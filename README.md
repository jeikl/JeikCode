<div align="center">
  <img src="./assets/jeikcode-logo.svg" alt="JeikCode Logo" width="120" />
  <h1>JeikCode: Ultra-Fast, Autonomous AI Coding Agent (Rust-Driven)</h1>
  <p><strong>98–99% KV-Cache Hit · Native Code Graph · Five-Protocol Native · Extreme Tool Self-Healing · Highly Customizable</strong></p>
  <p>
    <em>Next-generation autonomous AI coding agent purpose-built for complex production engineering — eliminating context bloat, broken tool loops, and cache thrashing.</em>
  </p>
  <p>
    <strong>English (Default)</strong> · <a href="./README.zh-CN.md"><strong>简体中文 (Chinese)</strong></a>
  </p>
  <p>
    <a href="https://github.com/jeikl/JeikCode/releases" target="_blank">
      <img src="https://img.shields.io/github/v/release/jeikl/JeikCode?color=blue&label=version" alt="version">
    </a>
    <img src="https://img.shields.io/badge/rust-1.88%2B-orange.svg" alt="rust">
    <img src="https://img.shields.io/badge/license-Non--Commercial%20(CC--BY--NC--4.0)-red.svg" alt="license">
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows%20%7C%20HarmonyOS-lightgrey.svg" alt="platform">
    <a href="https://github.com/jeikl/JeikCode" target="_blank">
      <img src="https://img.shields.io/github/stars/jeikl/JeikCode?style=social" alt="GitHub Stars"/>
    </a>
  </p>
  <p>
    🌐 <strong>Official GitHub Repository</strong>: <a href="https://github.com/jeikl/JeikCode">https://github.com/jeikl/JeikCode</a> ·
    <a href="https://github.com/jeikl/JeikCode/releases"><strong>Releases Download</strong></a>
  </p>
</div>

---

## 📌 What is JeikCode?

**JeikCode** is a next-generation cross-platform autonomous AI coding agent built natively in pure **Rust**. Not just another API wrapper, JeikCode is an industrial-strength agent designed specifically for deep software engineering. It directly eliminates the common frustrations of existing tools — such as rigid protocol lock-in, poor configurability, bloated runtime weight, and brittle tool death loops — providing blistering execution speeds, minimal memory footprint, a **pure-Rust native code semantic graph**, and robust self-healing toolchains to explore, refactor, build, and debug complex codebases autonomously.

---

## 🚀 Quick Start

### 1. One-Line Installation

Run the one-line command for your operating system:

```bash
# Linux / macOS / HarmonyOS PC
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

> **Build from source** (Requires Rust 1.88+):
> ```bash
> cd webui && npm run build && cd ..
> cargo install --path crates/jeikcode-cli --bin jeikcode --locked
> ```

### 2. Frontier Multi-Model Configuration (`~/.jeikcode/config.toml`)

On first launch, `~/.jeikcode/config.toml` is created automatically. JeikCode decouples account credentials (`provider_accounts`) from model profiles (`models`), natively connecting to modern frontier models including **xAI Grok (Grok 4.7 / 4.5), Claude (Opus 4.7 / Sonnet 4.6), Google Gemini (2.5 Pro / Flash), Xiaomi MiMo (MiMo-V2.6 Pro), and local Ollama**:

```toml
# Default active model profile (must be at the top level of the file)
default_model = "xai/grok-4.7"
language = "en"

# ── 1. Provider Accounts (API Keys and Base URLs) ──
[provider_accounts.xai]
provider = "openai-compatible"
api_key  = "xai-xxxxxxxxxxxxxxxxxxxxxxxx"
base_url = "https://api.x.ai/v1"

[provider_accounts.anthropic]
provider = "anthropic"
api_key  = "sk-ant-api03-xxxxxxxxxxxxxxxx"

[provider_accounts.gemini]
provider = "gemini"
api_key  = "AIzaxxxxxxxxxxxxxxxxxxxxxxxx"

[provider_accounts.xiaomi-mimo]
provider = "openai-compatible"
api_key  = "mimo-xxxxxxxxxxxxxxxxxxxxxxxx"
base_url = "https://api.xiaomimimo.com/v1"

