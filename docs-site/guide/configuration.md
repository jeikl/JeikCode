# AI快速配置

JeikCode 支持非常丰富的自定义配置，包括模型配置、MCP 服务、Agent Skills 技能库、工具超时控制及安全策略等。系统同时支持 **AI 自动配置** 与 **手动配置** 两种方式：

- **方式一：AI 自动配置（强烈推荐）**：在系统初始化完成后，你完全不需要死记硬背复杂的 TOML 语法，直接在终端或 WebUI 中向 JeikCode 用自然语言说明你的配置需求即可（例如：“帮我配置 DeepSeek 的 API Key 为 sk-xxx，并设为默认模型” 或 “帮我挂载 Chrome DevTools MCP 服务”）。AI 会调用底层能力自动帮你写入配置文件，并执行即时热重载（Hot-Reload），无需重启即可生效！
- **方式二：手动配置**：如果你更喜欢手动精细控制，以下是 JeikCode 的核心配置文件与数据存储位置：`~/.jeikcode`。

---

## 1. 核心配置与数据存储位置 (`~/.jeikcode`)

JeikCode 的核心配置文件与持久化数据统一保存在用户主目录下：
- **Linux / macOS**: `~/.jeikcode/config.toml`（或 `$JEIKCODE_HOME/config.toml`）
- **Windows**: `C:\Users\<用户名>\.jeikcode\config.toml`

`~/.jeikcode` 目录的主要资产包括：
- `config.toml`：核心配置文件（模型凭据、全局默认参数、超时控制）
- `mcp.json`：全局 MCP (Model Context Protocol) 服务挂载配置
- `skills/`：全局自定义 Agent Skills 技能库
- `teaches/`：内置系统指南知识库（供 AI 查阅与自愈）

---

## 2. 全局通用配置项

```toml
# =============================================================================
# 顶层全局默认配置（必须在文件最顶部）
# =============================================================================
default_model = "deepseek/deepseek-v4.1-flash"  # 默认启动时加载的模型
language = "zh-CN"                             # 界面与交互语言
auto_update = false                            # 自动更新，默认为关闭
auto_commit = false                            # 每轮对话结束后自动执行 Git 提交
keep_interrupted_context = true                # 中断/取消回合时是否保留已产生的部分上下文
```

---

## 3. 命令超时与慢构建白名单 (`[timeouts]`)

为防止自动化 Shell 执行意外挂死或交互等待造成会话死锁，JeikCode 提供了精准的超时保护机制：

```toml
[timeouts]
# 短命令最大空闲时间（秒），超时后自动进入后台任务或向用户确认
command_idle_secs = 30

# 慢构建命令白名单（避免 cargo, npm 等长时间编译被误杀）
long_running_keywords = ["cargo", "npm", "pnpm", "mvn", "gradle", "docker", "make"]
```

---

## 4. 更多专项配置指引

JeikCode 将各项能力的配置进行了模块化解耦，你可以前往专门的配置板块深入了解：

- **[模型配置](/guide/login)**：配置供应商账号 (`provider_accounts`) 与模型档案 (`models`)、推理思考参数与视觉代答；
- **[MCP (模型上下文协议)](/advanced/mcp)**：连接外部数据库、浏览器自动化与本地工具服务；
- **[Skills 技能系统](/advanced/skills)**：编写与管理专有业务工作流与 Prompt 模板。
