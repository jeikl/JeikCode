//! Hosted Linux smoke: real CodingRuntime -> global registry -> daemon GET /live SSE.
//! The only substitute is an in-process deterministic LlmProvider; snapshots, assistant
//! IDs, sequence stamps, tool execution, and HTTP frames all come from production code.
//! Copy to crates/jeikcode-daemon/examples and run with cargo run --locked. This tests
//! the registry-backed native live adapter, not the embedded LiveHub branch or browser UI.

use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, ensure, Context, Result};
use async_trait::async_trait;
use futures::{stream, FutureExt, StreamExt};
use jeikcode_coding::session_runtime_registry::SessionRuntimeRegistry;
use jeikcode_coding::{
    CodingAgentConfig, CodingProviderFactory, CodingRuntime, CodingRuntimeEvent,
    CodingRuntimeHandle, CodingRuntimeStart, PrepareOptions, ProviderBuildError, RuntimeMode,
    SessionMode, StaticPluginHookSource, TurnCompletion,
};
use jeikcode_daemon::{run_server, ServerOpts};
use jeikcode_kernel::message::{Message, Role, SessionSnapshot};
use jeikcode_kernel::provider::{ChatOptions, LlmProvider};
use jeikcode_kernel::stream::{ProviderError, StreamEvent};
use jeikcode_kernel::tool::{ToolCall, ToolDef};
use jeikcode_telemetry::{CliOverride, SessionMode as TelemetryMode};
use serde_json::{json, Value};
use tokio::sync::Notify;
use tokio::time::{sleep, timeout};

const CHUNKS: usize = 2300; // Greater than the production journal's 2048-event capacity.
const CALL_ID: &str = "native-replay-real-bash";
const PREFIX_TEXT: &str = "native-prefix|";
const REASON_A: &str = "reason-a|";
const REASON_B: &str = "reason-b|";
const NEXT_REASON: &str = "post-join-reason|";
const NEXT_TEXT: &str = "post-join-text|";
const FINAL_TEXT: &str = "native-final-after-real-tool|";
const TOOL_OUTPUT: &str = "native-tool-ok";
const DEADLINE: Duration = Duration::from_secs(30);

fn prefix_text() -> String {
    let mut text = PREFIX_TEXT.to_owned();
    for n in 0..CHUNKS {
        text.push_str(&format!("[{n}]"));
    }
    text
}

struct LocalProvider {
    calls: AtomicUsize,
    release_stream: Arc<Notify>,
}

#[async_trait]
impl LlmProvider for LocalProvider {
    fn model_name(&self) -> &str {
        "native-replay-local"
    }

    async fn chat_stream(
        &self,
        messages: &[Message],
        tools: &[ToolDef],
        _options: &ChatOptions,
    ) -> std::result::Result<futures::stream::BoxStream<'static, StreamEvent>, ProviderError> {
        let error = |message: &str| ProviderError {
            message: message.into(),
            ..Default::default()
        };
        match self.calls.fetch_add(1, Ordering::SeqCst) {
            0 => {
                if !tools.iter().any(|tool| tool.name == "run_command") {
                    return Err(error("production assembly did not mount run_command"));
                }
                let gate = self.release_stream.clone();
                Ok(stream::unfold(0usize, move |step| {
                    let gate = gate.clone();
                    async move {
                        let event = match step {
                            // Two identical reasoning fragments must both survive publication.
                            0 | 1 => StreamEvent::Reasoning(REASON_A.into()),
                            2 => StreamEvent::TextDelta(PREFIX_TEXT.into()),
                            3 => StreamEvent::Reasoning(REASON_B.into()),
                            n if n < CHUNKS + 4 => StreamEvent::TextDelta(format!("[{}]", n - 4)),
                            n if n == CHUNKS + 4 => {
                                gate.notified().await;
                                StreamEvent::Reasoning(NEXT_REASON.into())
                            }
                            n if n == CHUNKS + 5 => StreamEvent::TextDelta(NEXT_TEXT.into()),
                            n if n == CHUNKS + 6 => StreamEvent::ToolCall(ToolCall {
                                id: CALL_ID.into(),
                                name: "run_command".into(),
                                // One foreground child, no sleeps/polling descendants. Its FIFO
                                // read is deadline-bounded even if the smoke fails before release.
                                arguments: json!({
                                    "command": "exec bash -c 'exec 3<>gate.fifo; printf \"%s\\n\" \"$$\" > tool.pid; IFS= read -r -t 40 -u 3 token || exit 124; [ \"$token\" = release ] || exit 125; printf \"native-tool-ok\\n\"'"
                                }).to_string(),
                            }),
                            n if n == CHUNKS + 7 => StreamEvent::Done { truncated: false },
                            _ => return None,
                        };
                        Some((event, step + 1))
                    }
                }).boxed())
            }
            1 => {
                let result = messages.iter().find(|message| {
                    message.role == Role::Tool && message.tool_call_id.as_deref() == Some(CALL_ID)
                });
                if !result.is_some_and(|message| !message.is_error && message.text.contains(TOOL_OUTPUT)) {
                    return Err(error("second native round did not receive the successful real bash result"));
                }
                Ok(stream::iter([
                    StreamEvent::TextDelta(FINAL_TEXT.into()),
                    StreamEvent::Done { truncated: false },
                ]).boxed())
            }
            _ => Err(error("unexpected auxiliary or extra model call")),
        }
    }
}

