//! Append-only DISPLAY transcript.
//!
//! The model snapshot is intentionally compacted: old turns are drained into a
//! summary anchor so the provider context stays bounded. The WebUI/TUI, however,
//! must keep showing the full conversation. This module persists one JSONL record
//! per message, **outside** the model context, and never compacts it.
//!
//! Ordering: the file is append-only; a record's identity is `(turn_id, index)`.
//! `turn_id` is the kernel's monotonic turn counter, so a retried terminal can be
//! skipped idempotently. Unlike `snapshot.messages` indices, these never shift
//! when compaction replaces old history with a summary.
//!
//! Images are stored inline (base64) in v1. They are part of the record, so a
//! later compaction cannot remove them. A content-addressed blob store can be
//! layered under the same field without changing the read model.

use std::sync::Mutex;

use async_trait::async_trait;
use jeikcode_kernel::event::StopReason;
use jeikcode_kernel::hook::{LifecycleHooks, TurnCtx};
use jeikcode_kernel::message::{Conversation, Message, Role};
use serde::{Deserialize, Serialize};

use super::manager::SessionManager;
use super::{SessionResult, SessionStoreError};

pub const DISPLAY_VERSION: u32 = 4;
pub const MAX_DISPLAY_BYTES: usize = 512 * 1024 * 1024;
/// The reader loads the whole log (records + inline images). Keep a bounded
/// read but align it with realistic image-heavy sessions; beyond this the
/// daemon falls back to the snapshot projection and must not retry a backfill
/// that cannot be read back. A future streaming/indexed reader can lift this.
pub const MAX_DISPLAY_READ_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_DISPLAY_LINES: usize = 1_000_000;

/// One image attached to a user display row. `missing` marks a VL-preprocessed
/// submission whose original lives in the daemon's `.images.json` sidecar.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisplayImage {
    pub media_type: String,
    pub data: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub missing: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisplayToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// One display message. It mirrors the kernel message fields the UI needs, but is
/// a standalone DTO so it can never be fed back to a provider.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DisplayRecord {
    #[serde(default = "display_version")]
    pub v: u32,
    pub session_id: String,
    pub turn_id: u64,
    /// Position within this turn's conversation slice. `(turn_id, index)` is the
    /// idempotent identity for a retried terminal.
    pub index: u32,
    /// Session-global append order. Unlike `index`, this never resets per turn
    /// and never shifts on migration; it is the v4 log's `seq` cursor.
    #[serde(default)]
    pub seq: u64,
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default)]
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(default)]
    pub synthetic: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub internal_origin: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<DisplayToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub is_error: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<DisplayImage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
}

fn display_version() -> u32 {
    DISPLAY_VERSION
}

impl DisplayRecord {
    pub fn from_message(
        session_id: &str,
        working_dir: &std::path::Path,
        turn_id: u64,
        index: u32,
        message: &Message,
    ) -> Self {
        let role = match message.role {
            Role::System => "system",
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::Tool => "tool",
        };
        let mut images: Vec<DisplayImage> = message
            .images
            .iter()
            .map(|image| DisplayImage {
                media_type: image.media_type.clone(),
                data: image.data.clone(),
                missing: false,
            })
            .collect();
        // VL-preprocessed submissions keep a textual vision marker and no image
        // (the original lives in the daemon sidecar). Persist a placeholder so
        // the read path can re-attach the sidecar set in order.
        if message.role == Role::User
            && images.is_empty()
            && (message.text.contains("[图片内容（由") || message.text.contains("[图片识别失败]"))
        {
            images.push(DisplayImage {
                media_type: "image/png".into(),
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==".into(),
                missing: true,
            });
        }
        let content = if message.role == Role::User {
            super::user_text_for_display(working_dir, &message.text)
        } else {
            message.text.clone()
        };
        Self {
            v: DISPLAY_VERSION,
            session_id: session_id.to_string(),
            turn_id,
            index,
            seq: 0,
            role: role.to_string(),
            id: message.id.clone(),
            content,
            reasoning: message
                .reasoning
                .clone()
                .filter(|reasoning| !reasoning.is_empty()),
            synthetic: message.synthetic,
            internal_origin: message.internal_origin.clone(),
            tool_calls: message
                .tool_calls
                .iter()
                .map(|call| DisplayToolCall {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    arguments: call.arguments.clone(),
                })
                .collect(),
            tool_call_id: message.tool_call_id.clone(),
            is_error: message.is_error,
            images,
            created_at: (message.created_at_ms > 0).then_some(message.created_at_ms),
            elapsed_ms: message
                .meta
                .as_ref()
                .map(|meta| meta.elapsed_ms)
                .filter(|elapsed| *elapsed > 0),
        }
    }
}

/// Cap on the exact turn/prompt id sets. A session with more turns is far beyond
/// any realistic UI; the high-water mark still orders new appends.
const MAX_COMPLETED_TURNS: usize = 8192;

/// The prompting user row of a turn slice — the durable idempotency identity.
fn display_turn_prompt_id(records: &[DisplayRecord]) -> Option<String> {
    records
        .iter()
        .find(|record| {
            record.role.eq_ignore_ascii_case("user")
                && !record.synthetic
                && record.internal_origin.as_deref() != Some("presentation")
        })
        .and_then(|record| record.id.clone())
        .filter(|id| !id.is_empty())
}

/// Prompt identities present in a rewritten/backfilled projection. Presentation
/// rows are display-only and must not suppress a real future prompt.
fn display_completed_prompt_ids(records: &[DisplayRecord]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for record in records {
        if !record.role.eq_ignore_ascii_case("user") || record.synthetic {
            continue;
        }
        if record.internal_origin.as_deref() == Some("presentation") {
            continue;
        }
        let Some(id) = record.id.as_deref().filter(|id| !id.is_empty()) else {
            continue;
        };
        if !ids.iter().any(|known| known == id) {
            ids.push(id.to_string());
        }
    }
    if ids.len() > MAX_COMPLETED_TURNS {
        let drop = ids.len() - MAX_COMPLETED_TURNS;
        ids.drain(..drop);
    }
    ids
}

/// Sidecar telling the reader whether the log covers the whole session. A log
/// without meta (crash between append and meta write) is ignored and rebuilt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisplayMeta {
    #[serde(default = "display_version")]
    pub v: u32,
    /// False while a backfill/new log is being written.
    #[serde(default)]
    pub complete: bool,
    /// Highest kernel turn id covered. Future turns append above this.
    #[serde(default)]
    pub last_turn_id: u64,
    /// Highest session-global display sequence assigned in this log.
    #[serde(default)]
    pub last_seq: u64,
    /// Turn ids already present in this log. Unlike `last_turn_id` (a
    /// high-water mark), this is an exact set: a late terminal for a gap turn
    /// can still be appended after later turns without duplicating a turn.
    #[serde(default)]
    pub completed_turns: Vec<u64>,
    /// Prompt message ids that have a COMPLETED turn appended. Turn ids can be
    /// reused after a rewind, so the prompt id is the durable idempotency key.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub completed_prompt_ids: Vec<String>,
    /// Any user row already written early (opening prompt at admission / steer
    /// at fold). This is the row-dedup set; it must not imply turn completion.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub admitted_prompt_ids: Vec<String>,
    /// True when the prefix was reconstructed from the compacted snapshot/JSONL
    /// (images from already-drained turns cannot be recovered).
    #[serde(default)]
    pub backfilled: bool,
    #[serde(default)]
    pub updated_at: u64,
}

