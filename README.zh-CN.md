<div align="center">
  <img src="./assets/jeikcode-logo.svg" alt="JeikCode Logo" width="130" />
  <h1>JeikCode: 极速、自主的开源终端 AI Coding Agent (Rust 驱动)</h1>
  <p><strong>原生代码语义索引 · 极致 Rust 速度 · 极简热重载提示词 · 字节级 KV-Cache 保护</strong></p>
  <p>
    <em>专为大型复杂工程打造的下一代 Agentic AI 编程智能体</em>
  </p>
  <p>
    <a href="./README.md"><strong>English (Default)</strong></a> · <strong>简体中文</strong>
  </p>
  <p>
    <a href="#一jeikcode-是什么">定位与核心杀手锏</a> ·
    <a href="#二主流-ai-coding-agent-功能与机制深度对比">机制对比矩阵</a> ·
    <a href="#三原生-codeexplore-与-repomap-深度图谱检索">CodeExplore</a> ·
    <a href="#四核心机制与体验亮点">核心亮点</a> ·
    <a href="#五安装与快速上手">安装上手</a> ·
    <a href="#六快捷键与常用命令">命令指南</a> ·
    <a href="#七多项目知识库配置">知识包体系</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/version-6.9.22-blue.svg" alt="version">
    <img src="https://img.shields.io/badge/rust-1.88%2B-orange.svg" alt="rust">
    <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="license">
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows%20%7C%20HarmonyOS-lightgrey.svg" alt="platform">
    <a href="https://github.com/JeikCode/JeikCode" target="_blank">
      <img src="https://img.shields.io/github/stars/JeikCode/JeikCode?style=social" alt="GitHub Stars"/>
    </a>
  </p>
</div>

---

## 一、JeikCode 是什么？

**JeikCode 是一款采用纯 Rust 原生构建、拒绝上下文臃肿与无效翻找、专为大型复杂工程而生的新一代终端 AI 编程智能体。**

在传统 Coding Agent 面临“代码检索瞎蒙、提示词冗长占用窗口、模型假死报错即断联”等实际工程痛点时，JeikCode 完成了三大突破性核心创新：

1. 🔍 **原生 AST 语义代码索引（CodeExplore）**：
   - 告别传统 ripgrep 纯文本正则的盲目扫盘与 LSP 仅限符号查找的局限。
   - 自研**加权 AST 语法树向量 + 中英文自然语言与注释多重语义对齐（词林加权）**，用真实业务需求提问即可直接定位核心实现，检索效率提升 **60% - 70%**，命中准确率高达 **90%+**。
2. ⚡ **极致 Rust 原生性能与 TTY 掌控**：
   - 纯 Rust 编写的无依赖超轻量内核，毫秒级冷启动与流式吞吐，摆脱 Python / Node 运行时的臃肿迟滞。
   - 原生支持双击防误触（`ESC` / `Ctrl+C` ×2）与 Linux 前台 TTY 控制权主动夺回，终端绝不锁死。
3. 🧠 **极简提示词架构与字节级 KV-Cache 保护**：
   - **全量外置热重载**：提示词完全独立解耦于 `init.yaml`、`rules.yaml` 与 `user-wrap.md`，修改毫秒级热生效，无需重启重编译，不写死任何冗长废话。
   - **严格 Append-Only 前缀**：动态包裹仅作用于用户输入末端，保证系统前缀字节级不可变，配合 `sacred_floor` 记忆防丢失保护，彻底杜绝云端 KV-Cache 击穿，大幅削减 Token 开销。

---

## 二、主流 AI Coding Agent 功能与机制深度对比

以下矩阵基于真实的底层架构与工程实测，客观呈现 **JeikCode**、**OpenAI Codex**、**Claude Code**、**OpenCode** 与 **Grok Build** 的机制差异：

### 1. 核心功能与机制对比矩阵

