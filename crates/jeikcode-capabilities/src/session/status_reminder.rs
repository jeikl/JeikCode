//! `StatusReminderHook` — a per-turn `<system-reminder>` tail carrying live runtime status
//! (date + round budget) so the model can pace itself and resolve relative dates ("yesterday")
//! into concrete `after`/`before` for [`recall`](super::recall). This is the **sole**
//! model-facing calendar date (the persona no longer freezes a duplicate `Today's date`).
//! Deliberately DATE-only (no wall-clock time) and with NO context-usage gauge — context
//! pressure is handled silently by auto-compaction, never pushed to the model (see `render`).
//!
//! Cache-safety: appended once per user turn in [`LifecycleHooks::turn_start`] to the
//! **BOTTOM of the current real user message**. This keeps one wire-level user block,
//! avoids role confusion from a separate synthetic user instruction, and remains
//! append-only across tool-loop rounds. An existing date reminder is never rewritten
//! (keyword list changes land on the *next* user turn only). Session-temp long-bash
//! keywords are included only when that overlay is non-empty — same empty-hides
//! lifecycle as the WebUI todo panel. Global `long_bash_command_keyword` is never
//! injected here.
//!
//! The body is wrapped in `<system-reminder>…</system-reminder>` so the model reads it as
//! INJECTED CONTEXT, not the user's own words (matching `PlanModeReminderHook`'s convention).
//! Wall-clock lives in L1 (the kernel is clock-free); this reads the system-local time.

use async_trait::async_trait;
use chrono::{DateTime, Local};
use jeikcode_kernel::hook::{LifecycleHooks, TurnCtx};
use jeikcode_kernel::message::{Conversation, Role};
#[cfg(feature = "tools")]
use std::sync::Arc;

#[cfg(feature = "tools")]
use crate::tools::bash_runtime::{
    legacy_bash_runtime_state, ActiveBackgroundTask, BashRuntimeState,
};

pub(crate) const SESSION_ID_PREFIX: &str = "Current session ID: ";

/// 构建单次注入的会话 ID 提示行，严格约束仅在排查配置目录会话文件或传递工具/技能参数时才读取磁盘会话。
fn format_session_id_line(session_id: &str) -> String {
    format!(
        "{SESSION_ID_PREFIX}{session_id} — Use this ONLY when the user reports session-data anomalies, when invoking a skill or tool that accepts a session ID, or when troubleshooting programmatic bugs such as frontend rendering misalignment or backend message persistence accuracy in the config directory's session files. Otherwise, when the user asks what was discussed earlier or whether you forgot prior conversation, always answer directly from the active conversation context. Inspect the current session file in the config directory if and only if the user explicitly asks to inspect or troubleshoot it."
    )
}

/// Injects a `<system-reminder>` status tail from round 2 of each turn onward.
pub struct StatusReminderHook {
    #[cfg(feature = "tools")]
    bash_runtime: Arc<BashRuntimeState>,
    session_id: Option<String>,
}

impl StatusReminderHook {
    pub fn new() -> Self {
        Self {
            #[cfg(feature = "tools")]
            bash_runtime: legacy_bash_runtime_state(),
            session_id: None,
        }
    }

    /// 绑定当前会话 ID，供首轮或缺少该标记的旧会话在发送前于最新用户提问尾部补注一次。
    pub fn with_session_id(mut self, session_id: impl Into<String>) -> Self {
        let id = session_id.into();
        let trimmed = id.trim();
        self.session_id = (!trimmed.is_empty()).then(|| trimmed.to_string());
        self
    }

    #[cfg(feature = "tools")]
    pub fn with_runtime_state(bash_runtime: Arc<BashRuntimeState>) -> Self {
        Self {
            bash_runtime,
            session_id: None,
        }
    }