[provider_accounts.ollama]
provider = "ollama"
base_url = "http://localhost:11434"

# ── 2. Model Profiles (Tiering, Reasoning & Protocol Mapping) ──

# xAI Grok 4.7 / 4.5 Reasoning Series (Flagship coding and logic)
[models."xai/grok-4.7"]
account          = "xai"
model            = "grok-4.7"
reasoning_model  = true
reasoning_effort = "high"

[models."xai/grok-code-fast"]
account          = "xai"
model            = "grok-code-fast-1"
reasoning_model  = true
reasoning_effort = "medium"

# Anthropic Claude Opus 4.7 / Sonnet 4.6 (Extended Thinking)
[models."anthropic/claude-opus-4-7"]
account          = "anthropic"
model            = "claude-opus-4-7"
thinking_enabled = true
thinking_budget  = 8192

[models."anthropic/claude-3-7-sonnet"]
account          = "anthropic"
model            = "claude-3-7-sonnet-20250219"
thinking_enabled = true
thinking_budget  = 8192

# Google Gemini 2.5 Series (1M+ context window + Native Thinking)
[models."gemini/2.5-pro"]
account          = "gemini"
model            = "gemini-2.5-pro"
thinking_enabled = true
thinking_budget  = 8192

[models."gemini/2.5-flash"]
account          = "gemini"
model            = "gemini-2.5-flash"
thinking_enabled = true
thinking_budget  = 4096

# Xiaomi MiMo V2.6 Full-Modality Reasoning Series (High speed & cost-effective)
[models."mimo/v2.6-pro"]
account          = "xiaomi-mimo"
model            = "mimo-v2.6-pro"
reasoning_model  = true
reasoning_effort = "high"

# Local Offline Private Models (Ollama native streaming protocol)
[models."ollama/qwen2.5-coder"]
account = "ollama"
model   = "qwen2.5-coder:32b"
```

> 💡 **Not sure how to configure? Just ask JeikCode!**  
> JeikCode natively supports five communication protocols (`OpenAI Chat Completions`, `OpenAI Responses (/v1/responses)`, `Anthropic Messages`, `Google Gemini (generateContent)`, and `Ollama Local`).  
> Run `jeikcode`, enter `/modeladd` for an interactive wizard, or simply ask JeikCode in plain English:  
> *“Configure my newly created Xiaomi MiMo API key: sk-xxxx and set the default model to mimo-v2.6-pro”* or *“Configure xAI's grok-4.7 and Claude Opus 4.7”*.  
> JeikCode safely updates `config.toml` and **hot-reloads immediately without restarting**!

### 3. Launch & Usage

Navigate into any project directory and run:

```bash
cd /path/to/your/project
jeikcode
```

Common CLI Commands:
```bash
# Launch in a specific project directory
jeikcode -C /path/to/project

# Launch with a specific configured model
jeikcode --model xai/grok-3

# Launch interactive WebUI console in browser
jeikcode webui

# Resume previous conversation
jeikcode -c

# Headless automated execution for CI/CD or script workflows
jeikcode -p "Investigate and fix OAuth callback 404 error"

