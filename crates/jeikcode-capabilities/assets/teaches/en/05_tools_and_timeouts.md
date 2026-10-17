# 05 - Tools and Timeouts Configuration Guide (Tools & Timeouts)

Configuration file path: `~/.jeikcode/config.toml`.

---

## 1. Command Tool Hard Lifespans & Idle Detection (`[tools.bash]`)

Controls execution timeouts and idle detection for subprocess-spawning tools such as `run_command`:

```toml
[tools.bash]
max_timeout_secs = 1800         # Hard ceiling for child processes (seconds, default 1800 = 30 mins). Non-overridable by models
default_timeout_secs = 120      # Default timeout when user omits timeout parameter in !cmd (seconds)
silent_kill_secs = 60           # Short command check interval (seconds): checks health at interval; does not kill silent waits (0 disables)
second_levell_secs = 120        # Idle grace window after auto-promotion to batch job (seconds)
long_bash_command_keyword = []  # Whitelisted long-running command tokens (e.g. ["build", "test"]). Exempt from idle checks, runs up to hard cap
```

Short commands undergo health checks at every `silent_kill_secs`: pager/REPL/full-screen TUI fingerprints and foreground resident services are terminated; CPU-busy tasks are promoted to long tasks; alive processes that are CPU-idle with no new bytes and no interactive fingerprints are treated as waits, continuing until self-exit or `max_timeout_secs`.

### 1.1 `run_command` Invocation Nuances
- **Background Daemon Services (`"background": true`)**:
  - Running resident services in foreground (`npm run dev`, `uvicorn`, etc.) is intercepted and killed by idle checks.
  - Pass `"background": true` (optional `"settle_secs": 3` sets initial observation grace window, default 3s): If the process does not immediately crash during observation, PID and listening ports are returned, completing the current Turn while detaching the process to background supervision. Startup reports conduct **readiness checks**: probing `127.0.0.1` port availability (`Port: 8899 (accepting on 127.0.0.1)` / `(not reachable on 127.0.0.1 yet)`); when "no output and no listening port" occurs, readiness is explicitly marked **UNVERIFIED**—preventing "process is still alive" from being mistaken for "started successfully".
  - Subsequent turns automatically report alive status in `<system-reminder>` under `[Active Background Tasks]` (including `pid` and stop commands); non-zero exits trigger a one-shot `[Background Task Alert]` in the next turn.
  - Terminating background tasks: **Startup notices directly provide copy-paste stop commands**. Windows reports both the workload's `WinPID` (for `taskkill /F /T /PID <WinPID>`) and Git Bash PID (for `kill <GitBashPID>`); both are real process IDs, but `kill` only recognizes the latter. We recommend `taskkill /F /T /PID <WinPID>` (`/T` required to prevent orphaned children) or `kill <GitBashPID>`. If only `WinPID <wrapper shell>` is reported, use `taskkill /F /T /PID <WinPID>` to terminate the entire tree. On Unix use `kill -TERM -<pid>` (negative sign = whole process group).
- **Windows PowerShell Mode (`"shell": "powershell"`)**:
  - `"shell": "default"` (default): Executes via Git Bash / CMD.
  - `"shell": "powershell"`: Executes via 64-bit native PowerShell (UTF-16LE EncodedCommand), bypassing Bash path mangling, optimal for UNC network shares (e.g. `\\192.168.1.10\share$`) or native PowerShell cmdlets.

### 1.2 Path Resolution & Environment Variables (Built-in Tools)

- Built-in tools (`read` / `grep` / `glob` / `edit` / `write` / `code_explore`, etc.) share the **exact same path resolver** as `run_command`: supporting `~`, `$VAR` / `${VAR}` (Windows additionally supports `%VAR%`), as well as paired quote wrapping (e.g. `"$TMPDIR/x"`).
- Use `"$TMPDIR"` (or `"$TMP"` / `"$TEMP"`) instead of hardcoded `/tmp`, and `"$DESKTOP"` instead of assuming `~/Desktop`: both work identically inside the shell and as **arguments passed to native Windows programs** (python / node / curl). `"$TMPDIR_WIN"` / `"$DESKTOP_WIN"` are aliases for nested non-bash shell scenarios.
- Undefined environment variables are **preserved verbatim** (never silently stripped); a typo in a variable name stays relative within the workspace and is exposed in error diagnostics rather than escaping to the filesystem drive root.

---

## 2. In-Process Short Timeout Budgets (`[tools.timeouts]`)

Controls granular timeouts for internal searches, HTTP requests, Skill templates, and lifecycle hooks (isolated from bash hard limits):

