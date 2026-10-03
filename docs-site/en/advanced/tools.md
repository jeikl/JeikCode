# Built-in Tool Catalog

JeikCode comes equipped with an industrial-grade suite of native tools covering file reading/writing, surgical code editing, shell execution, semantic code graph traversal, and system introspection.

---

## Tool Reference

| Tool | Purpose | Key Attributes & Safety |
| :--- | :--- | :--- |
| `read_file` | Read line-numbered file contents or slices | Supports `offset` and `limit` to prevent massive token overruns |
| `edit_file` | Surgical exact-string code replacements | Precise match replacement avoids hallucinations in large files |
| `write_file` | Full file creation or replacement | Recursively creates parent directories automatically |
| `list_directory` | Immediate directory file inspection | Honors `.gitignore` exclusion rules by default |
| `glob` | Find files matching wildcard patterns | Cross-platform fast file path matching |
| `grep` | Literal or regex pattern search | Supports `-C`, `-A`, `-B` context lines and file type filters |
| `run_command` | Execute shell commands in native bash | Idle timeout safeguards and background task management |
| `code_explore` | Semantic code graph & symbol exploration | Bilingual thesaurus matching for deep cross-module reference tracing |
| `repo_map` | Full repository AST symbol outline tree | Token-budgeted AST symbol hierarchy |
| `task` | Dispatch parallel subagents | Read-only `explore` and path-scoped `worker` subagents |
| `request_user_input`| Interactive user questions | Single/multiple choice and text collection dialogs |

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


