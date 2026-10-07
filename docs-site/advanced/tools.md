# Built-in Tool Catalog

JeikCode comes equipped with an industrial-grade suite of native tools covering file reading/writing, surgical code editing, shell execution, semantic code graph traversal, and system introspection.

---

## Tool Reference

| Tool | Purpose | Key Attributes & Safety |
| :--- | :--- | :--- |
| `read` | Read file contents, inspect images, or view directory trees | Canonical `read` (alias `read_file`); line-numbered, supports offset/limit paging and key_string anchors |
| `edit` | Surgical exact-string code replacements | Canonical `edit` (alias `edit_file`); precise string matching prevents full-file rewrite drift |
| `write` | Full file creation or complete replacement | Canonical `write` (alias `write_file`); recursively creates parent directories automatically |
| `glob` | Find files matching wildcard patterns across folders | Fast cross-platform file path pattern matching |
| `grep` | Literal or regex pattern search across files | Supports context lines and file glob filtering |
| `run_command` | Execute shell commands in native terminal | Canonical `run_command` (alias `bash`); idle safeguards, resident background jobs return PID and port |
| `code_explore` | Semantic code graph & symbol exploration | Bilingual thesaurus matching for deep symbol definitions and call graph resolution |
| `todo_write` | Maintain structured multi-step task checklists | Canonical `todo_write` (alias `todo`); plans, tracks, and merges action batches |
| `request_user_input` | Interactive user clarification and questions | Single/multiple choice and text collection for architectural decisions or missing tokens |
| `jeikcode_config` | Global & workspace configuration management | Query module guides (`guide`) or hot-reload configurations in active sessions (`reload`) |
| `task` | Dispatch parallel subagents | Read-only `explore` and path-scoped `worker` subagents |

---

## Semantic Code Graph & Bilingual Thesaurus (`code_explore`)

In enterprise codebases, basic `grep` queries often produce overwhelming noise and false positives. JeikCode features semantic AST-driven code intelligence:

### 1. Bilingual Thesaurus Alignment
JeikCode incorporates a bilingual synonym thesaurus. When querying with domain concepts (e.g. "how is authentication validated?"), the engine cross-references English code symbols (e.g. `AuthClaims`, `verify_token`) and maps call hierarchies accurately.

### 2. Precise Reference & Call Graph Resolution
Using AST-level parsing, `code_explore` isolates:
- Symbol **definitions**;
- Exact **read and write call sites**;
- Full **upstream and downstream call graphs**.


