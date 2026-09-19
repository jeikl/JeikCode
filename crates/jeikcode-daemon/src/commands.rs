//! `POST /command`: 无状态斜杠命令执行器（对已持久化会话/记忆施加一次性变更）。
use axum::{extract::State, response::IntoResponse, Json};
use std::path::Path;
use std::sync::Arc;

use crate::AppState;
#[cfg(test)]
use jeikcode_capabilities::session::SessionMeta as NativeSessionMeta;
use jeikcode_capabilities::session::{
    LoadedSession, SessionLease as NativeSessionLease, SessionManager as NativeSessionManager,
    SessionStoreError,
};
use jeikcode_config::config::memory::MemoryStore;

#[derive(serde::Serialize)]
pub(crate) struct CostModelResult {
    provider: String,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cached_tokens: u64,
    estimated_cost_usd: Option<f64>,
    free: bool,
}

#[derive(serde::Deserialize)]
pub(crate) struct CommandReq {
    pub command: String,
    #[serde(default)]
    pub arg: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub working_dir: Option<String>,
    #[serde(default)]
    pub project_hash: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum CommandResult {
    Undo {
        undone: usize,
    },
    Remember {
        scope: String,
    },
    Forget {
        removed: Vec<String>,
    },
    Memory {
        global: Vec<String>,
        project: Vec<String>,
    },
    Context {
        used_tokens: usize,
        total_messages: usize,
        ctx_window: usize,
        utilization: f32,
        ctx_name: String,
    },
    Compact {
        applied: bool,
        removed_messages: usize,
        before_tokens: usize,
        after_tokens: usize,
    },
    Status {
        logged_in: bool,
        username: Option<String>,
        provider: String,
        model: String,
        working_dir: String,
        config_path: String,
        text: String,
    },
    Config {
        path: String,
        provider: String,
    },
    Diff {
        stat: String,
    },
    Cost {
        total_tokens: usize,
        turn_count: usize,
        models: Vec<CostModelResult>,
        unattributed_tokens: u64,
        estimated_cost_usd: Option<f64>,
    },
    Todo {
        items: Vec<TodoItemJson>,
    },
    Error {
        message: String,
    },
}

#[derive(serde::Serialize)]
pub(crate) struct TodoItemJson {
    pub status: String,
    pub content: String,
}

struct NativeCommandSession {
    manager: NativeSessionManager,
    lease: NativeSessionLease,
    loaded: LoadedSession,
}

fn command_project_bucket(
    working_dir: &std::path::Path,
    project_hash: Option<&str>,
) -> anyhow::Result<String> {
    let bucket = project_hash
        .map(str::to_owned)
        .unwrap_or_else(|| NativeSessionManager::project_hash(working_dir));
    if bucket.len() != 16 || !bucket.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        anyhow::bail!("invalid project session bucket")
    }
    Ok(bucket)
}

fn load_native_command_session(
    working_dir: &std::path::Path,
    project_hash: Option<&str>,
    id: &str,
) -> anyhow::Result<Option<NativeCommandSession>> {
    let bucket = command_project_bucket(working_dir, project_hash)?;
    let manager =
        NativeSessionManager::with_root(NativeSessionManager::sessions_root().join(bucket));
    let has_existing = [
        manager.meta_path(id)?,
        manager.snapshot_path(id)?,
        manager.legacy_path(id)?,
    ]
    .iter()
    .any(|path| path.exists());
    if !has_existing {
        return Ok(None);
    }
    let lease = manager.acquire_lease(id)?;
    crate::legacy_convert::converge_session(&manager, &lease)?;
    let loaded = manager.load_native_session(id)?;
    Ok(Some(NativeCommandSession {
        manager,
        lease,
        loaded,
    }))
}

fn load_command_session_view(
    working_dir: &std::path::Path,
    project_hash: Option<&str>,
    id: &str,
) -> anyhow::Result<crate::legacy_convert::CatalogSessionView> {
    let bucket = command_project_bucket(working_dir, project_hash)?;
    crate::legacy_convert::load_catalog_session_view_in_project(&bucket, id)?
        .ok_or_else(|| anyhow::anyhow!("session {id:?} not found"))
}

