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

### v7.1.49 (2026-10-04)

- **[Desktop model config load] Opening model settings no longer treats an empty 401 as a JSON parse failure**:
  - **The config file is still there**: A missing webui token made `GET /config` return an empty 401. The dialog then showed `Unexpected end of JSON input`.
  - **Show the real reason**: 401 responses now include a JSON error body. The dialog says the access token is missing or invalid and to reopen the desktop app. The token is stored locally; if storage fails, `?token=` stays in the URL.

### v7.1.48 (2026-10-04)

- **[Desktop window opens loopback] Startup no longer points the window at the LAN address, and the WebUI process stays up**:
  - **This computer uses 127.0.0.1**: The desktop still listens on `0.0.0.0`. The window opens `127.0.0.1` on that port and keeps the token. Other devices use the LAN addresses in the top-right panel.
  - **No console does not mean exit**: `jeikcode webui` started by the desktop shell has no console and keeps running until the shell exits. After the launch URL is found, the shell keeps reading its log so closing the pipe does not crash the child.

---

## 📄 License

This project is licensed under the **JeikCode Non-Commercial & Attribution License (Adapted from CC BY-NC 4.0)**. See the full [LICENSE](./LICENSE) for details:

1. **Non-Commercial Restriction**: The Software and its derivative works MAY NOT be used, in whole or in part, for any commercial purpose, commercial product integration, monetized services, SaaS hosting, or commercial redistribution without prior written authorization from the author.
2. **Mandatory Attribution**: Any public deployment, distribution, fork, or derivative work MUST prominently retain and display the original copyright notice, the project name (**JeikCode**), author credit, and the official repository URL: `https://github.com/jeikl/JeikCode`.
3. **Commercial Licensing**: For commercial licensing, enterprise integration, or partnership inquiries, please contact the author via the official repository.
