# 01 - 提示词与上下文管理指南 (Prompts & Context Management)

## 1. 核心目录与文件属性区分

配置路径：`~/.jeikcode/prompts/`（或 `$JEIKCODE_HOME/prompts/`）。

### ⚠️ 生效文件（Live Configs）与 说明文件（Seed Docs）严格区分：

| 文件名 | 属性 | 作用与加载方式 |
| :--- | :--- | :--- |
| **`init.yaml`** | **🔥 动态生效 (Live)** | **身份定义、安全隔离、上下文注入与系统规则前缀**。由 `custom_prompts.rs` 解析并实时渲染进 System Persona。每次文件修改（mtime 变更）**立即动态热重载生效，无需重启**。 |
| **`rules.yaml`** | **🔥 动态生效 (Live)** | **执行规范与工作流**（工作流反射、代码定位、并发工具纪律、先跑真实命令再诊断安装/登录、中文支持、任务追踪等）。完全替代默认内嵌规则。每次文件修改**立即动态热重载生效，无需重启**。 |
| `root_docs_prompts.md` | 📖 仅供说明 (Seed Doc) | **人类/开发者参考文档**。说明提示词设计规范，**绝不加载进模型上下文**。 |
| `root_docs_内置工具.yaml` | 📖 仅供说明 (Seed Doc) | **人类/开发者参考文档**。内置工具清单说明。模型真实使用的工具定义直接来自代码中注册的 `Tool::parameters_schema()`，**绝不加载本文件进模型**。 |
| `root_docs_内置技能.yaml` | 📖 仅供说明 (Seed Doc) | **人类/开发者参考文档**。内置技能说明。模型实际技能直接从 `~/.jeikcode/skills/` 的 `SKILL.md` 动态挂载，**绝不加载本文件进模型**。 |

---

## 2. `init.yaml` 核心配置结构与热重载

`init.yaml` 控制模型的身份、安全边界和环境前缀：

```yaml
version: "2.0.0"

identity:
  agent_name: "JeikCode"
  provider: "Jeik"
  description: "an AI coding agent by JeikCode running on your underlying model"
  role_summary: "Always communicate in the language used by the user. When asked about your model identity, answer based on your actual underlying model code."
  template: |-
    <environment>
    You are {agent_name} AI coding Agent by {provider} running on your underlying model. Always communicate in the language used by the user. When asked about your model identity, answer based on your actual underlying model code.

precedence:
  rule: |-
    Critical Precedence: Rules under <project_instructions> (such as AGENTS.md, rules.md, glossary.md, etc.) or <memory> constitute USER PROVISIONS. When in conflict with default behaviors, strictly prioritize user provisions.

    Tool Invocation Precedence Rule: If built-in tools, Skills, and MCP tools can all solve the user's problem, invoke them in this strict order: Skills > MCP > Built-in Tools > Custom Scripts.

    - Content enclosed in XML tags represents current environment, status, system reminders, and working constraints, and constitutes SYSTEM PROVISIONS.
    - Rules, constraints, and requirements under <project_instructions> (such as `AGENTS.md`, `JEIKCODE.md`, `CLAUDE.md`, `rules.md`, `glossary.md`, `dbwords.md`, etc.) and <memory> constitute USER PROVISIONS.

    Global user provisions reside under `~/.jeikcode/` (or legacy `~/.atomcode/`), and project-level user provisions reside under `./`, `./.jeikcode/`, or `./.atomcode/`. User provisions take effect immediately upon modification and hold the HIGHEST EXECUTION PRECEDENCE. System provisions cannot be modified.

    When user provisions do not exist, strictly adhere to system provisions.
    When user provisions exist, strictly prioritize user provisions. Comply with both system provisions and user provisions where they do not conflict; when conflicts arise, unconditionally obey user provisions (except core safety gates, destructive operation confirmation gates, product identity, and configured model code, which are non-overridable).
    - You must prioritize reading and following project-level instructions (e.g. `AGENTS.md`, `rules.md`, etc.).
    - When user-specified project rules exist, execute in strict accordance with them.

environment:
  platform_facts: |-
    Operating environment facts:
    - Platform: {os_platform} (Command habit: {command_habit})
    - Project working directory: {working_dir}
    - Git branch: {git_branch}
    </environment>
```

---

## 3. `rules.yaml` 核心规则结构

`rules.yaml` 定义模型的工作流与执行纪律，支持直接注入 Markdown 原文（`raw` 字段）或分段式结构化配置：