fn exec_native_undo(session: NativeCommandSession, arg: &str) -> anyhow::Result<CommandResult> {
    let expected_snapshot = session.loaded.snapshot;
    let available = expected_snapshot
        .messages
        .iter()
        .filter(|message| {
            message.role == jeikcode_kernel::message::Role::User && !message.synthetic
        })
        .count();
    if available == 0 {
        return Ok(CommandResult::Undo { undone: 0 });
    }
    let target = arg.trim().parse::<usize>().ok();
    let undo = jeikcode_coding::runtime::undo_snapshot_to_prompt(&expected_snapshot, target)?;
    let message_count = undo.snapshot.messages.len();
    let persisted_message_count = u32::try_from(message_count)?;
    session.manager.commit_native_runtime_mutation(
        &session.lease,
        &undo.snapshot,
        move |current_snapshot, meta, presentation| {
            if current_snapshot != &expected_snapshot {
                return Err(SessionStoreError::Corrupt {
                    kind: "session mutation",
                    message: "session snapshot changed while preparing undo".into(),
                });
            }
            meta.turn_stats
                .retain(|stat| !stat.position_valid || stat.after_message <= message_count);
            let surviving_turn_ids: std::collections::BTreeSet<_> = meta
                .turn_stats
                .iter()
                .filter_map(|stat| {
                    (stat.position_valid && stat.turn_id != 0).then_some(stat.turn_id)
                })
                .collect();
            presentation.retain_turns(&surviving_turn_ids);
            meta.message_count = persisted_message_count;
            meta.turn_count =
                u32::try_from(meta.turn_stats.len()).map_err(|_| SessionStoreError::TooLarge {
                    kind: "session turn stats",
                    limit: u32::MAX as usize,
                    actual: meta.turn_stats.len(),
                })?;
            meta.updated_at = jeikcode_capabilities::session::now_ms();
            Ok(())
        },
    )?;
    Ok(CommandResult::Undo {
        undone: undo
            .prompts_before
            .saturating_sub(undo.target_n.saturating_sub(1)),
    })
}

fn commit_native_compaction(
    session: NativeCommandSession,
    messages: Vec<jeikcode_kernel::message::Message>,
    mutation: jeikcode_coding::runtime::SnapshotCompactionMutation,
) -> anyhow::Result<()> {
    use jeikcode_coding::runtime::SnapshotCompactionMutation;

    let expected_snapshot = session.loaded.snapshot;
    let mut snapshot = expected_snapshot.clone();
    snapshot.messages = messages;
    let message_count = snapshot.messages.len();
    let persisted_message_count = u32::try_from(message_count)?;
    session.manager.commit_native_runtime_mutation(
        &session.lease,
        &snapshot,
        move |current_snapshot, meta, presentation| {
            if current_snapshot != &expected_snapshot {
                return Err(SessionStoreError::Corrupt {
                    kind: "session mutation",
                    message: "session snapshot changed while preparing compaction".into(),
                });
            }
            if let SnapshotCompactionMutation::Replace {
                old_start,
                old_end,
                new_end,
            } = mutation
            {
                let _ = meta.archive_turn_stats_where(|stat| {
                    stat.position_valid
                        && stat.after_message > old_start
                        && stat.after_message < old_end
                });
                for stat in &mut meta.turn_stats {
                    if !stat.position_valid {
                        continue;
                    }
                    if stat.after_message >= old_end {
                        stat.after_message = new_end + stat.after_message.saturating_sub(old_end);
                    }
                }
            }
            let surviving_turn_ids: std::collections::BTreeSet<_> = meta
                .turn_stats
                .iter()
                .filter_map(|stat| {
                    (stat.position_valid && stat.turn_id != 0).then_some(stat.turn_id)
                })
                .collect();
            presentation.retain_turns(&surviving_turn_ids);
            meta.message_count = persisted_message_count;
            meta.turn_count =
                u32::try_from(meta.turn_stats.len()).map_err(|_| SessionStoreError::TooLarge {
                    kind: "session turn stats",
                    limit: u32::MAX as usize,
                    actual: meta.turn_stats.len(),
                })?;
            meta.updated_at = jeikcode_capabilities::session::now_ms();
            Ok(())
        },
    )?;
    Ok(())
}

async fn exec_native_compact(
    provider_name: Option<&str>,
    arg: &str,
    session: NativeCommandSession,
    working_dir: &std::path::Path,
    telemetry: Arc<jeikcode_telemetry::Telemetry>,
) -> anyhow::Result<CommandResult> {
    let config =
        jeikcode_config::config::Config::load(&jeikcode_config::config::Config::default_path())?;
    let resolved = crate::live_api::resolve_provider_name(&config, provider_name);
    // Validate the provider up front for a clean error (the old core path did
    // `providers.get(...).ok_or("Provider not found")`); without this a missing
    // key surfaces as a murkier build/network failure deeper in.
    if !config.selection_exists(&resolved) {
        anyhow::bail!("Provider '{resolved}' not found");
    }

    // Build the summarizing provider via the SAME native chain `/chat` uses
    // (chat_runtime_config → coding_config_from_runtime → coding_provider_factory().build),
    // yielding a kernel-native `LlmProvider` directly — no core provider, no adapter.
    // `build` may do blocking auth I/O (gateway token), so run it off the async runtime.
    let coding_cfg = crate::kernel_runtime::coding_config_from_runtime(
        &crate::live_api::chat_runtime_config(&config, &resolved, working_dir, telemetry),
    );
    let factory = crate::runtime_host::coding_provider_factory();
    let provider = tokio::task::spawn_blocking(move || factory.build(&coding_cfg, None))
        .await
        .map_err(|e| anyhow::anyhow!("provider build task panicked: {e}"))?
        .map_err(|e| anyhow::anyhow!("provider construction failed: {e}"))?;

    let compacted = jeikcode_coding::runtime::compact_snapshot(
        session.loaded.snapshot.messages.clone(),
        provider,
        (!arg.trim().is_empty()).then(|| arg.trim().to_string()),
    )
    .await;
    if compacted.outcome.committed {
        commit_native_compaction(session, compacted.messages, compacted.mutation)?;
    }
    Ok(CommandResult::Compact {
        applied: compacted.outcome.committed,
        removed_messages: compacted.outcome.removed_messages,
        before_tokens: compacted.outcome.estimated_tokens_before,
        after_tokens: compacted.outcome.estimated_tokens_after,
    })
}

