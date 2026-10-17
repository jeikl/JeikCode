# 03 - MCP and Skills Configuration Guide (MCP & Skills)

---

## 1. MCP (Model Context Protocol) External Tool Integration

### 1.1 Configuration File Locations & Priority
1. **Workspace Project-Level**: `<workspace>/.mcp.json` (Scoped strictly to the current project, version-control friendly).
2. **User Global-Level**: `~/.jeikcode/mcp.json` (Shared globally, accessible by all projects).
3. **Priority**: For identical server names, project-level configuration overrides global-level configuration.

### 1.2 CLI Quick Addition for MCP Tools
Use the `jeikcode mcp add` CLI to add tools automatically without manual JSON editing:

```bash
# Add to current project .mcp.json
jeikcode mcp add playwright npx @playwright/mcp@latest

# Add to global ~/.jeikcode/mcp.json
jeikcode mcp add playwright npx -y @playwright/mcp@latest --global

# Specify workspace target directory
jeikcode mcp add playwright npx @playwright/mcp@latest -C /path/to/repo

# GitHub Official OAuth MCP
jeikcode mcp add-github-oauth github --global
jeikcode mcp login github
jeikcode mcp logout github
```

### 1.3 `mcp.json` Standard Schema

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "E:/code"],
      "env": {
        "DEBUG": "false"
      },
      "maxConcurrentCalls": 8,
      "scope": "project",
      "disabled": false
    },
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"],
      "maxConcurrentCalls": 1,
      "scope": "session"
    }
  }
}
```

### 1.4 Core Parameter Nuances & Behavioral Differences

- **`scope` Lifecycle Mode (`"project"` vs `"session"`)**:
  - `"project"` (default): Project-shared singleton. All sessions under the same project share one background child process, with lifecycle tied to the project, exempt from idle reclamation. Best for stateless tools (filesystem, git, search).
  - `"session"`: Isolated per session. Each session spawns an independent child process, injecting `JEIKCODE_SESSION_ID=<current_session_id>` into the child environment. Best for browsers (Playwright), stateful debuggers, or tools requiring session isolation.
  - **Process Idle Reclamation**: Under `scope: "session"`, when switching away from a session and no tool calls occur for longer than `[mcp.session] idle_ttl_secs` (default 600s / 10 minutes), the system automatically reaps the process to free memory; the process lazily restarts upon the next tool call. Set `idle_ttl_secs = 0` in `config.toml` to disable idle reclamation.
- **`maxConcurrentCalls` Concurrency Cap**:
  - Valid range: 1 to 64 (default 8).
  - Keep default 8 for stateless read-heavy services;
  - Set explicitly to `1` for stateful or exclusive control tools (Playwright, Puppeteer) to prevent race conditions.
- **`disabled` Temporary Disable**:
  - Set to `true` to temporarily disable a server without removing its configuration.

### 1.5 Reload & Effective Semantics

Modifying MCP configuration **never requires restarting JeikCode**:

| Action Channel | Command / Gesture | Semantics |
| :--- | :--- | :--- |
| **Agent Tool** | `jeikcode_config(action="reload")` | Invoked after saving files; reloads when turn finishes, available on the next turn. |
| **Terminal Command** | `/mcp reload` | WebUI / TUI rereads configuration and reconnects in background. |
| **WebUI Interface** | Sidebar MCP menu "Refresh button" | Immediate remounting upon click. |
| **Status Inspection** | `/mcp` | Displays status of all configured MCP server connections. |
| **Trust Gate** | `/mcp trust` | Trust gate only decides "can it be loaded": project-level `.mcp.json` is blocked by default in untrusted workspaces, but the switch (GLOBAL/PROJECT union-disabled) remains the authoritative loaded state. WebUI automatically trusts silently when unblocking or toggling switches; TUI / CLI requires explicit `/mcp trust`. |

---

## 2. Skills System

Skills allow injecting specialized engineering workflows into the Agent via Markdown + YAML.

### 2.1 Directory Layout & Priority
Searched in order from highest to lowest precedence (higher priority overrides identical names):
1. **Project Specific**: `<workspace>/.jeikcode/skills/<name>/SKILL.md` or `<workspace>/.skills/<name>/SKILL.md`
2. **Global User**: `~/.jeikcode/skills/<name>/SKILL.md`
3. **Plugin Marketplace**: `~/.jeikcode/plugins/marketplaces/...`

### 2.2 `SKILL.md` Standard Structure

Each skill is a standalone directory, with its entrypoint strictly named `SKILL.md`:

```markdown
---
name: feature-reviewer
description: Specialized in code review and architecture rule compliance. Activated when reviewing code or enforcing standards.
---

# Skill Execution Guide

## 1. Core Workflow
1. Use `code_explore` to locate modified files.
2. Run test suites to verify behavioral completeness.

## 2. Constraints & Rules
- Adhere to single responsibility and standard error handling.
```

### 2.3 Progressive Subdirectories (Recommended)
- `SKILL.md`: Core workflow and concise description (100–300 tokens).
- `references/`: Detailed technical documentation and API specifications (Agent reads on demand via `read`).
- `scripts/`: Supporting utility scripts or templates.

### 2.4 Browsing & Reloading
- Enter `/skills` in WebUI or TUI to browse mounted skills.
- After adding or modifying `SKILL.md`, call `jeikcode_config(action="reload")` or enter `/reload` to activate on the next turn.

---

## 3. Plugins Management

- Plugins root directory: `~/.jeikcode/plugins/`.
- Enter `/plugin` in the TUI to interactively browse, install, and uninstall plugins.
- After installing or updating plugins, invoke `jeikcode_config(action="reload")` to apply changes immediately without restart.
