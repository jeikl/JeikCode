//! In-memory version history and 3-Way Auto-Rebase state machine for `edit`.
//!
//! Provides a bounded `VersionRing` (up to 32 historical snapshots per canonical
//! file) to recover from cross-turn "Context Time-Travel" mismatches in rapid
//! test/debug loops. When a model's `old_string` fails against the current
//! on-disk content ($V_{current}$) but matches a recent historical version
//! ($V_{old}$), a 3-way line merge attempts to automatically rebase and apply the
//! edit onto $V_{current}$ if the intervening changes do not conflict.
//!
//! Memory is bounded at THREE levels:
//! 1. per-file count (`MAX_VERSIONS_PER_FILE`);
//! 2. per-file size policy (`HistoryPlan::Full` / `BaseOnly` / `Skip`);
//! 3. a process-wide byte budget (`MAX_TOTAL_BYTES`) with whole-ring LRU eviction.
//!
//! The global map is keyed by canonical path and the LRU evicts entire files, so
//! a long-lived daemon editing thousands of files cannot retain one pinned base
//! per file forever.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Maximum historical snapshots retained per file in memory.
pub const MAX_VERSIONS_PER_FILE: usize = 32;

/// Retain full snapshots only up to this size; above it keep a single pinned
/// base snapshot (the most useful rebase anchor), and above
/// [`HARD_SKIP_BYTES`] keep no text at all.
pub const MAX_TRACKED_TEXT_BYTES: usize = 1024 * 1024;
pub const HARD_SKIP_BYTES: usize = 10 * 1024 * 1024;

/// Process-wide byte budget for all retained snapshot text.
pub const MAX_TOTAL_BYTES: usize = 128 * 1024 * 1024;

/// How much history to retain for one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryPlan {
    /// Keep the initial base + up to `MAX_VERSIONS_PER_FILE` recent versions.
    Full,
    /// Keep only the pinned initial base (memory: 1x file size).
    BaseOnly,
    /// Keep no snapshot text; only the recent-path hint is recorded.
    Skip,
}

/// Decide the snapshot policy BEFORE allocating a copy. Generated/lock/minified
/// files and very large files are not useful rebase candidates; medium files keep
/// one base so the common "model still references the original content" case
/// remains recoverable.
pub fn plan_for(path: &Path, len: usize) -> HistoryPlan {
    if is_generated_path(path) {
        return HistoryPlan::Skip;
    }
    if len > HARD_SKIP_BYTES {
        return HistoryPlan::Skip;
    }
    if len > MAX_TRACKED_TEXT_BYTES {
        return HistoryPlan::BaseOnly;
    }
    HistoryPlan::Full
}

fn is_generated_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let lower = name.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "package-lock.json"
            | "pnpm-lock.yaml"
            | "yarn.lock"
            | "cargo.lock"
            | "poetry.lock"
            | "composer.lock"
            | "gemfile.lock"
            | "go.sum"
    ) || lower.ends_with(".min.js")
        || lower.ends_with(".min.css")
        || lower.ends_with(".map")
        || lower.ends_with(".lock")
}

/// Snapshots are `Arc<str>` so `all_versions_reverse` is a pointer bump under
/// the global history mutex instead of memcpy-ing up to 32 full files.
#[derive(Debug, Clone)]
pub struct FileVersion {
    pub content: Arc<str>,
    pub timestamp: std::time::Instant,
}

#[derive(Debug, Default)]
pub struct VersionRing {
    /// Pinned initial base ($V_0$): the very first version of the file observed in
    /// this session. Never evicted while the file is tracked, so models
    /// referencing the original file content can always 3-way rebase.
    initial_base: Option<FileVersion>,
    /// Sliding window of recent mutations ($V_1..V_k$). The initial base is NOT
    /// duplicated here (one Arc allocation, one accounting entry).
    versions: VecDeque<FileVersion>,
}

impl VersionRing {
    /// Test/compat entry point.
    pub fn push(&mut self, content: String) {
        let _ = self.push_arc(Arc::from(content));
    }

