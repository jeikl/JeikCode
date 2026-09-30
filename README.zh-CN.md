<div align="center">
  <img src="./assets/jeikcode-logo.svg" alt="JeikCode Logo" width="120" />
  <h1>JeikCode: 极速、自主的终端 AI Coding Agent (Rust 驱动)</h1>
  <p><strong>98–99% KV-Cache 命中 · 自研原生代码图谱 · 五协议原生 · 极致工具自愈 · 高度可定制</strong></p>
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
    🌐 <strong>官方开源仓库</strong>：<a href="https://github.com/jeikl/JeikCode">https://github.com/jeikl/JeikCode</a> ·
    <a href="https://github.com/jeikl/JeikCode/releases"><strong>Releases 下载</strong></a>
  </p>
</div>

---

## 📌 什么是 JeikCode？

**JeikCode** 是一款采用纯 **Rust** 原生打造的新一代跨平台自主 AI 编程智能体。它不是简单的 API 包装壳，而是专为深度软件工程设计的生产级 Agent：它彻底抛弃了市面上诸多工具“协议写死、可配置性差、功能过重、工具调用动辄死循环”的顽疾，提供飞快的执行响应、极低的内存占用、**纯 Rust 原生自研代码语义图谱**与强大的容灾自愈能力，帮助开发者在大型复杂代码库中完成高效自主的代码探索、架构重构与开发排错。

---

## 🚀 快速上手 (Quick Start)

### 1. 一键安装

在终端中执行对应操作系统的官方安装脚本：

```bash
# Linux / macOS / HarmonyOS PC
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

> **源码编译安装**（需 Rust 1.88+）：
> ```bash
> cd webui && npm run build && cd ..
> cargo install --path crates/jeikcode-cli --bin jeikcode --locked
> ```

### 2. 现代多模型前沿配置 (`~/.jeikcode/config.toml`)

首次启动会自动生成 `~/.jeikcode/config.toml`。JeikCode 采用账号凭据（`provider_accounts`）与模型档案（`models`）彻底解耦的高扩展架构，原生全面接入包括 **xAI Grok（Grok 4.7 / 4.5）、Claude（Opus 4.7 / Sonnet 4.6）、Google Gemini（2.5 Pro / Flash）、小米 MiMo（MiMo-V2.6 Pro）、本地私有 Ollama** 等前沿主流模型：

```toml
# 默认激活模型（必须置于文件最顶层）
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

# xAI Grok 4.7 / 4.5 旗舰推理系列 (代码与复杂逻辑之王)
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

# Anthropic Claude Opus 4.7 / Sonnet 4.6 (扩展深度思考)
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

# Google Gemini 2.5 旗舰 (超长 1M+ 上下文 + 原生 Thinking)
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

[models."mimo/v2.6-pro"]
account          = "xiaomi-mimo"
model            = "mimo-v2.6-pro"
reasoning_model  = true
reasoning_effort = "high"

# 本地离线私有大模型 (Ollama 原生流式协议)
[models."ollama/qwen2.5-coder"]
account = "ollama"
model   = "qwen2.5-coder:32b"
```

> 💡 **完全不懂怎么配？直接问 JeikCode 让他帮你配！**  
> JeikCode **原生支持五大主流通信协议接入**（`OpenAI Chat Completions`、`OpenAI Responses (/v1/responses)`、`Anthropic Messages`、`Google Gemini (generateContent)` 与 `Ollama (本地私有流式)`）。  
> 启动 `jeikcode` 后，在终端输入 `/modeladd` 打开可视化交互配置向导；或者**直接在对话里吩咐 JeikCode**：  
> *“帮我把刚申请的小米 MiMo API Key (sk-xxxx) 配置上，并将默认模型设为 mimo-v2.6-pro”*，或者 *“帮我配置 xAI 的 grok-4.7 和 Claude Opus 4.7”*。  
> JeikCode 会自动调用内置安全配置工具精准写入 `config.toml` 并**免重启热重载**立即生效！

### 3. 启动与常用命令

进入任意项目根目录直接启动：

```bash
cd /path/to/your/project
jeikcode
```

常用 CLI 操作命令：
```bash
# 指定项目目录启动
jeikcode -C /path/to/project

# 切换特定模型启动
jeikcode --model xai/grok-3

# 启动 WebUI 浏览器控制台
jeikcode webui

# 持续对话，恢复上一轮会话
jeikcode -c

# 无头自动化任务（适合 CI/CD、脚本调用自动修 Issue）
jeikcode -p "排查并修复 OAuth 回调 404 错误"

