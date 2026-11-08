//! Durable user-input log (prompt / steer / queue).
//!
//! The model snapshot only carries a prompt after the turn starts, and a steer
//! only after the kernel folds it. A refresh in either window currently loses
//! the rail entry (and a pre-fold steer is invisible). This append-only sidecar
//! closes that gap with the same identity the rest of the stack uses:
//!
//! - `id` = the client correlation id (`/chat` request_id / `/chat/steer`
//!   client_input_id) which is also the persisted user message id;
//! - `seq` = a session-scoped monotonic admission order;
//! - `status` = admitted → submitted → promoted | rejected | cancelled.
//!
//! The log is intentionally small: only user inputs, not assistant/tool rows.
//! It is keyed by session id under the global config dir, so it works before a
//! new session has a project bucket and never needs a catalog scan.
//!
//! Writers append one JSON object per line. Readers dedupe by `id` (latest seq
//! wins), sort by `seq`, and ignore a torn final line.

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use jeikcode_kernel::message::ImageContent;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionInput {
    pub id: String,
    #[serde(default)]
    pub seq: u64,
    pub session_id: String,
    /// `prompt` | `steer` | `queue`.
    #[serde(default)]
    pub delivery: String,
    /// `admitted` | `submitted` | `promoted` | `rejected` | `cancelled`.
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<ImageContent>,
    #[serde(default)]
    pub created_at: u64,
    /// Persisted kernel message id once the input is promoted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    /// Client correlation id of the owning turn (terminal attribution).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_path(root: &Path, session_id: &str) -> PathBuf {
    root.join(format!("{session_id}.lock"))
}

/// Serialize writers across processes (daemon + CLI) with a sidecar file lock.
/// Reads stay lock-free: appends are single `O_APPEND` writes and compaction
/// replaces the log atomically, so a reader always sees a complete old or new file.
fn with_file_lock<T>(
    root: &Path,
    session_id: &str,
    operation: impl FnOnce() -> std::io::Result<T>,
) -> std::io::Result<T> {
    std::fs::create_dir_all(root)?;
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(lock_path(root, session_id))?;
    fs2::FileExt::lock_exclusive(&file)?;
    let result = operation();
    let _ = fs2::FileExt::unlock(&file);
    result
}

#[derive(Clone, Copy)]
struct SeqHint {
    len: u64,
    modified: Option<SystemTime>,
    next_seq: u64,
}

fn seq_cache() -> &'static Mutex<HashMap<String, SeqHint>> {
    static CACHE: OnceLock<Mutex<HashMap<String, SeqHint>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn seq_key(root: &Path, session_id: &str) -> String {
    format!("{}\u{1f}{session_id}", root.to_string_lossy())
}

fn log_fingerprint(path: &Path) -> Option<(u64, Option<SystemTime>)> {
    std::fs::metadata(path)
        .ok()
        .map(|meta| (meta.len(), meta.modified().ok()))
}

/// Reuse the cached next seq only while the log's `(len, mtime)` fingerprint
/// still matches. Any append (from this process or another) changes `len`; a
/// compaction replaces the file, so a stale hint is discarded on the next
/// write. Callers must hold the cross-process writer lock.
fn next_seq_locked(root: &Path, session_id: &str, path: &Path) -> u64 {
    let fingerprint = log_fingerprint(path);
    let key = seq_key(root, session_id);
    if let Some(fingerprint) = fingerprint {
        let cache = seq_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(hint) = cache.get(&key) {
            if (hint.len, hint.modified) == fingerprint {
                return hint.next_seq;
            }
        }
    }
    read_file(path)
        .iter()
        .map(|row| row.seq)
        .max()
        .unwrap_or(0)
        .saturating_add(1)
}

fn remember_seq(root: &Path, session_id: &str, path: &Path, next_seq: u64) {
    let Some((len, modified)) = log_fingerprint(path) else {
        return;
    };
    let key = seq_key(root, session_id);
    let mut cache = seq_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if cache.len() > 1024 {
        cache.clear();
    }
    cache.insert(
        key,
        SeqHint {
            len,
            modified,
            next_seq,
        },
    );
}

fn forget_seq(root: &Path, session_id: &str) {
    let key = seq_key(root, session_id);
    if let Ok(mut cache) = seq_cache().lock() {
        cache.remove(&key);
    }
}