impl Default for DisplayMeta {
    fn default() -> Self {
        Self {
            v: DISPLAY_VERSION,
            complete: false,
            last_turn_id: 0,
            last_seq: 0,
            completed_turns: Vec::new(),
            completed_prompt_ids: Vec::new(),
            admitted_prompt_ids: Vec::new(),
            backfilled: false,
            updated_at: 0,
        }
    }
}

/// One sidecar index entry for segmented v4 reads. `offset` is the byte offset
/// of the record in the display log; `content` is only stored for user rows so
/// the rail can be rebuilt without parsing assistant/tool payloads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisplayIndexRow {
    pub seq: u64,
    pub offset: u64,
    pub role: String,
    pub turn_id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default)]
    pub synthetic: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub content: String,
}

fn index_rows_for_records(records: &[DisplayRecord]) -> Vec<DisplayIndexRow> {
    let mut offset = 0u64;
    records
        .iter()
        .map(|record| {
            let line_len = serde_json::to_vec(record)
                .map(|line| line.len())
                .unwrap_or(0) as u64;
            let row = DisplayIndexRow {
                seq: record.seq,
                offset,
                role: record.role.clone(),
                turn_id: record.turn_id,
                id: record.id.clone(),
                synthetic: record.synthetic,
                content: if record.role.eq_ignore_ascii_case("user") {
                    record.content.clone()
                } else {
                    String::new()
                },
            };
            offset = offset.saturating_add(line_len).saturating_add(1);
            row
        })
        .collect()
}

fn index_rows_for_bytes(bytes: &[u8]) -> Vec<DisplayIndexRow> {
    let mut offset = 0u64;
    let mut rows = Vec::new();
    for line in bytes.split(|byte| *byte == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_slice::<DisplayRecord>(line) else {
            break;
        };
        rows.push(DisplayIndexRow {
            seq: record.seq,
            offset,
            role: record.role.clone(),
            turn_id: record.turn_id,
            id: record.id.clone(),
            synthetic: record.synthetic,
            content: if record.role.eq_ignore_ascii_case("user") {
                record.content.clone()
            } else {
                String::new()
            },
        });
        offset = offset.saturating_add(line.len() as u64).saturating_add(1);
    }
    rows
}

/// Lifecycle hook that appends every completed turn to `<id>.display.jsonl`.
///
/// `turn_start` snapshots the conversation length AFTER the user message entered
/// history (the kernel pushes it before `run_turn`); the terminal then writes the
/// exact `[start..]` slice, preserving round order, reasoning, tool calls, tool
/// results and images.
#[derive(Clone, Debug)]
struct TurnAnchor {
    id: Option<String>,
    text: String,
    synthetic: bool,
    start_index: usize,
}

pub struct DisplayHook {
    mgr: std::sync::Arc<SessionManager>,
    session_id: String,
    working_dir: std::path::PathBuf,
    anchor: Mutex<Option<TurnAnchor>>,
}

impl DisplayHook {
    pub fn new(
        mgr: std::sync::Arc<SessionManager>,
        session_id: impl Into<String>,
        working_dir: impl Into<std::path::PathBuf>,
    ) -> Self {
        Self {
            mgr,
            session_id: session_id.into(),
            working_dir: working_dir.into(),
            anchor: Mutex::new(None),
        }
    }

    /// Append the conversation slice for one settled turn. Returns `false` when
    /// there is no valid prompt-anchored slice (rolled back / empty / turn_id 0).
    fn write_slice(&self, convo: &Conversation, turn_id: u64, anchor: Option<&TurnAnchor>) -> bool {
        // Mid-turn compaction can drain messages BEFORE the recorded start index.
        // Re-anchor on the turn's prompt message (id first, then text) so the
        // display slice still starts at the real user question.
        let anchored = anchor.and_then(|anchor| {
            anchor.id.as_deref().and_then(|id| {
                convo
                    .messages
                    .iter()
                    .rposition(|message| message.id.as_deref() == Some(id))
            })
        });
        let start = anchored.unwrap_or_else(|| {
            anchor
                .map(|anchor| anchor.start_index.min(convo.messages.len()))
                .unwrap_or(convo.messages.len())
        });
        if start >= convo.messages.len() || turn_id == 0 || convo.messages[start].role != Role::User
        {
            // Never write a slice that starts mid-assistant/tool: that would
            // persist a turn without its question. The caller may fall back to
            // `write_cancelled_user` when the turn was rolled back.
            return false;
        }
        let records: Vec<DisplayRecord> = convo.messages[start..]
            .iter()
            .enumerate()
            .map(|(index, message)| {
                DisplayRecord::from_message(
                    &self.session_id,
                    &self.working_dir,
                    turn_id,
                    u32::try_from(index).unwrap_or(u32::MAX),
                    message,
                )
            })
            .collect();
        if let Err(error) = self
            .mgr
            .append_display_turn(&self.session_id, turn_id, &records)
        {
            eprintln!("[DisplayHook] append display transcript failed: {error}");
            return false;
        }
        true
    }

