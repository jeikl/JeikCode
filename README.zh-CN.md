<div align="center">
  <img src="./assets/jeikcode-logo.svg" alt="JeikCode Logo" width="120" />
  <h1>JeikCode: 原生代码图谱 · 极致缓存 · 跨平台全能型 Agent（TUI / WebUI / 桌面）</h1>
  <p><strong>原生代码图谱 · 98–99% 极致缓存 · 跨平台全能型 Agent (TUI / WebUI / Desktop) · 自主开源 · 极速自愈</strong></p>
  <p>
    <em>专为大型复杂工程打造的新一代自主编程智能体，告别可配置性差、上下文臃肿、工具报错与缓存雪崩。</em>
  </p>
  <p>
    <a href="./README.md"><strong>English (Default)</strong></a> · <strong>简体中文</strong> · <a href="./README.zh-TW.md"><strong>繁體中文</strong></a> · <a href="./README.ja.md"><strong>日本語</strong></a> · <a href="./README.ko.md"><strong>한국어</strong></a> · <a href="./README.ru.md"><strong>Русский</strong></a> · <a href="./README.fr.md"><strong>Français</strong></a> · <a href="./README.es.md"><strong>Español</strong></a> · <a href="./README.de.md"><strong>Deutsch</strong></a> · <a href="./README.ar.md"><strong>العربية</strong></a> · <a href="./README.vi.md"><strong>Tiếng Việt</strong></a>
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
      <img src="https://img.shields.io/badge/📖_官方使用教程文档-jeikcode.top-0284c7?style=for-the-badge" alt="Docs">
    </a>
    <a href="https://github.com/jeikl/JeikCode">
      <img src="https://img.shields.io/badge/⭐_GitHub_源码仓库-点个Star支持-2563eb?style=for-the-badge&logo=github&logoColor=white" alt="GitHub Repo">
    </a>
    <a href="https://github.com/jeikl/JeikCode/releases">
      <img src="https://img.shields.io/badge/📥_客户端下载-Releases-0ea5e9?style=for-the-badge" alt="Releases">
    </a>
  </p>
  <p>
    🌐 <strong>官方文档直达</strong>：<a href="https://jeikcode.top"><strong>https://jeikcode.top</strong></a> · 
    ⭐ <strong>代码仓库</strong>：<a href="https://github.com/jeikl/JeikCode"><strong>https://github.com/jeikl/JeikCode</strong></a>
  </p>
</div>

---

## 📌 什么是 JeikCode？

**JeikCode** 是一款采用纯 **Rust** 原生打造的新一代跨平台全功能开源 AI 编程智能体（AI Coding Agent）。它专为应对高复杂度生产工程交付而生，具备极致轻量、高可控与端到端协同能力：

- 🔍 **语义代码图谱 (CodeExplore)**：深度内置 Tree-Sitter 原生支持 12+ 种主流语言。融合领域双语词林（`thesaurus`），支持用业务大白话直接提问全局代码与上下游调用链路，1~3ms 极速无感增量差量更新；
- 🛡️ **98–99% 极致缓存 (KV-Cache)**：基于严格 Append-Only 字节级不可变性与圣地地基设计（`sacred_floor`），首部系统提示词永久固化，彻底杜绝缓存雪崩（Cache Thrashing），API 调用成本降低 90%+，毫秒级首字极速吐出；
- ⚡ **9k 极简提示词与严苛纪律**：拒绝 30~50k 臃肿系统开销，单次起手仅占约 9~11k Token，将绝大部分宝贵上下文留给代码；全面开源，规则修改热重载即刻生效；
- 📱 **全场景协同与全平台统一 Agent**：终端 TUI、现代 WebUI、Tauri 桌面端、后台 Daemon 以及 OpenWrt 软路由/网关全覆盖。无缝在 Windows、macOS、Linux（x86/ARM）与 OpenWrt 软路由环境部署运行，统一架构、同一智能体心智与全端一致体验；
- 🔒 **类 Git 状态机并发原子保护**：多文件大范围并发编辑严格原子性保护防脏写，强模型与弱模型均能稳定执行，支持一键 Undo 历史检查点回滚；
- 🔄 **原生五大协议全栈兼容**：原生自适应支持 `OpenAI Chat`、`OpenAI Responses`、`Anthropic Claude`、`Google Gemini` 与 `Ollama` 格式，账号凭据与模型配置彻底解耦；
- 🧩 **开放生态与第三方兼容端点**：服务端暴露标准 OpenAI/Claude/Gemini API 端点，外部第三方工具、翻译插件或 OpenClaw 等 Agent 框架可直接无缝接入；
- 🚀 **高频迭代与社区敏捷审批**：社区 Issue 和 PR 保持极高频审核与合入，快速发布 Beta 测试版本验证，真诚拥抱开源共创。

