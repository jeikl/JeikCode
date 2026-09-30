<div align="center">
  <img src="./assets/jeikcode-logo.svg" alt="JeikCode Logo" width="120" />
  <h1>JeikCode: Ultra-Fast, Autonomous AI Coding Agent (Rust-Driven)</h1>
  <p><strong>98–99% KV-Cache Hit Rate · Native Code Graph · Quad-Protocol Native · Extreme Tool Self-Healing</strong></p>
  <p>
    <em>Next-generation autonomous AI coding assistant purpose-built for complex software engineering, eliminating context bloat and blind grepping.</em>
  </p>
  <p>
    <a href="./README.md"><strong>English (Default)</strong></a> · <a href="./README.zh-CN.md"><strong>简体中文 (Chinese)</strong></a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/version-7.1.7-blue.svg" alt="version">
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

### 2. Quick Configuration

On first launch, `~/.jeikcode/config.toml` is automatically created. Add your model API key to begin:

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
jeikcode --model deepseek-reasoner

# Launch interactive WebUI console in browser
jeikcode webui

# Resume previous conversation
jeikcode -c

# Headless mode for automated scripts or CI/CD
jeikcode -p "Investigate and fix login callback 404 error"

# In-place self-upgrade to the latest release
jeikcode update
```

---

## ⚡ Why JeikCode? (Core Highlights)

JeikCode is engineered from the ground up in native Rust to solve token inflation, context drift, and brittle tool failures:

1. 🔥 **Terrifying 98–99% KV-Cache Hit Rate**
   - **Strict Append-Only Tail Discipline**: System prompt, memory, and project rules maintain byte-exact immutability at the header; dynamic templates wrap only the user's active turn (`user-wrap.md`). This eliminates cache thrashing and **slashes inference costs and latency**.
   - **Hot-Reloadable Rules**: Prompts and rules hot-reload on save without restarting.

2. 🗺️ **Native Code Graph (CodeExplore)**
   - Features weighted AST syntax trees combined with bilingual semantic lexical graphs. Query by **natural business logic** (e.g. *"Find where refund callback verifies signatures"*).
   - **60%–70% faster** than brute-force text grep, achieving **90%+ retrieval accuracy** in complex codebases.

3. 🔌 **Quad-Protocol Native Compatibility**
   - Natively connects to **OpenAI Chat Completions**, **OpenAI Responses (`/v1/responses`)**, **Anthropic Messages**, and **Google Gemini**.
   - Swap model providers seamlessly with zero workflow changes.

4. 🩸 **Extreme Tool Self-Healing**
   - **5-Stage Error Rescue**: Automatically repairs malformed JSON, coerces misaligned types (e.g. `"5"` to `5`), and sanitizes Windows single-backslash paths before deserialization.
   - **Atomic Multi-Hunk Rewriting**: Multi-edit files execute via WAR topological sorting with 3-Way automatic rebase, preventing broken file writes or tool death loops.

---

## 💻 Common Shortcuts & Commands

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

### Common Slash Commands

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
