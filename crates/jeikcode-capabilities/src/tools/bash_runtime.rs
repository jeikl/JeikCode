//! Live bash registry, session-scoped long-job keywords, idle-decision
//! sentinels, and process-tree busy sampling.
//!
//! Session overlay (`global=false`) is written to the bound session sidecar
//! (`<id>.bashkw.json`) so `/resume` after a JeikCode restart still sees it.
//! `config.toml` is only touched when the model passes `global: true`.

use jeikcode_kernel::tool::ProgressSink;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock, RwLock, Weak};
use std::time::Instant;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

/// Marker in bash output / tool result: the process is still running and the
/// model must promote or kill it. WebUI/TUI keep the original pane inflight.
pub const AWAIT_DECISION_MARK: &str = "[bash-await-decision]";
/// Written to the original pane when `bash_kill_by_id` wins.
pub const KILLED_BY_TOOL_MARK: &str = "[task was canceled by bash kill tool]";
/// Written to the original pane when a keyword promote lands on a live task.
pub const PROMOTED_MARK: &str = "[bash promoted to long job]";

pub struct LiveBash {
    pub pid: u32,
    pub command: String,
    pub promoted: AtomicBool,
    /// First-level idle already elapsed with output but 0 CPU; now on
    /// `second_levell_secs` grace in case a silent compile is about to start.
    pub second_level: AtomicBool,
    pub is_background: AtomicBool,
    pub started_at: Instant,
    pub kill: CancellationToken,
    pub progress: ProgressSink,
    pub ring_buffer: Arc<Mutex<VecDeque<String>>>,
}

impl LiveBash {
    pub fn push_log_line(&self, line: &str) {
        let mut g = self.ring_buffer.lock().unwrap_or_else(|e| e.into_inner());
        if g.len() >= 200 {
            g.pop_front();
        }
        g.push_back(line.to_string());
    }

    pub fn tail_logs(&self, n: usize) -> Vec<String> {
        let g = self.ring_buffer.lock().unwrap_or_else(|e| e.into_inner());
        g.iter()
            .rev()
            .take(n)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BusyKind {
    Yes,
    No,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdleAction {
    /// Keep running; treat this invocation as a batch job.
    AutoPromote,
    /// Pager / REPL / wait-for-key. Kill, keep captured output.
    #[allow(dead_code)]
    KillStuck,
    /// Foreground server. Kill and tell the model to detach.
    #[allow(dead_code)]
    KillResident,
    /// Could not sample CPU; ask the model.
    AwaitDecision,
}

/// Idle expiry: bytes already decided there was no new output.
/// CPU decides whether that silence is work. Disk/network IO is NOT busy:
/// those go through first+second idle and then the model decides.
pub fn classify_idle(has_output: bool, busy: BusyKind, resident: bool) -> IdleAction {
    match busy {
        BusyKind::Yes => IdleAction::AutoPromote,
        BusyKind::No if resident && has_output => IdleAction::KillResident,
        BusyKind::No => IdleAction::KillStuck,
        BusyKind::Unknown if has_output => IdleAction::AwaitDecision,
        BusyKind::Unknown => IdleAction::KillStuck,
    }
}

#[derive(Default)]
struct SessionKeywordBinding {
    /// Bound `<id>.bashkw.json` for this CodingRuntime session.
    path: Option<PathBuf>,
    /// Session overlay only — not seeded from global config.toml.
    keywords: Vec<String>,
}

/// One immutable owner shared by an assembly's parent and child shell tools.
/// Preparing a candidate against shared runtime state cannot rebind old tools.
#[derive(Default)]
pub struct BashSessionOwner {
    session_id: OnceLock<Option<Arc<str>>>,
}

impl BashSessionOwner {
    pub fn bind(
        &self,
        runtime: &Arc<BashRuntimeState>,
        session_id: Option<&str>,
    ) -> std::io::Result<()> {
        if session_id == Some("") {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "bash session owner must not be empty",
            ));
        }
        let owner = self.session_id.get_or_init(|| session_id.map(Arc::from));
        if owner.as_deref() != session_id {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "bash assembly is already bound to a different session owner",
            ));
        }
        if let Some(owner) = owner {
            session_bash_runtimes().bind(owner, runtime);
        }
        Ok(())
    }

    pub(crate) fn session_id(&self) -> Option<Arc<str>> {
        self.session_id.get().cloned().flatten()
    }
}

struct RegisteredBash {
    entry: Arc<LiveBash>,
    /// Captured at creation; rebinding the runtime never transfers existing tasks.
    session_owner: Option<Arc<str>>,
}

/// Mutable bash runtime state owned by one CodingRuntime.
///
/// The process may host multiple sessions concurrently, so live tasks, crash
/// alerts, and session keyword persistence must never be process-global. Callers
/// that compose one runtime should share one `Arc<BashRuntimeState>` across the
/// bash tool, its control tools, child bash tools, and the status reminder hook.
#[derive(Default)]
pub struct BashRuntimeState {
    registry: Mutex<Vec<RegisteredBash>>,
    background_alerts: Mutex<Vec<BackgroundAlert>>,
    /// Keep path + keywords under one lock so a rebind cannot pair one
    /// session's keyword list with another session's sidecar path.
    keyword_binding: RwLock<SessionKeywordBinding>,
    live_tasks_changed: Notify,
}

