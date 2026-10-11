//! Per-session runtime registry (OpenCode-style session model).
//!
//! One live [`SessionRuntimeEntry`] per [`SessionKey`]. Driver/UI layers hold a
//! **ViewBinding** (`selected: Option<SessionKey>`) and route submit/cancel by
//! key — they never reconfigure another session's handle to "switch views".
//! See `docs/plans/2026-08-27-multi-session-runtime-and-agent-efficiency-design.md`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use std::sync::RwLock;
use tokio::sync::broadcast;

use crate::runtime::{CodingRuntimeHandle, DriverCommand, RuntimeUnavailable, UserInput};
use jeikcode_kernel::event::RequestId;
use jeikcode_kernel::message::SessionSnapshot;

/// Stable session identifier (UUID string).
pub type SessionKey = String;

/// Soft cap on concurrent live runners in one process (not "background slots").
pub const MAX_LIVE_SESSIONS: usize = 32;

/// Neutral runtime activity — Driver layers project UI labels from this.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeActivity {
    Starting,
    Ready,
    Running,
    WaitingApproval,
    WaitingUserInput,
    Reconfiguring,
    Stopping,
    Stopped,
    Failed,
}

impl RuntimeActivity {
    pub fn is_busy(self) -> bool {
        matches!(
            self,
            Self::Running
                | Self::WaitingApproval
                | Self::WaitingUserInput
                | Self::Starting
                | Self::Reconfiguring
        )
    }

    pub fn is_idle_releasable(self) -> bool {
        matches!(self, Self::Stopped | Self::Failed | Self::Ready)
    }

    /// A bound runner is mid-turn. `Starting` is only "row exists" (view
    /// subscribe / deferred spawn) and must not spin WebUI `/chat/active`.
    pub fn is_live_turn(self) -> bool {
        matches!(
            self,
            Self::Running | Self::WaitingApproval | Self::WaitingUserInput
        )
    }
}

/// Outcome of [`SessionRuntimeRegistry::open_or_attach`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenOutcome {
    /// Registry already held a live entry for this session; caller should attach.
    Attached,
    /// A new entry was registered for this session.
    Registered,
}

/// Sequenced observation for one session (driver projects to UI).
/// OpenCode fan-out: every client view subscribes here for realtime TextDelta etc.
#[derive(Debug, Clone)]
pub struct SequencedSessionEvent {
    pub session_id: SessionKey,
    /// Concrete runtime owner that emitted this observation. Unlike the runtime
    /// generation, this changes when a session is rebound to a replacement
    /// runtime, even if that replacement restarts its generation counter.
    pub runtime_instance_id: Option<String>,
    pub generation: u64,
    pub sequence: u64,
    pub activity: RuntimeActivity,
    /// Full runtime observation when this is a stream event; `None` for pure
    /// activity / lifecycle markers (e.g. bind_handle → Ready).
    pub runtime: Option<crate::runtime::CodingRuntimeEvent>,
    /// View-layer coordination (user echo, steered ack, request resolved, slash output).
    pub view: Option<SessionViewEvent>,
    /// Stamped at publication, so replay never depends on an evicted boundary.
    pub assistant_part: Option<AssistantPartStamp>,
    /// Set on the first replay entry when the requested history was evicted.
    pub replay_gap: bool,
}

/// One current native assistant part, retained independently of the bounded journal.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AssistantReplayPart {
    #[serde(flatten)]
    pub stamp: AssistantPartStamp,
    pub kind: AssistantPartKind,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct ActiveReplayTool {
    pub call: jeikcode_kernel::tool::ToolCall,
    pub started_at: std::time::Instant,
}

/// A snapshot and subscription captured under the same publication lock.
pub struct SessionReplayJoin {
    pub snapshot: Option<SessionSnapshot>,
    pub through_sequence: Option<u64>,
    pub assistant_parts: Vec<AssistantReplayPart>,
    pub active_tools: Vec<ActiveReplayTool>,
    pub replay: Vec<SequencedSessionEvent>,
    pub events: broadcast::Receiver<SequencedSessionEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct AssistantPartStamp {
    pub message_id: String,
    pub part_id: String,
    pub part_seq: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AssistantPartKind {
    Text,
    Reasoning,
}

impl AssistantPartKind {
    fn label(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Reasoning => "reasoning",
        }
    }
}

/// Driver/UI fan-out events that are not `CodingRuntimeEvent`s but must reach
/// every subscribed view of a session (parity with LiveHub `LiveViewEvent`).
#[derive(Debug, Clone)]
pub enum SessionViewEvent {
    /// An already projected delta (for example the owned `/chat` transport).
    AssistantDelta {
        content: String,
        kind: AssistantPartKind,
        stamp: Option<AssistantPartStamp>,
    },
    InputAccepted {
        input: UserInput,
        client_input_id: Option<String>,
        message_id: Option<String>,
    },
    Steered {
        count: usize,
        inputs: Vec<jeikcode_kernel::event::SteeredInput>,
        client_input_ids: Vec<Option<String>>,
    },
    CommandOutput(String),
    RequestResolved {
        request_id: RequestId,
        kind: String,
    },
}

/// Ring buffer for multi-view replay (TextDelta-heavy turns need headroom).
const JOURNAL_CAP: usize = 2048;
const BROADCAST_CAP: usize = 512;

/// In-memory record for one session's live runner.
#[derive(Debug, Clone)]
pub struct SessionRuntimeEntry {
    pub session_id: SessionKey,
    pub working_dir: PathBuf,
    pub activity: RuntimeActivity,
    pub generation: u64,
    /// Concrete runtime owner currently bound to this session.
    pub runtime_instance_id: Option<String>,
    /// Last known conversation snapshot (optional; filled by drivers).
    pub snapshot: Option<SessionSnapshot>,
    /// Transport id used by TUI event fan-in (optional).
    pub runtime_id: Option<u64>,
    /// Monotonic count of terminal outcomes (`completed` / `stopped` / `failed`).
    /// Observers notify once per increase so a late joiner does not replay history.
    pub terminal_seq: u64,
    /// Latest terminal label. `None` until the first turn ends.
    pub last_terminal: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingRuntimeRequest {
    runtime_instance_id: Option<String>,
    generation: u64,
    request_id: RequestId,
    kind: String,
}

struct LiveInner {
    meta: SessionRuntimeEntry,
    handle: Option<CodingRuntimeHandle>,
    journal: VecDeque<SequencedSessionEvent>,
    next_sequence: u64,
    event_tx: broadcast::Sender<SequencedSessionEvent>,
    pending_request: Option<PendingRuntimeRequest>,
    /// Recent agent-observation fingerprints. An observer echoing the journal
    /// back (A,B,A,B…) is dropped before it can peg a core.
    recent_runtime_keys: VecDeque<String>,
    current_assistant: Option<String>,
    part_seq: u32,
    part_kind: Option<AssistantPartKind>,
    evicted_through: Option<u64>,
    assistant_parts: Vec<AssistantReplayPart>,
    active_tools: HashMap<String, ActiveReplayTool>,
}

impl std::fmt::Debug for LiveInner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveInner")
            .field("meta", &self.meta)
            .field("has_handle", &self.handle.is_some())
            .field("journal_len", &self.journal.len())
            .field("next_sequence", &self.next_sequence)
            .field("pending_request", &self.pending_request)
            .finish()
    }
}

impl LiveInner {
    fn new(session_id: SessionKey, working_dir: PathBuf) -> Self {
        let (event_tx, _) = broadcast::channel(BROADCAST_CAP);
        Self {
            meta: SessionRuntimeEntry {
                session_id,
                working_dir,
                activity: RuntimeActivity::Starting,
                generation: 1,
                runtime_instance_id: None,
                snapshot: None,
                runtime_id: None,
                terminal_seq: 0,
                last_terminal: None,
            },
            handle: None,
            journal: VecDeque::new(),
            next_sequence: 0,
            event_tx,
            pending_request: None,
            recent_runtime_keys: VecDeque::new(),
            current_assistant: None,
            part_seq: 0,
            part_kind: None,
            evicted_through: None,
            assistant_parts: Vec::new(),
            active_tools: HashMap::new(),
        }
    }

    fn push_activity(&mut self, activity: RuntimeActivity) -> SequencedSessionEvent {
        self.push(
            activity,
            self.meta.runtime_instance_id.clone(),
            self.meta.generation,
            None,
            None,
        )
    }

    fn push_runtime(
        &mut self,
        generation: u64,
        event: crate::runtime::CodingRuntimeEvent,
    ) -> SequencedSessionEvent {
        if generation > 0 {
            self.meta.generation = generation;
        }
        let activity = activity_from_runtime_event(&event, self.meta.activity);
        self.push(activity, None, self.meta.generation, Some(event), None)
    }

    fn push_runtime_for_instance(
        &mut self,
        runtime_instance_id: &str,
        generation: u64,
        event: crate::runtime::CodingRuntimeEvent,
    ) -> SequencedSessionEvent {
        self.meta.generation = generation;
        let activity = activity_from_runtime_event(&event, self.meta.activity);
        self.push(
            activity,
            Some(runtime_instance_id.to_string()),
            generation,
            Some(event),
            None,
        )
    }

