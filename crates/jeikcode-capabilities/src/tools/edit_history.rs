//! In-memory version history and 3-Way Auto-Rebase state machine for `edit_file`.
//!
//! Provides a sliding `VersionRing` (up to 8 historical snapshots per canonical file)
//! to recover from cross-turn "Context Time-Travel" mismatches in rapid test/debug loops.
//! When a model's `old_string` fails against the current on-disk content ($V_{current}$)
//! but matches a recent historical version ($V_{old}$), a 3-way line merge attempts to
//! automatically rebase and apply the edit onto $V_{current}$ if the intervening changes
//! do not conflict.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Maximum historical snapshots retained per file in memory.
pub const MAX_VERSIONS_PER_FILE: usize = 32;

/// Snapshots are `Arc<str>` so `all_versions_reverse` is a pointer bump under
/// the global `FILE_HISTORY` mutex instead of memcpy-ing up to 32 full files.
/// Holding that lock across a 232 KB × 32 clone is what made concurrent
/// `edit_file` / `parallel_edit_files` look deadlocked.
#[derive(Debug, Clone)]
pub struct FileVersion {
    pub content: Arc<str>,
    pub timestamp: std::time::Instant,
}

#[derive(Debug, Default)]
pub struct VersionRing {
    /// Pinned initial base ($V_0$): the very first version of the file observed in this session.
    /// Never evicted, so models referencing the original file content can always 3-way rebase.
    initial_base: Option<FileVersion>,
    /// Sliding window of recent mutations ($V_1..V_k$).
    versions: VecDeque<FileVersion>,
}

impl VersionRing {
    pub fn push(&mut self, content: String) {
        let content: Arc<str> = Arc::from(content);
        if self.initial_base.is_none() {
            self.initial_base = Some(FileVersion {
                content: Arc::clone(&content),
                timestamp: std::time::Instant::now(),
            });
        }
        if self
            .versions
            .back()
            .map(|v| v.content.as_ref() == content.as_ref())
            .unwrap_or(false)
        {
            return;
        }
        if self.versions.len() >= MAX_VERSIONS_PER_FILE {
            self.versions.pop_front();
        }
        self.versions.push_back(FileVersion {
            content,
            timestamp: std::time::Instant::now(),
        });
    }

    /// Newest → oldest. Cheap (`Arc` clones) so the caller can drop `FILE_HISTORY`
    /// before running heal / 3-way work.
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

static FILE_HISTORY: LazyLock<Mutex<HashMap<PathBuf, VersionRing>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static RECENT_MODIFIED_FILES: LazyLock<Mutex<VecDeque<PathBuf>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));

/// Record a version snapshot for `path`.
pub fn record_version(path: &Path, content: &str) {
    let Ok(canonical) = path
        .canonicalize()
        .or_else(|_| Ok::<_, std::io::Error>(path.to_path_buf()))
    else {
        return;
    };
    record_modified_file(&canonical);
    let mut map = FILE_HISTORY.lock().unwrap_or_else(|e| e.into_inner());
    map.entry(canonical).or_default().push(content.to_string());
}