/// Automatic compaction backoff. If a pass cannot shrink an image-heavy log
/// (fewer than [`KEEP_RECENT_PROMOTED`] lines), retry only after it has grown
/// by another [`COMPACT_RETRY_BYTES`] instead of re-reading it on every append.
fn compact_hints() -> &'static Mutex<HashMap<String, u64>> {
    static HINTS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    HINTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn should_attempt_compact(root: &Path, session_id: &str, len: u64) -> bool {
    if len <= MAX_INPUT_LOG_BYTES {
        return false;
    }
    let key = seq_key(root, session_id);
    let hints = compact_hints()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match hints.get(&key) {
        Some(last) => len >= last.saturating_add(COMPACT_RETRY_BYTES),
        None => true,
    }
}

fn remember_compact_attempt(root: &Path, session_id: &str, len: u64) {
    let key = seq_key(root, session_id);
    let mut hints = compact_hints()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if hints.len() > 1024 {
        hints.clear();
    }
    hints.insert(key, len);
}

fn forget_compact_attempt(root: &Path, session_id: &str) {
    let key = seq_key(root, session_id);
    if let Ok(mut hints) = compact_hints().lock() {
        hints.remove(&key);
    }
}

const MAX_INPUT_LOG_BYTES: u64 = 256 * 1024;
const COMPACT_RETRY_BYTES: u64 = 1024 * 1024;
const KEEP_RECENT_PROMOTED: usize = 200;

pub fn global_root() -> PathBuf {
    crate::paths::config_dir().join("session-inputs")
}

fn path_for(root: &Path, session_id: &str) -> PathBuf {
    root.join(format!("{session_id}.jsonl"))
}

fn read_file(path: &Path) -> Vec<SessionInput> {
    read_file_with_line_count(path).0
}

/// One physical read for both the deduped rows and the raw non-empty line
/// count. Compaction uses the count to avoid a second full read just to decide
/// whether it would drop anything.
fn read_file_with_line_count(path: &Path) -> (Vec<SessionInput>, usize) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return (Vec::new(), 0);
    };
    let mut by_id: HashMap<String, SessionInput> = HashMap::new();
    let mut lines = 0usize;
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        lines += 1;
        let Ok(input) = serde_json::from_str::<SessionInput>(line) else {
            continue;
        };
        match by_id.get(&input.id) {
            Some(previous) if previous.seq >= input.seq => {}
            _ => {
                by_id.insert(input.id.clone(), input);
            }
        }
    }
    let mut rows: Vec<SessionInput> = by_id.into_values().collect();
    rows.sort_by_key(|input| input.seq);
    (rows, lines)
}

/// Read the deduped, seq-ordered input log for `session_id`.
pub fn list(root: &Path, session_id: &str) -> Vec<SessionInput> {
    read_file(&path_for(root, session_id))
}

pub fn list_global(session_id: &str) -> Vec<SessionInput> {
    list(&global_root(), session_id)
}

/// Latest durable row for one client correlation id.
pub fn find_global(session_id: &str, input_id: &str) -> Option<SessionInput> {
    list_global(session_id)
        .into_iter()
        .find(|input| input.id == input_id)
}

/// Append one admission row. `seq` is assigned by this writer.
pub fn append(root: &Path, input: &mut SessionInput) -> std::io::Result<()> {
    let _guard = lock();
    let session_id = input.session_id.clone();
    with_file_lock(root, &session_id, || {
        let path = path_for(root, &session_id);
        // The cache is keyed by the log's `(len, mtime)`: an external writer
        // invalidates it, so this stays O(1) without risking duplicate seq.
        let next = next_seq_locked(root, &session_id, &path);
        input.seq = next;
        append_row(&path, input)?;
        remember_seq(root, &session_id, &path, next.saturating_add(1));
        maybe_compact_locked(root, &session_id)
    })
}

pub fn append_global(input: &mut SessionInput) -> std::io::Result<()> {
    append(&global_root(), input)
}

fn append_row(path: &Path, input: &SessionInput) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(input).map_err(std::io::Error::other)?;
    line.push(b'\n');
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(&line)?;
    // User admission is the durable recovery point for a steer that has not
    // reached the kernel yet; pay the fsync cost here (one per input).
    file.sync_data()
}