    fn push_view(&mut self, view: SessionViewEvent) -> SequencedSessionEvent {
        let activity = match &view {
            SessionViewEvent::InputAccepted { .. } | SessionViewEvent::Steered { .. }
            | SessionViewEvent::AssistantDelta { .. } => {
                RuntimeActivity::Running
            }
            SessionViewEvent::RequestResolved { .. } => RuntimeActivity::Running,
            SessionViewEvent::CommandOutput(_) => self.meta.activity,
        };
        self.push(
            activity,
            self.meta.runtime_instance_id.clone(),
            self.meta.generation,
            None,
            Some(view),
        )
    }

    fn push_view_for_instance(
        &mut self,
        runtime_instance_id: &str,
        generation: u64,
        view: SessionViewEvent,
    ) -> SequencedSessionEvent {
        let activity = match &view {
            SessionViewEvent::InputAccepted { .. } | SessionViewEvent::Steered { .. }
            | SessionViewEvent::AssistantDelta { .. } => {
                RuntimeActivity::Running
            }
            SessionViewEvent::RequestResolved { .. } => RuntimeActivity::Running,
            SessionViewEvent::CommandOutput(_) => self.meta.activity,
        };
        self.push(
            activity,
            Some(runtime_instance_id.to_string()),
            generation,
            None,
            Some(view),
        )
    }

    fn push(
        &mut self,
        activity: RuntimeActivity,
        runtime_instance_id: Option<String>,
        generation: u64,
        runtime: Option<crate::runtime::CodingRuntimeEvent>,
        view: Option<SessionViewEvent>,
    ) -> SequencedSessionEvent {
        use crate::runtime::CodingRuntimeEvent;
        use jeikcode_kernel::event::AgentEvent;
        let assistant_part = match (runtime.as_ref(), view.as_ref()) {
            (_, Some(SessionViewEvent::AssistantDelta { stamp, kind, .. })) => {
                if let Some(stamp) = stamp {
                    self.current_assistant = Some(stamp.message_id.clone());
                    self.part_seq = stamp.part_seq;
                    self.part_kind = Some(*kind);
                }
                stamp.clone()
            }
            (Some(CodingRuntimeEvent::Agent(AgentEvent::AssistantMessage { message_id })), _) => {
                self.current_assistant = Some(message_id.clone());
                self.part_seq = 0;
                self.part_kind = None;
                self.assistant_parts.clear();
                None
            }
            (Some(CodingRuntimeEvent::Agent(AgentEvent::TextDelta(_))), _) => {
                self.stamp_part(AssistantPartKind::Text)
            }
            (Some(CodingRuntimeEvent::Agent(AgentEvent::Reasoning(_))), _) => {
                self.stamp_part(AssistantPartKind::Reasoning)
            }
            (Some(event), _) if terminal_label(event).is_some() => {
                self.current_assistant = None;
                self.part_seq = 0;
                self.part_kind = None;
                self.assistant_parts.clear();
                self.active_tools.clear();
                None
            }
            _ => None,
        };
        if let Some(CodingRuntimeEvent::Agent(AgentEvent::Snapshot { snapshot })) = runtime.as_ref() {
            self.meta.snapshot = Some(snapshot.clone());
            if self.current_assistant.as_ref().is_some_and(|id| {
                !snapshot.messages.iter().any(|message| message.id.as_ref() == Some(id))
            }) {
                self.current_assistant = None;
                self.part_seq = 0;
                self.part_kind = None;
                self.assistant_parts.clear();
            }
        }
        let delta = match (runtime.as_ref(), view.as_ref()) {
            (_, Some(SessionViewEvent::AssistantDelta { content, kind, .. })) => Some((content, *kind)),
            (Some(CodingRuntimeEvent::Agent(AgentEvent::TextDelta(content))), _) => Some((content, AssistantPartKind::Text)),
            (Some(CodingRuntimeEvent::Agent(AgentEvent::Reasoning(content))), _) => Some((content, AssistantPartKind::Reasoning)),
            _ => None,
        };
        if let (Some(stamp), Some((content, kind))) = (assistant_part.as_ref(), delta) {
            if let Some(part) = self.assistant_parts.last_mut().filter(|part| part.stamp == *stamp) {
                part.content.push_str(content);
            } else {
                self.assistant_parts.push(AssistantReplayPart { stamp: stamp.clone(), kind, content: content.clone() });
            }
        }
        match runtime.as_ref() {
            Some(CodingRuntimeEvent::Agent(AgentEvent::ToolStarted { call })) => {
                self.active_tools.entry(call.id.clone()).or_insert_with(|| ActiveReplayTool {
                    call: call.clone(), started_at: std::time::Instant::now(),
                });
            }
            Some(CodingRuntimeEvent::Agent(AgentEvent::ToolResult { result })) => {
                self.active_tools.remove(&result.call_id);
            }
            _ => {}
        }
        if let Some(event) = runtime.as_ref() {
            if let Some(label) = terminal_label(event) {
                self.meta.terminal_seq = self.meta.terminal_seq.wrapping_add(1);
                self.meta.last_terminal = Some(label.to_string());
            }
        }
        self.meta.activity = activity;
        let seq = self.next_sequence;
        self.next_sequence = self.next_sequence.wrapping_add(1);
        let event = SequencedSessionEvent {
            session_id: self.meta.session_id.clone(),
            runtime_instance_id,
            generation,
            sequence: seq,
            activity,
            runtime,
            view,
            assistant_part,
            replay_gap: false,
        };
        if self.journal.len() >= JOURNAL_CAP {
            self.evicted_through = self.journal.pop_front().map(|event| event.sequence);
        }
        self.journal.push_back(event.clone());
        let _ = self.event_tx.send(event.clone());
        event
    }

    fn stamp_part(&mut self, kind: AssistantPartKind) -> Option<AssistantPartStamp> {
        let message_id = self.current_assistant.as_ref()?;
        if self.part_kind != Some(kind) {
            self.part_seq += 1;
            self.part_kind = Some(kind);
        }
        Some(AssistantPartStamp {
            message_id: message_id.clone(),
            part_id: format!("{message_id}:{}:{}", self.part_seq, kind.label()),
            part_seq: self.part_seq,
        })
    }

    fn replay(&self, after_sequence: Option<u64>) -> Vec<SequencedSessionEvent> {
        let mut replay: Vec<_> = self.journal.iter()
            .filter(|event| after_sequence.is_none_or(|after| event.sequence > after))
            .cloned().collect();
        if self.evicted_through.is_some_and(|evicted| after_sequence.is_none_or(|after| after < evicted)) {
            if let Some(first) = replay.first_mut() { first.replay_gap = true; }
        }
        replay
    }

    fn replay_snapshot(&self) -> Option<SessionSnapshot> {
        let mut snapshot = self.meta.snapshot.clone()?;
        if let Some(id) = self.current_assistant.as_ref().filter(|id| {
            !snapshot.messages.iter().any(|message| message.id.as_ref() == Some(*id))
        }) {
            let mut draft = jeikcode_kernel::message::Message::assistant(String::new(), Vec::new());
            draft.id = Some(id.clone());
            // The source boundary carries identity, not the final native
            // authored timestamp. Do not invent one at reconnect time.
            draft.created_at_ms = 0;
            for part in &self.assistant_parts {
                match part.kind {
                    AssistantPartKind::Text => draft.text.push_str(&part.content),
                    AssistantPartKind::Reasoning => draft.reasoning.get_or_insert_with(String::new).push_str(&part.content),
                }
            }
            snapshot.messages.push(draft);
        }
        Some(snapshot)
    }
}

