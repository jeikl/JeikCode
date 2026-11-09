//! `TodoHook` — manages the live todo list state for the session (TUI / WebUI sync)
//! and provides a quiet safety-net via `offer_continuation` when actionable work was
//! performed but open items remain uncompleted.
//!
//! Note: Per architecture alignment with OpenCode / Grok Build conventions, dynamic
//! turn-start task list re-announcements have been retired in favor of the permanent,
//! static System 3 (`<todo_rules>`) guidelines.
//!
//! Architecture: ONE checklist per session. The session [`TodoBoard`] is the single
//! source of truth; the live vector is only the working copy the tool mutates while
//! a turn runs. The transcript is never folded to rebuild the checklist — a folded
//! transcript is a reconstruction that drifts (compaction drops the baseline, a
//! closed board looks open again), so it can never decide what to do.

use async_trait::async_trait;
use jeikcode_capabilities::tools::todo::{todo_glyph, TodoItem, TodoLive, TodoStatus};
use jeikcode_kernel::hook::{LifecycleHooks, TurnCtx};
use jeikcode_kernel::message::{Conversation, Message, Role};

/// Injected when the model tries to STOP while the task list still has open items — the
/// residual weak-model gap after incremental `todo` updates land: it does the last item's work
/// (e.g. the closing summary) then ends WITHOUT marking it completed. Nudges at most ONCE
/// per real-user turn (and the kernel `max_continuations` fuse bounds it), so it can never spin.
const TODO_COMPLETION_NUDGE_PREFIX: &str = "Before you finish: the task list still has open items.";

fn format_completion_nudge(todos: &[TodoItem]) -> String {
    let open_items = todos
        .iter()
        .enumerate()
        .filter(|(_, t)| t.status != TodoStatus::Completed)
        .map(|(i, t)| format!("{} {}. {}", todo_glyph(t.status, false), i + 1, t.content))
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "{TODO_COMPLETION_NUDGE_PREFIX}\n\
The following items are NOT completed yet:\n\
{open_items}\n\n\
Guidance:\n\
1. If not done: If the user previously instructed you to complete all tasks, continue driving forward to finish the remaining tasks. If there are uncertainties, items requiring approval or confirmation, or tasks lacking clear intent to proceed, you may stop without completing the remaining tasks, briefly explain to the user, and call `request_user_input` when appropriate to inquire about user intent.\n\
2. If actually completed: Mark all task items as completed via `update` (or emit a new `plan`), and conclude this turn with a concise single sentence."
    )
}

pub struct TodoHook {
    live: Option<TodoLive>,
}

impl Drop for TodoHook {
    fn drop(&mut self) {
        if let Some(live) = &self.live {
            jeikcode_capabilities::tools::unbind_todo_session(live);
        }
    }
}

impl Default for TodoHook {
    fn default() -> Self {
        Self::new()
    }
}

impl TodoHook {
    pub fn new() -> Self {
        Self { live: None }
    }

    pub fn with_live(live: TodoLive) -> Self {
        Self { live: Some(live) }
    }

    fn sync_live(&self, todos: &[TodoItem]) {
        if let Some(live) = &self.live {
            *live.lock().unwrap_or_else(|e| e.into_inner()) = todos.to_vec();
        }
    }

    /// 结束拦截只看会话上的那一份清单：已绑会话就读 board，未绑会话就读 live 副本。
    /// 不再从转录折叠 —— 会话清单是唯一真相，转录里的旧 todowrite 不足以重建它。
    fn stop_check_items(&self) -> Vec<TodoItem> {
        let Some(live) = &self.live else {
            return Vec::new();
        };
        if let Some(session_id) = jeikcode_capabilities::tools::todo::todo_session_of(live) {
            return jeikcode_capabilities::tools::read_todo_board(&session_id)
                .map(|board| board.items)
                .unwrap_or_default();
        }
        live.lock().unwrap_or_else(|err| err.into_inner()).clone()
    }
}

