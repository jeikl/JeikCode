<div align="center">
  <img src="./assets/jeikcode-logo.svg" alt="JeikCode Logo" width="120" />
  <h1>JeikCode: 极速、自主的终端 AI Coding Agent (Rust 驱动)</h1>
  <p><strong>98–99% KV-Cache 命中 · 原生代码图谱 · 四协议原生 · 极致工具自愈</strong></p>
  <p>
    <em>专为大型复杂工程打造的新一代高效自主编程智能体，告别上下文臃肿与无效翻找。</em>
  </p>
  <p>
    <a href="./README.md"><strong>English (Default)</strong></a> · <strong>简体中文</strong>
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
    🌐 <strong>官方开源仓库</strong>：<a href="https://github.com/jeikl/JeikCode">https://github.com/jeikl/JeikCode</a> ·
    <a href="https://github.com/jeikl/JeikCode/releases"><strong>Releases 下载</strong></a>
  </p>
</div>

---

## 🚀 快速上手 (Quick Start)

### 1. 一键安装

在终端中执行对应系统的安装命令：

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

### 2. 快速配置

首次启动会自动生成配置文件 `~/.jeikcode/config.toml`。填入你的模型 API Key 即可使用：

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

### 3. 启动运行

进入任意项目代码目录，直接运行：

```bash
cd /path/to/your/project
jeikcode
```

常用 CLI 选项：
```bash
# 指定项目目录启动
jeikcode -C /path/to/project

# 切换指定模型启动
jeikcode --model deepseek-reasoner

# 启动 WebUI 浏览器交互界面
jeikcode webui

# 持续对话，恢复上一轮会话
jeikcode -c

# 无头自动化批处理（适合 CI/CD 或脚本调用）
jeikcode -p "排查并修复登录回调 404 问题"

# 一键平滑热升级到最新版本
jeikcode update
```

---

## ⚡ 核心杀手锏 (Why JeikCode?)

JeikCode 采用 Rust 原生内核驱动，专为解决复杂工程下的 Token 爆炸、代码迷航与工具调用失败而生：

1. 🔥 **恐怖的 98–99% KV-Cache 命中率**
   - **严格 Append-Only 尾部包裹**：系统前缀、记忆与项目规则严格保持字节级不可变，仅在尾部动态包裹用户输入，消除上下文缓存击穿，**大幅降低 API 费用与响应等待时间**；
   - **提示词热重载**：`init.yaml`、`rules.yaml` 等规则修改即生效，无需重启重编译。

2. 🗺️ **原生代码图谱 (CodeExplore)**
   - 内置加权语法图谱与中英双语领域词林，支持直接用**业务自然语言**提问定位实现（例如 *「找出退款回调在哪个文件校验签名」*）；
   - 比盲目全量 grep / 正则翻找提速 **60%–70%**，目标定位准确率达 **90%+**。

3. 🔌 **四协议原生全兼容**
   - 一套 Agent 循环原生支持 **OpenAI Chat Completions**、**OpenAI Responses (`/v1/responses`)**、**Anthropic Messages**、**Google Gemini**；
   - 随心切换各大模型服务商，无需修改业务配置。

4. 🩸 **极致工具自愈链**
   - **5 级自动纠错**：智能修复模型输出的畸形 JSON、类型错位（如将 `"5"` 强转为 `5`）、Windows 单反斜杠路径转义问题；
   - **原子文件改写**：同文件多处编辑（multi-hunk）支持 WAR 拓扑全成功落盘与 3-Way 自动变基重试，告别工具失败死循环。

---

## 💻 常用快捷键与命令

### 终端常用快捷键

| 快捷键 | 功能说明 |
| :--- | :--- |
| `Enter` | 发送当前输入内容 |
| `\` + `Enter` | 通用强制换行 |
| `Shift+Enter` / `Alt+Enter` | 换行（受终端协议支持） |
| `Esc` × 2 或 `Ctrl+C` × 2 | **双击安全取消**：中断正在执行的任务并恢复输入内容 |
| `Alt+V` / `Ctrl+Alt+V` | 粘贴剪贴板截图为多模态图片附件 |
| `Ctrl+Up` / `Ctrl+Down` | 向上 / 向下滚动查看对话历史 |
| `Ctrl+L` | 清屏（保留当前会话上下文） |

### 常用斜杠命令 (Slash Commands)

| 命令 | 说明 |
| :--- | :--- |
| `/plan` | 切换为**只读规划模式**（仅探索分析代码，不修改任何文件） |
| `/build` | 切换为**编码构建模式**（允许执行改写、构建与测试） |
| `/effort` | 实时调整模型思考深度（`low` / `medium` / `high` / `xhigh` / `off`） |
| `/webui` | 一键拉起浏览器 Web 控制台（支持 KaTeX 公式、多项目管理与侧边栏） |
| `/compact` | 立即执行上下文智能压缩（核心记忆与规则受 `sacred_floor` 刚性保护） |
| `/model` | 查看或临时切换当前会话的模型 |
| `/modeladd` | 交互式添加与配置新模型服务商 |

---

## 📁 项目级开发规范 (Project Instructions)

在你的项目根目录下放置规则文件，Agent 将**严格优先遵循项目级规则**（优先级高于默认 System 提示词）：

* `AGENTS.md` / `JEIKCODE.md`：核心架构约束、代码风格与共同署名规范；
* `.jeikcode/rules.md`：团队业务约束与安全操作规则；
* `.jeikcode/glossary.md`：专有名词与业务术语中英对照词林。

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