fn exec_undo(
    working_dir: &Path,
    session_id: Option<&str>,
    arg: &str,
    project_hash: Option<&str>,
) -> anyhow::Result<CommandResult> {
    let sid = session_id.ok_or_else(|| anyhow::anyhow!("session_id required for undo"))?;
    let native = load_native_command_session(working_dir, project_hash, sid)?
        .ok_or_else(|| anyhow::anyhow!("session {sid:?} not found"))?;
    exec_native_undo(native, arg)
}

/// The session's current context size for `/context`: the prompt tokens the
/// provider reported on the most recent assistant turn (`meta.used_tokens`), or
/// 0 before any assistant turn. Mirrors kernel `Conversation::last_pressure`'s
/// used-tokens read, but works directly off a persisted snapshot so `/context`
/// reflects what the live (native) turn actually sent — no parallel tool assembly.
pub(crate) fn snapshot_used_tokens(messages: &[jeikcode_kernel::message::Message]) -> u32 {
    use jeikcode_kernel::message::Role;
    messages
        .iter()
        .rev()
        .find(|m| m.role == Role::Assistant)
        .and_then(|m| m.meta.as_ref())
        .map(|meta| meta.used_tokens)
        .unwrap_or(0)
}

async fn exec_context(
    working_dir: &std::path::Path,
    project_hash: Option<&str>,
    session_id: Option<&str>,
    provider: Option<&str>,
) -> anyhow::Result<CommandResult> {
    let sid = session_id.ok_or_else(|| anyhow::anyhow!("session_id required for context"))?;
    let session = load_command_session_view(working_dir, project_hash, sid)?;
    // Report the SAME context the live (native) turn tracks: the prompt tokens the
    // provider reported on the last assistant turn, projected onto the CURRENT
    // provider window. No parallel core tool-assembly (which diverged from the
    // native turn's actual tools/prompt and produced misleading per-zone numbers).
    let config =
        jeikcode_config::config::Config::load(&jeikcode_config::config::Config::default_path())?;
    let resolved = crate::live_api::resolve_provider_name(&config, provider);
    let provider_config = config
        .provider_config_for_selection(&resolved)
        .ok_or_else(|| anyhow::anyhow!("Provider '{}' not found", resolved))?;
    let ctx_window = provider_config.context_window as u32;
    let used_tokens = snapshot_used_tokens(&session.snapshot.messages);
    let utilization = if ctx_window > 0 {
        used_tokens as f32 / ctx_window as f32
    } else {
        0.0
    };
    Ok(CommandResult::Context {
        used_tokens: used_tokens as usize,
        total_messages: session.snapshot.messages.len(),
        ctx_window: ctx_window as usize,
        utilization,
        ctx_name: provider_config.model.clone(),
    })
}

/// 解析 `/remember` 参数：可选前缀 `--global`。返回 (是否全局, 去掉前缀并 trim 后的内容)。
pub(crate) fn parse_remember_arg(arg: &str) -> (bool, &str) {
    let arg = arg.trim();
    if let Some(rest) = arg.strip_prefix("--global") {
        if rest.is_empty() || rest.starts_with(char::is_whitespace) {
            return (true, rest.trim());
        }
    }
    (false, arg)
}

fn exec_remember(working_dir: &Path, arg: &str) -> anyhow::Result<CommandResult> {
    let (global, content) = parse_remember_arg(arg);
    if content.is_empty() {
        anyhow::bail!("remember needs content");
    }
    let store = if global {
        MemoryStore::global()
    } else {
        MemoryStore::project(working_dir)
    };
    store.append(content)?;
    Ok(CommandResult::Remember {
        scope: if global { "global" } else { "project" }.to_string(),
    })
}

