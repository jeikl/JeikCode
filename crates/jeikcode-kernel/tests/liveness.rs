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
                jeikcode_kernel::event::AgentEvent::SystemNotice(ref notice)
                    if notice.status == jeikcode_kernel::event::NoticeStatus::Active =>
                {
                    saw_reconnect = true
                }
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
                jeikcode_kernel::event::AgentEvent::SystemNotice(ref notice)
                    if notice.status == jeikcode_kernel::event::NoticeStatus::Active =>
                {
                    notices += 1
                }
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

/// 思考静默进入过渡期后不得叠加两倍超时（360s + 360s = 720s）：
/// 首个 thinking token 之后若一直无正文/工具输出，总静默时间不得超过 transition 上限。
#[tokio::test(start_paused = true)]
async fn thinking_silence_does_not_stack_streaming_and_transition_timeouts() {
    use async_trait::async_trait;
    use futures::stream::BoxStream;
    use jeikcode_kernel::message::Message;
    use jeikcode_kernel::provider::{ChatOptions, LlmProvider};
    use jeikcode_kernel::stream::ProviderError;
    use jeikcode_kernel::timeouts::TimeoutPolicy;

    struct ThinkThenStallProvider(std::sync::atomic::AtomicUsize);
    #[async_trait]
    impl LlmProvider for ThinkThenStallProvider {
        fn model_name(&self) -> &str {
            "think-stall"
        }
        fn context_window(&self) -> u32 {
            0
        }
        async fn chat_stream(
            &self,
            _messages: &[Message],
            _tools: &[jeikcode_kernel::tool::ToolDef],
            _options: &ChatOptions,
        ) -> Result<BoxStream<'static, StreamEvent>, ProviderError> {
            let n = self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if n == 0 {
                Ok(Box::pin(
                    futures::stream::once(async { StreamEvent::Reasoning("thinking...".into()) })
                        .chain(futures::stream::pending()),
                ))
            } else {
                Ok(Box::pin(futures::stream::iter(vec![
                    StreamEvent::TextDelta("recovered".into()),
                    StreamEvent::Done { truncated: false },
                ])))
            }
        }
    }
    use futures::StreamExt;

    let mut policy = TimeoutPolicy::unbounded();
    policy.ttft = Some(Duration::from_millis(50));
    policy.streaming = Some(Duration::from_millis(100));
    policy.transition = Some(Duration::from_millis(100));

    let provider = Arc::new(ThinkThenStallProvider(std::sync::atomic::AtomicUsize::new(
        0,
    )));
    let mut handle = Agent::builder()
        .provider(provider.clone())
        .tools(ToolRegistry::new().mount(&[] as &[&str]))
        .timeouts(policy)
        .build()
        .spawn();

    let started = tokio::time::Instant::now();
    handle.commands.send(send("go")).unwrap();

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
    let elapsed = started.elapsed();
    assert!(completed);
    assert_eq!(text, "recovered");
    // 若错误叠加了 streaming(100ms) + transition(100ms)，此处会 >= 200ms。
    assert!(
        elapsed < Duration::from_millis(150),
        "thinking silence stacked streaming + transition timeouts: {elapsed:?}"
    );
}

/// 同一故障重试耗尽与恢复时都必须复用同一个 `event_id` 并以 settled 收口。
#[tokio::test(start_paused = true)]
async fn retry_incidents_settle_same_event_id_on_exhaustion_and_recovery() {
    use jeikcode_kernel::event::{NoticeSeverity, NoticeStatus};

    // (1) 重试耗尽：所有 Active 进度与最后一条 Settled/Error 共用同一 event_id。
    let mut handle = Agent::builder()
        .provider(Arc::new(StallThenProvider::new(100, vec![])))
        .tools(ToolRegistry::new().mount(&[] as &[&str]))
        .stream_timeout(LIVENESS)
        .build()
        .spawn();
    handle.commands.send(send("go")).unwrap();
    let mut exhausted_events = Vec::new();
    while let Some(ev) = handle.events.recv().await {
        match ev {
            AgentEvent::SystemNotice(n) => exhausted_events.push(n),
            AgentEvent::TurnComplete { .. } => break,
            _ => {}
        }
    }
    assert_eq!(exhausted_events.len(), 10, "9 次活跃重试 + 1 次终态收口");
    let first_id = exhausted_events[0].event_id.clone();
    assert!(
        exhausted_events.iter().all(|n| n.event_id == first_id),
        "所有尝试与终态必须共用同一个 event_id"
    );
    let last = exhausted_events.last().unwrap();
    assert_eq!(last.status, NoticeStatus::Settled);
    assert_eq!(last.severity, NoticeSeverity::Error);
    assert_eq!(last.revision, 10);

    // (2) 恢复成功：复用同一 event_id 收口为 Info / Settled。
    let mut handle2 = Agent::builder()
        .provider(Arc::new(StallThenProvider::new(
            1,
            vec![
                StreamEvent::TextDelta("ok".into()),
                StreamEvent::Done { truncated: false },
            ],
        )))
        .tools(ToolRegistry::new().mount(&[] as &[&str]))
        .stream_timeout(LIVENESS)
        .build()
        .spawn();
    handle2.commands.send(send("go")).unwrap();
    let mut recovered_events = Vec::new();
    while let Some(ev) = handle2.events.recv().await {
        match ev {
            AgentEvent::SystemNotice(n) => recovered_events.push(n),
            AgentEvent::TurnComplete { .. } => break,
            _ => {}
        }
    }
    assert_eq!(recovered_events.len(), 2, "1 次活跃重试 + 1 次恢复收口");
    assert_eq!(recovered_events[0].event_id, recovered_events[1].event_id);
    assert_eq!(recovered_events[0].status, NoticeStatus::Active);
    assert_eq!(recovered_events[1].status, NoticeStatus::Settled);
    assert_eq!(recovered_events[1].severity, NoticeSeverity::Info);
}