fn clip_key(prefix: &str, value: &str) -> String {
    let mut out = String::with_capacity(prefix.len() + 128);
    out.push_str(prefix);
    for (i, ch) in value.chars().enumerate() {
        if i >= 192 {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

fn consecutive_runtime_key(event: &crate::runtime::CodingRuntimeEvent) -> Option<String> {
    use crate::runtime::CodingRuntimeEvent;
    use jeikcode_kernel::event::AgentEvent;
    match event {
        // Repeated provider fragments are distinct native observations. They
        // cannot be deduplicated by content without corrupting the live draft.
        CodingRuntimeEvent::Agent(AgentEvent::ToolStarted { call }) => {
            Some(format!("ts:{}:{}", call.id, call.name))
        }
        CodingRuntimeEvent::Agent(AgentEvent::ToolProgress { call_id, message }) => {
            Some(format!("tp:{call_id}:{}", clip_key("", message)))
        }
        CodingRuntimeEvent::Agent(AgentEvent::ToolResult { result }) => Some(format!(
            "tr:{}:{}",
            result.call_id,
            clip_key("", &result.content)
        )),
        _ => None,
    }
}

/// Map a runtime stop into the WebUI/daemon notification label.
pub fn stop_reason_terminal_label(reason: jeikcode_kernel::event::StopReason) -> &'static str {
    use jeikcode_kernel::event::StopReason;
    match reason {
        // Kernel `Stopped` is the normal "model finished" terminal.
        StopReason::Stopped => "completed",
        StopReason::Cancelled => "stopped",
        StopReason::ProviderError
        | StopReason::Timeout
        | StopReason::PromptRejected
        | StopReason::PolicyDenied => "failed",
        StopReason::MaxRounds
        | StopReason::MaxContinuations
        | StopReason::RepeatLoop
        | StopReason::ToolLoopDetected
        | StopReason::RateLimited => "stopped",
        _ => "stopped",
    }
}

fn terminal_label(event: &crate::runtime::CodingRuntimeEvent) -> Option<&'static str> {
    use crate::runtime::{CodingRuntimeEvent, TurnCompletion};
    match event {
        CodingRuntimeEvent::TurnFinished(TurnCompletion::Completed { reason, .. })
        | CodingRuntimeEvent::TurnFinished(TurnCompletion::SnapshotUnavailable {
            reason, ..
        }) => Some(stop_reason_terminal_label(*reason)),
        CodingRuntimeEvent::RuntimeStopped(_) => Some("stopped"),
        CodingRuntimeEvent::ProviderUnavailable { .. } => Some("failed"),
        _ => None,
    }
}

fn activity_from_runtime_event(
    event: &crate::runtime::CodingRuntimeEvent,
    previous: RuntimeActivity,
) -> RuntimeActivity {
    use crate::runtime::{CodingRuntimeEvent, TurnCompletion};
    use jeikcode_kernel::event::AgentEvent;
    match event {
        CodingRuntimeEvent::Agent(AgentEvent::TurnStarted)
        | CodingRuntimeEvent::Agent(AgentEvent::TextDelta(_))
        | CodingRuntimeEvent::Agent(AgentEvent::ToolCallStreaming { .. })
        | CodingRuntimeEvent::Agent(AgentEvent::ToolBatchStarted { .. })
        | CodingRuntimeEvent::Agent(AgentEvent::ToolStarted { .. })
        | CodingRuntimeEvent::Agent(AgentEvent::ToolResult { .. })
        | CodingRuntimeEvent::Agent(AgentEvent::Reasoning(_)) => RuntimeActivity::Running,
        CodingRuntimeEvent::Request(request) => {
            if request.kind
                == jeikcode_capabilities::tools::request_user_input::REQUEST_USER_INPUT_KIND
            {
                RuntimeActivity::WaitingUserInput
            } else {
                RuntimeActivity::WaitingApproval
            }
        }
        CodingRuntimeEvent::TurnFinished(TurnCompletion::Completed { .. })
        | CodingRuntimeEvent::TurnFinished(TurnCompletion::SnapshotUnavailable { .. }) => {
            RuntimeActivity::Ready
        }
        CodingRuntimeEvent::RuntimeStopped(_) => RuntimeActivity::Stopped,
        CodingRuntimeEvent::Reconfiguring { .. } => RuntimeActivity::Reconfiguring,
        CodingRuntimeEvent::Reconfigured { .. } => RuntimeActivity::Ready,
        CodingRuntimeEvent::ProviderUnavailable { .. } => RuntimeActivity::Failed,
        _ => previous,
    }
}

/// L2 registry: one live runner per session within a process.
#[derive(Debug, Default)]
pub struct SessionRuntimeRegistry {
    entries: RwLock<HashMap<SessionKey, LiveInner>>,
    /// Provider identity fingerprints keyed by session. Updated whenever a
    /// handle is bound or its provider is reassembled, so callers can compare
    /// a requested provider against the bound one without reaching into the
    /// runtime internals. Optional — absent when the bound handle was created
    /// without going through the fingerprint-aware spawn paths (older callers
    /// that pass `None` here).
    provider_fingerprints: RwLock<HashMap<SessionKey, String>>,
}

/// Process-wide registry. Drivers attach views here instead of competing for
/// exclusive "foreground" ownership of a single CodingRuntime.
static GLOBAL_REGISTRY: OnceLock<SessionRuntimeRegistry> = OnceLock::new();

impl SessionRuntimeRegistry {
    pub fn global() -> &'static SessionRuntimeRegistry {
        GLOBAL_REGISTRY.get_or_init(SessionRuntimeRegistry::new)
    }

    pub fn new() -> Self {
        Self::default()
    }

    pub fn lookup(&self, key: &SessionKey) -> Option<SessionRuntimeEntry> {
        self.entries
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .map(|inner| inner.meta.clone())
    }

    pub fn activity(&self, key: &SessionKey) -> Option<RuntimeActivity> {
        self.lookup(key).map(|e| e.activity)
    }

    /// List sessions with live runners under `working_dir` (exact path match).
    pub fn list_activity(&self, working_dir: &Path) -> Vec<(SessionKey, RuntimeActivity)> {
        self.entries
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|e| e.meta.working_dir == working_dir)
            .map(|e| (e.meta.session_id.clone(), e.meta.activity))
            .collect()
    }

    /// All live runners (any working directory).
    pub fn list_all(&self) -> Vec<SessionRuntimeEntry> {
        self.entries
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .map(|e| e.meta.clone())
            .collect()
    }

    /// Session ids whose **bound** runner is actually in a turn.
    ///
    /// `open_or_attach` / `subscribe_or_empty` leave handle-less `Starting`
    /// (or `InputAccepted` → `Running`) rows. Those are views, not occupancy.
    pub fn live_turn_session_ids(&self) -> Vec<SessionKey> {
        self.entries
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|e| e.handle.is_some() && e.meta.activity.is_live_turn())
            .map(|e| e.meta.session_id.clone())
            .collect()
    }

    pub fn live_count(&self) -> usize {
        self.entries.read().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// Register or attach to a session runner. At most one entry per `session_id`.
    /// Does **not** spawn a CodingRuntime — drivers call [`bind_handle`] after start.
    pub fn open_or_attach(
        &self,
        session_id: SessionKey,
        working_dir: PathBuf,
    ) -> Result<(OpenOutcome, SessionRuntimeEntry), RegistryError> {
        let mut guard = self.entries.write().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = guard.get(&session_id) {
            return Ok((OpenOutcome::Attached, existing.meta.clone()));
        }
        if guard.len() >= MAX_LIVE_SESSIONS {
            return Err(RegistryError::LiveLimit {
                max: MAX_LIVE_SESSIONS,
            });
        }
        let inner = LiveInner::new(session_id.clone(), working_dir);
        let meta = inner.meta.clone();
        guard.insert(session_id, inner);
        Ok((OpenOutcome::Registered, meta))
    }

    /// Wire the authoritative CodingRuntime handle after deferred start succeeds.
    pub fn bind_handle(
        &self,
        key: &SessionKey,
        handle: CodingRuntimeHandle,
        runtime_id: Option<u64>,
    ) -> bool {
        let mut guard = self.entries.write().unwrap_or_else(|e| e.into_inner());
        let Some(inner) = guard.get_mut(key) else {
            return false;
        };
        let incoming_instance_id = handle.instance_id().to_string();
        if let Some(existing) = inner.handle.as_ref() {
            if existing.instance_id() != incoming_instance_id && !existing.is_stopped() {
                return false;
            }
            if existing.instance_id() != incoming_instance_id {
                // A replacement runtime is only accepted after the previous owner
                // has stopped. Its pending request and replay window are scoped to
                // that old owner and must never survive into the replacement.
                inner.pending_request = None;
                inner.journal.clear();
                inner.recent_runtime_keys.clear();
                inner.current_assistant = None;
                inner.part_seq = 0;
                inner.part_kind = None;
                inner.assistant_parts.clear();
                inner.active_tools.clear();
                inner.evicted_through = None;
            }
        }
        inner.meta.runtime_instance_id = Some(incoming_instance_id);
        inner.meta.generation = handle.status().generation;
        inner.handle = Some(handle);
        inner.meta.runtime_id = runtime_id;
        if matches!(
            inner.meta.activity,
            RuntimeActivity::Starting | RuntimeActivity::Stopped
        ) {
            inner.push_activity(RuntimeActivity::Ready);
        }
        true
    }

    /// Record the provider fingerprint currently bound to `key`. Callers
    /// (e.g. the daemon's `/live` paths) update this whenever they spawn a
    /// new runtime or reassemble the provider on an existing one, so the
    /// next `/live/message` can detect a stale bound provider without
    /// reaching into runtime internals. `None` clears the entry (e.g. when
    /// the runner is torn down).
    pub fn set_provider_fingerprint(&self, key: &SessionKey, fingerprint: Option<String>) {
        let mut guard = self
            .provider_fingerprints
            .write()
            .unwrap_or_else(|e| e.into_inner());
        match fingerprint {
            Some(fp) => {
                guard.insert(key.clone(), fp);
            }
            None => {
                guard.remove(key);
            }
        }
    }

    /// Provider fingerprint bound to `key`, if recorded. `None` means either
    /// the session has no bound runner or the caller never set one.
    pub fn provider_fingerprint(&self, key: &SessionKey) -> Option<String> {
        let guard = self
            .provider_fingerprints
            .read()
            .unwrap_or_else(|e| e.into_inner());
        guard.get(key).cloned()
    }

    pub fn set_activity(&self, key: &SessionKey, activity: RuntimeActivity) -> bool {
        let mut guard = self.entries.write().unwrap_or_else(|e| e.into_inner());
        let Some(inner) = guard.get_mut(key) else {
            return false;
        };
        inner.push_activity(activity);
        true
    }

    /// Record a turn outcome and park the runner at Ready.
    ///
    /// `terminal` is `completed`, `stopped`, or `failed`. Each call bumps
    /// [`SessionRuntimeEntry::terminal_seq`] so a poller can notify once.
    pub fn note_terminal(&self, key: &SessionKey, terminal: &str) -> bool {
        let mut guard = self.entries.write().unwrap_or_else(|e| e.into_inner());
        let Some(inner) = guard.get_mut(key) else {
            return false;
        };
        inner.meta.terminal_seq = inner.meta.terminal_seq.wrapping_add(1);
        inner.meta.last_terminal = Some(terminal.to_string());
        inner.push_activity(RuntimeActivity::Ready);
        true
    }

    pub fn set_snapshot(&self, key: &SessionKey, snapshot: SessionSnapshot) -> bool {
        let mut guard = self.entries.write().unwrap_or_else(|e| e.into_inner());
        let Some(inner) = guard.get_mut(key) else {
            return false;
        };
        inner.meta.snapshot = Some(snapshot);
        true
    }

    pub fn snapshot(&self, key: &SessionKey) -> Option<SessionSnapshot> {
        self.entries
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .and_then(|e| e.meta.snapshot.clone())
    }

    pub fn pending_request_id(&self, key: &SessionKey) -> Option<RequestId> {
        self.entries
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .and_then(|e| e.pending_request.as_ref().map(|pending| pending.request_id))
    }

    pub fn set_pending_request(&self, key: &SessionKey, id: Option<RequestId>) -> bool {
        let mut guard = self.entries.write().unwrap_or_else(|e| e.into_inner());
        let Some(inner) = guard.get_mut(key) else {
            return false;
        };
        inner.pending_request = id.map(|request_id| PendingRuntimeRequest {
            runtime_instance_id: inner.meta.runtime_instance_id.clone(),
            generation: inner.meta.generation,
            request_id,
            kind: "approval".to_string(),
        });
        if inner.pending_request.is_some() {
            inner.push_activity(RuntimeActivity::WaitingApproval);
        }
        true
    }

    /// Submit a turn to the session's bound handle.
    pub fn submit(&self, key: &SessionKey, input: UserInput) -> Result<(), RegistryError> {
        let guard = self.entries.read().unwrap_or_else(|e| e.into_inner());
        let inner = guard.get(key).ok_or(RegistryError::UnknownSession {
            session_id: key.clone(),
        })?;
        let handle = inner.handle.as_ref().ok_or(RegistryError::HandleNotReady {
            session_id: key.clone(),
        })?;
        handle
            .dispatch(DriverCommand::Submit(input))
            .map_err(|_| RegistryError::Unavailable {
                session_id: key.clone(),
            })?;
        drop(guard);
        self.set_activity(key, RuntimeActivity::Running);
        Ok(())
    }

    pub fn cancel(&self, key: &SessionKey) -> Result<(), RegistryError> {
        let res = self.dispatch(key, DriverCommand::Cancel);
        jeikcode_capabilities::tools::legacy_bash_runtime_state().cancel_foreground_live_bash();
        res
    }

    pub fn resolve_request(
        &self,
        key: &SessionKey,
        id: RequestId,
        value: serde_json::Value,
    ) -> Result<(), RegistryError> {
        self.dispatch(key, DriverCommand::Respond { id, value })?;
        let mut guard = self.entries.write().unwrap_or_else(|e| e.into_inner());
        if let Some(inner) = guard.get_mut(key) {
            if inner
                .pending_request
                .as_ref()
                .is_some_and(|pending| pending.request_id == id)
            {
                inner.pending_request = None;
            }
        }
        Ok(())
    }

    pub fn dispatch(&self, key: &SessionKey, command: DriverCommand) -> Result<(), RegistryError> {
        let guard = self.entries.read().unwrap_or_else(|e| e.into_inner());
        let inner = guard.get(key).ok_or(RegistryError::UnknownSession {
            session_id: key.clone(),
        })?;
        let handle = inner.handle.as_ref().ok_or(RegistryError::HandleNotReady {
            session_id: key.clone(),
        })?;
        handle
            .dispatch(command)
            .map_err(|_: RuntimeUnavailable| RegistryError::Unavailable {
                session_id: key.clone(),
            })
    }

    /// Append a CodingRuntime observation for multi-view fan-out.
    /// Safe to call from sync driver paths (std `RwLock`).
    pub fn push_runtime_event(
        &self,
        key: &SessionKey,
        generation: u64,
        event: crate::runtime::CodingRuntimeEvent,
    ) -> bool {
        let mut guard = self.entries.write().unwrap_or_else(|e| e.into_inner());
        let Some(inner) = guard.get_mut(key) else {
            return false;
        };
        if let crate::runtime::CodingRuntimeEvent::TurnFinished(
            crate::runtime::TurnCompletion::Completed { snapshot, .. },
        ) = &event
        {
            inner.meta.snapshot = Some((**snapshot).clone());
        }
        if let crate::runtime::CodingRuntimeEvent::Request(request) = &event {
            inner.pending_request = Some(PendingRuntimeRequest {
                runtime_instance_id: None,
                generation: if generation > 0 {
                    generation
                } else {
                    inner.meta.generation
                },
                request_id: request.id,
                kind: request.kind.clone(),
            });
        }
        if let crate::runtime::CodingRuntimeEvent::TurnFinished(_) = &event {
            inner.pending_request = None;
        }
        // Snapshot already has the completed turn. Replaying TextDelta / ToolStart
        // on top of it duplicates the last assistant (text + tools) after a
        // sidebar session switch reconnects `/live?session_id=`.
        if matches!(
            &event,
            crate::runtime::CodingRuntimeEvent::TurnFinished(_)
                | crate::runtime::CodingRuntimeEvent::RuntimeStopped(_)
        ) {
            inner.journal.clear();
            inner.recent_runtime_keys.clear();
            inner.evicted_through = None;
        }
        if let Some(key) = consecutive_runtime_key(&event) {
            if inner.recent_runtime_keys.iter().any(|seen| seen == &key) {
                return false;
            }
            const RECENT_KEY_CAP: usize = 64;
            if inner.recent_runtime_keys.len() >= RECENT_KEY_CAP {
                inner.recent_runtime_keys.pop_front();
            }
            inner.recent_runtime_keys.push_back(key);
        }
        inner.push_runtime(generation, event);
        true
    }

    /// Append an observation only when it came from the concrete runtime that
    /// still owns this session. The producer supplies its immutable instance id;
    /// never infer it from the registry row after an async rebind.
    pub fn push_runtime_event_for_runtime(
        &self,
        key: &SessionKey,
        expected_runtime_instance_id: &str,
        generation: u64,
        event: crate::runtime::CodingRuntimeEvent,
    ) -> bool {
        let mut guard = self.entries.write().unwrap_or_else(|e| e.into_inner());
        let Some(inner) = guard.get_mut(key) else {
            return false;
        };
        if inner.meta.runtime_instance_id.as_deref() != Some(expected_runtime_instance_id) {
            return false;
        }
        let Some(handle) = inner.handle.as_ref() else {
            return false;
        };
        if handle.instance_id() != expected_runtime_instance_id
            || handle.status().generation != generation
        {
            return false;
        }
        if let crate::runtime::CodingRuntimeEvent::TurnFinished(
            crate::runtime::TurnCompletion::Completed { snapshot, .. },
        ) = &event
        {
            inner.meta.snapshot = Some((**snapshot).clone());
        }
        if let crate::runtime::CodingRuntimeEvent::Request(request) = &event {
            inner.pending_request = Some(PendingRuntimeRequest {
                runtime_instance_id: Some(expected_runtime_instance_id.to_string()),
                generation,
                request_id: request.id,
                kind: request.kind.clone(),
            });
        }
        if let crate::runtime::CodingRuntimeEvent::TurnFinished(_) = &event {
            inner.pending_request = None;
        }
        if matches!(
            &event,
            crate::runtime::CodingRuntimeEvent::TurnFinished(_)
                | crate::runtime::CodingRuntimeEvent::RuntimeStopped(_)
        ) {
            inner.journal.clear();
            inner.recent_runtime_keys.clear();
            inner.evicted_through = None;
        }
        if let Some(key) = consecutive_runtime_key(&event) {
            if inner.recent_runtime_keys.iter().any(|seen| seen == &key) {
                return false;
            }
            const RECENT_KEY_CAP: usize = 64;
            if inner.recent_runtime_keys.len() >= RECENT_KEY_CAP {
                inner.recent_runtime_keys.pop_front();
            }
            inner.recent_runtime_keys.push_back(key);
        }
        inner.push_runtime_for_instance(expected_runtime_instance_id, generation, event);
        true
    }

    /// Fan out a view-layer event (InputAccepted / Steered / RequestResolved / CommandOutput).
    pub fn push_view_event(&self, key: &SessionKey, view: SessionViewEvent) -> bool {
        let mut guard = self.entries.write().unwrap_or_else(|e| e.into_inner());
        let Some(inner) = guard.get_mut(key) else {
            return false;
        };
        if let SessionViewEvent::RequestResolved { request_id, .. } = &view {
            if inner
                .pending_request
                .as_ref()
                .is_some_and(|pending| pending.request_id == *request_id)
            {
                inner.pending_request = None;
            }
        }
        inner.push_view(view);
        true
    }

    /// Push a view event only while the same concrete runtime owner is still
    /// bound. This prevents a response completed on an old runtime from clearing
    /// a reused request id on a replacement runtime.
    pub fn push_view_event_for_runtime(
        &self,
        key: &SessionKey,
        expected_runtime_instance_id: &str,
        expected_generation: u64,
        view: SessionViewEvent,
    ) -> bool {
        let mut guard = self.entries.write().unwrap_or_else(|e| e.into_inner());
        let Some(inner) = guard.get_mut(key) else {
            return false;
        };
        if inner.meta.runtime_instance_id.as_deref() != Some(expected_runtime_instance_id) {
            return false;
        }
        let Some(handle) = inner.handle.as_ref() else {
            return false;
        };
        if handle.instance_id() != expected_runtime_instance_id
            || handle.status().generation != expected_generation
        {
            return false;
        }
        if inner.meta.generation != expected_generation {
            return false;
        }
        if let SessionViewEvent::RequestResolved { request_id, kind } = &view {
            let matches = inner.pending_request.as_ref().is_some_and(|pending| {
                pending.runtime_instance_id.as_deref() == Some(expected_runtime_instance_id)
                    && pending.generation == expected_generation
                    && pending.request_id == *request_id
                    && pending.kind == *kind
            });
            if !matches {
                return false;
            }
            inner.pending_request = None;
        }
        inner.push_view_for_instance(expected_runtime_instance_id, expected_generation, view);
        true
    }

    pub fn pending_request_matches(
        &self,
        key: &SessionKey,
        expected_runtime_instance_id: &str,
        expected_generation: u64,
        request_id: RequestId,
        kind: &str,
    ) -> bool {
        let guard = self.entries.read().unwrap_or_else(|e| e.into_inner());
        let Some(inner) = guard.get(key) else {
            return false;
        };
        if inner.meta.runtime_instance_id.as_deref() != Some(expected_runtime_instance_id)
            || inner.meta.generation != expected_generation
        {
            return false;
        }
        let Some(handle) = inner.handle.as_ref() else {
            return false;
        };
        if handle.instance_id() != expected_runtime_instance_id
            || handle.status().generation != expected_generation
        {
            return false;
        }
        inner.pending_request.as_ref().is_some_and(|pending| {
            pending.runtime_instance_id.as_deref() == Some(expected_runtime_instance_id)
                && pending.generation == expected_generation
                && pending.request_id == request_id
                && pending.kind == kind
        })
    }

    /// Ensure the session exists, then push a view event.
    pub fn ensure_and_push_view(
        &self,
        key: SessionKey,
        working_dir: PathBuf,
        view: SessionViewEvent,
    ) -> bool {
        let _ = self.open_or_attach(key.clone(), working_dir);
        self.push_view_event(&key, view)
    }

    /// Push by TUI transport runtime id (foreground / background runners).
    pub fn push_runtime_event_by_runtime_id(
        &self,
        runtime_id: u64,
        generation: u64,
        event: crate::runtime::CodingRuntimeEvent,
    ) -> bool {
        let key = {
            let guard = self.entries.read().unwrap_or_else(|e| e.into_inner());
            guard
                .values()
                .find(|e| e.meta.runtime_id == Some(runtime_id))
                .map(|e| e.meta.session_id.clone())
        };
        let Some(key) = key else {
            return false;
        };
        if let Some(handle) = self.handle(&key) {
            let runtime_instance_id = handle.instance_id().to_string();
            return self.push_runtime_event_for_runtime(
                &key,
                &runtime_instance_id,
                generation,
                event,
            );
        }
        self.push_runtime_event(&key, generation, event)
    }

    /// Bound CodingRuntime handle for a session, if ready.
    pub fn handle(&self, key: &SessionKey) -> Option<CodingRuntimeHandle> {
        let guard = self.entries.read().unwrap_or_else(|e| e.into_inner());
        guard.get(key).and_then(|e| e.handle.clone())
    }

    /// Bound handle only when it is still the exact runtime instance named by
    /// an external correlation token.
    pub fn handle_for_runtime_instance(
        &self,
        key: &SessionKey,
        expected_runtime_instance_id: &str,
    ) -> Option<CodingRuntimeHandle> {
        let guard = self.entries.read().unwrap_or_else(|e| e.into_inner());
        let inner = guard.get(key)?;
        if inner.meta.runtime_instance_id.as_deref() != Some(expected_runtime_instance_id) {
            return None;
        }
        let handle = inner.handle.clone()?;
        (handle.instance_id() == expected_runtime_instance_id).then_some(handle)
    }

    /// Look up session id by TUI transport runtime id.
    pub fn session_id_for_runtime_id(&self, runtime_id: u64) -> Option<SessionKey> {
        let guard = self.entries.read().unwrap_or_else(|e| e.into_inner());
        guard
            .values()
            .find(|e| e.meta.runtime_id == Some(runtime_id))
            .map(|e| e.meta.session_id.clone())
    }


    pub fn subscribe_with_snapshot(&self, key: &SessionKey) -> Result<SessionReplayJoin, RegistryError> {
        let guard = self.entries.read().unwrap_or_else(|error| error.into_inner());
        let inner = guard.get(key).ok_or_else(|| RegistryError::UnknownSession { session_id: key.clone() })?;
        Ok(SessionReplayJoin {
            snapshot: inner.replay_snapshot(),
            through_sequence: inner.next_sequence.checked_sub(1),
            assistant_parts: inner.assistant_parts.clone(),
            active_tools: inner.active_tools.values().cloned().collect(),
            replay: inner.replay(None),
            events: inner.event_tx.subscribe(),
        })
    }
    /// Subscribe to activity events for a session (after `after_sequence`).
    pub fn subscribe(
        &self,
        key: &SessionKey,
        after_sequence: Option<u64>,
    ) -> Result<
        (
            Vec<SequencedSessionEvent>,
            broadcast::Receiver<SequencedSessionEvent>,
        ),
        RegistryError,
    > {
        let guard = self.entries.read().unwrap_or_else(|e| e.into_inner());
        let inner = guard.get(key).ok_or(RegistryError::UnknownSession {
            session_id: key.clone(),
        })?;
        let replay = inner.replay(after_sequence);
        let rx = inner.event_tx.subscribe();
        Ok((replay, rx))
    }

    /// Subscribe even when the session is not yet registered — returns empty
    /// replay and a channel that will receive events after `open_or_attach`.
    /// Prefer [`subscribe`] when the session is known live.
    pub fn subscribe_or_empty(
        &self,
        key: &SessionKey,
        working_dir: PathBuf,
        after_sequence: Option<u64>,
    ) -> Result<
        (
            Vec<SequencedSessionEvent>,
            broadcast::Receiver<SequencedSessionEvent>,
        ),
        RegistryError,
    > {
        match self.subscribe(key, after_sequence) {
            Ok(pair) => Ok(pair),
            Err(RegistryError::UnknownSession { .. }) => {
                self.open_or_attach(key.clone(), working_dir)?;
                self.subscribe(key, after_sequence)
            }
            Err(other) => Err(other),
        }
    }

    pub fn release_if_idle(&self, key: &SessionKey) -> bool {
        let mut guard = self.entries.write().unwrap_or_else(|e| e.into_inner());
        match guard.get(key) {
            Some(entry) if entry.meta.activity.is_idle_releasable() => {
                if let Some(handle) = entry.handle.as_ref() {
                    let _ = handle.dispatch(DriverCommand::Shutdown);
                }
                guard.remove(key);
                true
            }
            _ => false,
        }
    }

    /// Force-remove an entry (e.g. view closed an empty home draft that was registered).
    pub fn force_remove(&self, key: &SessionKey) -> bool {
        let mut guard = self.entries.write().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = guard.remove(key) {
            if let Some(handle) = entry.handle.as_ref() {
                let _ = handle.dispatch(DriverCommand::Shutdown);
            }
            true
        } else {
            false
        }
    }

    /// Drop the registry row without shutting the runtime down. Used when the
    /// bound handle has already been freshed onto a new session id.
    pub fn detach(&self, key: &SessionKey) -> bool {
        let mut guard = self.entries.write().unwrap_or_else(|e| e.into_inner());
        guard.remove(key).is_some()
    }

    pub fn shutdown_all(&self) {
        let mut guard = self.entries.write().unwrap_or_else(|e| e.into_inner());
        for (_, entry) in guard.drain() {
            if let Some(handle) = entry.handle.as_ref() {
                let _ = handle.dispatch(DriverCommand::Shutdown);
            }
        }
    }

    /// Reconcile registry membership with the set of session ids the driver still owns.
    /// Unlike the old slot-mirror helper, this does **not** invent entries — it only
    /// drops idle registry rows that the driver no longer tracks.
    pub fn retain_sessions(&self, keep: &HashSet<SessionKey>) {
        let mut guard = self.entries.write().unwrap_or_else(|e| e.into_inner());
        let stale: Vec<SessionKey> = guard
            .keys()
            .filter(|id| !keep.contains(*id))
            .cloned()
            .collect();
        for id in stale {
            if guard
                .get(&id)
                .is_some_and(|e| e.meta.activity.is_idle_releasable())
            {
                if let Some(entry) = guard.remove(&id) {
                    if let Some(handle) = entry.handle.as_ref() {
                        let _ = handle.dispatch(DriverCommand::Shutdown);
                    }
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistryError {
    UnknownSession { session_id: SessionKey },
    HandleNotReady { session_id: SessionKey },
    Unavailable { session_id: SessionKey },
    LiveLimit { max: usize },
}

impl std::fmt::Display for RegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownSession { session_id } => {
                write!(f, "session {session_id} is not in the runtime registry")
            }
            Self::HandleNotReady { session_id } => {
                write!(f, "session {session_id} runtime handle is not ready")
            }
            Self::Unavailable { session_id } => {
                write!(f, "session {session_id} coding runtime is unavailable")
            }
            Self::LiveLimit { max } => {
                write!(f, "too many live sessions (max {max})")
            }
        }
    }
}

impl std::error::Error for RegistryError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn open_or_attach_is_idempotent_per_session() {
        let reg = SessionRuntimeRegistry::new();
        let (o1, e1) = reg
            .open_or_attach("s1".into(), PathBuf::from("/proj"))
            .unwrap();
        assert_eq!(o1, OpenOutcome::Registered);
        let (o2, e2) = reg
            .open_or_attach("s1".into(), PathBuf::from("/proj"))
            .unwrap();
        assert_eq!(o2, OpenOutcome::Attached);
        assert_eq!(e1.session_id, e2.session_id);
    }

    #[test]
    fn bound_runtime_generation_zero_is_authoritative_for_correlated_requests() {
        let reg = SessionRuntimeRegistry::new();
        let key = "s1".to_string();
        reg.open_or_attach(key.clone(), PathBuf::from("/proj"))
            .unwrap();
        let (handle, _control) = crate::runtime::coding_runtime_control_channel();
        let runtime_instance_id = handle.instance_id().to_string();
        assert_eq!(handle.status().generation, 0);
        assert!(reg.bind_handle(&key, handle, None));

        let bound = reg.lookup(&key).expect("bound registry entry");
        assert_eq!(bound.generation, 0);
        assert_eq!(
            bound.runtime_instance_id.as_deref(),
            Some(runtime_instance_id.as_str())
        );
        assert!(reg.push_runtime_event_for_runtime(
            &key,
            &runtime_instance_id,
            0,
            crate::runtime::CodingRuntimeEvent::Request(crate::runtime::RuntimeRequest {
                id: 1,
                kind: "approval".into(),
                payload: serde_json::json!({}),
                snapshot: None,
            }),
        ));
        assert!(reg.pending_request_matches(&key, &runtime_instance_id, 0, 1, "approval"));
        let (replay, _rx) = reg.subscribe(&key, None).unwrap();
        assert!(replay.iter().any(|event| {
            event.runtime_instance_id.as_deref() == Some(runtime_instance_id.as_str())
                && event.generation == 0
                && matches!(
                    &event.runtime,
                    Some(crate::runtime::CodingRuntimeEvent::Request(request)) if request.id == 1
                )
        }));
    }

    #[test]
    fn replacement_runtime_rejects_old_owner_with_reused_generation_and_request_id() {
        let reg = SessionRuntimeRegistry::new();
        let key = "s1".to_string();
        reg.open_or_attach(key.clone(), PathBuf::from("/proj"))
            .unwrap();

        let (old_handle, old_control) = crate::runtime::coding_runtime_control_channel();
        let old_instance_id = old_handle.instance_id().to_string();
        assert!(reg.bind_handle(&key, old_handle.clone(), None));
        drop(old_control);
        assert!(old_handle.is_stopped());

        let (new_handle, _new_control) = crate::runtime::coding_runtime_control_channel();
        let new_instance_id = new_handle.instance_id().to_string();
        assert_ne!(old_instance_id, new_instance_id);
        assert_eq!(new_handle.status().generation, 0);
        assert!(reg.bind_handle(&key, new_handle, None));
        assert!(reg.push_runtime_event_for_runtime(
            &key,
            &new_instance_id,
            0,
            crate::runtime::CodingRuntimeEvent::Request(crate::runtime::RuntimeRequest {
                id: 1,
                kind: "approval".into(),
                payload: serde_json::json!({}),
                snapshot: None,
            }),
        ));

        assert!(!reg.push_runtime_event_for_runtime(
            &key,
            &old_instance_id,
            0,
            crate::runtime::CodingRuntimeEvent::Request(crate::runtime::RuntimeRequest {
                id: 1,
                kind: "approval".into(),
                payload: serde_json::json!({}),
                snapshot: None,
            }),
        ));
        assert!(!reg.pending_request_matches(&key, &old_instance_id, 0, 1, "approval"));
        assert!(reg.pending_request_matches(&key, &new_instance_id, 0, 1, "approval"));
        assert_eq!(
            reg.lookup(&key).unwrap().runtime_instance_id.as_deref(),
            Some(new_instance_id.as_str())
        );
    }

    #[test]
    fn active_runtime_cannot_be_rebound_to_a_different_owner() {
        let reg = SessionRuntimeRegistry::new();
        let key = "s1".to_string();
        reg.open_or_attach(key.clone(), PathBuf::from("/proj"))
            .unwrap();
        let (first, _first_control) = crate::runtime::coding_runtime_control_channel();
        let first_instance_id = first.instance_id().to_string();
        let (second, _second_control) = crate::runtime::coding_runtime_control_channel();

        assert!(reg.bind_handle(&key, first, None));
        assert!(!reg.bind_handle(&key, second, None));
        assert_eq!(
            reg.lookup(&key).unwrap().runtime_instance_id.as_deref(),
            Some(first_instance_id.as_str())
        );
    }

    #[test]
    fn runtime_scoped_resolution_requires_exact_generation_request_and_kind() {
        let reg = SessionRuntimeRegistry::new();
        let key = "s1".to_string();
        reg.open_or_attach(key.clone(), PathBuf::from("/proj"))
            .unwrap();
        let (handle, _control) = crate::runtime::coding_runtime_control_channel();
        let runtime_instance_id = handle.instance_id().to_string();
        assert!(reg.bind_handle(&key, handle, None));
        assert!(reg.push_runtime_event_for_runtime(
            &key,
            &runtime_instance_id,
            0,
            crate::runtime::CodingRuntimeEvent::Request(crate::runtime::RuntimeRequest {
                id: 9,
                kind: "approval".into(),
                payload: serde_json::json!({}),
                snapshot: None,
            }),
        ));

        assert!(!reg.push_view_event_for_runtime(
            &key,
            &runtime_instance_id,
            1,
            SessionViewEvent::RequestResolved {
                request_id: 9,
                kind: "approval".into(),
            },
        ));
        assert!(!reg.push_view_event_for_runtime(
            &key,
            &runtime_instance_id,
            0,
            SessionViewEvent::RequestResolved {
                request_id: 9,
                kind: "user_input".into(),
            },
        ));
        assert!(reg.pending_request_matches(&key, &runtime_instance_id, 0, 9, "approval"));
        assert!(reg.push_view_event_for_runtime(
            &key,
            &runtime_instance_id,
            0,
            SessionViewEvent::RequestResolved {
                request_id: 9,
                kind: "approval".into(),
            },
        ));
        assert!(!reg.pending_request_matches(&key, &runtime_instance_id, 0, 9, "approval"));
    }

    #[tokio::test]
    async fn list_activity_scopes_by_working_dir() {
        let reg = SessionRuntimeRegistry::new();
        reg.open_or_attach("a".into(), PathBuf::from("/p1"))
            .unwrap();
        reg.open_or_attach("b".into(), PathBuf::from("/p2"))
            .unwrap();
        let p1 = reg.list_activity(Path::new("/p1"));
        assert_eq!(p1.len(), 1);
        assert_eq!(p1[0].0, "a");
    }

    #[tokio::test]
    async fn select_semantics_do_not_require_reconfigure() {
        // Registry holds A and B independently; "view switch" is a client concern.
        let reg = SessionRuntimeRegistry::new();
        reg.open_or_attach("a".into(), PathBuf::from("/p")).unwrap();
        reg.open_or_attach("b".into(), PathBuf::from("/p")).unwrap();
        reg.set_activity(&"a".into(), RuntimeActivity::Running);
        assert_eq!(reg.activity(&"a".into()), Some(RuntimeActivity::Running));
        assert_eq!(reg.activity(&"b".into()), Some(RuntimeActivity::Starting));
        // Switching the view to B must not clear A's busy state.
        assert!(reg.activity(&"a".into()).unwrap().is_busy());
    }

    #[tokio::test]
    async fn retain_sessions_drops_idle_stale_only() {
        let reg = SessionRuntimeRegistry::new();
        reg.open_or_attach("keep".into(), PathBuf::from("/p"))
            .unwrap();
        reg.open_or_attach("drop".into(), PathBuf::from("/p"))
            .unwrap();
        reg.set_activity(&"drop".into(), RuntimeActivity::Ready);
        reg.set_activity(&"keep".into(), RuntimeActivity::Running);
        let mut keep = HashSet::new();
        keep.insert("keep".into());
        reg.retain_sessions(&keep);
        assert!(reg.lookup(&"keep".into()).is_some());
        assert!(reg.lookup(&"drop".into()).is_none());
    }

    #[tokio::test]
    async fn subscribe_replays_journal_after_sequence() {
        let reg = SessionRuntimeRegistry::new();
        reg.open_or_attach("s".into(), PathBuf::from("/p")).unwrap();
        reg.set_activity(&"s".into(), RuntimeActivity::Ready);
        reg.set_activity(&"s".into(), RuntimeActivity::Running);
        let (replay, _rx) = reg.subscribe(&"s".into(), Some(0)).unwrap();
        assert!(replay
            .iter()
            .any(|e| e.activity == RuntimeActivity::Running));
    }

    #[tokio::test]
    async fn turn_finished_clears_delta_journal_so_reconnect_does_not_duplicate() {
        use jeikcode_kernel::event::AgentEvent;
        let reg = SessionRuntimeRegistry::new();
        reg.open_or_attach("s".into(), PathBuf::from("/p")).unwrap();
        assert!(reg.push_runtime_event(
            &"s".into(),
            1,
            crate::runtime::CodingRuntimeEvent::Agent(AgentEvent::TextDelta("hi".into())),
        ));
        assert!(reg.push_runtime_event(
            &"s".into(),
            1,
            crate::runtime::CodingRuntimeEvent::TurnFinished(
                crate::runtime::TurnCompletion::SnapshotUnavailable {
                    turn_id: 1,
                    reason: jeikcode_kernel::event::StopReason::Stopped,
                    error: crate::runtime::RuntimeSnapshotError {
                        message: "done".into(),
                    },
                    stats: crate::runtime::RuntimeTurnStats {
                        last_usage: None,
                        duration: std::time::Duration::from_millis(1),
                        turn_count: 1,
                        tool_call_count: 0,
                    },
                },
            ),
        ));
        let (replay, _rx) = reg.subscribe(&"s".into(), None).unwrap();
        assert!(
            replay.iter().all(|event| !matches!(
                event.runtime,
                Some(crate::runtime::CodingRuntimeEvent::Agent(
                    AgentEvent::TextDelta(_)
                ))
            )),
            "completed-turn deltas must not be replayed on the next live join"
        );
        assert!(replay.iter().any(|event| matches!(
            event.runtime,
            Some(crate::runtime::CodingRuntimeEvent::TurnFinished(_))
        )));
    }

    #[tokio::test]
    async fn push_runtime_event_fans_out_text_delta_to_subscribers() {
        use jeikcode_kernel::event::AgentEvent;
        let reg = SessionRuntimeRegistry::new();
        reg.open_or_attach("s".into(), PathBuf::from("/p")).unwrap();
        let (replay_before, mut rx) = reg.subscribe(&"s".into(), None).unwrap();
        assert!(replay_before
            .iter()
            .all(|e| e.runtime.is_none() && e.view.is_none()));
        assert!(reg.push_runtime_event(
            &"s".into(),
            1,
            crate::runtime::CodingRuntimeEvent::Agent(AgentEvent::TextDelta("hi".into())),
        ));
        let got = rx.recv().await.expect("fan-out");
        match got.runtime {
            Some(crate::runtime::CodingRuntimeEvent::Agent(AgentEvent::TextDelta(text))) => {
                assert_eq!(text, "hi");
            }
            other => panic!("expected TextDelta, got {other:?}"),
        }
        assert_eq!(got.activity, RuntimeActivity::Running);
    }

    #[tokio::test]
    async fn push_runtime_event_drops_consecutive_duplicate_agent_observations() {
        use jeikcode_kernel::event::AgentEvent;
        let reg = SessionRuntimeRegistry::new();
        reg.open_or_attach("s".into(), PathBuf::from("/p")).unwrap();
        let (_replay, mut rx) = reg.subscribe(&"s".into(), None).unwrap();
        let delta = crate::runtime::CodingRuntimeEvent::Agent(AgentEvent::ToolStarted {
            call: jeikcode_kernel::tool::ToolCall { id: "call-1".into(), name: "read_file".into(), arguments: "{}".into() },
        });
        assert!(reg.push_runtime_event(&"s".into(), 1, delta.clone()));
        assert!(
            !reg.push_runtime_event(&"s".into(), 1, delta),
            "observer echo of the same native call id must not re-fanout"
        );
        let first = rx.recv().await.expect("first fan-out");
        assert!(matches!(
            first.runtime,
            Some(crate::runtime::CodingRuntimeEvent::Agent(
                AgentEvent::ToolStarted { .. }
            ))
        ));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(30), rx.recv())
                .await
                .is_err(),
            "duplicate must not reach subscribers"
        );
        assert!(reg.push_runtime_event(
            &"s".into(),
            1,
            crate::runtime::CodingRuntimeEvent::Agent(AgentEvent::TextDelta("下一句".into())),
        ));
    }

    #[tokio::test]
    async fn push_runtime_event_breaks_alternating_observer_echo() {
        use jeikcode_kernel::event::AgentEvent;
        let reg = SessionRuntimeRegistry::new();
        reg.open_or_attach("s".into(), PathBuf::from("/p")).unwrap();
        let a = crate::runtime::CodingRuntimeEvent::Agent(AgentEvent::ToolStarted {
            call: jeikcode_kernel::tool::ToolCall { id: "call-a".into(), name: "read_file".into(), arguments: "{}".into() },
        });
        let b = crate::runtime::CodingRuntimeEvent::Agent(AgentEvent::ToolStarted {
            call: jeikcode_kernel::tool::ToolCall { id: "call-b".into(), name: "read_file".into(), arguments: "{}".into() },
        });
        assert!(reg.push_runtime_event(&"s".into(), 1, a.clone()));
        assert!(reg.push_runtime_event(&"s".into(), 1, b.clone()));
        assert!(!reg.push_runtime_event(&"s".into(), 1, a));
        assert!(!reg.push_runtime_event(&"s".into(), 1, b));
    }

    #[tokio::test]
    async fn atomic_replay_join_recovers_evicted_boundaries_and_repeated_parts() {
        use crate::runtime::CodingRuntimeEvent;
        use jeikcode_kernel::{event::AgentEvent, message::Message, tool::ToolCall};
        let reg = SessionRuntimeRegistry::new();
        let key = "evicted".to_string();
        reg.open_or_attach(key.clone(), PathBuf::from("/p")).unwrap();
        let call = ToolCall { id: "pending-call".into(), name: "read_file".into(), arguments: "{\"path\":\"src/lib.rs\"}".into() };
        let mut previous_round = Message::assistant("completed round", vec![call.clone()]);
        previous_round.id = Some("round-1".into());
        let mut canonical = SessionSnapshot::new(vec![Message::user("work"), previous_round]);
        assert!(reg.push_runtime_event(&key, 1, CodingRuntimeEvent::Agent(AgentEvent::Snapshot { snapshot: canonical.clone() })));
        assert!(reg.push_runtime_event(&key, 1, CodingRuntimeEvent::Agent(AgentEvent::ToolStarted { call })));
        for index in 0..=JOURNAL_CAP {
            assert!(reg.push_runtime_event(&key, 1, CodingRuntimeEvent::Agent(AgentEvent::ToolProgress { call_id: "pending-call".into(), message: format!("progress {index}") })));
        }
        let pending = reg.subscribe_with_snapshot(&key).unwrap();
        assert!(pending.replay[0].replay_gap);
        assert!(!pending.replay.iter().any(|event| matches!(&event.runtime, Some(CodingRuntimeEvent::Agent(AgentEvent::ToolStarted { .. })))));
        assert_eq!(pending.active_tools[0].call.id, "pending-call");
        assert_eq!(pending.snapshot.unwrap(), canonical);
        assert!(reg.push_runtime_event(&key, 1, CodingRuntimeEvent::Agent(AgentEvent::ToolResult {
            result: jeikcode_kernel::tool::ToolResult { call_id: "pending-call".into(), content: "result".into(), is_error: false, images: vec![] },
        })));
        canonical.messages.push(Message::tool_result("pending-call", "result", false));
        assert!(reg.push_runtime_event(&key, 1, CodingRuntimeEvent::Agent(AgentEvent::Snapshot { snapshot: canonical })));
        assert!(reg.push_runtime_event(&key, 1, CodingRuntimeEvent::Agent(AgentEvent::AssistantMessage { message_id: "round-2".into() })));
        assert!(reg.push_runtime_event(&key, 1, CodingRuntimeEvent::Agent(AgentEvent::Reasoning("earlier reasoning".into()))));
        assert!(reg.push_runtime_event(&key, 1, CodingRuntimeEvent::Agent(AgentEvent::TextDelta("earlier text".into()))));
        assert!(reg.push_runtime_event(&key, 1, CodingRuntimeEvent::Agent(AgentEvent::Reasoning("later reasoning".into()))));
        for _ in 0..=JOURNAL_CAP {
            assert!(reg.push_runtime_event(&key, 1, CodingRuntimeEvent::Agent(AgentEvent::TextDelta("x".into()))));
        }
        let mut join = reg.subscribe_with_snapshot(&key).unwrap();
        assert_eq!(join.replay.len(), JOURNAL_CAP);
        assert!(join.replay[0].replay_gap);
        assert!(!join.replay.iter().any(|event| matches!(&event.runtime, Some(CodingRuntimeEvent::Agent(AgentEvent::AssistantMessage { .. } | AgentEvent::ToolStarted { .. })))));
        let snapshot = join.snapshot.as_ref().unwrap();
        assert_eq!(snapshot.messages[1].id.as_deref(), Some("round-1"));
        let draft = snapshot.messages.last().unwrap();
        assert_eq!(draft.id.as_deref(), Some("round-2"));
        assert_eq!(draft.text, format!("earlier text{}", "x".repeat(JOURNAL_CAP + 1)));
        assert_eq!(draft.reasoning.as_deref(), Some("earlier reasoninglater reasoning"));
        assert_eq!(join.assistant_parts.len(), 4);
        assert_eq!(join.assistant_parts[3].stamp.part_id, "round-2:4:text");
        assert!(join.active_tools.is_empty());
        assert!(join.replay.iter().all(|event| event.assistant_part.as_ref().unwrap().part_seq == 4));
        assert!(reg.push_runtime_event(&key, 1, CodingRuntimeEvent::Agent(AgentEvent::Reasoning("future reasoning".into()))));
        let future = join.events.recv().await.unwrap();
        assert!(future.sequence > join.through_sequence.unwrap());
        assert_eq!(future.assistant_part.unwrap().part_id, "round-2:5:reasoning");
    }

    #[test]
    fn native_snapshot_publication_replaces_stale_mutated_registry_aggregate() {
        use crate::runtime::CodingRuntimeEvent;
        use jeikcode_kernel::{event::AgentEvent, message::Message};
        let reg = SessionRuntimeRegistry::new();
        let key = "restored".to_string();
        reg.open_or_attach(key.clone(), PathBuf::from("/p")).unwrap();
        let before = SessionSnapshot::new(vec![Message::user("old"), Message::assistant("removed", vec![])]);
        assert!(reg.set_snapshot(&key, before));
        let mut edited = Message::user("edited");
        edited.id = Some("exact-canonical-user".into());
        let after = SessionSnapshot::new(vec![edited]);
        assert!(reg.push_runtime_event(&key, 2, CodingRuntimeEvent::Agent(AgentEvent::Snapshot { snapshot: after.clone() })));
        assert_eq!(reg.snapshot(&key).unwrap(), after);
        assert_eq!(reg.subscribe_with_snapshot(&key).unwrap().snapshot.unwrap(), after);
    }


    #[tokio::test]
    async fn push_view_event_fans_out_input_accepted() {
        let reg = SessionRuntimeRegistry::new();
        reg.open_or_attach("s".into(), PathBuf::from("/p")).unwrap();
        let (_replay, mut rx) = reg.subscribe(&"s".into(), None).unwrap();
        assert!(reg.push_view_event(
            &"s".into(),
            SessionViewEvent::InputAccepted {
                input: UserInput::from("hello"),
                client_input_id: Some("c1".into()),
                message_id: Some("message-c1".into()),
            },
        ));
        let got = rx.recv().await.expect("view fan-out");
        match got.view {
            Some(SessionViewEvent::InputAccepted {
                input,
                client_input_id,
                message_id,
            }) => {
                assert_eq!(input.text, "hello");
                assert_eq!(client_input_id.as_deref(), Some("c1"));
                assert_eq!(message_id.as_deref(), Some("message-c1"));
            }
            other => panic!("expected InputAccepted, got {other:?}"),
        }
    }

    #[test]
    fn note_terminal_bumps_seq_without_replaying_on_first_sight() {
        let reg = SessionRuntimeRegistry::new();
        reg.open_or_attach("s".into(), PathBuf::from("/p")).unwrap();
        let fresh = reg.lookup(&"s".into()).unwrap();
        assert_eq!(fresh.terminal_seq, 0);
        assert!(fresh.last_terminal.is_none());

        assert!(reg.note_terminal(&"s".into(), "completed"));
        let done = reg.lookup(&"s".into()).unwrap();
        assert_eq!(done.terminal_seq, 1);
        assert_eq!(done.last_terminal.as_deref(), Some("completed"));
        assert_eq!(done.activity, RuntimeActivity::Ready);

        assert!(reg.note_terminal(&"s".into(), "stopped"));
        let stopped = reg.lookup(&"s".into()).unwrap();
        assert_eq!(stopped.terminal_seq, 2);
        assert_eq!(stopped.last_terminal.as_deref(), Some("stopped"));
    }

    #[test]
    fn stop_reason_labels_match_notification_policy() {
        use jeikcode_kernel::event::StopReason;
        assert_eq!(stop_reason_terminal_label(StopReason::Stopped), "completed");
        assert_eq!(stop_reason_terminal_label(StopReason::Cancelled), "stopped");
        assert_eq!(
            stop_reason_terminal_label(StopReason::ProviderError),
            "failed"
        );
        assert_eq!(stop_reason_terminal_label(StopReason::MaxRounds), "stopped");
    }

    #[test]
    fn view_only_rows_are_not_live_turns() {
        assert!(!RuntimeActivity::Starting.is_live_turn());
        assert!(!RuntimeActivity::Ready.is_live_turn());
        assert!(!RuntimeActivity::Reconfiguring.is_live_turn());
        assert!(RuntimeActivity::Running.is_live_turn());
        assert!(RuntimeActivity::WaitingApproval.is_live_turn());
        assert!(RuntimeActivity::WaitingUserInput.is_live_turn());

        let reg = SessionRuntimeRegistry::new();
        reg.open_or_attach("a".into(), PathBuf::from("/p")).unwrap();
        assert!(
            reg.live_turn_session_ids().is_empty(),
            "subscribe/open_or_attach Starting must not occupy /chat/active"
        );
        reg.set_activity(&"a".into(), RuntimeActivity::Running);
        assert!(
            reg.live_turn_session_ids().is_empty(),
            "InputAccepted without a bound handle must not occupy /chat/active"
        );
    }

    #[test]
    fn request_user_input_activity_is_not_approval() {
        use crate::runtime::RuntimeRequest;
        let user_input = crate::runtime::CodingRuntimeEvent::Request(RuntimeRequest {
            id: 1,
            kind: jeikcode_capabilities::tools::request_user_input::REQUEST_USER_INPUT_KIND.into(),
            payload: serde_json::json!({}),
            snapshot: None,
        });
        assert_eq!(
            activity_from_runtime_event(&user_input, RuntimeActivity::Running),
            RuntimeActivity::WaitingUserInput
        );
        let approval = crate::runtime::CodingRuntimeEvent::Request(RuntimeRequest {
            id: 2,
            kind: "approval".into(),
            payload: serde_json::json!({}),
            snapshot: None,
        });
        assert_eq!(
            activity_from_runtime_event(&approval, RuntimeActivity::Running),
            RuntimeActivity::WaitingApproval
        );
    }

    #[test]
    fn provider_fingerprint_round_trips_and_clears() {
        // Cache for an unknown session is `None`.
        let reg = SessionRuntimeRegistry::new();
        assert!(reg.provider_fingerprint(&"missing".into()).is_none());

        // open_or_attach does not synthesize a fingerprint — a freshly opened
        // session still has no cached fingerprint, so the caller knows to
        // treat the next comparison as "unknown → reload required".
        reg.open_or_attach("s".into(), PathBuf::from("/p")).unwrap();
        assert!(reg.provider_fingerprint(&"s".into()).is_none());

        // Explicit set is observable.
        reg.set_provider_fingerprint(&"s".into(), Some("fp-a".into()));
        assert_eq!(
            reg.provider_fingerprint(&"s".into()).as_deref(),
            Some("fp-a"),
        );

        // Overwriting a fingerprint reflects the new value (used after a
        // successful reload).
        reg.set_provider_fingerprint(&"s".into(), Some("fp-b".into()));
        assert_eq!(
            reg.provider_fingerprint(&"s".into()).as_deref(),
            Some("fp-b"),
        );

        // Clearing returns to None so the next comparison can re-detect a
        // bind-vs-request mismatch (e.g. when the runner is torn down).
        reg.set_provider_fingerprint(&"s".into(), None);
        assert!(reg.provider_fingerprint(&"s".into()).is_none());
    }
}
