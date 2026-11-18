//! CLAIM 26: LIVENESS TIMEOUTS — two kernel-owned, default-OFF timeouts so a turn
//! can never PARK FOREVER. The MECHANISM is kernel (the stream loop in agent.rs
//! and the round-trip broker in request.rs are kernel-owned); the VALUES are
//! policy, injected via the builder and default `None` to stay neutral.
//!
//! Two hang vectors are closed:
//!   (1) a provider that opens the stream then goes silent (TCP half-open / model
//!       stall) → `run_turn`'s `stream.next().await` parks the turn forever.
//!   (2) a middleware mid-turn awaits `rt.request(...)` and a crashed/silent driver
//!       never answers → `RequestCtx::request`'s `rx.await` parks forever.
//!
//! Each test is itself wrapped in an OUTER `tokio::time::timeout` that is far
//! larger than the injected liveness timeout. That outer guard is the proof: with
//! the fix the turn fails/unblocks well within it; WITHOUT the fix the turn parks
//! forever and the outer guard trips → the test FAILS rather than hanging the
//! whole suite. (Mentally revert the fix and the inner timeout never fires → the
//! drive loop never returns → the outer `timeout` elapses → `expect` panics.)

use jeikcode_kernel::agent::Agent;
use jeikcode_kernel::event::{AgentCommand, AgentEvent};
use jeikcode_kernel::stream::StreamEvent;
use jeikcode_kernel::testkit::{
    ApprovalMiddleware, EchoTool, MockProvider, RecorderHook, RiskyWriteTool, ScriptedProvider,
    StallThenProvider,
};
use jeikcode_kernel::tool::{ToolCall, ToolRegistry};
use std::sync::Arc;
use std::time::Duration;

// The injected liveness timeout used by the two hang-case tests. Short but safe:
// the provider/driver never make progress, so 50ms is deterministic (nothing can
// race the timer to a real result).
const LIVENESS: Duration = Duration::from_millis(50);
// The OUTER guard. >> LIVENESS so a working fix always wins; if the fix is absent
// the turn parks and this elapses → test FAILS (not a suite hang).
const OUTER_GUARD: Duration = Duration::from_secs(5);

fn send(text: &str) -> AgentCommand {
    AgentCommand::SendMessage {
        text: text.into(),
        images: vec![],
    }
}

fn tool_call(id: &str, name: &str, args: &str) -> ToolCall {
    ToolCall {
        id: id.into(),
        name: name.into(),
        arguments: args.into(),
    }
}

// ── (1a) STREAM TIMEOUT → RECONNECT → RECOVER ────────────────────────────────
//
// FIRST stream opens then PENDS FOREVER (idle stall); the SECOND succeeds. With
// `.stream_timeout(50ms)` the idle-timeout fires, the kernel retries on the
// unified ladder and recovers. Virtual time keeps the ladder instant.
#[tokio::test(start_paused = true)]
async fn stream_timeout_reconnects_then_recovers() {
    let reg = ToolRegistry::new();
    let provider = Arc::new(StallThenProvider::new(
        1,
        vec![
            StreamEvent::TextDelta("recovered".into()),
            StreamEvent::Done { truncated: false },
        ],
    ));
    let recorder = Arc::new(RecorderHook::new());
    let log = recorder.log.clone();

    let mut handle = Agent::builder()
        .provider(provider)
        .tools(reg.mount(&[] as &[&str]))
        .hooks(recorder)
        .stream_timeout(LIVENESS)
        .build()
        .spawn();

    handle.commands.send(send("go")).unwrap();

    let (saw_reconnect, error_msg, completed) = tokio::time::timeout(OUTER_GUARD, async {
        let mut saw_reconnect = false;
        let mut error_msg: Option<String> = None;
        let mut completed = false;
        while let Some(ev) = handle.events.recv().await {
            match ev {
                AgentEvent::RetryNotice { .. } => saw_reconnect = true,
                AgentEvent::Error { message, .. } => error_msg = Some(message),
                AgentEvent::TurnComplete { .. } => {
                    completed = true;
                    break;
                }
                _ => {}
            }
        }
        (saw_reconnect, error_msg, completed)
    })
    .await
    .expect("reconnect-and-recover must finish within the outer guard, not hang");

    assert!(
        completed,
        "the turn must complete after a successful reconnect"
    );
    assert!(
        saw_reconnect,
        "a `reconnecting` Warning must be emitted on the idle timeout"
    );
    assert!(
        error_msg.is_none(),
        "a recovered turn must NOT surface an Error; got {error_msg:?}"
    );
    let log = log.lock().unwrap();
    assert!(
        log.contains(&"on_model_response".to_string()),
        "the success path must run on the recovered stream"
    );
}