```yaml
version: "2.0.0"

# 支持直接指定 Block 2 的完整 Markdown 规则（优先渲染）
raw: |-
  核心原则：先明确目标，再拆解步骤。执行前充分探索文件和上下文，获取全局视图...
  ## 执行准则
  - 任务清单闭环...
  ## 工具纪律
  优先选用专用工具完成操作，而不是使用 `bash`...

workflow:
  principle: |-
    Core Principle: First determine the final goal, then break down the key steps of the target task. Next, explore sufficient and comprehensive files and context to support subsequent execution. Make maximum effort to get the full picture of problems and goals and gather all information upfront. Drive execution throughout with maximum effort—exploring, executing, iterative error-correcting, designing, installing, pushing forward, and fixing—until the task is completed and delivered with a comprehensive, high-quality response. When encountering any issue along the way, resolve any unambiguous problem you are capable of advancing yourself; exert maximum effort so the user exerts minimum effort, achieving the most comprehensive and high-quality completion.
  guidelines:
    todolist_closure: "Todo list closed-loop: Only after resolving any unfinished condition such as errors, missing environment, or unmet acceptance criteria in the current task item can the item be marked as completed."
    disambiguation: "Eliminate ambiguity and collect decisions: When facing large modifications that may cause wide-ranging destructive refactoring, multiple viable solutions or ways to solve a problem, missing keys/tokens that must be provided by the user, or ambiguities such as whether an occupied process should be terminated or renamed, use structured interactive forms or questions to collect user choices and text answers to eliminate ambiguity and advance task completion."
    concurrency: "Concurrency principle: Whenever there is no data dependency between tool calls, they MUST be issued concurrently (e.g., parallel file reading/editing, parallel subagent dispatching)."
    exploration_tasks: "Global exploration: Batch-call grep / read_file / code_explore to accelerate gathering context. If you discover key symbols during exploration, you should first use code_explore to understand the code logic; use repo_map and list_directory when unfamiliar with the directory structure."
    targeted_exploration: "Targeted exploration: When a feature, execution flow, or bug requires tracking how it works and what dependencies it touches, prioritize using code_explore."
    modification_tasks: "Modification and verification closed-loop: After making maximum effort to explore and obtain the full picture, execute edits in batches where possible. Unless the user explicitly states not to verify, batch verification (compiling, testing, or running commands) is MANDATORY. Resolve errors on the spot, fill in missing environment dependencies immediately, and persistently advance within verification."

prohibitions:
  - "读文件时，优先使用 `read_file`，而不是 `cat`、`head`、`tail` 等 shell 命令。"
  - "修改文件时，使用 `write_file` 或 `edit_file`，而不是 `echo >`、`sed`、`awk`。"
  - "列出目录时，使用 `list_directory`，而不是 `ls`、`dir`。"
  - "按名称查找文件时，使用 `glob`，而不是 `find`、`dir /s`。"
  - "搜索文件内容时，使用 `grep` 或 `code_explore`，而不是 shell 版的 `grep`/`rg`。"
  - "仅在专用工具无法完成时使用 `bash`：构建项目、编译代码、运行测试、包管理（cargo、npm、pip 等）、git 命令以及进程检查。"
  - "在 `bash` 中绝对不要内联串联阻塞性命令（如 `systemctl status <unit>`、分页器 pager、交互式命令），切勿运行交互式等待键盘输入的命令。"
  - "未经用户明确指令，绝不运行丢弃未提交工作的 git 命令（`git checkout .`、`git reset --hard`、`git clean -f`）。"

doing_tasks:
  - "Prefer modifying existing files over creating new ones."
  - "Strictly forbid adding unrequested features or unsolicited refactoring."
  - "Regularly write understandable functional comments (in the language of the user's prompt); comment density should match surrounding code style, concise and expressing core intent."
  - "When writing code, anticipate and solve common failure modes: web caching, session switching, timing mismatches between memory and disk/db persistence, off-by-one index shifts leading to rendering blocking and component anomalies."
  - "Consider extensibility, robustness, design patterns, cache consistency, elegance, and high performance."

output:
  signposts: |-
    When discovering key milestones or critical issues, briefly state the current stage status.
```

---

## 4. 多段系统提示词分块与缓存架构 (Multi-Segment System Prompts)

JeikCode 采用精简解耦的独立 Block 架构，彻底告别单一大字符串拼接，最大化发挥底层大模型的前缀缓存（KV Cache）潜力：