fn exec_forget(working_dir: &Path, arg: &str) -> anyhow::Result<CommandResult> {
    let keyword = arg.trim();
    if keyword.is_empty() {
        anyhow::bail!("forget needs a keyword");
    }
    let mut removed = MemoryStore::global().remove_matching(keyword)?;
    removed.extend(MemoryStore::project(working_dir).remove_matching(keyword)?);
    Ok(CommandResult::Forget { removed })
}

fn exec_memory(working_dir: &Path) -> anyhow::Result<CommandResult> {
    Ok(CommandResult::Memory {
        global: MemoryStore::global().load(),
        project: MemoryStore::project(working_dir).load(),
    })
}

async fn exec_compact(
    working_dir: &std::path::Path,
    project_hash: Option<&str>,
    session_id: Option<&str>,
    provider: Option<&str>,
    arg: &str,
    telemetry: Arc<jeikcode_telemetry::Telemetry>,
) -> anyhow::Result<CommandResult> {
    let sid = session_id.ok_or_else(|| anyhow::anyhow!("session_id required for compact"))?;
    let native = load_native_command_session(working_dir, project_hash, sid)?
        .ok_or_else(|| anyhow::anyhow!("session {sid:?} not found"))?;
    exec_native_compact(provider, arg, native, working_dir, telemetry).await
}

fn exec_config() -> anyhow::Result<CommandResult> {
    let path = jeikcode_config::config::Config::default_path();
    let provider = jeikcode_config::config::Config::load(&path)
        .map(|c| c.default_provider)
        .unwrap_or_default();
    Ok(CommandResult::Config {
        path: path.display().to_string(),
        provider,
    })
}

fn exec_diff(working_dir: &std::path::Path) -> anyhow::Result<CommandResult> {
    // No console-window flash for git when spawned from the console-less daemon
    // on Windows (no-op elsewhere). Mirrors capabilities' own tool spawns.
    let mut cmd = std::process::Command::new("git");
    cmd.args(["diff", "--stat"]).current_dir(working_dir);
    jeikcode_capabilities::process_utils::suppress_console_window_sync(&mut cmd);
    let out = cmd.output()?;
    let stat = if out.status.success() {
        String::from_utf8_lossy(&out.stdout).trim_end().to_string()
    } else {
        String::from_utf8_lossy(&out.stderr).trim_end().to_string()
    };
    Ok(CommandResult::Diff { stat })
}

fn render_context_file_status_block(working_dir: &std::path::Path) -> String {
    use jeikcode_config::config::instructions::{InstructionLevel, LayeredInstructions};
    use jeikcode_config::i18n::{t, Msg};
    let instructions = LayeredInstructions::load(working_dir);
    let mut out = t(Msg::StatusInstructionFilesHeader).into_owned();
    for line in instructions.status_lines(working_dir) {
        let scope = t(match line.level {
            InstructionLevel::Global => Msg::StatusInstructionScopeGlobal,
            InstructionLevel::Project => Msg::StatusInstructionScopeProject,
            InstructionLevel::User => Msg::StatusInstructionScopeUser,
        });
        let path = line.path.display().to_string();
        if line.found {
            out.push_str(&t(Msg::StatusInstructionPresent {
                path: &path,
                label: line.level.label(),
                scope: &scope,
            }));
        } else {
            out.push_str(&t(Msg::StatusInstructionMissing {
                path: &path,
                label: line.level.label(),
                scope: &scope,
            }));
        }
    }
    out.push('\n');
    out.push_str(&t(Msg::StatusMemoryFilesHeader));
    for (scope_msg, store) in [
        (
            Msg::StatusMemoryScopeGlobal,
            jeikcode_config::config::memory::MemoryStore::global(),
        ),
        (
            Msg::StatusMemoryScopeProject,
            jeikcode_config::config::memory::MemoryStore::project(working_dir),
        ),
    ] {
        let scope = t(scope_msg);
        let path = store.path().display().to_string();
        if store.path().is_file() {
            out.push_str(&t(Msg::StatusMemoryPresent {
                path: &path,
                scope: &scope,
            }));
        } else {
            out.push_str(&t(Msg::StatusMemoryMissing {
                path: &path,
                scope: &scope,
            }));
        }
    }
    out
}

fn assemble_status(
    body: &str,
    proxy: &str,
    instructions: &str,
) -> String {
    let mut txt = String::with_capacity(body.len() + proxy.len() + instructions.len() + 16);
    txt.push_str(body);
    txt.push_str(proxy);
    txt.push('\n');
    txt.push_str(instructions);
    txt
}

