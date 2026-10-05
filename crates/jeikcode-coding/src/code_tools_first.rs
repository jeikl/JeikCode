//! First-query + wander-loop steering for `code_explore` / `repo_map`.
//!
//! 1. **Opening tail** — on the first real user query, append a
//!    `<system-reminder>` to that same user block (same placement as the date
//!    reminder). Stored. TUI / WebUI strip it via
//!    [`jeikcode_capabilities::session::user_text_for_display`].
//! 2. **Wander meter** — a per-session counter over `grep` + `glob` +
//!    `read_file` combined. Crossing 7 in a 10-call window appends the wander
//!    reminder to **that tool result**. `code_explore` or a full window of 10
//!    resets the counter to 0. Parallel tool `after` hooks serialize on the
//!    session lock so the count stays exact.
//!
//! Enabled whenever `code_explore` is mounted. One [`CodeToolsFirstHook`]
//! instance is both a [`LifecycleHooks`] and a [`ToolMiddleware`], owned by
//! [`crate::parts::CodingParts`] so a `/model` respawn keeps the same meter.

use async_trait::async_trait;
use jeikcode_capabilities::reminder::system_reminder;
use jeikcode_kernel::hook::LifecycleHooks;
use jeikcode_kernel::message::{Conversation, Role};
use jeikcode_kernel::middleware::{AfterOutcome, ToolMiddleware};
use jeikcode_kernel::tool::{Tool, ToolResult};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

const WANDER_WINDOW: u8 = 10;
const WANDER_NUDGE_AT: u8 = 8;

const OPENING_BODY: &str = "\
Prioritize `code_explore` and `repo_map`. Note: the `path` argument of `code_explore` \
must be a directory/module path (e.g. `src/auth`). Fire concurrent calls when \
exploring across modules; establish the code graph with `code_explore` first before \
answering, and close gaps with `grep`.";

const WANDER_BODY: &str = "\
Little `code_explore` so far. If this is still primary code exploration, split intent \
and call `code_explore` in parallel.";

const OPENING_NEEDLE: &str = "code_explore` and `repo_map`";
const WANDER_NEEDLE: &str = "Little `code_explore` so far";

fn wander_meters() -> &'static Mutex<HashMap<String, u8>> {
    static MAP: OnceLock<Mutex<HashMap<String, u8>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_meters() -> std::sync::MutexGuard<'static, HashMap<String, u8>> {
    wander_meters().lock().unwrap_or_else(|e| e.into_inner())
}

/// Combined `grep`/`glob`/`read_file` window. Returns whether this call should
/// carry the wander reminder. `code_explore` or a full window of
/// [`WANDER_WINDOW`] clears the count.
fn apply_wander(count: &mut u8, name: &str) -> bool {
    match name {
        "code_explore" => {
            *count = 0;
            false
        }
        "grep" | "glob" | "read_file" => {
            *count = count.saturating_add(1);
            let nudge = *count == WANDER_NUDGE_AT;
            if *count >= WANDER_WINDOW {
                *count = 0;
            }
            nudge
        }
        _ => false,
    }
}

fn note_wander(session_key: &str, name: &str) -> bool {
    let mut map = lock_meters();
    let slot = map.entry(session_key.to_string()).or_insert(0);
    apply_wander(slot, name)
}

fn drop_session(session_key: &str) {
    lock_meters().remove(session_key);
}

fn append_reminder(text: &mut String, body: &str, needle: &str) {
    if text.contains(needle) {
        return;
    }
    if !text.is_empty() {
        text.push_str("\n\n");
    }
    text.push_str(&system_reminder(body));
}

pub struct CodeToolsFirstHook {
    enabled: bool,
    session_key: String,
}

impl CodeToolsFirstHook {
    pub fn new(code_explore_mounted: bool, session_id: Option<&str>) -> Self {
        static ANON: AtomicU64 = AtomicU64::new(1);
        let session_key = match session_id.map(str::trim).filter(|s| !s.is_empty()) {
            Some(id) => id.to_string(),
            None => format!("anon-{}", ANON.fetch_add(1, Ordering::Relaxed)),
        };
        Self {
            enabled: code_explore_mounted,
            session_key,
        }
    }
}

