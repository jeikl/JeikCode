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
    📖 <strong>官方使用教程与文档站点</strong>：<a href="https://docs.jeikcode.top"><strong>https://docs.jeikcode.top</strong></a><br>
    🌐 <strong>官方代码仓库</strong>：<a href="https://github.com/jeikl/JeikCode">https://github.com/jeikl/JeikCode</a> ·
    <a href="https://github.com/jeikl/JeikCode/releases"><strong>GitHub Releases 下载</strong></a>
  </p>
</div>

---

## 📌 什么是 JeikCode？

**JeikCode** 是一款采用纯 **Rust** 原生打造的新一代跨平台自主 AI 编程智能体。它不是简单的 API 包装壳，而是专为深度软件工程设计的生产级 Agent：

- ⚡ **原生极速与极低资源占用**：底层纯 Rust 异步运行时，秒级启动，常驻内存仅数十 MB，告别 Electron 沉重卡顿；
- 🛡️ **98–99% KV-Cache 命中率**：严格 Append-Only 前缀保护与核心记忆防丢（`sacred_floor`），大幅降低长会话 Token 成本，首字极速吐出；
- 🗺️ **纯 Rust 自研代码语义图谱 (CodeExplore)**：AST 深度加权匹配双语领域词林，以业务逻辑精准检索全局代码，比传统暴力 grep 快 70%，复杂代码定位命中率 90%+；
- 🔄 **协议与模型解耦**：原生直通五大协议（`OpenAI Chat`、`OpenAI Responses`、`Anthropic`、`Gemini`、`Ollama` 本地私有流式），账号凭据与模型自由组合；
- 🛠️ **工业级容灾与工具自愈**：5 级容灾自愈链，智能修复畸形 JSON 与路径转义，文件多点改写采用原子落盘与 3-Way 自动变基；
- 🌐 **全平台形态一网打尽**：终端 CLI、富交互 TUI、现代化浏览器 WebUI、桌面端应用及长驻 Daemon 守护进程无缝联动。

---

## 🚀 安装与下载 (Downloads)

### 1. 桌面端推荐安装包（图形界面 + 内置 CLI）