impl BashRuntimeState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_live_bash(&self, entry: Arc<LiveBash>) {
        self.register_live_bash_owned(entry, None);
    }

    pub(crate) fn register_live_bash_owned(
        &self,
        entry: Arc<LiveBash>,
        session_owner: Option<Arc<str>>,
    ) {
        self.registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(RegisteredBash {
                entry,
                session_owner,
            });
    }

    pub fn unregister_live_bash(&self, pid: u32) {
        self.registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|registered| registered.entry.pid != pid);
        self.live_tasks_changed.notify_waiters();
    }

    pub(crate) fn unregister_live_bash_entry(&self, entry: &Arc<LiveBash>) {
        self.registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|registered| !Arc::ptr_eq(&registered.entry, entry));
        self.live_tasks_changed.notify_waiters();
    }

    pub fn push_background_alert(&self, alert: BackgroundAlert) {
        self.background_alerts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(alert);
    }

    /// Drains this runtime's pending background alerts for one-shot reminder injection.
    pub fn drain_background_alerts(&self) -> Vec<BackgroundAlert> {
        let mut g = self
            .background_alerts
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut *g)
    }

    /// Returns a snapshot of background tasks owned by this runtime.
    pub fn active_background_tasks(&self) -> Vec<ActiveBackgroundTask> {
        let snapshot: Vec<Arc<LiveBash>> = self
            .registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|registered| Arc::clone(&registered.entry))
            .collect();
        snapshot
            .into_iter()
            .filter(|e| e.is_background.load(Ordering::SeqCst))
            .map(|e| ActiveBackgroundTask {
                pid: e.pid,
                command: e.command.clone(),
                uptime_secs: e.started_at.elapsed().as_secs(),
            })
            .collect()
    }

    pub fn get_background_logs(&self, pid: u32, lines: usize) -> Option<Vec<String>> {
        let entry = self.find_live_bash(pid)?;
        Some(entry.tail_logs(lines))
    }

    pub fn find_live_bash(&self, pid: u32) -> Option<Arc<LiveBash>> {
        self.registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|registered| registered.entry.pid == pid)
            .map(|registered| Arc::clone(&registered.entry))
    }

    pub fn session_long_keywords(&self) -> Vec<String> {
        self.keyword_binding
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .keywords
            .clone()
    }

    /// Atomically replace both the session sidecar binding and its loaded overlay.
    pub fn bind_session_long_keywords(&self, path: PathBuf, keywords: Vec<String>) {
        *self
            .keyword_binding
            .write()
            .unwrap_or_else(|e| e.into_inner()) = SessionKeywordBinding {
            path: Some(path),
            keywords,
        };
    }

    fn flush_session_keywords_locked(binding: &SessionKeywordBinding) {
        let Some(path) = binding.path.as_ref() else {
            return;
        };
        let payload = serde_json::json!({
            "v": 1,
            "keywords": binding.keywords,
        });
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, payload.to_string());
    }

    /// Disk config ∪ this runtime's session overlay.
    pub fn effective_long_keywords(&self) -> Vec<String> {
        let mut v = crate::tools::bash::resolve_bash_timeout_config().long_bash_command_keyword;
        for k in self.session_long_keywords() {
            if !v.iter().any(|x| x.eq_ignore_ascii_case(&k)) {
                v.push(k);
            }
        }
        v
    }

    pub fn live_long_keywords(&self) -> Vec<String> {
        self.effective_long_keywords()
    }

    /// Replace the in-memory overlay without writing its sidecar. Primarily used
    /// by tests and callers that already own persistence.
    pub fn set_live_long_keywords(&self, keywords: Vec<String>) {
        self.keyword_binding
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .keywords = keywords;
    }

    pub fn add_live_long_keyword(&self, keyword: &str) -> bool {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            return false;
        }
        let mut binding = self
            .keyword_binding
            .write()
            .unwrap_or_else(|e| e.into_inner());
        if binding
            .keywords
            .iter()
            .any(|k| k.eq_ignore_ascii_case(keyword))
        {
            return false;
        }
        binding.keywords.push(keyword.to_string());
        Self::flush_session_keywords_locked(&binding);
        true
    }

    pub fn remove_live_long_keyword(&self, keyword: &str) -> bool {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            return false;
        }
        let mut binding = self
            .keyword_binding
            .write()
            .unwrap_or_else(|e| e.into_inner());
        let before = binding.keywords.len();
        binding
            .keywords
            .retain(|k| !k.eq_ignore_ascii_case(keyword));
        let changed = binding.keywords.len() != before;
        if changed {
            Self::flush_session_keywords_locked(&binding);
        }
        changed
    }

    /// Promote live bash tasks owned by this runtime whose command contains `keyword`.
    pub fn promote_matching(&self, keyword: &str) -> usize {
        let snapshot: Vec<Arc<LiveBash>> = self
            .registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|registered| Arc::clone(&registered.entry))
            .collect();
        let mut n = 0;
        for e in snapshot {
            if command_matches_keyword(&e.command, keyword)
                && !e.promoted.swap(true, Ordering::SeqCst)
            {
                e.progress
                    .emit(format!("{PROMOTED_MARK} keyword={keyword}\n"));
                n += 1;
            }
        }
        n
    }

    pub fn kill_by_pid(&self, pid: u32) -> bool {
        if let Some(e) = self.find_live_bash(pid) {
            e.kill.cancel();
            true
        } else {
            false
        }
    }

    /// Cancel only foreground live bash tasks owned by this runtime.
    ///
    /// Detached background tasks (`is_background == true`) are exempted, allowing
    /// resident services (dev servers, daemons, FastAPI) to stay alive when a turn
    /// or prompt is cancelled by user stop, steer preemption, or network reconnect.
    pub fn cancel_foreground_live_bash(&self) -> usize {
        let snapshot: Vec<_> = self
            .registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|registered| Arc::clone(&registered.entry))
            .collect();
        let mut cancelled = 0;
        for entry in &snapshot {
            if !entry.is_background.load(Ordering::SeqCst) {
                entry.kill.cancel();
                cancelled += 1;
            }
        }
        cancelled
    }

    /// Cancel every live bash task owned by this runtime.
    ///
    /// Session/project transitions allocate a fresh `BashRuntimeState`. Detached
    /// background tasks do not observe the agent/request cancellation token after
    /// startup, so the outgoing runtime must explicitly signal their task-local
    /// kill tokens at the irrevocable transition boundary.
    pub fn cancel_all_live_bash(&self) -> usize {
        let snapshot: Vec<_> = self
            .registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|registered| Arc::clone(&registered.entry))
            .collect();
        for entry in &snapshot {
            entry.kill.cancel();
        }
        snapshot.len()
    }

    fn background_task_snapshot(&self, session_id: &str) -> Vec<Arc<LiveBash>> {
        self.registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|registered| {
                registered.session_owner.as_deref() == Some(session_id)
                    && registered.entry.is_background.load(Ordering::SeqCst)
            })
            .map(|registered| Arc::clone(&registered.entry))
            .collect()
    }

    pub(crate) async fn wait_for_tasks(&self, tasks: &[Arc<LiveBash>]) {
        loop {
            let changed = self.live_tasks_changed.notified();
            tokio::pin!(changed);
            // Subscribe before inspecting the registry so completion cannot be lost.
            changed.as_mut().enable();
            let pending = self
                .registry
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .any(|registered| {
                    tasks
                        .iter()
                        .any(|task| Arc::ptr_eq(&registered.entry, task))
                });
            if !pending {
                return;
            }
            changed.await;
        }
    }
}