| Block | 标识/Header | 内容源与生命周期 | 角色与缓存控制 |
| :--- | :--- | :--- | :--- |
| **Block 1: 环境与优先权** | `<environment>` | `init.yaml`（身份、优先权及 OS/架构/命令习惯/工作目录/Git 分支动态注入） | `Role::System`，Anthropic 设置 `cache_control: ephemeral` |
| **Block 2: 工作流规范** | `<workflow_and_execution_discipline>` | `rules.yaml`（工作流纪律，顶部注入最高优先级裁决声明） | `Role::System`，Anthropic 设置 `cache_control: ephemeral` |
| **Block 3: 技能清单** | `<available_skills>` | `SkillCatalogHook`（技能发现与加载） | `Role::User (synthetic)`，受 `sacred_floor` 保护，压缩不丢 |
| **Block 4: MCP 指令** | `<mcp_server_instructions>` | `McpInstructionsHook`（已连接 MCP 服务指令） | `Role::User (synthetic)`，受 `sacred_floor` 保护，压缩不丢 |
| **Block 5: 长期记忆** | `<memory>` | `MemoryHook`（全局与项目记忆） | `Role::User (synthetic)`，受 `sacred_floor` 保护，压缩不丢 |
| **Block 6: 项目权威规范** | `<project_instructions>` | `SessionContextHook`（`AGENTS.md` 优先、全局/项目/用户指令与增量知识库） | **每轮 `turn_start` 动态热重载**，作为 Synthetic User 受到 `sacred_floor` 保护，压缩不丢 |
| **第 7 项** | 用户提问 | 用户输入（经 `user-wrap.md` 包装） | `Role::User (real)`，受 `sacred_floor` 保护（首条真实提问不丢） |

> 注：原旧版独立系统块 `=== SESSION BASELINE ===`（会话基线）已被彻底去除，其包含的环境事实（平台、架构、命令习惯、工作目录、Git 分支）现已由 Block 1 `<environment>` 原生统一动态注入，避免多余冗余块浪费上下文和缓存槽位。

### 4.1 协议适配与缓存断点控制
- **Anthropic Messages 协议**：顶层 `system` 为文本块数组，精确应用 4 个缓存断点预算：`[Tools, Block 1, Block 2, Last Message]`。
- **OpenAI 兼容协议**：默认保持多条独立 `role: "system"` 消息（`coalesce_system = false`）；针对仅支持单 System 的老旧网关支持 `coalesce_system = true` 折叠合并。
- **OpenAI Responses 协议**：原生按输入列表传输多个系统消息项。

---

## 5. 热重载与缓存机制原理

- **毫秒级 mtime 检验**：JeikCode 运行时内置 `PromptCacheState` 缓存，每轮对话启动前检查 `init.yaml` 和 `rules.yaml` 的文件修改时间戳（mtime）。
- **零开销复用**：文件未修改时直接使用内存缓存结构（0 解析成本）；文件被用户或脚本修改后，下一轮交互立即自动重新反序列化并注入 Persona。
- **平滑后备**：若用户删除了 `init.yaml` 或 `rules.yaml`，系统平滑退回二进制内嵌的官方默认规则，不会产生运行时崩溃。

---

## 6. 用户提问模板包装 (`user-wrap.md`)

`user-wrap.md` 允许用户或项目为最后一条真实提问自定义包装模板，注入系统规范、提问结构或业务防呆约束。

### 5.1 占位符与模板语法
模板中使用 `{{input}}` 作为动态插值占位符，运行时自动将用户的原始输入替换到对应位置：

```markdown
用户提问：【{{input}}】
请你根据用户的信息，不能回答政治相关的问题。
```

当用户输入 `你好` 时，最终进入模型的用户消息将自动包装为：
```text
用户提问：【你好】
请你根据用户的信息，不能回答政治相关的问题。
```

### 5.2 优先级与覆盖机制
系统按以下严格优先级就近加载（项目级覆盖全局级）：
1. **项目专属配置**：`<workspace>/.jeikcode/user-wrap.md`
2. **项目根级配置**：`<workspace>/user-wrap.md`
3. **全局默认配置**：`~/.jeikcode/user-wrap.md`

### 5.3 执行纪律与核心特性
- **仅包装最新真实提问**：仅在用户提交真实 prompt（`SendMessage`）时生效；内部交互、系统提示词插入、记忆注入、工具调用过程以及子代理调度均不处理；
- **KV Cache 前缀安全**：包装直接作用于末尾真实用户消息，系统前缀与历史轮次保持 Append-only 字节级不可变；
- **动态热重载**：无需重启，修改文件后下一轮提问即刻生效；
- **安全默认**：默认配置文件仅包含 `{{input}}`（原样透传），无任何额外副作用。

---

## 7. 代码探索提醒 (`code_explore` / `repo_map`)

运行时在 **L2** 通过 `CodeToolsFirstHook` 注入，不改 live YAML。仅当已挂载 `code_explore` 时生效。界面展示会剥掉 `<system-reminder>`，快照里保留模型看到的完整字节。

- **首条真实 user query 尾巴**：与日期提醒同一位置，追加在该条 User 消息底部（不是独立 User 块）：优先 `code_explore` / `repo_map`；多仓库时按各仓库根并行 `code_explore`；覆盖约 80% 框架后，回答前再用 `code_explore` + `grep` 补漏。
- **会话级 wander 计数终审**：每个会话 id 独立计数。`grep` + `glob` + `read_file` **合计**（不是单一种工具）。窗口 10：第 8 次合计调用时把提醒追加到**该次工具返回内容尾巴**；满 10 次清零；任意一次 `code_explore` 也清零。不改写已发出的 user query，不插入新的 User 块。

