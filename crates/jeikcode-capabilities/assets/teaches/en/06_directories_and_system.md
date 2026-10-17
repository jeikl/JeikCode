# 06 - Directories and System Files Configuration Guide (Directories & System)

Global root directory path: `~/.jeikcode/` (or `$JEIKCODE_HOME`).

---

## 1. Core Directory Layout

| Directory | Content Description | Reload Semantics |
| :--- | :--- | :--- |
| **`prompts/`** | Prompts and execution rules (`init.yaml`, `rules.yaml`) | **Automatic hot-reload** (Reloaded based on file mtime) |
| **`teaches/`** | System configuration guides and knowledge base documents | System built-in / host override |
| **`thesaurus/`** | Bilingual code search thesaurus files (`*.txt`) | **Automatic hot-reload** (Reloaded on next code search) |
| **`skills/`** | Global user skills directory (subdirectories containing `SKILL.md`) | Requires manual reload trigger (`jeikcode_config(action="reload")`) |
| **`plugins/`** | Installed plugin marketplaces and extensions | Requires manual reload trigger (`jeikcode_config(action="reload")`) |
| **`sessions/`** | Persisted session state and execution checkpoints | Historical session transcripts |
| **`datalog/`** | Structured audit logs | Can be pruned periodically |
| **`cache/`** | AST syntax tree and symbol index temporary caches | Safe to delete (automatically rebuilt) |
| **`image-cache/`** | Temporary image preprocessing cache for vision models | Safe to delete |
| **`logs/`** | Runtime daemon/CLI logs and diagnostics | Safe to delete |
| **`rewind/`** | Code and conversation rewind checkpoints | Safe to delete |

---

## 2. Root Configuration & State Files

| File Name | Purpose | Reload Semantics |
| :--- | :--- | :--- |
| **`config.toml`** | Main configuration (models, API keys, timeouts, UI, proxy) | Requires active reload (call `jeikcode_config(action="reload")` or `/reload`) |
| **`auth.toml`** | OAuth tokens and sensitive credentials | Dynamically read at runtime |
| **`mcp.json`** | Global external MCP tool configurations | Requires active reload (call `jeikcode_config(action="reload")` or `/mcp reload`) |
| **`memory.md`** | Cross-session long-term memory | Read at session startup |
| **`user-wrap.md`** | User prompt outer wrapping template | **Automatic hot-reload** (Takes effect on next turn) |
| `.codegraphignore` | Symbol index and graph ignore patterns (Noise: build artifacts, dependencies; **also applied** to glob/grep searches) | Takes effect on next index build |
| `.codegraphignore.graph` | **Graph-only** ignore patterns (Credentials: `.env`/`.env.*`, `*.pem`, `*.key`, `id_rsa*`, `.ssh/`); **not applied** to glob/grep, allowing explicit search to find them | Takes effect on next index build |
| `webui-listen.json` | Desktop and WebUI port and token registry | Updated at runtime |
| `builtin-tools.txt` | Read-only summary catalog of all built-in tools | Read-only reference |

---

## 3. Reload & Maintenance Operations

1. **Automatic Hot-Reload Files**:
   - `prompts/init.yaml`, `prompts/rules.yaml`, `user-wrap.md`, `thesaurus/*.txt`: Saving edits requires zero user action; the system detects changes and applies them on the next turn.
2. **Non-Automatic Hot-Reload Files**:
   - `config.toml`, `mcp.json`, `skills/`: Editing requires triggering a reload:
     - Agent side: Invoke tool `jeikcode_config(action="reload")`;
     - UI side: Enter command `/reload` (or `/mcp reload`);
     - WebUI side: Click the "Refresh button" in sidebar MCP menu.
3. **Disk Space Cleanup**:
   - Safely prune `cache/`, `image-cache/`, `logs/`, and `rewind/` at any time without losing configurations or skills.
