//! In-memory per-turn file state machine for `write`.
//!
//! Enforces safety discipline for overwriting existing files:
//! 1. When a target file does NOT exist on disk: `write` directly creates it (bypassing the state machine).
//! 2. When a target file DOES exist on disk:
//!    - Requires that before the first `write` in the current turn, the last file operation on that file was `read`.
//!    - Once confirmed read in a turn, the file can be repeatedly overwritten until the turn ends.
//!    - At the start of the next turn (`turn_start` or `advance_turn`), the read confirmation resets to 0 (unread).
//! 3. If an existing file is unread:
//!    - Intercepts `write` (refuses to mutate the file).
//!    - Informs the model to read and confirm before writing.
//!    - Directly returns the file's latest 1500 lines formatted with line anchors.
//!    - If total lines > 1500, informs how many lines remain and instructs reading the remainder via offset/limit.

use async_trait::async_trait;
use jeikcode_kernel::hook::LifecycleHooks;
use jeikcode_kernel::message::Conversation;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

const DEFAULT_READ_LIMIT: usize = 1500;
const MAX_LINE_LEN: usize = 2000;
/// Bound the per-path state map so a long-lived daemon editing thousands of
/// files across sessions cannot grow it without limit. Oldest turns are pruned
/// first; a pruned file simply loses its read confirmation (fail-closed).
const MAX_TRACKED_FILES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileOpKind {
    Read,
    Write,
    Edit,
}

#[derive(Debug, Clone, Default)]
pub struct FileTurnState {
    /// True if confirmed read in this turn and persists until this turn ends.
    pub read_confirmed: bool,
    /// Last file operation performed on this file in this turn.
    pub last_op: Option<FileOpKind>,
    /// Turn ID at which an unread write intercept returned the full file content and
    /// granted read confirmation. Survives into the immediately following turn (grace
    /// period) so the model can retry `write` in the next turn as prompted.
    pub confirmed_at_turn: Option<u64>,
}

#[derive(Debug)]
struct WriteStateMachine {
    /// Workspace-specific turn counters for multi-session / parallel test isolation
    workspace_turns: HashMap<PathBuf, u64>,
    /// Global fallback turn counter
    global_turn: u64,
    /// Files: canonical_path -> (turn_id_when_recorded, FileTurnState)
    files: HashMap<PathBuf, (u64, FileTurnState)>,
}

impl Default for WriteStateMachine {
    fn default() -> Self {
        Self {
            workspace_turns: HashMap::new(),
            global_turn: 1,
            files: HashMap::new(),
        }
    }
}

static STATE_MACHINE: LazyLock<Mutex<WriteStateMachine>> =
    LazyLock::new(|| Mutex::new(WriteStateMachine::default()));

