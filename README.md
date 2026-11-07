<div align="center">
  <img src="./assets/jeikcode-logo.svg" alt="JeikCode Logo" width="120" />
  <h1>JeikCode: Native Code Graph · Extreme KV-Cache · Cross-Platform All-in-One Agent (TUI / WebUI / Desktop)</h1>
  <p><strong>Native Code Graph · 98–99% KV-Cache · Cross-Platform All-in-One Agent (TUI, WebUI, Desktop) · Self-Healing</strong></p>
  <p>
    <em>Next-generation autonomous AI coding agent purpose-built for complex production engineering — eliminating context bloat, broken tool loops, and cache thrashing.</em>
  </p>
  <p>
    <strong>English (Default)</strong> · <a href="./README.zh-CN.md"><strong>简体中文</strong></a> · <a href="./README.zh-TW.md"><strong>繁體中文</strong></a> · <a href="./README.ja.md"><strong>日本語</strong></a> · <a href="./README.ko.md"><strong>한국어</strong></a> · <a href="./README.ru.md"><strong>Русский</strong></a> · <a href="./README.fr.md"><strong>Français</strong></a> · <a href="./README.es.md"><strong>Español</strong></a> · <a href="./README.de.md"><strong>Deutsch</strong></a> · <a href="./README.ar.md"><strong>العربية</strong></a> · <a href="./README.vi.md"><strong>Tiếng Việt</strong></a>
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

---

## 📌 What is JeikCode?

**JeikCode** is a next-generation, cross-platform, full-featured open-source AI Coding Agent built natively in pure **Rust**. Designed specifically for high-complexity production software engineering, it delivers extreme lightweight speed, complete control, and end-to-end multi-device workflows:

- 🔍 **Semantic CodeGraph (CodeExplore)**: Powered by Tree-Sitter across 12+ programming languages. Seamlessly integrates domain bilingual thesauruses (`thesaurus`) to query code using everyday business natural language, backed by 1~3ms zero-touch incremental patching;
- 🛡️ **98–99% KV-Cache Protection (Sacred Floor)**: Enforces strict append-only byte immutability and memory preservation (`sacred_floor`), keeping system prefixes frozen across turns. Completely eliminates cache thrashing, slash token expenses by over 90%, and compresses TTFT to milliseconds;
- ⚡ **9k Minimal Prompts & High Discipline**: Avoids 30–50k token system bloat. A standard greeting turn consumes only ~9–11k tokens, reserving the maximum context window strictly for your codebase. Fully open-source and live-reloadable;
- 📱 **Omni-Platform Workflows & Unified Agent**: Full coverage across terminal TUI, modern WebUI, Tauri desktop apps, background daemons, and OpenWrt routers/gateways. Runs seamlessly across Windows, macOS, Linux (x86/ARM), and OpenWrt (iStoreOS/ImmortalWrt/Kwrt/LEDE) with a unified mental model and coherent cross-platform experience;
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

> 🍎 **macOS: Fix for "JeikCode Desktop.app is damaged and cannot be opened"**:  
> Drag the app into `/Applications`, then open Terminal and run:  
> `xattr -cr "/Applications/JeikCode Desktop.app"`

### 2. Official Terminal One-Liner (CLI)

```bash
# Linux / macOS / OpenWrt
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

---

## 💡 Quick Start

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

---

## 📝 Changelog

> For the full release history, see [CHANGELOG.md](./CHANGELOG.md) and [GitHub Releases](https://github.com/jeikl/JeikCode/releases).

---

## ☕ Support & Sponsor

If you find JeikCode valuable for your software engineering workflow, feel free to support the ongoing development and open-source maintenance!

<div align="center">
  <img src="./assets/jeikpaypal.jpg" width="220" alt="PayPal Sponsor QR Code" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" />
</div>

---

## 📄 License

This project is licensed under the **JeikCode Non-Commercial & Attribution License (Adapted from CC BY-NC 4.0)**. See the full [LICENSE](./LICENSE) for details:

1. **Non-Commercial Restriction**: The Software and its derivative works MAY NOT be used, in whole or in part, for any commercial purpose, commercial product integration, monetized services, SaaS hosting, or commercial redistribution without prior written authorization from the author.
2. **Mandatory Attribution**: Any public deployment, distribution, fork, or derivative work MUST prominently retain and display the original copyright notice, the project name (**JeikCode**), author credit, and the official repository URL: `https://github.com/jeikl/JeikCode`.
3. **Commercial Licensing**: For commercial licensing, enterprise integration, or partnership inquiries, please contact the author via the official repository.
