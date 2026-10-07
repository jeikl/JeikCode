# JeikCode 配置知识库导航索引 (Overview Index)

本目录为 JeikCode 全局与工作区配置体系的渐进式指南，供 Agent 与开发者查阅配置语法、参数与生效方式。

## 1. 核心指南模块速查表

| 编号 | 模块分类 (`topic`) | 对应文件路径 | 核心覆盖范围 |
| :--- | :--- | :--- | :--- |
| **01** | `prompts` | `teaches/01_prompts_and_context.md` | `prompts/init.yaml` 与 `rules.yaml` 配置结构、动态热重载机制、生效文件 vs 说明文件、`user-wrap.md` |
| **02** | `models` / `providers` | `teaches/02_models_and_providers.md` | `config.toml` 顶层标量位置、账号与模型解耦配置、思考档位、思考历史回传、Token 限制 |
| **03** | `mcp` / `skills` | `teaches/03_mcp_and_skills.md` | `jeikcode mcp add` CLI、`mcp.json`、WebUI/TUI `/mcp` 与刷新、`SKILL.md` 编写与 `/skills`、插件管理 |
| **04** | `thesaurus` / `cilin` | `teaches/04_thesaurus_and_retrieval.md` | 词林 `thesaurus/*.txt` 映射格式、双语代码检索、领域专有词库配置 |
| **05** | `tools` / `timeouts` | `teaches/05_tools_and_timeouts.md` | `[tools.bash]` 命令硬寿命、`[tools.timeouts]` 短超时、`[tools.tool_output]` 64KB 折叠、后台任务、代理设置 |
| **06** | `directories` / `files` | `teaches/06_directories_and_system.md` | `~/.jeikcode/` 目录结构与配置文件清单、清理与维护建议 |
| **07** | `project` / `rules` | `teaches/07_project_constraints_and_rules.md` | 三层项目指令（AGENTS.md、JEIKCODE.md、.jeikcode.user.md）、业务知识包（rules.md、glossary.md、dbwords.md） |
| **08** | `updates` / `upgrade` | `teaches/08_updates_and_releases.md` | 更新源配置（github.com/jeikl/JeikCode / latest.json）、自升级命令（/upgrade）、环境变量覆盖 |

---

## 2. 配置生效与热重载方式

修改配置后**无需重启 JeikCode 进程**，按文件类型生效：

| 配置类型 | 目标文件 | 生效方式 |
| :--- | :--- | :--- |
| **提示词与规则** | `prompts/init.yaml`<br>`prompts/rules.yaml`<br>`user-wrap.md` | **动态热重载**：保存后根据文件 mtime 自动热重载，下一轮对话即刻生效。 |
| **检索词林** | `thesaurus/*.txt` | **动态热重载**：保存后自动重载，下次检索即刻生效。 |
| **项目指令与知识包** | `AGENTS.md`<br>`rules.md`, `glossary.md`, `dbwords.md` | **动态热重载**：每轮对话开始时自动读取最新文件。 |
| **主配置** | `~/.jeikcode/config.toml` | **主动重载**：<br>• Agent 修改后调用工具 `jeikcode_config_reload`（下一轮生效）；<br>• WebUI / TUI 输入 `/reload`。 |
| **MCP 外部工具** | `mcp.json` / `.mcp.json`<br>CLI `jeikcode mcp add` | **主动重载**：<br>• Agent 修改后调用工具 `jeikcode_config_reload`；<br>• WebUI / TUI 输入 `/mcp reload`；<br>• WebUI 侧栏 MCP 菜单点击「刷新按钮」。 |
| **Skills 技能** | `skills/<name>/SKILL.md` | **主动重载**：调用 `jeikcode_config_reload` 或输入 `/reload`。 |