    /// Push a new mutation. Returns `(added_bytes, removed_bytes)` so the global
    /// budget can be maintained without recomputing every ring.
    fn push_arc(&mut self, content: Arc<str>) -> (usize, usize) {
        if self.initial_base.is_none() {
            let added = content.len();
            self.initial_base = Some(FileVersion {
                content,
                timestamp: Instant::now(),
            });
            return (added, 0);
        }
        if self
            .versions
            .back()
            .map(|v| v.content.as_ref() == content.as_ref())
            .unwrap_or(false)
            || self
                .initial_base
                .as_ref()
                .map(|v| v.content.as_ref() == content.as_ref())
                .unwrap_or(false)
        {
            return (0, 0);
        }
        let mut removed = 0usize;
        if self.versions.len() >= MAX_VERSIONS_PER_FILE {
            if let Some(evicted) = self.versions.pop_front() {
                removed += evicted.content.len();
            }
        }
        let added = content.len();
        self.versions.push_back(FileVersion {
            content,
            timestamp: Instant::now(),
        });
        (added, removed)
    }

    fn set_base(&mut self, content: Arc<str>) -> (usize, usize) {
        if self.initial_base.is_some() {
            return (0, 0);
        }
        let added = content.len();
        self.initial_base = Some(FileVersion {
            content,
            timestamp: Instant::now(),
        });
        (added, 0)
    }

    fn bytes(&self) -> usize {
        self.initial_base
            .as_ref()
            .map(|v| v.content.len())
            .unwrap_or(0)
            + self.versions.iter().map(|v| v.content.len()).sum::<usize>()
    }

    fn trim_to_base(&mut self) -> usize {
        let removed: usize = self.versions.iter().map(|v| v.content.len()).sum();
        self.versions.clear();
        removed
    }

    /// Newest → oldest. Cheap (`Arc` clones) so the caller can drop the history
    /// lock before running heal / 3-way work.
    pub fn all_versions_reverse(&self) -> Vec<Arc<str>> {
        let mut out = Vec::new();
        for v in self.versions.iter().rev() {
            out.push(Arc::clone(&v.content));
        }
        if let Some(base) = &self.initial_base {
            if !out.iter().any(|c| c.as_ref() == base.content.as_ref()) {
                out.push(Arc::clone(&base.content));
            }
        }
        out
    }
}

#[derive(Debug, Default)]
struct HistoryStore {
    rings: HashMap<PathBuf, VersionRing>,
    total_bytes: usize,
    /// Least-recently-used whole files, evicted first when over budget.
    lru: VecDeque<PathBuf>,
}

impl HistoryStore {
    fn push(&mut self, path: PathBuf, content: Arc<str>, plan: HistoryPlan) {
        if plan == HistoryPlan::Skip {
            return;
        }
        self.touch(&path);
        let entry = self.rings.entry(path.clone()).or_default();
        let (added, removed) = match plan {
            HistoryPlan::Full => entry.push_arc(content),
            HistoryPlan::BaseOnly => entry.set_base(content),
            HistoryPlan::Skip => (0, 0),
        };
        self.total_bytes = self
            .total_bytes
            .saturating_add(added)
            .saturating_sub(removed);
        self.enforce_budget(&path);
    }

    fn touch(&mut self, path: &Path) {
        self.lru.retain(|p| p != path);
        self.lru.push_back(path.to_path_buf());
    }

    fn enforce_budget(&mut self, keep: &Path) {
        // First evict other whole rings, oldest first.
        while self.total_bytes > MAX_TOTAL_BYTES {
            let victim = self.lru.iter().find(|p| p.as_path() != keep).cloned();
            let Some(victim) = victim else {
                break;
            };
            if let Some(ring) = self.rings.remove(&victim) {
                self.total_bytes = self.total_bytes.saturating_sub(ring.bytes());
            }
            self.lru.retain(|p| p != &victim);
        }
        // If the just-inserted ring alone is over budget, keep only its base.
        if self.total_bytes > MAX_TOTAL_BYTES {
            if let Some(ring) = self.rings.get_mut(keep) {
                let removed = ring.trim_to_base();
                self.total_bytes = self.total_bytes.saturating_sub(removed);
            }
        }
    }