    /// CANCEL = UNDO rolls the model context back to before the prompt. The UI
    /// transcript, however, must keep the user's question — and every steer
    /// that was folded into this turn before the cancel. Otherwise a refresh
    /// (or another browser) makes it look like those questions never existed —
    /// the "ghost question" bug.
    fn write_cancelled_user(
        &self,
        convo: &Conversation,
        turn_id: u64,
        anchor: Option<&TurnAnchor>,
    ) -> bool {
        let Some(anchor) = anchor else { return false };
        // Host-driven synthetic continuations are not user questions.
        if anchor.synthetic || turn_id == 0 || anchor.text.trim().is_empty() {
            return false;
        }
        let anchor_pos = anchor.id.as_deref().and_then(|id| {
            convo
                .messages
                .iter()
                .position(|message| message.id.as_deref() == Some(id))
        });
        let mut records: Vec<DisplayRecord> = Vec::new();
        if let Some(start) = anchor_pos {
            // PRESERVE mode (or a rolled-back slice that still carries the
            // prompt): keep the anchor and every real user row after it, so a
            // mid-turn steer survives a cancelled/failed turn.
            for (index, message) in convo.messages[start..].iter().enumerate() {
                if message.role != Role::User || message.synthetic {
                    continue;
                }
                let mut record = DisplayRecord::from_message(
                    &self.session_id,
                    &self.working_dir,
                    turn_id,
                    u32::try_from(index).unwrap_or(u32::MAX),
                    message,
                );
                // 与压缩归档行同一语义：它在模型上下文里不存在，编辑/删除必须禁用。
                record.internal_origin = Some("transcript_archive".into());
                records.push(record);
            }
        }
        if records.is_empty() {
            // The convo was rolled back before the prompt: keep the question
            // itself from the anchor so it is never a ghost.
            records.push(DisplayRecord {
                v: DISPLAY_VERSION,
                session_id: self.session_id.clone(),
                turn_id,
                index: 0,
                seq: 0,
                role: "user".into(),
                id: anchor.id.clone(),
                content: super::user_text_for_display(&self.working_dir, &anchor.text),
                reasoning: None,
                synthetic: false,
                internal_origin: Some("transcript_archive".into()),
                tool_calls: Vec::new(),
                tool_call_id: None,
                is_error: false,
                images: Vec::new(),
                created_at: Some(u64::try_from(super::now_ms()).unwrap_or(0)),
                elapsed_ms: None,
            });
        }
        // CANCEL = UNDO rolls the kernel context back, but the user already saw
        // the partial assistant stream. Persist that partial as a read-only
        // display row so a cold start / another browser still renders the text,
        // reasoning and tool calls that were on screen before the stop.
        if records
            .iter()
            .any(|record| record.role.eq_ignore_ascii_case("user"))
        {
            if let Some(partial) = super::partial::load_global(&self.session_id) {
                let has_partial = !partial.text.trim().is_empty()
                    || !partial.reasoning.trim().is_empty()
                    || !partial.tool_calls.is_empty();
                if has_partial {
                    let calls: Vec<jeikcode_kernel::tool::ToolCall> = partial
                        .tool_calls
                        .iter()
                        .filter_map(|call| {
                            Some(jeikcode_kernel::tool::ToolCall {
                                id: call.id.clone()?,
                                name: call.name.clone()?,
                                arguments: call.arguments.clone(),
                            })
                        })
                        .collect();
                    let mut message = Message::assistant(partial.text.clone(), calls);
                    message.reasoning =
                        (!partial.reasoning.trim().is_empty()).then(|| partial.reasoning.clone());
                    message.id = partial.message_id.clone();
                    let mut record = DisplayRecord::from_message(
                        &self.session_id,
                        &self.working_dir,
                        turn_id,
                        u32::try_from(records.len()).unwrap_or(u32::MAX),
                        &message,
                    );
                    // It no longer exists in the rolled-back model context.
                    record.internal_origin = Some("transcript_archive".into());
                    record.created_at = (partial.updated_at > 0).then_some(partial.updated_at);
                    records.push(record);
                }
            }
        }
        match self
            .mgr
            .append_display_turn(&self.session_id, turn_id, &records)
        {
            Ok(()) => true,
            Err(error) => {
                eprintln!("[DisplayHook] append cancelled turn failed: {error}");
                false
            }
        }
    }
}

#[async_trait]
impl LifecycleHooks for DisplayHook {
    async fn turn_start(&self, convo: &mut Conversation) {
        // The kernel pushes the prompt BEFORE run_turn→turn_start. Prefer the
        // latest real user message; for a synthetic continuation there is none,
        // so fall back to the last message (the synthetic prompt).
        let message = convo
            .messages
            .iter()
            .rev()
            .find(|message| message.role == Role::User && !message.synthetic)
            .or_else(|| convo.messages.last());
        *self
            .anchor
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = message.map(|message| TurnAnchor {
            id: message.id.clone(),
            text: message.text.clone(),
            synthetic: message.synthetic,
            start_index: convo.messages.len(),
        });
    }

    async fn turn_complete(&self, convo: &Conversation, reason: &StopReason, ctx: &TurnCtx) {
        // A rejected prompt never became a turn: nothing to show.
        if matches!(reason, StopReason::PromptRejected) {
            return;
        }
        let anchor = self
            .anchor
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if matches!(reason, StopReason::Cancelled) {
            // PRESERVE mode keeps the partial conversation → write it normally.
            // Default CANCEL = UNDO rolled it back → persist the question alone so
            // refresh / another browser still sees what was asked.
            if !self.write_slice(convo, ctx.turn_id, anchor.as_ref()) {
                self.write_cancelled_user(convo, ctx.turn_id, anchor.as_ref());
            }
            return;
        }
        self.write_slice(convo, ctx.turn_id, anchor.as_ref());
    }
}

impl SessionManager {
    /// Append-only UI transcript (never compacted). Sibling of the snapshot.
    pub fn display_path(&self, id: &str) -> SessionResult<std::path::PathBuf> {
        self.path_for(id, "display.jsonl")
    }

    /// Completeness/coverage sidecar for [`display_path`](Self::display_path).
    pub fn display_meta_path(&self, id: &str) -> SessionResult<std::path::PathBuf> {
        self.path_for(id, "display.meta.json")
    }

    /// Byte-offset/seq index for segmented v4 tail reads.
    pub fn display_index_path(&self, id: &str) -> SessionResult<std::path::PathBuf> {
        self.path_for(id, "display.idx.jsonl")
    }

    fn write_display_index(&self, id: &str, rows: &[DisplayIndexRow]) -> SessionResult<()> {
        let path = self.display_index_path(id)?;
        let mut bytes = Vec::with_capacity(rows.len() * 128);
        for row in rows {
            serde_json::to_writer(&mut bytes, row).map_err(|error| SessionStoreError::Corrupt {
                kind: "display index record",
                message: error.to_string(),
            })?;
            bytes.push(b'\n');
        }
        self.write_bytes_atomic(&path, &bytes, "display index", MAX_DISPLAY_BYTES)
    }

    fn read_display_index(&self, id: &str) -> SessionResult<Option<Vec<DisplayIndexRow>>> {
        let Some(meta) = crate::session::manager::read_json_optional::<DisplayMeta>(
            &self.display_meta_path(id)?,
            "display meta",
        )?
        else {
            return Ok(None);
        };
        if !meta.complete || meta.v != DISPLAY_VERSION {
            return Ok(None);
        }
        let path = self.display_index_path(id)?;
        let Ok(bytes) = self.read_bytes_bounded(&path, "display index", MAX_DISPLAY_READ_BYTES)
        else {
            return Ok(None);
        };
        let mut rows = Vec::new();
        let lines: Vec<&[u8]> = bytes.split(|byte| *byte == b'\n').collect();
        for (index, line) in lines.iter().enumerate() {
            if line.is_empty() {
                continue;
            }
            match serde_json::from_slice::<DisplayIndexRow>(line) {
                Ok(row) => rows.push(row),
                Err(_) if index + 1 == lines.len() => break,
                Err(_) => return Ok(None),
            }
        }
        if rows.last().map(|row| row.seq).unwrap_or(0) != meta.last_seq {
            return Ok(None);
        }
        let mut offset = 0u64;
        if rows.iter().any(|row| {
            let valid = row.offset >= offset;
            offset = row.offset;
            !valid
        }) {
            return Ok(None);
        }
        Ok(Some(rows))
    }

    /// Return the v4 meta + a complete offset index, rebuilding it once from the
    /// log when absent/stale. Tail readers can then seek without parsing the
    /// whole file on every page.
    pub fn ensure_display_index(
        &self,
        id: &str,
    ) -> SessionResult<Option<(DisplayMeta, Vec<DisplayIndexRow>)>> {
        if let Some(rows) = self.read_display_index(id)? {
            let meta = match self.read_display(id)? {
                Some((meta, _)) => meta,
                None => return Ok(None),
            };
            return Ok(Some((meta, rows)));
        }
        let Some((meta, records)) = self.read_display(id)? else {
            return Ok(None);
        };
        let rows = index_rows_for_records(&records);
        if self.write_display_index(id, &rows).is_err() {
            return Ok(None);
        }
        Ok(Some((meta, rows)))
    }

