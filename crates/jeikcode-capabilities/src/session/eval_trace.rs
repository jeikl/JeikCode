//! Phase 2 会话评测与无损上游请求重放账本（`eval_trace`）。
//!
//! 设计目标：
//! 1. **O(N) 无损重放**：按 `(system_messages, tools)` 的 SHA-256 摘要把静态前缀与工具模式去重落盘到
//!    `$JEIKCODE_HOME/eval/bundles/<sha256_16>.json`；逐轮 `<id>.trace.jsonl` 只保存非系统消息前缀
//!    最长公共前缀长度 `prefix_keep` 及尾部增量 `messages_delta`（天然包含 `pre_request` 注入与压缩后重置）。
//! 2. **零配置多端统一**：在 `SessionTraceHook` 统一挂接内核 `LifecycleHooks` + `ToolMiddleware`，
//!    自动覆盖 WebUI(`/chat`、`/live`)、TUI、Headless CLI 与 `task` 子 Agent，记录
//!    `approval_wait_ms`、`repaired_args`、`target_hint`、`result_bytes`、`truncated`、
//!    `ttft_ms`、`reasoning_elapsed_ms`、`Compaction`、`SystemNotice` 与 `TurnComplete`。
//! 3. **量化评测与配额护栏**：提供 `reconstruct_upstream_request` 与 `evaluate_session_metrics`，
//!    并对单会话 trace 体积（32 MiB 滚动旋转）及全局 bundle 数量/总体积/保留天数做自动裁剪。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Instant, SystemTime};

use async_trait::async_trait;
use jeikcode_kernel::event::{NoticeKind, NoticeSeverity, NoticeStatus, StopReason, SystemNotice};
use jeikcode_kernel::hook::{LifecycleHooks, TurnCtx};
use jeikcode_kernel::message::{CompactReport, CompactTrigger, Conversation, Message, Role};
use jeikcode_kernel::middleware::{AfterOutcome, BeforeOutcome, ToolMiddleware};
use jeikcode_kernel::provider::ChatOptions;
use jeikcode_kernel::request::RequestCtx;
use jeikcode_kernel::stream::TokenUsage;
use jeikcode_kernel::tool::{Tool, ToolCall, ToolDef, ToolResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::manager::{atomic_write, SessionManager, SessionResult, SessionStoreError};
use super::now_ms;
use super::snapshot::stop_reason_slug;
use super::tool_metrics::{
    sanitize_target_hint, ToolMetricRecord, ToolMetricStatus, TOOL_METRIC_VERSION,
};

pub const EVAL_TRACE_VERSION: u32 = 1;
pub const EVAL_BUNDLE_VERSION: u32 = 1;

/// 单个 `<id>.trace.jsonl` 上限（32 MiB）；超出后滚动到 `.trace.jsonl.old` 并以完整前缀开启新文件。
pub const MAX_TRACE_FILE_BYTES: u64 = 32 * 1024 * 1024;
/// 全局去重上下文 bundle 上限（数目 / 总字节数 / 最长保留天数）。
pub const MAX_EVAL_BUNDLES_COUNT: usize = 512;
pub const MAX_EVAL_BUNDLES_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_EVAL_ARTIFACT_AGE_SECS: u64 = 30 * 24 * 3600;
const PRUNE_CHECK_EVERY_BUNDLES: u64 = 32;

/// 按 SHA-256（前 16 位 hex）去重落盘的静态请求上下文包（系统提示词块 + 工具定义）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ContextBundle {
    pub v: u32,
    pub context_hash: String,
    pub created_at_ms: u64,
    pub system_messages: Vec<Message>,
    pub tools: Vec<ToolDef>,
}

/// 写入 `<id>.trace.jsonl` 的单行结构化追踪记录。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "record_type", rename_all = "snake_case")]
pub enum TraceRecord {
    RoundRequest {
        v: u32,
        seq: u64,
        ts_ms: u64,
        turn_id: u64,
        round: u32,
        request_id: u64,
        cache_epoch: u64,
        provider: String,
        model: String,
        context_hash: String,
        options: ChatOptions,
        total_non_system_messages: usize,
        prefix_keep: usize,
        messages_delta: Vec<Message>,
    },
    RoundResponse {
        v: u32,
        ts_ms: u64,
        turn_id: u64,
        round: u32,
        request_id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ttft_ms: Option<u64>,
        reasoning_elapsed_ms: u64,
        elapsed_ms: u64,
        tokens: TokenUsage,
        used_tokens: u32,
        ctx_window: u32,
        utilization: f32,
        finish_reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_response_id: Option<String>,
        assistant_message: Message,
    },
    Compaction {
        v: u32,
        ts_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        round: Option<u32>,
        epoch_before: u64,
        epoch_after: u64,
        trigger: CompactTrigger,
        removed: usize,
        bytes_before: usize,
        bytes_after: usize,
        notice_text: String,
    },
    SystemNotice {
        v: u32,
        ts_ms: u64,
        turn_id: u64,
        round: u32,
        request_id: u64,
        event_id: String,
        kind: NoticeKind,
        severity: NoticeSeverity,
        status: NoticeStatus,
        revision: u32,
        text: String,
    },
    TurnComplete {
        v: u32,
        ts_ms: u64,
        turn_id: u64,
        round: u32,
        stop_reason: String,
    },
}

/// 由 `reconstruct_upstream_request` 完整还原的某轮上游发包负载。
#[derive(Clone, Debug, PartialEq)]
pub struct ReconstructedUpstreamRequest {
    pub seq: u64,
    pub turn_id: u64,
    pub round: u32,
    pub request_id: u64,
    pub cache_epoch: u64,
    pub provider: String,
    pub model: String,
    pub context_hash: String,
    pub options: ChatOptions,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolDef>,
}

/// 分位数与累计耗时统计。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LatencyStats {
    pub count: usize,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub max_ms: u64,
    pub total_ms: u64,
}

/// 会话级可观测性与评测汇总报告。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SessionEvalReport {
    pub session_id: String,
    pub parent_session_id: Option<String>,
    pub parent_call_id: Option<String>,
    pub child_session_ids: Vec<String>,
    pub round_count: usize,
    pub turn_count: usize,
    pub stop_reasons: BTreeMap<String, usize>,
    pub total_prompt_tokens: u64,
    pub total_cached_tokens: u64,
    pub total_completion_tokens: u64,
    pub kv_cache_hit_rate: f64,
    pub ttft_ms: LatencyStats,
    pub reasoning_ms: LatencyStats,
    pub round_elapsed_ms: LatencyStats,
    pub tool_calls_total: usize,
    pub tool_calls_error: usize,
    pub tool_calls_incomplete: usize,
    pub tool_exec_ms: LatencyStats,
    pub approval_wait_ms: LatencyStats,
    pub tool_switch_ms: LatencyStats,
    pub repaired_args_count: usize,
    pub truncated_results_count: usize,
    pub compaction_count: usize,
    pub overflow_compaction_count: usize,
    pub notice_counts_by_kind: BTreeMap<String, usize>,
    /// 浪费工具调用占比：出错调用 + 相邻同工具同目标摘要重复 + 循环检测/重复拦截回合中的调用。
    pub wasted_tool_ratio: f64,
    /// 综合摩擦指数：聚合工具失败、参数修复、截断、循环/超限、溢出压缩、超时、重试等负面信号。
    pub friction_score: f64,
}

