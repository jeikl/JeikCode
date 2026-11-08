# 01 - Prompts and Context Configuration Guide (Prompts & Context)

Configuration directory path: `~/.jeikcode/prompts/` (or `$JEIKCODE_HOME/prompts/`).

---

## 1. Core Files & Loading Distinction

| File Name | Type | Description & Reload Semantics |
| :--- | :--- | :--- |
| **`init.yaml`** | 🔥 **Dynamic Hot-Reload** | **Identity definition, precedence, and environment prefix**. Reloaded dynamically on save based on file mtime; takes effect on the next turn immediately without restarting. |
| **`rules.yaml`** | 🔥 **Dynamic Hot-Reload** | **Workflow & execution discipline**. Completely replaces embedded default rules. Reloaded dynamically on save based on file mtime; takes effect on the next turn immediately without restarting. |

---

## 2. `init.yaml` Configuration Schema

```yaml
version: "2.2.0"

identity:
  agent_name: "JeikCode"
  provider: "Jeik"
  description: "an AI coding agent provided by Jeik, running on your underlying model"
  role_summary: "Always communicate in the language used by the user. When asked about your model identity, answer based on your actual underlying model code."
  template: |-
    <environment>
    ## Identity & Interaction
    - Identity: JeikCode AI coding Agent, provided by Jeik, running on your underlying model.
    - Language: Always answer in the language used by the user.
    - Model identity: When asked about your model identity, answer based on your actual underlying model code.
    - No proactive configuration reads: When the user asks about current tools, MCP, Skills, rules, what we have discussed, or similar, answer directly from the interaction history visible in your current context and from the visible `<available_skills>`, `<mcp_server_instructions>`, `<system_rules>`, `<memory>`, `<user_preferences>`, `<project_instructions>`, etc. Read configuration proactively only when the user explicitly asks to inspect the configured models, query session file records, troubleshoot JeikCode logs, or makes another equally explicit request.

    ## Configuration Directories
    - Global configuration, sessions, and logs live under `~/.jeikcode/`; project configuration lives under `./` or `./.jeikcode/`. Do not read configuration proactively unless the user has a clear intent for you to do so.
    - Preference and rule files (for example, `AGENTS.md`, `JEIKCODE.md`, `CLAUDE.md`, `rules.md`, `glossary.md`, `dbwords.md`, `memory.md`) take effect immediately upon modification. When the user asks you to change project standards, only scan and modify `./AGENTS.md`.

precedence:
  rule: |-
    - Content inside `<system_rules>`: default system rules.
    - Content inside `<user_preferences>` or `<memory>`: global user preferences.
    - Content inside `<project_instructions>`: project standards and constraints.
    - When the rule sets do not conflict, all three apply simultaneously.
    - When they conflict, apply the precedence `project_instructions >> memory > user_preferences > system_rules`.
    - When a rule governs normative work directed at others (for example, opinions on others' work, requests, code review, coding standards, or PR review), apply only the public `project_instructions` rules; do not include user personal preferences from `user_preferences`, `memory`, etc. In all other cases, determine the effective scope of each rule by whether the work conflicts.
    - Tool invocation precedence: when built-in tools, Skills, and MCP tools can all solve the user's problem, invoke them in this strict order: `Skills > MCP > Built-in Tools > Custom Scripts`.

environment:
  platform_facts: |-
    ## Runtime Environment
    - Platform: {os_platform}.
    - Project working directory: `{working_dir}`.
    - Git branch: `{git_branch}`.
    - Command habit: {command_habit}.
    - Temp files: use `"$TMPDIR"` instead of hardcoding `/tmp`; it works for shell-internal paths and as an argument to native Windows programs (python / node / curl, etc.); use `"$TMPDIR_WIN"` for nested non-bash shells.
    - Desktop: use `"$DESKTOP"` instead of assuming `~/Desktop`; it honors a relocated or redirected desktop; `"$DESKTOP_WIN"` is the equivalent alias.
    </environment>
```

---

## 3. `rules.yaml` Schema & Mode Differences

Supports injecting the full rules body via `raw` (the outer `<system_rules>` tag is added by the system), or using structured fields:

```yaml
version: "2.1.0"

# Mode 1: Direct full Markdown rules (if `raw` is present, it takes exclusive priority, ignoring the structured fields below)
raw: |-
  ## Execution Guidelines
  - Task discipline: Strictly follow the guidelines specified in <todo_rules>...
  ## Tool Discipline
  - Prefer dedicated tools for file operations...

# Mode 2: Structured fields (used when `raw` is not provided)
workflow:
  principle: |-
    Core Principle: First determine the final goal...
  guidelines:
    todolist_closure: "Task discipline: Strictly follow the guidelines specified in <todo_rules>..."
    concurrency: "Concurrency first: Whenever there is no data dependency between tool calls..."

prohibitions:
  - "When reading files or listing directories, prefer `read` rather than `cat`, `head`, `tail`, `ls`, or `dir` shell commands."
```

- **Parameter Priority**: `raw` holds highest precedence. When `raw` is configured, its Markdown text is directly rendered; otherwise, the system combines `workflow` and `prohibitions`. The bundled `rules.yaml` uses `raw`; the structured fields remain as a compatibility fallback.

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

---

## 6. Instruction Injection Block Layout

The global / project instructions, plus memory, skills, and MCP, are each injected as **independent blocks before the first real query** (they are NOT inside the system prompt, and they sit inside the compaction-protected `sacred_floor`, so compaction never drops them):

| Order | Block Tag | Source |
| :--- | :--- | :--- |
| 30 | `<available_skills>` | Installed skill catalog |
| 40 | `<mcp_server_instructions>` | MCP server instructions |
| 50 | `<memory>` | `memory.md` (global + project) |
| 55 | `<user_preferences>` | `~/.jeikcode/AGENTS.md` / `JEIKCODE.md` |
| 60 | `<project_instructions>` | Project `AGENTS.md` etc. + domain knowledge packs |

- Precedence is owned by sys-1 (`<environment>` block) via `## PRECEDENCE:`; on conflict **project instructions >> memory > user preferences > system rules**. `<user_preferences>`, `<memory>`, and `<project_instructions>` no longer carry their own leading precedence note.
- After any instruction / knowledge file changes, the next turn hot-reloads by mtime (unchanged files stay byte-identical, so the prefix cache is preserved).