/// 同一逻辑轮中连续发生两次“先吐字再断流并续写”时，必须按恢复点分拆为两张独立锚定的故障卡，同时累计总重试预算。
#[tokio::test(start_paused = true)]
async fn same_round_resume_then_second_drop_opens_distinct_anchored_incidents() {
    use jeikcode_kernel::event::{NoticeKind, NoticeSeverity, NoticeStatus};
    use jeikcode_kernel::stream::ProviderError;

    let drop_err = |msg: &str| ProviderError {
        retryable: true,
        resumable: true,
        message: msg.into(),
        http_status: None,
        code: None,
        retry_after_secs: None,
    };

    let provider = Arc::new(MockProvider::new(vec![
        vec![
            StreamEvent::TextDelta("part-1 ".into()),
            StreamEvent::Error(drop_err("drop-1")),
        ],
        vec![
            StreamEvent::TextDelta("part-2 ".into()),
            StreamEvent::Error(drop_err("drop-2")),
        ],
        vec![
            StreamEvent::TextDelta("part-3".into()),
            StreamEvent::Done { truncated: false },
        ],
    ]));

    let mut handle = Agent::builder()
        .provider(provider)
        .tools(ToolRegistry::new().mount(&[] as &[&str]))
        .build()
        .spawn();
    handle.commands.send(send("go")).unwrap();

    #[derive(Debug)]
    enum Seen {
        Assistant(String),
        Notice(jeikcode_kernel::event::SystemNotice),
    }

    let mut timeline = Vec::new();
    let mut completed = false;
    tokio::time::timeout(OUTER_GUARD, async {
        while let Some(ev) = handle.events.recv().await {
            match ev {
                AgentEvent::AssistantMessage { message_id } => {
                    timeline.push(Seen::Assistant(message_id));
                }
                AgentEvent::SystemNotice(notice) => {
                    timeline.push(Seen::Notice(notice));
                }
                AgentEvent::TurnComplete { reason } => {
                    assert_eq!(reason, jeikcode_kernel::event::StopReason::Stopped);
                    completed = true;
                    break;
                }
                _ => {}
            }
        }
    })
    .await
    .expect("multi-drop same-round recovery must finish quickly in virtual time");

    assert!(completed);

    let assistant_ids: Vec<String> = timeline
        .iter()
        .filter_map(|item| match item {
            Seen::Assistant(id) => Some(id.clone()),
            Seen::Notice(_) => None,
        })
        .collect();
    assert!(
        assistant_ids.len() >= 2,
        "每次断流前产出文本都应持有独立 assistant message_id: {assistant_ids:?}"
    );
    let m1 = assistant_ids[0].clone();
    let m2 = assistant_ids[1].clone();
    assert_ne!(m1, m2);

    let retry_notices: Vec<_> = timeline
        .iter()
        .filter_map(|item| match item {
            Seen::Notice(n) if n.kind == NoticeKind::Retry => Some(n.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        retry_notices.len(),
        4,
        "两次中断应各产生 Active -> Settled 共 4 条重试通知，实际: {retry_notices:#?}"
    );

    let card1_active = &retry_notices[0];
    let card1_settled = &retry_notices[1];
    let card2_active = &retry_notices[2];
    let card2_settled = &retry_notices[3];

    assert_eq!(card1_active.status, NoticeStatus::Active);
    assert_eq!(card1_settled.status, NoticeStatus::Settled);
    assert_eq!(card1_settled.severity, NoticeSeverity::Info);
    assert_eq!(card1_active.event_id, card1_settled.event_id);
    assert_eq!(card1_active.anchor_message_id.as_deref(), Some(m1.as_str()));
    assert_eq!(
        card1_settled.anchor_message_id.as_deref(),
        Some(m1.as_str())
    );

    assert_eq!(card2_active.status, NoticeStatus::Active);
    assert_eq!(card2_settled.status, NoticeStatus::Settled);
    assert_eq!(card2_settled.severity, NoticeSeverity::Info);
    assert_eq!(card2_active.event_id, card2_settled.event_id);
    assert_eq!(card2_active.anchor_message_id.as_deref(), Some(m2.as_str()));
    assert_eq!(
        card2_settled.anchor_message_id.as_deref(),
        Some(m2.as_str())
    );

    assert_ne!(
        card1_active.event_id, card2_active.event_id,
        "两次断流不能合并为同一个 event_id"
    );
    assert!(
        card1_active.text.contains("1/"),
        "首张卡片应从第 1 次尝试计数: {}",
        card1_active.text
    );
    assert!(
        card2_active.text.contains("2/"),
        "第二张卡片必须延续同轮累计重试预算 (2/N): {}",
        card2_active.text
    );

    // 验证时间顺序：m1 -> card1_active -> card1_settled -> m2 (或先 settled 后 m2) -> card2_active -> m3/settled
    let pos_card1_settled = timeline
        .iter()
        .position(|s| matches!(s, Seen::Notice(n) if n.event_id == card1_settled.event_id && n.status == NoticeStatus::Settled))
        .unwrap();
    let pos_card2_active = timeline
        .iter()
        .position(|s| matches!(s, Seen::Notice(n) if n.event_id == card2_active.event_id && n.status == NoticeStatus::Active))
        .unwrap();
    assert!(
        pos_card1_settled < pos_card2_active,
        "card1 必须在打开 card2 之前完成 Settled"
    );
}