    /// Append one completed turn. A log is only created for a brand-new session
    /// (turn 1). For an existing session without a log, the daemon backfills on
    /// the next idle read; writing only the new turn would create a partial log.
    pub(crate) fn append_display_turn(
        &self,
        id: &str,
        turn_id: u64,
        records: &[DisplayRecord],
    ) -> SessionResult<()> {
        self.with_display_lock(id, || {
            self.append_display_turn_unlocked(id, turn_id, records)
        })
    }

    fn append_display_turn_unlocked(
        &self,
        id: &str,
        turn_id: u64,
        records: &[DisplayRecord],
    ) -> SessionResult<()> {
        if records.is_empty() {
            return Ok(());
        }
        let meta_path = self.display_meta_path(id)?;
        let mut meta = match crate::session::manager::read_json_optional::<DisplayMeta>(
            &meta_path,
            "display meta",
        )? {
            Some(meta) => meta,
            None => {
                if turn_id != 1 {
                    return Ok(());
                }
                // First turn of a brand-new session: this append WILL make the
                // log complete. Do not trip the incomplete-log guard below.
                DisplayMeta {
                    complete: true,
                    ..DisplayMeta::default()
                }
            }
        };
        // Never append to a log written by a different projection. The next
        // read returns None and the daemon backfills it in the current schema.
        if meta.v != DISPLAY_VERSION {
            return Ok(());
        }
        // Idempotent terminal: a turn already present must not be written twice.
        // Identity is the PROMPT message id, not the turn id: a rewind may reuse
        // a turn id, and the old turn-id set would silently drop the NEW turn.
        // A legacy meta without prompt ids keeps the old turn-id guard until the
        // next idle read rebuilds it.
        let prompt_id = display_turn_prompt_id(records);
        let prompt_completed = prompt_id.as_deref().is_some_and(|prompt_id| {
            meta.completed_prompt_ids
                .iter()
                .any(|known| known == prompt_id)
        });
        // `completed_prompt_ids` is the SETTLED-turn idempotency key. Admission
        // writes only to `admitted_prompt_ids`, so a prompt written early cannot
        // suppress the assistant/tool remainder here.
        if prompt_completed {
            return Ok(());
        }
        if meta.completed_prompt_ids.is_empty() && meta.admitted_prompt_ids.is_empty() {
            // Truly legacy meta (no prompt identity at all): the turn-id
            // high-water mark is all we have.
            if meta.completed_turns.contains(&turn_id)
                || (meta.completed_turns.is_empty() && meta.last_turn_id >= turn_id)
            {
                return Ok(());
            }
        } else if prompt_id.is_none() && meta.completed_turns.contains(&turn_id) {
            // Identity-less turn (legacy row): the turn id is all we have.
            return Ok(());
        }
        if !meta.complete {
            // A crashed backfill / first-turn write is incomplete. Let the reader
            // rebuild instead of appending to a partial log.
            return Ok(());
        }
        let append_records: Vec<&DisplayRecord> = records
            .iter()
            .filter(|record| {
                // Admission may have written the opening prompt (and a future
                // incremental writer may have written steers). Those ids are
                // authoritative and must not be appended a second time at
                // turn_complete. Assistant/tool records keep their own ids.
                record.id.as_deref().map_or(true, |id| {
                    !meta.admitted_prompt_ids.iter().any(|known| known == id)
                        && !meta.completed_prompt_ids.iter().any(|known| known == id)
                })
            })
            .collect();
        if append_records.is_empty() {
            return Ok(());
        }
        let mut bytes = Vec::with_capacity(append_records.len() * 512);
        let mut next_seq = meta.last_seq;
        for record in append_records {
            next_seq = next_seq.saturating_add(1);
            let mut record = record.clone();
            record.v = DISPLAY_VERSION;
            record.seq = next_seq;
            serde_json::to_writer(&mut bytes, &record).map_err(|error| {
                SessionStoreError::Corrupt {
                    kind: "display record",
                    message: error.to_string(),
                }
            })?;
            bytes.push(b'\n');
        }
        let path = self.display_path(id)?;
        self.append_jsonl_line_at(id, &path, "display transcript", &bytes)?;
        meta.last_turn_id = meta.last_turn_id.max(turn_id);
        meta.last_seq = next_seq;
        if !meta.completed_turns.contains(&turn_id) {
            meta.completed_turns.push(turn_id);
        }
        for record in records {
            if !record.role.eq_ignore_ascii_case("user") {
                continue;
            }
            let Some(id) = record.id.as_deref() else {
                continue;
            };
            if !meta.admitted_prompt_ids.iter().any(|known| known == id) {
                meta.admitted_prompt_ids.push(id.to_string());
            }
        }
        if let Some(prompt_id) = prompt_id {
            if !meta
                .completed_prompt_ids
                .iter()
                .any(|known| known == &prompt_id)
            {
                meta.completed_prompt_ids.push(prompt_id);
            }
        }
        // Keep the exact sets bounded. A session with >8192 turns is far beyond
        // any realistic UI; the high-water mark still orders new appends.
        if meta.completed_turns.len() > MAX_COMPLETED_TURNS {
            let drop = meta.completed_turns.len() - MAX_COMPLETED_TURNS;
            meta.completed_turns.drain(..drop);
        }
        if meta.completed_prompt_ids.len() > MAX_COMPLETED_TURNS {
            let drop = meta.completed_prompt_ids.len() - MAX_COMPLETED_TURNS;
            meta.completed_prompt_ids.drain(..drop);
        }
        if meta.admitted_prompt_ids.len() > MAX_COMPLETED_TURNS {
            let drop = meta.admitted_prompt_ids.len() - MAX_COMPLETED_TURNS;
            meta.admitted_prompt_ids.drain(..drop);
        }
        meta.updated_at = u64::try_from(super::now_ms()).unwrap_or(0);
        self.write_display_meta(id, &meta)?;
        // The append changed last_seq; the old index is stale. The next tail read
        // rebuilds it once from the (now complete) log.
        if let Ok(path) = self.display_index_path(id) {
            let _ = std::fs::remove_file(path);
        }
        Ok(())
    }

    /// Replace the log with a complete snapshot-derived projection. Used for the
    /// first read of an old session (and after an explicit mutation).
    pub fn write_display_backfill(
        &self,
        id: &str,
        records: &[DisplayRecord],
        last_turn_id: u64,
    ) -> SessionResult<()> {
        self.rewrite_display_rows(id, records, last_turn_id, &[], true)
    }

