# 06 - 系统目录与全局文件配置指南 (Directories & System)

全局根目录路径：`~/.jeikcode/`（或 `$JEIKCODE_HOME`）。

---

## 1. 核心目录结构

| 目录 | 存放内容 | 热生效属性 |
| :--- | :--- | :--- |
| **`prompts/`** | 提示词与执行规则（`init.yaml`、`rules.yaml`） | **自动热生效**（按 mtime 自动重载） |
| **`teaches/`** | 系统配置指南与知识库文档 | 系统内置/覆盖 |
| **`thesaurus/`** | 中英双语代码检索词林文件（`*.txt`） | **自动热生效**（下次检索自动重载） |
| **`skills/`** | 全局用户技能目录（子目录包含 `SKILL.md`） | 需触发热生效（`jeikcode_config(action="reload")`） |
| **`plugins/`** | 已安装插件市场与扩展 | 需触发热生效（`jeikcode_config(action="reload")`） |
| **`sessions/`** | 会话持久化数据与状态检查点 | 历史资产 |
| **`datalog/`** | 结构化审计日志 | 可定期清理 |
| **`cache/`** | AST 语法树与符号索引临时缓存 | 可安全删除（自动重建） |
| **`image-cache/`** | 视觉模型图片预处理临时缓存 | 可安全删除 |
| **`logs/`** | 运行时输出日志与错误记录 | 可安全删除 |
| **`rewind/`** | 代码与对话回滚检查点 | 可安全删除 |

---

## 2. 根级配置文件与状态文件

| 文件名 | 用途 | 热生效属性 |
| :--- | :--- | :--- |
| **`config.toml`** | 主配置文件（模型、API Key、超时、UI、代理） | 需触发热生效（调用 `jeikcode_config(action="reload")` 或 `/reload`） |
| **`auth.toml`** | OAuth Token 与敏感凭据 | 运行时动态读取 |
| **`mcp.json`** | 全局外部 MCP 工具配置 | 需触发热生效（调用 `jeikcode_config(action="reload")` 或 `/mcp reload`） |
| **`memory.md`** | 跨会话长期记忆文件 | 启动会话时读取 |
| **`user-wrap.md`** | 用户提问外层包装模板 | **自动热生效**（下一轮对话生效） |
| `.codegraphignore` | 符号索引与图谱构建忽略规则 | 保存后下次建索引生效 |
| `webui-listen.json` | 桌面端与 WebUI 端口和 Token 配置 | 运行时更新 |
| `builtin-tools.txt` | 当前版本所有内置工具清单摘要 | 只读参考 |

---

## 3. 热生效与维护操作

1. **自动热生效文件**：
   - `prompts/init.yaml`、`prompts/rules.yaml`、`user-wrap.md`、`thesaurus/*.txt`：编辑保存后无需任何操作，系统自动检测变更并在下一轮生效。
2. **非自动热生效文件**：
   - `config.toml`、`mcp.json`、`skills/`：编辑保存后需触发重载：
     - Agent 端调用工具：`jeikcode_config(action="reload")`；
     - 界面输入命令：`/reload`（或 `/mcp reload`）；
     - WebUI 侧栏点击 MCP「刷新按钮」。
3. **磁盘空间清理**：
   - 可随时安全删除 `cache/`、`image-cache/`、`logs/`、`rewind/`，不会丢失任何配置或技能。
