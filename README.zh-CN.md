<div align="center">
  <img src="./assets/jeikcode-logo.svg" alt="JeikCode Logo" width="120" />
  <h1>JeikCode: 原生代码图谱 · 极致缓存 · 跨平台全能型 Agent（TUI / WebUI / 桌面）</h1>
  <p><strong>原生代码图谱 · 98–99% 极致缓存 · 跨平台全能型 Agent (TUI / WebUI / Desktop) · 自主开源 · 极速自愈</strong></p>
  <p>
    <em>专为大型复杂工程打造的新一代自主编程智能体，告别可配置性差、上下文臃肿、工具报错与缓存雪崩。</em>
  </p>
  <p>
    <a href="./README.md"><strong>English (Default)</strong></a> · <strong>简体中文</strong>
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

> 🌟 **欢迎关注与 Star 支持**：如果您觉得 JeikCode 有用，请顺手在 [GitHub](https://github.com/jeikl/JeikCode) 点亮右上角的一颗 **Star ⭐**！官方在线教程现已正式解析上线：👉 **[https://jeikcode.top](https://jeikcode.top)**

---

## 📌 什么是 JeikCode？

**JeikCode** 是一款采用纯 **Rust** 原生打造的新一代跨平台全功能开源 AI 编程智能体（AI Coding Agent）。它专为应对高复杂度生产工程交付而生，具备极致轻量、高可控与端到端协同能力：

- 🔍 **语义代码图谱 (CodeExplore)**：深度内置 Tree-Sitter 原生支持 12+ 种主流语言。融合领域双语词林（`thesaurus`），支持用业务大白话直接提问全局代码与上下游调用链路，1~3ms 极速无感增量差量更新；
- 🛡️ **98–99% 极致缓存 (KV-Cache)**：基于严格 Append-Only 字节级不可变性与圣地地基设计（`sacred_floor`），首部系统提示词永久固化，彻底杜绝缓存雪崩（Cache Thrashing），API 调用成本降低 90%+，毫秒级首字极速吐出；
- ⚡ **9k 极简提示词与严苛纪律**：拒绝 30~50k 臃肿系统开销，单次起手仅占约 9~11k Token，将绝大部分宝贵上下文留给代码；全面开源，规则修改热重载即刻生效；
- 📱 **全场景协同与移动端适配**：终端 TUI、现代 WebUI、Tauri 桌面端与后台 Daemon 全覆盖。WebUI 深度定制手机与平板触控界面，出门在外随时随地随身编程；
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

### 2. 官方终端一键安装脚本 (CLI)

```bash
# Linux / macOS 终端执行
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | bash
```

```powershell
# Windows (PowerShell) 执行
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

> 💡 **更多高级安装与部署（源码编译、无头 Daemon、Docker 容器化等）**：请参阅官方文档站点 👉 **[https://jeikcode.top/zh/guide/installation](https://jeikcode.top/zh/guide/installation)**

---

## 💡 快速上手 (Quick Start)

### 1. 启动体验

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

### 2. 模型配置 (`~/.jeikcode/config.toml`)

首次启动会自动生成配置文件 `~/.jeikcode/config.toml`。你可以使用内置可视化向导或直接配置：

- 终端输入 `/modeladd` 打开可视化交互配置向导；
- **或直接吩咐 JeikCode**：*“帮我配置小米 MiMo API Key (sk-xxxx) 并设为默认模型”*，JeikCode 会自动调用安全配置工具写入并免重启热重载生效！

典型配置示例：

```toml
# 默认激活模型
default_model = "xai/grok-4.7"
language = "zh-CN"

# ── 1. 账号连接定义 (API Key 与 Base URL) ──
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

# ── 2. 模型档案定义 (多档位、深度思考与协议映射) ──
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

## 📚 详细文档与进阶指南

JeikCode 拥有完备的官方在线文档库，覆盖深度架构、实战技巧与生态扩展：

- 📖 **官方文档站点**：[https://jeikcode.top](https://jeikcode.top)
- 🚀 [快速安装与起步指南](https://jeikcode.top/zh/guide/getting-started)
- ⚙️ [模型接入与配置指南](https://jeikcode.top/zh/guide/login)
- 🔌 [Model Context Protocol (MCP) 扩展接入](https://jeikcode.top/zh/advanced/mcp)
- 🧩 [Agent Skills 技能系统开发](https://jeikcode.top/zh/advanced/skills)
- 🖥️ [WebUI、桌面端与长驻后台 Daemon 部署](https://jeikcode.top/zh/deploy/daemon)
- 📝 [更新日志完整历史 (Changelog)](https://github.com/jeikl/JeikCode/releases)

---

## 📝 更新日志 (Changelog)

> 仅展示最近 2 个版本更新，完整历史请参阅 [CHANGELOG.md](./CHANGELOG.md) 与 [GitHub Releases](https://github.com/jeikl/JeikCode/releases)。

### v7.1.53 (2026-10-05)

- **[Beta 通道与预览版本号] 优化预发布检测策略，优先提取 Pre-release 版本号**：
  - 修复 Beta 预览通道取版本时受 SemVer 规则干扰的问题，确保切换到 Beta 通道时准确展示最新预发布版本号。
- **[多媒体图片灯箱] 全屏图片预览新增触控友好关闭按钮 (✕ 按钮)**：
  - 在全屏大图预览右上角增加高层级半透明磨砂关闭按钮，彻底解决手机端点击大图无法退出、桌面端必须按 Esc 的操作局限。
- **[移动端待办收纳与黑屏修复] 粘性待办折叠胶囊化，根除移动端贴边黑屏 Bug**：
  - 待办列表在移动端默认折叠为高度约 30px 的紧凑胶囊条，释放垂直视口；重构移动端侧边栏抽屉与折叠逻辑，彻底杜绝点击贴边图标后抽屉黑屏空白问题。

### v7.1.52 (2026-10-05)

- **[全端响应式基建与移动端设计] 对标主流 Agent (Gemini) 重构全端响应式系统、底抽屉弹窗、底吸附输入框与原生媒体文件上传**：
  - 建立手机 (≤768px)、iPad平板 (769-1024px)、电脑 (>1024px) 全端响应式体系。全域弹窗在移动端自动升维为原生级底部抽屉 (Bottom Sheet)；重构模型配置为自适应流体网格与路径自适应省略；输入框在移动端对标 Gemini 优雅吸底；在输入栏中新增原生媒体与文件上传按钮。
- **[更新通道与弹窗] 新增正式版与预览版双更新通道、交互式弹窗及预发布检测**：
  - 对标 Antigravity-Manager 重构 `UpdateDialog` 更新弹窗，提供正式版 (Stable) 与预览版 (Beta) 切换、本地偏好持久化及即时通道检测。后端升级支持 `channel` 参数与语义化版本比较。
- **[WebUI 会话切换与排队转向] 修复切会话用户消息丢失、两轮 Agent 消息串联，以及排队转向卡片刷新/切换消失问题**：
  - 修正磁盘结算判定，活跃回合严格保护内存缓存；在 `sessionStorage` 中持久化排队转向消息，消除异步转向竞态。

---

## 📄 License / 开源许可证

本项目遵循 **JeikCode 非商业性使用与署名开源协议（基于 CC BY-NC 4.0 适配）** 开源，详情请参阅 [LICENSE](./LICENSE)：

1. **严格禁止商用**：未经原作者显式书面许可与正式商业授权，严禁任何个人或机构将本软件（含源码与二进制）全部或部分用于商业营利目的、收费产品集成、闭源销售或作为 SaaS/云端增值服务提供；
2. **强制署名与注明出处**：任何基于本项目的二次修改（二改）、派生版本、代码合并或公开部署使用，**必须在界面显著位置（如欢迎页、关于界面、文档）完整保留原作者版权声明、项目名称（JeikCode）及官方开源仓库地址（`https://github.com/jeikl/JeikCode`）**；
3. **商业授权与合作**：如需将本软件用于商业环境、企业系统集成或商业合作，请通过官方开源仓库联系作者获得正式书面授权。
