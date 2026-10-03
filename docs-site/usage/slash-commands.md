# Common Keybindings & Commands

In the interactive terminal (TUI), you can navigate and edit efficiently using keyboard shortcuts. Type `/` to open the slash command menu with real-time fuzzy autocomplete. Most read-only inspection commands (such as `/diff`, `/cost`, `/context`, and `/status`) can be run concurrently while tokens are streaming, without interrupting active generation.

---

## 1. Terminal Keybindings Reference

| Shortcut | Description |
| :--- | :--- |
| <kbd>Enter</kbd> | Send current prompt in the input field |
| <kbd>Ctrl</kbd> + <kbd>J</kbd> | **Insert newline** (ASCII LF standard newline chord, universal across all terminals, bypasses terminal interception) |
| <kbd>Shift</kbd> + <kbd>Enter</kbd> / <kbd>Alt</kbd> + <kbd>Enter</kbd> | Insert newline (also supports trailing `\` followed by Enter) |
| <kbd>Alt</kbd> + <kbd>V</kbd> / <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>V</kbd> | **Paste image attachment** (paste screenshot from clipboard, alternative chord for Windows Terminal) |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>C</kbd> | Copy terminal mouse selection text to system clipboard |
| <kbd>Ctrl</kbd> + <kbd>C</kbd> | Interrupt active streaming generation or cancel running tool command |
| <kbd>Ctrl</kbd> + <kbd>D</kbd> | Exit session when the input field is empty |
| <kbd>Ctrl</kbd> + <kbd>L</kbd> | Clear terminal screen (preserves conversation context) |
| <kbd>Up</kbd> / <kbd>Down</kbd> | Cycle through prompt history |
| <kbd>Ctrl</kbd> + <kbd>R</kbd> | Reverse fuzzy search prompt history and fill into input field |
| <kbd>Tab</kbd> | Autocomplete slash commands and file paths |
| <kbd>Esc</kbd> | Clear input prompt or dismiss streaming status overlay card |

---

## 2. Core Slash Commands Reference

### 1. Sessions & Rollbacks

| Command | Arguments / Aliases | Description |
| :--- | :--- | :--- |
| `/sessions` | - | List all historical sessions and switch interactively |
| `/new` | - | Start a fresh clean session (clears active conversation memory) |
| `/rename` | `<new-name>` | Rename active session (updates title in `/sessions` and WebUI sidebar) |
| `/undo` | `[N]` | Revert memory from the last turn (or N turns) and restore prompt into input field (leaves disk files untouched) |
| `/rewind` | - | Open time-travel checkpoint picker: roll back conversational memory, code file changes, or both |
| `/clear` | `/cls` | Clear terminal display without starting a new session (preserves context) |
| `/cd` | `<path>` | Switch working directory and spawn a fresh session (or type `cd /path` directly) |

### 2. Code Review & Git Utilities

| Command | Arguments / Aliases | Description |
| :--- | :--- | :--- |
| `/diff` | - | View uncommitted `git diff` changes with syntax highlighting and pagination directly in the terminal |
| `/review` | `staged`, `<base>` | Launch automated architectural and code quality reviews on working changes, staged diffs, or a target branch |
| `/commit` | - | Automatically analyze modified files, craft a Conventional Commit message, and commit safely |
| `/worktree` | `create`, `list`, `done` | Manage isolated Git Worktrees for large parallel refactorings, with one-click squash back to main |

### 3. Content Extraction & Utilities

| Command | Arguments / Aliases | Description |
| :--- | :--- | :--- |
| `/view` | `[path]` | Built-in read-only file viewer. Opens a project-wide fuzzy file selector when run without arguments |
| `/copy` | `[N]`, `all`, `msg` | Copy code blocks or full Markdown response text to the system clipboard |
| `/save` | `[filename]` | Export the full conversational transcript and code changes as a standalone Markdown document |
| `/todo` | `add <task>`, `clear` | Inspect and manage the structured task list derived from the active session |
| `/paste` | - | Paste clipboard image attachments (fallback when terminal shortcuts are intercepted by the OS) |

### 4. Context, Cost & System Configuration

| Command | Arguments / Aliases | Description |
| :--- | :--- | :--- |
| `/compact` | `[focus]` | Manually trigger intelligent context summarization to prune token usage while retaining key code decisions |
| `/context` | - | Inspect context window budget breakdown (system prompt, tool definitions, compaction state, window usage) |
| `/cost` | - | Real-time local token consumption and cost estimation (calculated accurately even for self-hosted models) |
| `/model` | `/m` | Inspect active model, or interactively switch default models and providers |
| `/provider`| `/p` | Manage provider accounts, base URLs, API keys, and context window parameters |
| `/reload` | - | Instant hot-reload of `config.toml`, `mcp.json`, and Skills from disk without restarting the process |
| `/webui` | `stop` | Launch local WebUI browser client with live sync (or terminate background daemon) |
| `/upgrade`| - | Check for and smoothly upgrade JeikCode to the latest stable release |
| `/exit` | `/quit`, `/q` | Exit the interactive terminal session |

---

## 3. Key Usage Scenarios

### 1. `/compact` Mechanism & KV Cache Stability
When a long conversation approaches the model context threshold (default 70% utilization), JeikCode can compact automatically, or you can trigger `/compact` on demand:
- Initial system prompts, project rules, and persistent memories are protected under the `sacred_floor` and **never discarded**;
- Extracted summaries form immutable prefix anchors, maximizing server-side **Prompt Caching hit rates** across providers.

### 2. Non-Blocking Read-Only Queries During Streaming
You don't have to wait for the model to finish generating!
While tokens are streaming in real time, type `/diff`, `/cost`, `/context`, or `/status` into the prompt. A lightweight floating card appears above the input box displaying live metrics (press <kbd>Esc</kbd> to dismiss), **without interrupting active inference**.

### 3. Choosing Between `/undo` and `/rewind`
- **`/undo` (Rapid Trial & Error)**: Only reverts conversational memory and restores the preceding prompt into your input box for quick editing, leaving disk files unchanged;
- **`/rewind` (Full Checkpoint Rollback)**: Opens an interactive visual timeline to roll back both conversational memory and physical file modifications back to an earlier turn checkpoint.