fn exec_status(
    working_dir: &std::path::Path,
    provider: Option<&str>,
) -> anyhow::Result<CommandResult> {
    use jeikcode_config::i18n::{t, Msg};
    let config_path = jeikcode_config::config::Config::default_path();
    let config = jeikcode_config::config::Config::load(&config_path).ok();
    let provider_name = provider
        .map(|s| s.to_string())
        .or_else(|| config.as_ref().map(|c| c.default_provider.clone()))
        .unwrap_or_default();
    let model = config
        .as_ref()
        .and_then(|c| c.provider_config_for_selection(&provider_name))
        .map(|p| p.model)
        .unwrap_or_default();
    let body = t(Msg::StatusBody {
        model: &model,
        dir: &working_dir.display().to_string(),
        config: &config_path.display().to_string(),
    })
    .into_owned();
    let proxy_summary = config
        .as_ref()
        .map(|c| c.network.proxy.summary())
        .unwrap_or_else(|| "follow_system".to_string());
    let proxy_line = format!("  Proxy:  {}\n", proxy_summary);

    let text = assemble_status(
        &body,
        &proxy_line,
        &render_context_file_status_block(working_dir),
    );

    Ok(CommandResult::Status {
        logged_in: false,
        username: None,
        provider: provider_name,
        model,
        working_dir: working_dir.display().to_string(),
        config_path: config_path.display().to_string(),
        text,
    })
}

fn exec_cost(
    working_dir: &std::path::Path,
    project_hash: Option<&str>,
    session_id: Option<&str>,
) -> anyhow::Result<CommandResult> {
    let sid = session_id.ok_or_else(|| anyhow::anyhow!("session_id required for cost"))?;
    let session = load_command_session_view(working_dir, project_hash, sid)?;
    let report = jeikcode_capabilities::session::aggregate_session_cost(&session.meta);
    Ok(CommandResult::Cost {
        total_tokens: report.total_tokens as usize,
        turn_count: session.meta.turn_stats.len(),
        models: report
            .models
            .into_iter()
            .map(|model| CostModelResult {
                provider: model.provider_id,
                model: model.model_id,
                input_tokens: model.tokens.input,
                output_tokens: model.tokens.output,
                cached_tokens: model.tokens.cached_input,
                estimated_cost_usd: model.estimated_cost_usd,
                free: model.explicitly_free,
            })
            .collect(),
        unattributed_tokens: report.unattributed_tokens,
        estimated_cost_usd: report.estimated_cost_usd,
    })
}

fn exec_todo(
    working_dir: &std::path::Path,
    project_hash: Option<&str>,
    session_id: Option<&str>,
) -> anyhow::Result<CommandResult> {
    let sid = session_id.ok_or_else(|| anyhow::anyhow!("session_id required for todo"))?;
    let session = load_command_session_view(working_dir, project_hash, sid)?;

    Ok(CommandResult::Todo {
        items: todo_items_from_messages(&session.snapshot.messages),
    })
}

fn todo_items_from_messages(messages: &[jeikcode_kernel::message::Message]) -> Vec<TodoItemJson> {
    // Fold the kernel-native tool-call stream via the canonical reducer. This shows CURRENT
    // statuses in `/todo`, matching the merged `todowrite` tool + the TUI.
    use jeikcode_capabilities::tools::todo::{reduce_todos, TodoStatus};
    let calls: Vec<(&str, &str)> = messages
        .iter()
        .flat_map(|message| {
            message
                .tool_calls
                .iter()
                .map(|call| (call.name.as_str(), call.arguments.as_str()))
        })
        .collect();
    let todos = reduce_todos(calls);

    todos
        .into_iter()
        .map(|t| TodoItemJson {
            status: match t.status {
                TodoStatus::Pending => "pending",
                TodoStatus::InProgress => "in_progress",
                TodoStatus::Completed => "completed",
            }
            .to_string(),
            content: t.content,
        })
        .collect()
}

