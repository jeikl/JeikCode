# 模型上下文协议

JeikCode 原生支持 Anthropic 提出的 **Model Context Protocol (MCP)** 标准，允许将外部数据库、第三方 API、Chrome DevTools 自动化、文件系统等丰富工具无缝挂载给 Agent。

---

## 1. 配置文件定位与优先级

JeikCode 支持项目级与全局级双层 MCP 挂载：
1. **工作区项目级**：`<workspace>/.mcp.json`（版本控制友好，适合团队协同）；
2. **用户全局级**：`~/.jeikcode/mcp.json`（全局共享，所有项目均可访问）；
3. **优先级与覆盖**：同名服务配置时，项目级配置自动覆盖全局配置。

> 🛡️ **项目安全信任机制**：当首次打开一个未信任的项目时，项目级的 `.mcp.json` 默认处于 `blocked: untrusted project` 保护状态，防止恶意代码自动执行未知本地命令。你可以在 WebUI 侧栏中点击“信任本项目”，或在终端执行 `/mcp trust` 授权连接。

---

## 2. CLI 快速添加方式 (`jeikcode mcp add`)

除了手动编写 JSON 文件，JeikCode 提供了开箱即用的命令行工具快速添加 stdio 服务：

```bash
# 1. 添加到当前项目根目录的 .mcp.json
jeikcode mcp add playwright npx @playwright/mcp@latest

# 2. 添加到全局 ~/.jeikcode/mcp.json
jeikcode mcp add playwright npx -y @playwright/mcp@latest --global

# 3. 指定项目目录添加
jeikcode mcp add playwright npx @playwright/mcp@latest -C /path/to/repo

# 4. 添加 GitHub 官方远程 MCP (支持 OAuth 登录)
jeikcode mcp add-github-oauth github --global
jeikcode mcp login github
```

---

## 3. WebUI 界面与状态管理

在浏览器 WebUI 界面中，你可以更直观地管理 MCP 服务：
- **侧栏 MCP 面板**：点击侧边栏的 **MCP** 菜单，可直观查看已挂载的服务器连接状态（Running / Failed / Blocked）以及各自暴露的工具清单；
- **一键刷新重连**：修改 `mcp.json` 配置后，点击 MCP 面板右上角的**刷新按钮**即可热重载并重连，无需重启 JeikCode；
- **常用命令**：
  - `/mcp`：列出当前所有 MCP 服务及状态；
  - `/mcp reload`：重新读取配置并后台热重连；
  - `/mcp trust`：信任当前项目并放行项目级服务。

---

## 4. `scope` 两种生命周期隔离模式（⚠️ 核心关键）

在 `mcp.json` 的服务定义中，JeikCode 支持声明 `scope` 字段控制连接与进程的生命周期隔离：

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"],
      "scope": "session"
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "E:/code"],
      "scope": "project"
    }
  }
}
```

### 1. `scope: "project"`（默认模式）
- **项目级单例共享**：同一项目内所有前台、后台会话以及终端/WebUI 共享同一组 stdio 进程树和连接，避免重复通过 `npx` 启动多个冗余实例；
- **LRU 连接池管理**：内核的 `ProjectMcpPool` 默认维护最多 5 个项目的连接池，超出后自动 LRU 淘汰并安全 `shutdown` 旧项目的进程树；
- **适用场景**：无状态的数据查询、文件系统读写、网络搜索等通用服务。

### 2. `scope: "session"`（会话隔离模式）
- **独立进程与状态隔离**：每个活跃 coding session 拥有专属独立的 transport 与 stdio 进程，各会话互不影响；
- **自动环境变量注入**：JeikCode 会在启动该子进程前，自动安全注入环境变量 `JEIKCODE_SESSION_ID=<当前会话ID>`，便于服务识别调用归属；
- **适用场景**：带可变状态、浏览器上下文或需要会话路由的服务（如 Chrome DevTools、Playwright、带登录态的自动化工具）。

---

## 5. 进程回收与闲置超时机制

为了防止长期挂载的大量外部 MCP 进程持续占用系统内存与文件句柄，JeikCode 内置了智能的闲置进程回收机制：

- **空闲超时配置**：在 `config.toml` 中通过 `[mcp.session] idle_ttl_secs` 配置（**默认 600 秒 / 10 分钟**）；
- **滑动窗口刷新**：仅在实际执行工具调用（`call_tool` 的 begin/end）时才会刷新活跃时间窗口，普通的 schema 查询或列出工具不会重置计时器；
- **优雅停机与懒启动**：当会话切走（无活跃 lease）且闲置超过 10 分钟后，JeikCode 会安全关闭该会话的 MCP 进程树（Windows 使用 kill-on-close Job Object，Unix 关闭独立进程组）释放内存；工具元数据目录仍保留缓存，当下次再次调用该工具时会自动**懒加载重启（Lazy Restart）**；
- **彻底回收**：会话被删除或 JeikCode 退出时，所有挂载的 MCP 进程树会立即无条件销毁。设置 `idle_ttl_secs = 0` 则关闭闲置回收。

---

## 6. 并发控制与背压保护 (`maxConcurrentCalls`)

在 JSON-RPC 通信中，JeikCode 支持在配置中通过 `maxConcurrentCalls` 限制并发调用深度（支持 1~64，默认值为 `8`）：
- **有状态服务**（如浏览器操控、设计器交互）：建议显式配置为 `1`，确保调用严格按时序串行执行；
- **无状态服务**（如知识库搜索、多并发 API）：保留默认值 `8`，享受多路复用并发加速。