    /// Append an admitted user prompt directly to `display.jsonl` upon acceptance.
    /// This establishes the physical user record on disk BEFORE any model generation,
    /// ensuring that the prompt is already in the display transcript with an authoritative
    /// monotonic `seq` at the true beginning of the turn.
    pub fn append_display_user(
        &self,
        id: &str,
        prompt_id: &str,
        content: &str,
        images: &[DisplayImage],
        created_at: Option<u64>,
    ) -> SessionResult<Option<DisplayRecord>> {
        self.with_display_lock(id, || {
            let meta_path = self.display_meta_path(id)?;
            let mut meta = match crate::session::manager::read_json_optional::<DisplayMeta>(
                &meta_path,
                "display meta",
            )? {
                Some(meta) => meta,
                None => DisplayMeta {
                    complete: true,
                    ..DisplayMeta::default()
                },
            };
            if meta.v != DISPLAY_VERSION || !meta.complete {
                return Ok(None);
            }
            if meta.admitted_prompt_ids.iter().any(|k| k == prompt_id)
                || meta.completed_prompt_ids.iter().any(|k| k == prompt_id)
            {
                return Ok(None);
            }
            let next_seq = meta.last_seq.saturating_add(1);
            let next_turn_id = meta.last_turn_id.saturating_add(1);
            let record = DisplayRecord {
                v: DISPLAY_VERSION,
                session_id: id.to_string(),
                turn_id: next_turn_id,
                index: 0,
                seq: next_seq,
                role: "user".to_string(),
                id: Some(prompt_id.to_string()),
                content: content.to_string(),
                reasoning: None,
                synthetic: false,
                internal_origin: None,
                tool_calls: Vec::new(),
                tool_call_id: None,
                is_error: false,
                images: images.to_vec(),
                created_at,
                elapsed_ms: None,
            };
            let mut bytes = Vec::with_capacity(512);
            serde_json::to_writer(&mut bytes, &record).map_err(|error| {
                SessionStoreError::Corrupt {
                    kind: "display user record",
                    message: error.to_string(),
                }
            })?;
            bytes.push(b'\n');
            let path = self.display_path(id)?;
            self.append_jsonl_line_at(id, &path, "display transcript", &bytes)?;
            meta.last_turn_id = next_turn_id;
            meta.last_seq = next_seq;
            meta.admitted_prompt_ids.push(prompt_id.to_string());
            meta.updated_at = u64::try_from(super::now_ms()).unwrap_or(0);
            self.write_display_meta(id, &meta)?;
            if let Ok(idx_path) = self.display_index_path(id) {
                let _ = std::fs::remove_file(idx_path);
            }
            Ok(Some(record))
        })
    }

    /// Append a standalone display-only notice record (e.g. compaction mark,
    /// tool-fold notice, command notice, or warning) to `display.jsonl` with an
    /// authoritative monotonic `seq` and unique `id`. Never enters `snapshot.messages`
    /// or `model_history`.
    pub fn append_display_notice(
        &self,
        id: &str,
        content: impl Into<String>,
        notice_id: Option<String>,
    ) -> SessionResult<Option<DisplayRecord>> {
        let text = content.into();
        let text = text.trim().to_string();
        if text.is_empty() {
            return Ok(None);
        }
        self.with_display_lock(id, || {
            let meta_path = self.display_meta_path(id)?;
            let Some(mut meta) = crate::session::manager::read_json_optional::<DisplayMeta>(
                &meta_path,
                "display meta",
            )?
            else {
                return Ok(None);
            };
            if meta.v != DISPLAY_VERSION || !meta.complete {
                return Ok(None);
            }
            let next_seq = meta.last_seq.saturating_add(1);
            let record_id = notice_id.unwrap_or_else(|| format!("notice-{}", uuid::Uuid::new_v4()));
            let record = DisplayRecord {
                v: DISPLAY_VERSION,
                session_id: id.to_string(),
                turn_id: meta.last_turn_id,
                index: 0,
                seq: next_seq,
                role: "assistant".to_string(),
                id: Some(record_id),
                content: text,
                reasoning: None,
                synthetic: false,
                internal_origin: Some("turn_diagnostic".to_string()),
                tool_calls: Vec::new(),
                tool_call_id: None,
                is_error: false,
                images: Vec::new(),
                created_at: Some(u64::try_from(super::now_ms()).unwrap_or(0)),
                elapsed_ms: None,
            };
            let mut bytes = Vec::with_capacity(256);
            serde_json::to_writer(&mut bytes, &record).map_err(|error| {
                SessionStoreError::Corrupt {
                    kind: "display notice record",
                    message: error.to_string(),
                }
            })?;
            bytes.push(b'\n');
            let path = self.display_path(id)?;
            self.append_jsonl_line_at(id, &path, "display transcript", &bytes)?;
            meta.last_seq = next_seq;
            meta.updated_at = u64::try_from(super::now_ms()).unwrap_or(0);
            self.write_display_meta(id, &meta)?;
            if let Ok(idx_path) = self.display_index_path(id) {
                let _ = std::fs::remove_file(idx_path);
            }
            Ok(Some(record))
        })
    }

    /// Rewrite the v4 log in place (explicit mutation). `backfilled=false` keeps
    /// the exact `completed_turns` contract, so a normal read can trust the
    /// trimmed log without falling back to the snapshot.
    pub(crate) fn display_has_presentation_request(
        &self,
        id: &str,
        anchor_turn_id: u64,
        request_id: &str,
    ) -> bool {
        let Some((meta, records)) = self.read_display(id).ok().flatten() else {
            return false;
        };
        if meta.v != DISPLAY_VERSION {
            return false;
        }
        let prefix = format!("presentation-{anchor_turn_id}-{request_id}-");
        records.iter().any(|record| {
            record.internal_origin.as_deref() == Some("presentation")
                && record
                    .id
                    .as_deref()
                    .is_some_and(|id| id.starts_with(&prefix))
        })
    }

    /// Insert display-only rows at an anchor turn under the display lock. The
    /// read + splice + rewrite is one critical section so a concurrent
    /// turn-complete append cannot be overwritten by a stale read.
    pub(crate) fn insert_presentation_rows(
        &self,
        id: &str,
        anchor_turn_id: u64,
        rows: &[(String, String)],
        request_id: Option<&str>,
    ) -> SessionResult<bool> {
        if rows.is_empty() {
            return Ok(true);
        }
        self.with_display_lock(id, || {
            let Some((meta, mut records)) = self.read_display(id)? else {
                return Ok(false);
            };
            if meta.v != DISPLAY_VERSION {
                // v3 is migration input; never delete it here.
                return Ok(false);
            }
            if let Some(request_id) = request_id {
                let prefix = format!("presentation-{anchor_turn_id}-{request_id}-");
                if records.iter().any(|record| {
                    record.internal_origin.as_deref() == Some("presentation")
                        && record
                            .id
                            .as_deref()
                            .is_some_and(|id| id.starts_with(&prefix))
                }) {
                    return Ok(true);
                }
            }
            let insert_at = if anchor_turn_id == 0 {
                Some(0usize)
            } else {
                records
                    .iter()
                    .rposition(|record| record.turn_id == anchor_turn_id)
                    .map(|position| position + 1)
            };
            let Some(insert_at) = insert_at else {
                // The v4 log cannot address the anchor. Drop it under the same
                // display lock so a concurrent turn-complete append cannot land
                // between this decision and invalidation.
                self.invalidate_display_unlocked(id)?;
                return Ok(false);
            };
            let next_index = records
                .iter()
                .filter(|record| record.turn_id == anchor_turn_id)
                .map(|record| record.index)
                .max()
                .unwrap_or(0)
                .saturating_add(1);
            let id_epoch = meta.last_seq.saturating_add(1);
            let new_rows: Vec<DisplayRecord> = rows
                .iter()
                .enumerate()
                .map(|(index, (role, content))| DisplayRecord {
                    v: DISPLAY_VERSION,
                    session_id: id.to_string(),
                    turn_id: anchor_turn_id,
                    index: next_index.saturating_add(u32::try_from(index).unwrap_or(u32::MAX)),
                    seq: 0,
                    role: role.clone(),
                    id: Some(match request_id {
                        Some(request_id) => {
                            format!("presentation-{anchor_turn_id}-{request_id}-{index}")
                        }
                        None => format!("presentation-{anchor_turn_id}-{id_epoch}-{index}"),
                    }),
                    content: content.clone(),
                    reasoning: None,
                    synthetic: false,
                    internal_origin: Some("presentation".into()),
                    tool_calls: Vec::new(),
                    tool_call_id: None,
                    is_error: false,
                    images: Vec::new(),
                    created_at: None,
                    elapsed_ms: None,
                })
                .collect();
            records.splice(insert_at..insert_at, new_rows);
            self.rewrite_display_rows_unlocked(
                id,
                &records,
                meta.last_turn_id,
                &meta.completed_turns,
                meta.backfilled,
            )?;
            Ok(true)
        })
    }