// ── (1b) STREAM TIMEOUT → EXHAUST RETRIES → CLEAN-FAIL ───────────────────────
//
// PENDS FOREVER on every attempt. The kernel walks the unified ladder (9
// attempts) then clean-fails: on_error + Error (mentions timeout) +
// TurnComplete — never looping forever, never a bogus success. Virtual time
// keeps the full 257s ladder instant.
#[tokio::test(start_paused = true)]
async fn stream_timeout_exhausts_retries_then_fails() {
    let reg = ToolRegistry::new();
    let provider = Arc::new(StallThenProvider::new(100, vec![]));
    let recorder = Arc::new(RecorderHook::new());
    let log = recorder.log.clone();

    let mut handle = Agent::builder()
        .provider(provider)
        .tools(reg.mount(&[] as &[&str]))
        .hooks(recorder)
        .stream_timeout(LIVENESS)
        .build()
        .spawn();

    handle.commands.send(send("go")).unwrap();

    // Virtual time: the unified ladder (0+2+5+10+15+30+45+60+90s) auto-advances.
    let (notices, error_msg, completed) = tokio::time::timeout(Duration::from_secs(600), async {
        let mut notices = 0;
        let mut error_msg: Option<String> = None;
        let mut completed = false;
        while let Some(ev) = handle.events.recv().await {
            match ev {
                AgentEvent::RetryNotice { .. } => notices += 1,
                AgentEvent::Error { message, .. } => error_msg = Some(message),
                AgentEvent::TurnComplete { .. } => {
                    completed = true;
                    break;
                }
                _ => {}
            }
        }
        (notices, error_msg, completed)
    })
    .await
    .expect("exhausted retries must clean-fail within the guard, not loop forever");

    assert!(
        completed,
        "after exhausting retries the turn must clean-fail with TurnComplete"
    );
    assert_eq!(notices, 9, "每次重试都发一条进度（同一 id 原地更新）");
    assert!(
        error_msg.as_deref().is_some_and(|m| m.contains("timeout")),
        "the exhausted timeout must surface as an Error mentioning 'timeout'; got {error_msg:?}"
    );
    let log = log.lock().unwrap();
    assert!(
        log.contains(&"on_error".to_string()),
        "on_error must fire on the clean-fail"
    );
    assert!(
        !log.contains(&"on_model_response".to_string()),
        "an exhausted-timeout turn must NOT run the success path"
    );
}

// Observational metadata (ResponseId) must NOT reset TTFT. A gateway that
// heartbeats ids while the model is still silent used to keep the first-token
// arm alive forever.
#[tokio::test(start_paused = true)]
async fn response_id_heartbeat_does_not_reset_ttft() {
    use async_trait::async_trait;
    use futures::stream::BoxStream;
    use jeikcode_kernel::message::Message;
    use jeikcode_kernel::provider::{ChatOptions, LlmProvider};
    use jeikcode_kernel::stream::ProviderError;
    use jeikcode_kernel::tool::ToolDef;

    struct MetadataHeartbeat;
    #[async_trait]
    impl LlmProvider for MetadataHeartbeat {
        fn model_name(&self) -> &str {
            "meta"
        }
        fn context_window(&self) -> u32 {
            0
        }
        async fn chat_stream(
            &self,
            _messages: &[Message],
            _tools: &[ToolDef],
            _options: &ChatOptions,
        ) -> Result<BoxStream<'static, StreamEvent>, ProviderError> {
            Ok(Box::pin(futures::stream::unfold(0u32, |n| async move {
                if n > 0 {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Some((StreamEvent::ResponseId(format!("id-{n}")), n + 1))
            })))
        }
    }

    let mut handle = Agent::builder()
        .provider(Arc::new(MetadataHeartbeat))
        .tools(ToolRegistry::new().mount(&[] as &[&str]))
        .first_token_timeout(LIVENESS)
        .first_token_timeout_retries(0)
        .build()
        .spawn();
    handle.commands.send(send("go")).unwrap();

    let (error_msg, completed) = tokio::time::timeout(OUTER_GUARD, async {
        let mut error_msg: Option<String> = None;
        let mut completed = false;
        while let Some(ev) = handle.events.recv().await {
            match ev {
                AgentEvent::Error { message, .. } => error_msg = Some(message),
                AgentEvent::TurnComplete { .. } => {
                    completed = true;
                    break;
                }
                _ => {}
            }
        }
        (error_msg, completed)
    })
    .await
    .expect("TTFT must fire despite ResponseId heartbeats");

    assert!(completed);
    assert!(
        error_msg.as_deref().is_some_and(|m| {
            m.contains("首token")
                || m.contains("延迟")
                || m.contains("first token")
                || m.contains("latency")
        }),
        "TTFT must surface a first-token error; got {error_msg:?}"
    );
}