# 一键平滑升级到最新版本
jeikcode update
```

---

## 💡 它和主流的 Agent 有啥区别？

市面上现有的开源编程 Agent（如 Claude Code、OpenCode 等）虽然各有亮点，但在真实的工业生产环境中常暴露出明显的短板：**绝大多数是开源但可配置性极差（与单一厂商或专有协议死锁）、云端缓存频繁雪崩导致 Token 费用暴增与速度变慢、代码检索停留在低效的暴力文本 grep、工具链脆弱一报错就死循环、长任务并发支持能力弱**。

JeikCode 深度吸取了生产环境的血泪痛点，并融合了 OpenCode、GrokBuild、Claude Code 等顶尖 Agent 的优秀优点，打造出真正的生产级破局利器：

| 生产痛点维度 | 市面主流开源 Agent 现状 | **JeikCode 的核心破局设计** |
| :--- | :--- | :--- |
| **可配置性与生态适配** | 协议死锁或极难配置，很难自由接入自建中转、本地私有算力或各家新模型 | **原生五协议全兼容 + 高度自定义**：原生直通 `OpenAI Chat`、`OpenAI Responses`、`Anthropic`、`Gemini` 和 `Ollama`，账号凭据与模型档案完全解耦，支持任意中转与私有部署 |
| **Token 成本与推理延迟** | 会话轮次一多前缀被随意改动，导致云端 KV-Cache 频频雪崩击穿，账单失控 | **98–99% KV-Cache 命中率**：严格 Append-Only 尾部动态包裹（`user-wrap.md`）+ `sacred_floor` 核心记忆防丢，会话前缀字节级不可变，省钱 90% 以上且首字飞速吐出 |
| **代码搜索与工程理解** | 依赖粗暴的正则 grep 翻找，或挂载死板硬性的外部 MCP（如 Codegraph） | **纯 Rust 自研原生代码图谱 (CodeExplore)**：加权 AST + 双语语义词林，按业务逻辑自然语言检索，**检索提速 70%，命中率 90%+，大幅超越开源一众 MCP 工具** |
| **工具链执行可靠性** | 模型输出畸形 JSON、参数类型不符或 Windows 反斜杠转义错时直接报错卡死 | **5 级工具自动自愈链**：智能纠偏畸形 JSON、自动强转类型、救活 Windows 路径；同文件多处改写支持 WAR 拓扑原子全成功落盘与 3-Way 自动变基重试 |
| **长驻服务与多端协作** | 多数仅为单体命令行，无法做到长驻后台与随时跨端挂接 | **深度吸纳 OpenCode 优秀优点：支持高并发后台守护（Daemon 模式）与多端即时挂接** |

### 🌟 吸取 OpenCode 优点的后台 Daemon 模式配置教程

JeikCode 吸取了 OpenCode 前后端分离与长驻运行的优秀架构，原生支持无头后台守护运行，多终端、浏览器 WebUI、外部工具均可自由 Attach 到同一个正在运行的会话：

```bash
# 1. 在服务器或本地后台启动长驻 Daemon 服务
jeikcode serve --host 0.0.0.0 --port 4096 --token your-secret-token

# 2. 然后会打印出所有的weburl链接，直接打开即可体验体验感和Codex相当的编程体验