#[derive(Clone)]
struct InflightTool {
    name: String,
    started: Instant,
    started_at_ms: u64,
    switch_ms: u64,
    target_hint: Option<String>,
    turn_id: Option<u64>,
    round: Option<u32>,
}

struct TraceState {
    seeded: bool,
    next_seq: u64,
    prev_wire_non_sys: Vec<Message>,
    known_bundles: HashSet<String>,
    bundle_writes_since_prune: u64,
}

struct TraceShared {
    mgr: Arc<SessionManager>,
    session_id: String,
    bundles_dir: PathBuf,
    attribution: RwLock<(String, String)>,
    state: Mutex<TraceState>,
    origin: Instant,
    last_activity_rel_ms: AtomicU64,
    current_turn_id: AtomicU64,
    current_round: std::sync::atomic::AtomicU32,
    pending_compact_trigger: Mutex<Option<CompactTrigger>>,
    inflight_tools: Mutex<HashMap<String, InflightTool>>,
    io_lock: Mutex<()>,
}

/// 会话级统一追踪与工具指标落盘核心钩子（挂接内核 `LifecycleHooks` + 成对工具中间件）。
pub struct SessionTraceHook {
    shared: Arc<TraceShared>,
}

/// 注册在参数修复之后、所有策略与审批门之前的工具开始观察中间件。
pub struct SessionTraceStartMiddleware {
    shared: Arc<TraceShared>,
}

/// 注册在产物折叠与所有过滤门之后的最终工具完成观察中间件。
pub struct SessionTraceEndMiddleware {
    shared: Arc<TraceShared>,
}

/// 解析给定 [`SessionManager`] 对应的去重 ContextBundle 存储目录。
///
/// 生产环境下 `mgr.root()` 位于 `$JEIKCODE_HOME/sessions/<project_hash>`，bundle 统一落在
/// `$JEIKCODE_HOME/eval/bundles/` 以跨项目共享去重；临时测试目录则隔离在 `<root>/.eval-bundles/`。
pub fn default_bundles_dir_for(mgr: &SessionManager) -> PathBuf {
    let root = mgr.root();
    if root.parent().and_then(|p| p.file_name()) == Some(std::ffi::OsStr::new("sessions")) {
        if let Some(home) = root.parent().and_then(|p| p.parent()) {
            return home.join("eval").join("bundles");
        }
    }
    root.join(".eval-bundles")
}

fn bundle_path(bundles_dir: &Path, context_hash: &str) -> SessionResult<PathBuf> {
    if context_hash.is_empty() || !context_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(SessionStoreError::InvalidId {
            id: context_hash.to_string(),
            reason: "invalid eval context hash",
        });
    }
    Ok(bundles_dir.join(format!("{context_hash}.json")))
}

fn compute_context_hash_and_bytes(
    system_messages: &[Message],
    tools: &[ToolDef],
) -> SessionResult<(String, Vec<u8>)> {
    #[derive(Serialize)]
    struct CanonicalInput<'a> {
        system_messages: &'a [Message],
        tools: &'a [ToolDef],
    }
    let canonical = serde_json::to_vec(&CanonicalInput {
        system_messages,
        tools,
    })
    .map_err(|error| SessionStoreError::Corrupt {
        kind: "eval context bundle hash",
        message: error.to_string(),
    })?;
    let digest = Sha256::digest(&canonical);
    let mut full_hex = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(full_hex, "{byte:02x}");
    }
    let short_hash = full_hex[..16].to_string();
    let bundle = ContextBundle {
        v: EVAL_BUNDLE_VERSION,
        context_hash: short_hash.clone(),
        created_at_ms: now_ms().max(0) as u64,
        system_messages: system_messages.to_vec(),
        tools: tools.to_vec(),
    };
    let encoded = serde_json::to_vec(&bundle).map_err(|error| SessionStoreError::Corrupt {
        kind: "eval context bundle",
        message: error.to_string(),
    })?;
    Ok((short_hash, encoded))
}

fn common_prefix_len(a: &[Message], b: &[Message]) -> usize {
    a.iter().zip(b.iter()).take_while(|(x, y)| x == y).count()
}

fn seed_state_from_existing_trace(mgr: &SessionManager, session_id: &str) -> (u64, Vec<Message>) {
    let Ok(records) = read_trace_records(mgr, session_id) else {
        return (1, Vec::new());
    };
    let mut last_seq = 0u64;
    let mut non_sys: Vec<Message> = Vec::new();
    for rec in records {
        if let TraceRecord::RoundRequest {
            seq,
            prefix_keep,
            messages_delta,
            ..
        } = rec
        {
            last_seq = seq;
            let keep = prefix_keep.min(non_sys.len());
            non_sys.truncate(keep);
            non_sys.extend(messages_delta);
        }
    }
    (last_seq.saturating_add(1), non_sys)
}