#[async_trait]
impl LifecycleHooks for CodeToolsFirstHook {
    async fn turn_start(&self, convo: &mut Conversation) {
        if !self.enabled {
            return;
        }
        let real_users = convo
            .messages
            .iter()
            .filter(|m| m.role == Role::User && !m.synthetic)
            .count();
        if real_users != 1 {
            return;
        }
        let Some(query) = convo
            .messages
            .iter_mut()
            .rfind(|m| m.role == Role::User && !m.synthetic)
        else {
            return;
        };
        append_reminder(&mut query.text, OPENING_BODY, OPENING_NEEDLE);
    }

    async fn session_end(&self, _convo: &Conversation) {
        drop_session(&self.session_key);
    }
}

#[async_trait]
impl ToolMiddleware for CodeToolsFirstHook {
    async fn after(&self, result: &mut ToolResult, tool: Option<&dyn Tool>) -> AfterOutcome {
        if !self.enabled {
            return AfterOutcome::Proceed;
        }
        let Some(tool) = tool else {
            return AfterOutcome::Proceed;
        };
        if note_wander(&self.session_key, tool.name()) {
            append_reminder(&mut result.content, WANDER_BODY, WANDER_NEEDLE);
        }
        AfterOutcome::Proceed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jeikcode_kernel::message::Message;
    use jeikcode_kernel::tool::ToolContext;
    use serde_json::json;

    fn convo(msgs: Vec<Message>) -> Conversation {
        let mut c = Conversation::default();
        c.messages = msgs;
        c
    }

    struct Named(&'static str);

    #[async_trait]
    impl Tool for Named {
        fn name(&self) -> &str {
            self.0
        }
        fn description(&self) -> &str {
            ""
        }
        fn parameters_schema(&self) -> serde_json::Value {
            json!({"type": "object"})
        }
        async fn execute(&self, _args: &str, _ctx: &ToolContext) -> ToolResult {
            ToolResult {
                call_id: String::new(),
                content: String::new(),
                is_error: false,
                images: vec![],
            }
        }
    }

    fn result(content: &str) -> ToolResult {
        ToolResult {
            call_id: "c".into(),
            content: content.into(),
            is_error: false,
            images: vec![],
        }
    }

    async fn after_named(hook: &CodeToolsFirstHook, name: &'static str, content: &str) -> String {
        let mut r = result(content);
        hook.after(&mut r, Some(&Named(name))).await;
        r.content
    }

    #[test]
    fn wander_counts_grep_glob_read_file_together_and_resets() {
        let mut n = 0u8;
        for _ in 0..7 {
            assert!(!apply_wander(&mut n, "grep"));
        }
        assert_eq!(n, 7);
        assert!(apply_wander(&mut n, "glob"), "8th combined wander nudges");
        assert_eq!(n, 8);
        assert!(!apply_wander(&mut n, "read_file"));
        assert_eq!(n, 9);
        assert!(!apply_wander(&mut n, "grep"), "10th combined call clears");
        assert_eq!(n, 0);
    }

    #[test]
    fn wander_one_kind_does_not_need_seven_of_the_same() {
        let mut n = 0u8;
        assert!(!apply_wander(&mut n, "grep"));
        assert!(!apply_wander(&mut n, "grep"));
        assert!(!apply_wander(&mut n, "glob"));
        assert!(!apply_wander(&mut n, "glob"));
        assert!(!apply_wander(&mut n, "read_file"));
        assert!(!apply_wander(&mut n, "read_file"));
        assert!(!apply_wander(&mut n, "grep"));
        assert!(apply_wander(&mut n, "glob"));
        assert_eq!(n, 8);
    }

    #[test]
    fn code_explore_clears_the_combined_count() {
        let mut n = 0u8;
        for _ in 0..6 {
            apply_wander(&mut n, "read_file");
        }
        assert_eq!(n, 6);
        assert!(!apply_wander(&mut n, "code_explore"));
        assert_eq!(n, 0);
        for _ in 0..7 {
            assert!(!apply_wander(&mut n, "grep"));
        }
        assert!(apply_wander(&mut n, "grep"));
    }

    #[test]
    fn other_tools_do_not_move_the_window() {
        let mut n = 0u8;
        apply_wander(&mut n, "grep");
        assert!(!apply_wander(&mut n, "edit_file"));
        assert!(!apply_wander(&mut n, "repo_map"));
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn opening_appends_to_the_first_user_block() {
        let hook = CodeToolsFirstHook::new(true, Some("sess-open"));
        let mut c = convo(vec![Message::user("how does auth work")]);
        hook.turn_start(&mut c).await;
        assert_eq!(c.messages.len(), 1, "must not insert a separate user block");
        assert!(!c.messages[0].synthetic);
        assert!(
            c.messages[0]
                .text
                .starts_with("how does auth work\n\n<system-reminder>")
                && c.messages[0].text.contains(OPENING_NEEDLE)
                && c.messages[0].text.contains("directory/module path")
                && c.messages[0].text.contains("concurrent calls"),
            "{}",
            c.messages[0].text
        );
        hook.session_end(&c).await;
    }

    #[tokio::test]
    async fn opening_is_idempotent_and_sits_after_an_existing_date_tail() {
        let hook = CodeToolsFirstHook::new(true, Some("sess-date"));
        let mut c = convo(vec![Message::user(
            "hi\n\n<system-reminder>\nCurrent date: 2026-06-15 (Mon)\n</system-reminder>",
        )]);
        hook.turn_start(&mut c).await;
        hook.turn_start(&mut c).await;
        let text = &c.messages[0].text;
        assert_eq!(
            text.matches("<system-reminder>").count(),
            2,
            "date + opening, once each: {text}"
        );
        assert!(
            text.contains("Current date:") && text.contains(OPENING_NEEDLE),
            "{text}"
        );
        hook.session_end(&c).await;
    }

    #[tokio::test]
    async fn opening_skips_later_user_turns_and_unmounted_tool() {
        let hook = CodeToolsFirstHook::new(true, Some("sess-later"));
        let mut c = convo(vec![
            Message::user("first"),
            Message::assistant("ok", vec![]),
            Message::user("again"),
        ]);
        hook.turn_start(&mut c).await;
        assert_eq!(c.messages[2].text, "again");

        let off = CodeToolsFirstHook::new(false, Some("sess-off"));
        let mut d = convo(vec![Message::user("hi")]);
        off.turn_start(&mut d).await;
        assert_eq!(d.messages[0].text, "hi");
        hook.session_end(&c).await;
        off.session_end(&d).await;
    }

    #[tokio::test]
    async fn frontier_also_gets_the_opening_tail() {
        let hook = CodeToolsFirstHook::new(true, Some("sess-frontier"));
        let mut c = convo(vec![Message::user("hi")]);
        hook.turn_start(&mut c).await;
        assert!(c.messages[0].text.contains(OPENING_NEEDLE));
        hook.session_end(&c).await;
    }

    #[tokio::test]
    async fn wander_appends_to_the_tool_result_on_the_eighth_combined_call() {
        let hook = CodeToolsFirstHook::new(true, Some("sess-wander"));
        let names = [
            "grep",
            "glob",
            "read_file",
            "grep",
            "glob",
            "read_file",
            "grep",
            "glob",
        ];
        let mut last = String::new();
        for (i, name) in names.iter().enumerate() {
            last = after_named(&hook, name, "hits").await;
            if i < 7 {
                assert!(
                    !last.contains(WANDER_NEEDLE),
                    "call {} must not nudge yet: {last}",
                    i + 1
                );
            }
        }
        assert!(
            last.starts_with("hits\n\n<system-reminder>") && last.contains(WANDER_NEEDLE),
            "{last}"
        );
        hook.session_end(&Conversation::default()).await;
    }

    #[tokio::test]
    async fn wander_meters_are_isolated_per_session() {
        let a = CodeToolsFirstHook::new(true, Some("sess-a"));
        let b = CodeToolsFirstHook::new(true, Some("sess-b"));
        for _ in 0..8 {
            after_named(&a, "grep", "a").await;
        }
        let b_out = after_named(&b, "grep", "b").await;
        assert!(
            !b_out.contains(WANDER_NEEDLE),
            "session B must not inherit A's count: {b_out}"
        );
        a.session_end(&Conversation::default()).await;
        b.session_end(&Conversation::default()).await;
    }

    #[tokio::test]
    async fn code_explore_result_resets_so_later_greps_do_not_nudge_early() {
        let hook = CodeToolsFirstHook::new(true, Some("sess-reset"));
        for _ in 0..6 {
            after_named(&hook, "read_file", "x").await;
        }
        let explored = after_named(&hook, "code_explore", "graph").await;
        assert!(!explored.contains(WANDER_NEEDLE), "{explored}");
        for _ in 0..7 {
            let out = after_named(&hook, "grep", "x").await;
            assert!(!out.contains(WANDER_NEEDLE), "{out}");
        }
        let nudged = after_named(&hook, "grep", "x").await;
        assert!(nudged.contains(WANDER_NEEDLE), "{nudged}");
        hook.session_end(&Conversation::default()).await;
    }
}
