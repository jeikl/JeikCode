<div align="center">
  <img src="./assets/jeikcode-logo.svg" alt="JeikCode Logo" width="130" />
  <p><strong>98–99% KV-cache hit rate. Native code graph. Quad-protocol native: OpenAI · Responses · Anthropic · Gemini. Extreme self-healing tool chain.</strong></p>
  <h1>JeikCode: Ultra-Fast, Autonomous AI Coding Agent (Rust-Driven)</h1>
  <p><strong>98–99% KV-Cache · Native Code Graph · Quad-Protocol Native · Extreme Tool Self-Healing</strong></p>
  <p>
    <em>Next-generation Agentic AI coding assistant purpose-built for complex, large-scale production codebases.</em>
  </p>
  <p>
    <a href="./README.md"><strong>English (Default)</strong></a> · <a href="./README.zh-CN.md"><strong>简体中文 (Chinese)</strong></a>
  </p>
  <p>
    <a href="#1-what-is-jeikcode">What is JeikCode</a> ·
    <a href="#2-functional--architectural-comparison">Architecture Comparison</a> ·
    <a href="#3-native-codeexplore--repomap-deep-retrieval">CodeExplore Indexing</a> ·
    <a href="#4-core-architectural-highlights">Highlights</a> ·
    <a href="#5-installation--quick-start">Installation</a> ·
    <a href="#6-keybindings--commands">Commands</a> ·
    <a href="#7-multi-project-knowledge-packs">Knowledge Packs</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/version-7.1.7-blue.svg" alt="version">
    <img src="https://img.shields.io/badge/rust-1.88%2B-orange.svg" alt="rust">
    <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="license">
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows%20%7C%20HarmonyOS-lightgrey.svg" alt="platform">
    <a href="https://github.com/jeikl/JeikCode" target="_blank">
      <img src="https://img.shields.io/github/stars/jeikl/JeikCode?style=social" alt="GitHub Stars"/>
    </a>
  </p>
  <p>
    <a href="https://github.com/jeikl/JeikCode" target="_blank">
      <img src="https://img.shields.io/badge/GitHub_Repository-jeikl%2FJeikCode-181717?style=for-the-badge&logo=github&logoColor=white" alt="GitHub Repository" />
    </a>
    <a href="https://github.com/jeikl/JeikCode/releases" target="_blank">
      <img src="https://img.shields.io/badge/Releases-v7.1.7-00f2fe?style=for-the-badge&logo=github&logoColor=black" alt="Releases" />
    </a>
  </p>
  <p>
    🌐 <strong>Official GitHub Repository</strong>: <a href="https://github.com/jeikl/JeikCode">https://github.com/jeikl/JeikCode</a>
  </p>
</div>

---

## 1. What is JeikCode?

**JeikCode is a zero-bloat, ultra-fast autonomous AI coding agent natively built with Rust, specifically engineered to eliminate context bloat, eliminate blind grepping, and master large-scale complex software architectures.**

Four defining weapons sit in front of everything else:

1. 🔥 **Terrifying KV-cache hit rate**:
   - **98–99% on almost every conversation**, because prefixes stay byte-exact across turns.
   - **Strict Append-Only Prefix Discipline**: user queries are wrapped only at the tail (`user-wrap.md`). Paired with `sacred_floor` memory compaction protection, it eliminates KV-cache thrashing and slashes LLM inference cost.
   - Core prompts live in `init.yaml`, `rules.yaml`, and `user-wrap.md` — hot-reload on save, no restart, no rebuild.
2. 🗺️ **Native code graph (CodeExplore)**:
   - Built-in weighted AST syntax graphs + bilingual natural-language / docstring semantic alignment (Cilin-weighted).
   - Query by business logic (e.g. *"Find refund callback error handling"*) instead of blind regex or symbol-only LSP lookups — **60%–70% faster retrieval**, **90%+ location accuracy**.
3. 🔌 **Quad-protocol native**:
   - One agent speaks **OpenAI Chat Completions**, **OpenAI Responses**, **Anthropic Messages**, and **Google Gemini** natively.
   - Swap providers without rewriting the agent loop.
4. 🩸 **Extreme self-healing tool chain**:
   - Five-stage auto-heal for JSON, types, Windows paths, truncated payloads, and `edit_file` mismatches — the model is treated as a fallible child, not a perfect caller.
   - Same-file multi-hunk edits stay atomic (WAR topology + all-or-nothing write). Cross-turn VersionRing 3-way rebase recovers stale `old_string` without hanging the runtime.

---

## 2. Functional & Architectural Comparison