    pub fn rewrite_display_rows(
        &self,
        id: &str,
        records: &[DisplayRecord],
        last_turn_id: u64,
        completed_turns: &[u64],
        backfilled: bool,
    ) -> SessionResult<()> {
        self.with_display_lock(id, || {
            self.rewrite_display_rows_unlocked(
                id,
                records,
                last_turn_id,
                completed_turns,
                backfilled,
            )
        })
    }

    fn rewrite_display_rows_unlocked(
        &self,
        id: &str,
        records: &[DisplayRecord],
        last_turn_id: u64,
        completed_turns: &[u64],
        backfilled: bool,
    ) -> SessionResult<()> {
        let meta_path = self.display_meta_path(id)?;
        // Drop the old index first: a crash between the log rewrite and the new
        // index must never leave a same-length stale index that still passes the
        // `last_seq` check.
        if let Ok(path) = self.display_index_path(id) {
            let _ = std::fs::remove_file(path);
        }
        let mut incomplete = DisplayMeta {
            complete: false,
            last_turn_id: 0,
            last_seq: 0,
            completed_turns: completed_turns.to_vec(),
            completed_prompt_ids: display_completed_prompt_ids(records),
            admitted_prompt_ids: display_completed_prompt_ids(records),
            backfilled,
            updated_at: u64::try_from(super::now_ms()).unwrap_or(0),
            ..DisplayMeta::default()
        };
        self.write_display_meta(id, &incomplete)?;
        let path = self.display_path(id)?;
        let mut bytes = Vec::with_capacity(records.len() * 512);
        let mut next_seq = 0u64;
        for record in records {
            next_seq = next_seq.saturating_add(1);
            let mut record = record.clone();
            record.v = DISPLAY_VERSION;
            record.seq = next_seq;
            serde_json::to_writer(&mut bytes, &record).map_err(|error| {
                SessionStoreError::Corrupt {
                    kind: "display record",
                    message: error.to_string(),
                }
            })?;
            bytes.push(b'\n');
        }
        self.write_bytes_atomic(&path, &bytes, "display transcript", MAX_DISPLAY_BYTES)?;
        let index_rows = index_rows_for_bytes(&bytes);
        if self.write_display_index(id, &index_rows).is_err() {
            if let Ok(path) = self.display_index_path(id) {
                let _ = std::fs::remove_file(path);
            }
        }
        incomplete.complete = true;
        incomplete.last_turn_id = last_turn_id;
        incomplete.last_seq = next_seq;
        incomplete.updated_at = u64::try_from(super::now_ms()).unwrap_or(0);
        self.write_display_meta(id, &incomplete)
    }

    fn write_display_meta(&self, id: &str, meta: &DisplayMeta) -> SessionResult<()> {
        let path = self.display_meta_path(id)?;
        let bytes =
            serde_json::to_vec_pretty(meta).map_err(|error| SessionStoreError::Corrupt {
                kind: "display meta",
                message: error.to_string(),
            })?;
        self.write_bytes_atomic(&path, &bytes, "display meta", 64 * 1024)
    }

    /// Read a complete display log. `None` means it is absent or incomplete; the
    /// caller must fall back to the snapshot projection (and may backfill).
    pub fn read_display(
        &self,
        id: &str,
    ) -> SessionResult<Option<(DisplayMeta, Vec<DisplayRecord>)>> {
        let meta_path = self.display_meta_path(id)?;
        let Some(meta) =
            crate::session::manager::read_json_optional::<DisplayMeta>(&meta_path, "display meta")?
        else {
            return Ok(None);
        };
        // An old/future display projection must be rebuilt from the canonical
        // state rather than interpreted with the current coordinate system. v3
        // is still readable as a MIGRATION SOURCE; the normal read path filters
        // for `v == 4` and never trusts v3 directly.
        if !meta.complete || !matches!(meta.v, 3 | DISPLAY_VERSION) {
            return Ok(None);
        }
        let path = self.display_path(id)?;
        let bytes =
            match self.read_bytes_bounded(&path, "display transcript", MAX_DISPLAY_READ_BYTES) {
                Ok(bytes) => bytes,
                Err(SessionStoreError::NotFound { .. }) => return Ok(None),
                Err(error) => return Err(error),
            };
        let mut records = Vec::new();
        let mut last_seq = 0u64;
        let lines: Vec<&[u8]> = bytes.split(|byte| *byte == b'\n').collect();
        for (index, line) in lines.iter().enumerate() {
            if line.is_empty() {
                continue;
            }
            if records.len() >= MAX_DISPLAY_LINES {
                return Err(SessionStoreError::TooLarge {
                    kind: "display lines",
                    limit: MAX_DISPLAY_LINES,
                    actual: records.len() + 1,
                });
            }
            match serde_json::from_slice::<DisplayRecord>(line) {
                Ok(record) if matches!(record.v, 3 | DISPLAY_VERSION) => {
                    if record.v == DISPLAY_VERSION {
                        // v4 seq is the ordering contract: strictly increasing and
                        // mirrored by meta.last_seq. A crash between the append and
                        // the meta write falls back to the canonical rebuild.
                        if record.seq == 0 || record.seq <= last_seq {
                            return Ok(None);
                        }
                        last_seq = record.seq;
                    }
                    records.push(record);
                }
                // A record from another schema cannot be mixed with current
                // coordinates; fall back to the snapshot projection.
                Ok(_) => return Ok(None),
                // A crash can leave a partial final line. Ignore ONLY that line;
                // corruption in the middle is explicit.
                Err(_) if index + 1 == lines.len() => break,
                Err(error) => {
                    return Err(SessionStoreError::Corrupt {
                        kind: "display record",
                        message: error.to_string(),
                    })
                }
            }
        }
        if meta.v == DISPLAY_VERSION && meta.last_seq != last_seq {
            return Ok(None);
        }
        Ok(Some((meta, records)))
    }

    /// Drop the display log + meta so the next read rebuilds from the snapshot.
    /// Compaction must NEVER call this; explicit mutations/deletes do.
    pub fn invalidate_display(&self, id: &str) -> SessionResult<()> {
        self.with_display_lock(id, || self.invalidate_display_unlocked(id))
    }

