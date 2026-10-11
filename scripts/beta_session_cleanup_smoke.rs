//! Hosted Linux smoke: real CodingRuntime, assembled tools, daemon DELETE,
//! child trees and logs. The local provider supplies deterministic tool calls;
//! no upstream model quality, authentication or provider selection is claimed.
use async_trait::async_trait;
use futures::stream::{self, BoxStream};
use jeikcode_capabilities::tools::{bash_runtime, legacy_bash_runtime_state, BashTool};
use jeikcode_coding::{
    assemble, prepare, CodingAgentConfig, CodingProviderFactory, CodingRuntime, CodingRuntimeEvent,
    CodingRuntimeStart, PrepareOptions, ProviderBuildError, RuntimeMode, SessionMode,
    StaticPluginHookSource, TurnCompletion,
};
use jeikcode_daemon::{run_server, ServerOpts};
use jeikcode_kernel::{
    event::AgentEvent,
    message::{Message, Role},
    provider::{ChatOptions, LlmProvider},
    stream::{ProviderError, StreamEvent},
    tool::{ProgressSink, Tool, ToolCall, ToolContext, ToolDef},
};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

#[cfg(not(target_os = "linux"))]
fn main() {
    panic!("cleanup smoke requires Linux /proc and subreaper support");
}

#[cfg(target_os = "linux")]
extern "C" {
    fn prctl(option: i32, arg2: usize, arg3: usize, arg4: usize, arg5: usize) -> i32;
    fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
}

struct LocalToolProvider;
#[async_trait]
impl LlmProvider for LocalToolProvider {
    fn model_name(&self) -> &str {
        "cleanup-smoke-local-tool-provider"
    }
    fn context_window(&self) -> u32 {
        128_000
    }
    async fn chat_stream(
        &self,
        messages: &[Message],
        _tools: &[ToolDef],
        _options: &ChatOptions,
    ) -> Result<BoxStream<'static, StreamEvent>, ProviderError> {
        let prompt = messages
            .iter()
            .rev()
            .find(|message| message.role == Role::User)
            .map(|message| message.text.as_str())
            .unwrap_or("");
        if prompt.contains("hold-open") {
            return Ok(Box::pin(stream::pending()));
        }
        if messages
            .last()
            .is_some_and(|message| message.role == Role::User)
        {
            return Ok(Box::pin(stream::iter(vec![
                StreamEvent::ToolCall(ToolCall {
                    id: "launch-background".into(),
                    name: "run_command".into(),
                    arguments: background_args(),
                }),
                StreamEvent::Done { truncated: false },
            ])));
        }
        Ok(Box::pin(stream::iter(vec![
            StreamEvent::TextDelta("background service admitted".into()),
            StreamEvent::Done { truncated: false },
        ])))
    }
}
struct LocalFactory;
impl CodingProviderFactory for LocalFactory {
    fn build(
        &self,
        _config: &CodingAgentConfig,
        _session_id: Option<&str>,
    ) -> Result<Arc<dyn LlmProvider>, ProviderBuildError> {
        Ok(Arc::new(LocalToolProvider))
    }
}