/// Index of the current real-user turn's start (last non-synthetic user message).
fn current_real_user_start(convo: &Conversation) -> usize {
    convo
        .messages
        .iter()
        .rposition(|m| m.role == Role::User && !m.synthetic)
        .unwrap_or(0)
}

/// True iff the completion nudge was already injected in the CURRENT real-user turn — so we
/// nudge at most once; if the model stops again with open items, we let it end.
fn completion_nudge_already_present(convo: &Conversation) -> bool {
    let start = current_real_user_start(convo);
    convo.messages[start..].iter().any(|m| {
        m.role == Role::User
            && m.synthetic
            && m.text
                .trim_start()
                .starts_with(TODO_COMPLETION_NUDGE_PREFIX)
    })
}

fn is_actionable_tool(name: &str) -> bool {
    jeikcode_capabilities::tools::is_file_mutation_tool(name)
        || jeikcode_capabilities::tools::is_shell_tool_name(name)
        || jeikcode_capabilities::tools::is_todo_tool_name(name)
        || name.eq_ignore_ascii_case("task")
        || name.eq_ignore_ascii_case("cmd")
}

/// True iff the model performed actionable modifications this turn (e.g. edited files,
/// executed commands, updated todos). Pure informational / read-only queries (read, grep,
/// glob, code_explore) and explicit questions to the user (request_user_input) are
/// exempted so normal answering and clarifying questions are never hijacked into continuation.
fn active_work_or_managed_todos_this_turn(convo: &Conversation) -> bool {
    let start = current_real_user_start(convo);
    let turn_msgs = &convo.messages[start..];

    // If the assistant's last message explicitly asked the user for input, exempt from interception
    if let Some(last_asst) = turn_msgs.iter().rev().find(|m| m.role == Role::Assistant) {
        if last_asst
            .tool_calls
            .iter()
            .any(|c| c.name == "request_user_input")
        {
            return false;
        }
    }

    // Only intercept when actual modification or execution tools were called
    turn_msgs
        .iter()
        .any(|m| m.tool_calls.iter().any(|c| is_actionable_tool(&c.name)))
}

#[async_trait]
impl LifecycleHooks for TodoHook {
    async fn pre_request(&self, _messages: &mut Vec<Message>, ctx: &TurnCtx) {
        let Some(live) = &self.live else {
            return;
        };
        let Some(session_id) = ctx.session_id.as_deref() else {
            return;
        };
        jeikcode_capabilities::tools::bind_todo_session(live, session_id);
        let items = jeikcode_capabilities::tools::read_todo_board(session_id)
            .map(|board| board.items)
            .unwrap_or_default();
        self.sync_live(&items);
    }

    async fn turn_start(&self, _convo: &mut Conversation) {
        let Some(live) = &self.live else {
            return;
        };
        let Some(session_id) = jeikcode_capabilities::tools::todo::todo_session_of(live) else {
            return;
        };
        let items = jeikcode_capabilities::tools::read_todo_board(&session_id)
            .map(|board| board.items)
            .unwrap_or_default();
        self.sync_live(&items);
    }

    /// The model wants to stop. If the live checklist still has OPEN items
    /// (pending or in_progress), and actionable work was performed without
    /// answering or asking, inject a one-shot nudge to close them out and
    /// continue the turn. Fires at most once per real-user turn.
    async fn offer_continuation(&self, convo: &Conversation) -> Option<String> {
        let todos = self.stop_check_items();
        let has_open = todos.iter().any(|t| t.status != TodoStatus::Completed);
        if !has_open
            || !active_work_or_managed_todos_this_turn(convo)
            || completion_nudge_already_present(convo)
        {
            return None;
        }
        Some(format_completion_nudge(&todos))
    }