struct LocalFactory(Arc<LocalProvider>);

impl CodingProviderFactory for LocalFactory {
    fn build(
        &self,
        _config: &CodingAgentConfig,
        _session_id: Option<&str>,
    ) -> std::result::Result<Arc<dyn LlmProvider>, ProviderBuildError> {
        Ok(self.0.clone())
    }
}

// Parse actual HTTP SSE, including fragmented network chunks and keepalive comments.
struct Sse {
    response: reqwest::Response,
    pending: Vec<u8>,
}

impl Sse {
    async fn connect(client: &reqwest::Client, url: &str) -> Result<Self> {
        let response = client.get(url).send().await?.error_for_status()?;
        ensure!(response.headers().get("content-type").and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("text/event-stream")), "GET /live is not SSE");
        Ok(Self { response, pending: Vec::new() })
    }

    async fn next(&mut self) -> Result<Value> {
        loop {
            if let Some(end) = self.pending.windows(2).position(|bytes| bytes == b"\n\n") {
                let frame = self.pending.drain(..end + 2).collect::<Vec<_>>();
                let frame = std::str::from_utf8(&frame).context("SSE frame is not UTF-8")?;
                let data = frame.lines().filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
                    .collect::<Vec<_>>().join("\n");
                if !data.is_empty() {
                    let event: Value = serde_json::from_str(&data).context("invalid native SSE JSON")?;
                    ensure!(event.is_object() && event["type"].is_string(), "malformed native event: {event}");
                    return Ok(event);
                }
                continue;
            }
            let chunk = self.response.chunk().await?.context("native SSE closed before terminal")?;
            self.pending.extend_from_slice(&chunk);
            ensure!(self.pending.len() < 2 * 1024 * 1024, "unbounded SSE frame");
        }
    }
}

#[derive(Default)]
struct Observed {
    watermark: u64,
    last_sequence: Option<u64>,
    sequences: HashSet<u64>,
    messages: HashMap<String, (String, String)>,
    gap: bool,
    live_text: Vec<Value>,
    live_reasoning: Vec<Value>,
    results: Vec<Value>,
    ignored: usize,
}

impl Observed {
    fn from_snapshot(snapshot: &Value) -> Result<Self> {
        ensure!(snapshot["type"] == "snapshot" && snapshot["replay"] == true,
            "first HTTP frame is not an authoritative replay snapshot: {snapshot}");
        let mut observed = Self {
            watermark: snapshot["through_sequence"].as_u64().context("missing replay watermark")?,
            ..Default::default()
        };
        for message in snapshot["messages"].as_array().context("missing native messages")? {
            if message["role"] == "assistant" {
                let id = message["id"].as_str().context("native assistant has no identity")?;
                ensure!(observed.messages.insert(id.into(), (
                    message["content"].as_str().context("missing assistant text")?.into(),
                    message["reasoning"].as_str().unwrap_or_default().into(),
                )).is_none(), "duplicate canonical assistant ID in snapshot");
            }
        }
        Ok(observed)
    }