fn background_args() -> String {
    serde_json::json!({"command":"sleep 240 & printf 'CHILD_PID:%s\\n' \"$!\"; wait",
        "background":true,"settle_secs":1})
    .to_string()
}
fn options(id: &str) -> PrepareOptions {
    PrepareOptions {
        session: SessionMode::Draft { id: id.into() },
        skill_dirs: Some(Vec::new()),
        mcp: false,
        web: false,
        memory: false,
        review: false,
        request_user_input: false,
        ..PrepareOptions::default()
    }
}
async fn start(config: &CodingAgentConfig, id: &str) -> CodingRuntime {
    let runtime = CodingRuntime::start(CodingRuntimeStart {
        agent: config.clone(),
        prepare: options(id),
        provider_factory: Arc::new(LocalFactory),
        plugin_hooks: Arc::new(StaticPluginHookSource::default()),
        image_preprocessor: None,
    })
    .await
    .expect("real runtime startup");
    runtime.handle.set_mode(RuntimeMode::Auto).await.unwrap();
    runtime
}
async fn launch(runtime: &mut CodingRuntime, label: &str) -> String {
    runtime
        .handle
        .submit(label.into())
        .await
        .expect("launch admitted");
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut output = None;
        while let Some(event) = runtime.events.recv().await {
            match event.event {
                CodingRuntimeEvent::Agent(AgentEvent::ToolResult { result }) => {
                    assert!(
                        !result.is_error,
                        "real assembled tool failed: {}",
                        result.content
                    );
                    output = Some(result.content);
                }
                CodingRuntimeEvent::TurnFinished(TurnCompletion::Completed { .. }) => {
                    return output.expect("real tool output")
                }
                CodingRuntimeEvent::TurnFinished(completion) => {
                    panic!("unexpected completion: {completion:?}")
                }
                _ => {}
            }
        }
        panic!("runtime event stream ended before completed turn")
    })
    .await
    .expect("launch completion deadline")
}
#[derive(Clone)]
struct Task {
    leader: u32,
    descendant: u32,
    log: PathBuf,
}
async fn task(output: &str) -> Task {
    let pid_line = output
        .lines()
        .find(|line| line.starts_with("PID:"))
        .expect("PID output");
    let leader = pid_line
        .trim_start_matches("PID:")
        .trim()
        .parse()
        .expect("PID number");
    let log = PathBuf::from(
        output
            .lines()
            .find(|line| line.starts_with("Log path: "))
            .expect("log output")
            .trim_start_matches("Log path: ")
            .trim(),
    );
    let descendant = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let text = std::fs::read_to_string(&log).unwrap_or_default();
            if let Some(pid) = text
                .lines()
                .find_map(|line| line.strip_prefix("CHILD_PID:"))
            {
                break pid.trim().parse().expect("child PID");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("child PID log deadline");
    Task {
        leader,
        descendant,
        log,
    }
}
fn alive(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .is_some_and(|stat| {
            stat.rsplit_once(") ")
                .is_some_and(|(_, rest)| !rest.starts_with('Z'))
        })
}
fn assert_survives(task: &Task) {
    assert!(
        alive(task.leader) && alive(task.descendant) && task.log.is_file(),
        "unrelated leader/descendant/log must survive: {}",
        task.leader
    );
}
#[cfg(target_os = "linux")]
async fn assert_reaped(task: &Task) {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            // This process is the subreaper; descendants orphaned by production
            // group cleanup are owned here, while the production driver reaps its leader.
            let mut status = 0;
            unsafe {
                waitpid(task.descendant as i32, &mut status, 1);
            }
            if !Path::new(&format!("/proc/{}", task.leader)).exists()
                && !Path::new(&format!("/proc/{}", task.descendant)).exists()
                && !task.log.exists()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("deleted session children/log reaped");
    for fd in std::fs::read_dir("/proc/self/fd").unwrap().flatten() {
        if let Ok(target) = std::fs::read_link(fd.path()) {
            assert!(
                !target
                    .to_string_lossy()
                    .starts_with(&task.log.to_string_lossy().to_string()),
                "deleted task log descriptor remains open"
            );
        }
    }
}
struct Cleanup {
    tasks: Vec<Task>,
    server: Option<tokio::task::AbortHandle>,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Some(server) = &self.server {
            server.abort();
        }
        // Executable owns the entire process-local registry, including fixture
        // unowned service. Arm this guard before the first tool can spawn.
        legacy_bash_runtime_state().cancel_all_live_bash();
        for task in &self.tasks {
            for pid in [task.leader, task.descendant] {
                let _ = std::process::Command::new("kill")
                    .args(["-KILL", &pid.to_string()])
                    .status();
            }
            let _ = std::fs::remove_file(&task.log);
        }
    }
}
#[cfg(target_os = "linux")]
#[tokio::main]
async fn main() {
    assert_eq!(
        unsafe { prctl(36, 1, 0, 0, 0) },
        0,
        "enable child subreaper"
    );
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let project = temp.path().join("project");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&project).unwrap();
    std::env::set_var("JEIKCODE_HOME", &home);
    std::env::set_var("JEIKCODE_SUBAGENT", "0");
    std::env::set_var("JEIKCODE_TELEMETRY", "0");
    let mut cleanup = Cleanup {
        tasks: Vec::new(),
        server: None,
    };
    let config = CodingAgentConfig::new("", "http://unused.invalid", "cleanup-smoke", &project);
    let id_a = uuid::Uuid::new_v4().to_string();
    let id_b = uuid::Uuid::new_v4().to_string();
    let mut runtime_a = start(&config, &id_a).await;
    let mut runtime_b = start(&config, &id_b).await;
    let first_a = task(&launch(&mut runtime_a, "launch A first").await).await;
    cleanup.tasks.push(first_a.clone());
    let first_b = task(&launch(&mut runtime_b, "launch B").await).await;
    cleanup.tasks.push(first_b.clone());

    // A legacy host tool is neither a disabled-session assembled tool nor a
    // guessed filesystem owner. It shares the real process registry but has no owner.
    let ctx = ToolContext {
        working_dir: project.clone(),
        cancel: tokio_util::sync::CancellationToken::new(),
        progress: ProgressSink::noop(),
        requester: None,
    };
    let host_result = BashTool::default().execute(&background_args(), &ctx).await;
    assert!(!host_result.is_error, "{}", host_result.content);
    let host = task(&host_result.content).await;
    cleanup.tasks.push(host.clone());

    // A fresh candidate binds the SAME global BashRuntimeState. Dropping its
    // assembly must not change owner on the old runtime's existing mounted tool.
    let candidate_id = uuid::Uuid::new_v4().to_string();
    let mut candidate = prepare(&config, options(&candidate_id)).await.unwrap();
    let candidate_agent = assemble(&mut candidate, &config, Arc::new(LocalToolProvider)).unwrap();
    drop(candidate_agent);
    drop(candidate);
    let second_a = task(&launch(&mut runtime_a, "launch A after candidate discard").await).await;
    cleanup.tasks.push(second_a.clone());
    for item in &cleanup.tasks {
        assert_survives(item);
    }
    println!("cleanup smoke: completed turns and candidate discard preserved all real task trees");

    runtime_a.handle.submit("hold-open".into()).await.unwrap();
    runtime_a.handle.cancel().await.unwrap();
    tokio::time::timeout(Duration::from_secs(20), async {
        while let Some(event) = runtime_a.events.recv().await {
            if matches!(event.event, CodingRuntimeEvent::TurnFinished(_)) {
                return;
            }
        }
        panic!("missing cancelled turn terminal");
    })
    .await
    .unwrap();
    for item in &cleanup.tasks {
        assert_survives(item);
    }
    runtime_a.handle.shutdown().await.unwrap();
    runtime_a.task.await.unwrap();
    runtime_b.handle.shutdown().await.unwrap();
    runtime_b.task.await.unwrap();
    for item in &cleanup.tasks {
        assert_survives(item);
    }
    println!(
        "cleanup smoke: CodingRuntime cancel and shutdown retained owned and unowned services"
    );

    let log_dir = first_a.log.parent().unwrap();
    let legacy_log = log_dir.join(format!("legacy-unowned-{id_a}.log"));
    let user_log = project.join("user.log");
    let user_config = project.join("user-config.toml");
    std::fs::write(&legacy_log, b"legacy user-owned log").unwrap();
    std::fs::write(&user_log, b"user-owned log").unwrap();
    std::fs::write(&user_config, b"user configuration").unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let token_store = jeikcode_daemon::auth_token::WebuiTokenStore::new();
    let token = token_store.mint();
    let server = tokio::spawn(run_server(ServerOpts {
        host: "127.0.0.1".into(),
        port,
        cli_override: jeikcode_telemetry::CliOverride { disabled: true },
        idle_timeout_secs: 0,
        startup_mode: jeikcode_telemetry::SessionMode::Headless,
        webui_tokens: Some(token_store),
        working_dir_override: Some(project.clone()),
        quiet: true,
        prebound_listener: Some(listener),
        prebound_dual_stack_v6: None,
        app_user_id: None,
        startup_footer: None,
        yolo: false,
    }));
    cleanup.server = Some(server.abort_handle());
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{port}");
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if client.get(format!("{url}/health")).send().await.is_ok() {
            break;
        }
        assert!(Instant::now() < deadline, "daemon readiness deadline");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let manager = jeikcode_capabilities::session::SessionManager::for_project(&project);
    let hash = jeikcode_capabilities::session::SessionManager::project_hash(&project);
    assert!(
        manager.meta_path(&id_a).unwrap().is_file(),
        "real A persisted metadata"
    );
    let response = client
        .delete(format!("{url}/projects/{hash}/sessions/{id_a}"))
        .bearer_auth(&token)
        .header("X-JeikCode-Client", "webui")
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body = response.text().await.unwrap();
    assert!(
        status.is_success(),
        "actual daemon DELETE failed: {status}: {body}"
    );
    assert!(
        !manager.meta_path(&id_a).unwrap().exists(),
        "actual SessionManager deletion published"
    );
    assert_reaped(&first_a).await;
    assert_reaped(&second_a).await;
    assert_survives(&first_b);
    assert_survives(&host);
    assert!(
        manager.meta_path(&id_b).unwrap().is_file(),
        "other session metadata preserved"
    );
    assert_eq!(
        std::fs::read(&legacy_log).unwrap(),
        b"legacy user-owned log"
    );
    assert_eq!(std::fs::read(&user_log).unwrap(), b"user-owned log");
    assert_eq!(std::fs::read(&user_config).unwrap(), b"user configuration");
    assert_eq!(
        bash_runtime::kill_by_session_id(&id_a).await,
        0,
        "idempotent cleanup"
    );
    println!("cleanup smoke: actual daemon DELETE reaped A leaders/descendants and closed logs; B/host/legacy/user/config preserved");

    bash_runtime::kill_by_session_id(&id_b).await;
    legacy_bash_runtime_state().cancel_all_live_bash();
    for item in [&first_b, &host] {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let mut status = 0;
            unsafe {
                waitpid(item.descendant as i32, &mut status, 1);
            }
            if !Path::new(&format!("/proc/{}", item.leader)).exists()
                && !Path::new(&format!("/proc/{}", item.descendant)).exists()
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "fixture cleanup process deadline"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let _ = std::fs::remove_file(&item.log);
    }
    cleanup.tasks.clear();
    server.abort();
    let _ = server.await;
    cleanup.server = None;
    println!("cleanup smoke: all fixture child processes and logs cleaned");
}