/// Mark the entries identified by `(client_input_id, kernel_message_id)` as
/// promoted. A missing id is ignored (the log may be older than the feature).
pub fn mark_promoted(
    root: &Path,
    session_id: &str,
    pairs: &[(Option<String>, Option<String>)],
) -> std::io::Result<()> {
    let pairs: Vec<(String, Option<String>)> = pairs
        .iter()
        .filter_map(|(client, message)| client.clone().map(|client| (client, message.clone())))
        .collect();
    if pairs.is_empty() {
        return Ok(());
    }
    let _guard = lock();
    with_file_lock(root, session_id, || {
        let path = path_for(root, session_id);
        let mut rows = read_file(&path);
        let mut next = rows.iter().map(|row| row.seq).max().unwrap_or(0);
        let mut out: Vec<SessionInput> = Vec::new();
        for (client_id, message_id) in pairs {
            let Some(index) = rows.iter().position(|row| row.id == client_id) else {
                continue;
            };
            if rows[index].status == "promoted" {
                continue;
            }
            next = next.saturating_add(1);
            rows[index].seq = next;
            rows[index].status = "promoted".into();
            if message_id.is_some() {
                rows[index].message_id = message_id;
            }
            out.push(rows[index].clone());
        }
        if out.is_empty() {
            return Ok(());
        }
        for row in &out {
            append_row(&path, row)?;
        }
        remember_seq(root, session_id, &path, next.saturating_add(1));
        maybe_compact_locked(root, session_id)
    })
}

pub fn mark_promoted_global(
    session_id: &str,
    pairs: &[(Option<String>, Option<String>)],
) -> std::io::Result<()> {
    mark_promoted(&global_root(), session_id, pairs)
}

fn mark_status(
    root: &Path,
    session_id: &str,
    client_input_id: &str,
    allowed_from: &[&str],
    status: &str,
) -> std::io::Result<bool> {
    let client_input_id = client_input_id.trim();
    if client_input_id.is_empty() {
        return Ok(false);
    }
    let _guard = lock();
    with_file_lock(root, session_id, || {
        let path = path_for(root, session_id);
        let mut rows = read_file(&path);
        let mut next = rows.iter().map(|row| row.seq).max().unwrap_or(0);
        let Some(index) = rows.iter().position(|row| row.id == client_input_id) else {
            return Ok(false);
        };
        if !allowed_from.contains(&rows[index].status.as_str()) {
            return Ok(false);
        }
        next = next.saturating_add(1);
        rows[index].seq = next;
        rows[index].status = status.to_string();
        let row = rows[index].clone();
        append_row(&path, &row)?;
        remember_seq(root, session_id, &path, next.saturating_add(1));
        maybe_compact_locked(root, session_id)?;
        Ok(true)
    })
}

/// The kernel accepted the steer and will fold it at the next round boundary.
/// A retry in this window must not submit a second copy.
pub fn mark_submitted(
    root: &Path,
    session_id: &str,
    client_input_id: &str,
) -> std::io::Result<bool> {
    mark_status(
        root,
        session_id,
        client_input_id,
        &["admitted", "rejected"],
        "submitted",
    )
}

pub fn mark_submitted_global(session_id: &str, client_input_id: &str) -> std::io::Result<bool> {
    mark_submitted(&global_root(), session_id, client_input_id)
}

/// A steer request was admitted by the endpoint but the running turn rejected it.
/// Keep its queue card as an ordinary queued message, not as a phantom live steer.
pub fn mark_rejected(
    root: &Path,
    session_id: &str,
    client_input_id: &str,
) -> std::io::Result<bool> {
    mark_status(
        root,
        session_id,
        client_input_id,
        &["admitted", "submitted"],
        "rejected",
    )
}

pub fn mark_rejected_global(session_id: &str, client_input_id: &str) -> std::io::Result<bool> {
    mark_rejected(&global_root(), session_id, client_input_id)
}

