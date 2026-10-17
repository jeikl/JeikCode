# 01 - Prompts and Context Configuration Guide (Prompts & Context)

Configuration directory path: `~/.jeikcode/prompts/` (or `$JEIKCODE_HOME/prompts/`).

---

## 1. Core Files & Loading Distinction

| File Name | Type | Description & Reload Semantics |
| :--- | :--- | :--- |
| **`init.yaml`** | 🔥 **Dynamic Hot-Reload** | **Identity definition, precedence, and environment prefix**. Reloaded dynamically on save based on file mtime; takes effect on the next turn immediately without restarting. |
| **`rules.yaml`** | 🔥 **Dynamic Hot-Reload** | **Workflow & execution discipline**. Completely replaces embedded default rules. Reloaded dynamically on save based on file mtime; takes effect on the next turn immediately without restarting. |
| `root_docs_prompts.md` | 📖 Reference Only | Reference documentation; not loaded into model context window. |
| `root_docs_内置工具.yaml` | 📖 Reference Only | Built-in tools catalog reference; not loaded into context (tools are natively provided by code). |
| `root_docs_内置技能.yaml` | 📖 Reference Only | Built-in skills reference; not loaded into context (skills mount directly from `skills/`). |

---

## 2. `init.yaml` Configuration Schema

```yaml
version: "2.0.0"

identity:
  agent_name: "JeikCode"
  provider: "Jeik"
  description: "an AI coding agent by JeikCode running on your underlying model"
  role_summary: "Always communicate in the language used by the user. When asked about your model identity, answer based on your actual underlying model code."
  template: |-
    <environment>
    You are {agent_name} AI coding Agent by {provider} running on your underlying model. Always communicate in the language used by the user. When asked about your model identity, answer based on your actual underlying model code.

precedence:
  rule: |-
    Critical Precedence: Rules under <project_instructions> (such as AGENTS.md, rules.md, glossary.md, etc.) or <memory> constitute USER PROVISIONS. When in conflict with default behaviors, strictly prioritize user provisions.

    Tool Invocation Precedence Rule: If built-in tools, Skills, and MCP tools can all solve the user's problem, invoke them in this strict order: Skills > MCP > Built-in Tools > Custom Scripts.

environment:
  platform_facts: |-
    Operating environment facts:
    - Platform: {os_platform} (Command habit: {command_habit})
    - Project working directory: {working_dir}
    - Git branch: {git_branch}
    - Temp files: use `"$TMPDIR"` instead of a hardcoded `/tmp` — it works for shell-internal paths AND as an ARGUMENT to native Windows programs (python / node / curl / …); `"$TMPDIR_WIN"` is the same path under a second name for nested non-bash shells.
    - Desktop: use `"$DESKTOP"` instead of assuming `~/Desktop` — it honors a relocated / redirected desktop; `"$DESKTOP_WIN"` is the equivalent alias.
    </environment>
```

---

## 3. `rules.yaml` Schema & Mode Differences

Supports injecting full Markdown rules via `raw`, or using structured fields:

```yaml
version: "2.0.0"

# Mode 1: Direct full Markdown rules (if `raw` is present, it takes exclusive priority, ignoring `workflow` and `prohibitions` below)
raw: |-
  ## Execution Guidelines
  - Task checklist loop closure...
  ## Tool Discipline
  - Prefer dedicated tools for operations instead of shell...

# Mode 2: Structured fields (used when `raw` is not provided)
workflow:
  principle: |-
    Core Principle: First determine the final goal, then break down the key steps of the target task...
  guidelines:
    todolist_closure: "Todo list closed-loop: Only after resolving any unfinished condition can the item be marked as completed."
    concurrency: "Concurrency principle: Whenever there is no data dependency between tool calls, they MUST be issued concurrently."

prohibitions:
  - "When reading files or listing directories, prefer `read` rather than `cat`, `head`, `tail`, `ls`, or `dir` shell commands."
  - "When editing or writing files, use `write` or `edit` rather than `echo >`, `sed`, or `awk`."
  - "When searching file content, use `grep` or `code_explore` rather than shell `grep` or `rg`."
  - "Never run destructive git commands (such as `git checkout .`, `git reset --hard`) without explicit user instruction."
```

- **Parameter Priority**: `raw` holds highest precedence. When `raw` is configured, its Markdown text is directly rendered; otherwise, the system combines `workflow` and `prohibitions`.

---

## 4. User Prompt Wrapping (`user-wrap.md`)

Used to wrap the user's latest prompt with protective business constraints or formatting requirements.

### 4.1 Syntax & Placeholder
Use `{{input}}` in the template to represent the user's raw input:

```markdown
User question: 【{{input}}】
Please answer in English, strictly following software engineering best practices.
```

- If `{{input}}` is omitted from the template, the entire template is prepended as a prefix to the user's question.
- **Scope Boundary**: Wrapping occurs strictly once when the user submits their new prompt. Internal tool calls, system reminders, and subagent dispatches are never wrapped.

### 4.2 File Priority
Loaded by nearest scope (first hit takes effect):
1. Project-specific: `<workspace>/.jeikcode/user-wrap.md`
2. Project root: `<workspace>/user-wrap.md`
3. Global default: `~/.jeikcode/user-wrap.md`

---

## 5. Reload & Effective Semantics

- `init.yaml`, `rules.yaml`, and `user-wrap.md` **automatically hot-reload based on file mtime**.
- No restart or reload command is necessary; changes take effect immediately on the next user message turn.
- If a file is accidentally deleted, the system gracefully falls back to the official built-in default rules.
