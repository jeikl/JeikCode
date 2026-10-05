# Project Instructions & Prompt Templates

JeikCode integrates a multi-layered Markdown configuration and template system, helping teams codify architectural rules, automate prompt wrapping, and persist long-term context across sessions.

---

## 1. Project Instruction Files (`AGENTS.md` / `.jeikcode.md`)

### 1.1 File Location & Highest Precedence
Project instruction files establish repository-specific conventions, branch naming rules, architectural boundaries, and testing requirements:
- **Location**: In your project root as `<workspace>/AGENTS.md` (recommended) or `<workspace>/.jeikcode.md`;
- **Highest Precedence**: Rules defined in project instruction files hold **strict precedence over default system prompts** when the agent plans, refactors, or makes decisions.

### 1.2 Injection & KV Cache Stability
- **Compact Header Injection**: Merged tightly into the system prompt once at session start;
- **Sacred Floor Protection**: Safeguarded under the `sacred_floor` guarantee so instructions are **never discarded** during multi-turn compaction (`/compact`), ensuring byte-stable prompt caching.

### 1.3 Quick Initialization (`/init`)
Type `/init` in your terminal:
```text
/init
```
JeikCode automatically inspects your repository layout, tech stack, and build scripts, drafting an initial `AGENTS.md` file automatically.

---

## 2. User Prompt Wrapper Template (`user-wrap.md`)

`user-wrap.md` defines a global or project-specific prompt template that **automatically wraps every user message** before it reaches the model.

### 2.1 File Location & Priority
1. **Workspace Project-Level**: `./.jeikcode/user-wrap.md` (highest priority, scoped to project);
2. **User Global-Level**: `~/.jeikcode/user-wrap.md` (shared across all projects).

### 2.2 Template Syntax & <span v-pre><code>{{input}}</code></span> Placeholder
The template file **must include the <span v-pre><code>{{input}}</code></span> placeholder**. Your active prompt in the terminal or WebUI will be dynamically inserted here:

```markdown
You are a principal staff engineer. Answer the user prompt below:

{{input}}

## Non-Negotiable Constraints
1. Include clear, concise comments with all code changes;
2. Preserve backward compatibility and avoid unrequested refactoring;
3. Respond in English.
```

### 2.3 Instant Hot-Reload
`user-wrap.md` uses active mtime file monitoring. **Saved changes apply immediately to your next turn without restarting the session**.

---

## 3. Persistent Memory (`memory.md`)

The memory system records persistent facts, internal private registries, or personal architectural preferences across sessions.

### 3.1 Locations & Recording
- **File Location**: `~/.jeikcode/memory.md` (global) and project-level;
- **Quick Record Command**: In the terminal, type:
  ```text
  /remember All API responses in this service must wrap in ApiResponse<T>
  ```
  Or edit `memory.md` directly in your text editor.

### 3.2 Context Safety
Memories are injected into the immutable session prefix as `synthetic User` messages under `sacred_floor` protection. No matter how many turns elapse or how frequently `/compact` prunes historical context, **memories remain permanently accessible to the agent**.
