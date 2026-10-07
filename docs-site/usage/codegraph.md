# CodeExplore

CodeExplore is a core innovation that sets JeikCode apart from conventional AI coding assistants. By constructing a deep Abstract Syntax Tree (AST) and symbol call topology network across your entire repository, it grants the Agent repository-wide structural awareness.

Whether tracking cross-file function calls and type definitions, or navigating fuzzy requirements described in mixed natural language and business terminology, CodeExplore accurately guides the Agent to the exact implementation sites.

---

## Code Graph Ignore System: .gitignore and .codegraphignore

To ensure that the code graph index maintains maximum signal-to-noise ratio and sub-millisecond retrieval speeds, the indexing engine operates with strict ignore and filtering mechanisms, supporting **out-of-the-box defaults**, **automatic .gitignore alignment**, and **independent custom decoupling**.

### 1. Default Binding to `.gitignore`
In standard Git repositories, the code graph crawler (driven by a high-throughput `git ls-files` pipeline) **strictly adheres to the repository's `.gitignore` rules by default**. External dependencies (`node_modules/`, `target/`), build outputs, temporary caches, and local configuration files are automatically skipped and never pollute the graph.

### 2. Deep Decoupling: Dedicated `.codegraphignore`
In enterprise codebases and team workflows, developers frequently encounter scenarios where **certain files must be committed and tracked in Git, but should never be parsed or indexed by the code graph**:
- Massive test datasets (Mock JSON, database fixtures, bulk SQL seeding scripts);
- In-tree vendor dependencies and minified UMD bundles (e.g. bundled UI libraries);
- Auto-generated protocol stubs (Protobuf outputs, massive ORM entity mappings);
- Bundled static binary assets or template files.

Adding these to `.gitignore` would prevent Git from tracking necessary code. **JeikCode cleanly decouples code graph indexing from Git ignore rules via `.codegraphignore`**:
- **Core Mechanism**: **Any file or pattern declared in `.codegraphignore` will be skipped by the code graph indexer, even if it is actively tracked and committed in Git!**
- **Syntax Standards**: Fully compatible with standard Glob and GitIgnore syntax (supports wildcards `*`, directory anchors `/`, and negative patterns `!`).

#### Configuration Locations
You can place `.codegraphignore` at any of the following locations (cascading automatically from local project to global scope):
1. **Workspace Root (Recommended)**: `<workspace>/.codegraphignore` (applies to the current project)
2. **Project Dot-folder**: `<workspace>/.jeikcode/.codegraphignore`
3. **Global User Configuration**: `~/.jeikcode/.codegraphignore` (applies globally across all local projects)

#### Example Template
Create or edit `.codegraphignore` and specify patterns to exclude from code graph parsing:

```sh
# ==============================================================================
# .codegraphignore — Code Graph & Symbol Index Ignore Rules
# ==============================================================================
# Regardless of whether files are tracked in Git, matching entries are excluded from CodeGraph.

# 1. Generated & Minified Assets
*.generated.*
*.g.cs
*.designer.cs
*.min.js
*.min.css
*.bundle.js
*.map
element-ui/
element-plus/

# 2. Frontend Dependencies & Build Caches
node_modules/
dist/
.output/
.next/
.nuxt/
.turbo/
.cache/
coverage/
*.tsbuildinfo

# 3. Python Virtual Environments & Bytecode
__pycache__/
*.py[cod]
.venv/
venv/
.pytest_cache/

# 4. Java / JVM Build Artifacts
.gradle/
*.class
*.jar
*.war

# 5. Rust Build Targets
target/
*.rlib

# 6. C / C++ / Native Binaries & Symbol Dumps
cmake-build-*/
*.o
*.obj
*.so
*.dll
*.exe
*.pdb

# 7. C# / .NET Outputs
bin/
obj/
TestResults/

# 8. Go / PHP In-tree Vendors
vendor/

# 9. IDEs & OS Metadata
.git/
.idea/
.vscode/
.DS_Store
Thumbs.db
*.log
```

> **Hot Reload**: Changes to `.codegraphignore` take effect immediately on the next index rebuild (or whenever file saving triggers incremental watch, or via `jeikcode init --force`).

### 3. Built-in Hardcoded Safeguards
Even in projects lacking `.gitignore` or `.codegraphignore`, the JeikCode engine applies built-in defensive filters:
- **Directory Skip List (`SKIP_DIR_NAMES`)**: Automatically prunes `node_modules`, `target`, `bin`, `obj`, `dist`, `build`, `.venv`, `vendor`, `coverage`, and 30+ common build/dependency folders;
- **Generated File Detection (`is_generated_source`)**: Skips `*.designer.cs`, `*.g.cs`, `AssemblyInfo.cs`, `*.min.js`, `*.bundle.js`, `*.map`, etc.;
- **Minified Web Bundle Interceptor (`is_minified_web_bundle`)**: Detects dense JS/CSS files (>32KB with <4 newlines in the first 4KB) to prevent Tree-Sitter AST blowups;
- **Per-file Size Limits (`max_index_file_bytes`)**: 256KB ceiling for web scripts/styles and 768KB for general source code.

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