可在 [GitHub Releases](https://github.com/jeikl/JeikCode/releases) 下载最新发行版：

| 操作系统 | 推荐安装包 | 架构支持 |
| :--- | :--- | :--- |
| **Windows** | [📥 **下载 Windows 安装包 (.exe)**](https://github.com/jeikl/JeikCode/releases/latest) | x64 / arm64 |
| **macOS** | [🍏 **下载 macOS Apple Silicon (.dmg)**](https://github.com/jeikl/JeikCode/releases/latest)<br>[🍎 **下载 macOS Intel (.dmg)**](https://github.com/jeikl/JeikCode/releases/latest) | arm64 / x64 |
| **Linux** | [🐧 **下载 Debian / Ubuntu (.deb)**](https://github.com/jeikl/JeikCode/releases/latest)<br>[📦 **下载通用 AppImage (.AppImage)**](https://github.com/jeikl/JeikCode/releases/latest) | x64 / arm64 |

### 2. 终端一键安装 (CLI)

在终端中执行对应系统的官方一键安装脚本：

```bash
# Linux / macOS / HarmonyOS PC
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

> **源码编译安装**（需 Rust 1.88+）：
> ```bash
> cd webui && npm run build && cd ..
> cargo install --path crates/jeikcode-cli --bin jeikcode --locked
> ```

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

- 📖 **官方文档站点**：[https://docs.jeikcode.top](https://docs.jeikcode.top)
- 🚀 [快速安装与起步指南](https://docs.jeikcode.top/zh/guide/getting-started)
- ⚙️ [模型接入与配置指南](https://docs.jeikcode.top/zh/guide/login)
- 🔌 [Model Context Protocol (MCP) 扩展接入](https://docs.jeikcode.top/zh/advanced/mcp)
- 🧩 [Agent Skills 技能系统开发](https://docs.jeikcode.top/zh/advanced/skills)
- 🖥️ [WebUI、桌面端与长驻后台 Daemon 部署](https://docs.jeikcode.top/zh/deploy/daemon)
- 📝 [更新日志完整历史 (Changelog)](https://github.com/jeikl/JeikCode/releases)

---

## 📝 更新日志 (Changelog)

> 仅展示最近 2 个版本更新，完整历史请参阅 [CHANGELOG.md](./CHANGELOG.md) 与 [GitHub Releases](https://github.com/jeikl/JeikCode/releases)。

### v7.1.45 (2026-10-04)

- **[临时远程访问与安全鉴权深度治理] 彻底根除 WebUI 临时远程监听鉴权失效与局域网不可达缺陷，全面支持双栈绑定与动态原子 Token 保护**：
  - **动态原子鉴权开关与 Token 强制执行**：针对守护进程以免鉴权模式启动后 `enforce_token` 静态写死导致临时暴露局域网时鉴权失效漏洞，升级为 `Arc<AtomicBool>` 动态原子控制，并在开启临时远程访问时即时激活 Token 强校验，坚决拦截无凭证请求返回 401 Unauthorized；
  - **全链路双栈监听与 CORS 放行修复**：在 `crates/jeikcode-daemon/src/api_config.rs` 中补齐 IPv6 `[::]:port` 双栈监听与多任务管理，并在 `is_allowed_cors_origin` 中放宽对客户端直连 Host 与公网双栈 IPv6 的校验，彻底打通局域网跨设备直连；
  - **状态持久化与 URL 完整回显**：解除了 `already` 状态死锁判定，持久化记录当前绑定的活跃 Token，保证状态接口生成的访问链接 100% 完整携带 `?token=...`，支持随时热更新参数。

- **[跨平台桌面通知体系全面重构与交互动作升级] 消除双重通知重叠与窗口闪烁缩放顽疾，打通 Windows/macOS/Linux 原生交互通知与一键审批**：
  - **单通道通知收敛与消除双重重叠**：完全移除 Web 前端重复触发的浏览器内置 Web Notification，统一收敛至操作系统原生桌面通知（Windows Toast / macOS UserNotifications / Linux notify-send），彻底解决右下角多弹窗叠层遮挡问题；
  - **Windows WinRT Toast 原生交互按钮支持**：升级 Toast XML 模板，当触发工具审批（`permission_request`）时原生注入 `[ Approve ]` 与 `[ Deny ]` 操作按钮，用户无需切换前台窗口即可在 Windows 屏幕右下角点击按钮秒级完成权限审批；提问（`request_user_input`）通知自动注入 `[ Answer / 作答 ]` 快捷按钮直达问题；
  - **Win32 窗口前台穿透激活与尺寸保护 (ForceActivate)**：彻底重构 `notify-focus.ps1` 窗口聚焦脚本，引入 Alt 键微秒级按键事件挂起 Windows 内核的 `ForegroundLockTimeout` 超时限制，结合 `AttachThreadInput` 与 `SwitchToThisWindow` 实现 100% 稳定置顶前台激活；未最小化时绝不调用 ShowWindow，彻底消除多次重绘引起的闪烁，100% 保护最大化与 Windows 11 Aero Snap 贴靠尺寸不缩水；
  - **macOS 与 Linux 提问与审批通知全支持**：在 `notify-focus.sh` 脚本中增加动作解析，Linux 下通过 `notify-send -A` 原生支持 Approve/Deny 按钮点击提交，macOS 下原生调用 `UNUserNotificationCenter` 弹窗提醒，点击秒级无损激活置顶前台会话。

### v7.1.44 (2026-10-04)

- **[Windows 桌面 Toast 通知协议唤醒与焦点穿透 (Windows Toast Protocol Activation & Session Focus)] 攻克 WinRT 原生通知点击无法唤醒应用与会话定位问题，建立完整系统 Protocol Scheme 与守护进程鉴权通知总线**：
  - **WinRT Toast 注册 AUMID 方案重构与 Banner 显示修复**：排除无响应的未注册裸 `JeikCode` AUMID，优先使用标准 Windows PowerShell AUMID (`{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`) 触发 Toast 弹窗，根除 `Show()` 假成功但不弹出横幅通知缺陷；Toast 悬留时间延长至 `duration="long"`，并完善 XML 实体转义机制；
  - **注册 Windows 自定义 URI 协议 (`jeikcode-focus:`)**：自动注册 `HKCU\Software\Classes\jeikcode-focus` 协议，动态生成 `~/.jeikcode/notify-focus.ps1` 唤醒脚本；点击 Toast 通知时通过 Win32 API (`SetForegroundWindow`/`ShowWindow`/`BringWindowToTop`) 将最小化或后台的 JeikCode 窗口平滑置顶；
  - **守护进程安全通知通道与会话跳转**：新增 `/notify-focus` POST/GET 端点，基于 32 位 Hex 进程安全秘钥防护攻击；前端 `webui/src/api.ts` 与 `app.tsx` 引入轻量轮询探针，接收点击回调时自动触发 `jeikcode:focus-session` 全局事件并精准无缝跳转至对应会话；
  - **全量 OS 通知响应策略**：将 `shouldOsNotifyTerminal` 优化为全量触发模式，保证无论前后台状态，回合完成时系统通知中心均能准确捕获，实现无遗漏的离线完成追溯。

---

## 📄 License / 开源许可证

本项目遵循 **JeikCode 非商业性使用与署名开源协议（基于 CC BY-NC 4.0 适配）** 开源，详情请参阅 [LICENSE](./LICENSE)：

1. **严格禁止商用**：未经原作者显式书面许可与正式商业授权，严禁任何个人或机构将本软件（含源码与二进制）全部或部分用于商业营利目的、收费产品集成、闭源销售或作为 SaaS/云端增值服务提供；
2. **强制署名与注明出处**：任何基于本项目的二次修改（二改）、派生版本、代码合并或公开部署使用，**必须在界面显著位置（如欢迎页、关于界面、文档）完整保留原作者版权声明、项目名称（JeikCode）及官方开源仓库地址（`https://github.com/jeikl/JeikCode`）**；
3. **商业授权与合作**：如需将本软件用于商业环境、企业系统集成或商业合作，请通过官方开源仓库联系作者获得正式书面授权。