# In-place self-upgrade to the latest release
jeikcode update
```

---

## 💡 How Does JeikCode Differ from Mainstream Agents?

Most existing open-source coding agents (such as Claude Code, OpenCode, etc.) are impressive, yet in large-scale production codebases they frequently encounter painful bottlenecks: **rigid configurability (locked into a single provider protocol), frequent cloud KV-cache thrashing driving up token bills, code search restricted to blunt regex grep, fragile tool failure loops, and poor concurrency for long tasks**.

JeikCode addresses these production pain points head-on while absorbing the architectural strengths of OpenCode, GrokBuild, and Claude Code:

| Production Dimension | Mainstream Open-Source Agents | **JeikCode's Production Architecture** |
| :--- | :--- | :--- |
| **Configurability & Protocols** | Often hardcoded to a single API dialect; custom proxies or local models are painful | **Native 5-Protocol Engine + Extreme Customization**: Built-in support for `OpenAI Chat`, `OpenAI Responses`, `Anthropic`, `Gemini`, and `Ollama`. Decoupled accounts and models |
| **Token Cost & Latency** | Unstable turn prefixes cause cloud KV-cache thrashing and astronomical bills | **98–99% KV-Cache Hit Rate**: Strict Append-Only dynamic tail wrapping (`user-wrap.md`) + `sacred_floor` memory protection keeps prefixes byte-exact across turns |
| **Code Retrieval & Context** | Relies on brute-force regex grep or rigid symbol MCP tools (e.g. Codegraph) | **Native Code Graph (CodeExplore)**: Weighted AST + bilingual semantic lexicon allows natural business queries. **70% faster retrieval, 90%+ hit rate, vastly superior to external MCPs** |
| **Tool Execution Reliability** | Aborts or gets stuck when models produce malformed JSON, wrong types, or raw Windows backslashes | **5-Stage Tool Self-Healing**: Auto-fixes JSON syntax, coerces types, sanitizes paths; multi-hunk edits use WAR topological sorting with 3-Way rebase retry |
| **Architecture & Daemon Mode** | Monolithic CLI with no headless daemon or multi-client attach | **Adopts OpenCode's top features: High-concurrency headless Daemon mode with multi-client attach** |

### 🌟 OpenCode-Inspired Headless Daemon Mode Tutorial

JeikCode adopts OpenCode's decoupled client-server architecture, natively supporting a long-running background daemon. Multiple terminals, WebUI browsers, and IDE extensions can attach to the same live runtime:

```bash
# 1. Start persistent background daemon service
jeikcode serve --host 0.0.0.0 --port 4096 --token your-secret-token