    fn remove(&mut self, path: &Path) -> Option<VersionRing> {
        self.lru.retain(|p| p != path);
        self.rings.remove(path)
    }
}

static HISTORY: LazyLock<Mutex<HistoryStore>> =
    LazyLock::new(|| Mutex::new(HistoryStore::default()));

static RECENT_MODIFIED_FILES: LazyLock<Mutex<VecDeque<PathBuf>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));

fn canonical_or_self(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Record a version snapshot for `path` under the selected policy.
pub fn record_version(path: &Path, content: &str, plan: HistoryPlan) {
    let canonical = canonical_or_self(path);
    // Keep the cheap "wrong file" hint even when snapshots are skipped.
    record_modified_file(&canonical);
    if plan == HistoryPlan::Skip {
        return;
    }
    // Build the Arc OUTSIDE the global lock; a 1 MB copy under the mutex was a
    // cross-session stall (and a lock-order hazard once file locks are added).
    let snapshot: Arc<str> = Arc::from(content);
    let mut store = HISTORY.lock().unwrap_or_else(|e| e.into_inner());
    store.push(canonical, snapshot, plan);
}

/// Record the most recently modified file paths (LRU, max 8 files).
pub fn record_modified_file(path: &Path) {
    let canonical = canonical_or_self(path);
    if let Ok(mut list) = RECENT_MODIFIED_FILES.lock() {
        if let Some(pos) = list.iter().position(|p| p == &canonical) {
            list.remove(pos);
        }
        list.push_front(canonical);
        if list.len() > 8 {
            list.pop_back();
        }
    }
}

/// Check whether `old_string` exists verbatim in another recently modified file.
///
/// Files outside `workspace_root` are ignored: a daemon hosts sessions for
/// multiple projects, and a cross-project hint would leak another project's
/// path (and couple unrelated edits).
pub fn find_exact_match_in_recent_files(
    exclude_path: &Path,
    old_string: &str,
    workspace_root: &Path,
) -> Option<PathBuf> {
    if old_string.trim().is_empty() {
        return None;
    }
    let exclude_canonical = canonical_or_self(exclude_path);
    let root = canonical_or_self(workspace_root);

    let recent: Vec<PathBuf> = {
        let Ok(list) = RECENT_MODIFIED_FILES.lock() else {
            return None;
        };
        list.iter()
            .filter(|p| **p != exclude_canonical && p.starts_with(&root))
            .cloned()
            .collect()
    };

    // Snapshot the `Arc` contents under the lock, then scan with NO lock held.
    let candidates: Vec<(PathBuf, Vec<Arc<str>>)> = {
        let store = HISTORY.lock().unwrap_or_else(|e| e.into_inner());
        recent
            .iter()
            .filter_map(|path| {
                store
                    .rings
                    .get(path)
                    .map(|ring| (path.clone(), ring.all_versions_reverse()))
            })
            .collect()
    };
    for (path, versions) in candidates {
        for version in versions {
            if version.contains(old_string) {
                return Some(path);
            }
        }
    }

    // Disk fallback, also outside the history lock. Never read a huge recent
    // file just to build a hint; the hint is not worth a multi-MB allocation.
    for path in recent {
        let too_large = std::fs::metadata(&path)
            .map(|meta| meta.len() > MAX_TRACKED_TEXT_BYTES as u64)
            .unwrap_or(true);
        if too_large {
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(&path) {
            if content.contains(old_string) {
                return Some(path);
            }
        }
    }
    None
}

/// Clear history for a file (useful in tests / on file deletion).
pub fn clear_history(path: &Path) {
    let canonical = canonical_or_self(path);
    let mut store = HISTORY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ring) = store.remove(&canonical) {
        store.total_bytes = store.total_bytes.saturating_sub(ring.bytes());
    }
}

/// Result of a successful 3-way rebase.
#[derive(Debug, Clone)]
pub struct RebaseSuccess {
    /// The merged file content after rebasing the edit onto $V_{current}$.
    pub merged_content: String,
    /// The actual text in $V_{current}$ corresponding to the rebased region.
    pub actual_old_string: String,
}

/// Attempt to rebase an edit that failed on `current` by searching historical
/// versions of `path`.
pub fn try_history_rebase(
    path: &Path,
    current: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> Option<RebaseSuccess> {
    try_history_rebase_cancel(path, current, old_string, new_string, replace_all, None)
}

/// Same as [`try_history_rebase`], but bails between snapshots when `cancel`
/// fires so Esc/Ctrl-C can reclaim the async worker instead of waiting out a
/// 32-deep probe.
pub fn try_history_rebase_cancel(
    path: &Path,
    current: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
    cancel: Option<&tokio_util::sync::CancellationToken>,
) -> Option<RebaseSuccess> {
    let canonical = canonical_or_self(path);
    if plan_for(&canonical, current.len()) == HistoryPlan::Skip {
        return None;
    }
    // Clone Arcs under the lock, then DROP it before any heal/diff work.
    let history: Vec<Arc<str>> = {
        let store = HISTORY.lock().unwrap_or_else(|e| e.into_inner());
        let ring = store.rings.get(&canonical)?;
        ring.all_versions_reverse()
    };

    for base in &history {
        if cancel.is_some_and(|c| c.is_cancelled()) {
            return None;
        }
        if base.as_ref() == current {
            continue; // Already tried against current
        }

        if let Ok((theirs, _count, _kind, _actual)) =
            super::edit::apply_hunk_direct(base, old_string, new_string, replace_all)
        {
            if theirs == *base.as_ref() {
                continue;
            }
            if let Some(res) = perform_3way_rebase(base, current, &theirs) {
                return Some(res);
            }
        }
    }

    None
}

const REBASE_DIFF_TIMEOUT: Duration = Duration::from_millis(200);

fn bounded_patience_diff<'a, 'b>(
    old: &'a str,
    new: &'b str,
) -> Option<similar::TextDiff<'a, 'b, 'a, str>> {
    // similar 2.7 has no `deadline_reached()` on TextDiff; a timed-out run still
    // returns a *coarse but valid* diff. Using that for 3-way merge can silently
    // apply the wrong hunk. If we hit the budget, abort the rebase instead.
    let t0 = Instant::now();
    let mut config = similar::TextDiff::configure();
    config.algorithm(similar::Algorithm::Patience);
    config.timeout(REBASE_DIFF_TIMEOUT);
    let diff = config.diff_lines(old, new);
    if t0.elapsed() >= REBASE_DIFF_TIMEOUT {
        None
    } else {
        Some(diff)
    }
}

/// Performs line-based 3-way merge between:
/// - `base`: common historical ancestor ($V_{old}$)
/// - `ours`: current on-disk content ($V_{current}$)
/// - `theirs`: historical ancestor with model's edit applied ($V_{branch}$)
pub fn perform_3way_rebase(base: &str, ours: &str, theirs: &str) -> Option<RebaseSuccess> {
    let base_lines: Vec<&str> = base.lines().collect();
    let ours_lines: Vec<&str> = ours.lines().collect();
    let theirs_lines: Vec<&str> = theirs.lines().collect();

    // 1. Identify what `theirs` changed relative to `base`.
    let diff_bt = bounded_patience_diff(base, theirs)?;

    let mut theirs_changes = Vec::new(); // Vec<(base_start, base_end, replacement_lines)>
    for op in diff_bt.ops() {
        match *op {
            similar::DiffOp::Equal { .. } => {}
            similar::DiffOp::Delete {
                old_index, old_len, ..
            } => {
                theirs_changes.push((old_index, old_index + old_len, Vec::<&str>::new()));
            }
            similar::DiffOp::Insert {
                old_index,
                new_index,
                new_len,
            } => {
                let repl = theirs_lines[new_index..new_index + new_len].to_vec();
                theirs_changes.push((old_index, old_index, repl));
            }
            similar::DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                let repl = theirs_lines[new_index..new_index + new_len].to_vec();
                theirs_changes.push((old_index, old_index + old_len, repl));
            }
        }
    }

    if theirs_changes.is_empty() {
        return None;
    }

    // 2. Diff `base` vs `ours` to map line coordinates and detect conflicts.
    let diff_bo = bounded_patience_diff(base, ours)?;

    for &(t_start, t_end, _) in &theirs_changes {
        for op in diff_bo.ops() {
            match *op {
                similar::DiffOp::Equal { .. } => {}
                similar::DiffOp::Delete {
                    old_index, old_len, ..
                } => {
                    let o_start = old_index;
                    let o_end = old_index + old_len;
                    if ranges_overlap(t_start, t_end, o_start, o_end) {
                        return None;
                    }
                }
                similar::DiffOp::Insert { old_index, .. } => {
                    if t_start < t_end && old_index > t_start && old_index < t_end {
                        return None;
                    }
                }
                similar::DiffOp::Replace {
                    old_index, old_len, ..
                } => {
                    let o_start = old_index;
                    let o_end = old_index + old_len;
                    if ranges_overlap(t_start, t_end, o_start, o_end) {
                        return None;
                    }
                }
            }
        }
    }

    // 3. Map `theirs_changes` coordinates from `base` into `ours`.
    let mut mapped_changes = Vec::new();
    for (t_start, t_end, repl) in theirs_changes {
        let (o_start, o_end) = map_base_range_to_ours(
            t_start,
            t_end,
            diff_bo.ops(),
            base_lines.len(),
            ours_lines.len(),
        )?;
        mapped_changes.push((o_start, o_end, repl));
    }

    mapped_changes.sort_by(|a, b| b.0.cmp(&a.0));

    let mut result_lines: Vec<String> = ours_lines.iter().map(|l| l.to_string()).collect();
    let mut actual_parts = Vec::new();

    for (o_start, o_end, repl) in mapped_changes {
        if o_start <= o_end && o_end <= result_lines.len() {
            let actual = result_lines[o_start..o_end].join("\n");
            actual_parts.push(actual);
            let replacement_strings: Vec<String> = repl.iter().map(|s| s.to_string()).collect();
            result_lines.splice(o_start..o_end, replacement_strings);
        } else {
            return None;
        }
    }

    let has_trailing_newline = ours.ends_with('\n');
    let mut merged = result_lines.join("\n");
    if has_trailing_newline && !merged.ends_with('\n') {
        merged.push('\n');
    }
    if ours.contains("\r\n") {
        merged = super::edit::coerce_eol(&merged, "\r\n");
    }

    let actual_old_string = if actual_parts.is_empty() {
        String::new()
    } else {
        actual_parts.join("\n---\n")
    };

    Some(RebaseSuccess {
        merged_content: merged,
        actual_old_string,
    })
}