| 核心功能与机制 | **JeikCode (本项目)** | **OpenAI Codex (`@openai/codex`)** | **Claude Code (Anthropic)** | **OpenCode (OpenCode AI)** | **Grok Build (SpaceXAI)** |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **底层架构与运行时** | **Rust 原生内核 + 动态沙箱** | **Rust (`codex-rs`) + TS CLI** | **TypeScript + CLI** | **TypeScript + Effect-TS** | **Rust (Ptyctl/ChatState)** |
| **代码语义检索** | ✅ **CodeExplore: AST 向量 + 中英双语** | ⚠️ 基础语法树检索 | ⚠️ ripgrep / Glob 全文本搜索 | ⚠️ LSP 符号 + ripgrep 搜索 | ⚠️ xai 语法图谱 |
| **提示词架构与精简度** | ✅ **极简外置 + 毫秒级热重载** | ❌ 提示词内置于二进制，需重构 | ⚠️ 支持 `CLAUDE.md`，核心写死 | ⚠️ 支持外部配置，需重启载入 | ⚠️ 支持优先级，核心内置 |
| **KV Cache 前缀防击穿** | ✅ **`user-wrap.md` 动态末尾包裹 (字节级不可变)** | ⚠️ 依赖云端会话缓存机制 | ✅ **Anthropic 原生 Ephemeral Cache** | ⚠️ 依赖服务商原生缓存 | ⚠️ 基于 SQLite 日志转录 |
| **工具 5 级自愈与参数修复** | ✅ **自动修补 (JSON/类型/Windows路径)** | ❌ 仅结构校验，格式错误即报错 | ⚠️ 依靠 Claude 顶级推理自纠偏 | ⚠️ Schema 校验失败即中断报错 | ✅ 具备诊断回喂与纠偏 |
| **循环调用熔断机制** | ✅ **3次失败 Loop Guard + 状态熔断** | ⚠️ 依赖会话统一中断 | ⚠️ 依靠上下文截断或模型自省 | ⚠️ 依赖上下文截断或人工打断 | ✅ **具备 Loop Guard 熔断** |
| **首 Token 活性超时守护** | ✅ **独立 60s × 3 计时 (防思考模型假死)** | ⚠️ 统一 Stream 请求超时 | ⚠️ 全局统一 Stream 请求超时 | ⚠️ Effect 统一请求超时 | ✅ 进程级看门狗协同 |
| **超大输出保护与折叠** | ✅ **64KB 自动折叠 + `fetch_output` 按需切片** | ⚠️ 基础截断处理 | ⚠️ 依赖模型调用工具筛选 | ⚠️ 基础文件折叠 | ✅ 具备输出预算控制 |
| **多协议原生支持** | ✅ **Responses / Completions / Anthropic / Gemini** | ⚠️ 原生深度绑定 OpenAI 协议 | ⚠️ 深度绑定 Claude 官方协议 | ✅ 支持主流协议与扩展 | ⚠️ 深度绑定 xAI 协议 |
| **4 档思考深度随时切换** | ✅ **随时通过 `/effort` 或 WebUI (实时)** | ⚠️ 针对 o-系列模型固定配置 | ✅ **深度集成 Claude 3.7 Thinking** | ⚠️ 面板手动调节思考参数 | ✅ **深度集成 Grok 推理档位** |
| **远程无头运行与 Web 控制台** | ✅ **纯 Rust 高并发 `serve` + 交互式 WebUI** | ⚠️ 依赖 App-Server 与本地 Daemon | ❌ 纯终端 CLI 模式 | ✅ **具备 Web 控制台与桌面端** | ❌ 纯终端 Pager 模式 |
| **工程知识包与业务规范** | ✅ **4 层知识包且严格优先于 System** | ⚠️ 基础 Agent Role 配置 | ✅ **支持 `CLAUDE.md` 项目指令** | ✅ **支持项目规则拼接** | ✅ **支持项目级规则配置** |

---

### 2. 编程语言 AST 语义解析支持矩阵

| 语言与框架 | **JeikCode (CodeExplore)** | **传统正则 / 文本搜索** | **LSP 符号索引** |
| :--- | :---: | :---: | :---: |
| **Rust** | ✅ **AST 语法图谱 + 中英语义对齐** | ⚠️ 正则匹配，易漏掉关联宏/类型 | ⚠️ 需配置完整 rust-analyzer 环境 |
| **TypeScript / JavaScript** | ✅ **JSX / TSX 元素级语义与组件提取** | ⚠️ 纯文本匹配，易受同名变量干扰 | ⚠️ 符号跳转，缺乏自然语言理解 |
| **Vue (Vue2 / Vue3 SFC)** | ✅ **Template + Script 双 AST 结构解析** | ❌ 只能搜文本，无法理解 SFC 架构 | ⚠️ 对跨块绑定解析薄弱 |
| **Python** | ✅ **AST 语法图谱 + Docstring 语义映射** | ⚠️ 正则匹配 | ⚠️ 需配置 pyright/pylance |
| **Java** | ✅ **Class/Method AST + 中英语义图谱** | ⚠️ 纯文本匹配 | ⚠️ 依赖重型 jdt.ls |
| **Go** | ✅ **AST 语法图谱 + 中英语义对齐** | ⚠️ 纯文本匹配 | ⚠️ 依赖 gopls |
| **C / C++** | ✅ **AST 语法图谱 + 头文件依赖链路** | ⚠️ 纯文本匹配 | ⚠️ 依赖 clangd 配置 |
| **Svelte / Astro / SCSS** | ✅ **组件结构、模板与样式类提取** | ⚠️ 纯文本正则匹配 | ❌ 缺少综合业务语义检索 |