// ── (2) REQUEST ROUND-TRIP TIMEOUT ───────────────────────────────────────────
//
// An ApprovalMiddleware round-trips via `rt.request` on a risky tool. The driver
// here NEVER sends `Respond`. With `.request_timeout(50ms)` the round-trip
// degrades to `Value::Null` (same as a dropped sender) → ApprovalMiddleware sees a
// non-"allow" decision → blocks the tool → the turn proceeds and completes instead
// of parking forever in `rx.await`.
#[tokio::test]
async fn request_timeout_degrades_to_null_and_unblocks_turn() {
    let mut reg = ToolRegistry::new();
    reg.register(Arc::new(RiskyWriteTool));

    // Round 1: a risky tool_call (triggers approval), then Done. After the tool is
    // blocked, the turn loops to round 2 where the model gives a content-bearing
    // final answer → a normal completion. (Round 2 must carry text: a content-free
    // round 2 would now be retried as an empty-200 instead of completing.)
    let provider = Arc::new(MockProvider::new(vec![
        vec![
            StreamEvent::ToolCall(tool_call("c1", "risky_write", "{\"path\":\"notes.md\"}")),
            StreamEvent::Done { truncated: false },
        ],
        vec![
            StreamEvent::TextDelta("done".into()),
            StreamEvent::Done { truncated: false },
        ],
    ]));

    let mut handle = Agent::builder()
        .provider(provider)
        .tools(reg.mount(&["risky_write"]))
        .middleware(Arc::new(ApprovalMiddleware::new()))
        .request_timeout(LIVENESS)
        .build()
        .spawn();

    handle.commands.send(send("write the file")).unwrap();

    // Drive WITHOUT ever answering the Request. Under the outer guard: with the
    // fix the request degrades to Null and the turn completes; without it the turn
    // parks in rx.await forever and this `timeout` trips.
    let (saw_request, blocked_result, completed) = tokio::time::timeout(OUTER_GUARD, async {
        let mut saw_request = false;
        let mut blocked_result: Option<String> = None;
        let mut completed = false;
        while let Some(ev) = handle.events.recv().await {
            match ev {
                // Deliberately do NOT respond — model a crashed/silent driver.
                AgentEvent::Request { .. } => saw_request = true,
                AgentEvent::ToolResult { result } => blocked_result = Some(result.content),
                AgentEvent::TurnComplete { .. } => {
                    completed = true;
                    break;
                }
                _ => {}
            }
        }
        (saw_request, blocked_result, completed)
    })
    .await
    .expect("request-timeout turn must NOT hang — the round-trip must degrade to Null and unblock");

    assert!(
        saw_request,
        "the middleware must have round-tripped an approval Request"
    );
    assert!(
        completed,
        "the turn must complete after the request degrades to Null"
    );
    // Null → ApprovalMiddleware treats it as deny → the tool is BLOCKED.
    assert!(
        blocked_result.as_deref().is_some_and(|c| c.contains("blocked")),
        "a request that timed out (→ Null → deny) must BLOCK the risky tool; got {blocked_result:?}"
    );
}

// ── (3) DEFAULT-OFF: no timer when neither timeout is set ─────────────────────
//
// Without setting either knob, behavior is unchanged: a normal turn completes and
// no timer arm is added. (We reuse a plain scripted turn; the SilentStreamProvider
// is NOT used here precisely because, with no stream_timeout, it would park
// forever — the default-None path adds no timer, by design.)
#[tokio::test]
async fn no_timeout_by_default_unchanged() {
    let mut reg = ToolRegistry::new();
    reg.register(Arc::new(EchoTool));

    let provider = Arc::new(ScriptedProvider::events(vec![
        StreamEvent::TextDelta("answer".into()),
        StreamEvent::Done { truncated: false },
    ]));

    // No .stream_timeout / .request_timeout calls → both default None.
    let mut handle = Agent::builder()
        .provider(provider)
        .tools(reg.mount(&["echo"]))
        .build()
        .spawn();

    handle.commands.send(send("hello")).unwrap();

    let (text, completed) = tokio::time::timeout(OUTER_GUARD, async {
        let mut text = String::new();
        let mut completed = false;
        while let Some(ev) = handle.events.recv().await {
            match ev {
                AgentEvent::TextDelta(t) => text.push_str(&t),
                AgentEvent::TurnComplete { .. } => {
                    completed = true;
                    break;
                }
                _ => {}
            }
        }
        (text, completed)
    })
    .await
    .expect("a normal default turn must complete promptly");

    assert!(
        completed,
        "a normal turn completes with the default-None timeouts"
    );
    assert_eq!(
        text, "answer",
        "the default path is unchanged — full text delivered"
    );
}
