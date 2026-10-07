<div align="center">
  <img src="./assets/jeikcode-logo.svg" alt="JeikCode Logo" width="120" />
  <h1>JeikCode: Native Code Graph · Extreme KV-Cache · Cross-Platform All-in-One Agent (TUI / WebUI / Desktop)</h1>
  <p><strong>Native Code Graph · 98–99% KV-Cache · Cross-Platform All-in-One Agent (TUI, WebUI, Desktop) · Self-Healing</strong></p>
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
    <a href="https://jeikcode.top">
      <img src="https://img.shields.io/badge/📖_Official_Documentation-jeikcode.top-0284c7?style=for-the-badge" alt="Docs">
    </a>
    <a href="https://github.com/jeikl/JeikCode">
      <img src="https://img.shields.io/badge/⭐_Star_on_GitHub-Support_Project-2563eb?style=for-the-badge&logo=github&logoColor=white" alt="GitHub Repo">
    </a>
    <a href="https://github.com/jeikl/JeikCode/releases">
      <img src="https://img.shields.io/badge/📥_Download_Releases-Latest-0ea5e9?style=for-the-badge" alt="Releases">
    </a>
  </p>
  <p>
    🌐 <strong>Official Docs Portal</strong>: <a href="https://jeikcode.top"><strong>https://jeikcode.top</strong></a> · 
    ⭐ <strong>Source Code</strong>: <a href="https://github.com/jeikl/JeikCode"><strong>https://github.com/jeikl/JeikCode</strong></a>
  </p>
</div>