```toml
[tools.timeouts]
search_secs = 72            # grep / glob file traversal timeout (seconds)
web_connect_secs = 12       # HTTP connection timeout (seconds)
web_request_secs = 72       # web_fetch / web_search request timeout (seconds)
mcp_secs = 180              # Single MCP tool call timeout (seconds)
skill_cmd_secs = 40         # Skill template command timeout (seconds)
hook_secs = 30              # Lifecycle hook execution timeout (seconds)
fs_gate_secs = 36           # Permission check and path resolution timeout (seconds)

[mcp.session]
idle_ttl_secs = 600         # Idle reclamation timeout for scope="session" MCP processes (seconds, default 10 mins; 0 disables)
```

---

## 3. Tool Output Compression Policy (`[tools.tool_output]`)

Prevents massive tool outputs from exhausting context windows. Non-exempt tools exceeding the threshold are folded into a "head 1500 + tail 2200 bytes" preview accompanied by an `artifact` retrieval token; full output is saved to disk, retrieved on demand via `fetch_output`:

```toml
[tools.tool_output]
max_bytes = 65536               # General compression threshold (bytes, default 65536 = 64KiB; 0 disables compression completely)
terminal_max_bytes = 24576      # Earlier compression threshold for terminal (run_command/bash) (bytes, default 24KiB; 0 follows max_bytes)
no_fold_tools = [               # Whitelist tools: returned raw and never compressed
    "fetch_output",
    "code_explore",
    "web_fetch",
    "web_search"
]
```

- Effective threshold for terminal tools = `min(max_bytes, terminal_max_bytes)`.
- Exempt tools (`no_fold_tools` list + tools declaring `never_truncate_result()`) completely bypass folding.
- Both thresholds support environment variable overrides: `JEIKCODE_TOOL_OUTPUT_THRESHOLD_BYTES` / `JEIKCODE_TOOL_OUTPUT_TERMINAL_THRESHOLD_BYTES` (environment variables take precedence over config.toml).

---

## 4. Task Checklist Policy (`[tools.todo]`)

```toml
[tools.todo]
enabled = true                  # Enable task checklist mechanism (overridable via JEIKCODE_TODO env)
eager = "auto"                  # Proactivity: "auto" (intent-based) | "preferred" (frequent prompts) | "always" (forced creation on turn 1)
```

---

## 5. Session Turn Caps & Streaming Timeouts (`[coding]`)

```toml
[coding]
max_rounds = 230                # Maximum model interaction rounds per session (0 = unlimited)
connect_timeout_secs = 10       # TCP/TLS connection timeout
open_timeout_secs = 180         # HTTP response header (TTFB) timeout; does not truncate streaming body
ttft_secs = 180                 # Time to first thinking/content/tool token (alias first_token_timeout_secs)
transition_secs = 180           # Transition timeout from thinking completion to first content/tool token
streaming_sliding_secs = 120    # Sliding window between consecutive content tokens
first_token_timeout_retries = 3 # Automatic retry attempts upon first token timeout
```

Environment variable overrides: `JEIKCODE_CONNECT_TIMEOUT_SECS`, `JEIKCODE_OPEN_TIMEOUT_SECS`, `JEIKCODE_TTFT_SECS` (or `JEIKCODE_FIRST_TOKEN_TIMEOUT_SECS`), `JEIKCODE_TRANSITION_SECS`, `JEIKCODE_STREAMING_SECS` (or `JEIKCODE_STREAM_TIMEOUT_SECS`). Setting to `0` disables that specific timeout stage. SSE ping, `ResponseId`, and `Usage` do not reset the content sliding window.

---

## 6. Subagent Concurrency (`[subagent]`)

```toml
[subagent]
max_concurrent = 3              # Maximum concurrent subagents (default 3)
max_rounds = 230                # Maximum interaction rounds per subagent (0 = unlimited)
```

---

## 7. Network Proxy (`[network.proxy]`)

```toml
[network.proxy]
mode = "follow_system"          # Proxy mode: "follow_system" (default) | "default_proxy" | "no_proxy"
# http = "http://127.0.0.1:7890"
# https = "http://127.0.0.1:7890"
```

---

## 8. Interruption Preservation & UI Configuration

```toml
# Top-level scalar configurations (MUST precede all [table] sections)
keep_interrupted_context = true # Preserve generated context upon Ctrl+C interruption for seamless continuation

[ui]
theme = "auto"                  # Terminal theme: "auto" | "dark" | "light"
ai_session_naming = true        # Asynchronously generate session titles using AI
```

---

## 9. Reload Semantics & Triggering

- **No automatic reload**: Saving edits to `~/.jeikcode/config.toml` does not trigger automatic reload.
- **Reload Triggers**:
  1. **Agent Side**: Invoke the built-in tool `jeikcode_config(action="reload")`; takes effect on the next turn immediately after the current turn completes.
  2. **User Side**: Enter `/reload` in WebUI or TUI terminal to reread configuration immediately.
- Neither method **requires restarting the JeikCode process**.
