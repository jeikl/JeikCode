//! C1 — the FULL assembly, end to end against a scripted provider and an isolated
//! `$JEIKCODE_HOME`. One sequential test fn (the env var is process-global; parallel
//! tests would race it) walking the whole lifecycle:
//!
//!   fresh prepare → memory injected → turn persists snapshot/meta/jsonl →
//!   resume continues the SAME session (turn_id monotonic across processes) →
//!   respawn on the SAME parts preserves allow-always approval grants.

use std::sync::Arc;
use std::time::Duration;

use jeikcode_coding::{assemble, prepare, CodingAgentConfig, PrepareOptions, SessionMode};
use jeikcode_kernel::event::{AgentCommand, AgentEvent};
use jeikcode_kernel::message::Role;
use jeikcode_kernel::stream::StreamEvent;
use jeikcode_kernel::testkit::RecordingProvider;
use jeikcode_kernel::tool::ToolCall;

#[ctor::ctor]
fn _isolate_jeikcode_home() {
    jeikcode_kernel::test_support::isolate_home();
}

fn cfg(working_dir: &std::path::Path) -> CodingAgentConfig {
    let mut c = CodingAgentConfig::new("k", "http://unused", "test-model", working_dir);
    c.timeouts = c.timeouts.with_content_liveness(Duration::from_secs(5));
    c.request_timeout = Some(Duration::from_secs(5));
    c
}

/// Bounded shutdown: an agent task that never exits on `Shutdown` would otherwise hang the
/// suite FOREVER — the Phase-4 respawn deadlock this test surfaced once the canonical `read`
/// expectation let it past Phase 1 (previously the stale `read_file` assertion failed first,
/// masking it). Fail fast with the phase instead of hanging.
async fn shutdown(handle: &mut jeikcode_kernel::agent::AgentHandle, phase: &str) {
    handle.commands.send(AgentCommand::Shutdown).unwrap();
    match tokio::time::timeout(Duration::from_secs(20), &mut handle.task).await {
        Ok(_) => {}
        Err(_) => panic!(
            "{phase}: the agent task did not exit on Shutdown (deadlock — see the test's \
             `#[ignore]` note)"
        ),
    }
}

fn text_turn(text: &str) -> Vec<StreamEvent> {
    vec![
        StreamEvent::TextDelta(text.into()),
        StreamEvent::Done { truncated: false },
    ]
}

/// Drive one user turn; answer every approval Request with `decision`.
async fn drive(
    handle: &mut jeikcode_kernel::agent::AgentHandle,
    text: &str,
    decision: Option<&str>,
) -> (Vec<AgentEvent>, usize) {
    handle
        .commands
        .send(AgentCommand::SendMessage {
            text: text.into(),
            images: vec![],
        })
        .unwrap();
    let mut events = Vec::new();
    let mut requests = 0;
    // Bounded wait: a turn that never completes (e.g. a parked tool / dead provider)
    // must FAIL with context instead of hanging the suite forever — same philosophy as
    // `shutdown()`. The label is the user text so the panic names the phase.
    let mut turn_completed = false;
    while !turn_completed {
        let ev = match tokio::time::timeout(Duration::from_secs(60), handle.events.recv()).await {
            Ok(Some(ev)) => ev,
            Ok(None) => break,
            Err(_) => {
                panic!("turn {text:?} did not complete within 60s (parked tool / dead provider?)")
            }
        };
        match &ev {
            AgentEvent::Request { id, .. } => {
                requests += 1;
                let d = decision.expect("unexpected approval Request in this phase");
                handle
                    .commands
                    .send(AgentCommand::Respond {
                        id: *id,
                        value: serde_json::json!({ "decision": d }),
                    })
                    .unwrap();
            }
            AgentEvent::TurnComplete { .. } => {
                events.push(ev);
                turn_completed = true;
                continue;
            }
            _ => {}
        }
        events.push(ev);
    }
    (events, requests)
}