    fn effective_session_id(&self) -> Option<String> {
        if let Some(id) = self
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(id.to_string());
        }
        #[cfg(feature = "tools")]
        {
            self.bash_runtime
                .session_id()
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty())
        }
        #[cfg(not(feature = "tools"))]
        {
            None
        }
    }

    /// 快速扫描全部后端上下文：仅当上下文中尚未包含当前会话 ID 标记时才返回待注入的 ID。
    fn pending_session_id_for_turn(&self, convo: &Conversation) -> Option<String> {
        let sid = self.effective_session_id()?;
        let needle = format!("{SESSION_ID_PREFIX}{sid}");
        let already_injected = convo
            .messages
            .iter()
            .any(|message| message.text.contains(&needle));
        (!already_injected).then_some(sid)
    }

    /// Build the `<system-reminder>` body from wall-clock `now` and the turn context. Pure
    /// (clock + ctx injected) so it is unit-testable without a running agent.
    fn render(now: DateTime<Local>, ctx: &TurnCtx) -> String {
        Self::new().render_with_runtime(now, ctx)
    }

    fn render_with_runtime(&self, now: DateTime<Local>, ctx: &TurnCtx) -> String {
        let mut lines = Vec::with_capacity(2);
        // Date + weekday only — NO wall-clock time. The minute-level clock made chatty weak
        // models (e.g. deepseek-v4-flash) editorialize about the hour ("要休息了吗？快 1 点了")
        // instead of working, and relative-date resolution for `recall` needs only the date.
        lines.push(format!(
            "Current date: {} ({})",
            now.format("%Y-%m-%d"),
            now.format("%a")
        ));
        // NO context-window usage line. Pushing a running "X / Y tokens used (Z%)" gauge to the
        // model is a net negative: weak models (deepseek-v4-flash) read it as "almost full" and
        // either rush to a FALSE completion or start reminding the USER to compact — the exact
        // failure we kept seeing. Context pressure is handled where it belongs: SILENTLY, by the
        // auto-compaction trigger (`should_compact` / `AUTO_DRAIN_UTILIZATION`), never surfaced to
        // the model. The user keeps full visibility via the footer gauge and `/context`. This
        // matches codex (auto-compact at a token limit, model never told the %) and opencode
        // (`isOverflow` → silent summarize, model never told remaining tokens). `TurnCtx` still
        // carries `context_window`/`used_tokens` for other consumers (e.g. cc-hooks).
        // Turn round counter — the CURRENT round only, deliberately WITHOUT the
        // `of {max} (max)` ceiling. Surfacing the ceiling ("48 of 50 (max)")
        // reads as a countdown that pressures weaker models (deepseek-v4-flash)
        // into rushing to declare the task "done" before running out of rounds
        // — a FALSE completion that unravels on the next question. A bare
        // progress counter keeps pacing awareness without the countdown.
        // (codex exposes remaining budget as an on-demand tool, not a per-turn
        // push; opencode injects no countdown at all.)
        // (`ctx.max_rounds` stays available to other hooks — e.g. cc-hooks in
        // hooks.rs — it is simply no longer surfaced to the model here.)
        lines.push(format!("Turn round: {}", ctx.round));
        #[cfg(feature = "tools")]
        append_session_long_keyword_lines(self.bash_runtime.as_ref(), &mut lines);
        #[cfg(feature = "tools")]
        append_background_task_lines(self.bash_runtime.as_ref(), &mut lines);
        crate::reminder::system_reminder(&lines.join("\n"))
    }

    fn render_turn_start(&self, now: DateTime<Local>, session_id: Option<&str>) -> String {
        crate::reminder::system_reminder(&self.date_and_session_keywords(now, session_id))
    }

    /// One reminder body: date, optional one-shot session-id notice, then the
    /// session long-bash list only when that overlay has entries. Never a second
    /// `<system-reminder>` wrap.
    fn date_and_session_keywords(&self, now: DateTime<Local>, session_id: Option<&str>) -> String {
        let mut lines = vec![format!(
            "Current date: {} ({})",
            now.format("%Y-%m-%d"),
            now.format("%a")
        )];
        if let Some(sid) = session_id.map(str::trim).filter(|s| !s.is_empty()) {
            lines.push(String::new());
            lines.push(format_session_id_line(sid));
        }
        #[cfg(feature = "tools")]
        append_session_long_keyword_lines(self.bash_runtime.as_ref(), &mut lines);
        #[cfg(feature = "tools")]
        append_background_task_lines(self.bash_runtime.as_ref(), &mut lines);
        lines.join("\n")
    }
}