fn canon(path: &Path) -> PathBuf {
    crate::pathnorm::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn prune_files(state: &mut WriteStateMachine) {
    if state.files.len() <= MAX_TRACKED_FILES {
        return;
    }
    let mut entries: Vec<(u64, PathBuf)> = state
        .files
        .iter()
        .map(|(path, (turn, _))| (*turn, path.clone()))
        .collect();
    entries.sort_by_key(|(turn, _)| *turn);
    let remove = state.files.len() - MAX_TRACKED_FILES;
    for (_, path) in entries.into_iter().take(remove) {
        state.files.remove(&path);
    }
}

fn get_turn_for_path(p: &Path, state: &WriteStateMachine) -> u64 {
    let mut matched_turn = None;
    let mut longest_len = 0;
    for (ws, turn) in &state.workspace_turns {
        if p.starts_with(ws) && ws.as_os_str().len() > longest_len {
            longest_len = ws.as_os_str().len();
            matched_turn = Some(*turn);
        }
    }
    matched_turn.unwrap_or(state.global_turn)
}

/// Advance the turn counter for a specific workspace directory.
pub fn advance_turn_for_dir(dir: &Path) {
    let d = canon(dir);
    let mut lock = STATE_MACHINE.lock().unwrap();
    let entry = lock.workspace_turns.entry(d).or_insert(1);
    *entry += 1;
    prune_files(&mut lock);
}

/// Advance the global turn counter (and all registered workspaces), resetting all read states to unread.
pub fn advance_turn() {
    let mut lock = STATE_MACHINE.lock().unwrap();
    lock.global_turn += 1;
    for turn in lock.workspace_turns.values_mut() {
        *turn += 1;
    }
    prune_files(&mut lock);
}

/// Reset all state (useful for unit test isolation).
pub fn reset_all() {
    let mut lock = STATE_MACHINE.lock().unwrap();
    lock.files.clear();
    lock.workspace_turns.clear();
    lock.global_turn = 1;
}

/// Record a successful `read` on `path`.
pub fn record_read(path: &Path) {
    let p = canon(path);
    let mut lock = STATE_MACHINE.lock().unwrap();
    let turn = get_turn_for_path(&p, &lock);
    let entry = lock
        .files
        .entry(p)
        .or_insert((turn, FileTurnState::default()));
    if entry.0 != turn {
        *entry = (
            turn,
            FileTurnState {
                read_confirmed: false,
                last_op: Some(FileOpKind::Read),
                confirmed_at_turn: Some(turn),
            },
        );
    } else {
        entry.1.last_op = Some(FileOpKind::Read);
        entry.1.confirmed_at_turn = Some(turn);
    }
}

/// Record a successful `edit` on `path`.
pub fn record_edit(path: &Path) {
    let p = canon(path);
    let mut lock = STATE_MACHINE.lock().unwrap();
    let turn = get_turn_for_path(&p, &lock);
    let entry = lock
        .files
        .entry(p)
        .or_insert((turn, FileTurnState::default()));
    if entry.0 != turn {
        *entry = (
            turn,
            FileTurnState {
                read_confirmed: false,
                last_op: Some(FileOpKind::Edit),
                confirmed_at_turn: None,
            },
        );
    } else {
        entry.1.last_op = Some(FileOpKind::Edit);
    }
}

/// Record a successful `write` on `path`.
pub fn record_write_success(path: &Path) {
    let p = canon(path);
    let mut lock = STATE_MACHINE.lock().unwrap();
    let turn = get_turn_for_path(&p, &lock);
    let entry = lock
        .files
        .entry(p)
        .or_insert((turn, FileTurnState::default()));
    entry.0 = turn;
    entry.1.read_confirmed = true;
    entry.1.last_op = Some(FileOpKind::Write);
    entry.1.confirmed_at_turn = None;
}

/// Record that a file has been confirmed read in this turn (e.g. by returning its full content on write intercept).
pub fn record_read_confirmed(path: &Path) {
    let p = canon(path);
    let mut lock = STATE_MACHINE.lock().unwrap();
    let turn = get_turn_for_path(&p, &lock);
    let entry = lock
        .files
        .entry(p)
        .or_insert((turn, FileTurnState::default()));
    entry.0 = turn;
    entry.1.read_confirmed = true;
    entry.1.last_op = Some(FileOpKind::Read);
    entry.1.confirmed_at_turn = Some(turn);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WritePermission {
    Allowed,
    RefusedUnread,
}

/// Check whether `write` is permitted on `path`.
/// Returns `WritePermission::Allowed` if:
/// - Target file does NOT exist (new file creation)
/// - Target file exists and has been confirmed read in this turn (either prior write succeeded, or last_op is Read)
pub fn check_write_permitted(path: &Path) -> WritePermission {
    if !path.exists() {
        return WritePermission::Allowed;
    }
    let p = canon(path);
    let mut lock = STATE_MACHINE.lock().unwrap();
    let turn = get_turn_for_path(&p, &lock);
    let entry = lock
        .files
        .entry(p)
        .or_insert((turn, FileTurnState::default()));
    if entry.0 != turn {
        // If the immediately preceding turn granted a read confirmation (e.g. from an intercept
        // that returned the full file content to the model), grant a one-turn grace period
        // so the model's next-turn retry write succeeds as promised in the interception message.
        let has_intercept_grace = (entry.1.read_confirmed
            || entry.1.last_op == Some(FileOpKind::Read))
            && entry.1.confirmed_at_turn.map_or(false, |t| t + 1 >= turn);

        if has_intercept_grace {
            entry.0 = turn;
            entry.1.read_confirmed = true;
            entry.1.last_op = Some(FileOpKind::Read);
            return WritePermission::Allowed;
        }

        // Reset for new turn
        *entry = (turn, FileTurnState::default());
        return WritePermission::RefusedUnread;
    }

    if entry.1.read_confirmed {
        // Persists until this turn ends
        return WritePermission::Allowed;
    }

    if entry.1.last_op == Some(FileOpKind::Read) {
        // First write in this turn, and the last operation before write was read!
        entry.1.read_confirmed = true;
        return WritePermission::Allowed;
    }

    WritePermission::RefusedUnread
}

/// Build the unread refusal message returning up to 1500 lines of the target file.
pub async fn build_unread_refusal_message(path: &Path, display_path: &str) -> String {
    let bytes = match tokio::fs::read(path).await {
        Ok(b) => b,
        Err(e) => {
            return format!(
                "❌ **[Write Intercepted: File Unread Confirmation Required]**\n\
                 The target file `{display_path}` already exists and has not been read in this conversation.\n\
                 Please read and confirm the file contents before overwriting it. (Failed to read disk contents: {e})"
            );
        }
    };

    if super::looks_binary(&bytes) {
        return format!(
            "❌ **[Write Intercepted: File Unread Confirmation Required]**\n\
             The target file `{display_path}` already exists (binary file, {} bytes) and has not been read in this conversation.\n\
             Please read and confirm the file contents before overwriting it.",
            bytes.len()
        );
    }

    let text: std::borrow::Cow<str> = match std::str::from_utf8(&bytes) {
        Ok(s) => std::borrow::Cow::Borrowed(s),
        Err(_) => match crate::tools::encoding::decode_non_utf8_text(path, &bytes) {
            Some(s) => std::borrow::Cow::Owned(s),
            None => {
                return format!(
                    "❌ **[Write Intercepted: File Unread Confirmation Required]**\n\
                     The target file `{display_path}` already exists (cannot be parsed as text) and has not been read in this conversation.\n\
                     Please read and confirm the file contents before overwriting it."
                );
            }
        },
    };

    let total = text.lines().count();
    let mut rendered_lines = String::new();
    let display_count = total.min(DEFAULT_READ_LIMIT);

    for (i, line) in text.lines().take(display_count).enumerate() {
        let n = i + 1;
        let is_anchor = i == 0 || n % 10 == 0;
        let rendered = if line.chars().count() > MAX_LINE_LEN {
            let head: String = line.chars().take(MAX_LINE_LEN).collect();
            if is_anchor {
                format!("{n}→{head}... (line truncated to {MAX_LINE_LEN} chars)\n")
            } else {
                format!("{head}... (line truncated to {MAX_LINE_LEN} chars)\n")
            }
        } else if is_anchor {
            format!("{n}→{line}\n")
        } else {
            format!("{line}\n")
        };
        rendered_lines.push_str(&rendered);
    }

    let footer = if total > DEFAULT_READ_LIMIT {
        let remaining = total - DEFAULT_READ_LIMIT;
        format!(
            "[Showing lines 1-{display_count} of {total}. {remaining} lines remaining.]\n\
             ⚠️ **Note**: The target file contains {total} lines in total; currently showing the first {display_count} lines ({remaining} lines remaining).\
             Please read the complete file (using `read` with offset={}, limit=1500) before writing.",
            DEFAULT_READ_LIMIT + 1
        )
    } else {
        record_read_confirmed(path);
        format!(
            "[Showing lines 1-{total} of {total} (complete content)]\n\
             Note: The above displays the complete content of the target file ({total} lines total). The file state has now been marked as read. Please confirm your intended changes and call `write` again to proceed."
        )
    };

    format!(
        "❌ **[Write Intercepted: File Unread Confirmation Required]**\n\
         The target file `{display_path}` already exists and has not been read in this conversation.\n\
         Safety rule: Before overwriting an existing file, you must first inspect its current content using `read`! Please verify the existing content before writing.\n\n\
         The first {display_count} lines of the current file content have been returned below for your inspection:\n\
         ```\n\
         {rendered_lines}```\n\
         {footer}"
    )
}

/// Lifecycle hook that advances the turn counter on each turn start,
/// resetting all file read confirmation states.
#[derive(Clone, Default, Debug)]
pub struct WriteStateHook {
    working_dir: Option<PathBuf>,
}

impl WriteStateHook {
    pub fn new() -> Self {
        Self { working_dir: None }
    }

    pub fn with_dir(working_dir: impl Into<PathBuf>) -> Self {
        Self {
            working_dir: Some(working_dir.into()),
        }
    }
}

#[async_trait]
impl LifecycleHooks for WriteStateHook {
    async fn turn_start(&self, _convo: &mut Conversation) {
        if let Some(dir) = &self.working_dir {
            advance_turn_for_dir(dir);
        } else {
            advance_turn();
        }
    }
}
