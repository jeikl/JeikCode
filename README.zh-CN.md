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

### v7.2.0 (2026-10-08)

- **[核心工具体系大精简与鲁棒性全面加固] 工具链收敛规范化、全能 `read` 与高级 `grep`、确定性命令执行与大模型 Glob 模式高容错适配**：
  - 彻底淘汰废弃旧式独立的 `codeintel::repo_map` 模块，将大范围安全读文件、目录树探查、多模态图片阅读全量收敛至 `read` 工具，新增 `key_string` 关键字居中匹配与上下文透视，输出格式全面对齐纯文本；
  - `grep` 工具全面增强多模式输出（`content`、`files_with_matches`、`count`）与独立上下文行控制；`glob` 工具自动剥离 `./` 前缀并规范化 Windows 斜杠；
  - `run_command` 彻底废除不可靠的启发式 Shell 猜测，改为确定性分层路由，原生支持 PowerShell 与带进程宽限期的 MSYS2/Bash 执行；升级多字段与层级结构化参数校验。
- **[系统提示词与 Agent 工作流纪律] 全新优化核心提示词、强化执行纪律、无依赖全并发调度与激进式上下文读取策略**：
  - 全面升级 `rules.yaml` 与 `system.yaml` 基础提示词体系，确立严格的任务范围意识（Task Scope Awareness）、原子化提交与清单闭环原则；
  - 多轮推理与工具调用链路全面优化，支持在无数据依赖时全并发发射独立工具调用，大幅削减等待时延；
  - 确立大范围安全读取标准（Read Generously），单次调用鼓励阅读数百行乃至全量文件，快速构建完整代码认知全局图景，杜绝盲目小步试探；加固飞行中转向（Steer）平滑插队规范。
- **[代码智能与图谱引擎] 多语言生态源码资产保护、MSBuild 构建产物精准剪枝与自适应索引引导**：
  - 解绑粗暴拦截裸 `bin/` 的规则，完整放行 Rust crate（`src/bin/*.rs`）、Ruby（`bin/rails`）和 Node（`bin/cli.js`）等生态可执行源码；
  - MSBuild 产物依据路径上下文精准剪枝（`Debug`/`Release` 位于 `bin/` 或 `obj/` 下），解禁 ASP.NET `wwwroot` 静态资产并保留手写 `AssemblyInfo.cs`；
  - 原生扩充全生态构建忽略规则库（.NET SDK、Elixir、Flutter、Zig、Haskell、Swift、虚幻引擎、Unity 等），支持单仓免配置自适应索引与规则差异比对。
- **[WebUI 颜值重构与极简美学] 灵感源自 Gemini 的高级炭灰调色板、单行输入框、交互式 Mermaid 图表与 VSCode 风格 Git 检视器**：
  - 全新重构界面调色板，默认启用沉浸护眼的高级炭灰深色美学；极简 Composer 重构为流线型单行胶囊设计并搭载绿色闪电 Token 动态徽标；
  - 对话流原生支持交互式 Mermaid 图表渲染；Git 面板新增 VSCode 风格 Commit 悬停详情卡片、响应式 Git Graph 与紧凑菜单；修复嵌套 Markdown 代码块碎裂渲染故障。
- **[移动端深度优化与触控体验飞跃] 顶栏自适应收纳排布、输入键盘平滑贴合、移动端专属审批停靠坞与断线韧性重连**：
  - 小屏幕顶栏自动收纳折叠，移动端虚拟键盘支持平滑贴合与回车默认换行；新增移动端专属吸底审批停靠坞（Approval Dock），杜绝误触；
  - 深度加固移动端断线韧性重连（Mobile Reconnect），后台切回或网络恢复时无感重新同步；消除消息生成重绘导致的气泡跳变与位移。
- **[远程浏览器体验与多端工作区项目同步] 远程环境内置网页目录选择器、跨端项目侧边栏同步与 Windows 驱动级路径规范化**：
  - 远程浏览器访问自动切为内置网页目录浏览器，彻底解决远程触发服务端不可见原生弹窗导致卡死的顽疾；
  - 侧边栏项目隐藏/移除加入安全二次确认，绝对不删磁盘会话；`GET/POST /projects/sidebar` 实现多设备、多标签页置顶与隐藏状态双向实时同步，运行中项目智能自动拉回；剥离 Windows `\\?\` 等驱动级前缀。
- **[会话流架构收敛与守护进程鲁棒性防线] 会话直连开箱即用、废弃冗余同步流、审批流精准关联与磁盘日志配额治理**：
  - TUI `/webui` 直开携带当前活跃会话短 ID 锚定；彻底移除废弃的 `/sync` 双流机制，统一收敛至高性能 `/chat` 与 `/chat/watch` 画布 SSE 流；
  - 审批权限精准关联并实现首击即消，杜绝切会话触发的重复审批通知；强化沙箱与路径安全边界；默认禁用冗余数据日志并施加磁盘硬配额治理。
- **[官方文档、CI/CD 与工程规范全方位升级] 官网结构与导航焕新、桌面端跨平台打包加固与严密类型门禁**：
  - 官网侧边栏将内置工具提升至顶层首位；修复 Ubuntu 22.04 / 24.04 Linux 桌面端打包兼容性；将 `tsc --noEmit` 固化为 WebUI 构建前置门禁；引入规范化 PR 模板与严密分支协作规范。

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

## ☕ 赞助与支持 (Support & Sponsor)

如果您觉得 JeikCode 为您的工程研发带来了切实的效率提升，欢迎请作者喝一杯咖啡，支持项目的持续演进与开源建设！

<p align="left">
  <img src="./assets/jeikpaypal.jpg" width="220" alt="PayPal Sponsor QR Code" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" />
</p>

---

## 📄 License / 开源许可证

本项目遵循 **JeikCode 非商业性使用与署名开源协议（基于 CC BY-NC 4.0 适配）** 开源，详情请参阅 [LICENSE](./LICENSE)：

1. **严格禁止商用**：未经原作者显式书面许可与正式商业授权，严禁任何个人或机构将本软件（含源码与二进制）全部或部分用于商业营利目的、收费产品集成、闭源销售或作为 SaaS/云端增值服务提供；
2. **强制署名与注明出处**：任何基于本项目的二次修改（二改）、派生版本、代码合并或公开部署使用，**必须在界面显著位置（如欢迎页、关于界面、文档）完整保留原作者版权声明、项目名称（JeikCode）及官方开源仓库地址（`https://github.com/jeikl/JeikCode`）**；
3. **商业授权与合作**：如需将本软件用于商业环境、企业系统集成或商业合作，请通过官方开源仓库联系作者获得正式书面授权。