---

## 三、原生 CodeExplore 与 repo_map 深度图谱检索

开源项目 **CodeGraph** 带来了优秀的符号索引思路，但工程实战暴露出其致命短板：**只懂硬编码的符号语言，完全缺乏自然语言业务语义理解**。当开发者用业务语言提问（例如*“定位一下处理退款回调的逻辑”*），纯符号检索往往无能为力。

JeikCode 彻底自研了原生的 **`CodeExplore`** 与 **`repo_map`** 体系：

1. **加权 AST 向量 + 中英混合多重语义对齐**：
   - 提取代码结构（AST 符号、函数调用链路、结构体与类定义）；
   - 提取中英文注释与函数文档（Docstring / Comment）；
   - 将代码逻辑与中英文业务语义进行多重向量化与词林加权对齐。
2. **加权排行置顶最相关代码**：
   - 综合评分算法将最核心的代码段和实现细节**直接置顶呈现**给智能体，彻底告别盲目 grep。
3. **低相关代码极小 Token 预算推荐**：
   - 次相关或潜在依赖文件绝不暴力 dump 污染上下文，而是提炼极小的 Token 预算路径与摘要推荐，兼顾全局视野与极低 Token 消耗。
4. **实测指标**：
   - 🚀 **检索效率大幅提升 60% - 70%**：1 轮内精准定位核心业务代码；
   - 🎯 **检索准确率高达 90%+**：无论是中英文混合还是模糊业务需求均能精准锁定。

---

## 四、核心机制与体验亮点

### 1. 严格 Append-Only 缓存保护与极简提示词
- **字节级不可变**：系统提示词、`MEMORY` 记忆、`SKILLS` 技能与知识包在首部紧凑合并。
- **`user-wrap.md` 动态末尾包裹**：利用 `{{input}}` 仅对末尾真实用户提问进行动态包裹，修改模板即刻毫秒级生效，**完全不破坏已缓存的前缀**。
- **`sacred_floor` 防丢失机制**：执行 `/compact` 上下文压缩时，底部的核心规则与记忆条目受保护永不丢失。

### 2. 五级工具容错、自愈链与防假死熔断
- **五级自愈修复链**：直解析 → 宽松 JSON 修复（尾逗号/未加引号 key/去掉 Markdown 标记）→ `edit_file` 正则提取 → Schema 字符串解码 → Key-Value 兜底。
- **Windows 路径反斜杠救赎**：自动抢救 `D:\project\src` 单反斜杠，避免被反序列化误转义。
- **类型自动强转**：`"quantity":"3"` 自动转为数值 `3`，`"retry":"true"` 自动转为布尔 `true`。
- **64KB 大文本自动折叠**：超大输出自动折叠入 Artifact 产生头尾预览，模型可用 `fetch_output` 按需提取。
- **3 次失败 Loop Guard 熔断**：同一工具连续失败 3 次触发熔断强换方案，拦截重复无效空转。
- **双层超时与进度感知**：1800s 命令硬寿命强行回收树状子进程；180s MCP 空闲预算（监听进度通知自动重置计时）。
- **独立首 Token 活性超时（First-Token Timeout）**：针对 DeepSeek-R1、Grok 3 等超大思考模型，建立 60s × 3 独立计时，告别长推理静默假死。

### 3. 原生全协议支持与 4 档思考深度
- 原生支持四大模型协议：**OpenAI Responses (`/v1/responses`)**、**OpenAI Chat Completions**、**Anthropic Messages** 与 **Google Gemini 原生协议**。
- 随时通过 `/effort` 切换 4 档思考深度（`low` / `medium` / `high` / `xhigh` / `off`）。
- 账号凭据与模型参数彻底解耦，打开 `/modeladd` 自动拉取上游模型列表。