    fn accept(&mut self, event: Value) -> Result<bool> {
        let kind = event["type"].as_str().context("missing wire type")?;
        ensure!(!matches!(kind, "error" | "warning" | "persistence_warning"), "unexpected native diagnostic: {event}");
        if kind == "replay_gap" {
            ensure!(!self.gap && event["replay"] == true, "missing/duplicate gap provenance");
            ensure!(event["first_available_sequence"].as_u64().is_some_and(|n| n > 0 && n <= self.watermark),
                "gap does not describe actual eviction: {event}");
            self.gap = true;
            return Ok(false);
        }
        let sequence = event["sequence"].as_u64().context("missing sequenced native event")?;
        ensure!(self.sequences.insert(sequence), "duplicate HTTP sequence {sequence}");
        ensure!(self.last_sequence.is_none_or(|last| sequence > last), "HTTP publication order regressed");
        self.last_sequence = Some(sequence);
        if sequence <= self.watermark {
            ensure!(self.gap && event["replay"] == true, "history arrived before gap or without replay provenance");
            self.ignored += 1;
            return Ok(false); // Snapshot already contains these native observations.
        }
        ensure!(self.gap && event["replay"] == false, "future observation has stale replay provenance");
        match kind {
            "text" | "reasoning" => {
                let id = event["message_id"].as_str().context("live delta lost canonical assistant ID")?;
                let entry = self.messages.entry(id.into()).or_default();
                let content = event["content"].as_str().context("delta content missing")?;
                if kind == "text" {
                    entry.0.push_str(content);
                    self.live_text.push(event);
                } else {
                    entry.1.push_str(content);
                    self.live_reasoning.push(event);
                }
            }
            "tool_result" => self.results.push(event),
            "state" if event["running"] == false => {
                ensure!(event["stop_reason"] == "stopped", "unexpected terminal: {event}");
                return Ok(true);
            }
            _ => {}
        }
        Ok(false)
    }

    async fn finish(&mut self, sse: &mut Sse) -> Result<()> {
        while !self.accept(sse.next().await?)? {}
        ensure!(self.gap && self.ignored > 0, "smoke did not exercise retained pre-watermark replay");
        Ok(())
    }
}

fn assert_snapshot(snapshot: &Value, text: &str, reasoning: &str, id: &str, parts: usize) -> Result<()> {
    let messages = snapshot["messages"].as_array().context("no snapshot messages")?;
    let matching = messages.iter().filter(|message| message["id"] == id).collect::<Vec<_>>();
    ensure!(matching.len() == 1, "snapshot lost/duplicated canonical assistant {id}");
    ensure!(matching[0]["content"] == text && matching[0]["reasoning"] == reasoning,
        "snapshot lost or duplicated already-emitted text/reasoning");
    let actual_parts = snapshot["assistant_parts"].as_array().context("missing original assistant parts")?;
    ensure!(actual_parts.len() == parts, "snapshot lost original part boundaries");
    for (index, part) in actual_parts.iter().enumerate() {
        let sequence = index + 1;
        let kind = if sequence % 2 == 1 { "reasoning" } else { "text" };
        ensure!(part["message_id"] == id && part["part_seq"] == sequence as u64 && part["kind"] == kind,
            "snapshot reconstructed a different native part identity: {part}");
        ensure!(part["part_id"] == format!("{id}:{sequence}:{kind}"), "unstable part ID");
        let expected_content = match sequence {
            1 => format!("{REASON_A}{REASON_A}"),
            2 => PREFIX_TEXT.into(),
            3 => REASON_B.into(),
            4 => prefix_text().strip_prefix(PREFIX_TEXT).context("prefix construction failed")?.into(),
            5 => NEXT_REASON.into(),
            6 => NEXT_TEXT.into(),
            _ => bail!("unexpected native assistant part"),
        };
        ensure!(part["content"] == expected_content, "snapshot changed original native part content");
    }
    Ok(())
}

async fn wait_until(mut ready: impl FnMut() -> Result<bool>) -> Result<()> {
    loop {
        if ready()? {
            return Ok(());
        }
        sleep(Duration::from_millis(5)).await;
    }
}