// MULTI-THREAD on purpose: the bounded `shutdown()` guard below needs a second worker to
// run the 20s timer — on the default current-thread runtime a blocking task starves the
// timer, so the guard would hang instead of failing fast (production runs multi-thread).
//
// REGRESSION LOCK for the MCP teardown deadlock: the Phase-4 respawn is the only phase that
// runs a real tool, so it is what starts the session MCP process tree. Before
// `SessionMcpLease::drop` learned to tear a short-lived host's transports down
// synchronously, this test's body finished and then `Runtime::drop` waited forever on the
// parked child's stdout pipe — the suite hung and had to be `#[ignore]`d.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_assembly_lifecycle() {
    // ---- Isolated world: $JEIKCODE_HOME + a project dir, both temp. Skill dirs
    // are pinned to a temp dir too — the home-based default would scan the HOST
    // machine's real ~/.claude/skills and leak host state into this test.
    let home = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let _home = jeikcode_config::test_util::IsolatedHome::at(home.path());
    let cfg = cfg(project.path());
    let opts = || PrepareOptions {
        skill_dirs: Some(vec![project.path().join("skills")]),
        ..Default::default()
    };

    // A global memory the MemoryHook must inject.
    std::fs::write(home.path().join("memory.md"), "- the user prefers tabs\n").unwrap();

    // ================= Phase 1: fresh prepare + first turn =================
    let mut parts = prepare(&cfg, opts()).await.unwrap();

    let session_id = parts.session.as_ref().unwrap().id.clone();
    let sessions_root = parts.session.as_ref().unwrap().manager.root().to_path_buf();

    let provider1 = Arc::new(RecordingProvider::new(vec![text_turn("first answer")]));
    let calls1 = provider1.calls();
    let mut h1 = assemble(&mut parts, &cfg, provider1).unwrap().spawn();
    let (_, reqs) = drive(&mut h1, "the first task", None).await;
    assert_eq!(reqs, 0, "a text-only turn asks no approval");
    shutdown(&mut h1, "P1").await;

    // The FULL toolset rode the wire: core + codeintel + web + skills + recall + review.
    {
        let calls = calls1.lock().unwrap();
        let defs: Vec<&str> = calls[0].1.iter().map(|d| d.name.as_str()).collect();
        for expected in [
            "run_command",
            "read",
            "code_explore",
            "web_fetch",
            "use_skill",
        ] {
            assert!(
                defs.contains(&expected),
                "missing tool {expected}: {defs:?}"
            );
        }
        assert!(
            !defs.contains(&"code_review"),
            "code_review must not be mounted"
        );
        assert!(!defs.contains(&"memory"), "memory must not be mounted");
        assert!(
            !defs.contains(&"list_skills"),
            "list_skills must not be mounted"
        );
    }

    // Prefix order: persona (block 1) → workflow (block 2) (System) → MEMORY (frozen synthetic User),
    // all BEFORE the real query.
    {
        let calls = calls1.lock().unwrap();
        let first = &calls[0].0;
        let shape = || {
            first
                .iter()
                .map(|m| (&m.role, m.text[..m.text.len().min(30)].to_string()))
                .collect::<Vec<_>>()
        };
        assert_eq!(first[0].role, Role::System, "persona identity leads");
        assert!(
            first[1].role == Role::System
                && (first[1].text.starts_with("<system_rules>")
                    || first[1]
                        .text
                        .starts_with("<workflow_and_execution_discipline>")
                    || first[1]
                        .text
                        .starts_with(jeikcode_coding::persona::CRITICAL_PRECEDENCE_NOTICE)),
            "workflow discipline follows persona: {:?}",
            shape()
        );
        // Layout: persona + several System blocks (workflow / todo / explore…) → MEMORY as
        // the first synthetic User message → the real query. Assert by SHAPE, not by a
        // fixed index: the System block count changes as new blocks land.
        let leading_system = first.iter().take_while(|m| m.role == Role::System).count();
        let memory = &first[leading_system];
        assert!(
            memory.role == Role::User
                && memory.synthetic
                && (memory.text.starts_with("=== MEMORY ===")
                    || memory.text.starts_with("<memory>")),
            "memory block follows the leading System run: {:?}",
            shape()
        );
        assert!(memory.text.contains("prefers tabs"));
        assert_eq!(
            first.last().unwrap().role,
            Role::User,
            "round 1 ends at the user turn"
        );
        assert!(
            !first.last().unwrap().synthetic,
            "last user must be the real query, not a reminder"
        );
        // StatusReminderHook appends the date to the bottom of the real query; no
        // independent synthetic user message is created. The opening `<strong-reminder>`
        // exploration tail (CodeToolsFirstHook, added 2026-10-17) may sit AHEAD of it, so
        // assert the real query owns BOTH tails instead of pinning a prefix that predates
        // that feature.
        let tail = &first.last().unwrap().text;
        assert!(
            tail.starts_with("the first task") && tail.contains("Current date"),
            "date reminder belongs to the real query block: {:?}",
            shape()
        );
    }

    // The turn persisted all three session files.
    assert!(
        sessions_root
            .join(format!("{session_id}.snapshot"))
            .exists(),
        "snapshot persisted"
    );
    assert!(
        sessions_root.join(format!("{session_id}.meta")).exists(),
        "meta persisted"
    );
    assert!(
        sessions_root.join(format!("{session_id}.jsonl")).exists(),
        "transcript persisted"
    );

    // ===== Phase 2: RESPAWN on the SAME parts (model swap) continues the session ====
    // assemble() reloads the latest on-disk snapshot for a session-bound parts — a
    // plain re-assemble can never rewind a live session (the review's must-fix).
    let provider1b = Arc::new(RecordingProvider::new(vec![text_turn("post-swap answer")]));
    let calls1b = provider1b.calls();
    let mut h1b = assemble(&mut parts, &cfg, provider1b).unwrap().spawn();
    let _ = drive(&mut h1b, "the swap task", None).await;
    shutdown(&mut h1b, "P2").await;
    {
        let calls = calls1b.lock().unwrap();
        let first = &calls[0].0;
        // The user block now carries the opening `<strong-reminder>` exploration tail, so
        // match the task text itself rather than a fixed `<system-reminder>`-first prefix.
        assert!(
            first.iter().any(|m| m.text.starts_with("the first task")),
            "respawn on the same parts carries the conversation"
        );
    }

    // ================= Phase 3: resume continues the SAME session =================
    // This phase models a new process. Dropping the previous parts releases its
    // active-session lease before the new owner resumes the persisted session.
    drop(parts);
    let mut parts2 = prepare(
        &cfg,
        PrepareOptions {
            session: SessionMode::Resume(session_id.clone()),
            ..opts()
        },
    )
    .await
    .unwrap();
    let provider2 = Arc::new(RecordingProvider::new(vec![text_turn("second answer")]));
    let calls2 = provider2.calls();
    let mut h2 = assemble(&mut parts2, &cfg, provider2).unwrap().spawn();
    let _ = drive(&mut h2, "the second task", None).await;
    shutdown(&mut h2, "P3").await;

    // History continued: the resumed provider saw the first turn's exchange.
    {
        let calls = calls2.lock().unwrap();
        let first = &calls[0].0;
        assert!(
            first.iter().any(|m| m.text.starts_with("the first task")),
            "resume carries history"
        );
        assert!(
            first.iter().any(|m| m.text.starts_with("the swap task")),
            "incl. the respawned turn"
        );
        assert!(first.iter().any(|m| m.text.starts_with("the second task")));
        // Each REQUIRED System block is injected exactly once on resume (reconcile in
        // place — no duplication). Assert by uniqueness of the block markers instead of
        // a magic total: the block set grows as new discipline blocks land.
        let mut block_keys: Vec<String> = first
            .iter()
            .filter(|m| m.role == Role::System)
            .map(|m| m.text.chars().take(24).collect::<String>())
            .collect();
        let total_system_blocks = block_keys.len();
        block_keys.sort();
        block_keys.dedup();
        assert_eq!(
            block_keys.len(),
            total_system_blocks,
            "every required System block injected exactly once on resume: {block_keys:?}"
        );
        assert!(
            block_keys.len() >= 2,
            "persona + workflow must both survive the resume: {block_keys:?}"
        );
        let memory_count = first
            .iter()
            .filter(|m| {
                m.role == Role::User
                    && m.synthetic
                    && (m.text.starts_with("=== MEMORY ===") || m.text.starts_with("<memory>"))
            })
            .count();
        assert_eq!(
            memory_count, 1,
            "memory frozen user prefix exactly once (resume reconciles in place, no double-inject)"
        );
    }

    // Transcript turn_ids are MONOTONIC across the resume (the 8c06a9e2 seeding,
    // end-to-end through prepare/assemble): lines say turn 1 then turn 2.
    let jsonl = std::fs::read_to_string(sessions_root.join(format!("{session_id}.jsonl"))).unwrap();
    let turn_ids: Vec<u64> = jsonl
        .lines()
        .map(|l| {
            serde_json::from_str::<serde_json::Value>(l).unwrap()["turn_id"]
                .as_u64()
                .unwrap()
        })
        .collect();
    assert_eq!(
        turn_ids,
        vec![1, 2, 3],
        "turn ids continue across respawn AND resume — no duplicate keys"
    );

    // ============== Phase 4: respawn on the SAME parts keeps approval grants ======
    let mut parts3 = prepare(
        &cfg,
        PrepareOptions {
            session: SessionMode::Disabled, // independent of the session above
            ..opts()
        },
    )
    .await
    .unwrap();

    let risky = || ToolCall {
        id: "c1".into(),
        name: "bash".into(),
        arguments: serde_json::json!({ "command": "git reset --hard HEAD~3" }).to_string(),
    };
    let provider3 = Arc::new(RecordingProvider::new(vec![
        vec![
            StreamEvent::ToolCall(risky()),
            StreamEvent::Done { truncated: false },
        ],
        text_turn("done"),
    ]));
    let mut h3 = assemble(&mut parts3, &cfg, provider3).unwrap().spawn();
    let (_, reqs) = drive(&mut h3, "do the risky thing", Some("allow_always")).await;
    assert_eq!(reqs, 1, "the risky call asks once");
    shutdown(&mut h3, "P4 first").await;

    // RESPAWN (model swap) on the SAME parts: the identical risky call must NOT ask
    // again — the grant store survives because the approval handle lives in parts.
    let provider4 = Arc::new(RecordingProvider::new(vec![
        vec![
            StreamEvent::ToolCall(risky()),
            StreamEvent::Done { truncated: false },
        ],
        text_turn("done again"),
    ]));
    let mut h4 = assemble(&mut parts3, &cfg, provider4).unwrap().spawn();
    let (_, reqs) = drive(&mut h4, "again", None).await;
    assert_eq!(
        reqs, 0,
        "allow-always grant survives the respawn (parts own the store)"
    );
    shutdown(&mut h4, "P4 respawn").await;
}