/// Weak ownership directory only; live tasks and their control state stay local
/// to each runtime. Detached task drivers keep their own runtime alive until exit.
#[derive(Default)]
struct SessionBashRuntimes {
    bindings: Mutex<Vec<(Weak<str>, Weak<BashRuntimeState>)>>,
}

impl SessionBashRuntimes {
    fn bind(&self, session_id: &Arc<str>, runtime: &Arc<BashRuntimeState>) {
        let owner = Arc::downgrade(session_id);
        let weak = Arc::downgrade(runtime);
        let mut bindings = self.bindings.lock().unwrap_or_else(|e| e.into_inner());
        bindings.retain(|(owner, state)| owner.strong_count() > 0 && state.strong_count() > 0);
        if !bindings
            .iter()
            .any(|(bound_owner, state)| bound_owner.ptr_eq(&owner) && state.ptr_eq(&weak))
        {
            bindings.push((owner, weak));
        }
    }

    async fn kill_session(&self, session_id: &str) -> usize {
        let runtimes: Vec<_> = {
            let mut bindings = self.bindings.lock().unwrap_or_else(|e| e.into_inner());
            bindings.retain(|(owner, state)| owner.strong_count() > 0 && state.strong_count() > 0);
            let mut runtimes: Vec<Arc<BashRuntimeState>> = Vec::new();
            for (owner, state) in bindings.iter() {
                if owner.upgrade().as_deref() == Some(session_id) {
                    if let Some(runtime) = state.upgrade() {
                        // Reprepared assemblies may have distinct identities for the same
                        // session while sharing one registry; select that registry once.
                        if !runtimes.iter().any(|bound| Arc::ptr_eq(bound, &runtime)) {
                            runtimes.push(runtime);
                        }
                    }
                }
            }
            runtimes
        };
        let pending: Vec<_> = runtimes
            .into_iter()
            .map(|runtime| {
                let tasks = runtime.background_task_snapshot(session_id);
                for task in &tasks {
                    task.kill.cancel();
                }
                (runtime, tasks)
            })
            .collect();
        let count = pending.iter().map(|(_, tasks)| tasks.len()).sum();
        for (runtime, tasks) in pending {
            runtime.wait_for_tasks(&tasks).await;
        }
        count
    }
}

fn session_bash_runtimes() -> &'static SessionBashRuntimes {
    static RUNTIMES: LazyLock<SessionBashRuntimes> = LazyLock::new(SessionBashRuntimes::default);
    &RUNTIMES
}

