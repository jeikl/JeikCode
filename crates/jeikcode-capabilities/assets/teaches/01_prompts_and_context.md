# 01 - 提示词与上下文配置指南 (Prompts & Context)

配置目录路径：`~/.jeikcode/prompts/`（或 `$JEIKCODE_HOME/prompts/`）。

---

## 1. 核心文件与加载区分

| 文件名 | 类型 | 说明与生效方式 |
| :--- | :--- | :--- |
| **`init.yaml`** | 🔥 **动态生效** | **身份定义、优先级与环境前缀**。修改保存后按 mtime **动态热重载**，下一轮对话立即生效，无需重启。 |
| **`rules.yaml`** | 🔥 **动态生效** | **工作流与执行规范**。完全替代默认内嵌规则。修改保存后按 mtime **动态热重载**，下一轮对话立即生效，无需重启。 |
| `root_docs_prompts.md` | 📖 说明文件 | 参考说明，不加载进模型上下文。 |
| `root_docs_内置工具.yaml` | 📖 说明文件 | 内置工具清单参考，不加载进模型上下文（工具由代码原生提供）。 |
| `root_docs_内置技能.yaml` | 📖 说明文件 | 内置技能参考，不加载进模型上下文（技能直接从 `skills/` 挂载）。 |

---

## 2. `init.yaml` 配置结构

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

environment:
  platform_facts: |-
    Operating environment facts:
    - Platform: {os_platform} (Command habit: {command_habit})
    - Project working directory: {working_dir}
    - Git branch: {git_branch}
    </environment>
```

---

## 3. `rules.yaml` 配置结构与模式差异

支持使用 `raw` 注入完整 Markdown 规则，或使用结构化字段：

```yaml
version: "2.0.0"

# 模式一：直接指定完整 Markdown 规则（若存在 raw，则优先独占生效，忽略下方的 workflow 与 prohibitions）
raw: |-
  ## 执行准则
  - 任务清单闭环...
  ## 工具纪律
  - 优先选用专用工具完成操作，而不是使用 bash...

# 模式二：结构化字段（未提供 raw 时使用）
workflow:
  principle: |-
    Core Principle: First determine the final goal, then break down the key steps of the target task...
  guidelines:
    todolist_closure: "Todo list closed-loop: Only after resolving any unfinished condition can the item be marked as completed."
    concurrency: "Concurrency principle: Whenever there is no data dependency between tool calls, they MUST be issued concurrently."

prohibitions:
  - "读文件时，优先使用 read_file，而不是 cat、head、tail 等 shell 命令。"
  - "修改文件时，使用 write_file 或 edit_file，而不是 echo >、sed、awk。"
  - "列出目录时，使用 list_directory，而不是 ls、dir。"
  - "搜索文件内容时，使用 grep 或 code_explore，而不是 shell 版的 grep/rg。"
  - "未经用户明确指令，绝不运行丢弃未提交工作的 git 命令（git checkout .、git reset --hard 等）。"
```

- **参数差异**：`raw` 具有最高优先级，配置了 `raw` 后直接渲染其 Markdown 内容；若未配置 `raw`，系统自动拼装 `workflow` 与 `prohibitions`。

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