### 4. 现代化 WebUI 与多实例远程无头服务 (Serve)
- **交互式 WebUI 控制台**：输入 `/webui` 或 `jeikcode webui` 即可在浏览器中开启可视化操作（支持 KaTeX 科学公式渲染、Token 消耗分类浮层）。
- **附件流式上传**：支持文件拖拽与多模态流式上传，非图片附件智能落入 `.jeikcode_store` 供智能体自主检索。
- **多实例远程无头服务**：
  ```bash
  jeikcode serve --host 0.0.0.0 --port 4096 --token sk-my-secret
  jeikcode attach http://192.168.1.100:4096 --token sk-my-secret
  ```

---

## 五、安装与快速上手

### 1. 一键脚本安装（推荐）

前往 [GitHub Releases](https://github.com/JeikCode/JeikCode/releases) 下载：

```bash
# Linux / macOS 一键安装
curl -fsSL https://raw.githubusercontent.com/JeikCode/JeikCode/main/scripts/install.sh | bash

# Windows PowerShell 一键安装
irm https://raw.githubusercontent.com/JeikCode/JeikCode/main/scripts/install.ps1 | iex
```

### 2. 源码编译安装

环境要求：**Rust 1.88+**（[rustup.rs](https://rustup.rs/)）：

```bash
git clone https://github.com/JeikCode/JeikCode.git
cd JeikCode

cargo install --path crates/atomcode-cli --bin jeikcode --locked
jeikcode --version
```

### 3. 配置与启动

进入任意工程目录直接启动：

```bash
cd /path/to/your/project
jeikcode
```

配置文件位于 `~/.atomcode/config.toml`：

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

常用命令行启动方式：
```bash
# 指定工程目录启动
jeikcode -C /path/to/project

# 指定模型启动
jeikcode --model deepseek-reasoner

# Headless 自动化模式 (适合 CI/CD 与脚本批处理)
jeikcode -p "排查并修复登录模块鉴权异常"

# 快速恢复上一轮会话
jeikcode -c
```

---

## 六、快捷键与常用命令

### 1. 终端核心快捷键

| 快捷键 | 功能说明 |
| :--- | :--- |
| `Enter` | 发送当前输入内容 |
| `\` + `Enter` | 换行（全终端通用兼容） |
| `Shift+Enter` / `Alt+Enter` | 换行（需终端协议支持） |
| `Esc` ×2 / `Ctrl+C` ×2 | **双击防误触取消**：终止当前执行并恢复输入框 |
| `Alt+V` / `Ctrl+Alt+V` | 粘贴剪贴板截图为多模态图片附件 |
| `Ctrl+Up` / `Ctrl+Down` | 向上 / 向下滚动对话区域 |
| `PageUp` / `PageDown` | 翻页滚动对话 |
| `Ctrl+L` | 清屏并保留上下文 |

### 2. 常用斜杠命令

| 命令分类 | 斜杠命令 | 详细功能说明 |
| :--- | :--- | :--- |
| **模式与状态** | `/plan` | 切换至只读探索规划模式（只调研不修改代码） |
| | `/build` | 切换至代码修改执行模式 |
| | `/effort` | 实时调整思考努力程度 (`low/med/high/xhigh/off`) |
| **界面与交互** | `/webui` | 打开浏览器可视化交互控制台 |
| | `/modeladd` | 图形化快速添加/配置新模型 |
| | `/model` | 快速切换当前会话所使用的模型 |
| **工程与记忆** | `/compact` | 触发上下文压缩（底层规则受 `sacred_floor` 保护） |
| | `/init` | 自动扫描当前工程并生成规范化规则文件 |

---

## 七、多项目工程知识库体系

JeikCode 支持多层工程规则定义，**优先级严格高于 System 默认规则**：

| 文件路径 | 作用与约束定位 |
| :--- | :--- |
| `AGENTS.md` / `ATOMCODE.md` | 主工程开发规范与技术栈守则 |
| `.atomcode/rules.md` | 业务开发规则、审批纪律与安全约束 |
| `.atomcode/dbwords.md` | 数据库表结构、核心字段与枚举映射 |
| `.atomcode/glossary.md` | 领域业务专有名词中英文对照词典 |

---

## License

本项目遵循 [MIT License](./LICENSE) 开源协议。
