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
use jeikcode_kernel::event::{NoticeKind, NoticeSeverity, NoticeStatus, StopReason, SystemNotice};
use jeikcode_kernel::hook::{LifecycleHooks, TurnCtx};
use jeikcode_kernel::message::{CompactReport, CompactTrigger, Conversation, Message, Role};
use serde::{Deserialize, Serialize};

use super::manager::SessionManager;
use super::{SessionResult, SessionStoreError};

pub const DISPLAY_VERSION: u32 = 5;
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
    /// v5 系统通知字段：同 `event_id` 对应同一故障/边界，跨轮次按 `anchor_message_id` 就位。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub part_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_part_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice_kind: Option<NoticeKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<NoticeSeverity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<NoticeStatus>,
}

impl Default for DisplayRecord {
    fn default() -> Self {
        Self {
            v: DISPLAY_VERSION,
            session_id: String::new(),
            turn_id: 0,
            index: 0,
            seq: 0,
            role: String::new(),
            id: None,
            content: String::new(),
            reasoning: None,
            synthetic: false,
            internal_origin: None,
            tool_calls: Vec::new(),
            tool_call_id: None,
            is_error: false,
            images: Vec::new(),
            created_at: None,
            elapsed_ms: None,
            event_id: None,
            part_id: None,
            anchor_message_id: None,
            anchor_part_id: None,
            notice_kind: None,
            revision: None,
            severity: None,
            status: None,
        }
    }
}

fn display_version() -> u32 {
    DISPLAY_VERSION
}

impl DisplayRecord {
    pub fn from_system_notice(session_id: &str, turn_id: u64, notice: &SystemNotice) -> Self {
        Self {
            v: DISPLAY_VERSION,
            session_id: session_id.to_string(),
            turn_id,
            index: 0,
            seq: 0,
            role: "assistant".to_string(),
            id: Some(notice.event_id.clone()),
            content: notice.text.clone(),
            internal_origin: Some("turn_diagnostic".to_string()),
            created_at: Some(u64::try_from(super::now_ms()).unwrap_or(0)),
            event_id: Some(notice.event_id.clone()),
            part_id: Some(notice.part_id.clone()),
            anchor_message_id: notice.anchor_message_id.clone(),
            anchor_part_id: notice.anchor_part_id.clone(),
            notice_kind: Some(notice.kind),
            revision: Some(notice.revision),
            severity: Some(notice.severity),
            status: Some(notice.status),
            ..Self::default()
        }
    }

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
            event_id: message
                .notice
                .as_ref()
                .and_then(|notice| notice.event_id.clone()),
            part_id: message
                .notice
                .as_ref()
                .and_then(|notice| notice.part_id.clone()),
            anchor_message_id: message
                .notice
                .as_ref()
                .and_then(|notice| notice.anchor_message_id.clone()),
            anchor_part_id: message
                .notice
                .as_ref()
                .and_then(|notice| notice.anchor_part_id.clone()),
            notice_kind: message.notice.as_ref().map(|notice| notice.kind),
            revision: message.notice.as_ref().and_then(|notice| notice.revision),
            severity: message.notice.as_ref().map(|notice| notice.severity),
            status: message.notice.as_ref().map(|notice| notice.status),
            ..Self::default()
        }
    }
}

/// Cap on the exact turn/prompt id sets. A session with more turns is far beyond
/// any realistic UI; the high-water mark still orders new appends.
const MAX_COMPLETED_TURNS: usize = 8192;
const MAX_FLUSHED_RECORD_IDS: usize = 65_536;
/// 与 `MAX_FLUSHED_RECORD_IDS`、`MAX_COMPLETED_TURNS` 的理论体积上限对齐，避免长会话在元数据落盘时触发 64 KiB 截断导致账本与 meta 撕裂。
const MAX_DISPLAY_META_BYTES: usize = 16 * 1024 * 1024;

/// 预校验并序列化 `.display.meta.json`，确保在追加 `.display.jsonl` 之前就能发现体积超限。
fn serialize_display_meta(meta: &DisplayMeta) -> SessionResult<Vec<u8>> {
    let bytes = serde_json::to_vec_pretty(meta).map_err(|error| SessionStoreError::Corrupt {
        kind: "display meta",
        message: error.to_string(),
    })?;
    super::manager::ensure_size("display meta", bytes.len(), MAX_DISPLAY_META_BYTES)?;
    Ok(bytes)
}

fn read_display_meta_file(path: &std::path::Path) -> SessionResult<Option<DisplayMeta>> {
    crate::session::manager::read_json_optional_bounded::<DisplayMeta>(
        path,
        "display meta",
        MAX_DISPLAY_META_BYTES,
    )
}

/// 将新落盘记录中的 `id` 与用户侧 `admitted_prompt_ids` 同步更新到元数据。
fn record_flushed_rows_in_meta<'a>(
    meta: &mut DisplayMeta,
    records: impl IntoIterator<Item = &'a DisplayRecord>,
    record_admitted_prompts: bool,
) {
    for record in records {
        if let Some(rec_id) = record.id.as_deref() {
            SessionManager::push_bounded_ids(
                &mut meta.flushed_record_ids,
                rec_id,
                MAX_FLUSHED_RECORD_IDS,
            );
        }
        if record_admitted_prompts && record.role.eq_ignore_ascii_case("user") {
            if let Some(rec_id) = record.id.as_deref() {
                SessionManager::push_bounded_ids(
                    &mut meta.admitted_prompt_ids,
                    rec_id,
                    MAX_COMPLETED_TURNS,
                );
            }
        }
    }
}

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

