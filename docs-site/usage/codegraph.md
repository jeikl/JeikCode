# CodeExplore

CodeExplore is a core innovation that sets JeikCode apart from conventional AI coding assistants. JeikCode incorporates an ultra-low-overhead, change-aware weighted code graph engine featuring native Chinese and English natural-language semantic retrieval.

Whether tracking cross-file function calls and type definitions, or navigating fuzzy requirements described in mixed natural language and business terminology, CodeExplore accurately guides the Agent to the exact implementation sites.

---

## Language & Ecosystem Support

JeikCode natively supports AST parsing and topological extraction for major programming languages:

| Language / Framework | Parser | Supported Features |
| :--- | :--- | :--- |
| **Rust** | Tree-Sitter Rust | Structs, enums, trait impls, macro expansion contexts, module hierarchy |
| **TypeScript / JavaScript** | Tree-Sitter TS/JS | Classes, functions, arrow functions, interfaces, JSX/TSX exports and imports |
| **Python** | Tree-Sitter Python | Classes, functions, decorators, modules, dynamic references |
| **Go** | Tree-Sitter Go | Structs, interfaces, functions, package methods, receivers |
| **Java** | Tree-Sitter Java | Classes, methods, annotations, inheritance chains, interface impls |
| **C / C++** | Tree-Sitter C/CPP | Function prototypes, header references, classes, namespaces |
| **C#** | Tree-Sitter C# | Classes, namespaces, properties, async methods, pattern matching |
| **Vue** | Tree-Sitter Vue | `<script setup>` Composition API, template bindings, component dependencies |
| **PHP / Ruby** | Tree-Sitter PHP/Ruby | OOP structures, functions, class inheritance networks |

---

## Index Construction & Configuration Guide

### 1. Automatic Indexing & Real-Time Change Watching
Under normal circumstances within a project workspace, **manual indexing is not required**. The Agent automatically initializes the index on-demand; during daily development, the engine monitors file saving events and applies single-file incremental diff patches (1~3ms updates) without requiring manual rebuilds.

### 2. Multi-Repository Best Practices
If JeikCode is launched from a parent directory containing multiple independent repositories:
- **It is strongly recommended to launch or build the index within each individual project directory**;
- This prevents cross-project symbol collision and unnecessary indexing noise;
- *Exception*: Monorepos sharing a unified full-stack architecture (e.g. `web/` and `server/` within the same repository).

### 3. Manual CLI Commands
Run the following commands in the project root to analyze the repository and cache graph data:

```bash
# Initial or incremental index build
jeikcode init

# Force full re-scan and rebuild (clears previous cache)
jeikcode init --force
```

### 4. Integration with `code_explore` Tool
During task execution, the model queries the code graph using the built-in `code_explore` tool:

```text
User: "Explain how user login JWT authentication and middleware interceptors work."
↓
Agent invokes: code_explore(path="src", query="user login JWT auth middleware")
↓
Code Graph:
1. Expands query via thesaurus to TokenValidator, verify_token, AuthMiddleware
2. Resolves call topology and extracts context code chunks
3. Aggregates upstream interceptor pipelines and downstream route handlers
↓
Agent returns exact execution timeline and file line references
```

You can ask high-level business or architectural questions without knowing exact filenames or symbol signatures in advance.

---

## Code Graph Ignore System: .gitignore and .codegraphignore

To ensure that the code graph index maintains maximum signal-to-noise ratio and sub-millisecond retrieval speeds, the indexing engine operates with strict ignore and filtering mechanisms, supporting **automatic .gitignore alignment**, **independent custom decoupling**, and **hardcoded defaults**.

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

# 7. C# / .NET outputs (MSBuild config dirs only; a directory named bin can be source)
**/bin/[Dd]ebug/
**/bin/[Rr]elease/
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
- **Directory Skip List (`SKIP_DIR_NAMES`)**: Automatically prunes `node_modules`, `target`, `obj`, `dist`, `build`, `.venv`, `vendor`, `coverage`, and other build/dependency folders. A directory named `bin` is kept (Rust `src/bin`, Ruby and npm `bin/` are source); `bin/Debug` and `bin/Release` are still pruned;
- **Generated File Detection (`is_generated_source`)**: Skips `*.designer.cs`, `*.g.cs`, `*.AssemblyAttributes.cs`, `*.min.js`, `*.bundle.js`, `*.map`, and similar generated or minified files. Hand-written `Properties/AssemblyInfo.cs` stays in the index;
- **Minified Web Bundle Interceptor (`is_minified_web_bundle`)**: Detects dense JS/CSS files (>32KB with <4 newlines in the first 4KB) to prevent Tree-Sitter AST blowups;
- **Per-file Size Limits (`max_index_file_bytes`)**: 256KB ceiling for web scripts/styles and 768KB for general source code.
