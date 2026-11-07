# 01 - 提示词与上下文配置指南 (Prompts & Context)

配置目录路径：`~/.jeikcode/prompts/`（或 `$JEIKCODE_HOME/prompts/`）。

---

## 1. 核心文件与加载区分

| 文件名 | 类型 | 说明与生效方式 |
| :--- | :--- | :--- |
| **`init.yaml`** | 🔥 **动态生效** | **身份定义、优先级与环境前缀**。修改保存后按 mtime **动态热重载**，下一轮对话立即生效，无需重启。 |
| **`rules.yaml`** | 🔥 **动态生效** | **工作流与执行规范**。完全替代默认内嵌规则。修改保存后按 mtime **动态热重载**，下一轮对话立即生效，无需重启。 |

---

## 2. `init.yaml` 配置结构

```yaml
version: "2.1.0"

identity:
  agent_name: "JeikCode"
  provider: "Jeik"
  description: "an AI coding agent provided by Jeik, running on your underlying model"
  role_summary: "Always communicate in the language used by the user. When asked about your model identity, answer based on your actual underlying model code."
  template: |-
    <environment>
    You are the JeikCode AI coding Agent provided by Jeik, running on your underlying model. Always communicate in the language used by the user. When asked about your model identity, answer based on your actual underlying model code.

precedence:
  rule: |-
    Content enclosed in `<system_rules>` tags constitutes the default system rules.
    Content enclosed in `<user_preferences>` or `<memory>` tags constitutes global user preferences.
    Content enclosed in `<project_instructions>` tags constitutes project standards and constraints.

    When the rule sets do not conflict, all three apply simultaneously. For code review, issue publication, PR review, project code authoring, and similar work, the opinions, requests, code reviews, and standards of others must be governed solely by the `project_instructions` rules; `user_preferences` and any other personal user preferences must not be included.
    When they conflict, apply the precedence `project_instructions >> memory > user_preferences > system_rules`.

    Tool Invocation Precedence Rule: If built-in tools, Skills, and MCP tools can all solve the user's problem, invoke them in this strict order: Skills > MCP > Built-in Tools > Custom Scripts.

environment:
  platform_facts: |-
    Operating environment facts:
    - Platform: {os_platform} (Command habit: {command_habit})
    - Project working directory: {working_dir}
    - Git branch: {git_branch}
    - Temp files: use `"$TMPDIR"` instead of a hardcoded `/tmp` — it works for shell-internal paths AND as an ARGUMENT to native Windows programs (python / node / curl / …); `"$TMPDIR_WIN"` is the same path under a second name for nested non-bash shells.
    - Desktop: use `"$DESKTOP"` instead of assuming `~/Desktop` — it honors a relocated / redirected desktop; `"$DESKTOP_WIN"` is the equivalent alias.
    </environment>
```

---

## 3. `rules.yaml` 配置结构与模式差异

支持使用 `raw` 注入完整的规则正文（外层 `<system_rules>` 标签由系统统一包裹），或使用结构化字段：

```yaml
version: "2.1.0"

# 模式一：直接指定完整 Markdown 规则（若存在 raw，则优先独占生效，忽略下方的结构化字段）
raw: |-
  ## 执行准则
  - 任务纪律：严格遵循 <todo_rules> 中指定的准则推进任务...
  ## 工具纪律
  - 文件操作优先使用专用工具...

# 模式二：结构化字段（未提供 raw 时使用）
workflow:
  principle: |-
    Core Principle: First determine the final goal...
  guidelines:
    todolist_closure: "Task Discipline: Strictly follow the guidelines specified in <todo_rules>..."
    concurrency: "Concurrency principle: Whenever there is no data dependency between tool calls..."

prohibitions:
  - "读文件或查看目录时，优先使用 read，而不是 cat、head、tail、ls、dir 等 shell 命令。"
```

- **参数差异**：`raw` 具有最高优先级，配置了 `raw` 后直接渲染其 Markdown 内容；若未配置 `raw`，系统自动拼装 `workflow` 与 `prohibitions`。当前内置 `rules.yaml` 使用 `raw`，结构化字段仅作为兼容回退保留。

---

## 4. 用户提问包装 (`user-wrap.md`)

用于为用户最新真实提问增加外层包装（如注入业务防呆约束）。

### 4.1 语法与占位符
在模板中使用 `{{input}}` 作为用户原始输入占位符：

```markdown
用户提问：【{{input}}】
请以中文回答，并严格遵循工程最佳实践。
```

- 若模板中省略 `{{input}}`，则整篇模板作为用户提问的前缀拼接。
- **生效边界**：仅在用户提交最新真实 prompt 时包装一次；内部工具调用过程、系统提醒及子代理调度均不被包装。

### 4.2 配置文件优先级
按以下就近原则加载（命中首个生效）：
1. 项目级专属：`<workspace>/.jeikcode/user-wrap.md`
2. 项目级根目录：`<workspace>/user-wrap.md`
3. 全局默认：`~/.jeikcode/user-wrap.md`

---

## 5. 生效方式与热重载

- `init.yaml`、`rules.yaml`、`user-wrap.md` 保存后**自动根据文件 mtime 动态热重载**。
- 无需执行任何重启或重载命令，下一轮用户消息发出时立即以最新内容生效。
- 若文件被误删除，系统自动平滑回退至官方内置默认规则。

---

## 6. 指令注入块布局

全局 / 项目指令与记忆、技能、MCP 各自注入为**首条真实提问之前的独立块**（不在系统提示词内，且处于压缩的 `sacred_floor` 保护区，不会被压缩丢弃）：

| 顺序 | 块标签 | 来源 |
| :--- | :--- | :--- |
| 30 | `<available_skills>` | 已安装技能目录 |
| 40 | `<mcp_server_instructions>` | MCP 服务器说明 |
| 50 | `<memory>` | `memory.md`（全局 + 项目） |
| 55 | `<user_preferences>` | `~/.jeikcode/AGENTS.md` / `JEIKCODE.md` |
| 60 | `<project_instructions>` | 项目 `AGENTS.md` 等 + 业务知识包 |

- 优先级统一由 sys-1（`<environment>` 块）的 `## PRECEDENCE:` 表达；冲突时 **项目指令 >> memory > 用户偏好 > system 规则**。`<user_preferences>`、`<memory>`、`<project_instructions>` 不再各自携带前导优先级说明。
- 指令 / 知识文件修改后，下一轮按 mtime 自动热重载（未变的文件字节不变，前缀缓存不失效）。
