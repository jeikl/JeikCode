# CodeExplore

CodeExplore is a core innovation that sets JeikCode apart from conventional AI coding assistants. By constructing a deep Abstract Syntax Tree (AST) and symbol call topology network across your entire repository, it grants the Agent repository-wide structural awareness.

Whether tracking cross-file function calls and type definitions, or navigating fuzzy requirements described in mixed natural language and business terminology, CodeExplore accurately guides the Agent to the exact implementation sites.

---

## Architecture & Core Mechanics

Traditional code search methods rely on simple string matching (Grep) or basic symbol indexing, which often fail when faced with long cross-file call chains or discrepancies between business terms and actual code naming. JeikCode CodeExplore overcomes these limitations through the following capabilities:

1. **AST Symbol Topology & Reference Mesh**:
   - Built on industrial-grade Tree-Sitter parsing engines;
   - Deeply extracts function definitions, classes/structs, traits/interfaces, field reads/writes, call relationships, and dependency graphs.

2. **Bilingual Thesaurus & Semantic Business Search**:
   - Traditional code search tools are limited to strict symbol or class name matching;
   - JeikCode CodeExplore seamlessly integrates a domain bilingual thesaurus (`thesaurus`) with calling topology. **Most importantly, it supports natural-language and business queries** (e.g., "how does order cancellation work upon timeout?", "where does the authentication interceptor take effect?", "how is multi-protocol streaming converted?"). The Agent leverages multi-level synonym expansion and call chain traversal to instantly locate the most relevant code and complete upstream/downstream call graphs.

3. **Minimal Resource Footprint & Zero-touch Incremental Watching**:
   - Ultra-low resident memory usage without background CPU drain;
   - Intelligent file change watching with 1~3ms single-file incremental diff patching—**fully hands-free thereafter, automatically monitoring file changes without requiring manual rebuilds**.

---

## Language & Ecosystem Support

JeikCode natively supports syntax analysis and topology extraction across major programming languages:

| Language / Framework | Parser Engine | Key Highlights |
| :--- | :--- | :--- |
| **Rust** | Tree-Sitter Rust | Structs, enums, trait implementations, macro expansion context, module trees |
| **TypeScript / JavaScript** | Tree-Sitter TS/JS | Classes, functions, arrow functions, interfaces, JSX/TSX exports and imports |
| **Python** | Tree-Sitter Python | Classes, functions, decorators, modules, and dynamic reference tracking |
| **Go** | Tree-Sitter Go | Structs, interfaces, functions, package methods, and receivers |
| **Java** | Tree-Sitter Java | Classes, methods, annotations, inheritance hierarchies, interface contracts |
| **C / C++** | Tree-Sitter C/CPP | Function prototypes, header includes, classes, and namespaces |
| **C#** | Tree-Sitter C# | Classes, namespaces, properties, async methods, and pattern matching |
| **Vue** | Tree-Sitter Vue | `<script setup>` Composition API, template bindings, component dependencies |
| **PHP / Ruby** | Tree-Sitter PHP/Ruby | OOP structures, functions, and inheritance hierarchies |

---

## Indexing & Multi-Repo Guidance

### 1. Automatic Indexing & Maintenance
In standard project workflows, **manual index generation is typically not needed**. The Agent automatically initiates background indexing when appropriate and updates incrementally whenever files are saved.

### 2. Multi-Repository Workspaces
If you launch JeikCode from a parent folder containing multiple distinct code repositories that do not belong to the same project:
- **We strongly recommend entering each specific sub-repository to build individual indices or start the session**;
- This prevents global cross-project indexing from producing noisy symbol overlaps and ambiguous search results;
- *Exception*: When the multi-repo layout represents a single project's decoupled frontend and backend (e.g., `web/` and `server/` in one monorepo), joint indexing is both meaningful and highly recommended.

### 3. Manual Build Commands

Execute the following commands in your target project root to analyze syntax and generate graph cache in seconds:

```bash
# First-time or incremental index build
jeikcode init

# Force a clean, full rebuild of the repository graph cache
jeikcode init --force
```

---

## Interacting via `code_explore`

During task execution, the model automatically accesses CodeExplore intelligence using the built-in `code_explore` tool:

```text
User: "Explain how user authentication verifies JWT tokens and handles route interception."
↓
Agent executes: code_explore(path="src", query="user authentication JWT token verification interceptor")
↓
CodeExplore:
1. Thesaurus expands query to TokenValidator, verify_token, AuthMiddleware, etc.
2. Extracts calling topology and relevant context snippets.
3. Aggregates downstream route injection and upstream filter pipelines.
↓
Agent delivers an accurate architectural breakdown with precise file paths and line ranges.
```