/// Stop only background tasks explicitly owned by this session, then await the
/// drivers' process reap and exact temporary-log cleanup. No filesystem scan or
/// session-id-derived path is used; unbound host services are never selected.
pub async fn kill_by_session_id(session_id: &str) -> usize {
    session_bash_runtimes().kill_session(session_id).await
}

/// Compatibility state for direct standalone uses of the historical unit tools.
/// Production CodingRuntime assembly should inject its own `Arc<BashRuntimeState>`.
pub fn legacy_bash_runtime_state() -> Arc<BashRuntimeState> {
    static STATE: OnceLock<Arc<BashRuntimeState>> = OnceLock::new();
    Arc::clone(STATE.get_or_init(|| Arc::new(BashRuntimeState::new())))
}

/// Interpreters that must not be auto-promoted as long-job keywords
/// (`python script.py` stays a short probe). Explicit `action=add` still works.
pub fn is_generic_long_keyword(keyword: &str) -> bool {
    matches!(
        keyword.trim().to_ascii_lowercase().as_str(),
        "python"
            | "python3"
            | "python2"
            | "py"
            | "node"
            | "nodejs"
            | "bun"
            | "deno"
            | "java"
            | "javaw"
            | "bash"
            | "sh"
            | "zsh"
            | "dash"
            | "fish"
            | "cmd"
            | "cmd.exe"
            | "powershell"
            | "pwsh"
            | "ruby"
            | "perl"
            | "php"
            | "lua"
    )
}

pub fn cancel_foreground_live_bash() -> usize {
    legacy_bash_runtime_state().cancel_foreground_live_bash()
}

pub fn cancel_all_live_bash() -> usize {
    legacy_bash_runtime_state().cancel_all_live_bash()
}

pub fn register_live_bash(entry: Arc<LiveBash>) {
    legacy_bash_runtime_state().register_live_bash(entry);
}