    fn invalidate_display_unlocked(&self, id: &str) -> SessionResult<()> {
        for path in [
            self.display_meta_path(id)?,
            self.display_path(id)?,
            self.display_index_path(id)?,
        ] {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(source) => return Err(SessionStoreError::Io { path, source }),
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(turn_id: u64, index: u32, text: &str) -> DisplayRecord {
        DisplayRecord {
            v: DISPLAY_VERSION,
            session_id: "s1".into(),
            turn_id,
            index,
            seq: 0,
            role: "user".into(),
            id: Some(format!("m-{turn_id}-{index}")),
            content: text.into(),
            reasoning: None,
            synthetic: false,
            internal_origin: None,
            tool_calls: Vec::new(),
            tool_call_id: None,
            is_error: false,
            images: Vec::new(),
            created_at: Some(1_000 + i64::from(index) as u64),
            elapsed_ms: None,
        }
    }

    #[test]
    fn display_log_is_append_only_and_idempotent_per_turn() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::with_root(dir.path());
        mgr.append_display_turn("s1", 1, &[record(1, 0, "Q1"), record(1, 1, "A1")])
            .unwrap();
        let (meta, rows) = mgr.read_display("s1").unwrap().unwrap();
        assert!(meta.complete);
        assert_eq!(meta.last_turn_id, 1);
        assert_eq!(rows.len(), 2);

        mgr.append_display_turn("s1", 2, &[record(2, 0, "Q2")])
            .unwrap();
        // A retried terminal for turn 2 must not duplicate rows.
        mgr.append_display_turn("s1", 2, &[record(2, 0, "Q2")])
            .unwrap();
        let (meta, rows) = mgr.read_display("s1").unwrap().unwrap();
        assert_eq!(meta.last_turn_id, 2);
        assert_eq!(rows.len(), 3);

        // Turn ids may have gaps (cancelled/rejected turns never wrote a log).
        // Once a complete log exists, appending the next settled turn is fine.
        mgr.append_display_turn("s1", 5, &[record(5, 0, "late")])
            .unwrap();
        let (_, rows) = mgr.read_display("s1").unwrap().unwrap();
        assert_eq!(rows.len(), 4);
    }

    #[test]
    fn reused_turn_id_appends_a_new_prompt_but_skips_the_same_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::with_root(dir.path());
        let mut q1 = record(1, 0, "Q1");
        q1.role = "user".into();
        let mut a1 = record(1, 1, "A1");
        a1.role = "assistant".into();
        mgr.append_display_turn("s1", 1, &[q1.clone(), a1.clone()])
            .unwrap();
        let (meta, rows) = mgr.read_display("s1").unwrap().unwrap();
        assert_eq!(meta.completed_prompt_ids, vec!["m-1-0"]);
        assert_eq!(rows.len(), 2);

        // A retried terminal for the SAME prompt is idempotent.
        mgr.append_display_turn("s1", 1, &[q1, a1]).unwrap();
        let (_, rows) = mgr.read_display("s1").unwrap().unwrap();
        assert_eq!(rows.len(), 2);

        // A NEW prompt that reused turn id 1 (rewind restored the counter) must
        // append: the prompt id, not the turn id, is the idempotency key.
        mgr.append_display_turn("s1", 1, &[record(1, 2, "Q2")])
            .unwrap();
        let (meta, rows) = mgr.read_display("s1").unwrap().unwrap();
        assert_eq!(rows.len(), 3);
        assert!(meta.completed_prompt_ids.contains(&"m-1-0".to_string()));
        assert!(meta.completed_prompt_ids.contains(&"m-1-2".to_string()));
    }

    #[test]
    fn admission_prompt_is_not_duplicated_at_turn_complete() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::with_root(dir.path());
        let open = record(1, 0, "Q1");
        mgr.append_display_user("s1", "m-1-0", "Q1", &[], Some(1_000))
            .unwrap();

        let mut assistant = record(1, 1, "A1");
        assistant.role = "assistant".into();
        mgr.append_display_turn("s1", 1, &[open, assistant])
            .unwrap();