/// 按时间/数目/字节数自动裁剪 `eval/bundles` 与（可选的）旧 `.trace.jsonl*` 磁盘配额。
pub fn prune_eval_storage(
    bundles_dir: &Path,
    sessions_root: Option<&Path>,
    max_bundle_count: usize,
    max_bundle_bytes: u64,
    max_age_secs: u64,
) {
    let now = SystemTime::now();
    if let Ok(entries) = fs::read_dir(bundles_dir) {
        let mut files: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let age_secs = now
                .duration_since(modified)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            if max_age_secs > 0 && age_secs > max_age_secs {
                let _ = fs::remove_file(&path);
                continue;
            }
            files.push((path, meta.len(), modified));
        }
        let mut total_bytes: u64 = files.iter().map(|(_, len, _)| *len).sum();
        if files.len() > max_bundle_count || total_bytes > max_bundle_bytes {
            // 按修改时间从旧到新淘汰。
            files.sort_by_key(|(_, _, mtime)| *mtime);
            let mut remaining = files.len();
            for (path, len, _) in files {
                if remaining <= max_bundle_count && total_bytes <= max_bundle_bytes {
                    break;
                }
                if fs::remove_file(&path).is_ok() {
                    remaining = remaining.saturating_sub(1);
                    total_bytes = total_bytes.saturating_sub(len);
                }
            }
        }
    }

    if let Some(root) = sessions_root {
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                if !(name.ends_with(".trace.jsonl.old") || name.ends_with(".trace.jsonl")) {
                    continue;
                }
                let Ok(meta) = entry.metadata() else {
                    continue;
                };
                if !meta.is_file() {
                    continue;
                }
                let age_secs = meta
                    .modified()
                    .ok()
                    .and_then(|m| now.duration_since(m).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                if max_age_secs > 0 && age_secs > max_age_secs {
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }
}

fn contains_truncation_marker(text: &str) -> bool {
    text.contains("…[truncated:")
        || text.contains("[truncated:")
        || text.contains("lines elided")
        || text.contains("lines truncated")
        || text.contains("[Output truncated")
}

impl SessionTraceHook {
    pub fn new(
        mgr: Arc<SessionManager>,
        session_id: impl Into<String>,
        provider: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        let session_id = session_id.into();
        let bundles_dir = default_bundles_dir_for(&mgr);
        let shared = Arc::new(TraceShared {
            mgr,
            session_id,
            bundles_dir,
            attribution: RwLock::new((provider.into(), model.into())),
            state: Mutex::new(TraceState {
                seeded: false,
                next_seq: 0,
                prev_wire_non_sys: Vec::new(),
                known_bundles: HashSet::new(),
                bundle_writes_since_prune: 0,
            }),
            origin: Instant::now(),
            last_activity_rel_ms: AtomicU64::new(0),
            current_turn_id: AtomicU64::new(0),
            current_round: std::sync::atomic::AtomicU32::new(0),
            pending_compact_trigger: Mutex::new(None),
            inflight_tools: Mutex::new(HashMap::new()),
            io_lock: Mutex::new(()),
        });
        Self { shared }
    }

    pub fn with_bundles_dir(self, dir: impl Into<PathBuf>) -> Self {
        // 仅在独立测试或自定义布局初始化期替换目录：构造后立刻设置无并发写入。
        let shared = Arc::new(TraceShared {
            mgr: self.shared.mgr.clone(),
            session_id: self.shared.session_id.clone(),
            bundles_dir: dir.into(),
            attribution: RwLock::new(
                self.shared
                    .attribution
                    .read()
                    .map(|g| g.clone())
                    .unwrap_or_default(),
            ),
            state: Mutex::new(TraceState {
                seeded: false,
                next_seq: 0,
                prev_wire_non_sys: Vec::new(),
                known_bundles: HashSet::new(),
                bundle_writes_since_prune: 0,
            }),
            origin: self.shared.origin,
            last_activity_rel_ms: AtomicU64::new(0),
            current_turn_id: AtomicU64::new(0),
            current_round: std::sync::atomic::AtomicU32::new(0),
            pending_compact_trigger: Mutex::new(None),
            inflight_tools: Mutex::new(HashMap::new()),
            io_lock: Mutex::new(()),
        });
        Self { shared }
    }

    pub fn set_model_attribution(&self, provider: impl Into<String>, model: impl Into<String>) {
        if let Ok(mut g) = self.shared.attribution.write() {
            *g = (provider.into(), model.into());
        }
    }

    pub fn start_middleware(&self) -> SessionTraceStartMiddleware {
        SessionTraceStartMiddleware {
            shared: Arc::clone(&self.shared),
        }
    }

    pub fn end_middleware(&self) -> SessionTraceEndMiddleware {
        SessionTraceEndMiddleware {
            shared: Arc::clone(&self.shared),
        }
    }
}

impl TraceShared {
    fn touch_activity(&self) {
        let rel = self.origin.elapsed().as_millis() as u64;
        self.last_activity_rel_ms.store(rel, Ordering::Relaxed);
    }

    fn take_switch_ms(&self) -> u64 {
        let now_rel = self.origin.elapsed().as_millis() as u64;
        let prev = self.last_activity_rel_ms.swap(now_rel, Ordering::Relaxed);
        now_rel.saturating_sub(prev)
    }

    fn current_attribution(&self) -> (String, String) {
        self.attribution
            .read()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    /// 将单条 trace 记录追加写入 `<id>.trace.jsonl`；超出 `MAX_TRACE_FILE_BYTES` 时自动旋转。
    /// 若发生文件旋转返回 `true`，提示调用方把 `prefix_keep` 归零重建起点。
    fn append_trace_record(&self, record: &TraceRecord) -> bool {
        let Ok(path) = self.mgr.trace_path(&self.session_id) else {
            return false;
        };
        let Ok(mut line) = serde_json::to_vec(record) else {
            return false;
        };
        line.push(b'\n');

        let _io = self.io_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut rotated = false;
        if let Ok(meta) = fs::metadata(&path) {
            if meta.len().saturating_add(line.len() as u64) > MAX_TRACE_FILE_BYTES {
                let mut old = path.as_os_str().to_owned();
                old.push(".old");
                if fs::rename(&path, PathBuf::from(old)).is_ok() {
                    rotated = true;
                }
            }
        }
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
            if let Err(error) = file.write_all(&line) {
                tracing::warn!(
                    target: "jeikcode::eval",
                    session_id = %self.session_id,
                    %error,
                    "failed to append trace record"
                );
            }
        }
        rotated
    }

    fn ensure_bundle_written(
        &self,
        context_hash: &str,
        encoded_bundle: &[u8],
        known: &mut HashSet<String>,
        writes_since_prune: &mut u64,
    ) {
        if known.contains(context_hash) {
            return;
        }
        let Ok(path) = bundle_path(&self.bundles_dir, context_hash) else {
            return;
        };
        if !path.exists() {
            if let Err(error) = atomic_write(&path, encoded_bundle) {
                tracing::warn!(
                    target: "jeikcode::eval",
                    %context_hash,
                    %error,
                    "failed to write context bundle"
                );
                return;
            }
            *writes_since_prune = writes_since_prune.saturating_add(1);
            if *writes_since_prune >= PRUNE_CHECK_EVERY_BUNDLES {
                *writes_since_prune = 0;
                let bundles_dir = self.bundles_dir.clone();
                let root = self.mgr.root().to_path_buf();
                let prune_job = move || {
                    prune_eval_storage(
                        &bundles_dir,
                        Some(&root),
                        MAX_EVAL_BUNDLES_COUNT,
                        MAX_EVAL_BUNDLES_BYTES,
                        MAX_EVAL_ARTIFACT_AGE_SECS,
                    );
                };
                if let Ok(handle) = tokio::runtime::Handle::try_current() {
                    let _ = handle.spawn_blocking(prune_job);
                } else {
                    let _ = std::thread::Builder::new()
                        .name("jeikcode-eval-prune".into())
                        .spawn(prune_job);
                }
            }
        }
        known.insert(context_hash.to_string());
    }

    fn persist_and_log_tool_metric(&self, record: &ToolMetricRecord) {
        match record.status {
            ToolMetricStatus::Error | ToolMetricStatus::Incomplete => {
                tracing::warn!(
                    target: "jeikcode::tool",
                    session_id = %self.session_id,
                    call_id = %record.call_id,
                    tool = %record.name,
                    status = record.status.as_str(),
                    duration_ms = record.duration_ms.unwrap_or(0),
                    switch_ms = record.switch_ms,
                    approval_wait_ms = record.approval_wait_ms.unwrap_or(0),
                    repaired_args = record.repaired_args.unwrap_or(false),
                    truncated = record.truncated.unwrap_or(false),
                    target_hint = record.target_hint.as_deref().unwrap_or(""),
                    "tool call failed or incomplete"
                );
            }
            ToolMetricStatus::Done => {
                let dur = record.duration_ms.unwrap_or(0);
                if dur >= 3_000 || record.switch_ms >= 2_000 {
                    tracing::info!(
                        target: "jeikcode::tool",
                        session_id = %self.session_id,
                        call_id = %record.call_id,
                        tool = %record.name,
                        duration_ms = dur,
                        switch_ms = record.switch_ms,
                        approval_wait_ms = record.approval_wait_ms.unwrap_or(0),
                        repaired_args = record.repaired_args.unwrap_or(false),
                        truncated = record.truncated.unwrap_or(false),
                        result_bytes = record.result_bytes.unwrap_or(0),
                        target_hint = record.target_hint.as_deref().unwrap_or(""),
                        "slow tool call settled"
                    );
                } else {
                    tracing::debug!(
                        target: "jeikcode::tool",
                        session_id = %self.session_id,
                        call_id = %record.call_id,
                        tool = %record.name,
                        duration_ms = dur,
                        switch_ms = record.switch_ms,
                        approval_wait_ms = record.approval_wait_ms.unwrap_or(0),
                        repaired_args = record.repaired_args.unwrap_or(false),
                        truncated = record.truncated.unwrap_or(false),
                        target_hint = record.target_hint.as_deref().unwrap_or(""),
                        "tool call settled"
                    );
                }
            }
            ToolMetricStatus::Running => {}
        }
        if let Err(error) = self.mgr.append_tool_metric(&self.session_id, record) {
            tracing::warn!(
                target: "jeikcode::tool",
                session_id = %self.session_id,
                call_id = %record.call_id,
                %error,
                "failed to append tool metric"
            );
        }
    }
}

#[async_trait]
impl LifecycleHooks for SessionTraceHook {
    async fn turn_start(&self, _convo: &mut Conversation) {
        self.shared.touch_activity();
    }

    async fn on_text_delta(&self, _delta: &mut String) {
        self.shared.touch_activity();
    }

    async fn on_reasoning_delta(&self, _delta: &mut String) {
        self.shared.touch_activity();
    }

    async fn on_request(
        &self,
        messages: &[Message],
        tools: &[ToolDef],
        options: &ChatOptions,
        ctx: &TurnCtx,
    ) {
        self.shared
            .current_turn_id
            .store(ctx.turn_id, Ordering::Relaxed);
        self.shared
            .current_round
            .store(ctx.round, Ordering::Relaxed);

        let sys_end = messages
            .iter()
            .position(|m| m.role != Role::System)
            .unwrap_or(messages.len());
        let system_messages = messages[..sys_end].to_vec();
        let non_sys = messages[sys_end..].to_vec();
        let tools = tools.to_vec();
        let options = options.clone();
        let ctx = ctx.clone();
        let shared = Arc::clone(&self.shared);

        let _ = tokio::task::spawn_blocking(move || {
            let Ok((context_hash, encoded_bundle)) =
                compute_context_hash_and_bytes(&system_messages, &tools)
            else {
                return;
            };
            let (provider, model) = shared.current_attribution();

            let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            if !state.seeded {
                let (next_seq, prev_wire_non_sys) =
                    seed_state_from_existing_trace(&shared.mgr, &shared.session_id);
                state.next_seq = next_seq;
                state.prev_wire_non_sys = prev_wire_non_sys;
                state.seeded = true;
            }

            {
                let path_len = shared
                    .mgr
                    .trace_path(&shared.session_id)
                    .ok()
                    .and_then(|p| fs::metadata(p).ok())
                    .map(|m| m.len())
                    .unwrap_or(0);
                if path_len >= MAX_TRACE_FILE_BYTES {
                    if let Ok(path) = shared.mgr.trace_path(&shared.session_id) {
                        let mut old = path.as_os_str().to_owned();
                        old.push(".old");
                        let _ = fs::rename(&path, PathBuf::from(old));
                        state.prev_wire_non_sys.clear();
                    }
                }
            }

            let prefix_keep = common_prefix_len(&state.prev_wire_non_sys, &non_sys);
            let messages_delta = non_sys[prefix_keep..].to_vec();
            let seq = state.next_seq;
            state.next_seq = state.next_seq.saturating_add(1);

            let mut known = std::mem::take(&mut state.known_bundles);
            let mut writes = state.bundle_writes_since_prune;
            shared.ensure_bundle_written(&context_hash, &encoded_bundle, &mut known, &mut writes);
            state.known_bundles = known;
            state.bundle_writes_since_prune = writes;
            let total_non_system_messages = non_sys.len();
            state.prev_wire_non_sys = non_sys;
            drop(state);

            let record = TraceRecord::RoundRequest {
                v: EVAL_TRACE_VERSION,
                seq,
                ts_ms: now_ms().max(0) as u64,
                turn_id: ctx.turn_id,
                round: ctx.round,
                request_id: ctx.request_id,
                cache_epoch: ctx.cache_epoch,
                provider,
                model,
                context_hash,
                options,
                total_non_system_messages,
                prefix_keep,
                messages_delta,
            };
            if shared.append_trace_record(&record) {
                if let Ok(mut s) = shared.state.lock() {
                    s.prev_wire_non_sys.clear();
                }
            }
        })
        .await;
    }

    async fn on_model_response(&self, response: &mut Message) {
        // 切勿在此处重置活动时间戳：工具参数流式输出与模型整轮汇总发生在 `on_text_delta`
        // 之后、工具真正 `before()` 之前；若在此刷新，落盘的 `switch_ms` 会被压成几毫秒，
        // 回合结束后回刷磁盘指标时就会覆盖实时投影到的真实切换延迟。
        let Some(meta) = response.meta.clone() else {
            return;
        };
        let record = TraceRecord::RoundResponse {
            v: EVAL_TRACE_VERSION,
            ts_ms: now_ms().max(0) as u64,
            turn_id: meta.turn_id,
            round: meta.round,
            request_id: meta.request_id,
            ttft_ms: meta.ttft_ms,
            reasoning_elapsed_ms: meta.reasoning_elapsed_ms,
            elapsed_ms: meta.elapsed_ms,
            tokens: meta.tokens,
            used_tokens: meta.used_tokens,
            ctx_window: meta.ctx_window,
            utilization: meta.utilization,
            finish_reason: meta.finish_reason,
            provider_model: meta.provider_model,
            provider_response_id: meta.provider_response_id,
            assistant_message: response.clone(),
        };
        let shared = Arc::clone(&self.shared);
        let _ = tokio::task::spawn_blocking(move || {
            shared.append_trace_record(&record);
        })
        .await;
    }

    async fn pre_compaction(
        &self,
        _convo: &Conversation,
        trigger: &CompactTrigger,
        _ctx: Option<&TurnCtx>,
    ) {
        if let Ok(mut slot) = self.shared.pending_compact_trigger.lock() {
            *slot = Some(trigger.clone());
        }
    }

    async fn post_compaction(
        &self,
        report: &CompactReport,
        notice: &SystemNotice,
        ctx: Option<&TurnCtx>,
    ) {
        let trigger = self
            .shared
            .pending_compact_trigger
            .lock()
            .ok()
            .and_then(|mut s| s.take())
            .unwrap_or(CompactTrigger::Auto { utilization: 0.0 });
        let record = TraceRecord::Compaction {
            v: EVAL_TRACE_VERSION,
            ts_ms: now_ms().max(0) as u64,
            turn_id: ctx.map(|c| c.turn_id),
            round: ctx.map(|c| c.round),
            epoch_before: report.epoch_before,
            epoch_after: report.epoch_after,
            trigger,
            removed: report.removed,
            bytes_before: report.bytes_before,
            bytes_after: report.bytes_after,
            notice_text: notice.text.clone(),
        };
        let shared = Arc::clone(&self.shared);
        let _ = tokio::task::spawn_blocking(move || {
            shared.append_trace_record(&record);
        })
        .await;
    }

    async fn on_system_notice(&self, notice: &SystemNotice, _convo: &Conversation, ctx: &TurnCtx) {
        let record = TraceRecord::SystemNotice {
            v: EVAL_TRACE_VERSION,
            ts_ms: now_ms().max(0) as u64,
            turn_id: ctx.turn_id,
            round: ctx.round,
            request_id: ctx.request_id,
            event_id: notice.event_id.clone(),
            kind: notice.kind.clone(),
            severity: notice.severity,
            status: notice.status,
            revision: notice.revision,
            text: notice.text.clone(),
        };
        let shared = Arc::clone(&self.shared);
        let _ = tokio::task::spawn_blocking(move || {
            shared.append_trace_record(&record);
        })
        .await;
    }

    async fn turn_complete(&self, _convo: &Conversation, reason: &StopReason, ctx: &TurnCtx) {
        // 对任何仍挂在 inflight（例如中断/异常结束尚未经过 after 的调用）兜底记为 Incomplete。
        let pending: Vec<(String, InflightTool)> = self
            .shared
            .inflight_tools
            .lock()
            .map(|mut g| g.drain().collect())
            .unwrap_or_default();
        let now = now_ms().max(0) as u64;
        let mut metrics = Vec::with_capacity(pending.len());
        for (call_id, info) in pending {
            let signals = crate::call_signals::take(&call_id);
            metrics.push(ToolMetricRecord {
                v: TOOL_METRIC_VERSION,
                call_id,
                name: info.name,
                started_at: info.started_at_ms,
                finished_at: Some(now),
                duration_ms: Some(info.started.elapsed().as_millis() as u64),
                switch_ms: info.switch_ms,
                status: ToolMetricStatus::Incomplete,
                approval_wait_ms: (signals.approval_wait_ms > 0)
                    .then_some(signals.approval_wait_ms),
                repaired_args: signals.repaired_args.then_some(true),
                target_hint: info.target_hint,
                result_bytes: signals.raw_result_bytes,
                truncated: signals.truncated.then_some(true),
                turn_id: info.turn_id.or(Some(ctx.turn_id)),
                round: info.round.or(Some(ctx.round)),
            });
        }

        let record = TraceRecord::TurnComplete {
            v: EVAL_TRACE_VERSION,
            ts_ms: now,
            turn_id: ctx.turn_id,
            round: ctx.round,
            stop_reason: stop_reason_slug(*reason).to_string(),
        };
        let shared = Arc::clone(&self.shared);
        let _ = tokio::task::spawn_blocking(move || {
            for metric in &metrics {
                shared.persist_and_log_tool_metric(metric);
            }
            shared.append_trace_record(&record);
        })
        .await;
    }
}

#[async_trait]
impl ToolMiddleware for SessionTraceStartMiddleware {
    async fn before(
        &self,
        call: &mut ToolCall,
        tool: &Arc<dyn Tool>,
        _rt: &RequestCtx,
    ) -> BeforeOutcome {
        let turn_id = Some(self.shared.current_turn_id.load(Ordering::Relaxed)).filter(|v| *v > 0);
        let round = Some(self.shared.current_round.load(Ordering::Relaxed)).filter(|v| *v > 0);
        let started_at_ms = now_ms().max(0) as u64;
        let switch_ms = self.shared.take_switch_ms();
        let target_hint = sanitize_target_hint(tool.name(), &call.arguments);

        if let Ok(mut inflight) = self.shared.inflight_tools.lock() {
            inflight.insert(
                call.id.clone(),
                InflightTool {
                    name: call.name.clone(),
                    started: Instant::now(),
                    started_at_ms,
                    switch_ms,
                    target_hint: target_hint.clone(),
                    turn_id,
                    round,
                },
            );
        }

        let signals_repaired = crate::call_signals::take(&call.id);
        let initial_repaired = signals_repaired.repaired_args;
        // 若前置 `RepairToolArgsMiddleware` 已触发修复，先留痕到状态但暂不清空 `raw_result_bytes`/`approval_wait_ms`：
        // 还原 `mark_repaired` 让 `after` 最终取出完整汇总。
        if initial_repaired {
            crate::call_signals::mark_repaired(&call.id);
        }

        let mut running = ToolMetricRecord::running(&call.id, &call.name, started_at_ms, switch_ms);
        running.repaired_args = initial_repaired.then_some(true);
        running.target_hint = target_hint;
        running.turn_id = turn_id;
        running.round = round;
        let shared = Arc::clone(&self.shared);
        let _ = tokio::task::spawn_blocking(move || {
            let _ = shared.mgr.append_tool_metric(&shared.session_id, &running);
        })
        .await;

        BeforeOutcome::Proceed
    }
}

#[async_trait]
impl ToolMiddleware for SessionTraceEndMiddleware {
    async fn after(&self, result: &mut ToolResult, _tool: Option<&dyn Tool>) -> AfterOutcome {
        let info = self
            .shared
            .inflight_tools
            .lock()
            .ok()
            .and_then(|mut g| g.remove(&result.call_id));
        self.shared.touch_activity();

        let signals = crate::call_signals::take(&result.call_id);
        let finished_at = now_ms().max(0) as u64;
        let Some(info) = info else {
            return AfterOutcome::Proceed;
        };

        let duration_ms = info.started.elapsed().as_millis() as u64;
        let status = if result.is_error {
            ToolMetricStatus::Error
        } else {
            ToolMetricStatus::Done
        };
        let truncated = signals.truncated || contains_truncation_marker(&result.content);
        let raw_bytes = signals.raw_result_bytes.unwrap_or(result.content.len());
        let record = ToolMetricRecord {
            v: TOOL_METRIC_VERSION,
            call_id: result.call_id.clone(),
            name: info.name,
            started_at: info.started_at_ms,
            finished_at: Some(finished_at),
            duration_ms: Some(duration_ms),
            switch_ms: info.switch_ms,
            status,
            approval_wait_ms: (signals.approval_wait_ms > 0).then_some(signals.approval_wait_ms),
            repaired_args: signals.repaired_args.then_some(true),
            target_hint: info.target_hint,
            result_bytes: Some(raw_bytes),
            truncated: truncated.then_some(true),
            turn_id: info.turn_id,
            round: info.round,
        };
        let shared = Arc::clone(&self.shared);
        let _ = tokio::task::spawn_blocking(move || {
            shared.persist_and_log_tool_metric(&record);
        })
        .await;
        AfterOutcome::Proceed
    }
}

/// 读取 `<id>.trace.jsonl` 中的全部有效记录（遇到半截或损坏行自动跳过，绝不阻塞主流程）。
pub fn read_trace_records(
    mgr: &SessionManager,
    session_id: &str,
) -> SessionResult<Vec<TraceRecord>> {
    let path = mgr.trace_path(session_id)?;
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => return Err(SessionStoreError::Io { path, source }),
    };
    let mut out = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(record) = serde_json::from_str::<TraceRecord>(trimmed) {
            out.push(record);
        }
    }
    Ok(out)
}