#[cfg(feature = "tools")]
fn append_session_long_keyword_lines(runtime: &BashRuntimeState, lines: &mut Vec<String>) {
    // Session overlay only. Config.toml `long_bash_command_keyword` is global
    // and must not appear here. Empty list → omit (same lifecycle as WebUI todos).
    let kws = runtime.session_long_keywords();
    if kws.is_empty() {
        return;
    }
    lines.push(format!(
        "暂存长bash列表：{}（如果长bash运行效果不达预期，可通过 long_bash_keyword_actions action=delete 取消）",
        kws.join("、")
    ));
}

#[cfg(feature = "tools")]
fn append_background_task_lines(runtime: &BashRuntimeState, lines: &mut Vec<String>) {
    let alerts = runtime.drain_background_alerts();
    if !alerts.is_empty() {
        lines.push("[Background Task Alert]".to_string());
        for a in alerts {
            let exit_info = a
                .exit_code
                .map(|c| format!("exit code {c}"))
                .unwrap_or_else(|| "terminated".to_string());
            // NOT "CRASHED": the status is the WRAPPER shell's own report, so an external
            // stop (taskkill / Stop-Process / job teardown) lands here too — the old
            // wording asserted a crash and pushed models into chasing phantom bugs.
            lines.push(format!(
                "- Background command `{}` (pid {}) exited: {exit_info}. \
                 The status is the wrapper shell's own report, so it also covers an external \
                 stop — ignore this alert if it was stopped deliberately; otherwise inspect its \
                 log (path from the start message).",
                a.command, a.pid
            ));
            if !a.error_tail.is_empty() {
                // "Recent output", NOT "error output": the tail mixes stdout and stderr, and
                // the old label made a healthy startup line look like the cause of a crash.
                lines.push("  Recent output:".to_string());
                for l in a.error_tail.lines() {
                    lines.push(format!("    {l}"));
                }
            }
        }
    }

    let tasks = runtime.active_background_tasks();
    if !tasks.is_empty() {
        lines.push("[Active Background Tasks]".to_string());
        for t in tasks {
            lines.push(active_task_line(&t));
        }
    }
}

/// One `[Active Background Tasks]` row: what runs, the wrapper shell's own pid, and the
/// stop recipe that covers the WHOLE tree (`stop_hint`). The start message carries the
/// workload's own WinPID + Git-Bash pid (see `bash.rs::render_background_pid_block`) —
/// this row stays compact because the tree kill is always sufficient.
#[cfg(feature = "tools")]
fn active_task_line(t: &ActiveBackgroundTask) -> String {
    let pid_label = if cfg!(windows) { "WinPID" } else { "pid" };
    format!(
        "- cmd: `{}` | {pid_label}: {} | status: running | uptime: {}s | stop: {}",
        t.command,
        t.pid,
        t.uptime_secs,
        crate::tools::bash_runtime::stop_hint(t.pid)
    )
}

impl Default for StatusReminderHook {
    fn default() -> Self {
        Self::new()
    }
}

/// 将会话 ID 提示补注到既有用户提问（通常为受 `sacred_floor` 压缩保护的首轮提问）尾部。
fn inject_session_id_into_existing_prompt(text: &mut String, session_id: &str) {
    let needle = format!("{SESSION_ID_PREFIX}{session_id}");
    if text.contains(&needle) {
        return;
    }
    let sid_line = format_session_id_line(session_id);
    const DATE_MARKER: &str = "<system-reminder>\nCurrent date:";
    if let Some(marker_start) = text.rfind(DATE_MARKER) {
        let after_marker = marker_start + "<system-reminder>\n".len();
        if let Some(rel_nl) = text[after_marker..].find('\n') {
            let line_end = after_marker + rel_nl;
            if text[line_end..].contains("</system-reminder>") {
                text.insert_str(line_end, &format!("\n\n{sid_line}"));
                return;
            }
        }
    }
    if !text.is_empty() {
        text.push_str("\n\n");
    }
    text.push_str(&crate::reminder::system_reminder(&sid_line));
}