    /// 大轮结束。只有清单已经全部完成时才清掉内存里的实时副本。
    /// 工具调用留在记录里，历史画布仍能画到那一条消息上。还有未完成项时保留，下一轮接着改。
    async fn turn_complete(
        &self,
        _convo: &Conversation,
        _reason: &jeikcode_kernel::event::StopReason,
        ctx: &TurnCtx,
    ) {
        let Some(session_id) = ctx.session_id.as_deref() else {
            return;
        };
        if jeikcode_capabilities::tools::close_todo_board_if_complete(session_id).is_some() {
            self.sync_live(&[]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jeikcode_kernel::hook::LifecycleHooks;
    use jeikcode_kernel::message::Message;
    use jeikcode_kernel::tool::ToolCall;

    fn todowrite_msg(args: &str) -> Message {
        Message::assistant(
            "",
            vec![ToolCall {
                id: "1".into(),
                name: jeikcode_capabilities::tools::TODO_TOOL_NAME.into(),
                arguments: args.into(),
            }],
        )
    }

    fn convo_with(msgs: Vec<Message>) -> Conversation {
        let mut c = Conversation::default();
        c.messages = msgs;
        c
    }

    // ---- offer_continuation: safety-net for actionable work ---------------------------------

    fn convo_of(msgs: Vec<Message>) -> Conversation {
        let mut c = Conversation::new();
        c.messages = msgs;
        c
    }

    /// A session-scoped checklist: one tool instance, one bound session, one board.
    ///
    /// The board is the single source of truth — the transcript never rebuilds it.
    /// Dropping the fixture unbinds the session and clears the board, so a failing
    /// assertion can never leave a global binding behind for a later test.
    struct BoardFixture {
        tool: jeikcode_capabilities::tools::TodoTool,
        hook: TodoHook,
        live: TodoLive,
        session_id: String,
    }

    impl BoardFixture {
        fn new(tag: &str) -> Self {
            static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let seq = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let tool = jeikcode_capabilities::tools::TodoTool::new();
            let live = tool.live();
            let hook = TodoHook::with_live(live.clone());
            let session_id = format!("todo-test-{tag}-{}-{seq}", std::process::id());
            jeikcode_capabilities::tools::bind_todo_session(&live, &session_id);
            Self {
                tool,
                hook,
                live,
                session_id,
            }
        }

        /// Replace the session checklist — the one place the checklist lives.
        fn set_items(&self, items: &[(&str, TodoStatus)]) {
            jeikcode_capabilities::tools::commit_todo_board(
                &self.session_id,
                &items
                    .iter()
                    .map(|(content, status)| TodoItem {
                        id: None,
                        content: (*content).to_string(),
                        status: *status,
                    })
                    .collect::<Vec<_>>(),
            );
        }

        /// The live working copy the hook keeps in sync with the board.
        fn live_items(&self) -> Vec<TodoItem> {
            self.live.lock().unwrap_or_else(|e| e.into_inner()).clone()
        }
    }

    impl Drop for BoardFixture {
        fn drop(&mut self) {
            jeikcode_capabilities::tools::unbind_todo_session(&self.live);
            jeikcode_capabilities::tools::clear_todo_board(&self.session_id);
        }
    }

    #[tokio::test]
    async fn turn_start_does_not_inject_dynamic_reminder() {
        let fixture = BoardFixture::new("turn-start-no-inject");
        fixture.set_items(&[("step one", TodoStatus::InProgress)]);
        let mut convo = convo_with(vec![Message::user("do it"), Message::user("what next?")]);
        let before_len = convo.messages.len();
        fixture.hook.turn_start(&mut convo).await;
        assert_eq!(
            convo.messages.len(),
            before_len,
            "turn_start must not inject dynamic reminders into convo"
        );
    }

    #[tokio::test]
    async fn hook_syncs_live_from_session_board_so_execute_rejects_unknown_ids() {
        use jeikcode_kernel::tool::{Tool, ToolContext};
        use tokio_util::sync::CancellationToken;

        let fixture = BoardFixture::new("unknown-ids");
        fixture.set_items(&[("only", TodoStatus::Pending)]);
        let mut convo = convo_with(vec![Message::user("do it")]);
        fixture.hook.turn_start(&mut convo).await;

        assert_eq!(
            fixture.live_items().len(),
            1,
            "turn_start must copy the session checklist into the live working copy"
        );

        let ctx = ToolContext {
            working_dir: std::path::PathBuf::from("."),
            cancel: CancellationToken::new(),
            progress: jeikcode_kernel::tool::ProgressSink::noop(),
            requester: None,
        };
        let bad = fixture
            .tool
            .execute(r#"{"action":"update","id":3,"status":"completed"}"#, &ctx)
            .await;
        assert!(bad.is_error, "{}", bad.content);
        assert!(bad.content.contains("only"), "{}", bad.content);
        assert!(bad.content.contains("Current list"), "{}", bad.content);
    }

    #[tokio::test]
    async fn no_injection_when_no_list() {
        let fixture = BoardFixture::new("no-list");
        let mut convo = convo_with(vec![
            Message::user("hi"),
            Message::assistant("hello", vec![]),
        ]);
        let before = convo.messages.len();
        fixture.hook.turn_start(&mut convo).await;
        assert_eq!(convo.messages.len(), before, "empty list → no injection");
    }

    #[tokio::test]
    async fn nudges_to_close_out_open_items_on_stop() {
        let fixture = BoardFixture::new("nudge-open-items");
        fixture.set_items(&[("a", TodoStatus::Completed), ("b", TodoStatus::InProgress)]);
        let convo = convo_of(vec![
            Message::user("do the audit"),
            todowrite_msg(r#"{"actions":[{"action":"add","content":"b"}]}"#),
            Message::assistant("here is the summary…", vec![]),
        ]);
        assert!(
            fixture.hook.offer_continuation(&convo).await.is_some(),
            "open item on stop after todowrite must nudge"
        );
    }

    #[tokio::test]
    async fn completed_board_does_not_nudge_when_the_transcript_fold_still_looks_open() {
        let fixture = BoardFixture::new("board-wins-over-transcript");
        fixture.set_items(&[("a", TodoStatus::Completed), ("b", TodoStatus::Completed)]);
        let convo = convo_of(vec![
            Message::user("do the audit"),
            todowrite_msg(
                r#"{"todos":[{"content":"a","status":"pending"},{"content":"b","status":"in_progress"}]}"#,
            ),
            Message::assistant("here is the summary…", vec![]),
        ]);
        assert!(
            fixture.hook.offer_continuation(&convo).await.is_none(),
            "a finished TodoBoard must not be reopened by the transcript fold"
        );
    }

    #[tokio::test]
    async fn no_nudge_when_all_completed() {
        let fixture = BoardFixture::new("nudge-all-completed");
        fixture.set_items(&[("a", TodoStatus::Completed), ("b", TodoStatus::Completed)]);
        let convo = convo_of(vec![
            Message::user("do it"),
            todowrite_msg(
                r#"{"todos":[{"content":"a","status":"completed"},{"content":"b","status":"completed"}]}"#,
            ),
            Message::assistant("all done", vec![]),
        ]);
        assert!(
            fixture.hook.offer_continuation(&convo).await.is_none(),
            "all completed → let it stop"
        );
    }

    #[tokio::test]
    async fn no_nudge_when_no_todos() {
        let fixture = BoardFixture::new("nudge-no-todos");
        let convo = convo_of(vec![
            Message::user("hi"),
            Message::assistant("hi there", vec![]),
        ]);
        assert!(fixture.hook.offer_continuation(&convo).await.is_none());
    }

    #[tokio::test]
    async fn no_nudge_when_list_untouched_this_turn() {
        let fixture = BoardFixture::new("nudge-untouched");
        fixture.set_items(&[("a", TodoStatus::InProgress)]);
        let convo = convo_of(vec![
            Message::user("plan it"),
            todowrite_msg(r#"{"todos":[{"content":"a","status":"in_progress"}]}"#),
            Message::assistant("planned", vec![]),
            Message::user("what does foo do?"),
            Message::assistant("foo does X.", vec![]),
        ]);
        assert!(
            fixture.hook.offer_continuation(&convo).await.is_none(),
            "a stale open list not touched this turn must not force a continuation"
        );
    }

    #[tokio::test]
    async fn no_nudge_when_only_read_tools_performed() {
        // Read-only tools should be exempted so question answering is not hijacked
        let fixture = BoardFixture::new("nudge-read-only");
        fixture.set_items(&[("a", TodoStatus::InProgress)]);
        let convo = convo_of(vec![
            Message::user("plan it"),
            todowrite_msg(r#"{"todos":[{"content":"a","status":"in_progress"}]}"#),
            Message::assistant("planned", vec![]),
            Message::user("explain how auth works"),
            Message::assistant(
                "I researched this",
                vec![ToolCall {
                    id: "tool_1".into(),
                    name: "read".into(),
                    arguments: "{}".into(),
                }],
            ),
        ]);
        assert!(
            fixture.hook.offer_continuation(&convo).await.is_none(),
            "read-only tools must be exempted from continuation nudge"
        );
    }

    #[tokio::test]
    async fn no_nudge_when_request_user_input_called() {
        // Asking the user for confirmation should be exempted from continuation nudge
        let fixture = BoardFixture::new("nudge-ask-user");
        fixture.set_items(&[("a", TodoStatus::InProgress)]);
        let convo = convo_of(vec![
            Message::user("plan it"),
            todowrite_msg(r#"{"todos":[{"content":"a","status":"in_progress"}]}"#),
            Message::assistant("planned", vec![]),
            Message::user("continue"),
            Message::assistant(
                "Which option do you prefer?",
                vec![ToolCall {
                    id: "tool_1".into(),
                    name: "request_user_input".into(),
                    arguments: "{}".into(),
                }],
            ),
        ]);
        assert!(
            fixture.hook.offer_continuation(&convo).await.is_none(),
            "asking the user via request_user_input must be exempted from continuation nudge"
        );
    }

    #[tokio::test]
    async fn nudges_when_model_performed_work_tools_without_calling_todowrite() {
        // Agent did real modification work (edit/write) but neglected to update todo -> nudge
        let fixture = BoardFixture::new("nudge-after-work");
        fixture.set_items(&[("a", TodoStatus::InProgress)]);
        let convo = convo_of(vec![
            Message::user("plan it"),
            todowrite_msg(r#"{"todos":[{"content":"a","status":"in_progress"}]}"#),
            Message::assistant("planned", vec![]),
            Message::user("now implement feature a"),
            Message::assistant(
                "implemented",
                vec![ToolCall {
                    id: "tool_1".into(),
                    name: "write".into(),
                    arguments: "{}".into(),
                }],
            ),
        ]);
        assert!(
            fixture.hook.offer_continuation(&convo).await.is_some(),
            "working agent that omitted todowrite after write must be nudged before ending turn"
        );
    }

    #[tokio::test]
    async fn nudge_includes_concrete_unfinished_item_list() {
        let fixture = BoardFixture::new("nudge-lists-board");
        fixture.set_items(&[
            ("task finished", TodoStatus::Completed),
            ("task ongoing", TodoStatus::InProgress),
            ("task pending", TodoStatus::Pending),
        ]);
        // The transcript still carries an older plan. The board is the only source,
        // so the stale entry must not reach the nudge.
        let convo = convo_of(vec![
            Message::user("do the audit"),
            todowrite_msg(r#"{"todos":[{"content":"stale item","status":"pending"}]}"#),
            Message::assistant(
                "I worked on this",
                vec![ToolCall {
                    id: "tool_1".into(),
                    name: "write".into(),
                    arguments: "{}".into(),
                }],
            ),
        ]);
        let nudge = fixture.hook.offer_continuation(&convo).await.unwrap();
        assert!(nudge.contains("[~] 2. task ongoing"));
        assert!(nudge.contains("[ ] 3. task pending"));
        assert!(
            !nudge.contains("1. task finished"),
            "completed items must not be listed in unfinished nudge"
        );
        assert!(
            !nudge.contains("stale item"),
            "the nudge must come from the session board, not the transcript"
        );
    }

    #[tokio::test]
    async fn nudges_at_most_once_per_turn() {
        let fixture = BoardFixture::new("nudge-once");
        fixture.set_items(&[("a", TodoStatus::InProgress)]);
        let mut convo = convo_of(vec![
            Message::user("do it"),
            todowrite_msg(r#"{"todos":[{"content":"a","status":"in_progress"}]}"#),
            Message::assistant("summary", vec![]),
        ]);
        assert!(
            fixture.hook.offer_continuation(&convo).await.is_some(),
            "first stop nudges"
        );
        // Kernel injected the nudge as a synthetic user message; model stops again without closing.
        convo
            .messages
            .push(Message::synthetic_user(TODO_COMPLETION_NUDGE_PREFIX));
        convo
            .messages
            .push(Message::assistant("still open", vec![]));
        assert!(
            fixture.hook.offer_continuation(&convo).await.is_none(),
            "already nudged this turn → let it stop (no spin)"
        );
    }

    #[tokio::test]
    async fn nudges_for_actionable_tool_aliases_and_task_delegation() {
        for tool_name in [
            "task",
            "Task",
            "bash",
            "cmd",
            "edit_file",
            "create_file",
            "search_replace",
            "global_search_replace",
        ] {
            let fixture = BoardFixture::new("nudge-alias");
            fixture.set_items(&[("a", TodoStatus::InProgress)]);
            let convo = convo_of(vec![
                Message::user("plan it"),
                todowrite_msg(r#"{"todos":[{"content":"a","status":"in_progress"}]}"#),
                Message::assistant("planned", vec![]),
                Message::user("execute the step"),
                Message::assistant(
                    "did work",
                    vec![ToolCall {
                        id: "tool_1".into(),
                        name: tool_name.into(),
                        arguments: "{}".into(),
                    }],
                ),
            ]);
            assert!(
                fixture.hook.offer_continuation(&convo).await.is_some(),
                "actionable tool `{tool_name}` with open todos must trigger continuation nudge"
            );
        }
    }

    #[tokio::test]
    async fn completed_checklist_cleared_on_turn_complete_is_not_resurrected_next_turn() {
        use jeikcode_kernel::event::StopReason;

        let fixture = BoardFixture::new("clear-board");
        fixture.set_items(&[
            ("step 1", TodoStatus::Completed),
            ("step 2", TodoStatus::Completed),
        ]);
        let ctx = TurnCtx {
            session_id: Some(fixture.session_id.clone().into()),
            ..TurnCtx::default()
        };

        let mut convo = convo_with(vec![
            Message::user("ship feature"),
            Message::assistant("all done", vec![]),
        ]);
        fixture.hook.turn_start(&mut convo).await;
        assert_eq!(fixture.live_items().len(), 2);

        fixture
            .hook
            .turn_complete(&convo, &StopReason::Stopped, &ctx)
            .await;
        assert!(
            fixture.live_items().is_empty(),
            "turn_complete must clear live when all items are completed"
        );

        // Turn 2: user sends a new message; turn_start and pre_request must not resurrect Turn 1's completed list.
        convo.messages.push(Message::user("thanks, what is 2+2?"));
        fixture.hook.turn_start(&mut convo).await;
        assert!(
            fixture.live_items().is_empty(),
            "turn_start on next turn must not resurrect completed checklist from prior turn"
        );

        fixture.hook.pre_request(&mut convo.messages, &ctx).await;
        assert!(
            fixture.live_items().is_empty(),
            "pre_request on next turn must not resurrect completed checklist from prior turn"
        );
    }
}