async fn exercise(
    handle: &CodingRuntimeHandle,
    session_id: &String,
    project: &Path,
    gate: &mut File,
    provider: &LocalProvider,
    client: &reqwest::Client,
    base_url: &str,
) -> Result<()> {
    let registry = SessionRuntimeRegistry::global();
    handle.set_mode(RuntimeMode::Auto).await?;
    handle.submit("Exercise native reasoning, streamed text and a real tool.".into()).await?;
    let expected_text = prefix_text();
    let expected_reason = format!("{REASON_A}{REASON_A}{REASON_B}");
    wait_until(|| {
        let join = registry.subscribe_with_snapshot(session_id)?;
        Ok(join.assistant_parts.len() == 4 && join.assistant_parts[3].content.ends_with(&format!("[{}]", CHUNKS - 1)))
    }).await?;
    let join = registry.subscribe_with_snapshot(session_id)?;
    ensure!(join.replay.first().is_some_and(|event| event.replay_gap), "real runtime stream did not evict journal history");
    ensure!(!join.replay.iter().any(|event| matches!(event.runtime,
        Some(CodingRuntimeEvent::Agent(jeikcode_kernel::event::AgentEvent::AssistantMessage { .. })))),
        "assistant boundary was not actually evicted");
    let assistant_id = join.assistant_parts[0].stamp.message_id.clone();
    drop(join);
    ensure!(jeikcode_daemon::native_live::should_use_registry_for_session(session_id), "native HTTP would bypass registry");
    let url = format!("{base_url}/live?session_id={session_id}");
    let mut first = Sse::connect(client, &url).await?;
    let snapshot = first.next().await?;
    ensure!(snapshot["session_id"] == *session_id, "HTTP joined a different native session");
    assert_snapshot(&snapshot, &expected_text, &expected_reason, &assistant_id, 4)?;
    let mut observed_first = Observed::from_snapshot(&snapshot)?;
    let gap = first.next().await?;
    ensure!(gap["type"] == "replay_gap", "snapshot must precede the eviction notice");
    observed_first.accept(gap)?;
    provider.release_stream.notify_one();

    wait_until(|| Ok(!registry.subscribe_with_snapshot(session_id)?.active_tools.is_empty())).await?;
    wait_until(|| Ok(project.join("tool.pid").is_file())).await?;
    let tool_join = registry.subscribe_with_snapshot(session_id)?;
    ensure!(tool_join.active_tools.len() == 1 && tool_join.active_tools[0].call.id == CALL_ID,
        "real native tool was not active at join");
    let native_started = tool_join.active_tools[0].started_at;
    drop(tool_join);
    sleep(Duration::from_millis(300)).await;
    let before_join = native_started.elapsed().as_millis() as u64;
    let mut second = Sse::connect(client, &url).await?;
    let second_snapshot = second.next().await?;
    assert_snapshot(&second_snapshot, &format!("{expected_text}{NEXT_TEXT}"),
        &format!("{expected_reason}{NEXT_REASON}"), &assistant_id, 6)?;
    let calls = second_snapshot["messages"].as_array().context("messages absent")?.iter()
        .find(|message| message["id"] == assistant_id).context("tool assistant absent")?["tool_calls"]
        .as_array().context("canonical native tool call missing")?;
    ensure!(calls.len() == 1 && calls[0]["id"] == CALL_ID && calls[0]["name"] == "run_command", "native tool identity lost");
    let active = second_snapshot["active_tools"].as_array().context("active tools missing")?;
    ensure!(active.len() == 1 && active[0]["id"] == CALL_ID && active[0]["name"] == "run_command", "pending tool missing on HTTP join");
    let joined_elapsed = active[0]["elapsed_ms"].as_u64().context("tool age missing")?;
    ensure!(joined_elapsed >= before_join && joined_elapsed <= native_started.elapsed().as_millis() as u64,
        "join reset the native tool start timestamp");
    let mut observed_second = Observed::from_snapshot(&second_snapshot)?;
    gate.write_all(b"release\n").context("releasing real foreground tool")?;
    gate.flush()?;
    let (left, right) = tokio::join!(observed_first.finish(&mut first), observed_second.finish(&mut second));
    left?;
    right?;
    ensure!(observed_first.live_reasoning.len() == 1 && observed_first.live_reasoning[0]["content"] == NEXT_REASON,
        "post-join reasoning was not delivered exactly once");
    let reason = &observed_first.live_reasoning[0];
    ensure!(reason["message_id"] == assistant_id && reason["part_seq"] == 5
        && reason["part_id"] == format!("{assistant_id}:5:reasoning"), "continued reasoning changed native identity");
    let continued = observed_first.live_text.iter().filter(|event| event["content"] == NEXT_TEXT).collect::<Vec<_>>();
    ensure!(continued.len() == 1 && continued[0]["message_id"] == assistant_id && continued[0]["part_seq"] == 6,
        "post-join text was duplicated or changed identity");
    ensure!(observed_first.live_text.len() == 2 && observed_second.live_text.len() == 1
        && observed_second.live_text[0]["content"] == FINAL_TEXT && observed_second.live_reasoning.is_empty(),
        "snapshot continuation replay duplicated native deltas");
    for observed in [&observed_first, &observed_second] {
        ensure!(observed.results.len() == 1, "real tool result was not delivered exactly once");
        let result = &observed.results[0];
        ensure!(result["id"] == CALL_ID && result["name"] == "run_command" && result["success"] == true
            && result["output"].as_str().is_some_and(|text| text.contains(TOOL_OUTPUT)), "real tool execution failed: {result}");
    }
    ensure!(observed_second.results[0]["duration_ms"].as_u64().is_some_and(|duration| duration >= joined_elapsed),
        "post-join tool result reset the original native start timestamp");
    let final_snapshot = handle.snapshot().await?;
    assert_final(&observed_first, &final_snapshot)?;
    assert_final(&observed_second, &final_snapshot)?;
    ensure!(provider.calls.load(Ordering::SeqCst) == 2, "smoke escaped deterministic two-round provider");
    Ok(())
}

