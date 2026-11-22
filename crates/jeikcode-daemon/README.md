# jeikcode-daemon

JeikCode 的 HTTP/SSE 服务端，提供会话、流式聊天、配置、Provider、MCP 与兼容 API。它既可以作为独立二进制运行，也可以由已发布的 `jeikcode` CLI 通过内置 `daemon` 子命令直接启动（发布资产只有 `jeikcode`，不单独分发本二进制）。

基于 [Axum](https://github.com/tokio-rs/axum) 构建。

---

## 快速开始

```bash
# 独立二进制（源码构建）
cargo build -p jeikcode-daemon
cargo run -p jeikcode-daemon -- --host 127.0.0.1 --port 13456

# 发布版 CLI 的等价入口（无需额外二进制）
jeikcode daemon --host 127.0.0.1 --port 13456 --token sk-your-secret
```

> `jeikcode --host ...` 与 `jeikcode serve ...` 也会启动同一套服务，并在启动横幅中打印**当前版本权威的 API 端点清单**；本 README 只列常用路由。

### 启动参数

| 参数 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `--host` | `127.0.0.1` | 绑定地址；`0.0.0.0` 可供局域网访问 |
| `--port` | `13456` | 监听端口 |
| `--token` | 无 | 固定访问 token；绑定非 loopback 地址时必需 |
| `--no-telemetry` | 关闭 | 本次进程禁用遥测 |
| `--idle-timeout` | `1800` | 无活动自动退出秒数；`0` 禁用，非零值最小 60 |
| `--client` | `ide` | 遥测客户端标识（`vscode` / `jetbrains` / `webui` / `jeikcode-air`） |

### 环境变量

| 变量 | 说明 |
| :--- | :--- |
| `JEIKCODE_SERVER_TOKEN` | 访问 token；可替代 `--token` |
| `JEIKCODE_DAEMON_IDLE_TIMEOUT` | 覆盖空闲退出秒数（`0` 禁用） |
| `JEIKCODE_DAEMON_ENABLE_DANGEROUS_TOOLS` | 设为 `1` 时允许 daemon 会话启用 bash / 写文件工具 |

> 安全边界：绑定非 loopback 地址时，缺少 token 会拒绝启动（fail-closed）。

---

## 常用 API

所有接口返回 JSON；聊天走 SSE。基础路径为 `http://<host>:<port>`。

| 分组 | 路由 |
| :--- | :--- |
| 健康 / 生命周期 | `GET /health`、`POST /shutdown` |
| 项目 | `GET /project`、`POST /cd`、`GET /projects` |
| 会话 | `GET/POST /sessions`、`GET /sessions/search`、`GET /sessions/by-working-dir`、`POST /sessions/:id/fork`、`GET /sessions/:id/messages`、`POST /sessions/:id/seen` |
| 项目会话 | `GET /projects/:hash/sessions`、`GET/DELETE /projects/:hash/sessions/:id`、`PATCH .../rename`、`POST .../repair`、`POST .../fork`、`POST .../truncate`、`GET .../lineage`、`GET .../freshness` |
| 模型 | `GET /models`、`GET /v1/models` |
| 聊天 | `POST /chat`（SSE）、`POST /chat/stop`、`GET /chat/active`、`GET /chat/pending`、`POST /chat/permission`、`GET /chat/queue`、`POST /chat/queue/claim`、`POST /chat/queue/release`、`GET /chat/runtime`、`POST /chat/user-input`、`GET /chat/watch` |
| 配置 | `GET /config`、`POST /config`、`POST /config/reload` |
| Provider | `GET/POST /providers`、`PATCH/DELETE /providers/:name`、`POST /providers/:name/default`、`PATCH /providers/:name/thinking`、`GET /providers/upstream-models` |
| MCP | `GET /mcp/status`、`POST /mcp/reload` |
| 兼容协议 | `POST /v1/messages`（Anthropic）、`POST /v1/responses`（OpenAI Responses）、`GET /v1/models` |

### 健康检查

`GET /health` 返回构建版本与固定服务名：

```json
{
  "status": "ok",
  "version": "<current build version>",
  "service": "jeikcode-daemon"
}
```

### CORS

允许 loopback 以及 RFC1918 / link-local 私网来源，便于手机或其他局域网设备直接访问 WebUI；公网来源不在允许列表内。需要跨公网时请使用反向代理与 TLS。

---

## 内置工具

daemon 会话可用的工具与主 Agent 一致（名称大小写敏感）：

| 工具 | 说明 |
| :--- | :--- |
| `run_command` | 执行终端命令（别名 `bash`） |
| `read` | 读取文件/目录（别名 `read_file`） |
| `write` | 写入文件（别名 `write_file`） |
| `edit` | 精确文本替换（别名 `edit_file`） |
| `parallel_edit` | 并行编辑多个文件 |
| `glob` / `grep` | 文件匹配 / 内容搜索 |
| `todo_write` / `task` | 任务清单 / 子代理 |
| `web_fetch` / `web_search` | 网络抓取 / 搜索 |
| `code_explore` | 语义代码图谱检索 |
| `use_skill` | 调用已安装 Skill |
| `jeikcode_config` | 配置指南查询与热重载 |

---

## 项目结构（节选）

```
jeikcode-daemon/
├── Cargo.toml
└── src/
    ├── main.rs             # 独立二进制入口（参数解析 → run_server）
    ├── lib.rs              # 路由、聊天流、会话与运行时编排
    ├── compat_api.rs       # OpenAI / Anthropic 兼容端点
    ├── api_config.rs       # 配置接口
    ├── api_provider.rs     # Provider 管理
    ├── api_git.rs          # Git 相关接口
    ├── api_schedule.rs     # 定时任务接口
    ├── api_update.rs       # 更新接口
    ├── auth_token.rs       # WebUI token 存储
    ├── live_api.rs         # 实时会话/事件
    ├── native_live.rs      # 进程内 TUI ↔ WebUI 绑定
    ├── runtime_host.rs     # 运行时宿主
    └── webui.rs            # rust-embed 内嵌 WebUI 静态资源
```

> 认证/登录与 CodingPlan 初始化端点已不再由 daemon 暴露；登录由 CLI/TUI 的 `/login` 与 `auth.toml` 完成。

## 配置文件

| 文件（`~/.jeikcode/`） | 说明 |
| :--- | :--- |
| `config.toml` | 主配置（Provider、默认工作目录等） |
| `mcp.json` | MCP 服务器配置 |
| `auth.toml` | 认证信息（CLI `/login` 写入） |
| `webui-listen.json` | 最近一次 WebUI 监听 host/port/token |
| `sessions/` | 会话快照与转录 |