```

---

## 🗺️ 自研代码图谱 (CodeExplore) 相比传统 MCP 的降维优势

很多开发者在使用带有 MCP 工具（如 Codegraph 等）的开源 Agent 时经常会发现：**“它根本听不懂自然语言，只能死板匹配精确的函数或类符号”**。当你问 *“找一下退款回调在哪个文件校验签名”* 时，这类硬性符号工具直接失效，Agent 只能 fallback 回低效盲目的全量 grep 翻找。

JeikCode 抛弃了低效的外部 MCP 胶水方案，**在内核中用纯 Rust 自研了深度代码图谱与双语语义索引系统**：
- **语义级多维融合**：通过 AST 语法树解析类型继承、调用链与跨文件定义，结合中英文领域词林将代码注释、语义上下文与业务概念做多对多向量加权对齐；
- **智能预算剪裁**：精准将核心实现代码置顶提供给大模型，次要辅助文件自动压缩为结构大纲，绝不浪费宝贵的上下文空间；
- **实测性能**：比传统正则或普通 MCP 检索**减少 60%–70% 的翻找交互轮次**，复杂业务代码定位命中率高达 **90%+**，大幅超越目前开源的一众 MCP 工具。

---

## 💻 常用快捷键与核心斜杠命令速查

### 终端交互快捷键

| 快捷键 | 功能说明 |
| :--- | :--- |
| `Enter` | 发送当前输入内容 |
| `\` + `Enter` | 通用强制换行 |
| `Shift+Enter` / `Alt+Enter` | 换行（受终端终端协议支持） |
| `Esc` × 2 或 `Ctrl+C` × 2 | **双击安全取消**：中断当前正在执行的任务并恢复输入内容 |
| `Alt+V` / `Ctrl+Alt+V` | 粘贴剪贴板截图为多模态图片附件 |
| `Ctrl+Up` / `Ctrl+Down` | 向上 / 向下平滑滚动查看对话历史 |
| `Ctrl+L` | 快速清屏（保留当前会话完整上下文） |

### 核心斜杠命令 (Slash Commands)

| 命令 | 说明 |
| :--- | :--- |
| `/plan` | 切换为**只读规划模式**（仅探索分析架构，不修改任何文件） |
| `/build` | 切换为**编码构建模式**（正常执行代码改写、构建与测试） |
| `/effort` | 实时调节思考深度（`low` / `medium` / `high` / `xhigh` / `off`） |
| `/webui` | 一键拉起现代化 WebUI 控制台（支持公式渲染、文件上传与多项目手风琴） |
| `/compact` | 立即执行上下文智能压缩（核心记忆与重要规则受 `sacred_floor` 刚性保护） |
| `/model` | 查看或在当前会话中快速切换模型 |
| `/modeladd` | 交互式图形/菜单向导快速配置新提供商与模型 |

---

## 📁 项目级开发规范 (Project Instructions)

在你的代码工程根目录下放置规范文件，JeikCode 会在决策中**严格优先遵循项目级规则**（高于系统默认 System 设定）：

* `AGENTS.md` / `JEIKCODE.md`：核心架构分层、编码约束与 Git 提交规范；
* `.jeikcode/rules.md`：团队特定业务规则、审批红线与安全策略；
* `.jeikcode/glossary.md`：专有名词与业务术语中英对照词典。

---

## 更新日志

**v7.1.39**（2026-09-30）：WebUI 模型选择控件全面移至顶部标题栏右上角，彻底消除底部输入框空间挤压导致的发送按钮变形与溢出问题；顶栏操作区统一垂直居中，预留 6px 底部安全间隙，根除控件下边缘接触穿透下方 Git 面板与指示器的缺陷；模型选择器重构为现代化微胶囊并支持向下展开实心高层级级联菜单，彻底防止文字半透明穿透。

**v7.1.38**（2026-09-30）：WebUI 右上角工具栏（更新/主题/语言）联动右侧检视面板（提问记录/Git面板）平滑自适应避让，根除穿透遮盖标题与折叠按钮问题；移除输入框底部 780px 强制两行堆叠，模型选择器支持弹性自适应收缩，保持单行优雅排布；多项目手风琴列表全面贯穿乐观会话，发消息即时在所属项目文件夹浮现并联动刷新缓存；分离活跃流标识与脱机停止别名，免疫后台检测改写，彻底解决发消息卡在闪烁、刷新才显示消息的流式同步问题。

**v7.1.36**（2026-09-30）：WebUI 右上角新增检测更新按钮，支持自动与手动检测版本更新，新版本点亮绿色向上箭头并弹窗确认；桌面端一键升级自动下载平台 Setup 安装包并展示进度，下载完成后退出并拉起重新安装；修复已有配置环境下运行 `install.sh` / `install.ps1` 安装脚本不触发可选覆盖的问题，升级后首次启动桌面端或 WebUI 自动弹出配置覆盖多选框（保护自定义模型与 MCP/Skills），支持一键确认覆盖。

**v7.1.35**（2026-09-30）：WebUI 左侧边栏重构为 Codex 风格多项目收纳列表，支持多项目收纳折叠、会话归类、展开更多与项目内快捷新建，添加项目支持唤起系统原生文件资源管理器通用对话框；左上角新建会话默认在用户家目录（`~`）创建，输入框移除底部冗余行并贴底释放垂直空间，右上角新增圆形主题与语言快速切换，左下角直出独立模型配置；桌面端外部链接与弹窗统一由系统原生默认浏览器正常多标签打开；重构 Steer 转向机制与多模态载荷分流；移除 `run_command` 的 `task_progress` 并规范 `summary` 输出语言。

完整记录见 [CHANGELOG.md](./CHANGELOG.md)。

---

## License / 开源许可证

本项目遵循 **JeikCode 非商业性使用与署名开源协议（基于 CC BY-NC 4.0 适配）** 开源，详情请参阅 [LICENSE](./LICENSE)：

1. **严格禁止商用**：未经原作者显式书面许可与正式商业授权，严禁任何个人或机构将本软件（含源码与二进制）全部或部分用于商业营利目的、收费产品集成、闭源销售或作为 SaaS/云端增值服务提供；
2. **强制署名与注明出处**：任何基于本项目的二次修改（二改）、派生版本、代码合并或公开部署使用，**必须在界面显著位置（如欢迎页、关于界面、文档）完整保留原作者版权声明、项目名称（JeikCode）及官方开源仓库地址（`https://github.com/jeikl/JeikCode`）**；
3. **商业授权与合作**：如需将本软件用于商业环境、企业系统集成或商业合作，请通过官方开源仓库联系作者获得正式书面授权。