#[async_trait]
impl LifecycleHooks for StatusReminderHook {
    async fn turn_start(&self, convo: &mut Conversation) {
        let pending_session_id = self.pending_session_id_for_turn(convo);
        let first_real_idx = convo
            .messages
            .iter()
            .position(|m| m.role == Role::User && !m.synthetic);
        let last_real_idx = convo
            .messages
            .iter()
            .rposition(|m| m.role == Role::User && !m.synthetic);
        let (Some(first_idx), Some(last_idx)) = (first_real_idx, last_real_idx) else {
            return;
        };

        // 旧会话（首轮提问与当前提问不是同一条）统一补注到受 `sacred_floor` 保护的首轮提问尾部，
        // 避免落到后续轮次后在上下文压缩时被摘要裁掉。
        let session_id_for_query = if first_idx < last_idx {
            if let Some(sid) = pending_session_id.as_deref() {
                inject_session_id_into_existing_prompt(&mut convo.messages[first_idx].text, sid);
            }
            None
        } else {
            pending_session_id
        };

        let query = &mut convo.messages[last_idx];
        if query.text.contains("<system-reminder>\nCurrent date:") {
            if let Some(sid) = session_id_for_query.as_deref() {
                inject_session_id_into_existing_prompt(&mut query.text, sid);
            }
            return;
        }
        query.text.push_str("\n\n");
        query
            .text
            .push_str(&self.render_turn_start(Local::now(), session_id_for_query.as_deref()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use jeikcode_kernel::message::Message;

    fn ctx(round: u32, window: u32, used: u32) -> TurnCtx {
        TurnCtx {
            round,
            max_rounds: Some(50),
            context_window: window,
            used_tokens: used,
            ..Default::default()
        }
    }

    #[test]
    fn render_has_date_context_and_round_wrapped() {
        let dt = Local
            .with_ymd_and_hms(2026, 6, 15, 17, 34, 0)
            .single()
            .unwrap();
        let s = StatusReminderHook::render(dt, &ctx(3, 128_000, 40_000));
        assert!(
            s.starts_with("<system-reminder>") && s.ends_with("</system-reminder>"),
            "must be wrapped so the model knows it's injected: {s}"
        );
        // Date + weekday only (no wall-clock HH:MM): the minute-level time made chatty weak
        // models (deepseek-v4-flash) editorialize ("要休息了吗？快 1 点了"), and relative-date
        // resolution for `recall` needs only the date.
        assert!(s.contains("Current date: 2026-06-15 (Mon)"), "{s}");
        assert!(
            !s.contains("local time"),
            "must not carry wall-clock time: {s}"
        );
        assert!(!s.contains("17:34"), "must not carry wall-clock time: {s}");
        // NO context-usage gauge is pushed to the model, even when the window IS known —
        // pressure is handled silently by auto-compaction (matches codex/opencode).
        assert!(
            !s.contains("Context window"),
            "must not push a context-usage gauge: {s}"
        );
        assert!(!s.contains('%'), "must not push any usage percentage: {s}");
        // Round counter shows the CURRENT round only — the `of N (max)` ceiling
        // is deliberately NOT surfaced (countdown pressures weak models into
        // false completions; see render()).
        assert!(s.contains("Turn round: 3"), "round counter: {s}");
        assert!(!s.contains("(max)"), "no countdown ceiling: {s}");
        assert!(!s.contains("of 50"), "no `of N` countdown framing: {s}");
    }

    #[test]
    fn render_never_injects_context_usage_even_at_high_pressure() {
        // The window is known AND nearly full — the exact case the old code injected a scary
        // "Context window: … (95%)". It must NOT be surfaced to the model: pressure is handled
        // silently by auto-compaction, and pushing the gauge made weak models false-complete or
        // nag the user to compact. Only date + round remain.
        let dt = Local
            .with_ymd_and_hms(2026, 6, 15, 9, 0, 0)
            .single()
            .unwrap();
        let s = StatusReminderHook::render(dt, &ctx(2, 128_000, 121_600));
        assert!(
            !s.contains("Context window"),
            "no context-usage gauge pushed to the model: {s}"
        );
        assert!(
            !s.contains('%'),
            "no usage percentage pushed to the model: {s}"
        );
        assert!(s.contains("Current date"), "date is still carried: {s}");
        assert!(s.contains("Turn round: 2"), "{s}");
        assert!(!s.contains("(max)"), "no countdown ceiling: {s}");
    }

    #[test]
    #[cfg(feature = "tools")]
    fn render_injects_session_long_keywords_when_present() {
        let runtime = Arc::new(BashRuntimeState::new());
        runtime.set_live_long_keywords(vec!["ninja".into(), "webpack".into()]);
        let hook = StatusReminderHook::with_runtime_state(runtime);
        let dt = Local
            .with_ymd_and_hms(2026, 6, 15, 9, 0, 0)
            .single()
            .unwrap();
        let s = hook.render_with_runtime(dt, &ctx(2, 128_000, 1_000));
        assert_eq!(
            s.matches("<system-reminder>").count(),
            1,
            "date and long-bash list must share one reminder: {s}"
        );
        assert!(
            s.contains("Current date: 2026-06-15 (Mon)"),
            "date stays in the same reminder: {s}"
        );
        assert!(
            s.contains("暂存长bash列表：ninja、webpack")
                && s.contains("long_bash_keyword_actions")
                && s.contains("action=delete"),
            "{s}"
        );
    }

    #[test]
    #[cfg(feature = "tools")]
    fn render_omits_session_keywords_when_overlay_is_empty() {
        let runtime = Arc::new(BashRuntimeState::new());
        let hook = StatusReminderHook::with_runtime_state(runtime);
        let dt = Local
            .with_ymd_and_hms(2026, 6, 15, 9, 0, 0)
            .single()
            .unwrap();
        let s = hook.render_with_runtime(dt, &ctx(2, 128_000, 1_000));
        assert!(s.contains("Current date"), "{s}");
        assert!(
            !s.contains("暂存长bash列表"),
            "empty session overlay must not inject: {s}"
        );
    }

    #[tokio::test]
    #[cfg(feature = "tools")]
    async fn turn_start_keeps_prefix_stable_when_keywords_appear_later() {
        let runtime = Arc::new(BashRuntimeState::new());
        let hook = StatusReminderHook::with_runtime_state(Arc::clone(&runtime));
        let mut convo = Conversation::default();
        convo.messages = vec![Message::user("你好")];
        hook.turn_start(&mut convo).await;
        let first = convo.messages[0].text.clone();
        assert!(
            first.starts_with("你好\n\n<system-reminder>\nCurrent date:")
                && first.matches("<system-reminder>").count() == 1
                && !first.contains("暂存长bash列表"),
            "first injection is date-only in one reminder: {first}"
        );

        runtime.set_live_long_keywords(vec!["ninja".into()]);
        hook.turn_start(&mut convo).await;
        assert_eq!(
            convo.messages[0].text, first,
            "already-written reminder must not be rewritten (prefix stability)"
        );

        convo.messages.push(Message::user("下一句"));
        hook.turn_start(&mut convo).await;
        let second = &convo.messages[1].text;
        assert!(
            second.starts_with("下一句\n\n<system-reminder>\nCurrent date:")
                && second.contains("暂存长bash列表：ninja")
                && second.matches("<system-reminder>").count() == 1,
            "next user turn gets date + list in the same reminder: {second}"
        );
        assert_eq!(convo.messages[0].text, first);
    }

    #[test]
    #[cfg(feature = "tools")]
    fn active_task_line_carries_pid_and_stop_recipe() {
        // Regression: the row used to show only cmd/status/uptime, so the model had to
        // GUESS how to stop the task — and guessed wrong on Windows (MSYS `kill` cannot
        // see the wrapper's Windows pid). The row now carries the pid and the recipe.
        let line = active_task_line(&crate::tools::bash_runtime::ActiveBackgroundTask {
            pid: 4242,
            command: "python -m http.server 8899".into(),
            uptime_secs: 933,
        });
        assert!(line.contains(": 4242"), "{line}");
        assert!(
            line.contains("taskkill /F /T /PID 4242") || line.contains("kill -TERM -4242"),
            "{line}"
        );
    }

    #[tokio::test]
    async fn turn_start_appends_date_to_query_bottom() {
        let hook = StatusReminderHook::new();
        let mut convo = Conversation::default();
        convo.messages = vec![Message::system("s"), Message::user("hi")];
        hook.turn_start(&mut convo).await;
        assert_eq!(convo.messages.len(), 2);
        assert!(!convo.messages[1].synthetic);
        assert!(
            convo.messages[1]
                .text
                .starts_with("hi\n\n<system-reminder>")
                && convo.messages[1].text.contains("Current date"),
            "date reminder is appended inside the real query block: {:?}",
            convo.messages[1].text
        );
        assert!(!convo.messages[1].text.contains("Turn round"));
        let before = convo.messages.clone();
        hook.turn_start(&mut convo).await;
        assert_eq!(
            convo.messages, before,
            "second turn_start on the same query is idempotent"
        );
    }

    #[test]
    #[cfg(feature = "tools")]
    fn background_alert_is_one_shot_drained() {
        use crate::tools::bash_runtime::BackgroundAlert;

        let runtime = BashRuntimeState::new();
        runtime.push_background_alert(BackgroundAlert {
            pid: 5173,
            command: "npm run dev".into(),
            exit_code: Some(1),
            error_tail: "Error: Port 5173 is already in use".into(),
        });

        let mut lines = Vec::new();
        append_background_task_lines(&runtime, &mut lines);
        let joined = lines.join("\n");
        assert!(joined.contains("[Background Task Alert]"));
        assert!(joined.contains("npm run dev"));
        assert!(joined.contains("Port 5173 is already in use"));

        // Second call: already drained, alert disappears completely!
        let mut lines2 = Vec::new();
        append_background_task_lines(&runtime, &mut lines2);
        let joined2 = lines2.join("\n");
        assert!(!joined2.contains("[Background Task Alert]"));
    }

    #[test]
    #[cfg(feature = "tools")]
    fn reminder_state_is_runtime_scoped() {
        let a = Arc::new(BashRuntimeState::new());
        let b = Arc::new(BashRuntimeState::new());
        a.set_live_long_keywords(vec!["ninja".into()]);
        b.set_live_long_keywords(vec!["webpack".into()]);
        a.push_background_alert(crate::tools::bash_runtime::BackgroundAlert {
            pid: 1001,
            command: "ninja -C build".into(),
            exit_code: Some(1),
            error_tail: "a-only".into(),
        });
        let hook_a = StatusReminderHook::with_runtime_state(a);
        let hook_b = StatusReminderHook::with_runtime_state(b);
        let dt = Local
            .with_ymd_and_hms(2026, 6, 15, 9, 0, 0)
            .single()
            .unwrap();

        let a_text = hook_a.render_with_runtime(dt, &ctx(2, 128_000, 1_000));
        let b_text = hook_b.render_with_runtime(dt, &ctx(2, 128_000, 1_000));
        assert!(a_text.contains("ninja"));
        assert!(!a_text.contains("webpack"));
        assert!(b_text.contains("webpack"));
        assert!(!b_text.contains("ninja"));
    }

    #[tokio::test]
    async fn turn_start_injects_session_id_once_below_date_and_skips_later_turns() {
        let hook = StatusReminderHook::new().with_session_id("sess-abc-123");
        let mut convo = Conversation::default();
        convo.messages = vec![Message::system("sys"), Message::user("第一轮提问")];
        hook.turn_start(&mut convo).await;

        let first = &convo.messages[1].text;
        assert!(first.starts_with("第一轮提问\n\n<system-reminder>\nCurrent date:"));
        assert!(
            first.contains("\n\nCurrent session ID: sess-abc-123 — "),
            "session-id must sit right below the date separated by a blank line: {first}"
        );
        assert_eq!(
            crate::session::user_text_for_display(std::path::Path::new(""), first),
            "第一轮提问",
            "display stripping must still hide the entire reminder block"
        );

        // 第二轮提问：后端上下文中已包含当前会话 ID，不再重复注入。
        convo
            .messages
            .push(Message::assistant("第一轮回答", Vec::new()));
        convo.messages.push(Message::user("第二轮提问"));
        hook.turn_start(&mut convo).await;

        let second = &convo.messages[3].text;
        assert!(second.starts_with("第二轮提问\n\n<system-reminder>\nCurrent date:"));
        assert!(
            !second.contains(SESSION_ID_PREFIX),
            "second turn must not repeat session-id injection: {second}"
        );
    }

    #[tokio::test]
    async fn turn_start_backfills_session_id_once_into_protected_first_user_turn() {
        let hook = StatusReminderHook::new().with_session_id("sess-legacy-999");
        let mut convo = Conversation::default();
        // 旧版本上下文里只有普通对话（哪怕聊到过 sessionid 字样），没有结构化注入标记。
        convo.messages = vec![
            Message::system("sys"),
            Message::user(
                "之前讨论过 sessionid 是啥\n\n<system-reminder>\nCurrent date: 2026-10-01 (Thu)\n</system-reminder>",
            ),
            Message::assistant("是会话标识", Vec::new()),
            Message::user("帮我查一下会话数据"),
        ];
        hook.turn_start(&mut convo).await;

        assert!(
            convo.messages[1].text.contains(
                "Current date: 2026-10-01 (Thu)\n\nCurrent session ID: sess-legacy-999 — "
            ),
            "first real user turn (inside sacred_floor) must receive one-time backfill below its date: {}",
            convo.messages[1].text
        );
        assert_eq!(
            convo.messages[1].text.matches("<system-reminder>").count(),
            1,
            "must reuse the existing <system-reminder> wrapper on the first turn"
        );
        assert!(
            !convo.messages[3].text.contains(SESSION_ID_PREFIX),
            "latest turn must not carry duplicate session-id when backfilled at the opening: {}",
            convo.messages[3].text
        );
        assert!(
            convo.sacred_floor() > 1
                && convo.messages[..convo.sacred_floor()]
                    .iter()
                    .any(|m| m.text.contains("Current session ID: sess-legacy-999 — ")),
            "session-id must sit inside sacred_floor so compaction never drops it"
        );

        // 之后的新轮次已检测到上述标记，首轮与新轮次均不再重复注入。
        let frozen_first = convo.messages[1].text.clone();
        convo.messages.push(Message::assistant("好的", Vec::new()));
        convo.messages.push(Message::user("继续聊"));
        hook.turn_start(&mut convo).await;
        assert_eq!(convo.messages[1].text, frozen_first);
        assert!(
            !convo.messages[5].text.contains(SESSION_ID_PREFIX),
            "subsequent turn after backfill must not inject again: {}",
            convo.messages[5].text
        );
    }

    #[tokio::test]
    async fn turn_start_backfills_ultra_old_first_turn_without_existing_reminder() {
        let hook = StatusReminderHook::new().with_session_id("sess-ancient-1");
        let mut convo = Conversation::default();
        convo.messages = vec![
            Message::user("很早以前的提问"),
            Message::assistant("早期回答", Vec::new()),
            Message::user("新提问"),
        ];
        hook.turn_start(&mut convo).await;

        assert!(
            convo.messages[0].text.starts_with(
                "很早以前的提问\n\n<system-reminder>\nCurrent session ID: sess-ancient-1 — "
            ),
            "first turn without prior reminder must get wrapped session-id tail: {}",
            convo.messages[0].text
        );
        assert_eq!(
            crate::session::user_text_for_display(
                std::path::Path::new(""),
                &convo.messages[0].text
            ),
            "很早以前的提问"
        );
        assert!(!convo.messages[2].text.contains(SESSION_ID_PREFIX));
    }

    #[tokio::test]
    #[cfg(feature = "tools")]
    async fn turn_start_picks_up_session_id_from_bound_bash_runtime() {
        let runtime = Arc::new(BashRuntimeState::new());
        runtime.bind_session("sess-from-bash-runtime");
        let hook = StatusReminderHook::with_runtime_state(runtime);
        let mut convo = Conversation::default();
        convo.messages = vec![Message::user("hello")];
        hook.turn_start(&mut convo).await;

        assert!(
            convo.messages[0]
                .text
                .contains("\n\nCurrent session ID: sess-from-bash-runtime — "),
            "bound bash_runtime session_id should be injected: {}",
            convo.messages[0].text
        );
    }
}