The following matrix objectively evaluates **JeikCode**, **OpenAI Codex**, **Claude Code**, **OpenCode**, and **Grok Build** based on real-world engineering benchmarks:

### 1. Feature & Mechanism Comparison Matrix

| Core Feature & Mechanism | **JeikCode (This Project)** | **OpenAI Codex (`@openai/codex`)** | **Claude Code (Anthropic)** | **OpenCode (OpenCode AI)** | **Grok Build (SpaceXAI)** |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Runtime & Core Architecture** | **Native Rust Core + Dynamic Sandbox** | **Rust (`codex-rs`) + TS CLI** | **TypeScript + CLI** | **TypeScript + Effect-TS** | **Rust (Ptyctl/ChatState)** |
| **Code Semantic Retrieval** | ✅ **CodeExplore: Weighted AST + Semantic Graph** | ⚠️ Basic file scan & AST | ⚠️ ripgrep / Glob full text search | ⚠️ LSP symbols + ripgrep | ⚠️ xai syntax graph |
| **Prompt Architecture** | ✅ **Ultra-lean externalized + mtime hot-reload** | ❌ Baked in binary, requires rebuild | ⚠️ Supports `CLAUDE.md`, core hardcoded | ⚠️ Supports custom prompt on reload | ⚠️ Supports precedence, core baked |
| **KV Cache Prefix Stability** | ✅ **Byte-exact tail wrap · 98–99% hit almost every turn** | ⚠️ Relies on remote server cache | ✅ **Anthropic Ephemeral Cache** | ⚠️ Relies on vendor raw cache | ⚠️ SQLite transcript based |
| **5-Stage Tool Recovery & Healing** | ✅ **Auto-Heal (JSON / Types / Windows Paths)** | ❌ Schema check only; fails on error | ⚠️ Relies on Claude model self-correction | ⚠️ Schema validation error aborts | ✅ Diagnostic feedback & coercion |
| **Tool Loop Guard Circuit Breakers** | ✅ **3-Attempt Loop Guard + Fuse Tripping** | ⚠️ Unified session abort | ⚠️ Relies on context truncation | ⚠️ Context truncation / manual abort | ✅ **Loop Guard active** |
| **First-Token Liveness Watchdog** | ✅ **Independent 60s × 3 timer (Anti-hang)** | ⚠️ Unified stream timeout | ⚠️ Unified stream timeout | ⚠️ Unified Effect timeout | ✅ Process watchdog integration |
| **Large Output Budget Management** | ✅ **64KB auto-fold + `fetch_output` slicing** | ⚠️ Basic hard truncation | ⚠️ Relies on model tool pruning | ⚠️ Basic file folding | ✅ Output budget management |
| **Multi-Protocol Support** | ✅ **Responses / Completions / Anthropic / Gemini** | ⚠️ OpenAI protocol exclusive | ⚠️ Claude protocol exclusive | ✅ Standard and custom protocols | ⚠️ xAI protocol exclusive |
| **Reasoning Effort Gears** | ✅ **Realtime `/effort` (`low/med/high/xhigh/off`)** | ⚠️ Fixed config for o-series | ✅ **Integrated Claude 3.7 Thinking** | ⚠️ Frontend panel manual config | ✅ **Integrated Grok Reasoning** |
| **Remote Headless & Web Console** | ✅ **Native Rust `serve` + Interactive WebUI** | ⚠️ App-Server & daemon dependent | ❌ Terminal CLI exclusive | ✅ **Web console + desktop app** | ❌ Terminal Pager TUI mode |
| **Multi-Tier Knowledge Packs** | ✅ **4-Tier packs strict over System default** | ⚠️ Basic agent role configuration | ✅ **Supports `CLAUDE.md` project spec** | ✅ **Project rules concatenation** | ✅ **Project rule configurations** |

---

### 2. Programming Language AST Support Matrix

| Language & Ecosystem | **JeikCode (CodeExplore)** | **Traditional Regex / Text Search** | **LSP Symbol Indexing** |
| :--- | :---: | :---: | :---: |
| **Rust** | ✅ **AST Syntax Graph + Semantic Mapping** | ⚠️ Regex misses macro expansions / traits | ⚠️ Requires full `rust-analyzer` setup |
| **TypeScript / JavaScript** | ✅ **JSX / TSX Component & Element AST** | ⚠️ Collides with common variable names | ⚠️ Symbol jump without semantic intent |
| **Vue (Vue2 / Vue3 SFC)** | ✅ **Template + Script Dual-AST Parsing** | ❌ Text-only, cannot resolve SFC bindings | ⚠️ Weak cross-block type inference |
| **Python** | ✅ **AST Syntax Graph + Docstring Mapping** | ⚠️ Regex search | ⚠️ Requires pyright/pylance server |
| **Java** | ✅ **Class/Method AST + Semantic Graph** | ⚠️ Raw text search | ⚠️ Heavyweight jdt.ls dependency |
| **Go** | ✅ **AST Syntax Graph + Semantic Mapping** | ⚠️ Raw text search | ⚠️ Requires gopls server |
| **C / C++** | ✅ **AST Syntax Graph + Header Include Chain** | ⚠️ Raw text search | ⚠️ Complex compile_commands.json needed |
| **Svelte / Astro / SCSS** | ✅ **Component Template & Style Class AST** | ⚠️ Raw regex matching | ❌ Lacks unified business query support |