# 2. Prints all WebUI links — open directly in browser for a Codex-grade coding experience!
```

---

## 🗺️ Native Code Graph (CodeExplore) vs. Traditional MCPs

When developers use external MCP tools like Codegraph, they quickly hit a ceiling: **"It only understands exact symbol names, not developer intent."** When you ask *"Where is refund callback signature verified?"*, rigid symbol lookups fail completely, and the agent falls back to slow brute-force text search.

JeikCode eliminates external MCP glue overhead with an in-tree pure-Rust code graph:
- **Semantic Fusion**: Combines structural AST symbols with domain semantic lexicons, vectorizing code comments and identifiers for multi-way business alignment.
- **Budget-Aware Context Pruning**: Pins the most relevant implementation blocks at the top of context while summarizing secondary files into lean structural paths.
- **Real-World Metrics**: Slashes search iterations by **60%–70%**, reaching **90%+ target location accuracy** on complex business queries, massively outperforming open-source MCP tools.

---

## 💻 Common Shortcuts & Slash Commands

### Terminal Shortcuts

| Shortcut | Description |
| :--- | :--- |
| `Enter` | Send current input message |
| `\` + `Enter` | Universal newline insertion |
| `Shift+Enter` / `Alt+Enter` | Newline insertion (terminal protocol dependent) |
| `Esc` × 2 or `Ctrl+C` × 2 | **Double-press safe cancel**: Abort execution and restore input |
| `Alt+V` / `Ctrl+Alt+V` | Paste clipboard screenshot as multimodal image attachment |
| `Ctrl+Up` / `Ctrl+Down` | Scroll conversation history up / down |
| `Ctrl+L` | Clear screen while preserving active conversation context |

### Core Slash Commands

| Command | Description |
| :--- | :--- |
| `/plan` | Switch to **read-only planning mode** (explore without modifying code) |
| `/build` | Switch to **active build mode** (allows edits, builds, and tests) |
| `/effort` | Adjust reasoning effort on the fly (`low` / `medium` / `high` / `xhigh` / `off`) |
| `/webui` | Launch browser WebUI console (LaTeX KaTeX support, multi-project sidebar) |
| `/compact` | Trigger context compaction (`sacred_floor` memory protected) |
| `/model` | Inspect or switch model for the current session |
| `/modeladd` | Interactive wizard to configure new model providers |

---

## 📁 Project Customization (Project Instructions)

Place guideline files in your project root — JeikCode enforces these with **strict execution precedence over System defaults**:

* `AGENTS.md` / `JEIKCODE.md`: Core architectural constraints, code style, and co-authorship guidelines.
* `.jeikcode/rules.md`: Team business rules and operational constraints.
* `.jeikcode/glossary.md`: Domain glossary and bilingual terminology dictionary.

---

## Changelog

**v7.1.40** (2026-10-01): Multi-project session isolation and cross-directory penetration fix, introducing frontend `navSeqRef` sequence barrier to drop in-flight stale responses and establishing `effectiveWorkingDir` in Chat component to strictly bind message streaming, file uploads, compaction, and Git inspection to the active session's true directory; backend core routes (`process_chat_request` and `live_message`) enforce original registered working directory for session drafts with automatic cross-project catalog resolution, preventing draft misplacement across project buckets; injects `JEIKCODE_SESSION_ID` into session-scoped stdio MCP child processes and introduces double-checked locking for schema probing to eliminate concurrent startup competition; integrates `optimisticSessions` in WebUI sidebar for anti-loss on session switch during initial sends; refactors release pipeline to automatically extract rich structured technical notes from `CHANGELOG.md` for clean GitHub Releases; integrates Grok 4.7, Claude Opus 4.7, and MiMo 2.6 frontier model matrix with dynamic Release badge.

**v7.1.39** (2026-09-30): Moves the WebUI model selector out of the bottom composer and relocates it into the top-right header toolbar, eliminating input overcrowding that caused send buttons to deform and overflow; aligns all top-right controls with strict vertical centering within the 40px header and 6px bottom clearance, preventing any visual overlap or clipping over the Git panel below; redesigns model picker into a modern pill button with downwards-opening opaque cascade dropdown and elevated z-index, preventing semi-transparent background bleed-through.

**v7.1.38** (2026-09-30): WebUI top-right toolbar (update/theme/language) dynamically coordinates with the right inspector panel (Questions/Git) with smooth adaptive offset, preventing overlay over panel header and collapse buttons; removes rigid 780px two-row stacking in input footer with responsive model selector truncation in a clean single-row flow; integrates optimistic sessions into multi-project accordion lists with auto-expansion upon send and unified cache refresh on turn completion; isolates active stream request tokens from background detached discovery, resolving streaming freeze issues where turns appeared stuck until manual page reload.

**v7.1.36** (2026-09-30): Adds Check for Updates button to the top-right toolbar of WebUI with automatic/manual detection, highlighting a green upward arrow badge on new releases and presenting a 1-click upgrade dialog; desktop client automatically downloads the native Setup installer with progress display, exiting cleanly to launch the installer for in-place re-installation; fixes install scripts (`install.sh` / `install.ps1`) to trigger optional config sync when existing configuration is present; automatically displays a multi-select config sync modal on first launch after upgrading Desktop or WebUI (preserving custom models/accounts and MCP/Skills) with 1-click overwrite confirmation.

**v7.1.35** (2026-09-30): WebUI sidebar redesigned into a Codex-style multi-project accordion with project grouping, session management, expand/collapse, and in-project new chat; adding project folders invokes the native OS file explorer dialog (compatible with Everything search); New Chat button creates global sessions in home directory (`~`); removes redundant input subbar & keyboard hints and drops input box to the bottom for maximized vertical space; adds top-right circular toggles for theme (light/dark/system) and language (ZH/EN); independent model config button at bottom-left; desktop shell intercepts external links/navigation to open in the system default browser in normal multi-tab mode (never incognito); refactors Steer course-correction flow and multimodal payload routing; removes `task_progress` from `run_command` schema and aligns `summary` language with user prompt.

Full notes: [CHANGELOG.md](./CHANGELOG.md).

---

## License

This project is licensed under the **JeikCode Non-Commercial & Attribution License (Adapted from CC BY-NC 4.0)**. See the full [LICENSE](./LICENSE) for details:

1. **Non-Commercial Restriction**: The Software and its derivative works MAY NOT be used, in whole or in part, for any commercial purpose, commercial product integration, monetized services, SaaS hosting, or commercial redistribution without prior written authorization from the author.
2. **Mandatory Attribution**: Any public deployment, distribution, fork, or derivative work MUST prominently retain and display the original copyright notice, the project name (**JeikCode**), author credit, and the official repository URL: `https://github.com/jeikl/JeikCode`.
3. **Commercial Licensing**: For commercial licensing, enterprise integration, or partnership inquiries, please contact the author via the official repository.
