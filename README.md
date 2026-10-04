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
    📖 <strong>Official Documentation & Tutorials Site</strong>: <a href="https://docs.jeikcode.top"><strong>https://docs.jeikcode.top</strong></a><br>
    🌐 <strong>Official Code Repository</strong>: <a href="https://github.com/jeikl/JeikCode">https://github.com/jeikl/JeikCode</a> ·
    <a href="https://github.com/jeikl/JeikCode/releases"><strong>GitHub Releases Download</strong></a>
  </p>
</div>

---

## 📌 What is JeikCode?

**JeikCode** is a next-generation cross-platform autonomous AI coding agent built natively in pure **Rust**. Not just another API wrapper, JeikCode is an industrial-strength agent designed specifically for deep software engineering:

- ⚡ **Native Speed & Minimal Footprint**: Built with an asynchronous Rust core, near-instant startup, and tiny tens-of-megabytes resident memory, free from Electron bloat;
- 🛡️ **98–99% KV-Cache Hit Rate**: Strict Append-Only prefix stability and core memory preservation (`sacred_floor`), drastically slashing token costs while delivering rapid time-to-first-token;
- 🗺️ **Pure Rust Native Code Graph (CodeExplore)**: AST-weighted semantic graph aligned with bilingual thesaurus indexing, querying by business logic up to 70% faster than brute-force grep with 90%+ hit rates;
- 🔄 **Decoupled Providers & Models**: Natively connects to five major wire protocols (`OpenAI Chat`, `OpenAI Responses`, `Anthropic`, `Gemini`, and local `Ollama` streaming), freely mixing credentials and model profiles;
- 🛠️ **Industrial-Grade Self-Healing Toolchains**: 5-tier failure self-healing automatically corrects malformed JSON and Windows path escapes, with atomic multi-file patching and 3-way rebase retries;
- 🌐 **Omni-Platform Interfaces**: Interactive terminal CLI, rich TUI, modern browser WebUI, native desktop app, and long-running background daemon seamlessly interlinked.

---

## 🚀 Downloads & Installation

### 1. Recommended Desktop Installers (GUI + Built-in CLI)