/// Mark admitted/submitted/rejected entries matching `client_input_id` (or `text`
/// when no id is given) as `cancelled` so they no longer appear in
/// `pending_for_operation`.
pub fn mark_cancelled(
    root: &Path,
    session_id: &str,
    client_input_id: Option<&str>,
    text: Option<&str>,
) -> std::io::Result<()> {
    let cid = client_input_id.map(str::trim).filter(|s| !s.is_empty());
    let target_text = text.map(str::trim).filter(|s| !s.is_empty());
    if cid.is_none() && target_text.is_none() {
        return Ok(());
    }
    let _guard = lock();
    with_file_lock(root, session_id, || {
        let path = path_for(root, session_id);
        let mut rows = read_file(&path);
        let mut next = rows.iter().map(|row| row.seq).max().unwrap_or(0);
        let mut out: Vec<SessionInput> = Vec::new();
        for row in &mut rows {
            if row.status != "admitted" && row.status != "submitted" && row.status != "rejected" {
                continue;
            }
            let matched = if let Some(id) = cid {
                row.id == id
            } else if let Some(t) = target_text {
                // Exact text only: a substring fallback can cancel a different
                // queued input whose text happens to overlap.
                row.text.trim() == t
            } else {
                false
            };
            if !matched {
                continue;
            }
            next = next.saturating_add(1);
            row.seq = next;
            row.status = "cancelled".into();
            out.push(row.clone());
        }
        if out.is_empty() {
            return Ok(());
        }
        for row in &out {
            append_row(&path, row)?;
        }
        remember_seq(root, session_id, &path, next.saturating_add(1));
        maybe_compact_locked(root, session_id)
    })
}

pub fn mark_cancelled_global(
    session_id: &str,
    client_input_id: Option<&str>,
    text: Option<&str>,
) -> std::io::Result<()> {
    mark_cancelled(&global_root(), session_id, client_input_id, text)
}

/// Cursor for `after_seq` clients: the highest admission sequence present.
pub fn cursor(root: &Path, session_id: &str) -> u64 {
    list(root, session_id)
        .iter()
        .map(|row| row.seq)
        .max()
        .unwrap_or(0)
}

pub fn cursor_global(session_id: &str) -> u64 {
    cursor(&global_root(), session_id)
}

/// Inputs still waiting for the kernel for the *current* operation. Stale
/// admitted rows from an older operation are intentionally excluded: the
/// daemon only shows pending inputs for the turn that owns the session.
pub fn pending_for_operation(
    root: &Path,
    session_id: &str,
    operation_id: &str,
) -> Vec<SessionInput> {
    list(root, session_id)
        .into_iter()
        .filter(|row| {
            (row.status == "admitted" || row.status == "submitted")
                && row.operation_id.as_deref() == Some(operation_id)
                && (!row.text.trim().is_empty() || !row.images.is_empty())
        })
        .collect()
}

