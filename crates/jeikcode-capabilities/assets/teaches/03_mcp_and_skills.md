# 03 - MCP 与 Skills 技能配置指南 (MCP & Skills)

---

## 1. MCP (Model Context Protocol) 外部工具集成

### 1.1 配置文件定位与优先级
1. **工作区项目级**：`<workspace>/.mcp.json`（仅对当前项目生效，版本控制友好）。
2. **用户全局级**：`~/.jeikcode/mcp.json`（全局共享，所有项目均可访问）。
3. **优先级**：同名配置下，项目级覆盖全局级。

### 1.2 CLI 快速添加 MCP 工具
使用 `jeikcode mcp add` 命令行添加（自动写入 JSON，无需手动编辑）：

```bash
# 写入当前项目 .mcp.json
jeikcode mcp add playwright npx @playwright/mcp@latest

# 写入全局 ~/.jeikcode/mcp.json
jeikcode mcp add playwright npx -y @playwright/mcp@latest --global

# 指定工作区目录
jeikcode mcp add playwright npx @playwright/mcp@latest -C /path/to/repo

# GitHub 官方 OAuth MCP
jeikcode mcp add-github-oauth github --global
jeikcode mcp login github
jeikcode mcp logout github
```

### 1.3 `mcp.json` 标准配置格式

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "E:/code"],
      "env": {
        "DEBUG": "false"
      },
      "maxConcurrentCalls": 8,
      "scope": "project",
      "disabled": false
    },
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"],
      "maxConcurrentCalls": 1,
      "scope": "session"
    }
  }
}
```

### 1.4 核心参数细微差异说明

- **`scope` 范围模式（`"project"` vs `"session"`）**：
  - `"project"`（默认）：项目级共享单例。同项目下所有会话复用同一子进程，生命周期跟随项目，不会被闲置回收。适合无状态工具（如 filesystem、git、搜索）。
  - `"session"`：会话级独立隔离。每个会话单独启动一个独立子进程，并自动向子进程注入环境变量 `JEIKCODE_SESSION_ID=<当前会话ID>`。适合浏览器（Playwright）、有状态调试器等需要会话隔离的工具。
  - **进程闲置回收**：在 `scope: "session"` 模式下，当会话切走且距离上次工具调用超过 `[mcp.session] idle_ttl_secs`（默认 600 秒 / 10 分钟）时，系统会自动回收终止该进程释放资源；下次该会话再次调用工具时自动懒加载拉起重启。在 `config.toml` 中设置 `idle_ttl_secs = 0` 可关闭闲置回收。
- **`maxConcurrentCalls` 并发调用上限**：
  - 允许范围 1~64（默认 8）。
  - 无状态读取类服务保留默认 8 并发；
  - 浏览器控制（Playwright、Puppeteer）等带独占状态的工具建议显式设为 `1`，避免并发操作冲突。
- **`disabled` 临时禁用**：
  - 设为 `true` 即可临时停用该服务而无需删除配置。

### 1.5 重载与生效方式

修改配置后**无需重启 JeikCode 进程**：

| 操作途径 | 命令 / 动作 | 说明 |
| :--- | :--- | :--- |
| **Agent 工具** | `jeikcode_config(action="reload")` | 修改文件后调用；当前回合结束后重载，新工具在下一轮生效。 |
| **终端命令** | `/mcp reload` | WebUI / TUI 重新读取配置并后台重连。 |
| **WebUI 界面** | 侧栏 MCP 菜单的「刷新按钮」 | 点按即可即时重新挂载。 |
| **状态查看** | `/mcp` | 列出当前所有 MCP 服务连接状态。 |
| **信任授权** | `/mcp trust` | 首次在未信任项目中使用项目级 `.mcp.json` 时需授权信任。 |

---

## 2. Skills 技能系统

Skills 允许以 Markdown + YAML 方式为 Agent 注入特定工程工作流。

### 2.1 目录定位与优先级
按以下优先级由高到低搜索（高优先级同名覆盖）：
1. **项目专属**：`<workspace>/.jeikcode/skills/<name>/SKILL.md` 或 `<workspace>/.skills/<name>/SKILL.md`
2. **全局用户**：`~/.jeikcode/skills/<name>/SKILL.md`
3. **插件市场**：`~/.jeikcode/plugins/marketplaces/...`

### 2.2 `SKILL.md` 标准格式

每个技能为一个独立目录，入口必须命名为 `SKILL.md`：

```markdown
---
name: feature-reviewer
description: 专精于代码审查与架构规范检查。当用户要求 review 代码或检查规范时激活。
---

# 技能执行指南

## 1. 核心流程
1. 首先使用 `code_explore` 定位相关改动文件。
2. 运行测试套件验证行为完整性。

## 2. 约束规则
- 遵循单一职责与错误码规范。
```

### 2.3 渐进式子目录（推荐）
- `SKILL.md`：核心流程与描述（精简，100~300 tokens）。
- `references/`：放详细技术文档、API 参考（Agent 按需 `read` 查阅）。
- `scripts/`：放辅助脚本或模板。

### 2.4 查看与重载
- 在 WebUI 或 TUI 输入 `/skills` 浏览当前已挂载技能。
- 新增或修改 `SKILL.md` 后，调用工具 `jeikcode_config(action="reload")` 或输入 `/reload` 即可在下一轮生效。

---

## 3. Plugins 插件管理

- 插件主目录：`~/.jeikcode/plugins/`。
- 在 TUI 输入 `/plugin` 交互式浏览、安装与卸载插件。
- 安装或更新插件后调用工具 `jeikcode_config(action="reload")` 立即生效，无需重启。