fn assert_final(observed: &Observed, snapshot: &SessionSnapshot) -> Result<()> {
    let assistants = snapshot.messages.iter().filter(|message| message.role == Role::Assistant).collect::<Vec<_>>();
    ensure!(assistants.len() == 2 && observed.messages.len() == 2, "extra/missing native assistant at terminal");
    for message in assistants {
        let id = message.id.as_ref().context("final assistant lost native ID")?;
        ensure!(observed.messages.get(id) == Some(&(message.text.clone(), message.reasoning.clone().unwrap_or_default())),
            "watermark-filtered HTTP transcript differs from authoritative CodingRuntime snapshot for {id}");
    }
    ensure!(snapshot.messages.iter().filter(|message| message.role == Role::Tool
        && message.tool_call_id.as_deref() == Some(CALL_ID) && !message.is_error && message.text.contains(TOOL_OUTPUT)).count() == 1,
        "authoritative runtime snapshot lacks exactly one real successful tool result");
    Ok(())
}

async fn run(project: PathBuf, gate: &mut File) -> Result<()> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let server = tokio::spawn(run_server(ServerOpts {
        host: "127.0.0.1".into(), port,
        cli_override: CliOverride { disabled: true }, idle_timeout_secs: 0,
        startup_mode: TelemetryMode::Webui, webui_tokens: None,
        working_dir_override: Some(project.clone()), quiet: true,
        prebound_listener: Some(listener), prebound_dual_stack_v6: None,
        app_user_id: None, startup_footer: None, yolo: false,
    }));
    let result = AssertUnwindSafe(async {
        let client = reqwest::Client::builder().no_proxy().connect_timeout(Duration::from_secs(3)).build()?;
        let base_url = format!("http://127.0.0.1:{port}");
        timeout(DEADLINE, async {
            loop {
                if server.is_finished() {
                    bail!("daemon stopped during startup");
                }
                match client.get(format!("{base_url}/health")).send().await {
                    Ok(response) if response.status().is_success() => break,
                    Ok(_) | Err(_) => sleep(Duration::from_millis(10)).await,
                }
            }
            Ok::<_, anyhow::Error>(())
        }).await.context("daemon startup deadline")??;
        let provider = Arc::new(LocalProvider { calls: AtomicUsize::new(0), release_stream: Arc::new(Notify::new()) });
        let mut config = CodingAgentConfig::new("", "http://127.0.0.1/unused", "native-replay-local", &project);
        config.first_token_timeout = DEADLINE;
        config.stream_timeout = DEADLINE;
        config.first_token_timeout_retries = 0;
        config.max_rounds = 3;
        let mut runtime = timeout(DEADLINE, CodingRuntime::start(CodingRuntimeStart {
            agent: config,
            prepare: PrepareOptions {
                session: SessionMode::Fresh, skill_dirs: Some(Vec::new()), mcp: false,
                memory: false, web: false, review: false, request_user_input: false,
                ..Default::default()
            },
            provider_factory: Arc::new(LocalFactory(provider.clone())),
            plugin_hooks: Arc::new(StaticPluginHookSource::default()), image_preprocessor: None,
        })).await.context("native startup deadline")?.context("starting actual CodingRuntime")?;
        let session_id = runtime.session.as_ref().context("native session not allocated")?.id.clone();
        let handle = runtime.handle.clone();
        let registry = SessionRuntimeRegistry::global();
        registry.open_or_attach(session_id.clone(), project.clone())?;
        ensure!(registry.bind_handle(&session_id, handle.clone(), None), "binding real native owner failed");
        let forward_id = session_id.clone();
        let forward = tokio::spawn(async move {
            while let Some(event) = runtime.events.recv().await {
                ensure!(registry.push_runtime_event(&forward_id, event.generation, event.event.clone()),
                    "registry rejected an actual runtime observation");
                if let CodingRuntimeEvent::TurnFinished(TurnCompletion::SnapshotUnavailable { error, .. }) = event.event {
                    bail!("native terminal snapshot unavailable: {}", error.message);
                }
            }
            Ok::<_, anyhow::Error>(())
        });
        let exercise_result = AssertUnwindSafe(timeout(DEADLINE,
            exercise(&handle, &session_id, &project, gate, &provider, &client, &base_url)))
            .catch_unwind().await;
        // Always unblock the child and shut down the native owner, including after a
        // panic, HTTP/ordering assertion failure, or scenario deadline expiry.
        let release_result = gate.write_all(b"release\n").context("cleanup FIFO release");
        let shutdown_result = timeout(Duration::from_secs(10), handle.shutdown()).await;
        let owner_result = timeout(Duration::from_secs(10), runtime.task).await;
        registry.shutdown_all();
        let forward_result = timeout(Duration::from_secs(5), forward).await;
        release_result?;
        shutdown_result.context("native shutdown deadline")?.map_err(|error| anyhow!("native shutdown: {error:?}"))?;
        owner_result.context("native owner task deadline")?.context("native owner task panicked")?;
        forward_result.context("event forwarding cleanup deadline")?.context("event forwarder panicked")??;
        match exercise_result {
            Ok(result) => result.context("native replay scenario deadline")?,
            Err(_) => Err(anyhow!("native replay scenario panicked; runtime cleanup completed")),
        }
    }).catch_unwind().await;
    server.abort();
    match server.await {
        Ok(result) => result.context("daemon unexpectedly exited")?,
        Err(error) if error.is_cancelled() => {}
        Err(error) => return Err(error).context("daemon task panicked"),
    }
    // The fixture command uses only bash builtins and exec, so this is its only
    // child PID. Require actual reap, not merely a cancellation request.
    if project.join("tool.pid").exists() {
        let pid: u32 = std::fs::read_to_string(project.join("tool.pid"))?.trim().parse()?;
        timeout(Duration::from_secs(5), wait_until(|| Ok(!Path::new(&format!("/proc/{pid}")).exists())))
            .await.context("foreground fixture child leaked after native shutdown")??;
    }
    match result {
        Ok(result) => result,
        Err(_) => Err(anyhow!("native smoke panicked")),
    }
}

