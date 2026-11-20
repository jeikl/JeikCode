//! CLAIM 27: FAILURE PERCEPTION — a failed turn can never look like an empty
//! SUCCESS.
//!
//! Three coupled defects are closed:
//!   (1) `AgentEvent::TurnComplete` now carries a `StopReason`, so a driver can
//!       tell WHY a turn ended (normal vs max-rounds / provider-error / timeout /
//!       cancel / prompt-rejected / runaway offer_continuation continuation).
//!   (2) `run_to_completion`'s `Outcome` now carries `stop: StopReason` and
//!       `error: Option<String>`; it no longer swallows `AgentEvent::Error`. A
//!       failed run yields `Outcome { stop: ProviderError/.., error: Some(..) }` —
//!       NOT an empty success (the SWE-bench-grader-facing fix).
//!   (3) The `offer_continuation` continuation loop is now BOUNDED by a default-ON fuse
//!       (`max_continuations = Some(50)`); a `offer_continuation` hook that always
//!       continues is stopped with `StopReason::MaxContinuations` instead of
//!       spinning forever with no model agency to stop it.

use async_trait::async_trait;
use jeikcode_kernel::agent::{Agent, AutoRespond};
use jeikcode_kernel::event::{AgentCommand, AgentEvent, StopReason};
use jeikcode_kernel::hook::LifecycleHooks;
use jeikcode_kernel::message::Conversation;
use jeikcode_kernel::middleware::{BeforeOutcome, ToolMiddleware};
use jeikcode_kernel::request::RequestCtx;
use jeikcode_kernel::stream::{ProviderError, StreamEvent};
use jeikcode_kernel::testkit::{AlwaysStopProvider, EchoTool, MockProvider, ScriptedProvider};
use jeikcode_kernel::tool::{Tool, ToolCall, ToolRegistry};
use std::sync::Arc;
use std::time::Duration;

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

struct TerminalDeny;

#[async_trait]
impl ToolMiddleware for TerminalDeny {
    async fn before(
        &self,
        call: &mut ToolCall,
        _tool: &Arc<dyn Tool>,
        _rt: &RequestCtx,
    ) -> BeforeOutcome {
        if call.id == "c2" {
            BeforeOutcome::deny_turn("credential policy denied; do not retry")
        } else {
            BeforeOutcome::Proceed
        }
    }
}

