//! Phase 2 端到端集成测试：验证通过完整 `prepare` / `assemble` 启动的编码会话
//! 自动写入去重上下文包（SHA-256 bundle）、增量 `.trace.jsonl`、扩展 `.toolmetrics.jsonl`
//!（含参数自动修复/目标摘要/结果字节数），并且 `reconstruct_upstream_request` 与 `evaluate_session_metrics`
//! 能精确还原每轮发包与关键指标。

use std::sync::Arc;
use std::time::Duration;

use jeikcode_capabilities::session::{
    default_bundles_dir_for, evaluate_session_metrics, read_trace_records,
    reconstruct_upstream_request, SessionManager, ToolMetricStatus,
};
use jeikcode_coding::{assemble, prepare, CodingAgentConfig, PrepareOptions};
use jeikcode_kernel::event::{AgentCommand, AgentEvent};
use jeikcode_kernel::stream::{StreamEvent, TokenUsage};
use jeikcode_kernel::testkit::RecordingProvider;
use jeikcode_kernel::tool::ToolCall;

#[ctor::ctor]
fn _isolate_jeikcode_home() {
    jeikcode_kernel::test_support::isolate_home();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_assembly_persists_lossless_eval_trace_and_enriched_toolmetrics() {
    let home = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let _home = jeikcode_config::test_util::IsolatedHome::at(home.path());

    std::fs::create_dir_all(project.path().join("src")).unwrap();
    std::fs::write(project.path().join("src/demo.txt"), "hello phase2 trace\n").unwrap();

    let mut cfg = CodingAgentConfig::new("k", "http://unused", "test-model", project.path());
    cfg.timeouts = cfg.timeouts.with_content_liveness(Duration::from_secs(5));
    cfg.request_timeout = Some(Duration::from_secs(5));

    let opts = PrepareOptions {
        skill_dirs: Some(vec![project.path().join("skills")]),
        ..Default::default()
    };
    let mut parts = prepare(&cfg, opts).await.unwrap();
    let session_id = parts.session.as_ref().unwrap().id.clone();
    let sessions_root = parts.session.as_ref().unwrap().manager.root().to_path_buf();

    // 刻意在工具参数结尾加入尾随逗号，触发 RepairToolArgsMiddleware 并验证 repaired_args=true 落盘。
    let provider = Arc::new(RecordingProvider::new(vec![
        vec![
            StreamEvent::Usage(TokenUsage {
                prompt: 200,
                completion: 15,
                cached: 0,
            }),
            StreamEvent::ToolCall(ToolCall {
                id: "call-read-1".into(),
                name: "read".into(),
                arguments: r#"{"file_path":"src/demo.txt",}"#.into(),
            }),
            StreamEvent::Done { truncated: false },
        ],
        vec![
            StreamEvent::Usage(TokenUsage {
                prompt: 400,
                completion: 12,
                cached: 300,
            }),
            StreamEvent::TextDelta("done reading".into()),
            StreamEvent::Done { truncated: false },
        ],
    ]));

    let mut handle = assemble(&mut parts, &cfg, provider.clone())
        .unwrap()
        .spawn();
    handle
        .commands
        .send(AgentCommand::SendMessage {
            text: "Inspect src/demo.txt".into(),
            images: vec![],
        })
        .unwrap();

    while let Some(ev) = tokio::time::timeout(Duration::from_secs(30), handle.events.recv())
        .await
        .expect("turn should finish cleanly")
    {
        if matches!(ev, AgentEvent::TurnComplete { .. }) {
            break;
        }
    }
    handle.commands.send(AgentCommand::Shutdown).unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(15), handle.task).await;

    let recorded = provider.recorded();
    assert_eq!(recorded.len(), 2, "expected two model rounds");

    let mgr = SessionManager::with_root(&sessions_root);
    let trace = read_trace_records(&mgr, &session_id).unwrap();
    assert!(
        trace.len() >= 5,
        "expected request/response/turn records: {trace:?}"
    );

    // 静态上下文包应按 SHA-256 去重：两轮同一 system + tools 只落盘 1 个 bundle 文件。
    let bundles_dir = default_bundles_dir_for(&mgr);
    let bundle_count = std::fs::read_dir(&bundles_dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .count();
    assert_eq!(bundle_count, 1);

    // 验证两轮重放结果与上游真实收到的 (messages, tools, options) 100% 字节一致。
    for (idx, (exp_msgs, exp_tools, exp_opts)) in recorded.iter().enumerate() {
        let round_seq = (idx + 1) as u64;
        let restored = reconstruct_upstream_request(&mgr, &session_id, round_seq).unwrap();
        assert_eq!(
            &restored.messages, exp_msgs,
            "round {round_seq} messages mismatch"
        );
        assert_eq!(
            &restored.tools, exp_tools,
            "round {round_seq} tools mismatch"
        );
        assert_eq!(
            restored.options.reasoning_effort, exp_opts.reasoning_effort,
            "round {round_seq} reasoning_effort mismatch"
        );
        assert_eq!(
            restored.options.max_tokens, exp_opts.max_tokens,
            "round {round_seq} max_tokens mismatch"
        );
        assert_eq!(
            restored.options.temperature, exp_opts.temperature,
            "round {round_seq} temperature mismatch"
        );
        assert_eq!(
            restored.options.tool_choice, exp_opts.tool_choice,
            "round {round_seq} tool_choice mismatch"
        );
    }

    // 验证工具指标包含参数修复标记、目标摘要、原始字节数与轮次归属。
    let metrics = mgr.read_tool_metrics(&session_id).unwrap();
    let read_metric = &metrics["call-read-1"];
    assert_eq!(read_metric.status, ToolMetricStatus::Done);
    assert_eq!(read_metric.repaired_args, Some(true));
    assert_eq!(read_metric.target_hint.as_deref(), Some("src/demo.txt"));
    assert!(read_metric.result_bytes.unwrap_or(0) > 0);
    assert_eq!(read_metric.turn_id, Some(1));
    assert_eq!(read_metric.round, Some(1));

    // 验证 meta.turn_stats 与 eval 汇总报告。
    let meta = mgr.read_meta(&session_id).unwrap();
    assert_eq!(meta.turn_stats[0].stop_reason.as_deref(), Some("stopped"));

    let eval = evaluate_session_metrics(&mgr, &session_id).unwrap();
    assert_eq!(eval.round_count, 2);
    assert_eq!(eval.turn_count, 1);
    assert_eq!(eval.stop_reasons.get("stopped").copied(), Some(1));
    assert_eq!(eval.tool_calls_total, 1);
    assert_eq!(eval.repaired_args_count, 1);
    assert_eq!(eval.total_prompt_tokens, 600);
    assert_eq!(eval.total_cached_tokens, 300);
    assert!((eval.kv_cache_hit_rate - 0.5).abs() < 1e-6);
}