pub fn clear(root: &Path, session_id: &str) {
    let _guard = lock();
    forget_seq(root, session_id);
    forget_compact_attempt(root, session_id);
    let _ = with_file_lock(root, session_id, || {
        match std::fs::remove_file(path_for(root, session_id)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    });
}

/// Rewrite the log with the latest row per id, keeping every unresolved row
/// (`admitted` / `submitted`) and the most recent completed rows. Returns how
/// many physical lines were dropped.
pub fn compact(root: &Path, session_id: &str) -> std::io::Result<usize> {
    let _guard = lock();
    let result = with_file_lock(root, session_id, || compact_locked(root, session_id));
    if result.is_ok() {
        let after = std::fs::metadata(path_for(root, session_id))
            .map(|meta| meta.len())
            .unwrap_or(0);
        if after <= MAX_INPUT_LOG_BYTES {
            forget_compact_attempt(root, session_id);
        } else {
            remember_compact_attempt(root, session_id, after);
        }
    }
    result
}

fn compact_locked(root: &Path, session_id: &str) -> std::io::Result<usize> {
    let path = path_for(root, session_id);
    let (rows, before_lines) = read_file_with_line_count(&path);
    if rows.is_empty() {
        return Ok(0);
    }
    let keep_from = rows.len().saturating_sub(KEEP_RECENT_PROMOTED);
    let kept: Vec<SessionInput> = rows
        .into_iter()
        .enumerate()
        .filter(|(index, row)| {
            row.status == "admitted" || row.status == "submitted" || *index >= keep_from
        })
        .map(|(_, row)| row)
        .collect();
    if kept.len() >= before_lines {
        return Ok(0);
    }
    std::fs::create_dir_all(root)?;
    let mut bytes = Vec::with_capacity(kept.len() * 256);
    for row in &kept {
        bytes.extend(serde_json::to_vec(row).map_err(std::io::Error::other)?);
        bytes.push(b'\n');
    }
    let tmp = path.with_extension("jsonl.tmp");
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    // Atomic replace: readers observe either the old log or the new one, never
    // the gap left by remove-then-rename. Callers hold the writer lock.
    std::fs::rename(&tmp, &path)?;
    forget_seq(root, session_id);
    Ok(before_lines.saturating_sub(kept.len()))
}

/// Caller must hold the cross-process writer lock.
fn maybe_compact_locked(root: &Path, session_id: &str) -> std::io::Result<()> {
    let path = path_for(root, session_id);
    let Some(len) = std::fs::metadata(&path).map(|meta| meta.len()).ok() else {
        return Ok(());
    };
    if len <= MAX_INPUT_LOG_BYTES {
        forget_compact_attempt(root, session_id);
        return Ok(());
    }
    if !should_attempt_compact(root, session_id, len) {
        return Ok(());
    }
    compact_locked(root, session_id)?;
    let after = std::fs::metadata(&path)
        .map(|meta| meta.len())
        .unwrap_or(len);
    if after <= MAX_INPUT_LOG_BYTES {
        forget_compact_attempt(root, session_id);
    } else {
        remember_compact_attempt(root, session_id, after);
    }
    Ok(())
}

pub fn clear_global(session_id: &str) {
    clear(&global_root(), session_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(session: &str, id: &str, text: &str) -> SessionInput {
        SessionInput {
            id: id.into(),
            seq: 0,
            session_id: session.into(),
            delivery: "steer".into(),
            status: "admitted".into(),
            text: text.into(),
            images: Vec::new(),
            created_at: 1,
            message_id: None,
            operation_id: Some("op-1".into()),
        }
    }

    #[test]
    fn append_assigns_monotonic_seq_and_dedupes_by_id() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut a = input("s1", "i-1", "first");
        let mut b = input("s1", "i-2", "second");
        append(root, &mut a).unwrap();
        append(root, &mut b).unwrap();
        assert_eq!(a.seq, 1);
        assert_eq!(b.seq, 2);

        // A promoted update is a new line for the SAME id; the reader must keep
        // only the latest seq and drop it from the pending projection.
        mark_promoted(root, "s1", &[(Some("i-1".into()), Some("m-1".into()))]).unwrap();
        let rows = list(root, "s1");
        assert_eq!(rows.len(), 2);
        let promoted = rows.iter().find(|row| row.id == "i-1").unwrap();
        assert_eq!(promoted.status, "promoted");
        assert_eq!(promoted.message_id.as_deref(), Some("m-1"));
        let pending = pending_for_operation(root, "s1", "op-1");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, "i-2");
        assert_eq!(cursor(root, "s1"), 3);
    }

    #[test]
    fn compact_keeps_admitted_and_recent_promoted_rows() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root).unwrap();
        let path = path_for(root, "s1");
        for seq in 1..=300u64 {
            let mut row = input("s1", &format!("p-{seq}"), "old");
            row.seq = seq;
            row.status = "promoted".into();
            append_row(&path, &row).unwrap();
        }
        let mut admitted = input("s1", "admitted-1", "keep me");
        admitted.seq = 301;
        admitted.status = "admitted".into();
        append_row(&path, &admitted).unwrap();

        let removed = compact(root, "s1").unwrap();
        assert!(removed > 0);
        let rows = list(root, "s1");
        assert_eq!(rows.len(), KEEP_RECENT_PROMOTED);
        assert!(rows.iter().any(|row| row.id == "admitted-1"));
        assert!(!rows.iter().any(|row| row.id == "p-1"));
        assert_eq!(rows.last().unwrap().seq, 301);
    }

    #[test]
    fn pending_is_scoped_to_the_current_operation() {
        let dir = tempfile::tempdir().unwrap();
        let mut old = input("s1", "old", "old steer");
        old.operation_id = Some("op-old".into());
        let mut new = input("s1", "new", "new steer");
        new.operation_id = Some("op-new".into());
        append(dir.path(), &mut old).unwrap();
        append(dir.path(), &mut new).unwrap();
        let rows = pending_for_operation(dir.path(), "s1", "op-new");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "new");
    }

    #[test]
    fn rejected_steer_leaves_no_pending_outline_but_can_still_be_promoted_if_folded() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut row = input("s1", "steer-1", "retry me");
        append(root, &mut row).unwrap();

        assert!(mark_rejected(root, "s1", "steer-1").unwrap());
        assert!(pending_for_operation(root, "s1", "op-1").is_empty());
        assert_eq!(list(root, "s1")[0].status, "rejected");

        // A timeout may race a late kernel fold; the durable kernel event wins.
        mark_promoted(root, "s1", &[(Some("steer-1".into()), Some("m-1".into()))]).unwrap();
        let mut rows = list(root, "s1");
        let promoted = rows.remove(0);
        assert_eq!(promoted.status, "promoted");
        assert_eq!(promoted.message_id.as_deref(), Some("m-1"));
    }

    #[test]
    fn submitted_steer_is_retry_idempotent_and_still_cancellable() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut row = input("s1", "steer-1", "submitted");
        append(root, &mut row).unwrap();

        assert!(mark_submitted(root, "s1", "steer-1").unwrap());
        assert!(!mark_submitted(root, "s1", "steer-1").unwrap());
        assert_eq!(pending_for_operation(root, "s1", "op-1").len(), 1);

        mark_cancelled(root, "s1", Some("steer-1"), None).unwrap();
        let rows = list(root, "s1");
        assert_eq!(rows[0].status, "cancelled");
        assert!(pending_for_operation(root, "s1", "op-1").is_empty());
    }

    #[test]
    fn submitted_steer_can_be_rejected_after_restart_or_turn_loss() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut row = input("s1", "steer-orphan", "orphan");
        append(root, &mut row).unwrap();
        mark_submitted(root, "s1", "steer-orphan").unwrap();

        assert!(mark_rejected(root, "s1", "steer-orphan").unwrap());
        let rows = list(root, "s1");
        assert_eq!(rows[0].status, "rejected");
        assert!(pending_for_operation(root, "s1", "op-1").is_empty());
    }

    #[test]
    fn mark_cancelled_retires_admitted_or_rejected_steers_from_pending() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut s1 = input("s1", "steer-1", "123");
        let mut s2 = input("s1", "steer-2", "456");
        append(root, &mut s1).unwrap();
        append(root, &mut s2).unwrap();
        assert!(mark_rejected(root, "s1", "steer-1").unwrap());

        mark_cancelled(root, "s1", Some("steer-1"), None).unwrap();
        let pending = pending_for_operation(root, "s1", "op-1");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, "steer-2");
        let rows = list(root, "s1");
        assert_eq!(
            rows.iter().find(|row| row.id == "steer-1").unwrap().status,
            "cancelled"
        );
    }

    #[test]
    fn append_observes_rows_written_by_another_writer() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root).unwrap();
        let path = path_for(root, "s1");
        let mut external = input("s1", "ext-1", "external");
        external.seq = 41;
        append_row(&path, &external).unwrap();

        let mut next = input("s1", "i-2", "next");
        append(root, &mut next).unwrap();
        assert_eq!(next.seq, 42);
    }

    #[test]
    fn compact_attempts_back_off_after_a_no_shrink_pass() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root).unwrap();
        let path = path_for(root, "s1");
        let big = "x".repeat(300 * 1024);
        let mut row = input("s1", "big", &big);
        row.status = "promoted".into();
        append_row(&path, &row).unwrap();
        let len = std::fs::metadata(&path).unwrap().len();

        assert!(should_attempt_compact(root, "s1", len));
        remember_compact_attempt(root, "s1", len);
        assert!(!should_attempt_compact(root, "s1", len));
        assert!(should_attempt_compact(
            root,
            "s1",
            len.saturating_add(COMPACT_RETRY_BYTES)
        ));
    }

    #[test]
    fn seq_cache_invalidates_after_another_writer_appends() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut first = input("s1", "i-1", "one");
        append(root, &mut first).unwrap();

        // Simulate another process appending without touching our cache.
        let path = path_for(root, "s1");
        let mut external = input("s1", "ext", "external");
        external.seq = 10;
        append_row(&path, &external).unwrap();

        let mut second = input("s1", "i-2", "two");
        append(root, &mut second).unwrap();
        assert_eq!(second.seq, 11);
    }

    #[test]
    fn text_cancellation_requires_an_exact_match() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut long = input("s1", "long", "hello world");
        let mut short = input("s1", "short", "hello");
        append(root, &mut long).unwrap();
        append(root, &mut short).unwrap();

        mark_cancelled(root, "s1", None, Some("hello")).unwrap();
        let rows = list(root, "s1");
        let long = rows.iter().find(|row| row.id == "long").unwrap();
        let short = rows.iter().find(|row| row.id == "short").unwrap();
        assert_eq!(long.status, "admitted");
        assert_eq!(short.status, "cancelled");
    }
}
