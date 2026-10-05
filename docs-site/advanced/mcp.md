# Model Context Protocol

JeikCode natively supports the **Model Context Protocol (MCP)** standard proposed by Anthropic, enabling seamless integration of external databases, third-party APIs, Chrome DevTools automation, file systems, and specialized tools into your agent runtime.

---

## 1. Configuration File Locations & Priority

JeikCode supports dual-layer MCP mounting:
1. **Workspace Project-Level**: `<workspace>/.mcp.json` (version-controlled, ideal for team collaboration);
2. **User Global-Level**: `~/.jeikcode/mcp.json` (globally accessible across all workspaces);
3. **Priority & Overrides**: When a service name matches, the project-level definition overrides the global configuration.

> 🛡️ **Project Trust Security**: When opening an untrusted project for the first time, project-level `.mcp.json` servers remain in a `blocked: untrusted project` state to prevent untrusted repositories from executing local commands automatically. You can click "Trust this project" in the WebUI sidebar or run `/mcp trust` in the terminal to grant connection access.

---

## 2. CLI Quick Setup (`jeikcode mcp add`)

In addition to editing JSON manually, JeikCode provides a CLI utility to add stdio services quickly:

```bash
# 1. Add to the current workspace's .mcp.json
jeikcode mcp add playwright npx @playwright/mcp@latest

# 2. Add globally to ~/.jeikcode/mcp.json
jeikcode mcp add playwright npx -y @playwright/mcp@latest --global

# 3. Specify target workspace directory
jeikcode mcp add playwright npx @playwright/mcp@latest -C /path/to/repo

# 4. Add official GitHub remote MCP with OAuth authentication
jeikcode mcp add-github-oauth github --global
jeikcode mcp login github
```

---

## 3. WebUI Interface & Status Management

In the browser WebUI, managing MCP servers is fully visual:
- **Sidebar MCP Panel**: Click **MCP** in the sidebar to view connection statuses (Running / Failed / Blocked) and the catalog of active tools for each server;
- **One-Click Hot Reload**: After editing `mcp.json`, click the **Refresh button** in the top-right corner of the MCP panel to reload and reconnect without restarting JeikCode;
- **Slash Commands**:
  - `/mcp`: List all mounted MCP servers and health statuses;
  - `/mcp reload`: Re-read configurations and reconnect in the background;
  - `/mcp trust`: Trust the current workspace and unblock project-level servers.

---

## 4. `scope` Lifecycle Isolation Modes (⚠️ Critical)

In your `mcp.json` definitions, specify `scope` to control connection pooling and process isolation:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"],
      "scope": "session"
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "E:/code"],
      "scope": "project"
    }
  }
}
```

### 1. `scope: "project"` (Default)
- **Workspace-Level Shared Singleton**: All foreground/background sessions and terminals in the same workspace share the same stdio process tree and transport, avoiding redundant `npx` spawns;
- **LRU Connection Pooling**: The internal `ProjectMcpPool` caches up to 5 project pools, safely evicting and terminating old process trees via LRU;
- **Best For**: Stateless database queries, file systems, web searches, and general utilities.

### 2. `scope: "session"` (Session Isolation)
- **Dedicated Process per Session**: Every active coding session gets its own independent transport and stdio process tree;
- **Automatic Environment Injection**: JeikCode safely injects `JEIKCODE_SESSION_ID=<session_id>` into the child process environment before launch, allowing servers to track session context;
- **Best For**: Stateful services requiring separate browser contexts (e.g. Chrome DevTools, Playwright, or authenticated session-specific tools).

---

## 5. Process Lifecycle & Idle Timeout Recycling

To prevent background MCP processes from consuming system memory and open handles indefinitely:

- **Idle Timeout Setting**: Configured via `[mcp.session] idle_ttl_secs` in `config.toml` (**default: 600 seconds / 10 minutes**);
- **Sliding Window Refresh**: The timer only refreshes when tool calls execute (`call_tool` begin/end). Regular schema probing or tool listing does not reset the timer;
- **Graceful Shutdown & Lazy Restart**: When a session is unselected (no active lease) and remains idle for 10 minutes, JeikCode gracefully terminates its MCP process tree (using kill-on-close Job Objects on Windows and process groups on Unix). Cached tool schemas are preserved, and processes are **lazily restarted** on the next tool invocation;
- **Unconditional Cleanup**: All child processes are immediately terminated when a session is deleted or JeikCode exits. Setting `idle_ttl_secs = 0` disables idle recycling.

---

## 6. Concurrency & Backpressure (`maxConcurrentCalls`)

Control JSON-RPC call concurrency per server via `maxConcurrentCalls` (1 to 64, default `8`):
- **Stateful Tools** (e.g. browser automation): Configure explicitly to `1` to serialize actions;
- **Stateless Tools** (e.g. data lookups): Retain the default `8` to leverage multiplexed concurrency.