fn load_context_bundle(bundles_dir: &Path, context_hash: &str) -> SessionResult<ContextBundle> {
    let path = bundle_path(bundles_dir, context_hash)?;
    let bytes = fs::read(&path).map_err(|source| SessionStoreError::Io {
        path: path.clone(),
        source,
    })?;
    serde_json::from_slice::<ContextBundle>(&bytes).map_err(|error| SessionStoreError::Corrupt {
        kind: "eval context bundle",
        message: format!("{}: {error}", path.display()),
    })
}

fn reconstruct_with<F>(
    mgr: &SessionManager,
    bundles_dir: &Path,
    session_id: &str,
    mut matches: F,
) -> SessionResult<ReconstructedUpstreamRequest>
where
    F: FnMut(u64, u64, u32) -> bool,
{
    let records = read_trace_records(mgr, session_id)?;
    let mut non_sys: Vec<Message> = Vec::new();
    for rec in records {
        if let TraceRecord::RoundRequest {
            seq,
            turn_id,
            round,
            request_id,
            cache_epoch,
            provider,
            model,
            context_hash,
            options,
            prefix_keep,
            messages_delta,
            ..
        } = rec
        {
            let keep = prefix_keep.min(non_sys.len());
            non_sys.truncate(keep);
            non_sys.extend(messages_delta);

            if matches(seq, turn_id, round) {
                let bundle = load_context_bundle(bundles_dir, &context_hash)?;
                let mut messages = bundle.system_messages;
                messages.extend(non_sys);
                return Ok(ReconstructedUpstreamRequest {
                    seq,
                    turn_id,
                    round,
                    request_id,
                    cache_epoch,
                    provider,
                    model,
                    context_hash,
                    options,
                    messages,
                    tools: bundle.tools,
                });
            }
        }
    }
    Err(SessionStoreError::NotFound {
        path: mgr.trace_path(session_id)?,
    })
}