---

## 🚀 安装与起步 (Installation)

### 1. 桌面客户端安装包（首选推荐）

开箱即用的跨平台桌面应用（内嵌 WebUI，并自动将 `jeikcode` CLI 写入系统路径）：

| 操作系统 / 芯片架构 | 推荐安装包 | 说明 |
| :--- | :--- | :--- |
| **Windows** (64-bit) | [📥 **下载 Windows 安装程序 (.exe)**](https://github.com/jeikl/JeikCode/releases/latest) | 带有图形向导安装包 |
| **macOS** (Apple Silicon / Intel) | [🍏 **下载 macOS 安装包 (.dmg)**](https://github.com/jeikl/JeikCode/releases/latest) | 原生支持 M1~M4 及 Intel |
| **Linux** (Debian / Ubuntu / 通用) | [🐧 **下载 Linux 安装包 (.deb / .AppImage)**](https://github.com/jeikl/JeikCode/releases/latest) | 通用独立运行包 |

> 🍎 **macOS 提示“已损坏，无法打开”的解决方法**：  
> 将应用拖入 `/Applications`（应用程序）文件夹后，打开终端运行：  
> `xattr -cr "/Applications/JeikCode Desktop.app"` 即可正常使用。

### 2. 官方终端一键安装脚本 (CLI)

```bash
# Linux / macOS / OpenWrt 终端执行
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | sh
```

```powershell
# Windows (PowerShell) 执行
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

---

## 💡 快速上手 (Quick Start)

进入任意代码工程目录直接启动：

```bash
cd /path/to/your/project
jeikcode
```

常用 CLI 选项：
```bash
# 指定工程目录启动
jeikcode -C /path/to/project

# 启动并在浏览器打开现代 WebUI 界面
jeikcode webui

# 持续对话，恢复上一轮会话
jeikcode -c

# 无头自动化批量执行任务（适合 CI/CD 与脚本排障）
jeikcode -p "排查并修复 OAuth 回调 404 错误"

# 一键平滑升级至最新版本
jeikcode update
```

---

## 📝 更新日志 (Changelog)

> 完整历史请参阅 [CHANGELOG.md](./CHANGELOG.md) 与 [GitHub Releases](https://github.com/jeikl/JeikCode/releases)。

---

## ☕ 赞助与支持 (Support & Sponsor)

如果您觉得 JeikCode 为您的工程研发带来了切实的效率提升，欢迎请作者喝一杯咖啡，支持项目的持续演进与开源建设！

<div align="center">
  <img src="./assets/jeikpaypal.jpg" width="220" alt="PayPal Sponsor QR Code" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" />
</div>

---

## 📄 License / 开源许可证

本项目遵循 **JeikCode 非商业性使用与署名开源协议（基于 CC BY-NC 4.0 适配）** 开源，详情请参阅 [LICENSE](./LICENSE)：

1. **严格禁止商用**：未经原作者显式书面许可与正式商业授权，严禁任何个人或机构将本软件（含源码与二进制）全部或部分用于商业营利目的、收费产品集成、闭源销售或作为 SaaS/云端增值服务提供；
2. **强制署名与注明出处**：任何基于本项目的二次修改（二改）、派生版本、代码合并或公开部署使用，**必须在界面显著位置（如欢迎页、关于界面、文档）完整保留原作者版权声明、项目名称（JeikCode）及官方开源仓库地址（`https://github.com/jeikl/JeikCode`）**；
3. **商业授权与合作**：如需将本软件用于商业环境、企业系统集成或商业合作，请通过官方开源仓库联系作者获得正式书面授权。