---

## 3. Native CodeExplore & repo_map Deep Retrieval

While **CodeGraph** introduced valuable symbol-indexing concepts, real-world engineering surfaced a critical bottleneck: **it only understands rigid code symbols and has zero semantic understanding of natural language**. When a developer asks *"Where is the refund callback verified?"*, pure symbol search is blind.

JeikCode developed a fully autonomous **`CodeExplore`** and **`repo_map`** engine:

1. **Weighted AST Vectors + Semantic Alignment**:
   - Parses code structures (AST symbols, call graphs, type definitions, trait bounds).
   - Extracts bilingual comments and docstrings.
   - Aligns code logic with natural language business semantics using semantic embedding and Cilin lexical weighting.
2. **Weighted Relevance Ranking**:
   - Scores and directly **pins the most relevant implementation blocks** at the top of the agent context, eliminating trial-and-error grep loops.
3. **Budget-Aware Low-Relevance File Recommendations**:
   - Never dumps entire secondary files into context. Instead, condenses them into minimal token-budget paths and structural summaries, preserving maximum context space for active development.
4. **Benchmarked Metrics**:
   - 🚀 **60% - 70% reduction in search latency**: Pinpoints exact targets in a single round;
   - 🎯 **90%+ retrieval accuracy**: Handles bilingual and abstract business queries seamlessly.

---

## 4. Core Architectural Highlights

### 1. Strict Append-Only Cache Stability & Lean Prompts
- **Byte-Exact Immutability**: System identity, `MEMORY`, `SKILLS`, and knowledge rules are packed compactly at the conversation header.
- **`user-wrap.md` Dynamic Tail Wrapping**: The `{{input}}` template dynamically wraps only the active turn's user message. Modifying the template hot-reloads in milliseconds **without invalidating cached prefix tokens**.
- **`sacred_floor` Compaction Guard**: During `/compact` context summarization, critical rules and memory entries are anchored below the floor and are never dropped.

### 2. 5-Stage Tool Recovery, Self-Healing & Loop Guard
- **5-Stage Tool Self-Healing**: Direct parsing → Lenient JSON repair (trailing commas, unquoted keys, markdown code fences stripping) → `edit_file` regex rescue → Schema string decoding → Key-value fallback.
- **Windows Path Backslash Sanitization**: Automatically rescues unescaped single backslashes in paths like `D:\project\src` before serde deserialization.
- **Automatic Type Coercion**: Automatically coerces `"count":"5"` to `5` and `"verbose":"true"` to `true`.
- **64KB Large Output Folding**: Massive outputs fold into artifacts with head/tail previews; agent queries slices via `fetch_output` as needed.
- **3-Attempt Loop Guard Circuit Breaker**: Tripped when identical tool calls fail 3 times sequentially, halting runaway loops and forcing alternative strategies.
- **Dual-Tier Timeout Architecture**: 1800s hard process lifetime with process tree reclamation; 180s progress-aware idle budget (reset on `notifications/progress`).
- **Independent First-Token Watchdog**: 60s × 3 independent retry watchdog for reasoning models (DeepSeek-R1, Grok 3), preventing silent stream hangs.

### 3. Native Multi-Protocol Support & 4-Gear Reasoning
- Native support for four primary model protocols: **OpenAI Responses (`/v1/responses`)**, **OpenAI Chat Completions**, **Anthropic Messages**, and **Google Gemini Native Protocol**.
- Switch reasoning effort on the fly with `/effort` (`low` / `medium` / `high` / `xhigh` / `off`).
- Model credentials and parameters are fully decoupled; `/modeladd` queries upstream `/models` dynamically.

### 4. Modern Interactive WebUI & Multi-Instance Headless
- **WebUI Console**: Launch interactive browser control via `/webui` or `jeikcode webui` (featuring KaTeX LaTeX rendering and real-time token cost overlays).
- **Streaming Multipart Attachments**: Drag-and-drop multimodal attachments with upload progress. Non-image files stream into `.jeikcode_store` and remain indexed for tool queries.
- **Multi-Instance Headless Serve**:
  ```bash
  jeikcode serve --host 0.0.0.0 --port 4096 --token sk-my-secret
  jeikcode attach http://192.168.1.100:4096 --token sk-my-secret
  ```