fn display_record_ids_for_meta(records: &[DisplayRecord]) -> Vec<String> {
    let mut ids = Vec::new();
    for record in records {
        if let Some(key) = record
            .event_id
            .as_deref()
            .or(record.id.as_deref())
            .filter(|id| !id.is_empty())
        {
            if !ids.iter().any(|known| known == key) {
                ids.push(key.to_string());
            }
        }
    }
    if ids.len() > MAX_FLUSHED_RECORD_IDS {
        let drop = ids.len() - MAX_FLUSHED_RECORD_IDS;
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
    /// 回合内检查点已经增量写盘的记录身份集合，与 `completed_prompt_ids` 严格隔离。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub flushed_record_ids: Vec<String>,
    /// 增量检查点 `(turn_id, slice)` 幂等键集合。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub flushed_slice_keys: Vec<String>,
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
            flushed_record_ids: Vec::new(),
            flushed_slice_keys: Vec::new(),
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

#[derive(Clone, Debug)]
struct BufferedNotice {
    notice: SystemNotice,
    dirty: bool,
}

#[derive(Default)]
struct TurnDisplayState {
    anchor: Option<TurnAnchor>,
    notices: Vec<BufferedNotice>,
    next_slice_seq: u32,
    /// 本轮提问或前置切片是否已经安全写入显示账本（如 pre_compaction 或检查点）。
    /// 一旦置 true，即使后续压缩裁剪了 convo 里的 u-1 锚点，终态仍可续写新增回复。
    prompt_flushed_to_ledger: bool,
}

pub struct DisplayHook {
    mgr: std::sync::Arc<SessionManager>,
    session_id: String,
    working_dir: std::path::PathBuf,
    state: Mutex<TurnDisplayState>,
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
            state: Mutex::new(TurnDisplayState::default()),
        }
    }

    fn build_slice_records(
        &self,
        convo: &Conversation,
        turn_id: u64,
        anchor: Option<&TurnAnchor>,
        skip_turn_diagnostics: bool,
        prompt_flushed_to_ledger: bool,
    ) -> Option<Vec<DisplayRecord>> {
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
        let start = if let Some(pos) = anchored {
            pos
        } else if prompt_flushed_to_ledger {
            // 如果前置切片已落盘且压缩裁掉了原始 u-1 锚点，从剩余消息起续写新增回复；
            // 已落盘的旧消息会由 append_display_slice / append_display_turn 按 id 去重跳过。
            0
        } else {
            anchor
                .map(|anchor| anchor.start_index.min(convo.messages.len()))
                .unwrap_or(convo.messages.len())
        };
        if start >= convo.messages.len() || turn_id == 0 {
            return None;
        }
        if anchored.is_none()
            && !prompt_flushed_to_ledger
            && convo.messages[start].role != Role::User
        {
            // Never write a slice that starts mid-assistant/tool without an already
            // flushed prompt: the caller falls back to `write_cancelled_user`.
            return None;
        }
        let records: Vec<DisplayRecord> = convo.messages[start..]
            .iter()
            .filter(|message| {
                !(skip_turn_diagnostics && message.is_display_only())
                    && !(prompt_flushed_to_ledger && message.synthetic)
            })
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
        Some(records)
    }

    /// Append the conversation slice for one settled turn. Returns `false` when
    /// there is no valid prompt-anchored slice (rolled back / empty / turn_id 0).
    fn write_slice(
        &self,
        convo: &Conversation,
        turn_id: u64,
        anchor: Option<&TurnAnchor>,
        skip_turn_diagnostics: bool,
        prompt_flushed_to_ledger: bool,
    ) -> bool {
        let Some(records) = self.build_slice_records(
            convo,
            turn_id,
            anchor,
            skip_turn_diagnostics,
            prompt_flushed_to_ledger,
        ) else {
            return false;
        };
        if let Err(error) = self.mgr.append_display_turn_with_prompt_id(
            &self.session_id,
            turn_id,
            &records,
            anchor.and_then(|a| a.id.as_deref()),
        ) {
            eprintln!("[DisplayHook] append display transcript failed: {error}");
            return false;
        }
        true
    }

    fn flush_checkpoint_records(&self, convo: &Conversation, turn_id: u64, slice_key: &str) {
        if turn_id == 0 {
            return;
        }
        let (anchor, skip_diagnostics, prompt_flushed) = {
            let guard = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            (
                guard.anchor.clone(),
                !guard.notices.is_empty(),
                guard.prompt_flushed_to_ledger,
            )
        };
        if let Some(records) = self.build_slice_records(
            convo,
            turn_id,
            anchor.as_ref(),
            skip_diagnostics,
            prompt_flushed,
        ) {
            match self
                .mgr
                .append_display_slice(&self.session_id, turn_id, slice_key, &records)
            {
                Ok(true) => {
                    let mut guard = self
                        .state
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    guard.prompt_flushed_to_ledger = true;
                }
                Ok(false) => {}
                Err(error) => {
                    eprintln!("[DisplayHook] checkpoint flush slice failed: {error}");
                }
            }
        }
    }

    fn flush_dirty_notices(&self, turn_id: u64, promote_active_to_settled: bool) {
        let pending: Vec<SystemNotice> = {
            let guard = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard
                .notices
                .iter()
                .filter(|item| {
                    item.notice.persist
                        && (item.dirty
                            || (promote_active_to_settled
                                && item.notice.status == NoticeStatus::Active))
                })
                .map(|item| {
                    let mut n = item.notice.clone();
                    if promote_active_to_settled && n.status == NoticeStatus::Active {
                        n.status = NoticeStatus::Settled;
                    }
                    n
                })
                .collect()
        };
        if pending.is_empty() {
            return;
        }
        let mut flushed_pairs = Vec::with_capacity(pending.len());
        for notice in pending {
            let record = DisplayRecord::from_system_notice(&self.session_id, turn_id, &notice);
            if let Err(error) = self
                .mgr
                .upsert_display_notice_record(&self.session_id, record)
            {
                tracing::warn!(
                    target: "jeikcode_capabilities::session::display",
                    session_id = %self.session_id,
                    turn_id,
                    error = %error,
                    "flush dirty display notice failed"
                );
                eprintln!("[DisplayHook] upsert display notice failed: {error}");
            } else {
                flushed_pairs.push((notice.event_id, notice.revision, notice.status));
            }
        }
        let mut guard = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for (event_id, revision, status) in flushed_pairs {
            if let Some(entry) = guard
                .notices
                .iter_mut()
                .find(|item| item.notice.event_id == event_id)
            {
                if entry.notice.revision == revision {
                    entry.notice.status = status;
                    entry.dirty = false;
                }
            }
        }
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
                internal_origin: Some("transcript_archive".into()),
                created_at: Some(u64::try_from(super::now_ms()).unwrap_or(0)),
                ..DisplayRecord::default()
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
        let anchor = message.map(|message| TurnAnchor {
            id: message.id.clone(),
            text: message.text.clone(),
            synthetic: message.synthetic,
            start_index: convo.messages.len(),
        });
        *self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = TurnDisplayState {
            anchor,
            notices: Vec::new(),
            next_slice_seq: 0,
            prompt_flushed_to_ledger: false,
        };
    }

    async fn on_turn_checkpoint(&self, convo: &Conversation, ctx: &TurnCtx) {
        let slice_key = {
            let mut guard = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.next_slice_seq = guard.next_slice_seq.saturating_add(1);
            format!("t{}:c{}", ctx.turn_id, guard.next_slice_seq)
        };
        self.flush_checkpoint_records(convo, ctx.turn_id, &slice_key);
        self.flush_dirty_notices(ctx.turn_id, false);
    }

    async fn on_system_notice(&self, notice: &SystemNotice, convo: &Conversation, ctx: &TurnCtx) {
        let (should_flush_slice, flush_notice_key) = {
            let mut guard = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut accepted = true;
            if let Some(existing) = guard
                .notices
                .iter_mut()
                .find(|item| item.notice.event_id == notice.event_id)
            {
                if (existing.notice.status == NoticeStatus::Settled
                    && notice.status != NoticeStatus::Settled)
                    || notice.revision < existing.notice.revision
                {
                    accepted = false;
                } else {
                    existing.notice = notice.clone();
                    existing.dirty = true;
                }
            } else {
                guard.notices.push(BufferedNotice {
                    notice: notice.clone(),
                    dirty: true,
                });
            }
            if !accepted || !notice.persist {
                (false, None)
            } else if notice.revision == 1 || notice.status == NoticeStatus::Settled {
                guard.next_slice_seq = guard.next_slice_seq.saturating_add(1);
                (
                    true,
                    Some(format!("t{}:n{}", ctx.turn_id, guard.next_slice_seq)),
                )
            } else {
                (false, None)
            }
        };
        if should_flush_slice {
            if let Some(slice_key) = flush_notice_key {
                self.flush_checkpoint_records(convo, ctx.turn_id, &slice_key);
            }
            self.flush_dirty_notices(ctx.turn_id, false);
        }
    }

    async fn pre_compaction(
        &self,
        convo: &Conversation,
        _trigger: &CompactTrigger,
        ctx: Option<&TurnCtx>,
    ) {
        let Some(turn_id) = ctx.map(|c| c.turn_id).filter(|&id| id > 0) else {
            return;
        };
        let slice_key = {
            let mut guard = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.next_slice_seq = guard.next_slice_seq.saturating_add(1);
            format!("t{}:precompact:{}", turn_id, guard.next_slice_seq)
        };
        self.flush_checkpoint_records(convo, turn_id, &slice_key);
        self.flush_dirty_notices(turn_id, false);
    }

    async fn post_compaction(
        &self,
        _report: &CompactReport,
        notice: &SystemNotice,
        ctx: Option<&TurnCtx>,
    ) {
        let turn_id = ctx.map(|c| c.turn_id).unwrap_or(0);
        let record = DisplayRecord::from_system_notice(&self.session_id, turn_id, notice);
        if let Err(error) = self
            .mgr
            .upsert_display_notice_record(&self.session_id, record)
        {
            tracing::warn!(
                target: "jeikcode_capabilities::session::display",
                session_id = %self.session_id,
                turn_id,
                error = %error,
                "post_compaction display notice failed"
            );
            eprintln!("[DisplayHook] post_compaction notice failed: {error}");
        }
    }

    async fn turn_complete(&self, convo: &Conversation, reason: &StopReason, ctx: &TurnCtx) {
        // A rejected prompt never became a turn: nothing to show.
        if matches!(reason, StopReason::PromptRejected) {
            let _ = std::mem::take(
                &mut *self
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()),
            );
            return;
        }
        let state = std::mem::take(
            &mut *self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
        let skip_diagnostics = !state.notices.is_empty();
        if matches!(reason, StopReason::Cancelled) {
            // PRESERVE mode keeps the partial conversation → write it normally.
            // Default CANCEL = UNDO rolled it back → persist the question alone so
            // refresh / another browser still sees what was asked.
            if !self.write_slice(
                convo,
                ctx.turn_id,
                state.anchor.as_ref(),
                skip_diagnostics,
                state.prompt_flushed_to_ledger,
            ) {
                self.write_cancelled_user(convo, ctx.turn_id, state.anchor.as_ref());
            }
        } else {
            self.write_slice(
                convo,
                ctx.turn_id,
                state.anchor.as_ref(),
                skip_diagnostics,
                state.prompt_flushed_to_ledger,
            );
        }
        // 收口并刷入本轮全部未落盘/仍处于活跃态的通知，保证终态之后不留 active 卡。
        for item in state.notices {
            if !item.notice.persist {
                continue;
            }
            let mut notice = item.notice;
            let need_write = item.dirty || notice.status == NoticeStatus::Active;
            if !need_write {
                continue;
            }
            if notice.status == NoticeStatus::Active {
                notice.status = NoticeStatus::Settled;
                notice.revision = notice.revision.saturating_add(1);
            }
            let record = DisplayRecord::from_system_notice(&self.session_id, ctx.turn_id, &notice);
            if let Err(error) = self
                .mgr
                .upsert_display_notice_record(&self.session_id, record)
            {
                tracing::warn!(
                    target: "jeikcode_capabilities::session::display",
                    session_id = %self.session_id,
                    turn_id = ctx.turn_id,
                    error = %error,
                    "final flush display notice failed"
                );
                eprintln!("[DisplayHook] final flush notice failed: {error}");
            }
        }
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
        let Some(meta) = read_display_meta_file(&self.display_meta_path(id)?)? else {
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

    /// Return the meta + a complete offset index, lazily upgrading v4 if needed and
    /// rebuilding the index once from the log when absent/stale.
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
        let _ = self.with_display_lock(id, || self.ensure_v5_display_unlocked(id));
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
        self.append_display_turn_with_prompt_id(id, turn_id, records, None)
    }

    pub(crate) fn append_display_turn_with_prompt_id(
        &self,
        id: &str,
        turn_id: u64,
        records: &[DisplayRecord],
        prompt_id_override: Option<&str>,
    ) -> SessionResult<()> {
        self.with_display_lock(id, || {
            self.append_display_turn_unlocked(id, turn_id, records, prompt_id_override)
        })
    }

    fn push_bounded_ids(target: &mut Vec<String>, id: &str, cap: usize) {
        if id.is_empty() || target.iter().any(|known| known == id) {
            return;
        }
        target.push(id.to_string());
        if target.len() > cap {
            let drop = target.len() - cap;
            target.drain(..drop);
        }
    }

    /// 懒升级：将完整落盘的 v4 日志原地归一化升级为 v5（不丢失历史消息与图片），
    /// 并把未带锚点的旧通知挂到所属 turn 末尾。
    fn ensure_v5_display_unlocked(&self, id: &str) -> SessionResult<()> {
        let meta_path = self.display_meta_path(id)?;
        let Some(meta) = read_display_meta_file(&meta_path)? else {
            return Ok(());
        };
        if meta.v != 4 || !meta.complete {
            return Ok(());
        }
        let Some((_, records)) = self.read_display(id)? else {
            return Ok(());
        };
        self.rewrite_display_rows_with_slices_unlocked(
            id,
            &records,
            meta.last_turn_id,
            &meta.completed_turns,
            meta.backfilled,
            &meta.flushed_slice_keys,
        )
    }

    /// 回合内 `(turn_id, slice_key)` 增量落盘：与终态 `completed_prompt_ids` 严格分离，
    /// 保证每轮/工具批检查点及压缩前能提前落盘，同时绝不会屏蔽后续轮次或 `turn_complete`。
    pub fn append_display_slice(
        &self,
        id: &str,
        turn_id: u64,
        slice_key: &str,
        records: &[DisplayRecord],
    ) -> SessionResult<bool> {
        if records.is_empty() || turn_id == 0 || slice_key.trim().is_empty() {
            return Ok(false);
        }
        self.with_display_lock(id, || {
            self.ensure_v5_display_unlocked(id)?;
            let meta_path = self.display_meta_path(id)?;
            let mut meta = match read_display_meta_file(&meta_path)? {
                Some(meta) => meta,
                None => {
                    if turn_id != 1 {
                        return Ok(false);
                    }
                    DisplayMeta {
                        complete: true,
                        ..DisplayMeta::default()
                    }
                }
            };
            if meta.v != DISPLAY_VERSION || !meta.complete {
                return Ok(false);
            }
            if meta.flushed_slice_keys.iter().any(|k| k == slice_key) {
                return Ok(true);
            }
            let prompt_id = display_turn_prompt_id(records);
            if prompt_id
                .as_deref()
                .is_some_and(|pid| meta.completed_prompt_ids.iter().any(|known| known == pid))
            {
                return Ok(true);
            }
            let append_records: Vec<&DisplayRecord> = records
                .iter()
                .filter(|record| {
                    record.id.as_deref().map_or(true, |rec_id| {
                        !meta.admitted_prompt_ids.iter().any(|known| known == rec_id)
                            && !meta
                                .completed_prompt_ids
                                .iter()
                                .any(|known| known == rec_id)
                            && !meta.flushed_record_ids.iter().any(|known| known == rec_id)
                    })
                })
                .collect();
            let mut next_seq = meta.last_seq;
            let mut log_bytes = Vec::new();
            if !append_records.is_empty() {
                log_bytes.reserve(append_records.len() * 512);
                for record in &append_records {
                    next_seq = next_seq.saturating_add(1);
                    let mut rec = (*record).clone();
                    rec.v = DISPLAY_VERSION;
                    rec.seq = next_seq;
                    serde_json::to_writer(&mut log_bytes, &rec).map_err(|error| {
                        SessionStoreError::Corrupt {
                            kind: "display record",
                            message: error.to_string(),
                        }
                    })?;
                    log_bytes.push(b'\n');
                }
                record_flushed_rows_in_meta(&mut meta, append_records.iter().copied(), true);
            }
            Self::push_bounded_ids(&mut meta.flushed_slice_keys, slice_key, MAX_COMPLETED_TURNS);
            meta.last_turn_id = meta.last_turn_id.max(turn_id);
            meta.last_seq = next_seq;
            meta.updated_at = u64::try_from(super::now_ms()).unwrap_or(0);
            // 先校验并序列化 metadata，防止追加日志后再因 meta 超限失败造成 last_seq 撕裂。
            let meta_bytes = serialize_display_meta(&meta)?;
            if !log_bytes.is_empty() {
                let path = self.display_path(id)?;
                self.append_jsonl_line_at(id, &path, "display transcript", &log_bytes)?;
            }
            self.write_display_meta_bytes(id, &meta_bytes)?;
            if let Ok(path) = self.display_index_path(id) {
                let _ = std::fs::remove_file(path);
            }
            Ok(true)
        })
    }

    fn append_display_turn_unlocked(
        &self,
        id: &str,
        turn_id: u64,
        records: &[DisplayRecord],
        prompt_id_override: Option<&str>,
    ) -> SessionResult<()> {
        if records.is_empty() {
            return Ok(());
        }
        self.ensure_v5_display_unlocked(id)?;
        let meta_path = self.display_meta_path(id)?;
        let mut meta = match read_display_meta_file(&meta_path)? {
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
        let prompt_id = display_turn_prompt_id(records).or_else(|| {
            prompt_id_override
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        });
        let prompt_completed = prompt_id.as_deref().is_some_and(|prompt_id| {
            meta.completed_prompt_ids
                .iter()
                .any(|known| known == prompt_id)
        });
        // `completed_prompt_ids` is the SETTLED-turn idempotency key. Admission
        // and incremental checkpoints write to `admitted_prompt_ids` /
        // `flushed_record_ids`, never marking the turn complete early.
        if prompt_completed {
            return Ok(());
        }
        if meta.completed_prompt_ids.is_empty()
            && meta.admitted_prompt_ids.is_empty()
            && meta.flushed_record_ids.is_empty()
        {
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
                // 跳过入口预写和回合内检查点已经落盘的记录，避免终态重复写。
                record.id.as_deref().map_or(true, |rec_id| {
                    !meta.admitted_prompt_ids.iter().any(|known| known == rec_id)
                        && !meta
                            .completed_prompt_ids
                            .iter()
                            .any(|known| known == rec_id)
                        && !meta.flushed_record_ids.iter().any(|known| known == rec_id)
                })
            })
            .collect();
        let mut next_seq = meta.last_seq;
        let mut log_bytes = Vec::new();
        if !append_records.is_empty() {
            log_bytes.reserve(append_records.len() * 512);
            for record in &append_records {
                next_seq = next_seq.saturating_add(1);
                let mut record = (*record).clone();
                record.v = DISPLAY_VERSION;
                record.seq = next_seq;
                serde_json::to_writer(&mut log_bytes, &record).map_err(|error| {
                    SessionStoreError::Corrupt {
                        kind: "display record",
                        message: error.to_string(),
                    }
                })?;
                log_bytes.push(b'\n');
            }
            record_flushed_rows_in_meta(&mut meta, append_records.iter().copied(), false);
        }
        meta.last_turn_id = meta.last_turn_id.max(turn_id);
        meta.last_seq = next_seq;
        if !meta.completed_turns.contains(&turn_id) {
            meta.completed_turns.push(turn_id);
        }
        // 回合终态收口后，清理该 turn 的瞬态切片去重键，避免长会话元数据持续膨胀。
        let settled_slice_prefix = format!("t{turn_id}:");
        meta.flushed_slice_keys
            .retain(|key| !key.starts_with(&settled_slice_prefix));
        for record in records {
            if !record.role.eq_ignore_ascii_case("user") {
                continue;
            }
            let Some(id) = record.id.as_deref() else {
                continue;
            };
            Self::push_bounded_ids(&mut meta.admitted_prompt_ids, id, MAX_COMPLETED_TURNS);
        }
        if let Some(prompt_id) = prompt_id {
            Self::push_bounded_ids(
                &mut meta.completed_prompt_ids,
                &prompt_id,
                MAX_COMPLETED_TURNS,
            );
        }
        // Keep the exact sets bounded. A session with >8192 turns is far beyond
        // any realistic UI; the high-water mark still orders new appends.
        if meta.completed_turns.len() > MAX_COMPLETED_TURNS {
            let drop = meta.completed_turns.len() - MAX_COMPLETED_TURNS;
            meta.completed_turns.drain(..drop);
        }
        meta.updated_at = u64::try_from(super::now_ms()).unwrap_or(0);
        let meta_bytes = serialize_display_meta(&meta)?;
        if !log_bytes.is_empty() {
            let path = self.display_path(id)?;
            self.append_jsonl_line_at(id, &path, "display transcript", &log_bytes)?;
        }
        self.write_display_meta_bytes(id, &meta_bytes)?;
        // The append changed last_seq; the old index is stale. The next tail read
        // rebuilds it once from the (now complete) log.
        if !append_records.is_empty() {
            if let Ok(path) = self.display_index_path(id) {
                let _ = std::fs::remove_file(path);
            }
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
            self.ensure_v5_display_unlocked(id)?;
            let meta_path = self.display_meta_path(id)?;
            let mut meta = match read_display_meta_file(&meta_path)? {
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
                images: images.to_vec(),
                created_at,
                ..DisplayRecord::default()
            };
            let mut bytes = Vec::with_capacity(512);
            serde_json::to_writer(&mut bytes, &record).map_err(|error| {
                SessionStoreError::Corrupt {
                    kind: "display user record",
                    message: error.to_string(),
                }
            })?;
            bytes.push(b'\n');
            meta.last_turn_id = next_turn_id;
            meta.last_seq = next_seq;
            Self::push_bounded_ids(
                &mut meta.admitted_prompt_ids,
                prompt_id,
                MAX_COMPLETED_TURNS,
            );
            Self::push_bounded_ids(
                &mut meta.flushed_record_ids,
                prompt_id,
                MAX_FLUSHED_RECORD_IDS,
            );
            meta.updated_at = u64::try_from(super::now_ms()).unwrap_or(0);
            let meta_bytes = serialize_display_meta(&meta)?;
            let path = self.display_path(id)?;
            self.append_jsonl_line_at(id, &path, "display transcript", &bytes)?;
            self.write_display_meta_bytes(id, &meta_bytes)?;
            if let Ok(idx_path) = self.display_index_path(id) {
                let _ = std::fs::remove_file(idx_path);
            }
            Ok(Some(record))
        })
    }

    fn read_last_non_diagnostic_anchor_id(&self, id: &str) -> Option<String> {
        use std::io::{Read, Seek, SeekFrom};
        let path = self.display_path(id).ok()?;
        let mut file = std::fs::File::open(&path).ok()?;
        let len = file.metadata().ok()?.len();
        let start = len.saturating_sub(64 * 1024);
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).ok()?;
        let decoded = String::from_utf8_lossy(&buf);
        let mut lines: Vec<&str> = decoded.lines().collect();
        if start > 0 && !lines.is_empty() {
            lines.remove(0);
        }
        for line in lines.iter().rev() {
            let Ok(record) = serde_json::from_str::<DisplayRecord>(line) else {
                continue;
            };
            if record.synthetic
                || record.internal_origin.as_deref() == Some("turn_diagnostic")
                || record.internal_origin.as_deref() == Some("verify_cadence")
            {
                continue;
            }
            if record.role.eq_ignore_ascii_case("user")
                || record.role.eq_ignore_ascii_case("assistant")
            {
                return record.id;
            }
        }
        None
    }

    fn notice_insertion_index(records: &[DisplayRecord], notice: &DisplayRecord) -> usize {
        if let Some(anchor_id) = notice.anchor_message_id.as_deref() {
            if let Some(anchor_pos) = records
                .iter()
                .rposition(|record| record.id.as_deref() == Some(anchor_id))
            {
                let mut idx = anchor_pos + 1;
                while idx < records.len() {
                    let row = &records[idx];
                    if row.role.eq_ignore_ascii_case("tool") {
                        idx += 1;
                        continue;
                    }
                    if row.internal_origin.as_deref() == Some("turn_diagnostic")
                        && row.anchor_message_id.as_deref() == Some(anchor_id)
                    {
                        idx += 1;
                        continue;
                    }
                    break;
                }
                return idx;
            }
        }
        records.len()
    }

    /// 唯一账本写入/原地更新入口（v5）：同 `event_id` 按 `revision` 幂等覆盖并遵守
    /// `settled` 不降级约束；新事件若因果锚点在日志末尾则 O(1) 追加，否则按锚点插槽落位。
    pub fn upsert_display_notice_record(
        &self,
        id: &str,
        mut notice: DisplayRecord,
    ) -> SessionResult<Option<DisplayRecord>> {
        let trimmed = notice.content.trim().to_string();
        if trimmed.is_empty() {
            return Ok(None);
        }
        notice.content = trimmed;
        notice.v = DISPLAY_VERSION;
        notice.role = "assistant".to_string();
        notice.internal_origin = Some("turn_diagnostic".to_string());

        self.with_display_lock(id, || {
            self.ensure_v5_display_unlocked(id)?;
            let meta_path = self.display_meta_path(id)?;
            let mut meta = match read_display_meta_file(&meta_path)? {
                Some(meta) => meta,
                // 若 `.display.meta.json` 尚未建立（即便 turn_id > 1），按完备初始元数据落盘，
                // 避免首张通知被静默丢弃并退化为仅靠快照兜底。
                None => DisplayMeta {
                    complete: true,
                    ..DisplayMeta::default()
                },
            };
            if meta.v != DISPLAY_VERSION || !meta.complete {
                tracing::warn!(
                    target: "jeikcode_capabilities::session::display",
                    session_id = id,
                    turn_id = notice.turn_id,
                    meta_version = meta.v,
                    complete = meta.complete,
                    event_id = notice.event_id.as_deref().unwrap_or(""),
                    "skipping display notice upsert because display meta is incomplete or mismatched"
                );
                return Ok(None);
            }
            if notice.turn_id == 0 {
                notice.turn_id = meta.last_turn_id;
            }
            let event_key = notice
                .event_id
                .clone()
                .or_else(|| notice.id.clone())
                .unwrap_or_else(|| format!("notice-{}", uuid::Uuid::new_v4()));
            notice.id = Some(event_key.clone());
            notice.event_id = Some(event_key.clone());
            if notice.part_id.is_none() {
                notice.part_id = Some(format!("{event_key}:1:notice"));
            }
            if notice.created_at.is_none() {
                notice.created_at = Some(u64::try_from(super::now_ms()).unwrap_or(0));
            }
            if notice.status.is_none() {
                notice.status = Some(NoticeStatus::Settled);
            }
            if notice.revision.is_none() {
                notice.revision = Some(1);
            }

            let maybe_existing = meta.flushed_record_ids.iter().any(|k| k == &event_key);
            if maybe_existing {
                if let Some((_read_meta, mut records)) = self.read_display(id)? {
                    if let Some(pos) = records.iter().rposition(|row| {
                        row.event_id.as_deref() == Some(&event_key)
                            || row.id.as_deref() == Some(&event_key)
                    }) {
                        let existing = &records[pos];
                        let existing_settled = existing.status == Some(NoticeStatus::Settled);
                        let incoming_settled = notice.status == Some(NoticeStatus::Settled);
                        if (existing_settled && !incoming_settled)
                            || (existing.revision.unwrap_or(0) > notice.revision.unwrap_or(0))
                        {
                            return Ok(Some(existing.clone()));
                        }
                        if existing.content == notice.content
                            && existing.status == notice.status
                            && existing.severity == notice.severity
                            && existing.notice_kind == notice.notice_kind
                        {
                            return Ok(Some(existing.clone()));
                        }
                        let mut updated = notice.clone();
                        updated.seq = existing.seq;
                        updated.created_at = existing.created_at.or(notice.created_at);
                        if updated.anchor_message_id.is_none() {
                            updated.anchor_message_id = existing.anchor_message_id.clone();
                        }
                        if updated.anchor_part_id.is_none() {
                            updated.anchor_part_id = existing.anchor_part_id.clone();
                        }
                        records[pos] = updated;
                        self.rewrite_display_rows_with_slices_unlocked(
                            id,
                            &records,
                            meta.last_turn_id,
                            &meta.completed_turns,
                            meta.backfilled,
                            &meta.flushed_slice_keys,
                        )?;
                        let result = self
                            .read_display(id)?
                            .and_then(|(_, rows)| rows.get(pos).cloned())
                            .unwrap_or(records[pos].clone());
                        return Ok(Some(result));
                    }
                }
            }

            let can_fast_append = notice.anchor_message_id.as_deref().is_none_or(|anchor| {
                self.read_last_non_diagnostic_anchor_id(id).as_deref() == Some(anchor)
            });
            if !can_fast_append {
                if let Some((_, mut records)) = self.read_display(id)? {
                    // 按 anchor_message_id 找到因果插槽，保持历史顺序与直播一致。
                    if let Some(pos) = records.iter().rposition(|row| {
                        row.event_id.as_deref() == Some(&event_key)
                            || row.id.as_deref() == Some(&event_key)
                    }) {
                        return Ok(Some(records[pos].clone()));
                    }
                    let insert_at = Self::notice_insertion_index(&records, &notice);
                    records.insert(insert_at, notice);
                    self.rewrite_display_rows_with_slices_unlocked(
                        id,
                        &records,
                        meta.last_turn_id,
                        &meta.completed_turns,
                        meta.backfilled,
                        &meta.flushed_slice_keys,
                    )?;
                    let inserted = self
                        .read_display(id)?
                        .and_then(|(_, rows)| rows.get(insert_at).cloned())
                        .unwrap_or_else(|| records[insert_at].clone());
                    return Ok(Some(inserted));
                }
            }

            let next_seq = meta.last_seq.saturating_add(1);
            notice.seq = next_seq;
            let mut bytes = Vec::with_capacity(256);
            serde_json::to_writer(&mut bytes, &notice).map_err(|error| {
                SessionStoreError::Corrupt {
                    kind: "display notice record",
                    message: error.to_string(),
                }
            })?;
            bytes.push(b'\n');
            meta.last_seq = next_seq;
            Self::push_bounded_ids(
                &mut meta.flushed_record_ids,
                &event_key,
                MAX_FLUSHED_RECORD_IDS,
            );
            meta.updated_at = u64::try_from(super::now_ms()).unwrap_or(0);
            let meta_bytes = serialize_display_meta(&meta)?;
            let path = self.display_path(id)?;
            self.append_jsonl_line_at(id, &path, "display transcript", &bytes)?;
            self.write_display_meta_bytes(id, &meta_bytes)?;
            if let Ok(idx_path) = self.display_index_path(id) {
                let _ = std::fs::remove_file(idx_path);
            }
            Ok(Some(notice))
        })
    }

    /// 兼容接口：将纯文本通知转化为结构化 v5 显示通知并走唯一 upsert 入口。
    pub fn append_display_notice(
        &self,
        id: &str,
        content: impl Into<String>,
        notice_id: Option<String>,
    ) -> SessionResult<Option<DisplayRecord>> {
        let text = content.into();
        let trimmed = text.trim().to_string();
        if trimmed.is_empty() {
            return Ok(None);
        }
        let (notice_kind, severity) = infer_legacy_notice_meta(&trimmed, notice_id.as_deref());
        let event_key = notice_id.unwrap_or_else(|| format!("notice-{}", uuid::Uuid::new_v4()));
        self.upsert_display_notice_record(
            id,
            DisplayRecord {
                v: DISPLAY_VERSION,
                session_id: id.to_string(),
                role: "assistant".to_string(),
                id: Some(event_key.clone()),
                content: trimmed,
                internal_origin: Some("turn_diagnostic".to_string()),
                created_at: Some(u64::try_from(super::now_ms()).unwrap_or(0)),
                event_id: Some(event_key.clone()),
                part_id: Some(format!("{event_key}:1:notice")),
                notice_kind: Some(notice_kind),
                revision: Some(1),
                severity: Some(severity),
                status: Some(NoticeStatus::Settled),
                ..DisplayRecord::default()
            },
        )
    }

    /// Rewrite the log in place (explicit mutation). `backfilled=false` keeps
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
        if !matches!(meta.v, 4 | DISPLAY_VERSION) {
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
            self.ensure_v5_display_unlocked(id)?;
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
                // The log cannot address the anchor. Drop it under the same
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
                    internal_origin: Some("presentation".into()),
                    ..DisplayRecord::default()
                })
                .collect();
            records.splice(insert_at..insert_at, new_rows);
            self.rewrite_display_rows_with_slices_unlocked(
                id,
                &records,
                meta.last_turn_id,
                &meta.completed_turns,
                meta.backfilled,
                &meta.flushed_slice_keys,
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
        self.rewrite_display_rows_with_slices_unlocked(
            id,
            records,
            last_turn_id,
            completed_turns,
            backfilled,
            &[],
        )
    }

    fn rewrite_display_rows_with_slices_unlocked(
        &self,
        id: &str,
        records: &[DisplayRecord],
        last_turn_id: u64,
        completed_turns: &[u64],
        backfilled: bool,
        flushed_slice_keys: &[String],
    ) -> SessionResult<()> {
        // Drop the old index first: a crash between the log rewrite and the new
        // index must never leave a same-length stale index that still passes the
        // `last_seq` check.
        if let Ok(path) = self.display_index_path(id) {
            let _ = std::fs::remove_file(path);
        }
        let prompt_ids = display_completed_prompt_ids(records);
        let flushed_record_ids = display_record_ids_for_meta(records);
        let mut incomplete = DisplayMeta {
            complete: false,
            last_turn_id: 0,
            last_seq: 0,
            completed_turns: completed_turns.to_vec(),
            completed_prompt_ids: prompt_ids.clone(),
            admitted_prompt_ids: prompt_ids,
            flushed_record_ids,
            flushed_slice_keys: flushed_slice_keys.to_vec(),
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

    fn write_display_meta_bytes(&self, id: &str, bytes: &[u8]) -> SessionResult<()> {
        let path = self.display_meta_path(id)?;
        self.write_bytes_atomic(&path, bytes, "display meta", MAX_DISPLAY_META_BYTES)
    }

    fn write_display_meta(&self, id: &str, meta: &DisplayMeta) -> SessionResult<()> {
        let bytes = serialize_display_meta(meta)?;
        self.write_display_meta_bytes(id, &bytes)
    }

    /// Read a complete display log. `None` means it is absent or incomplete; the
    /// caller must fall back to the snapshot projection (and may backfill).
    pub fn read_display(
        &self,
        id: &str,
    ) -> SessionResult<Option<(DisplayMeta, Vec<DisplayRecord>)>> {
        let meta_path = self.display_meta_path(id)?;
        let Some(meta) = read_display_meta_file(&meta_path)? else {
            return Ok(None);
        };
        // An old/future display projection must be rebuilt from the canonical
        // state rather than interpreted with the current coordinate system. v3/v4
        // remain readable for migration/lazy-upgrade.
        if !meta.complete || !matches!(meta.v, 3 | 4 | DISPLAY_VERSION) {
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
                Ok(mut record) if matches!(record.v, 3 | 4 | DISPLAY_VERSION) => {
                    if matches!(record.v, 4 | DISPLAY_VERSION) {
                        // v4/v5 seq is the ordering contract: strictly increasing and
                        // mirrored by meta.last_seq.
                        if record.seq == 0 || record.seq <= last_seq {
                            return Ok(None);
                        }
                        last_seq = record.seq;
                    }
                    if record.v == 4 {
                        normalize_v4_record(&mut record);
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
        if matches!(meta.v, 4 | DISPLAY_VERSION) && meta.last_seq != last_seq {
            return Ok(None);
        }
        if meta.v == 4 {
            records = normalize_v4_unanchored_notices(records);
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

fn infer_legacy_notice_meta(text: &str, id: Option<&str>) -> (NoticeKind, NoticeSeverity) {
    let id_str = id.unwrap_or("");
    if id_str.starts_with("compact:")
        || [
            "已压缩",
            "已壓縮",
            "无需压缩",
            "無需壓縮",
            "Compacted",
            "Nothing to compact",
            "Đã thu gọn",
        ]
        .iter()
        .any(|marker| text.contains(marker))
    {
        return (NoticeKind::Compaction, NoticeSeverity::Info);
    }
    if id_str.ends_with(":retry") || text.contains("重试") || text.contains("retry") {
        return (NoticeKind::Retry, NoticeSeverity::Warning);
    }
    if text.contains("速率限制") || text.contains("rate limit") || text.contains("429") {
        return (NoticeKind::RateLimit, NoticeSeverity::Warning);
    }
    if text.contains("超时") || text.contains("timeout") {
        return (NoticeKind::Timeout, NoticeSeverity::Warning);
    }
    if text.contains("错误")
        || text.contains("失败")
        || text.contains("Error")
        || text.contains("failed")
    {
        return (NoticeKind::Error, NoticeSeverity::Error);
    }
    (NoticeKind::Warning, NoticeSeverity::Warning)
}

fn normalize_v4_record(record: &mut DisplayRecord) {
    if record.internal_origin.as_deref() == Some("turn_diagnostic") {
        let key = record
            .event_id
            .clone()
            .or_else(|| record.id.clone())
            .unwrap_or_else(|| format!("notice-{}-{}", record.turn_id, record.seq));
        if record.event_id.is_none() {
            record.event_id = Some(key.clone());
        }
        if record.part_id.is_none() {
            record.part_id = Some(format!("{key}:1:notice"));
        }
        let (kind, sev) = infer_legacy_notice_meta(&record.content, record.id.as_deref());
        if record.notice_kind.is_none() {
            record.notice_kind = Some(kind);
        }
        if record.severity.is_none() {
            record.severity = Some(sev);
        }
        if record.status.is_none() {
            record.status = Some(NoticeStatus::Settled);
        }
        if record.revision.is_none() {
            record.revision = Some(1);
        }
    }
    record.v = DISPLAY_VERSION;
}

/// 将 v4 遗留日志中未带 `anchor_message_id` 的 `turn_diagnostic` 顺延挂到其所属
/// `turn_id` 末尾，修复旧版本因中途插入导致的通知倒悬在问题之前。
fn normalize_v4_unanchored_notices(records: Vec<DisplayRecord>) -> Vec<DisplayRecord> {
    let mut out = Vec::with_capacity(records.len());
    let mut pending_by_turn: std::collections::BTreeMap<u64, Vec<DisplayRecord>> =
        std::collections::BTreeMap::new();
    let mut current_turn: Option<u64> = None;

    for record in records {
        let is_unanchored_diag = record.internal_origin.as_deref() == Some("turn_diagnostic")
            && record.anchor_message_id.is_none();
        if let Some(prev_turn) = current_turn {
            if record.turn_id != prev_turn {
                if let Some(buffered) = pending_by_turn.remove(&prev_turn) {
                    out.extend(buffered);
                }
            }
        }
        if !is_unanchored_diag {
            current_turn = Some(record.turn_id);
            out.push(record);
        } else {
            current_turn.get_or_insert(record.turn_id);
            pending_by_turn
                .entry(record.turn_id)
                .or_default()
                .push(record);
        }
    }
    for (_, buffered) in pending_by_turn {
        out.extend(buffered);
    }
    out
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
            created_at: Some(1_000 + i64::from(index) as u64),
            ..DisplayRecord::default()
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

    #[test]
    fn display_notice_upserts_in_place_by_event_id_without_polluting_seq() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::with_root(dir.path());
        mgr.write_display_backfill("s1", &[record(1, 0, "Q")], 1)
            .unwrap();
        let text1 = "网络连接中断，已保留当前输出，重试 1/9 次";
        let first = mgr
            .upsert_display_notice_record(
                "s1",
                DisplayRecord {
                    turn_id: 1,
                    id: Some("m-a:retry".into()),
                    event_id: Some("m-a:retry".into()),
                    part_id: Some("m-a:retry:1:notice".into()),
                    content: text1.into(),
                    notice_kind: Some(NoticeKind::Retry),
                    revision: Some(1),
                    severity: Some(NoticeSeverity::Warning),
                    status: Some(NoticeStatus::Active),
                    ..DisplayRecord::default()
                },
            )
            .unwrap()
            .unwrap();
        // 幂等重复（同 event_id, 同 revision/content）：不新增记录。
        let second = mgr
            .append_display_notice("s1", text1, Some("m-a:retry".into()))
            .unwrap()
            .unwrap();
        assert_eq!(second.id, first.id);

        // 同一 event_id、更高 revision 的更新或终态收敛：原地更新为唯一记录，不再追加 9 条！
        let third = mgr
            .upsert_display_notice_record(
                "s1",
                DisplayRecord {
                    turn_id: 1,
                    id: Some("m-a:retry".into()),
                    event_id: Some("m-a:retry".into()),
                    part_id: Some("m-a:retry:1:notice".into()),
                    content: "自动重连失败，已终止".into(),
                    notice_kind: Some(NoticeKind::Error),
                    revision: Some(2),
                    severity: Some(NoticeSeverity::Error),
                    status: Some(NoticeStatus::Settled),
                    ..DisplayRecord::default()
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(third.seq, first.seq, "原地更新应保留原有因果 seq 位置");
        assert_eq!(third.status, Some(NoticeStatus::Settled));

        // 已 settled 后即使收到滞后 active 帧也不得降级。
        let stale = mgr
            .upsert_display_notice_record(
                "s1",
                DisplayRecord {
                    turn_id: 1,
                    id: Some("m-a:retry".into()),
                    event_id: Some("m-a:retry".into()),
                    content: "滞后重试 1/9".into(),
                    notice_kind: Some(NoticeKind::Retry),
                    revision: Some(99),
                    severity: Some(NoticeSeverity::Warning),
                    status: Some(NoticeStatus::Active),
                    ..DisplayRecord::default()
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(stale.status, Some(NoticeStatus::Settled));
        assert_eq!(stale.content, "自动重连失败，已终止");

        let (_, rows) = mgr.read_display("s1").unwrap().unwrap();
        assert_eq!(
            rows.iter()
                .filter(|row| row.id.as_deref() == Some("m-a:retry"))
                .count(),
            1,
            "v5 同 event_id 在账本里只保留单一权威记录"
        );
    }

    #[test]
    fn display_notice_initializes_missing_meta_when_turn_id_gt_one() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::with_root(dir.path());
        mgr.write_meta(&crate::session::SessionMeta::new("s-turn2", "/tmp", 1))
            .unwrap();
        // Deliberately do NOT write `.display.meta.json` yet, and upsert with turn_id = 2.
        let inserted = mgr
            .upsert_display_notice_record(
                "s-turn2",
                DisplayRecord {
                    turn_id: 2,
                    id: Some("warn-max-rounds:2".into()),
                    event_id: Some("warn-max-rounds:2".into()),
                    content: "Round limit reached".into(),
                    notice_kind: Some(NoticeKind::Warning),
                    severity: Some(NoticeSeverity::Warning),
                    status: Some(NoticeStatus::Settled),
                    ..DisplayRecord::default()
                },
            )
            .unwrap();
        let inserted = inserted
            .expect("missing display meta on turn_id > 1 must initialize and persist notice");
        assert_eq!(inserted.id.as_deref(), Some("warn-max-rounds:2"));
        assert_eq!(inserted.turn_id, 2);
        let (_, rows) = mgr.read_display("s-turn2").unwrap().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].severity, Some(NoticeSeverity::Warning));
    }

    #[test]
    fn append_display_slice_checkpoint_flushes_early_without_blocking_turn_complete() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::with_root(dir.path());
        let q1 = record(1, 0, "Q1");
        let mut a1 = record(1, 1, "A1");
        a1.role = "assistant".into();
        let mut a2 = record(1, 2, "A2");
        a2.role = "assistant".into();

        // 第一轮检查点提前写 [Q1, A1]。
        assert!(mgr
            .append_display_slice("s1", 1, "t1:c1", &[q1.clone(), a1.clone()])
            .unwrap());
        let (meta1, rows1) = mgr.read_display("s1").unwrap().unwrap();
        assert_eq!(rows1.len(), 2);
        assert!(
            !meta1.completed_prompt_ids.contains(&"m-1-0".to_string()),
            "切片检查点绝不得提前标为 completed_prompt_ids"
        );

        // 相同 slice_key 幂等跳过。
        assert!(mgr
            .append_display_slice("s1", 1, "t1:c1", &[q1.clone(), a1.clone()])
            .unwrap());
        assert_eq!(mgr.read_display("s1").unwrap().unwrap().1.len(), 2);

        // turn_complete 只补写剩余 A2 并把 m-1-0 标记为 completed。
        mgr.append_display_turn("s1", 1, &[q1, a1, a2]).unwrap();
        let (meta2, rows2) = mgr.read_display("s1").unwrap().unwrap();
        assert_eq!(rows2.len(), 3);
        assert_eq!(
            rows2.iter().map(|r| r.content.as_str()).collect::<Vec<_>>(),
            vec!["Q1", "A1", "A2"]
        );
        assert!(meta2.completed_prompt_ids.contains(&"m-1-0".to_string()));
    }

    #[tokio::test]
    async fn display_hook_flushes_before_midturn_compaction_and_anchors_notices() {
        use jeikcode_kernel::message::CompactReport;

        let dir = tempfile::tempdir().unwrap();
        let mgr = std::sync::Arc::new(SessionManager::with_root(dir.path()));
        let hook = DisplayHook::new(mgr.clone(), "s1", dir.path());

        let mut convo = Conversation::new();
        let mut q = Message::user("长任务");
        q.id = Some("u-1".into());
        convo.push(q);
        hook.turn_start(&mut convo).await;

        let mut a1 = Message::assistant("第一轮输出", Vec::new());
        a1.id = Some("a-1".into());
        convo.push(a1);
        let ctx = TurnCtx {
            turn_id: 1,
            ..Default::default()
        };
        hook.on_turn_checkpoint(&convo, &ctx).await;

        // 发出绑定在 a-1 上的重试通知，然后恢复收口。
        let n1 = SystemNotice {
            event_id: "retry-1".into(),
            part_id: "retry-1:1:notice".into(),
            kind: NoticeKind::Retry,
            severity: NoticeSeverity::Warning,
            status: NoticeStatus::Active,
            revision: 1,
            text: "流空闲超时，重试 1/9 次".into(),
            anchor_message_id: Some("a-1".into()),
            anchor_part_id: None,
            turn_id: Some(1),
            persist: true,
        };
        hook.on_system_notice(&n1, &convo, &ctx).await;

        // 回合中发生自动压缩：先 pre_compaction 落盘，随后裁剪内存 convo，再写入压缩边界。
        hook.pre_compaction(
            &convo,
            &CompactTrigger::Auto { utilization: 0.9 },
            Some(&ctx),
        )
        .await;
        convo.messages.drain(..1); // 裁掉前面消息（a-1 也在日志里安全保留了）
        let compact_report = CompactReport {
            epoch_before: 0,
            epoch_after: 1,
            removed: 1,
            bytes_before: 4000,
            bytes_after: 800,
            committed: true,
        };
        let compact_notice = SystemNotice {
            event_id: "compact:epoch:1".into(),
            part_id: "compact:epoch:1:1:notice".into(),
            kind: NoticeKind::Compaction,
            severity: NoticeSeverity::Info,
            status: NoticeStatus::Settled,
            revision: 1,
            text: "已压缩 · 摘要 1 条".into(),
            anchor_message_id: Some("a-1".into()),
            anchor_part_id: None,
            turn_id: Some(1),
            persist: true,
        };
        hook.post_compaction(&compact_report, &compact_notice, Some(&ctx))
            .await;

        let mut a2 = Message::assistant("最终回复", Vec::new());
        a2.id = Some("a-2".into());
        convo.push(a2);
        hook.turn_complete(&convo, &StopReason::Stopped, &ctx).await;

        let (_, rows) = mgr.read_display("s1").unwrap().unwrap();
        let contents: Vec<&str> = rows.iter().map(|r| r.content.as_str()).collect();
        // u-1, a-1, retry-1 (settled on turn_complete), compact:epoch:1, a-2
        assert_eq!(
            contents,
            vec![
                "长任务",
                "第一轮输出",
                "流空闲超时，重试 1/9 次",
                "已压缩 · 摘要 1 条",
                "最终回复"
            ]
        );
        let retry_row = rows
            .iter()
            .find(|r| r.event_id.as_deref() == Some("retry-1"))
            .unwrap();
        assert_eq!(retry_row.status, Some(NoticeStatus::Settled));
    }

    #[test]
    fn v4_unanchored_notices_migrate_to_turn_tail_lazily() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::with_root(dir.path());
        // 构造一个带错位 v4 通知的老日志：turn=1 里 user(seq=1) -> notice(seq=2) -> assistant(seq=3)
        let u1 = DisplayRecord {
            v: 4,
            session_id: "s1".into(),
            turn_id: 1,
            index: 0,
            seq: 1,
            role: "user".into(),
            id: Some("u-1".into()),
            content: "提问".into(),
            ..DisplayRecord::default()
        };
        let old_notice = DisplayRecord {
            v: 4,
            session_id: "s1".into(),
            turn_id: 1,
            index: 0,
            seq: 2,
            role: "assistant".into(),
            id: Some("notice-old".into()),
            content: "已压缩 · 摘要 3 条".into(),
            internal_origin: Some("turn_diagnostic".into()),
            ..DisplayRecord::default()
        };
        let a1 = DisplayRecord {
            v: 4,
            session_id: "s1".into(),
            turn_id: 1,
            index: 1,
            seq: 3,
            role: "assistant".into(),
            id: Some("a-1".into()),
            content: "回答".into(),
            ..DisplayRecord::default()
        };
        let mut bytes = Vec::new();
        for r in [&u1, &old_notice, &a1] {
            serde_json::to_writer(&mut bytes, r).unwrap();
            bytes.push(b'\n');
        }
        std::fs::write(mgr.display_path("s1").unwrap(), &bytes).unwrap();
        mgr.write_display_meta(
            "s1",
            &DisplayMeta {
                v: 4,
                complete: true,
                last_turn_id: 1,
                last_seq: 3,
                completed_turns: vec![1],
                completed_prompt_ids: vec!["u-1".into()],
                admitted_prompt_ids: vec!["u-1".into()],
                ..DisplayMeta::default()
            },
        )
        .unwrap();

        let (meta, rows) = mgr.read_display("s1").unwrap().unwrap();
        assert_eq!(meta.v, 4);
        assert_eq!(
            rows.iter()
                .map(|r| r.id.as_deref().unwrap())
                .collect::<Vec<_>>(),
            vec!["u-1", "a-1", "notice-old"],
            "未带锚点的 v4 旧通知在读取时应顺延至所属 turn 末尾"
        );
        let migrated_notice = &rows[2];
        assert_eq!(migrated_notice.notice_kind, Some(NoticeKind::Compaction));
        assert_eq!(migrated_notice.status, Some(NoticeStatus::Settled));
    }

    #[test]
    fn large_display_meta_past_64kib_does_not_tear_log_and_prunes_settled_slice_keys() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::with_root(dir.path());

        let mut records = Vec::with_capacity(2200);
        for i in 0..2200u32 {
            let mut rec = DisplayRecord {
                v: DISPLAY_VERSION,
                session_id: "s-large".into(),
                turn_id: 1,
                index: i,
                seq: 0,
                role: if i == 0 {
                    "user".into()
                } else {
                    "assistant".into()
                },
                id: Some(format!("m-0000000000000000000000000000{i:04}")),
                content: format!("row-{i}"),
                ..DisplayRecord::default()
            };
            if i > 0 && i % 50 == 0 {
                rec.role = "tool".into();
                rec.tool_call_id = Some(format!("call-{i}"));
            }
            records.push(rec);
        }

        // 先通过检查点写入超过 64 KiB 阈值的记录并落盘。
        for chunk_idx in 0..10u32 {
            let end = ((chunk_idx + 1) * 220) as usize;
            let key = format!("t1:c{}", chunk_idx + 1);
            assert!(mgr
                .append_display_slice("s-large", 1, &key, &records[..end])
                .unwrap());
        }
        let meta_path = mgr.display_meta_path("s-large").unwrap();
        assert!(
            std::fs::metadata(&meta_path).unwrap().len() > 64 * 1024,
            "metadata should grow past old 64 KiB cap without failing"
        );

        // 回合收口后：瞬态切片键应被清理，且日志与 meta 的 last_seq 保持一致可读。
        mgr.append_display_turn("s-large", 1, &records).unwrap();
        let (meta, read_rows) = mgr.read_display("s-large").unwrap().unwrap();
        assert_eq!(read_rows.len(), 2200);
        assert_eq!(meta.last_seq, 2200);
        assert!(
            meta.flushed_slice_keys
                .iter()
                .all(|key| !key.starts_with("t1:")),
            "settled turn slice keys must be pruned"
        );
    }
}