#[tokio::test]
async fn terminal_policy_denial_pairs_batch_and_stops_before_retry() {
    let provider = Arc::new(MockProvider::new(vec![
        vec![
            StreamEvent::ToolCall(tool_call("c1", "echo", r#"{"text":"first"}"#)),
            StreamEvent::ToolCall(tool_call("c2", "echo", r#"{"text":"second"}"#)),
            StreamEvent::Done { truncated: false },
        ],
        vec![
            StreamEvent::ToolCall(tool_call("c3", "echo", r#"{"text":"retry"}"#)),
            StreamEvent::Done { truncated: false },
        ],
    ]));
    let agent = Agent::builder()
        .provider(provider)
        .tools(echo_tools())
        .middleware(Arc::new(TerminalDeny))
        .build();

    let outcome = agent.run_to_completion("go", AutoRespond::AllowAll).await;

    assert_eq!(outcome.stop, StopReason::PolicyDenied);
    assert_eq!(outcome.tool_results.len(), 2);
    assert_eq!(
        outcome.tool_results[0].content,
        "blocked: another call in this batch terminated the turn by policy"
    );
    assert_eq!(
        outcome.tool_results[1].content,
        "blocked: credential policy denied; do not retry"
    );
}

// ── A normal turn ends with StopReason::Stopped ──────────────────────────────
#[tokio::test]
async fn turn_complete_carries_stop_reason() {
    let reg = ToolRegistry::new();
    let provider = Arc::new(ScriptedProvider::events(vec![
        StreamEvent::TextDelta("done".into()),
        StreamEvent::Done { truncated: false },
    ]));

    let handle = Agent::builder()
        .provider(provider)
        .tools(reg.mount(&[] as &[&str]))
        .build()
        .spawn();
    handle.commands.send(send("go")).unwrap();

    let mut events = handle.events;
    let mut reason: Option<StopReason> = None;
    while let Some(ev) = events.recv().await {
        if let AgentEvent::TurnComplete { reason: r } = ev {
            reason = Some(r);
            break;
        }
    }
    assert_eq!(
        reason,
        Some(StopReason::Stopped),
        "a normal turn must end with StopReason::Stopped"
    );
}

// ── The empty-success-illusion fix (SWE-bench grader facing) ─────────────────
//
// A provider whose `chat_stream` returns Err must NOT produce an empty SUCCESS
// Outcome: `run_to_completion` must report `stop == ProviderError` and capture the
// error message (Error is no longer dropped by the `_ => {}` arm).
#[tokio::test]
async fn failed_open_run_to_completion_reports_error_not_empty_success() {
    let reg = ToolRegistry::new();
    let provider = Arc::new(ScriptedProvider::open_error(ProviderError {
        retryable: false,
        message: "auth failed (401)".into(),
        ..Default::default()
    }));

    let agent = Agent::builder()
        .provider(provider)
        .tools(reg.mount(&[] as &[&str]))
        .build();
    let outcome = agent.run_to_completion("go", AutoRespond::AllowAll).await;

    assert_eq!(
        outcome.stop,
        StopReason::ProviderError,
        "a failed open must surface as Outcome.stop == ProviderError"
    );
    assert_eq!(
        outcome.error.as_deref(),
        Some("auth failed (401)"),
        "the provider error message must be captured in Outcome.error, not dropped"
    );
    // And it must NOT look like a vacuous success.
    assert!(
        outcome.text.is_empty(),
        "no bogus assistant text on a failed open"
    );
    assert!(
        outcome.tool_results.is_empty(),
        "no tool results on a failed open"
    );
}

// ── max_rounds fuse maps to StopReason::MaxRounds (event + Outcome) ───────────
#[tokio::test]
async fn max_rounds_stop_reason() {
    let mut reg = ToolRegistry::new();
    reg.register(Arc::new(EchoTool));
    // Every round the model emits a tool call → never stops on its own → the
    // max_rounds fuse must trip. Provide enough scripted rounds to exceed the cap.
    let mut turns = Vec::new();
    for i in 0..10 {
        turns.push(vec![
            StreamEvent::ToolCall(tool_call(&format!("c{i}"), "echo", "{\"text\":\"x\"}")),
            StreamEvent::Done { truncated: false },
        ]);
    }
    let provider = Arc::new(MockProvider::new(turns));

    let handle = Agent::builder()
        .provider(provider)
        .tools(reg.mount(&["echo"]))
        .max_rounds(2)
        .build()
        .spawn();
    handle.commands.send(send("loop")).unwrap();

    let mut events = handle.events;
    let mut reason: Option<StopReason> = None;
    let mut saw_warn_notice = false;
    let mut saw_error_event = false;
    let driven = tokio::time::timeout(OUTER_GUARD, async {
        while let Some(ev) = events.recv().await {
            match ev {
                AgentEvent::SystemNotice(notice)
                    if notice.event_id.starts_with("warn-max-rounds:")
                        && notice.kind == jeikcode_kernel::event::NoticeKind::Warning
                        && notice.severity == jeikcode_kernel::event::NoticeSeverity::Warning
                        && notice.status == jeikcode_kernel::event::NoticeStatus::Settled =>
                {
                    saw_warn_notice = true;
                }
                AgentEvent::Error { .. } => saw_error_event = true,
                AgentEvent::TurnComplete { reason: r } => {
                    reason = Some(r);
                    break;
                }
                _ => {}
            }
        }
        reason
    })
    .await
    .expect("max_rounds turn must complete, not hang");
    assert_eq!(
        driven,
        Some(StopReason::MaxRounds),
        "a max_rounds fuse must end the turn with StopReason::MaxRounds"
    );
    assert!(
        saw_warn_notice,
        "soft landing must emit warn-max-rounds Warning notice"
    );
    assert!(
        !saw_error_event,
        "soft landing must NOT emit AgentEvent::Error"
    );

    // And via run_to_completion, the Outcome reports StopReason::MaxRounds cleanly (no Outcome.error).
    let mut turns2 = Vec::new();
    for i in 0..10 {
        turns2.push(vec![
            StreamEvent::ToolCall(tool_call(&format!("c{i}"), "echo", "{\"text\":\"x\"}")),
            StreamEvent::Done { truncated: false },
        ]);
    }
    let provider2 = Arc::new(MockProvider::new(turns2));
    let mut reg2 = ToolRegistry::new();
    reg2.register(Arc::new(EchoTool));
    let agent = Agent::builder()
        .provider(provider2)
        .tools(reg2.mount(&["echo"]))
        .max_rounds(2)
        .build();
    let outcome = tokio::time::timeout(
        OUTER_GUARD,
        agent.run_to_completion("loop", AutoRespond::AllowAll),
    )
    .await
    .expect("max_rounds run_to_completion must not hang");
    assert_eq!(
        outcome.stop,
        StopReason::MaxRounds,
        "Outcome.stop must be MaxRounds"
    );
    assert!(
        outcome.error.is_none(),
        "soft landing emits a warning notice, not a red Outcome.error; got {:?}",
        outcome.error
    );
}

// ── The offer_continuation continuation fuse stops a runaway loop ───────────────────────
//
// A `offer_continuation` hook that ALWAYS returns Some("more"), with the DEFAULT fuse
// (max_continuations = Some(50)) and max_rounds = None: WITHOUT the fuse
// this loops forever (the model never gets agency to stop). WITH it, the turn ends
// after the cap with StopReason::MaxContinuations and an Error is emitted. The
// outer guard proves it does not hang.
struct AlwaysContinueHook;

#[async_trait]
impl LifecycleHooks for AlwaysContinueHook {
    async fn offer_continuation(&self, _convo: &Conversation) -> Option<String> {
        Some("more".to_string())
    }
}

#[tokio::test]
async fn turn_end_continuation_fuse_stops_runaway() {
    // The provider returns a content-bearing no-tool-call response → the model
    // "wants to stop" every round, but the always-continue hook keeps injecting →
    // only the fuse can break the loop. `AlwaysStopProvider` yields `TextDelta`+`Done`
    // every round (a REAL stop, not a content-free `Done` — which the kernel now
    // treats as an empty-200 and retries), exactly modelling this.
    let reg = ToolRegistry::new();
    let provider = Arc::new(AlwaysStopProvider::new("(stop)"));

    let mut handle = Agent::builder()
        .provider(provider)
        .tools(reg.mount(&[] as &[&str]))
        .hooks(Arc::new(AlwaysContinueHook))
        // max_rounds None (the default) → ONLY the continuation fuse can stop this.
        .build()
        .spawn();
    handle.commands.send(send("go")).unwrap();

    let (reason, error_msg) = tokio::time::timeout(OUTER_GUARD, async {
        let mut reason: Option<StopReason> = None;
        let mut error_msg: Option<String> = None;
        while let Some(ev) = handle.events.recv().await {
            match ev {
                AgentEvent::Error { message, .. } => error_msg = Some(message),
                AgentEvent::TurnComplete { reason: r } => {
                    reason = Some(r);
                    break;
                }
                _ => {}
            }
        }
        (reason, error_msg)
    })
    .await
    .expect("the offer_continuation fuse must STOP the runaway loop, not hang forever");

    assert_eq!(
        reason,
        Some(StopReason::MaxContinuations),
        "the runaway offer_continuation loop must end with StopReason::MaxContinuations"
    );
    assert!(
        error_msg
            .as_deref()
            .is_some_and(|m| m.contains("continuation")),
        "an Error mentioning continuations must be emitted; got {error_msg:?}"
    );
}

// ── A custom (small) fuse value is honored, and unlimited (None) opts out ─────
#[tokio::test]
async fn turn_end_continuation_fuse_is_configurable() {
    let reg = ToolRegistry::new();
    // A content-bearing stop every round (see the runaway test) — a content-free
    // `Done` would now be retried as an empty-200 instead of looping the fuse.
    let provider = Arc::new(AlwaysStopProvider::new("(stop)"));

    let mut handle = Agent::builder()
        .provider(provider)
        .tools(reg.mount(&[] as &[&str]))
        .hooks(Arc::new(AlwaysContinueHook))
        .max_continuations(3)
        .build()
        .spawn();
    handle.commands.send(send("go")).unwrap();

    let reason = tokio::time::timeout(OUTER_GUARD, async {
        let mut reason: Option<StopReason> = None;
        while let Some(ev) = handle.events.recv().await {
            if let AgentEvent::TurnComplete { reason: r } = ev {
                reason = Some(r);
                break;
            }
        }
        reason
    })
    .await
    .expect("a small fuse must stop the loop quickly");
    assert_eq!(reason, Some(StopReason::MaxContinuations));
}

// ── A cancelled turn ends with StopReason::Cancelled ─────────────────────────
//
// Mid-turn cancel: a tool call is in flight; we send Cancel; the turn must end
// Cancelled (the StopReason on the terminal TurnComplete) AND still emit the
// AgentEvent::Cancelled marker.
#[tokio::test]
async fn cancel_reason() {
    let reg = ToolRegistry::new();
    // The provider opens then PENDS forever after a delta, so the turn is parked
    // mid-stream when Cancel arrives → the mid-stream cancel path fires.
    let provider = Arc::new(jeikcode_kernel::testkit::SilentStreamProvider::new(vec![
        StreamEvent::TextDelta("thinking".into()),
    ]));

    let mut handle = Agent::builder()
        .provider(provider)
        .tools(reg.mount(&[] as &[&str]))
        .build()
        .spawn();
    handle.commands.send(send("go")).unwrap();

    let (saw_marker, reason) = tokio::time::timeout(OUTER_GUARD, async {
        // Give the turn a moment to park mid-stream, then cancel.
        tokio::task::yield_now().await;
        handle.commands.send(AgentCommand::Cancel).unwrap();
        let mut saw_marker = false;
        let mut reason: Option<StopReason> = None;
        while let Some(ev) = handle.events.recv().await {
            match ev {
                AgentEvent::Cancelled => saw_marker = true,
                AgentEvent::TurnComplete { reason: r } => {
                    reason = Some(r);
                    break;
                }
                _ => {}
            }
        }
        (saw_marker, reason)
    })
    .await
    .expect("a cancelled turn must terminate, not hang");

    assert!(
        saw_marker,
        "the AgentEvent::Cancelled marker must still be emitted"
    );
    assert_eq!(
        reason,
        Some(StopReason::Cancelled),
        "a cancelled turn must end with StopReason::Cancelled"
    );
}

// ── A stream timeout ends with StopReason::Timeout ───────────────────────────
#[tokio::test(start_paused = true)]
async fn timeout_reason() {
    let reg = ToolRegistry::new();
    let provider = Arc::new(jeikcode_kernel::testkit::SilentStreamProvider::new(vec![
        StreamEvent::TextDelta("partial".into()),
    ]));

    let mut handle = Agent::builder()
        .provider(provider)
        .tools(reg.mount(&[] as &[&str]))
        .stream_timeout(Duration::from_millis(50))
        .build()
        .spawn();
    handle.commands.send(send("go")).unwrap();

    // Virtual time: a partial-response stall walks the unified ladder
    // (0+2+5+10+15+30+45+60+90 = 257s) before clean-failing with Timeout.
    let reason = tokio::time::timeout(Duration::from_secs(300), async {
        let mut reason: Option<StopReason> = None;
        while let Some(ev) = handle.events.recv().await {
            if let AgentEvent::TurnComplete { reason: r } = ev {
                reason = Some(r);
                break;
            }
        }
        reason
    })
    .await
    .expect("a timed-out turn must clean-fail after exhausting retries, not hang");
    assert_eq!(
        reason,
        Some(StopReason::Timeout),
        "a timed-out turn must end with StopReason::Timeout after exhausting retries"
    );
}

// ── round-cap checkpoint (round_cap_checkpoint = true) ───────────────────────

/// Build a MockProvider that always calls the "echo" tool — so a max_rounds fuse
/// will always trip. Provides `n` scripted tool-calling rounds (mirroring the
/// `max_rounds_stop_reason` test's scaffolding).
fn scripted_tool_rounds(n: usize) -> Arc<MockProvider> {
    let mut turns = Vec::new();
    for i in 0..n {
        turns.push(vec![
            StreamEvent::ToolCall(tool_call(&format!("c{i}"), "echo", "{\"text\":\"x\"}")),
            StreamEvent::Done { truncated: false },
        ]);
    }
    Arc::new(MockProvider::new(turns))
}

/// A ToolRegistry with the echo tool mounted (required so tool calls resolve).
fn echo_tools() -> jeikcode_kernel::tool::MountedTools {
    let mut reg = ToolRegistry::new();
    reg.register(Arc::new(EchoTool));
    reg.mount(&["echo"])
}

#[tokio::test]
async fn round_cap_checkpoint_continue_rearms_then_stop() {
    // Cap = 2; 5 scripted tool-calling rounds. At round 3 (> cap 2) the first
    // checkpoint fires: we answer continue → cap grows to 4. At round 5 (> cap 4)
    // the second checkpoint fires: we answer stop → MaxRounds.
    let provider = scripted_tool_rounds(5);
    let mut handle = Agent::builder()
        .provider(provider)
        .tools(echo_tools())
        .max_rounds(2)
        .round_cap_checkpoint(true)
        .build()
        .spawn();
    handle
        .commands
        .send(AgentCommand::SendMessage {
            text: "go".into(),
            images: vec![],
        })
        .unwrap();

    let mut checkpoints = 0;
    let mut stop = None;
    let outcome = tokio::time::timeout(OUTER_GUARD, async {
        while let Some(ev) = handle.events.recv().await {
            match ev {
                AgentEvent::Request { id, kind, .. }
                    if kind == jeikcode_kernel::ROUND_CAP_CHECKPOINT_KIND =>
                {
                    checkpoints += 1;
                    let cont = checkpoints == 1; // first → continue, second → stop
                    handle
                        .commands
                        .send(AgentCommand::Respond {
                            id,
                            value: serde_json::json!({ "continue": cont }),
                        })
                        .unwrap();
                }
                AgentEvent::TurnComplete { reason } => {
                    stop = Some(reason);
                    break;
                }
                _ => {}
            }
        }
    })
    .await;
    outcome.expect("round_cap_checkpoint_continue_rearms_then_stop must not hang");
    assert_eq!(
        checkpoints, 2,
        "continue must re-arm to trigger a second checkpoint"
    );
    assert!(
        matches!(stop, Some(StopReason::MaxRounds)),
        "stop on second checkpoint must be MaxRounds; got {stop:?}"
    );
}

#[tokio::test]
async fn round_cap_checkpoint_null_response_stops_fail_closed() {
    let provider = scripted_tool_rounds(5);
    let mut handle = Agent::builder()
        .provider(provider)
        .tools(echo_tools())
        .max_rounds(2)
        .round_cap_checkpoint(true)
        .build()
        .spawn();
    handle
        .commands
        .send(AgentCommand::SendMessage {
            text: "go".into(),
            images: vec![],
        })
        .unwrap();

    let mut stop = None;
    let outcome = tokio::time::timeout(OUTER_GUARD, async {
        while let Some(ev) = handle.events.recv().await {
            match ev {
                AgentEvent::Request { id, kind, .. }
                    if kind == jeikcode_kernel::ROUND_CAP_CHECKPOINT_KIND =>
                {
                    // Driver answers Null (simulates unattended / timed-out driver)
                    handle
                        .commands
                        .send(AgentCommand::Respond {
                            id,
                            value: serde_json::Value::Null,
                        })
                        .unwrap();
                }
                AgentEvent::TurnComplete { reason } => {
                    stop = Some(reason);
                    break;
                }
                _ => {}
            }
        }
    })
    .await;
    outcome.expect("round_cap_checkpoint_null_response_stops_fail_closed must not hang");
    assert!(
        matches!(stop, Some(StopReason::MaxRounds)),
        "Null response → fail-closed stop must be MaxRounds; got {stop:?}"
    );
}

#[tokio::test]
async fn round_cap_checkpoint_cancel_stops_as_cancelled() {
    // Cancelling AT the checkpoint (rather than answering stop) must terminate
    // the turn as Cancelled, not MaxRounds: `Cancel` resolves the pending
    // Request to Null so `continue` reads false, but the in-scope cancel token
    // is set, so `run_turn` funnels through the cancel path. Also asserts no
    // hang (the Cancel must actually terminate the turn).
    let provider = scripted_tool_rounds(5);
    let mut handle = Agent::builder()
        .provider(provider)
        .tools(echo_tools())
        .max_rounds(2)
        .round_cap_checkpoint(true)
        .build()
        .spawn();
    handle
        .commands
        .send(AgentCommand::SendMessage {
            text: "go".into(),
            images: vec![],
        })
        .unwrap();

    let mut saw_cancelled_event = false;
    let mut stop = None;
    let outcome = tokio::time::timeout(OUTER_GUARD, async {
        while let Some(ev) = handle.events.recv().await {
            match ev {
                AgentEvent::Request { kind, .. }
                    if kind == jeikcode_kernel::ROUND_CAP_CHECKPOINT_KIND =>
                {
                    // Cancel instead of Respond: the user aborted at the prompt.
                    handle.commands.send(AgentCommand::Cancel).unwrap();
                }
                AgentEvent::Cancelled => {
                    saw_cancelled_event = true;
                }
                AgentEvent::TurnComplete { reason } => {
                    stop = Some(reason);
                    break;
                }
                _ => {}
            }
        }
    })
    .await;
    outcome.expect("round_cap_checkpoint_cancel_stops_as_cancelled must not hang");
    assert!(
        matches!(stop, Some(StopReason::Cancelled)),
        "cancel at checkpoint must end the turn as Cancelled; got {stop:?}"
    );
    assert!(
        saw_cancelled_event,
        "cancel path must emit AgentEvent::Cancelled"
    );
}

#[tokio::test]
async fn round_cap_checkpoint_off_enters_soft_landing_warning() {
    // Default (round_cap_checkpoint = false): hitting the cap skips checkpoint,
    // emits one Warning SystemNotice (NO AgentEvent::Error), and ends with MaxRounds.
    let provider = scripted_tool_rounds(5);
    let mut handle = Agent::builder()
        .provider(provider)
        .tools(echo_tools())
        .max_rounds(2) // round_cap_checkpoint defaults to false
        .build()
        .spawn();
    handle
        .commands
        .send(AgentCommand::SendMessage {
            text: "go".into(),
            images: vec![],
        })
        .unwrap();

    let mut warn_notices = 0usize;
    let mut error_events = 0usize;
    let mut requests = 0usize;
    let mut stop = None;
    let outcome = tokio::time::timeout(OUTER_GUARD, async {
        while let Some(ev) = handle.events.recv().await {
            match ev {
                AgentEvent::Request { kind, .. }
                    if kind == jeikcode_kernel::ROUND_CAP_CHECKPOINT_KIND =>
                {
                    requests += 1;
                }
                AgentEvent::SystemNotice(notice)
                    if notice.event_id.starts_with("warn-max-rounds:") =>
                {
                    assert_eq!(notice.kind, jeikcode_kernel::event::NoticeKind::Warning);
                    assert_eq!(
                        notice.severity,
                        jeikcode_kernel::event::NoticeSeverity::Warning
                    );
                    assert_eq!(notice.status, jeikcode_kernel::event::NoticeStatus::Settled);
                    warn_notices += 1;
                }
                AgentEvent::Error { .. } => {
                    error_events += 1;
                }
                AgentEvent::TurnComplete { reason } => {
                    stop = Some(reason);
                    break;
                }
                _ => {}
            }
        }
    })
    .await;
    outcome.expect("round_cap_checkpoint_off_enters_soft_landing_warning must not hang");
    assert_eq!(requests, 0, "checkpoint must never be emitted when off");
    assert_eq!(
        warn_notices, 1,
        "exactly one warn-max-rounds notice must be emitted"
    );
    assert_eq!(
        error_events, 0,
        "soft landing must not emit AgentEvent::Error"
    );
    assert!(
        matches!(stop, Some(StopReason::MaxRounds)),
        "stop must be MaxRounds when checkpoint is off; got {stop:?}"
    );
}

// ── A rejected prompt ends with StopReason::PromptRejected ────────────────────
#[tokio::test]
async fn prompt_rejected_reason() {
    let reg = ToolRegistry::new();
    let provider = Arc::new(ScriptedProvider::events(vec![StreamEvent::Done {
        truncated: false,
    }]));

    let agent = Agent::builder()
        .provider(provider)
        .tools(reg.mount(&[] as &[&str]))
        .hooks(Arc::new(jeikcode_kernel::testkit::RejectPromptHook))
        .build();
    let outcome = agent.run_to_completion("go", AutoRespond::AllowAll).await;

    assert_eq!(
        outcome.stop,
        StopReason::PromptRejected,
        "a rejected prompt must surface as Outcome.stop == PromptRejected"
    );
    assert!(
        outcome
            .error
            .as_deref()
            .is_some_and(|m| m.contains("rejected")),
        "the rejection reason must be captured in Outcome.error; got {:?}",
        outcome.error
    );
}

#[tokio::test]
async fn max_rounds_zero_builder_is_unbounded() {
    let mut reg = ToolRegistry::new();
    reg.register(Arc::new(EchoTool));
    let provider = Arc::new(MockProvider::new(vec![
        vec![
            StreamEvent::ToolCall(tool_call("c1", "echo", "{\"text\":\"1\"}")),
            StreamEvent::Done { truncated: false },
        ],
        vec![
            StreamEvent::ToolCall(tool_call("c2", "echo", "{\"text\":\"2\"}")),
            StreamEvent::Done { truncated: false },
        ],
        vec![
            StreamEvent::ToolCall(tool_call("c3", "echo", "{\"text\":\"3\"}")),
            StreamEvent::Done { truncated: false },
        ],
        vec![
            StreamEvent::TextDelta("all done".into()),
            StreamEvent::Done { truncated: false },
        ],
    ]));
    let outcome = Agent::builder()
        .provider(provider)
        .tools(reg.mount(&["echo"]))
        .max_rounds(0)
        .build()
        .run_to_completion("run unbounded", AutoRespond::AllowAll)
        .await;
    assert_eq!(outcome.stop, StopReason::Stopped);
    assert_eq!(outcome.tool_results.len(), 3);
    assert!(outcome.text.contains("all done"));
}

#[tokio::test]
async fn max_rounds_soft_landing_contract_and_tool_rejection() {
    use futures::stream::BoxStream;
    use jeikcode_kernel::event::{NoticeKind, NoticeSeverity, NoticeStatus};
    use jeikcode_kernel::hook::TurnCtx;
    use jeikcode_kernel::message::{Message, Role, TURN_DIAGNOSTIC_ORIGIN};
    use jeikcode_kernel::provider::{ChatOptions, LlmProvider, ToolChoice};
    use jeikcode_kernel::tool::ToolDef;
    use std::sync::Mutex;

    struct CaptureProvider {
        responses: Mutex<Vec<Vec<StreamEvent>>>,
        captured: Arc<Mutex<Vec<(Vec<Message>, Vec<ToolDef>, ChatOptions)>>>,
    }
    #[async_trait]
    impl LlmProvider for CaptureProvider {
        fn model_name(&self) -> &str {
            "capture-mock"
        }
        async fn chat_stream(
            &self,
            messages: &[Message],
            tools: &[ToolDef],
            options: &ChatOptions,
        ) -> Result<BoxStream<'static, StreamEvent>, ProviderError> {
            self.captured.lock().unwrap().push((
                messages.to_vec(),
                tools.to_vec(),
                options.clone(),
            ));
            let evs = {
                let mut g = self.responses.lock().unwrap();
                if g.is_empty() {
                    vec![StreamEvent::Done { truncated: false }]
                } else {
                    g.remove(0)
                }
            };
            Ok(Box::pin(futures::stream::iter(evs)))
        }
    }

    struct ContinuationAndSnapHook {
        cont_calls: Arc<Mutex<usize>>,
        snapshot_msgs: Arc<Mutex<Vec<Message>>>,
    }
    #[async_trait]
    impl LifecycleHooks for ContinuationAndSnapHook {
        async fn offer_continuation(&self, _convo: &Conversation) -> Option<String> {
            *self.cont_calls.lock().unwrap() += 1;
            Some("keep going".into())
        }
        async fn turn_complete(&self, convo: &Conversation, _r: &StopReason, _c: &TurnCtx) {
            *self.snapshot_msgs.lock().unwrap() = convo.messages.clone();
        }
    }

    // 场景 A：正常软着陆（模型遵守 ToolChoice::None 输出总结，跳过 continuation，快照单轨保留结构化通知）
    let mut reg = ToolRegistry::new();
    reg.register(Arc::new(EchoTool));
    let captured = Arc::new(Mutex::new(Vec::new()));
    let provider = Arc::new(CaptureProvider {
        responses: Mutex::new(vec![
            vec![
                StreamEvent::ToolCall(tool_call("c1", "echo", "{\"text\":\"step1\"}")),
                StreamEvent::Done { truncated: false },
            ],
            vec![
                StreamEvent::TextDelta("Completed step 1; next check tests.".into()),
                StreamEvent::Done { truncated: true }, // 验证软着陆不触发 truncation/continuation 续跑
            ],
        ]),
        captured: captured.clone(),
    });
    let cont_calls = Arc::new(Mutex::new(0));
    let snapshot_msgs = Arc::new(Mutex::new(Vec::new()));
    let hook = Arc::new(ContinuationAndSnapHook {
        cont_calls: cont_calls.clone(),
        snapshot_msgs: snapshot_msgs.clone(),
    });
    let mut handle = Agent::builder()
        .provider(provider)
        .tools(reg.mount(&["echo"]))
        .hooks(hook)
        .max_rounds(1)
        .build()
        .spawn();
    handle.commands.send(send("do work")).unwrap();

    let mut notices = Vec::new();
    let mut errs = 0usize;
    let mut stop = None;
    let mut final_text = String::new();
    let mut saw_ttft = false;
    while let Some(ev) = handle.events.recv().await {
        match ev {
            AgentEvent::TextDelta(t) => final_text.push_str(&t),
            AgentEvent::Usage(m) => {
                if m.ttft_ms.is_some() {
                    saw_ttft = true;
                }
            }
            AgentEvent::SystemNotice(n) => notices.push(n),
            AgentEvent::Error { .. } => errs += 1,
            AgentEvent::TurnComplete { reason } => {
                stop = Some(reason);
                break;
            }
            _ => {}
        }
    }
    let _ = handle.commands.send(AgentCommand::Shutdown);
    let _ = handle.task.await;

    assert_eq!(stop, Some(StopReason::MaxRounds));
    assert_eq!(errs, 0, "soft landing must never emit AgentEvent::Error");
    assert!(
        saw_ttft,
        "MessageMeta.ttft_ms must be populated on streamed round"
    );
    assert_eq!(
        *cont_calls.lock().unwrap(),
        0,
        "offer_continuation must be skipped in soft landing"
    );
    assert!(final_text.contains("Completed step 1"));
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].event_id, "warn-max-rounds:1");
    assert_eq!(notices[0].kind, NoticeKind::Warning);
    assert_eq!(notices[0].severity, NoticeSeverity::Warning);
    assert_eq!(notices[0].status, NoticeStatus::Settled);

    let reqs = captured.lock().unwrap();
    assert_eq!(reqs.len(), 2, "round 1 + 1 soft landing round");
    assert_eq!(reqs[0].2.tool_choice, ToolChoice::Auto);
    assert_eq!(
        reqs[1].2.tool_choice,
        ToolChoice::None,
        "soft landing must force ToolChoice::None"
    );
    assert!(
        !reqs[1].1.is_empty(),
        "&defs tools slice must be preserved for prefix cache"
    );
    let injected = reqs[1].0.last().expect("injected landing prompt");
    assert_eq!(injected.role, Role::User);
    assert!(injected.synthetic);
    assert!(injected.text.contains("Do NOT invoke any tools"));

    let snap = snapshot_msgs.lock().unwrap();
    let diag_msgs: Vec<_> = snap
        .iter()
        .filter(|m| m.internal_origin.as_deref() == Some(TURN_DIAGNOSTIC_ORIGIN))
        .collect();
    assert_eq!(
        diag_msgs.len(),
        1,
        "snapshot must hold single structured diagnostic"
    );
    assert_eq!(diag_msgs[0].id.as_deref(), Some("warn-max-rounds:1"));
    let meta = diag_msgs[0]
        .notice
        .as_ref()
        .expect("Message.notice must be populated");
    assert_eq!(meta.kind, NoticeKind::Warning);
    assert_eq!(meta.severity, NoticeSeverity::Warning);
    assert_eq!(meta.status, NoticeStatus::Settled);
    assert_eq!(meta.event_id.as_deref(), Some("warn-max-rounds:1"));

    // 场景 B：模型无视 ToolChoice::None 仍返回 tool_calls 时，必须硬拦截并不执行工具
    let mut reg2 = ToolRegistry::new();
    reg2.register(Arc::new(EchoTool));
    let provider2 = Arc::new(CaptureProvider {
        responses: Mutex::new(vec![
            vec![
                StreamEvent::ToolCall(tool_call("c1", "echo", "{\"text\":\"ok\"}")),
                StreamEvent::Done { truncated: false },
            ],
            vec![
                StreamEvent::ToolCall(tool_call("c2-rogue", "echo", "{\"text\":\"illegal\"}")),
                StreamEvent::Done { truncated: false },
            ],
        ]),
        captured: Arc::new(Mutex::new(Vec::new())),
    });
    let outcome2 = Agent::builder()
        .provider(provider2)
        .tools(reg2.mount(&["echo"]))
        .max_rounds(1)
        .build()
        .run_to_completion("try rogue tool", AutoRespond::AllowAll)
        .await;
    assert_eq!(outcome2.stop, StopReason::MaxRounds);
    assert_eq!(
        outcome2.tool_results.len(),
        2,
        "c1 executed + c2 rejected paired error result"
    );
    assert!(!outcome2.tool_results[0].is_error);
    assert!(outcome2.tool_results[1].is_error);
    assert!(outcome2.tool_results[1]
        .content
        .contains("Tool execution disabled"));
}