fn main() -> Result<()> {
    ensure!(cfg!(target_os = "linux"), "this hosted smoke requires Linux FIFO and /proc semantics");
    // Set isolation before starting any threads or initializing home/config caches.
    let temp = tempfile::Builder::new().prefix("jeikcode-native-replay-").tempdir()?;
    let home = temp.path().join("home");
    let project = temp.path().join("project");
    std::fs::create_dir_all(&home)?;
    std::fs::create_dir_all(&project)?;
    std::env::set_var("HOME", &home);
    std::env::set_var("JEIKCODE_HOME", home.join(".jeikcode"));
    std::env::set_var("JEIKCODE_OFFLINE", "1");
    std::env::set_var("JEIKCODE_TELEMETRY", "0");
    std::env::remove_var("JEIKCODE_API_TOKEN");
    let status = std::process::Command::new("mkfifo").arg(project.join("gate.fifo")).status()?;
    ensure!(status.success(), "could not create foreground tool gate FIFO");
    let mut gate = OpenOptions::new().read(true).write(true).open(project.join("gate.fifo"))?;
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()?;
    let result = runtime.block_on(run(project, &mut gate));
    runtime.shutdown_timeout(Duration::from_secs(5));
    drop(gate);
    temp.close().context("removing isolated native smoke home/project")?;
    result?;
    println!("native replay HTTP smoke: actual runtime gap, complete prefix/reasoning/parts, stable IDs, watermark deduplication, exactly-once continuation, real bash result, original tool age, and child reap verified");
    Ok(())
}