        let (_, rows) = mgr.read_display("s1").unwrap().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows.iter().filter(|row| row.role == "user").count(), 1);
        assert_eq!(rows.iter().filter(|row| row.role == "assistant").count(), 1);
    }

    #[test]
    fn display_log_is_not_created_from_a_later_turn_without_a_backfill() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::with_root(dir.path());
        mgr.append_display_turn("s1", 5, &[record(5, 0, "late")])
            .unwrap();
        assert!(mgr.read_display("s1").unwrap().is_none());
    }

    #[test]
    fn display_backfill_then_append_keeps_old_and_new_turns() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::with_root(dir.path());
        mgr.write_display_backfill("s1", &[record(0, 0, "old Q"), record(0, 1, "old A")], 7)
            .unwrap();
        let (meta, rows) = mgr.read_display("s1").unwrap().unwrap();
        assert!(meta.backfilled);
        assert_eq!(meta.last_turn_id, 7);
        assert_eq!(meta.last_seq, 2);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].seq, 1);
        assert_eq!(rows[1].seq, 2);

        mgr.append_display_turn("s1", 8, &[record(8, 0, "new Q")])
            .unwrap();
        let (meta, rows) = mgr.read_display("s1").unwrap().unwrap();
        assert_eq!(meta.last_turn_id, 8);
        assert_eq!(meta.last_seq, 3);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[2].content, "new Q");
        assert_eq!(rows[2].seq, 3);
    }

    #[test]
    fn display_reader_ignores_a_partial_final_line() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::with_root(dir.path());
        mgr.append_display_turn("s1", 1, &[record(1, 0, "Q1")])
            .unwrap();
        let path = mgr.display_path("s1").unwrap();
        let mut bytes = std::fs::read(&path).unwrap();
        bytes.extend_from_slice(b"{\"v\":1,\"session_id\":\"s1\",\"turn_id\":2");
        std::fs::write(&path, bytes).unwrap();
        let (_, rows) = mgr.read_display("s1").unwrap().unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[tokio::test]
    async fn display_hook_reanchors_on_the_prompt_after_prefix_compaction() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = std::sync::Arc::new(SessionManager::with_root(dir.path()));
        let hook = DisplayHook::new(mgr.clone(), "s1", dir.path());
        let mut convo = Conversation::new();
        convo.push(Message::system("system prompt"));
        convo.push(Message::user_with_images(
            "Q1",
            vec![jeikcode_kernel::message::ImageContent {
                media_type: "image/png".into(),
                data: "AAAA".into(),
            }],
        ));
        hook.turn_start(&mut convo).await;

        // Mid-turn compaction drains the prefix; the recorded start index is now
        // stale. The hook must re-anchor on Q1 by identity, not on the old index.
        convo.messages.remove(0);
        convo.push(Message::assistant("A1", Vec::new()));
        let ctx = TurnCtx {
            turn_id: 1,
            ..Default::default()
        };
        hook.turn_complete(&convo, &StopReason::Stopped, &ctx).await;

        let (meta, rows) = mgr.read_display("s1").unwrap().unwrap();
        assert!(meta.complete);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].content, "Q1");
        assert_eq!(rows[0].images[0].data, "AAAA");
        assert_eq!(rows[1].content, "A1");
    }

    /// CANCEL = UNDO 会把模型上下文回滚到提问之前；但展示转录必须留下提问，
    /// 否则刷新/异地打开时提问就像从未存在过。
    #[tokio::test]
    async fn cancelled_turn_keeps_the_user_question() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = std::sync::Arc::new(SessionManager::with_root(dir.path()));
        let hook = DisplayHook::new(mgr.clone(), "s1", dir.path());
        let mut convo = Conversation::new();
        convo.push(Message::system("system prompt"));
        convo.push(Message::user("请帮我修这个问题"));
        hook.turn_start(&mut convo).await;
        let prompt_id = convo.messages[1].id.clone();

        // 默认取消路径：内核在 turn_complete 之前已经把提问回滚掉。
        convo.messages.truncate(1);
        let ctx = TurnCtx {
            turn_id: 1,
            ..Default::default()
        };
        hook.turn_complete(&convo, &StopReason::Cancelled, &ctx)
            .await;

        let (meta, rows) = mgr.read_display("s1").unwrap().unwrap();
        assert!(meta.complete);
        assert_eq!(
            rows.len(),
            1,
            "cancelled turn must keep exactly the question"
        );
        assert_eq!(rows[0].role, "user");
        assert_eq!(rows[0].content, "请帮我修这个问题");
        assert_eq!(
            rows[0].id, prompt_id,
            "the stored id must survive the rollback"
        );
        assert_eq!(rows[0].turn_id, 1);
    }

    #[tokio::test]
    async fn cancelled_turn_keeps_folded_steers_when_context_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = std::sync::Arc::new(SessionManager::with_root(dir.path()));
        let hook = DisplayHook::new(mgr.clone(), "s1", dir.path());
        let mut convo = Conversation::new();
        convo.push(Message::system("system prompt"));
        convo.push(Message::user("主提问"));
        hook.turn_start(&mut convo).await;
        let prompt_id = convo.messages[1].id.clone();

        // The user steered before the turn was stopped. PRESERVE mode keeps
        // both user rows + the partial assistant; the transcript must too.
        convo.push(Message::assistant("partial answer", Vec::new()));
        let mut steer = Message::user("中途转向");
        steer.id = Some("steer-1".into());
        convo.push(steer);
        convo.push(Message::assistant("steer partial", Vec::new()));
        let ctx = TurnCtx {
            turn_id: 1,
            ..Default::default()
        };
        hook.turn_complete(&convo, &StopReason::Cancelled, &ctx)
            .await;

        let (_, rows) = mgr.read_display("s1").unwrap().unwrap();
        let users: Vec<_> = rows.iter().filter(|row| row.role == "user").collect();
        assert_eq!(
            users.len(),
            2,
            "the prompt and the folded steer are both durable"
        );
        assert_eq!(users[0].id, prompt_id);
        assert_eq!(users[1].id.as_deref(), Some("steer-1"));
        assert!(
            rows.iter()
                .any(|row| row.role == "assistant" && row.content == "partial answer"),
            "partial assistant work must survive the interruption"
        );
    }

    #[tokio::test]
    async fn rejected_prompt_is_not_persisted() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = std::sync::Arc::new(SessionManager::with_root(dir.path()));
        let hook = DisplayHook::new(mgr.clone(), "s1", dir.path());
        let mut convo = Conversation::new();
        convo.push(Message::user("rejected"));
        hook.turn_start(&mut convo).await;
        let ctx = TurnCtx {
            turn_id: 1,
            ..Default::default()
        };
        hook.turn_complete(&convo, &StopReason::PromptRejected, &ctx)
            .await;
        assert!(mgr.read_display("s1").unwrap().is_none());
    }

    #[test]
    fn v3_log_is_readable_as_migration_input_and_v4_backfill_assigns_seq() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::with_root(dir.path());
        mgr.write_display_meta(
            "s1",
            &DisplayMeta {
                v: 3,
                complete: true,
                last_turn_id: 1,
                ..DisplayMeta::default()
            },
        )
        .unwrap();
        let mut legacy = record(1, 0, "legacy Q");
        legacy.v = 3;
        let mut line = serde_json::to_vec(&legacy).unwrap();
        line.push(b'\n');
        mgr.append_jsonl_line_at(
            "s1",
            &mgr.display_path("s1").unwrap(),
            "display transcript",
            &line,
        )
        .unwrap();
        let (meta, rows) = mgr.read_display("s1").unwrap().unwrap();
        assert_eq!(
            meta.v, 3,
            "the normal read path filters v3; migration can read it"
        );
        assert_eq!(rows.len(), 1);

        mgr.write_display_backfill("s1", &rows, 1).unwrap();
        let (meta, rows) = mgr.read_display("s1").unwrap().unwrap();
        assert_eq!(meta.v, DISPLAY_VERSION);
        assert_eq!(meta.last_seq, 1);
        assert_eq!(rows[0].seq, 1);
    }

    #[test]
    fn display_index_offsets_match_the_log_and_rebuild_after_append() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::with_root(dir.path());
        mgr.write_display_backfill(
            "s1",
            &[record(1, 0, "Q1"), record(1, 1, "A1"), record(2, 0, "Q2")],
            2,
        )
        .unwrap();
        let (meta, index) = mgr.ensure_display_index("s1").unwrap().unwrap();
        assert_eq!(meta.last_seq, 3);
        assert_eq!(index.len(), 3);
        assert_eq!(index.last().unwrap().seq, 3);
        let bytes = std::fs::read(mgr.display_path("s1").unwrap()).unwrap();
        for row in &index {
            let start = row.offset as usize;
            let end = bytes[start..]
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|len| start + len)
                .unwrap();
            let parsed: DisplayRecord = serde_json::from_slice(&bytes[start..end]).unwrap();
            assert_eq!(parsed.seq, row.seq);
            assert_eq!(parsed.role, row.role);
        }

        mgr.append_display_turn("s1", 3, &[record(3, 0, "Q3")])
            .unwrap();
        assert!(
            mgr.read_display_index("s1").unwrap().is_none(),
            "append invalidates the stale index"
        );
        let (_, rebuilt) = mgr.ensure_display_index("s1").unwrap().unwrap();
        assert_eq!(rebuilt.len(), 4);
        assert_eq!(rebuilt.last().unwrap().seq, 4);
    }

    #[test]
    fn v4_seq_meta_mismatch_is_rejected_for_rebuild() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::with_root(dir.path());
        mgr.write_display_backfill("s1", &[record(1, 0, "Q")], 1)
            .unwrap();
        let (mut meta, _) = mgr.read_display("s1").unwrap().unwrap();
        meta.last_seq = 0;
        mgr.write_display_meta("s1", &meta).unwrap();
        assert!(
            mgr.read_display("s1").unwrap().is_none(),
            "a torn append/meta pair must fall back to the canonical rebuild"
        );
    }

    #[test]
    fn incompatible_display_schema_falls_back_for_backfill() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::with_root(dir.path());
        mgr.write_display_meta(
            "s1",
            &DisplayMeta {
                v: DISPLAY_VERSION + 1,
                complete: true,
                ..DisplayMeta::default()
            },
        )
        .unwrap();
        assert!(mgr.read_display("s1").unwrap().is_none());
        // A terminal must not append into an incompatible log either.
        mgr.append_display_turn("s1", 1, &[record(1, 0, "Q1")])
            .unwrap();
        assert!(mgr.read_display("s1").unwrap().is_none());
    }

    #[test]
    fn invalidate_display_forces_the_fallback_path() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::with_root(dir.path());
        mgr.append_display_turn("s1", 1, &[record(1, 0, "Q1")])
            .unwrap();
        assert!(mgr.read_display("s1").unwrap().is_some());
        mgr.invalidate_display("s1").unwrap();
        assert!(mgr.read_display("s1").unwrap().is_none());
    }
}
