//! MCP (Model Context Protocol) capability: connect external MCP servers over
//! stdio / HTTP(SSE) (with OAuth), discover their tools, and surface them to a
//! kernel `Agent` as kernel `Tool`s (`mcp__{server}__{tool}`).
//!
//! Ported from `jeikcode-core::mcp` into L1 with ZERO dependency on core:
//! - the Tool adapter ([`tool`]) targets the kernel trait,
//! - the home/config-dir + console helpers are local ([`util`]),
//! - the core telemetry block is dropped — a driver re-attaches it by observing
//!   [`McpConnectEvent`] (cross-cutting telemetry lives on a seam, not hard-coded
//!   in the registry).
//!
//! # Runtime boundary
//! This module owns transport, discovery, trust, and tool adaptation. It does not
//! own a coding session transition or decide when discovered tools become visible.
//! The embedding runtime may connect in the background and atomically publish a new
//! per-turn tool catalog; non-interactive surfaces may instead await readiness.

use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use jeikcode_kernel::tool::{Tool, ToolRegistry};

pub mod client;
pub mod config;
pub mod global_pool;
pub mod oauth;
pub mod pool;
pub mod registry;
pub mod schema_cache;
pub mod session_pool;
pub mod tool;
pub mod transport_http;
pub mod transport_stdio;
pub mod trust;
pub mod types;
mod util;

pub use client::{McpClient, McpToolInfo};
pub use config::{
    load_all_mcp_configs, load_mcp_config, merge_http_mcp_server_into_json_file,
    merge_http_mcp_server_with_options_into_json_file, merge_http_oauth_mcp_server_into_json_file,
    merge_stdio_mcp_server_into_json_file, merge_stdio_mcp_server_with_options_into_json_file,
    read_raw_servers, remove_mcp_server_from_json_file, McpHttpAuthConfig, McpOAuthConfig,
    McpScope, McpServerConfig, McpTransportConfig,
};
pub use global_pool::GlobalMcpPool;
pub use oauth::{
    login_github_oauth, login_mcp_oauth, refresh_mcp_oauth_token, McpOAuthLoginOptions,
    McpOAuthToken, McpTokenStore,
};
pub use pool::{CachedMcpRegistry, ProjectMcpHandle, ProjectMcpPool, MCP_CACHE_MAX};
pub use registry::{project_trust_key, McpConnectEvent, McpRegistry};
pub use schema_cache::{
    cached_session_mcp_schema, ensure_session_mcp_schema, refresh_session_mcp_schema,
    SessionMcpSchemaSnapshot,
};
pub use session_pool::{SessionMcpLease, SessionMcpPool};
pub use tool::{mcp_tool_full_name, sanitize_name_segment, McpToolAdapter};
pub use types::*;

/// Reap every global, project-scoped and session-scoped MCP transport. Drivers must
/// call this on host exit; `OnceLock` globals do not run `Drop` on process
/// teardown, and session stdio children otherwise become orphans.
pub async fn shutdown_all_mcp_pools() {
    GlobalMcpPool::global().shutdown_all().await;
    ProjectMcpPool::global().shutdown_all().await;
    SessionMcpPool::global().shutdown_all().await;
    kill_all_mcp_children_now();
}

/// Weak handles to EVERY live MCP client, whatever registry owns it (session pool /
/// project pool / schema probe). A child spawned by ANY path must be reaped before a host
/// tears its runtime down — see [`kill_all_mcp_children_now`].
static LIVE_MCP_CLIENTS: OnceLock<Mutex<Vec<Weak<dyn McpClient>>>> = OnceLock::new();

fn live_mcp_clients() -> &'static Mutex<Vec<Weak<dyn McpClient>>> {
    LIVE_MCP_CLIENTS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Remember a freshly connected client so a later global teardown can kill its child.
/// Called by `McpRegistry` at every `servers` insert; dead entries are pruned by the killer.
pub fn register_mcp_client(client: &Arc<dyn McpClient>) {
    let mut live = live_mcp_clients().lock().unwrap_or_else(|e| e.into_inner());
    live.retain(|weak| weak.strong_count() > 0);
    live.push(Arc::downgrade(client));
}

/// Synchronously kill the child process of EVERY live MCP client (best-effort, idempotent,
/// no awaits — callable from `Drop`).
///
/// Why GLOBAL: `SessionMcpLease`'s last-owner teardown only knows its OWN registry, but a
/// child may belong to the project pool or the schema probe (a session-less assembly spawns
/// through those). Leaving any of them alive both leaks the npx/cmd/node tree AND deadlocks
/// `Runtime::drop` forever on the still-open stdout pipe — empirically: killing the lone
/// child is exactly what unblocks `tests/full_assembly.rs`'s teardown hang.
pub fn kill_all_mcp_children_now() {
    let clients: Vec<Arc<dyn McpClient>> = {
        let mut live = live_mcp_clients().lock().unwrap_or_else(|e| e.into_inner());
        let mut alive = Vec::with_capacity(live.len());
        let mut upgraded = Vec::with_capacity(live.len());
        for weak in live.drain(..) {
            if let Some(client) = weak.upgrade() {
                upgraded.push(client.clone());
                alive.push(Arc::downgrade(&client));
            }
        }
        *live = alive;
        upgraded
    };
    for client in clients {
        client.kill_now();
    }
}

/// Default bound used by callers that explicitly require initial MCP readiness
/// (headless one-shot / CI). Interactive chat must not use this as a send gate.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Interactive first-token budget: wait this long for a warm MCP catalog, then
/// send anyway. Late-published tools become visible on the next user turn.
pub const FIRST_TURN_SOFT_WAIT: Duration = Duration::from_millis(200);

/// Register MCP tool adapters into `reg`; returns their `mcp__…` names so the
/// assembler can chain them into [`ToolRegistry::mount`]. MCP tools are discovered
/// at runtime, so there is no static `mcp_tool_names()` — the caller mounts exactly
/// the names returned here.
pub fn register_mcp_tools(reg: &mut ToolRegistry, adapters: Vec<Arc<dyn Tool>>) -> Vec<String> {
    let mut names = Vec::with_capacity(adapters.len());
    for adapter in adapters {
        names.push(adapter.name().to_string());
        reg.register(adapter);
    }
    names
}