---

## 5. Installation & Quick Start

### 1. One-Line Script Installation (Recommended)

Prebuilt binaries are available on [GitHub Releases](https://github.com/jeikl/JeikCode/releases):

```bash
# Linux / macOS Installation
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | bash

# Windows PowerShell Installation
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

### 2. Upgrades & Custom Update Channel

JeikCode natively supports seamless in-place self-upgrades (`update` and `upgrade` are completely identical):

```bash
# Check and upgrade in-place to latest release
jeikcode update

# Automatic non-interactive upgrade (auto-sync prompts/teaches, protect custom config)
jeikcode update -y

# Configure and remember custom/mirror update source (persists to ~/.jeikcode/config.toml)
jeikcode update set https://github.com/jeikl/JeikCode

# Inspect current update source and resolved endpoints
jeikcode update get

# Roll back to the previous version
jeikcode update rollback
```

Or re-run the one-line installer at any time to overwrite with the latest release:
```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | bash

# Windows PowerShell
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

### 3. Build from Source

Prerequisites: **Rust 1.88+** ([rustup.rs](https://rustup.rs/)):

```bash
git clone https://github.com/jeikl/JeikCode.git
cd JeikCode

cargo install --path crates/jeikcode-cli --bin jeikcode --locked
jeikcode --version
```

### 4. Configuration & Launch

Launch directly from any project directory:

```bash
cd /path/to/your/project
jeikcode
```

Configuration file is located at `~/.jeikcode/config.toml`:

```toml
default_provider = "deepseek"

[provider_accounts.deepseek]
api_key  = "sk-xxxxxxxxxxxxxxxxxxxxxxxx"
base_url = "https://api.deepseek.com/v1"

[models.deepseek-chat]
provider = "deepseek"
model    = "deepseek-chat"
protocol = "chat_completions"

[models.deepseek-reasoner]
provider         = "deepseek"
model            = "deepseek-reasoner"
protocol         = "chat_completions"
reasoning_effort = "high"
```

Common CLI commands:
```bash
# Launch in a specific project directory
jeikcode -C /path/to/project

# Launch with a specific model
jeikcode --model deepseek-reasoner

# Headless mode for automated scripts / CI/CD
jeikcode -p "Investigate and fix OAuth callback 404 error"

# Resume previous conversation
jeikcode -c
```

---

## 6. Keybindings & Commands

### 1. Terminal Shortcuts

| Shortcut | Description |
| :--- | :--- |
| `Enter` | Send current input message |
| `\` + `Enter` | Universal newline insertion |
| `Shift+Enter` / `Alt+Enter` | Newline insertion (terminal protocol dependent) |
| `Esc` ×2 / `Ctrl+C` ×2 | **Double-press safe cancel**: Abort execution and restore input |
| `Alt+V` / `Ctrl+Alt+V` | Paste clipboard screenshot as multimodal image attachment |
| `Ctrl+Up` / `Ctrl+Down` | Scroll conversation history up / down |
| `PageUp` / `PageDown` | Page scroll conversation history |
| `Ctrl+L` | Clear screen while preserving active context |

### 2. Slash Commands

| Category | Command | Description |
| :--- | :--- | :--- |
| **Workflow & Mode** | `/plan` | Switch to read-only exploration and planning mode |
| | `/build` | Switch to full code modification and build mode |
| | `/effort` | Dynamically adjust reasoning effort (`low/med/high/xhigh/off`) |
| **UI & Model** | `/webui` | Launch browser-based interactive web console |
| | `/modeladd` | Interactive GUI to configure new model endpoints |
| | `/model` | Switch active model for the current session |
| **Context & Project** | `/compact` | Trigger context compaction (`sacred_floor` protected) |
| | `/init` | Analyze project and initialize standardized instructions |

---

## 7. Multi-Project Knowledge Packs

JeikCode supports multi-tier project rules that hold **strict execution precedence over System default prompts**:

| File Path | Function & Precedence |
| :--- | :--- |
| `AGENTS.md` / `JEIKCODE.md` | Primary architectural and coding guidelines |
| `.jeikcode/rules.md` | Business logic constraints and operation safety policies |
| `.jeikcode/dbwords.md` | Database schemas, key fields, and enum definitions |
| `.jeikcode/glossary.md` | Domain-specific terminology and bilingual mappings |

---

## License

This project is licensed under the [MIT License](./LICENSE).