Download the latest prebuilt packages from [GitHub Releases](https://github.com/jeikl/JeikCode/releases):

| Operating System | Recommended Package | Architecture |
| :--- | :--- | :--- |
| **Windows** | [📥 **Download Windows Installer (.exe)**](https://github.com/jeikl/JeikCode/releases/latest) | x64 / arm64 |
| **macOS** | [🍏 **Download macOS Apple Silicon (.dmg)**](https://github.com/jeikl/JeikCode/releases/latest)<br>[🍎 **Download macOS Intel (.dmg)**](https://github.com/jeikl/JeikCode/releases/latest) | arm64 / x64 |
| **Linux** | [🐧 **Download Debian / Ubuntu (.deb)**](https://github.com/jeikl/JeikCode/releases/latest)<br>[📦 **Download Universal AppImage (.AppImage)**](https://github.com/jeikl/JeikCode/releases/latest) | x64 / arm64 |

### 2. One-Line Terminal Installation (CLI)

Run the one-line command for your operating system:

```bash
# Linux / macOS / HarmonyOS PC
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

> **Build from source** (Requires Rust 1.88+):
> ```bash
> cd webui && npm run build && cd ..
> cargo install --path crates/jeikcode-cli --bin jeikcode --locked
> ```

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

- 📖 **Official Documentation Site**: [https://docs.jeikcode.top](https://docs.jeikcode.top)
- 🚀 [Installation & Quickstart Guide](https://docs.jeikcode.top/guide/getting-started)
- ⚙️ [Model Provider Configuration](https://docs.jeikcode.top/guide/login)
- 🔌 [Model Context Protocol (MCP) Integration](https://docs.jeikcode.top/advanced/mcp)
- 🧩 [Agent Skills System](https://docs.jeikcode.top/advanced/skills)
- 🖥️ [WebUI, Desktop App & Background Daemon](https://docs.jeikcode.top/deploy/daemon)
- 📝 [Full Changelog & Releases History](https://github.com/jeikl/JeikCode/releases)

---

## 📝 Changelog

> Only showing the latest 2 releases. For the full release history, see [CHANGELOG.md](./CHANGELOG.md) and [GitHub Releases](https://github.com/jeikl/JeikCode/releases).

### v7.1.46 (2026-10-04)

- **[Temporary remote access stays reachable and editable] Applying `0.0.0.0` no longer leaves a localhost-only link or a stuck green control**:
  - **Share URLs use interface IPv4 addresses**: A wildcard bind no longer advertises `127.0.0.1`. IPv4 `0.0.0.0` and IPv6 listen on separate sockets so Windows does not let the dual-stack socket hide external IPv4.
  - **Windows inbound rule**: The panel checks for an allow rule named `JeikCode` on the running executable and asks once when it is missing. The desktop app starts on loopback, so that prompt appears when temporary access is applied.
  - **Apply can be used again**: The same host and port only update the token, and the status lock is released first. A failed port change keeps the listener that is still open. Close stays available while Apply is in flight, and a request older than 12 seconds is reconciled with the server.

- **[Session switch and notification click] Switching away no longer drops an answer that has not hit disk, and a toast click no longer flashes a console**:
  - A running session stays on `/chat/watch`. Windows `jeikcode-focus:` starts through a hidden `wscript` host and prefers the desktop window. Open pages follow a monotonic version so one click is delivered to each of them.

### v7.1.45 (2026-10-04)

- **[Temporary Remote Access & Security Governance] Eliminated temporary remote access token bypass and LAN connection failures, fully supporting dual-stack binding and dynamic atomic token protection**:
  - **Dynamic Atomic Token Enforcement**: Upgraded `AppState.enforce_token` to dynamic atomic `Arc<AtomicBool>` control to prevent token bypass when the daemon starts without credentials, strictly returning 401 Unauthorized for unauthenticated requests when remote access is active;
  - **Dual-Stack Listener & CORS Bypass**: Completed IPv6 `[::]:port` dual-stack binding in `crates/jeikcode-daemon/src/api_config.rs` and relaxed CORS restrictions for direct client host and global IPv6 traffic, enabling smooth LAN cross-device access;
  - **State Persistence & Full URL Echo**: Eliminated `already` state deadlocks and persisted active tokens in `ExtraRemoteBind`, guaranteeing that generated URLs 100% retain `?token=...` query parameters.

- **[Cross-Platform Desktop Notification Refactoring & Interactive Actions] Eliminated duplicate toast overlap and window flickering/resizing, enabling native interactive notifications and one-click approvals**:
  - **Single Notification Channel Convergence**: Removed redundant in-browser Web Notifications, unifying on OS-native notifications (Windows Toast / macOS UserNotifications / Linux notify-send) to eliminate overlapping duplicate cards;
  - **Windows WinRT Toast Interactive Action Buttons**: Enhanced Toast XML templates to inject native `[ Approve ]` and `[ Deny ]` buttons on tool approval prompts (`permission_request`), allowing instant approvals directly from the notification; added `[ Answer / 作答 ]` action button on agent question prompts (`request_user_input`);
  - **Win32 Window Foreground Activation & Size Protection (ForceActivate)**: Overhauled `notify-focus.ps1` with Alt-key simulation to suspend Windows `ForegroundLockTimeout` and used `AttachThreadInput` + `SwitchToThisWindow` for 100% reliable focus activation; avoided calling ShowWindow when not minimized to eliminate flickering and protect maximized/Aero Snap layout dimensions;
  - **Full macOS & Linux Notification & Navigation Support**: Added action segment parsing in `notify-focus.sh`, supporting Approve/Deny actions via `notify-send -A` on Linux, and native `UNUserNotificationCenter` toasts with lossless window focusing on macOS.

---

## 📄 License

This project is licensed under the **JeikCode Non-Commercial & Attribution License (Adapted from CC BY-NC 4.0)**. See the full [LICENSE](./LICENSE) for details:

1. **Non-Commercial Restriction**: The Software and its derivative works MAY NOT be used, in whole or in part, for any commercial purpose, commercial product integration, monetized services, SaaS hosting, or commercial redistribution without prior written authorization from the author.
2. **Mandatory Attribution**: Any public deployment, distribution, fork, or derivative work MUST prominently retain and display the original copyright notice, the project name (**JeikCode**), author credit, and the official repository URL: `https://github.com/jeikl/JeikCode`.
3. **Commercial Licensing**: For commercial licensing, enterprise integration, or partnership inquiries, please contact the author via the official repository.
