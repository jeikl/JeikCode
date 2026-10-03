# Subagent Parallel Dispatch

In large codebases, a single linear conversation can quickly suffer from context bloat or conflicting goals. JeikCode provides a **native subagent parallel dispatch runtime**, allowing the primary agent to break down research, refactoring, and multi-file tasks into isolated subtasks.

---

## Subagent Architecture & Roles

JeikCode defines two distinct subagent types with strict permission boundaries:

### 1. Read-Only Research Subagents (`explore`)
- **Permissions**: Read-only sandbox environment; cannot write or modify any files on disk;
- **Use Cases**: Tracing cross-file call chains, analyzing dependencies, evaluating alternative architectures;
- **Advantage**: Extremely fast and safe. Multiple `explore` subagents can run concurrently without side effects, returning summarized insights directly to the main agent.

### 2. Write-Scoped Execution Subagents (`worker`)
- **Permissions**: Confined to an explicit file path whitelist (`scope`);
- **Use Cases**: Implementing a dedicated feature or module (e.g. updating schemas or refactoring a service layer);
- **Scope Sandboxing**: Every `worker` subagent must specify its allowed relative path globs (e.g. `["src/auth/**", "Cargo.toml"]`). Any attempt to edit or write files outside this scope is blocked at the runtime level.

---

## Parallel Workflow Diagram

```text
               ┌───────────────────────┐
               │ User Task / Prompt    │
               └──────────┬────────────┘
                          │
                          ▼
               ┌───────────────────────┐
               │      Main Agent       │
               └──────────┬────────────┘
                          │ Parallel Dispatch
             ┌────────────┴────────────┐
             ▼                         ▼
   ┌───────────────────┐     ┌───────────────────┐
   │ Subagent [explore]│     │ Subagent [worker] │
   │ Research Module A │     │ Implement API B   │
   │ (Strict read-only)│     │ (Scoped to B)     │
   └─────────┬─────────┘     └─────────┬─────────┘
             │ Summarized findings     │ Changes completed
             └────────────┬────────────┘
                          ▼
               ┌───────────────────────┐
               │ Aggregate & Deliver   │
               └───────────────────────┘
```

---

## Key Benefits

1. **Context Cleanliness**: Subagents operate in their own temporary contexts. Heavy command outputs and intermediate file reads never pollute the primary agent's token window.
2. **Speed & Concurrency**: Independent research tasks execute in parallel, substantially shortening total turnaround time.
3. **Safety Isolation**: Enforcing explicit write scopes on `worker` subagents eliminates unintended accidental edits across unrelated code files.