pub(crate) async fn run_command(
    State(state): State<AppState>,
    Json(req): Json<CommandReq>,
) -> impl IntoResponse {
    let working_dir = match req.working_dir.as_deref() {
        Some(d) if !d.is_empty() => std::path::PathBuf::from(d),
        _ => {
            return Json(CommandResult::Error {
                message: "working_dir required".into(),
            })
        }
    };
    let result = match req.command.as_str() {
        "undo" => exec_undo(
            &working_dir,
            req.session_id.as_deref(),
            &req.arg,
            req.project_hash.as_deref(),
        ),
        "remember" => exec_remember(&working_dir, &req.arg),
        "forget" => exec_forget(&working_dir, &req.arg),
        "memory" => exec_memory(&working_dir),
        "context" => {
            exec_context(
                &working_dir,
                req.project_hash.as_deref(),
                req.session_id.as_deref(),
                req.provider.as_deref(),
            )
            .await
        }
        "compact" => {
            exec_compact(
                &working_dir,
                req.project_hash.as_deref(),
                req.session_id.as_deref(),
                req.provider.as_deref(),
                &req.arg,
                state.telemetry.clone(),
            )
            .await
        }
        "config" => exec_config(),
        "diff" => exec_diff(&working_dir),
        "status" => exec_status(&working_dir, req.provider.as_deref()),
        "cost" => exec_cost(
            &working_dir,
            req.project_hash.as_deref(),
            req.session_id.as_deref(),
        ),
        "todo" => exec_todo(
            &working_dir,
            req.project_hash.as_deref(),
            req.session_id.as_deref(),
        ),
        other => Err(anyhow::anyhow!("unknown command: {other}")),
    };
    match result {
        Ok(r) => Json(r),
        Err(e) => Json(CommandResult::Error {
            message: e.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jeikcode_capabilities::session::PresentationFile;
    use jeikcode_capabilities::session::{StorageOwner, TurnStat};
    use jeikcode_config::config::memory::MemoryStore;

    #[test]
    fn context_file_status_shows_instruction_and_memory_paths() {
        let project = tempfile::tempdir().unwrap();
        std::fs::write(project.path().join("AGENTS.md"), "project instructions").unwrap();
        let project_memory = MemoryStore::project(project.path());
        std::fs::create_dir_all(project_memory.path().parent().unwrap()).unwrap();
        std::fs::write(project_memory.path(), "- remembered fact\n").unwrap();
        let status = render_context_file_status_block(project.path());
        assert!(status.contains(&project.path().join("AGENTS.md").display().to_string()));
        assert!(status.contains(&project_memory.path().display().to_string()));
        assert!(status.contains("(PROJECT)") || status.contains("（PROJECT）"));
    }

    #[test]
    fn snapshot_used_tokens_reads_latest_assistant_meta() {
        use jeikcode_kernel::message::{Message, MessageMeta};

        // No assistant turn yet → zero.
        assert_eq!(snapshot_used_tokens(&[Message::user("hi")]), 0);

        // The most recent assistant meta's recorded prompt tokens win.
        let mut a = Message::assistant("ans", Vec::new());
        a.meta = Some(MessageMeta {
            ctx_window: 128_000,
            used_tokens: 40_000,
            utilization: 0.3125,
            ..Default::default()
        });
        let msgs = vec![Message::user("hi"), a];
        assert_eq!(snapshot_used_tokens(&msgs), 40_000);
    }

    #[test]
    fn native_undo_preserves_updates_after_session_load() {
        use jeikcode_capabilities::session::{
            DisplayAnchor, PresentationEntry, PresentationRole, TurnStat,
        };

        let dir = tempfile::tempdir().unwrap();
        let manager = NativeSessionManager::with_root(dir.path());
        let id = "native-undo";
        let snapshot = jeikcode_kernel::message::SessionSnapshot::new(vec![
            jeikcode_kernel::message::Message::user("first"),
            jeikcode_kernel::message::Message::assistant("one", Vec::new()),
            jeikcode_kernel::message::Message::user("second"),
            jeikcode_kernel::message::Message::assistant("two", Vec::new()),
        ]);
        manager.save_snapshot(id, &snapshot).unwrap();
        let mut meta = NativeSessionMeta::new(id, "/p", 1);
        meta.owner = StorageOwner::Native;
        meta.message_count = 4;
        meta.turn_count = 3;
        meta.turn_stats = vec![
            TurnStat {
                after_message: 99,
                position_valid: false,
                turn_id: 99,
                round_count: 1,
                tool_call_count: 0,
                duration_ms: 1,
                total_tokens: 10,
                errored: false,
                used_tokens: 1,
                ctx_window: 10,
                model_usage: Vec::new(),
            },
            TurnStat {
                after_message: 2,
                position_valid: true,
                turn_id: 1,
                round_count: 1,
                tool_call_count: 0,
                duration_ms: 1,
                total_tokens: 1,
                errored: false,
                used_tokens: 1,
                ctx_window: 10,
                model_usage: Vec::new(),
            },
            TurnStat {
                after_message: 4,
                position_valid: true,
                turn_id: 2,
                round_count: 1,
                tool_call_count: 0,
                duration_ms: 1,
                total_tokens: 1,
                errored: false,
                used_tokens: 1,
                ctx_window: 10,
                model_usage: Vec::new(),
            },
        ];
        manager.write_meta(&meta).unwrap();
        let presentation = PresentationFile {
            v: jeikcode_capabilities::session::presentation::PRESENTATION_VERSION,
            entries: vec![
                PresentationEntry {
                    anchor: DisplayAnchor::AfterTurn { turn_id: 1 },
                    role: PresentationRole::Assistant,
                    text: "keep".into(),
                },
                PresentationEntry {
                    anchor: DisplayAnchor::AfterTurn { turn_id: 2 },
                    role: PresentationRole::Assistant,
                    text: "drop".into(),
                },
            ],
        };
        manager.write_presentation(id, &presentation).unwrap();
        let lease = manager.acquire_lease(id).unwrap();
        let loaded = LoadedSession {
            snapshot,
            meta,
            presentation,
        };

        manager.rename(id, "renamed after load").unwrap();
        manager
            .append_presentation(
                id,
                PresentationEntry {
                    anchor: DisplayAnchor::AfterTurn { turn_id: 1 },
                    role: PresentationRole::Assistant,
                    text: "late keep".into(),
                },
            )
            .unwrap();

        let result = exec_native_undo(
            NativeCommandSession {
                manager: NativeSessionManager::with_root(dir.path()),
                lease,
                loaded,
            },
            "",
        )
        .unwrap();

        assert!(matches!(result, CommandResult::Undo { undone: 1 }));
        let manager = NativeSessionManager::with_root(dir.path());
        assert_eq!(manager.load_snapshot(id).unwrap().messages.len(), 2);
        let meta = manager.read_meta(id).unwrap();
        assert_eq!(meta.turn_count, 2);
        assert!(!meta.turn_stats[0].position_valid);
        assert_eq!(meta.turn_stats[0].total_tokens, 10);
        assert_eq!(meta.name, "renamed after load");
        assert!(meta.user_renamed);
        let presentation = manager.read_presentation(id).unwrap();
        assert_eq!(presentation.entries.len(), 2);
        assert_eq!(presentation.entries[0].text, "keep");
        assert_eq!(presentation.entries[1].text, "late keep");
        assert!(presentation
            .entries
            .iter()
            .all(|entry| entry.text != "drop"));
    }

    #[test]
    fn native_compaction_preserves_updates_and_prunes_removed_turn_anchors() {
        use jeikcode_capabilities::session::{
            DisplayAnchor, PresentationEntry, PresentationRole, TurnStat,
        };
        use jeikcode_coding::runtime::SnapshotCompactionMutation;

        let dir = tempfile::tempdir().unwrap();
        let manager = NativeSessionManager::with_root(dir.path());
        let id = "native-compact";
        let mut snapshot = jeikcode_kernel::message::SessionSnapshot::new(vec![
            jeikcode_kernel::message::Message::user("u1"),
            jeikcode_kernel::message::Message::assistant("a1", Vec::new()),
            jeikcode_kernel::message::Message::user("u2"),
            jeikcode_kernel::message::Message::assistant("a2", Vec::new()),
            jeikcode_kernel::message::Message::user("u3"),
            jeikcode_kernel::message::Message::assistant("a3", Vec::new()),
        ]);
        snapshot.turn_counter = 8;
        manager.save_snapshot(id, &snapshot).unwrap();
        let stat = |after_message, turn_id| TurnStat {
            after_message,
            position_valid: true,
            turn_id,
            round_count: 1,
            tool_call_count: 0,
            duration_ms: 1,
            total_tokens: 1,
            errored: false,
            used_tokens: 1,
            ctx_window: 10,
            model_usage: Vec::new(),
        };
        let mut meta = NativeSessionMeta::new(id, "/p", 1);
        meta.owner = StorageOwner::Native;
        meta.message_count = 6;
        meta.turn_count = 3;
        meta.turn_stats = vec![stat(2, 1), stat(4, 2), stat(6, 3)];
        manager.write_meta(&meta).unwrap();
        let presentation = PresentationFile {
            v: jeikcode_capabilities::session::presentation::PRESENTATION_VERSION,
            entries: vec![
                PresentationEntry {
                    anchor: DisplayAnchor::AfterTurn { turn_id: 1 },
                    role: PresentationRole::Assistant,
                    text: "removed".into(),
                },
                PresentationEntry {
                    anchor: DisplayAnchor::AfterTurn { turn_id: 2 },
                    role: PresentationRole::Assistant,
                    text: "kept".into(),
                },
            ],
        };
        manager.write_presentation(id, &presentation).unwrap();
        let lease = manager.acquire_lease(id).unwrap();
        let loaded = LoadedSession {
            snapshot,
            meta,
            presentation,
        };

        manager.rename(id, "renamed after load").unwrap();
        manager
            .append_presentation(
                id,
                PresentationEntry {
                    anchor: DisplayAnchor::AfterTurn { turn_id: 2 },
                    role: PresentationRole::Assistant,
                    text: "late kept".into(),
                },
            )
            .unwrap();

        commit_native_compaction(
            NativeCommandSession {
                manager: NativeSessionManager::with_root(dir.path()),
                lease,
                loaded,
            },
            vec![
                jeikcode_kernel::message::Message::user("summary"),
                jeikcode_kernel::message::Message::user("u3"),
                jeikcode_kernel::message::Message::assistant("a3", Vec::new()),
            ],
            SnapshotCompactionMutation::Replace {
                old_start: 0,
                old_end: 4,
                new_end: 1,
            },
        )
        .unwrap();

        let manager = NativeSessionManager::with_root(dir.path());
        let snapshot = manager.load_snapshot(id).unwrap();
        assert_eq!(snapshot.messages.len(), 3);
        assert_eq!(snapshot.turn_counter, 8);
        let meta = manager.read_meta(id).unwrap();
        assert_eq!(meta.turn_count, 2);
        assert_eq!(meta.turn_stats[0].after_message, 1);
        assert_eq!(meta.turn_stats[1].after_message, 3);
        assert_eq!(meta.detached_unattributed_tokens, 1);
        assert_eq!(meta.name, "renamed after load");
        assert!(meta.user_renamed);
        let presentation = manager.read_presentation(id).unwrap();
        assert_eq!(presentation.entries.len(), 2);
        assert_eq!(presentation.entries[0].text, "kept");
        assert_eq!(presentation.entries[1].text, "late kept");
        assert!(presentation
            .entries
            .iter()
            .all(|entry| entry.text != "removed"));
    }

    #[test]
    fn parse_remember_arg_detects_global() {
        assert_eq!(parse_remember_arg("--global 记住这个"), (true, "记住这个"));
        assert_eq!(parse_remember_arg("普通事实"), (false, "普通事实"));
        assert_eq!(
            parse_remember_arg("  --global   trimmed  "),
            (true, "trimmed")
        );
        assert_eq!(parse_remember_arg("--globalfoo"), (false, "--globalfoo"));
    }

    #[test]
    fn remember_then_memory_roundtrip_project_scope() {
        // hermetic：project 作用域写到 working_dir/.jeikcode/memory.md
        let dir = tempfile::tempdir().unwrap();
        let wd = dir.path();
        exec_remember(wd, "阿童木用 Rust 写").unwrap();
        let store = MemoryStore::project(wd);
        assert!(store.load().iter().any(|e| e.contains("阿童木用 Rust 写")));
    }

    #[test]
    fn forget_removes_project_entry() {
        let dir = tempfile::tempdir().unwrap();
        let wd = dir.path();
        exec_remember(wd, "delete-me fact").unwrap();
        exec_remember(wd, "keep-me fact").unwrap();
        // exec_forget 也会扫全局，但全局此刻应无匹配；断言项目侧被删。
        let _ = exec_forget(wd, "delete-me");
        let remaining = MemoryStore::project(wd).load();
        assert!(!remaining.iter().any(|e| e.contains("delete-me")));
        assert!(remaining.iter().any(|e| e.contains("keep-me")));
    }

    #[test]
    fn cost_sums_turn_stats_tokens() {
        let mut meta = NativeSessionMeta::new("cost", "/tmp/cost-test", 1);
        meta.turn_stats.push(TurnStat {
            after_message: 2,
            position_valid: true,
            turn_id: 1,
            round_count: 1,
            tool_call_count: 0,
            duration_ms: 100,
            total_tokens: 100,
            errored: false,
            used_tokens: 0,
            ctx_window: 0,
            model_usage: Vec::new(),
        });
        meta.turn_stats.push(TurnStat {
            after_message: 4,
            position_valid: true,
            turn_id: 2,
            round_count: 1,
            tool_call_count: 0,
            duration_ms: 120,
            total_tokens: 250,
            errored: false,
            used_tokens: 0,
            ctx_window: 0,
            model_usage: Vec::new(),
        });
        let report = jeikcode_capabilities::session::aggregate_session_cost(&meta);
        assert_eq!(report.total_tokens, 350);
        assert_eq!(report.unattributed_tokens, 350);
    }

    #[test]
    fn todo_derives_from_last_todowrite_call() {
        use jeikcode_kernel::tool::ToolCall;

        let args = r#"{"todos":[{"content":"写测试","status":"in_progress"},{"content":"提交","status":"pending"}]}"#;
        let messages = vec![jeikcode_kernel::message::Message::assistant(
            "",
            vec![ToolCall {
                id: "call1".into(),
                name: "todowrite".into(),
                arguments: args.into(),
            }],
        )];
        let todos = todo_items_from_messages(&messages);

        assert_eq!(todos.len(), 2);
        assert_eq!(todos[0].content, "写测试");
        assert_eq!(todos[1].content, "提交");
    }

    #[test]
    fn todo_empty_session_returns_empty() {
        let todos = todo_items_from_messages(&[]);
        assert!(todos.is_empty());
    }

    #[test]
    fn exec_diff_returns_stat_in_a_git_repo() {
        let dir = tempfile::tempdir().unwrap();
        // init a repo with one committed file + a working-tree change
        let run = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(dir.path())
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap()
        };
        run(&["init"]);
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        run(&["add", "a.txt"]);
        run(&["commit", "-m", "init"]);
        std::fs::write(dir.path().join("a.txt"), "one\ntwo\n").unwrap();
        let res = exec_diff(dir.path()).unwrap();
        match res {
            CommandResult::Diff { stat } => assert!(stat.contains("a.txt"), "stat was: {stat}"),
            _ => panic!("wrong variant"),
        }
    }
}
