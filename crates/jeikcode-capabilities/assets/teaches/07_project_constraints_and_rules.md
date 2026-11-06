# 07 - 项目约束与业务规则配置指南 (Project Constraints & Rules)

---

## 1. 三层项目指令配置

系统自动匹配并把两层指令注入为**相互独立的块**：全局层 → `<user_preferences>` 块，项目层 → `<project_instructions>` 块（两者都是首条真实提问之前的 frozen synthetic user 块，处于压缩保护区内）：

| 层级 | 配置文件路径（按顺序匹配首个命中项） | 注入块 | 适用场景与差异说明 |
| :--- | :--- | :--- | :--- |
| **1. 全局层** | `~/.jeikcode/AGENTS.md`<br>`~/.jeikcode/JEIKCODE.md` | `<user_preferences>` | 全局跨项目个人偏好。 |
| **2. 项目层** | `1. AGENTS.md`<br>`2. .jeikcode.md`<br>`3. JEIKCODE.md`<br>`4. CLAUDE.md`<br>`5. claude.md` | `<project_instructions>` | **项目核心开发规范**（架构边界、代码风格、提交规范）。建议提交至 Git 仓库，团队共享。 |

> 优先级：不冲突时三套规则（全局偏好 / 项目指令 / system 默认）同时生效；冲突时 **项目指令 >> memory > 用户偏好 > system 规则**。优先级与审查边界统一由 sys-1 表达，两个指令块不再重复前导说明。
> （原 `.jeikcode.user.md` 用户层已移除；核心安全网关与破坏性操作确认门不可被覆盖。）

---

## 2. 三大业务知识包配置

系统支持在项目内放置 3 类专属知识文件，每轮对话前自动检测读取：

| 知识包类型 | 候选文件路径（按顺序首个命中即停） | 作用 |
| :--- | :--- | :--- |
| **业务名词表 (Glossary)** | `.jeikcode/glossary.md`<br>`docs/glossary.md`<br>`glossary.md` | 业务黑话与专业名词映射到代码符号/类名。 |
| **业务规则 (Rules)** | `.jeikcode/rules.md`<br>`docs/rules.md`<br>`rules.md` | 业务逻辑、审批流与状态机等硬性规则约束。 |
| **数据库字典 (DB Words)** | `.jeikcode/dbwords.md`<br>`docs/dbwords.md`<br>`dbwords.md` | 数据表名、字段含义与关联关系说明。 |

- **命中规则差异**：知识包按表格顺序**首个匹配即停**。例如找到 `.jeikcode/glossary.md` 后即停止检索，不会合并 `docs/glossary.md`。

---

## 3. 项目级专属能力扩展路径

| 扩展项 | 放置路径 |
| :--- | :--- |
| **项目技能** | `<workspace>/.skills/<skill-name>/SKILL.md` 或 `<workspace>/.jeikcode/skills/<skill-name>/SKILL.md` |
| **提问包装** | `<workspace>/.jeikcode/user-wrap.md` 或 `<workspace>/user-wrap.md` |
| **专属 MCP** | `<workspace>/.mcp.json` |
| **专属词林** | `<workspace>/.jeikcode/thesaurus/*.txt` |
| **索引忽略** | `<workspace>/.codegraphignore`（构建符号图谱时忽略的文件，即便已入 Git 也会被忽略；噪声类规则同样作用于 glob/grep） |
| **凭据忽略（仅图谱）** | `<workspace>/.codegraphignore.graph`（`.env`、密钥、SSH 等敏感凭据**只对图谱**隐藏，显式 glob/grep 仍能搜到） |

---

## 4. 推荐项目配置结构

```text
my-project/
├── AGENTS.md                 # 项目架构边界与开发约束
├── .jeikcode/
│   ├── user-wrap.md          # 专属提问包装
│   ├── rules.md              # 业务规则与状态机约束
│   ├── glossary.md           # 业务术语表
│   ├── dbwords.md            # 数据库表与字段说明
│   └── thesaurus/
│       └── biz.txt           # 业务双语词林
├── .skills/
│   └── deploy-check/
│       └── SKILL.md          # 专属部署检查技能
└── .mcp.json                 # 项目专属 MCP 配置
```

---

## 5. 热生效说明

- **自动热生效**：`AGENTS.md`、`JEIKCODE.md`、`rules.md`、`glossary.md`、`dbwords.md`、`user-wrap.md`、`thesaurus/*.txt` 在每轮对话开始时自动读取最新内容，**无需重启或重载**。
- **需触发热生效**：修改项目级 `.mcp.json` 或 `.skills/` 后，需调用工具 `jeikcode_config(action="reload")` 或输入 `/mcp reload`、`/reload` 生效。