> 🌟 **Support the Project**: If you find JeikCode helpful for your engineering workflow, please consider starring the repository on [GitHub](https://github.com/jeikl/JeikCode) ⭐! Official documentation is now live at: 👉 **[https://jeikcode.top](https://jeikcode.top)**

---

## 📌 What is JeikCode?

**JeikCode** is a next-generation, cross-platform, full-featured open-source AI Coding Agent built natively in pure **Rust**. Designed specifically for high-complexity production software engineering, it delivers extreme lightweight speed, complete control, and end-to-end multi-device workflows:

- 🔍 **Semantic CodeGraph (CodeExplore)**: Powered by Tree-Sitter across 12+ programming languages. Seamlessly integrates domain bilingual thesauruses (`thesaurus`) to query code using everyday business natural language, backed by 1~3ms zero-touch incremental patching;
- 🛡️ **98–99% KV-Cache Protection (Sacred Floor)**: Enforces strict append-only byte immutability and memory preservation (`sacred_floor`), keeping system prefixes frozen across turns. Completely eliminates cache thrashing, slash token expenses by over 90%, and compresses TTFT to milliseconds;
- ⚡ **9k Minimal Prompts & High Discipline**: Avoids 30–50k token system bloat. A standard greeting turn consumes only ~9–11k tokens, reserving the maximum context window strictly for your codebase. Fully open-source and live-reloadable;
- 📱 **Omni-Platform Workflows & Mobile UI**: Full coverage across terminal TUI, modern WebUI, Tauri desktop apps, and headless background daemons. WebUI is specifically optimized for phone and tablet touchscreens for on-the-go coding;
- 🔒 **Git-like State Machine Atomic Protection**: Strict concurrent file edit boundaries eliminate dirty writes. Operates safely across frontier and lightweight models, complete with one-click undo/rollback checkpoints;
- 🔄 **Native Support for 5 Industry Protocols**: Seamlessly integrates `OpenAI Chat`, `OpenAI Responses`, `Anthropic Claude`, `Google Gemini`, and `Ollama` formats, with complete decoupling of accounts and models;
- 🧩 **Tri-Protocol Gateway & Open Ecosystem**: Exposes standard OpenAI, Anthropic, and Gemini compatible server endpoints, enabling tools like OpenClaw or translation plugins to connect effortlessly;
- 🚀 **Rapid Iterations & Agile Code Review**: Community issues and PRs are reviewed and merged with extreme velocity, accompanied by fast pre-release beta builds.

---

## 🚀 Installation & Quickstart

### 1. Desktop Application (Recommended)

Out-of-the-box cross-platform desktop application with embedded WebUI and automatic CLI PATH integration:

| OS / Architecture | Installer | Description |
| :--- | :--- | :--- |
| **Windows** (64-bit) | [📥 **Download Windows Installer (.exe)**](https://github.com/jeikl/JeikCode/releases/latest) | Graphical setup wizard |
| **macOS** (Apple Silicon / Intel) | [🍏 **Download macOS Installer (.dmg)**](https://github.com/jeikl/JeikCode/releases/latest) | Native M1~M4 & Intel packages |
| **Linux** (Debian / Ubuntu / Universal) | [🐧 **Download Linux Package (.deb / .AppImage)**](https://github.com/jeikl/JeikCode/releases/latest) | Standalone portable executable |

### 2. Official Terminal One-Liner (CLI)

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

> 💡 **For Advanced Installation & Deployment (Source compilation, Headless Daemon, Docker, etc.)**: Please refer to the official documentation portal 👉 **[https://jeikcode.top/guide/installation](https://jeikcode.top/guide/installation)**

---

## 💡 Quick Start

### 1. Launching

Navigate to any codebase directory and start:

```bash
cd /path/to/your/project
jeikcode
```

Common CLI commands:
```bash
# Start in a specific project directory
jeikcode -C /path/to/project

# Launch and open the browser WebUI
jeikcode webui

# Continue / resume previous conversation session
jeikcode -c

# Headless autonomous task execution (ideal for CI/CD and scripts)
jeikcode -p "Investigate and fix OAuth callback 404 issue"

# One-click seamless upgrade to latest version
jeikcode update
```

### 2. Model Configuration (`~/.jeikcode/config.toml`)

On first launch, `~/.jeikcode/config.toml` is created automatically. You can configure models visually or interactively:

- Run `/modeladd` in the terminal to open the interactive setup wizard;
- **Or directly instruct JeikCode**: *"Configure my Anthropic API Key (sk-ant-xxx) and set claude-3-7-sonnet as default"*. JeikCode will safely update `config.toml` with zero-restart live reload!

Typical configuration example:

```toml
# Default active model profile
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
[models."xai/grok-4.7"]
account          = "xai"
model            = "grok-4.7"
reasoning_model  = true
reasoning_effort = "high"

[models."anthropic/claude-3-7-sonnet"]
account          = "anthropic"
model            = "claude-3-7-sonnet-20250219"
thinking_enabled = true
thinking_budget  = 8192

[models."gemini/2.5-pro"]
account          = "gemini"
model            = "gemini-2.5-pro"
thinking_enabled = true
thinking_budget  = 8192

[models."mimo/v2.6-pro"]
account          = "xiaomi-mimo"
model            = "mimo-v2.6-pro"
reasoning_model  = true
reasoning_effort = "high"
```

---

## 📚 Full Documentation & Advanced Guides

For comprehensive tutorials, architectural specifications, and ecosystem integrations, visit the official docs:

- 📖 **Official Documentation Site**: [https://jeikcode.top](https://jeikcode.top)
- 🚀 [Installation & Quickstart Guide](https://jeikcode.top/guide/getting-started)
- ⚙️ [Model Provider Configuration](https://jeikcode.top/guide/login)
- 🔌 [Model Context Protocol (MCP) Integration](https://jeikcode.top/advanced/mcp)
- 🧩 [Agent Skills System](https://jeikcode.top/advanced/skills)
- 🖥️ [WebUI, Desktop App & Background Daemon](https://jeikcode.top/deploy/daemon)
- 📝 [Full Changelog & Releases History](https://github.com/jeikl/JeikCode/releases)

---

## 📝 Changelog

> Only showing the latest 2 releases. For the full release history, see [CHANGELOG.md](./CHANGELOG.md) and [GitHub Releases](https://github.com/jeikl/JeikCode/releases).

### v7.2.0 (2026-10-08)

- **[Core Tools Overhaul & Robustness] Unified and Streamlined Tool Architecture, Enhanced `read` & `grep`, Deterministic Shell Execution, and LLM Glob Normalization**:
  - Permanently retired legacy `codeintel::repo_map` in favor of a modern, unified `read` tool supporting massive safe chunk reads, directory trees, images, and centered keyword search (`key_string`) with pure-text responses;
  - Enhanced `grep` with multi-mode outputs (`content`, `files_with_matches`, `count`) and dedicated context lines control; hardened `glob` with `./` prefix stripping and Windows backslash normalization;
  - Overhauled `run_command` with deterministic shell execution, workspace-relative `cwd`, native Windows PowerShell support, MSYS2/Bash PATH hardening, process grace periods (`settle_secs`), and multi-field structured parameter validation.
- **[Prompts & Agentic Workflow Discipline] Overhauled Core System Prompts, Reinforced Operational Discipline, Stable High-Concurrency Tool Dispatch, and Aggressive Reading Strategy**:
  - Redesigned system prompts and workflow discipline across `rules.yaml` and `system.yaml`, enforcing strict task boundary awareness, atomic commit discipline, and checklist closure verification;
  - Optimized multi-turn reasoning pipelines to launch independent tool calls in parallel concurrently whenever no data dependency exists, slashing turnaround latency;
  - Mandated wide-window context reading (reading several hundred lines or entire files in a single pass) to build an authoritative mental model upfront, eliminating fragmented blind edits; hardened in-flight steer prompt guidance.
- **[CodeIntel & CodeGraph] Multi-Ecosystem Source Protection, Context-Aware MSBuild Pruning, and Adaptive Workspace Indexing**:
  - Unlocked executable language source bins (Rust `src/bin/*.rs`, Ruby `bin/rails`, Node `bin/cli.js`), reclaimed ASP.NET `wwwroot` assets, and preserved hand-written `AssemblyInfo.cs`;
  - Pruned MSBuild build directories (`Debug`/`Release` under `bin/` or `obj/`) based on path context, and expanded native `.codegraphignore` presets for .NET, Elixir, Flutter, Zig, Haskell, Swift, Unreal, and Unity.
- **[WebUI & Visual Polish] Refined Charcoal Palette, Streamlined Single-Line Composer, Interactive Mermaid Diagrams, and VSCode-Style Git Inspector**:
  - Redesigned the WebUI palette inspired by Gemini, setting a charcoal dark canvas as default; streamlined composer into a single-line capsule with a live green-lightning token badge;
  - Integrated interactive Mermaid diagrams directly into chat streams; upgraded Git panel with VSCode-style commit hover cards, responsive Git Graph, and compact action menus; fixed nested Markdown code block glitches.
- **[Mobile Experience] Comprehensive Mobile-First UI Overhaul, Touch Navigation, and Resilient Connection Architecture**:
  - Implemented adaptive top navigation with auto-collapsing controls; optimized mobile virtual keyboard interaction with soft newlines and seamless keyboard docking;
  - Added dedicated Mobile Approval Dock with thumb-friendly layout; hardened mobile reconnection resilience to automatically re-sync session state without blank screens.
- **[Remote Browsing & Workspace Sync] Seamless Remote Directory Selection, Multi-Observer Project Synchronization, and Windows Verbatim Path Normalization**:
  - Integrated an in-page directory picker for remote browser sessions to eliminate hanging native dialog requests; added confirmation for project hiding while preserving session files;
  - Synchronized pinned and hidden sidebar projects across tabs and observers via `GET/POST /projects/sidebar`, automatically surfacing running projects; stripped Windows extended verbatim path prefixes (`\\?\`, `//?/`, `/?/`).
- **[Session Architecture & Daemon Robustness] Direct Session Deep-Linking, Retirement of Legacy Sync Streams, Hardened Permissions, and Disk Quota Governance**:
  - Passed active session IDs in `/webui` launch URLs for immediate deep-linking; retired legacy `/sync` double-streaming in favor of unified `/chat` and `/chat/watch` SSE pipelines;
  - Hardened approval permission handling with instant dismissal and strict correlation; reinforced security boundaries; disabled verbose datalogs by default and enforced disk storage quotas.
- **[Docs, CI/CD & Engineering Discipline] Full-Stack Docs Refresh, Hardened Native CI Matrix, and Upgraded Release Infrastructure**:
  - Elevated built-in tools to top-level site navigation; resolved Ubuntu 22.04 / 24.04 Linux desktop packaging compatibility; coupled `tsc --noEmit` as an automated frontend build gate; adopted standardized Pull Request templates.

### v7.1.53 (2026-10-05)

- **[Beta Release Channel] Prioritize latest pre-releases in Beta channel to properly display preview version numbers**:
  - Updated `check_update` in `api_update.rs` so the Beta channel selects the latest pre-release instead of formal releases with matching core versions.
- **[Image Lightbox Modal] Add prominent touch-friendly close button (✕) for image previews**:
  - Added a floating `.img-lightbox-close` button positioned at top-safe-area right with backdrop blur for one-tap dismiss on mobile devices.
- **[Collapsible Sticky Todo Panel & Blank Drawer Fix] Mobile-first collapsible Todo list capsule and drawer fix**:
  - Re-engineered `SessionTodoPanel` to collapse into a sleek single-line capsule showing status metrics and active task on mobile views; resolved mobile sidebar drawer going black when collapsed.
- **[Queued Cards Control Actions] Bottom action buttons for queued messages (Send Now, Steer, Cancel)**:
  - Moved queued action buttons below the card with comfortable touch targets. Added "Send Now" (interrupts running turn and sends immediately).

### v7.1.52 (2026-10-05)

- **[Universal Responsive & Mobile UX] Gemini-aligned responsive mobile architecture, bottom-sheet modals, bottom-docked composer, and native media/file upload button**:
  - Built universal responsive design system across mobile (≤768px), tablet/iPad (769-1024px), and desktop (>1024px). Modals automatically elevate to native-style bottom sheets with top pull handles and safe-area insets. Overhauled model configuration into a fluid layout, docked mobile composer to the bottom (Gemini style), and added a dedicated native media/file upload button.
- **[Update Channels & Modal] Add Stable and Beta release channels with interactive modal and pre-release support**:
  - Added `UpdateDialog` modal with dual-channel toggle (Stable / Beta) aligned with Antigravity-Manager, persistent channel preference (`localStorage`), real-time channel switching, and progress indicators. Enhanced daemon backend with SemVer pre-release version comparison.
- **[WebUI Session Switch & Queued Steers] Fix disappearing queued cards, preserve steer cards, and prevent message loss on session switch**:
  - Refactored `diskSettled` check so an active turn requires the disk transcript to actually include the current user turn and not lag behind before replacing `currentCached`. Added `sessionStorage` persistence (`STORAGE_KEY_QUEUED_MESSAGES`) for queued and steered messages across refreshes. Bound `targetSid` in `handleSteerQueuedMessage` to eliminate asynchronous session switching race conditions.

---

## 📄 License

This project is licensed under the **JeikCode Non-Commercial & Attribution License (Adapted from CC BY-NC 4.0)**. See the full [LICENSE](./LICENSE) for details:

1. **Non-Commercial Restriction**: The Software and its derivative works MAY NOT be used, in whole or in part, for any commercial purpose, commercial product integration, monetized services, SaaS hosting, or commercial redistribution without prior written authorization from the author.
2. **Mandatory Attribution**: Any public deployment, distribution, fork, or derivative work MUST prominently retain and display the original copyright notice, the project name (**JeikCode**), author credit, and the official repository URL: `https://github.com/jeikl/JeikCode`.
3. **Commercial Licensing**: For commercial licensing, enterprise integration, or partnership inquiries, please contact the author via the official repository.