/// 按全局请求序号 `round_or_seq`（单 Turn 时与轮次号 `round` 一致）无损还原上游发包全量上下文。
pub fn reconstruct_upstream_request(
    mgr: &SessionManager,
    session_id: &str,
    round_or_seq: u64,
) -> SessionResult<ReconstructedUpstreamRequest> {
    let bundles_dir = default_bundles_dir_for(mgr);
    reconstruct_with(mgr, &bundles_dir, session_id, |seq, _, _| {
        seq == round_or_seq
    })
}

/// 按 `(turn_id, round)` 精确还原多 Turn 会话中某一轮的上游发包全量上下文。
pub fn reconstruct_turn_round_upstream_request(
    mgr: &SessionManager,
    session_id: &str,
    turn_id: u64,
    round: u32,
) -> SessionResult<ReconstructedUpstreamRequest> {
    let bundles_dir = default_bundles_dir_for(mgr);
    reconstruct_with(mgr, &bundles_dir, session_id, |_, tid, r| {
        tid == turn_id && r == round
    })
}

fn summarize_latencies(values: &[u64]) -> LatencyStats {
    if values.is_empty() {
        return LatencyStats::default();
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let count = sorted.len();
    let p50_ms = sorted[((count - 1) * 50) / 100];
    let p95_ms = sorted[((count - 1) * 95) / 100];
    let max_ms = *sorted.last().unwrap_or(&0);
    let total_ms = sorted.iter().copied().fold(0u64, u64::saturating_add);
    LatencyStats {
        count,
        p50_ms,
        p95_ms,
        max_ms,
        total_ms,
    }
}

fn notice_kind_slug(kind: &NoticeKind) -> &'static str {
    match kind {
        NoticeKind::Retry => "retry",
        NoticeKind::Timeout => "timeout",
        NoticeKind::RateLimit => "rate_limit",
        NoticeKind::Compaction => "compaction",
        NoticeKind::Truncation => "truncation",
        NoticeKind::Command => "command",
        NoticeKind::Error => "error",
        NoticeKind::Warning => "warning",
    }
}