pub fn unregister_live_bash(pid: u32) {
    legacy_bash_runtime_state().unregister_live_bash(pid);
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackgroundAlert {
    pub pid: u32,
    pub command: String,
    pub exit_code: Option<i32>,
    pub error_tail: String,
}

pub fn push_background_alert(alert: BackgroundAlert) {
    legacy_bash_runtime_state().push_background_alert(alert);
}

/// Drains all pending background alerts for one-shot injection into the next turn reminder.
pub fn drain_background_alerts() -> Vec<BackgroundAlert> {
    legacy_bash_runtime_state().drain_background_alerts()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActiveBackgroundTask {
    pub pid: u32,
    pub command: String,
    pub uptime_secs: u64,
}

/// Returns a snapshot of currently running background tasks.
pub fn active_background_tasks() -> Vec<ActiveBackgroundTask> {
    legacy_bash_runtime_state().active_background_tasks()
}

/// Returns the last `lines` logs for a background task by pid.
pub fn get_background_logs(pid: u32, lines: usize) -> Option<Vec<String>> {
    legacy_bash_runtime_state().get_background_logs(pid, lines)
}

pub fn find_live_bash(pid: u32) -> Option<Arc<LiveBash>> {
    legacy_bash_runtime_state().find_live_bash(pid)
}

pub fn kill_by_pid(pid: u32) -> bool {
    legacy_bash_runtime_state().kill_by_pid(pid)
}

pub fn session_long_keywords() -> Vec<String> {
    legacy_bash_runtime_state().session_long_keywords()
}

/// Bind this process to a session sidecar and load its keywords.
/// Called from CodingRuntime `prepare` on Fresh/Resume/Draft.
pub fn bind_session_long_keywords(path: PathBuf, keywords: Vec<String>) {
    legacy_bash_runtime_state().bind_session_long_keywords(path, keywords);
}

/// Disk config ∪ session overlay. Config wins as persistence; session covers
/// this process without writing `config.toml`.
pub fn effective_long_keywords() -> Vec<String> {
    legacy_bash_runtime_state().effective_long_keywords()
}

pub fn live_long_keywords() -> Vec<String> {
    effective_long_keywords()
}

pub fn set_live_long_keywords(keywords: Vec<String>) {
    legacy_bash_runtime_state().set_live_long_keywords(keywords);
}

pub fn add_live_long_keyword(keyword: &str) -> bool {
    legacy_bash_runtime_state().add_live_long_keyword(keyword)
}

pub fn remove_live_long_keyword(keyword: &str) -> bool {
    legacy_bash_runtime_state().remove_live_long_keyword(keyword)
}

/// Whole-word match (alphanumeric / `_` / `-` / `.`). `a` does not match `cat`.
pub fn command_matches_keyword(command: &str, keyword: &str) -> bool {
    let k = keyword.trim();
    if k.is_empty() {
        return false;
    }
    command
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.'))
        .any(|w| !w.is_empty() && w.eq_ignore_ascii_case(k))
}

pub fn command_matches_any_keyword(command: &str, keywords: &[String]) -> bool {
    keywords.iter().any(|k| command_matches_keyword(command, k))
}

/// Promote every live bash whose command contains `keyword`. Returns how many
/// were newly promoted (already-promoted entries are skipped).
pub fn promote_matching(keyword: &str) -> usize {
    legacy_bash_runtime_state().promote_matching(keyword)
}

/// Parse Linux `/proc/<pid>/stat`. Returns `(pgrp, state, utime+stime ticks)`.
pub fn parse_linux_proc_stat(stat: &str) -> Option<(u32, char, u64)> {
    let after = stat.rsplit_once(')')?.1;
    let mut parts = after.split_whitespace();
    let state = parts.next()?.chars().next()?;
    let _ppid = parts.next()?;
    let pgrp: u32 = parts.next()?.parse().ok()?;
    for _ in 0..8 {
        parts.next()?;
    }
    let utime: u64 = parts.next()?.parse().ok()?;
    let stime: u64 = parts.next()?.parse().ok()?;
    Some((pgrp, state, utime.saturating_add(stime)))
}

#[cfg(test)]
pub fn parse_linux_proc_io(io: &str) -> u64 {
    let mut rchar = 0u64;
    let mut wchar = 0u64;
    for line in io.lines() {
        if let Some(v) = line.strip_prefix("rchar:") {
            rchar = v.trim().parse().unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("wchar:") {
            wchar = v.trim().parse().unwrap_or(0);
        }
    }
    rchar.saturating_add(wchar)
}

/// TCP hex state that means data or a handshake is in flight — not LISTEN
/// (servers sitting idle) and not TIME_WAIT/CLOSE.
#[cfg(test)]
pub fn tcp_hex_state_is_inflight(st: &str) -> bool {
    matches!(st, "01" | "02" | "03" | "04" | "05" | "08" | "09" | "0B")
}

/// `/proc/net/tcp` (and tcp6) line → inode if the connection is in-flight.
#[cfg(test)]
pub fn parse_proc_net_tcp_inflight_inode(line: &str) -> Option<u64> {
    let cols: Vec<&str> = line.split_whitespace().collect();
    // sl local rem st tx:rx tr tm->when retrnsmt uid timeout inode
    if cols.len() < 10 || cols[0] == "sl" {
        return None;
    }
    if !tcp_hex_state_is_inflight(cols[3]) {
        return None;
    }
    cols[9].parse().ok()
}

#[cfg(target_os = "linux")]
struct LinuxSnap {
    cpu: u64,
    runnable: bool,
}

#[cfg(target_os = "linux")]
fn linux_pgroup_snapshot(pgid: u32) -> Option<LinuxSnap> {
    let mut cpu = 0u64;
    let mut runnable = false;
    let mut any = false;
    let dir = std::fs::read_dir("/proc").ok()?;
    for ent in dir.flatten() {
        let name = ent.file_name();
        let Some(s) = name.to_str() else { continue };
        if !s.as_bytes().iter().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let _pid: u32 = match s.parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let path = ent.path();
        let Ok(stat) = std::fs::read_to_string(path.join("stat")) else {
            continue;
        };
        let Some((pgrp, state, ticks)) = parse_linux_proc_stat(&stat) else {
            continue;
        };
        if pgrp != pgid {
            continue;
        }
        any = true;
        cpu = cpu.saturating_add(ticks);
        // Runnable on CPU only. Disk-sleep (D) and ESTABLISHED-TCP-without-CPU
        // are ordinary short-command idle and go through first+second rounds.
        if state == 'R' {
            runnable = true;
        }
    }
    any.then_some(LinuxSnap { cpu, runnable })
}

/// Two 250ms samples of the process tree. `Unknown` when the platform cannot
/// observe CPU (caller should await-decision if there was output).
pub async fn tree_is_busy(
    pgid: Option<u32>,
    #[cfg(windows)] job: &Option<crate::process_utils::JobHandle>,
) -> BusyKind {
    #[cfg(windows)]
    {
        let _ = pgid;
        let Some(j) = job.as_ref() else {
            return BusyKind::Unknown;
        };
        let Some((c1, _)) = j.cpu_and_io() else {
            return BusyKind::Unknown;
        };
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let Some((c2, _)) = j.cpu_and_io() else {
            return BusyKind::Unknown;
        };
        // CPU only. Disk/network byte counters must not auto-promote: those
        // commands take the first+second idle path and the model decides.
        return if c2 > c1 { BusyKind::Yes } else { BusyKind::No };
    }
    #[cfg(target_os = "linux")]
    {
        let Some(pgid) = pgid else {
            return BusyKind::Unknown;
        };
        let Some(a) = linux_pgroup_snapshot(pgid) else {
            return BusyKind::Unknown;
        };
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let Some(b) = linux_pgroup_snapshot(pgid) else {
            return BusyKind::Unknown;
        };
        return if a.runnable || b.runnable || b.cpu > a.cpu {
            BusyKind::Yes
        } else {
            BusyKind::No
        };
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = pgid;
        BusyKind::Unknown
    }
}

pub fn decision_prompt(idle_secs: u64, second_secs: u64, suggested_keyword: &str) -> String {
    format!(
        "{AWAIT_DECISION_MARK}\n\
         This command already printed output, then went silent through first idle \
         ({idle_secs}s) and second-level grace ({second_secs}s). \
         It is STILL RUNNING in this pane.\n\
         If you were running a network-IO or disk-IO command, this likely means the \
         task has timed out — stop the process if unneeded.\n\
         Only if after careful consideration you still believe it is making progress, \
         upgrade it to a temporary long bash with `long_bash_keyword_actions` \
         {{\"action\":\"add\",\"keyword\":\"{suggested_keyword}\"}} \
         (global defaults to false: this session only, survives JeikCode restart on resume).\n\
         Do not start a replacement bash. Output of add stays on this pane."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_idle_matrix() {
        use BusyKind::*;
        use IdleAction::*;
        assert_eq!(classify_idle(false, Yes, false), AutoPromote);
        assert_eq!(classify_idle(true, Yes, false), AutoPromote);
        assert_eq!(classify_idle(false, No, false), KillStuck);
        assert_eq!(classify_idle(true, No, false), KillStuck);
        assert_eq!(classify_idle(true, No, true), KillResident);
        assert_eq!(classify_idle(false, No, true), KillStuck);
        assert_eq!(classify_idle(true, Unknown, false), AwaitDecision);
        assert_eq!(classify_idle(false, Unknown, false), KillStuck);
    }

    #[test]
    fn parse_linux_proc_io_sums_rchar_wchar() {
        let io = "rchar: 100\nwchar: 23\nsyscr: 1\nread_bytes: 0\nwrite_bytes: 0\n";
        assert_eq!(parse_linux_proc_io(io), 123);
    }

    #[test]
    fn inflight_tcp_excludes_listen() {
        assert!(tcp_hex_state_is_inflight("01"));
        assert!(tcp_hex_state_is_inflight("02"));
        assert!(!tcp_hex_state_is_inflight("0A"));
        assert!(!tcp_hex_state_is_inflight("06"));
        let line = "   0: 0100007F:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1";
        assert_eq!(parse_proc_net_tcp_inflight_inode(line), None);
        let est = "   1: 0100007F:0050 0100007F:E24A 01 00000000:00000000 00:00000000 00000000     0        0 99999 1";
        assert_eq!(parse_proc_net_tcp_inflight_inode(est), Some(99999));
    }

    #[test]
    fn parse_linux_stat_extracts_pgrp_state_cpu() {
        // fields 14-15 (utime/stime) sit after state,ppid,pgrp + 8 more.
        let line = "42 (gcc) R 1 42 42 0 -1 0 0 0 0 0 100 50 0 0 0";
        let (pgrp, state, cpu) = parse_linux_proc_stat(line).unwrap();
        assert_eq!(pgrp, 42);
        assert_eq!(state, 'R');
        assert_eq!(cpu, 150);
    }

    #[test]
    fn generic_interpreters_are_not_auto_keyword_material() {
        assert!(is_generic_long_keyword("python"));
        assert!(is_generic_long_keyword("Node"));
        assert!(!is_generic_long_keyword("ninja"));
        assert!(!is_generic_long_keyword("webpack"));
    }

    #[test]
    fn session_sidecar_round_trips_keywords() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sess.bashkw.json");
        let state = BashRuntimeState::new();
        state.bind_session_long_keywords(path.clone(), Vec::new());
        assert!(state.add_live_long_keyword("ninja"));
        assert!(!state.add_live_long_keyword("Ninja"));
        let raw = std::fs::read_to_string(&path).expect("sidecar written");
        assert!(raw.contains("ninja"), "{raw}");
        assert!(state.remove_live_long_keyword("ninja"));
        let raw2 = std::fs::read_to_string(&path).unwrap();
        assert!(!raw2.contains("ninja"), "{raw2}");
    }

    #[test]
    fn runtime_states_isolate_keyword_sidecars() {
        let dir = tempfile::tempdir().unwrap();
        let a_path = dir.path().join("a.bashkw.json");
        let b_path = dir.path().join("b.bashkw.json");
        let a = BashRuntimeState::new();
        let b = BashRuntimeState::new();
        a.bind_session_long_keywords(a_path.clone(), Vec::new());
        b.bind_session_long_keywords(b_path.clone(), Vec::new());

        assert!(a.add_live_long_keyword("ninja"));
        assert_eq!(a.session_long_keywords(), vec!["ninja"]);
        assert!(b.session_long_keywords().is_empty());
        assert!(std::fs::read_to_string(&a_path).unwrap().contains("ninja"));
        assert!(!b_path.exists(), "B sidecar must not be touched by A");
    }

    #[test]
    fn keyword_rebind_replaces_path_and_keywords_as_one_binding() {
        let dir = tempfile::tempdir().unwrap();
        let first_path = dir.path().join("first.bashkw.json");
        let second_path = dir.path().join("second.bashkw.json");
        let state = BashRuntimeState::new();

        state.bind_session_long_keywords(first_path.clone(), Vec::new());
        assert!(state.add_live_long_keyword("first"));
        let first_before = std::fs::read_to_string(&first_path).unwrap();

        state.bind_session_long_keywords(second_path.clone(), vec!["second".into()]);
        assert!(state.add_live_long_keyword("third"));

        assert_eq!(
            std::fs::read_to_string(&first_path).unwrap(),
            first_before,
            "rebind must never flush the new overlay to the old path"
        );
        let second = std::fs::read_to_string(&second_path).unwrap();
        assert!(second.contains("second"), "{second}");
        assert!(second.contains("third"), "{second}");
        assert!(!second.contains("first"), "{second}");
    }

    #[test]
    fn background_alerts_are_runtime_scoped() {
        let a = BashRuntimeState::new();
        let b = BashRuntimeState::new();
        a.push_background_alert(BackgroundAlert {
            pid: 101,
            command: "a-cmd".into(),
            exit_code: Some(1),
            error_tail: "a-error".into(),
        });
        b.push_background_alert(BackgroundAlert {
            pid: 102,
            command: "b-cmd".into(),
            exit_code: Some(2),
            error_tail: "b-error".into(),
        });

        assert_eq!(a.drain_background_alerts()[0].pid, 101);
        assert_eq!(b.drain_background_alerts()[0].pid, 102);
        assert!(a.drain_background_alerts().is_empty());
    }

    fn live(pid: u32, command: &str) -> Arc<LiveBash> {
        Arc::new(LiveBash {
            pid,
            command: command.into(),
            promoted: AtomicBool::new(false),
            second_level: AtomicBool::new(false),
            is_background: AtomicBool::new(true),
            started_at: Instant::now(),
            kill: CancellationToken::new(),
            progress: ProgressSink::default(),
            ring_buffer: Arc::new(Mutex::new(VecDeque::new())),
        })
    }

    #[test]
    fn live_registry_control_is_runtime_scoped() {
        let a = BashRuntimeState::new();
        let b = BashRuntimeState::new();
        let a_task = live(1001, "ninja -C build");
        let b_task = live(1002, "ninja -C build");
        a.register_live_bash(Arc::clone(&a_task));
        b.register_live_bash(Arc::clone(&b_task));

        assert!(b.find_live_bash(1001).is_none());
        assert!(!b.kill_by_pid(1001));
        assert!(!a_task.kill.is_cancelled());
        assert_eq!(a.promote_matching("ninja"), 1);
        assert!(a_task.promoted.load(Ordering::SeqCst));
        assert!(!b_task.promoted.load(Ordering::SeqCst));
        assert_eq!(a.active_background_tasks().len(), 1);
        assert_eq!(b.active_background_tasks().len(), 1);

        assert!(a.kill_by_pid(1001));
        assert!(a_task.kill.is_cancelled());
        assert!(!b_task.kill.is_cancelled());
    }

    #[test]
    fn cancel_foreground_live_bash_exempts_background_tasks() {
        let state = BashRuntimeState::new();
        let mut fg_task = live(2001, "cargo test");
        // Make fg an actual foreground task
        Arc::get_mut(&mut fg_task)
            .unwrap()
            .is_background
            .store(false, Ordering::SeqCst);
        let bg_task = live(2002, "python -m uvicorn main:app");

        state.register_live_bash(Arc::clone(&fg_task));
        state.register_live_bash(Arc::clone(&bg_task));

        // Cancelling foreground only kills fg, leaves bg intact
        assert_eq!(state.cancel_foreground_live_bash(), 1);
        assert!(fg_task.kill.is_cancelled());
        assert!(!bg_task.kill.is_cancelled());

        // cancel_all_live_bash kills all including background
        assert_eq!(state.cancel_all_live_bash(), 2);
        assert!(bg_task.kill.is_cancelled());
    }

    #[test]
    fn cancelling_outgoing_runtime_only_signals_its_own_live_tasks() {
        let outgoing = BashRuntimeState::new();
        let incoming = BashRuntimeState::new();
        let a = live(3001, "server-a");
        let b = live(3002, "server-b");
        let next = live(3003, "server-next");
        outgoing.register_live_bash(Arc::clone(&a));
        outgoing.register_live_bash(Arc::clone(&b));
        incoming.register_live_bash(Arc::clone(&next));

        assert_eq!(outgoing.cancel_all_live_bash(), 2);
        assert!(a.kill.is_cancelled());
        assert!(b.kill.is_cancelled());
        assert!(!next.kill.is_cancelled());
    }

    #[tokio::test]
    async fn session_background_cleanup_preserves_assembly_owners_and_unowned_tasks() {
        let runtime = Arc::new(BashRuntimeState::new());
        let host = live(4001, "host-service");
        runtime.register_live_bash(Arc::clone(&host));

        let old_owner = BashSessionOwner::default();
        old_owner.bind(&runtime, Some("cleanup-unit-old")).unwrap();
        let old_task = live(4002, "old-service");
        runtime.register_live_bash_owned(Arc::clone(&old_task), old_owner.session_id());

        let candidate_owner = BashSessionOwner::default();
        candidate_owner
            .bind(&runtime, Some("cleanup-unit-next"))
            .unwrap();
        assert!(old_owner.bind(&runtime, Some("cleanup-unit-next")).is_err());
        assert_eq!(old_owner.session_id().as_deref(), Some("cleanup-unit-old"));
        let next_task = live(4003, "next-service");
        runtime.register_live_bash_owned(Arc::clone(&next_task), candidate_owner.session_id());
        drop(candidate_owner);

        // Old tools may create more tasks even after a candidate was prepared/discarded.
        let late_old_task = live(4004, "late-old-service");
        runtime.register_live_bash_owned(Arc::clone(&late_old_task), old_owner.session_id());
        let foreground = live(4005, "foreground-command");
        foreground.is_background.store(false, Ordering::SeqCst);
        runtime.register_live_bash_owned(Arc::clone(&foreground), old_owner.session_id());

        let cleanup = kill_by_session_id("cleanup-unit-old");
        tokio::pin!(cleanup);
        assert!(futures::poll!(cleanup.as_mut()).is_pending());
        assert!(old_task.kill.is_cancelled());
        assert!(late_old_task.kill.is_cancelled());
        assert!(!next_task.kill.is_cancelled());
        assert!(!host.kill.is_cancelled());
        assert!(!foreground.kill.is_cancelled());

        runtime.unregister_live_bash_entry(&old_task);
        assert!(futures::poll!(cleanup.as_mut()).is_pending());
        runtime.unregister_live_bash_entry(&late_old_task);
        assert_eq!(cleanup.await, 2);
        assert_eq!(kill_by_session_id("cleanup-unit-old").await, 0);
        assert_eq!(kill_by_session_id("../../cleanup-unit-old").await, 0);
        assert!(runtime.find_live_bash(host.pid).is_some());
        assert!(runtime.find_live_bash(next_task.pid).is_some());
    }

    #[tokio::test]
    async fn session_background_cleanup_covers_runtime_generations_and_already_ended_tasks() {
        let first = Arc::new(BashRuntimeState::new());
        let second = Arc::new(BashRuntimeState::new());
        let owner = BashSessionOwner::default();
        owner
            .bind(&first, Some("cleanup-unit-generations"))
            .unwrap();
        owner
            .bind(&second, Some("cleanup-unit-generations"))
            .unwrap();
        let reprepared_owner = BashSessionOwner::default();
        reprepared_owner
            .bind(&first, Some("cleanup-unit-generations"))
            .unwrap();
        let ended = live(5001, "ended");
        first.register_live_bash_owned(Arc::clone(&ended), owner.session_id());
        first.unregister_live_bash_entry(&ended);
        let old = live(5002, "old-generation");
        let current = live(5003, "current-generation");
        old.kill.cancel();
        first.register_live_bash_owned(Arc::clone(&old), owner.session_id());
        second.register_live_bash_owned(Arc::clone(&current), owner.session_id());

        let cleanup = kill_by_session_id("cleanup-unit-generations");
        tokio::pin!(cleanup);
        assert!(futures::poll!(cleanup.as_mut()).is_pending());
        assert!(current.kill.is_cancelled());
        assert!(!ended.kill.is_cancelled());
        first.unregister_live_bash_entry(&old);
        assert!(futures::poll!(cleanup.as_mut()).is_pending());
        second.unregister_live_bash_entry(&current);
        assert_eq!(cleanup.await, 2);
        drop(first);
        drop(second);
        assert_eq!(kill_by_session_id("cleanup-unit-generations").await, 0);
    }

    #[test]
    fn session_background_cleanup_owner_binding_rejects_empty_and_rebound_owners() {
        let runtime = Arc::new(BashRuntimeState::new());
        let owner = BashSessionOwner::default();
        assert_eq!(
            owner.bind(&runtime, Some("")).unwrap_err().kind(),
            std::io::ErrorKind::InvalidInput
        );
        owner.bind(&runtime, None).unwrap();
        owner.bind(&runtime, None).unwrap();
        assert!(owner.bind(&runtime, Some("session")).is_err());
        assert!(owner.session_id().is_none());
    }

    #[tokio::test]
    async fn session_background_cleanup_late_completion_does_not_remove_a_reused_pid() {
        let runtime = Arc::new(BashRuntimeState::new());
        let owner = BashSessionOwner::default();
        owner
            .bind(&runtime, Some("cleanup-unit-reused-pid"))
            .unwrap();
        let ended = live(6001, "old-task-awaiting-log-cleanup");
        let replacement = live(6001, "unowned-task-with-reused-pid");
        runtime.register_live_bash_owned(Arc::clone(&ended), owner.session_id());
        runtime.register_live_bash(Arc::clone(&replacement));

        let cleanup = kill_by_session_id("cleanup-unit-reused-pid");
        tokio::pin!(cleanup);
        assert!(futures::poll!(cleanup.as_mut()).is_pending());
        assert!(ended.kill.is_cancelled());
        assert!(!replacement.kill.is_cancelled());
        runtime.unregister_live_bash_entry(&ended);
        assert_eq!(cleanup.await, 1);
        assert!(Arc::ptr_eq(
            &runtime.find_live_bash(6001).unwrap(),
            &replacement
        ));
        assert!(!replacement.kill.is_cancelled());
    }

    #[test]
    fn keyword_is_whole_word() {
        assert!(command_matches_keyword("systemctl status foo", "status"));
        assert!(command_matches_keyword("./ninja -C build", "ninja"));
        assert!(!command_matches_keyword("cat file", "a"));
        assert!(!command_matches_keyword("catch me", "cat"));
        assert!(command_matches_keyword("CAT file", "cat"));
    }
}