fn ranges_overlap(a_start: usize, a_end: usize, b_start: usize, b_end: usize) -> bool {
    if a_start == a_end {
        return a_start >= b_start && a_start < b_end;
    }
    if b_start == b_end {
        return b_start >= a_start && b_start < a_end;
    }
    a_start < b_end && b_start < a_end
}

fn map_base_range_to_ours(
    base_start: usize,
    base_end: usize,
    ops: &[similar::DiffOp],
    base_len: usize,
    ours_len: usize,
) -> Option<(usize, usize)> {
    let map_pos = |pos: usize| -> usize {
        if pos == 0 {
            return 0;
        }
        if pos >= base_len {
            return ours_len;
        }
        for op in ops {
            match *op {
                similar::DiffOp::Equal {
                    old_index,
                    new_index,
                    len,
                } => {
                    if pos >= old_index && pos <= old_index + len {
                        return new_index + (pos - old_index);
                    }
                }
                similar::DiffOp::Delete {
                    old_index,
                    old_len,
                    new_index,
                } => {
                    if pos >= old_index && pos <= old_index + old_len {
                        return new_index;
                    }
                }
                similar::DiffOp::Insert {
                    old_index,
                    new_index,
                    ..
                } => {
                    if pos == old_index {
                        return new_index;
                    }
                }
                similar::DiffOp::Replace {
                    old_index,
                    old_len,
                    new_index,
                    new_len,
                } => {
                    if pos >= old_index && pos <= old_index + old_len {
                        return new_index + new_len;
                    }
                }
            }
        }
        ours_len
    };

    Some((map_pos(base_start), map_pos(base_end)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_3way_rebase_clean_merge() {
        let base = "fn foo() {\n    let a = 1;\n    let b = 2;\n    let c = 3;\n}\n";
        let ours = "fn foo() {\n    let a = 100;\n    let b = 2;\n    let c = 3;\n}\n";
        let theirs = "fn foo() {\n    let a = 1;\n    let b = 2;\n    let c = 999;\n}\n";

        let res = perform_3way_rebase(base, ours, theirs);
        assert!(res.is_some(), "clean 3-way merge should succeed");
        let unwrapped = res.unwrap();
        assert_eq!(
            unwrapped.merged_content,
            "fn foo() {\n    let a = 100;\n    let b = 2;\n    let c = 999;\n}\n",
            "both non-overlapping changes should be preserved"
        );
        assert_eq!(unwrapped.actual_old_string, "    let c = 3;");
    }

    #[test]
    fn test_3way_rebase_detects_conflict() {
        let base = "fn foo() {\n    let a = 1;\n}\n";
        let ours = "fn foo() {\n    let a = 10;\n}\n";
        let theirs = "fn foo() {\n    let a = 20;\n}\n";

        let res = perform_3way_rebase(base, ours, theirs);
        assert!(res.is_none(), "overlapping changes must trigger conflict");
    }

    #[test]
    fn test_initial_base_is_pinned_even_after_many_edits() {
        let mut ring = VersionRing::default();
        let v0 = "fn initial() { 0 }".to_string();
        ring.push(v0.clone());

        for i in 1..=40 {
            ring.push(format!("fn step_{i}() {{ {i} }}"));
        }

        let all = ring.all_versions_reverse();
        assert_eq!(
            all.len(),
            33,
            "should hold 32 recent versions + 1 pinned initial base"
        );
        assert_eq!(all.first().unwrap().as_ref(), "fn step_40() { 40 }");
        assert_eq!(all.last().unwrap().as_ref(), v0.as_str());
    }

    #[test]
    fn plan_skips_generated_and_oversized_files() {
        assert_eq!(
            plan_for(Path::new("package-lock.json"), 10),
            HistoryPlan::Skip
        );
        assert_eq!(plan_for(Path::new("bundle.min.js"), 10), HistoryPlan::Skip);
        assert_eq!(
            plan_for(Path::new("src/main.rs"), MAX_TRACKED_TEXT_BYTES + 1),
            HistoryPlan::BaseOnly
        );
        assert_eq!(
            plan_for(Path::new("src/main.rs"), HARD_SKIP_BYTES + 1),
            HistoryPlan::Skip
        );
        assert_eq!(plan_for(Path::new("src/main.rs"), 1024), HistoryPlan::Full);
    }

    #[test]
    fn history_rebase_probe_skips_diagnostic_on_large_unrelated_hunk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.tsx");
        let mut content = String::new();
        for i in 0..3000 {
            content.push_str(&format!("line_{i} = {i};\n"));
        }
        std::fs::write(&path, &content).unwrap();
        clear_history(&path);
        record_version(&path, &content, HistoryPlan::Full);
        for v in 1..=8 {
            content.push_str(&format!("// rev {v}\n"));
            record_version(&path, &content, HistoryPlan::Full);
        }
        let mut old = String::new();
        for i in 0..240 {
            old.push_str(&format!(
                "        <div className=\"ghost-{i}\">nope</div>\n"
            ));
        }
        let t0 = std::time::Instant::now();
        let res = try_history_rebase(&path, &content, &old, "x", false);
        let elapsed = t0.elapsed();
        assert!(res.is_none(), "unrelated hunk must not rebase");
        assert!(
            elapsed < std::time::Duration::from_millis(1500),
            "history rebase probe hung on diagnostic: {elapsed:?}"
        );
    }
}