/// 聚合单会话 `.meta.json`、`.trace.jsonl`、`.toolmetrics.jsonl` 与子 Agent 级联关系生成量化评测报告。
pub fn evaluate_session_metrics(
    mgr: &SessionManager,
    session_id: &str,
) -> SessionResult<SessionEvalReport> {
    let meta = match mgr.read_meta(session_id) {
        Ok(m) => Some(m),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let mut child_session_ids: Vec<String> = mgr
        .list()
        .into_iter()
        .filter(|entry| entry.parent_session_id.as_deref() == Some(session_id))
        .map(|entry| entry.id)
        .collect();
    child_session_ids.sort();

    let records = read_trace_records(mgr, session_id)?;
    let tool_events = mgr.read_tool_metrics_events(session_id)?;
    let mut latest_tools: HashMap<String, ToolMetricRecord> = HashMap::new();
    let mut ordered_call_ids: Vec<String> = Vec::new();
    for ev in &tool_events {
        if !latest_tools.contains_key(&ev.call_id) {
            ordered_call_ids.push(ev.call_id.clone());
        }
        latest_tools.insert(ev.call_id.clone(), ev.clone());
    }

    let mut report = SessionEvalReport {
        session_id: session_id.to_string(),
        parent_session_id: meta.as_ref().and_then(|m| m.parent_session_id.clone()),
        parent_call_id: meta.as_ref().and_then(|m| m.parent_call_id.clone()),
        child_session_ids,
        ..Default::default()
    };

    let mut ttfts = Vec::new();
    let mut reasonings = Vec::new();
    let mut round_elapseds = Vec::new();
    let mut loop_turn_ids = HashSet::new();
    let mut soft_landing_count = 0usize;
    let mut retry_notice_count = 0usize;
    let mut error_notice_count = 0usize;
    let mut rate_limit_notice_count = 0usize;

    for rec in &records {
        match rec {
            TraceRecord::RoundRequest { .. } => {}
            TraceRecord::RoundResponse {
                ttft_ms,
                reasoning_elapsed_ms,
                elapsed_ms,
                tokens,
                ..
            } => {
                report.round_count += 1;
                report.total_prompt_tokens = report
                    .total_prompt_tokens
                    .saturating_add(u64::from(tokens.prompt));
                report.total_cached_tokens = report
                    .total_cached_tokens
                    .saturating_add(u64::from(tokens.cached));
                report.total_completion_tokens = report
                    .total_completion_tokens
                    .saturating_add(u64::from(tokens.completion));
                if let Some(t) = ttft_ms {
                    ttfts.push(*t);
                }
                if *reasoning_elapsed_ms > 0 {
                    reasonings.push(*reasoning_elapsed_ms);
                }
                round_elapseds.push(*elapsed_ms);
            }
            TraceRecord::Compaction { trigger, .. } => {
                report.compaction_count += 1;
                if matches!(trigger, CompactTrigger::Overflow { .. }) {
                    report.overflow_compaction_count += 1;
                }
            }
            TraceRecord::SystemNotice {
                kind,
                status,
                event_id,
                ..
            } => {
                if *status == NoticeStatus::Settled
                    || matches!(kind, NoticeKind::Retry | NoticeKind::RateLimit)
                {
                    *report
                        .notice_counts_by_kind
                        .entry(notice_kind_slug(kind).to_string())
                        .or_insert(0) += 1;
                }
                if event_id.starts_with("warn-max-rounds:") {
                    soft_landing_count += 1;
                }
                match kind {
                    NoticeKind::Retry => retry_notice_count += 1,
                    NoticeKind::Error if *status == NoticeStatus::Settled => {
                        error_notice_count += 1
                    }
                    NoticeKind::RateLimit => rate_limit_notice_count += 1,
                    _ => {}
                }
            }
            TraceRecord::TurnComplete {
                turn_id,
                stop_reason,
                ..
            } => {
                report.turn_count += 1;
                *report.stop_reasons.entry(stop_reason.clone()).or_insert(0) += 1;
                if matches!(stop_reason.as_str(), "repeat_loop" | "tool_loop_detected") {
                    loop_turn_ids.insert(*turn_id);
                }
            }
        }
    }

    if report.turn_count == 0 {
        if let Some(m) = &meta {
            report.turn_count = m.turn_stats.len();
            for ts in &m.turn_stats {
                if let Some(sr) = &ts.stop_reason {
                    *report.stop_reasons.entry(sr.clone()).or_insert(0) += 1;
                    if matches!(sr.as_str(), "repeat_loop" | "tool_loop_detected") {
                        loop_turn_ids.insert(ts.turn_id);
                    }
                }
            }
        }
    }

    report.kv_cache_hit_rate = if report.total_prompt_tokens > 0 {
        report.total_cached_tokens as f64 / report.total_prompt_tokens as f64
    } else {
        0.0
    };
    report.ttft_ms = summarize_latencies(&ttfts);
    report.reasoning_ms = summarize_latencies(&reasonings);
    report.round_elapsed_ms = summarize_latencies(&round_elapseds);

    let mut exec_durations = Vec::new();
    let mut approval_waits = Vec::new();
    let mut switches = Vec::new();
    let mut wasted_calls = 0usize;
    let mut prev_sig: Option<(String, Option<String>)> = None;

    for call_id in &ordered_call_ids {
        let Some(rec) = latest_tools.get(call_id) else {
            continue;
        };
        report.tool_calls_total += 1;
        switches.push(rec.switch_ms);

        let wait = rec.approval_wait_ms.unwrap_or(0);
        if wait > 0 {
            approval_waits.push(wait);
        }
        if let Some(dur) = rec.duration_ms {
            // 将真实工具执行耗时与等待用户点击审批的挂起时间拆开统计。
            exec_durations.push(dur.saturating_sub(wait));
        }
        if rec.repaired_args == Some(true) {
            report.repaired_args_count += 1;
        }
        if rec.truncated == Some(true) {
            report.truncated_results_count += 1;
        }
        let is_err_or_inc = match rec.status {
            ToolMetricStatus::Error => {
                report.tool_calls_error += 1;
                true
            }
            ToolMetricStatus::Incomplete => {
                report.tool_calls_incomplete += 1;
                true
            }
            _ => false,
        };
        let sig = (rec.name.clone(), rec.target_hint.clone());
        let repeated_neighbor = sig.1.is_some() && prev_sig.as_ref() == Some(&sig);
        let in_loop_turn = rec.turn_id.is_some_and(|tid| loop_turn_ids.contains(&tid));
        if is_err_or_inc || repeated_neighbor || in_loop_turn {
            wasted_calls += 1;
        }
        prev_sig = Some(sig);
    }

    report.tool_exec_ms = summarize_latencies(&exec_durations);
    report.approval_wait_ms = summarize_latencies(&approval_waits);
    report.tool_switch_ms = summarize_latencies(&switches);
    report.wasted_tool_ratio = if report.tool_calls_total > 0 {
        wasted_calls as f64 / report.tool_calls_total as f64
    } else {
        0.0
    };

    let loop_stops = report.stop_reasons.get("repeat_loop").copied().unwrap_or(0)
        + report
            .stop_reasons
            .get("tool_loop_detected")
            .copied()
            .unwrap_or(0);
    let timeout_stops = report.stop_reasons.get("timeout").copied().unwrap_or(0);
    let error_stops = report
        .stop_reasons
        .get("provider_error")
        .copied()
        .unwrap_or(0);

    report.friction_score = (report.tool_calls_error as f64) * 1.5
        + (report.tool_calls_incomplete as f64) * 1.0
        + (report.repaired_args_count as f64) * 0.5
        + (report.truncated_results_count as f64) * 0.5
        + (report.overflow_compaction_count as f64) * 3.0
        + (loop_stops as f64) * 5.0
        + (soft_landing_count as f64) * 2.0
        + (timeout_stops as f64) * 4.0
        + (error_stops as f64) * 3.0
        + (retry_notice_count as f64) * 0.75
        + (error_notice_count as f64) * 1.0
        + (rate_limit_notice_count as f64) * 1.0;

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::SessionMeta;
    use jeikcode_kernel::message::{Message, MessageMeta};
    use jeikcode_kernel::provider::ToolChoice;
    use jeikcode_kernel::tool::ToolCall;

    fn hook_with_tempdir(id: &str) -> (SessionTraceHook, Arc<SessionManager>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let mgr = Arc::new(SessionManager::with_root(dir.path()));
        mgr.write_meta(&SessionMeta::new(id, "/workspace", 1_000))
            .unwrap();
        let hook = SessionTraceHook::new(mgr.clone(), id, "openai", "gpt-test")
            .with_bundles_dir(dir.path().join("bundles"));
        (hook, mgr, dir)
    }

    fn dummy_tool_defs() -> Vec<ToolDef> {
        vec![ToolDef {
            name: "read".into(),
            description: "Read file".into(),
            parameters: serde_json::json!({"type": "object", "properties": {"file_path": {"type": "string"}}}),
        }]
    }

    #[tokio::test]
    async fn deduplicates_context_bundles_and_reconstructs_exact_upstream_requests() {
        let (hook, mgr, dir) = hook_with_tempdir("s-eval");
        let tools = dummy_tool_defs();
        let opts = ChatOptions {
            max_tokens: Some(4096),
            tool_choice: ToolChoice::Auto,
            ..Default::default()
        };

        // 第 1 轮：sys + U1
        let sys = Message::system("You are a helpful coding assistant.");
        let u1 = Message::user("Read src/lib.rs");
        let r1_msgs = vec![sys.clone(), u1.clone()];
        let ctx1 = TurnCtx {
            session_id: Some(Arc::from("s-eval")),
            turn_id: 1,
            round: 1,
            request_id: 1,
            max_rounds: None,
            cache_epoch: 0,
            ..Default::default()
        };
        hook.on_request(&r1_msgs, &tools, &opts, &ctx1).await;

        let a1 = Message::assistant(
            "",
            vec![ToolCall {
                id: "call-1".into(),
                name: "read".into(),
                arguments: r#"{"file_path":"src/lib.rs"}"#.into(),
            }],
        );
        let t1 = Message::tool_result("call-1", "pub fn hi() {}", false);

        // 第 2 轮：相同 system + tools，非系统消息追加 [A1, T1, ephemeral_reminder]
        let reminder = Message::synthetic_user("<system-reminder>stay focused</system-reminder>");
        let r2_msgs = vec![
            sys.clone(),
            u1.clone(),
            a1.clone(),
            t1.clone(),
            reminder.clone(),
        ];
        let ctx2 = TurnCtx {
            turn_id: 1,
            round: 2,
            request_id: 2,
            ..ctx1.clone()
        };
        hook.on_request(&r2_msgs, &tools, &opts, &ctx2).await;

        // bundles 目录内应只写出 1 个 SHA-256 去重上下文包
        let bundles: Vec<_> = fs::read_dir(dir.path().join("bundles"))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(bundles.len(), 1);

        // Trace 第 2 轮应命中 prefix_keep = 1，仅记录新增 3 条 delta
        let trace = read_trace_records(&mgr, "s-eval").unwrap();
        assert_eq!(trace.len(), 2);
        match &trace[1] {
            TraceRecord::RoundRequest {
                prefix_keep,
                messages_delta,
                ..
            } => {
                assert_eq!(*prefix_keep, 1);
                assert_eq!(messages_delta.len(), 3);
            }
            other => panic!("unexpected record: {other:?}"),
        }

        // 重放器使用定制 bundles_dir 时可直接验证完整请求还原字节一致性
        let reconstructed_1 =
            reconstruct_with(&mgr, &dir.path().join("bundles"), "s-eval", |seq, _, _| {
                seq == 1
            })
            .unwrap();
        assert_eq!(reconstructed_1.messages, r1_msgs);
        assert_eq!(reconstructed_1.tools, tools);

        let reconstructed_2 =
            reconstruct_with(&mgr, &dir.path().join("bundles"), "s-eval", |seq, _, _| {
                seq == 2
            })
            .unwrap();
        assert_eq!(reconstructed_2.messages, r2_msgs);
        assert_eq!(reconstructed_2.options, opts);
    }

    #[tokio::test]
    async fn compaction_resets_delta_baseline_and_preserves_reconstruction() {
        let (hook, mgr, dir) = hook_with_tempdir("s-compact");
        let tools = dummy_tool_defs();
        let opts = ChatOptions::default();
        let sys = Message::system("sys");
        let ctx = TurnCtx {
            session_id: Some(Arc::from("s-compact")),
            turn_id: 1,
            round: 1,
            request_id: 1,
            ..Default::default()
        };
        let r1 = vec![sys.clone(), Message::user("u1"), Message::user("u2")];
        hook.on_request(&r1, &tools, &opts, &ctx).await;

        let convo = Conversation::new();
        hook.pre_compaction(&convo, &CompactTrigger::Overflow { attempt: 1 }, Some(&ctx))
            .await;
        let report = CompactReport {
            epoch_before: 0,
            epoch_after: 1,
            removed: 2,
            bytes_before: 4000,
            bytes_after: 800,
            committed: true,
        };
        let notice = SystemNotice {
            part_id: "compact:epoch:1:1:notice".into(),
            event_id: "compact:epoch:1".into(),
            kind: NoticeKind::Compaction,
            severity: NoticeSeverity::Info,
            status: NoticeStatus::Settled,
            revision: 1,
            text: "Compacted".into(),
            anchor_message_id: None,
            anchor_part_id: None,
            turn_id: Some(1),
            persist: true,
        };
        hook.post_compaction(&report, &notice, Some(&ctx)).await;

        let summary_anchor = Message::synthetic_user("Compacted summary");
        let r2 = vec![sys, summary_anchor];
        hook.on_request(
            &r2,
            &tools,
            &opts,
            &TurnCtx {
                round: 2,
                request_id: 2,
                ..ctx
            },
        )
        .await;

        let req2 = reconstruct_with(
            &mgr,
            &dir.path().join("bundles"),
            "s-compact",
            |seq, _, _| seq == 2,
        )
        .unwrap();
        assert_eq!(req2.messages, r2);
        let eval = evaluate_session_metrics(&mgr, "s-compact").unwrap();
        assert_eq!(eval.compaction_count, 1);
        assert_eq!(eval.overflow_compaction_count, 1);
    }

    #[tokio::test]
    async fn evaluates_session_metrics_tool_signals_and_parent_child_linkage() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = Arc::new(SessionManager::with_root(dir.path()));
        mgr.write_meta(&SessionMeta::new("parent-s", "/workspace", 1_000))
            .unwrap();
        let mut child_meta = SessionMeta::new("sub-c1-1", "/workspace", 1_100);
        child_meta.parent_session_id = Some("parent-s".into());
        child_meta.parent_call_id = Some("c1".into());
        mgr.write_meta(&child_meta).unwrap();

        let hook = SessionTraceHook::new(mgr.clone(), "parent-s", "openai", "gpt-test")
            .with_bundles_dir(dir.path().join("bundles"));

        let mut resp1 = Message::assistant("thinking", vec![]);
        resp1.meta = Some(MessageMeta {
            turn_id: 1,
            round: 1,
            request_id: 1,
            ttft_ms: Some(120),
            reasoning_elapsed_ms: 400,
            elapsed_ms: 900,
            tokens: TokenUsage {
                prompt: 1000,
                completion: 100,
                cached: 750,
            },
            finish_reason: "tool_calls".into(),
            ..Default::default()
        });
        hook.on_model_response(&mut resp1).await;

        // 模拟两轮同目标重复工具调用：第一次含参数修复+审批等待+产物截断，第二次返回错误。
        let mut rec1 = ToolMetricRecord::running("c1", "run_command", 1_000, 50);
        rec1.approval_wait_ms = Some(500);
        rec1.repaired_args = Some(true);
        rec1.target_hint = Some("cargo test".into());
        rec1.result_bytes = Some(128_000);
        rec1.truncated = Some(true);
        rec1.turn_id = Some(1);
        rec1.round = Some(1);
        mgr.append_tool_metric(
            "parent-s",
            &rec1.finished(ToolMetricStatus::Done, 1_650, 650),
        )
        .unwrap();

        let mut rec2 = ToolMetricRecord::running("c2", "run_command", 1_700, 50);
        rec2.target_hint = Some("cargo test".into());
        rec2.turn_id = Some(1);
        rec2.round = Some(2);
        mgr.append_tool_metric(
            "parent-s",
            &rec2.finished(ToolMetricStatus::Error, 1_900, 200),
        )
        .unwrap();

        hook.turn_complete(
            &Conversation::new(),
            &StopReason::Stopped,
            &TurnCtx {
                session_id: Some(Arc::from("parent-s")),
                turn_id: 1,
                round: 2,
                request_id: 2,
                ..Default::default()
            },
        )
        .await;

        let report = evaluate_session_metrics(&mgr, "parent-s").unwrap();
        assert_eq!(report.child_session_ids, vec!["sub-c1-1".to_string()]);
        assert_eq!(report.round_count, 1);
        assert!((report.kv_cache_hit_rate - 0.75).abs() < 1e-6);
        assert_eq!(report.ttft_ms.p50_ms, 120);
        assert_eq!(report.tool_calls_total, 2);
        assert_eq!(report.tool_calls_error, 1);
        assert_eq!(report.repaired_args_count, 1);
        assert_eq!(report.truncated_results_count, 1);
        // 第一个调用执行耗时 = 650 - 500 = 150ms；第二个 200ms；sorted = [150, 200] -> max = 200
        assert_eq!(report.tool_exec_ms.max_ms, 200);
        assert_eq!(report.approval_wait_ms.total_ms, 500);
        // 第二个调用既相邻重复又出错，wasted = 1 / 2 = 0.5
        assert!((report.wasted_tool_ratio - 0.5).abs() < 1e-6);
        assert!(report.friction_score > 0.0);
    }

    #[test]
    fn prunes_old_bundles_when_exceeding_count_or_bytes_cap() {
        let dir = tempfile::tempdir().unwrap();
        let bundles = dir.path().join("bundles");
        fs::create_dir_all(&bundles).unwrap();
        for i in 0..5 {
            let p = bundles.join(format!("{i:016x}.json"));
            fs::write(&p, vec![b'a'; 100]).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        prune_eval_storage(&bundles, None, 2, 1024 * 1024, 3600);
        let remaining: Vec<_> = fs::read_dir(&bundles)
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(remaining.len(), 2);
    }

    #[tokio::test]
    async fn model_response_does_not_reset_tool_switch_latency() {
        let (hook, _mgr, _dir) = hook_with_tempdir("s-switch");
        let mut convo = Conversation::new();
        hook.turn_start(&mut convo).await;
        let mut delta = "准备调用工具".to_string();
        hook.on_text_delta(&mut delta).await;

        tokio::time::sleep(std::time::Duration::from_millis(35)).await;

        let mut resp = Message::assistant("准备调用工具", vec![]);
        hook.on_model_response(&mut resp).await;

        let switch_ms = hook.shared.take_switch_ms();
        assert!(
            switch_ms >= 25,
            "on_model_response 不得覆写上一段活动时间戳导致 switch_ms 塌缩（实际={switch_ms}ms）"
        );
    }
}