/// 记录最近成功修改过的文件路径（维护 LRU 队列，最多保留 8 个文件）
pub fn record_modified_file(path: &Path) {
    let Ok(canonical) = path
        .canonicalize()
        .or_else(|_| Ok::<_, std::io::Error>(path.to_path_buf()))
    else {
        return;
    };
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

/// 检查 old_string 是否在最近修改过的其它文件中 100% 精确存在（交叉嗅探走错门场景）
pub fn find_exact_match_in_recent_files(exclude_path: &Path, old_string: &str) -> Option<PathBuf> {
    if old_string.trim().is_empty() {
        return None;
    }
    let Ok(exclude_canonical) = exclude_path
        .canonicalize()
        .or_else(|_| Ok::<_, std::io::Error>(exclude_path.to_path_buf()))
    else {
        return None;
    };

    let recent = {
        if let Ok(list) = RECENT_MODIFIED_FILES.lock() {
            list.iter()
                .filter(|p| **p != exclude_canonical)
                .cloned()
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        }
    };

    let map = FILE_HISTORY.lock().unwrap_or_else(|e| e.into_inner());

    for path in recent {
        // 1. 先查版本历史中的内容
        if let Some(ring) = map.get(&path) {
            for v in ring.all_versions_reverse() {
                if v.contains(old_string) {
                    return Some(path);
                }
            }
        }
        // 2. 再查磁盘当前内容
        if let Ok(content) = std::fs::read_to_string(&path) {
            if content.contains(old_string) {
                return Some(path);
            }
        }
    }
    None
}

/// Clear history for a file (useful in tests).
#[cfg(test)]
pub fn clear_history(path: &Path) {
    let Ok(canonical) = path
        .canonicalize()
        .or_else(|_| Ok::<_, std::io::Error>(path.to_path_buf()))
    else {
        return;
    };
    let mut map = FILE_HISTORY.lock().unwrap_or_else(|e| e.into_inner());
    map.remove(&canonical);
}

/// Result of a successful 3-way rebase.
#[derive(Debug, Clone)]
pub struct RebaseSuccess {
    /// The merged file content after rebasing the edit onto $V_{current}$.
    pub merged_content: String,
    /// The actual text in $V_{current}$ corresponding to the rebased region.
    pub actual_old_string: String,
}

/// Attempt to rebase an edit that failed on `current` by searching historical versions of `path`.
///
/// If `old_string` matches in an older version $V_{old}$, and the model's change on $V_{old}$
/// does not conflict with lines modified between $V_{old}$ and $V_{current}$, this returns
/// the rebased merged content and the actual text in $V_{current}$.
pub fn try_history_rebase(
    path: &Path,
    current: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> Option<RebaseSuccess> {
    try_history_rebase_cancel(path, current, old_string, new_string, replace_all, None)
}

/// Same as [`try_history_rebase`], but bails between snapshots when `cancel` fires
/// so Esc/Ctrl-C can reclaim the async worker instead of waiting out a 32-deep probe.
pub fn try_history_rebase_cancel(
    path: &Path,
    current: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
    cancel: Option<&tokio_util::sync::CancellationToken>,
) -> Option<RebaseSuccess> {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    // Clone Arcs under the lock, then DROP it before any heal/diff work. A full-file
    // memcpy here used to pin every concurrent editor on FILE_HISTORY.
    let history: Vec<Arc<str>> = {
        let map = FILE_HISTORY.lock().unwrap_or_else(|e| e.into_inner());
        let ring = map.get(&canonical)?;
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
    // Timeout: unbounded Patience on two 3k-line files can pin the executor the
    // same way the old closest-match Levenshtein did. A timed-out (coarse) diff
    // must NOT be used for merge — abort the rebase instead of applying a wrong hunk.
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

    // Build a map of base line index -> ours line index and check for conflicts.
    // We check if any ours change overlaps with any theirs_changes.
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
                        return None; // Conflict: both modified the same lines
                    }
                }
                similar::DiffOp::Insert { old_index, .. } => {
                    // An insert in ours strictly inside (t_start, t_end) conflicts
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
                        return None; // Conflict: both modified the same lines
                    }
                }
            }
        }
    }

    // 3. Map `theirs_changes` coordinates from `base` into `ours`.
    // For each (t_start, t_end), find corresponding (o_start, o_end) in `ours`.
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

    // Sort mapped changes by o_start descending so we can apply them safely from bottom to top
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
        // Point insertion at a_start: overlaps if inside (b_start, b_end) or at b_start when b is replacement
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
        // Ours modified `let a = 1` to `let a = 100`
        let ours = "fn foo() {\n    let a = 100;\n    let b = 2;\n    let c = 3;\n}\n";
        // Model (on base) modified `let c = 3` to `let c = 999`
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
        // Ours modified `let a = 1` to `let a = 10`
        let ours = "fn foo() {\n    let a = 10;\n}\n";
        // Theirs modified `let a = 1` to `let a = 20`
        let theirs = "fn foo() {\n    let a = 20;\n}\n";

        let res = perform_3way_rebase(base, ours, theirs);
        assert!(res.is_none(), "overlapping changes must trigger conflict");
    }

    #[test]
    fn test_initial_base_is_pinned_even_after_many_edits() {
        let mut ring = VersionRing::default();
        let v0 = "fn initial() { 0 }".to_string();
        ring.push(v0.clone());

        // Push 40 subsequent revisions (exceeding MAX_VERSIONS_PER_FILE = 32)
        for i in 1..=40 {
            ring.push(format!("fn step_{i}() {{ {i} }}"));
        }

        let all = ring.all_versions_reverse();
        // The most recent 32 plus the initial base
        assert_eq!(
            all.len(),
            33,
            "should hold 32 recent versions + 1 pinned initial base"
        );
        assert_eq!(
            all.first().unwrap().as_ref(),
            "fn step_40() { 40 }",
            "newest version first"
        );
        assert_eq!(
            all.last().unwrap().as_ref(),
            v0.as_str(),
            "pinned initial base must remain at the end"
        );
    }

    #[test]
    fn history_rebase_probe_skips_diagnostic_on_large_unrelated_hunk() {
        // Each historical snapshot used to run the full closest-match Levenshtein
        // diagnostic on miss. 8 versions × a 240-line ghost hunk × a 3k-line file
        // hung for minutes. Probing must stay on the heal path only.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.tsx");
        let mut content = String::new();
        for i in 0..3000 {
            content.push_str(&format!("line_{i} = {i};\n"));
        }
        std::fs::write(&path, &content).unwrap();
        clear_history(&path);
        record_version(&path, &content);
        for v in 1..=8 {
            content.push_str(&format!("// rev {v}\n"));
            record_version(&path, &content);
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
