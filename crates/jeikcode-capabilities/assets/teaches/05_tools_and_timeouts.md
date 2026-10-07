# 05 - 工具与超时配置教程 (Tools & Timeouts)

配置文件路径：`~/.jeikcode/config.toml`。

---

## 1. 命令类工具硬寿命与空闲探测 (`[tools.bash]`)

控制 `run_command` 等生成子进程的执行超时与空闲终止：

```toml
[tools.bash]
max_timeout_secs = 1800         # 子进程硬上限（秒，默认 1800 = 30 分钟）。到期强制终止，模型无法覆盖
default_timeout_secs = 120      # 仅供用户 !cmd 省略超时参数时的默认超时（秒）
silent_kill_secs = 60           # 第一档空闲探测：无任何新输出满 60 秒时触发探测（0 为关闭）
second_levell_secs = 120        # 第二档宽限：有过输出但之后输出中断且 CPU 空闲时的等待秒数（0 为关闭宽限）
long_bash_command_keyword = []  # 长任务关键词列表（如 ["build", "test"]）。匹配的命令豁免空闲探测，可跑至硬上限
```

### 1.1 `run_command` 细微调用参数说明
- **后台常驻服务 (`"background": true`)**：
  - 前台运行常驻服务（`npm run dev`、`uvicorn` 等）会被空闲检测拦截终止。
  - 传入 `"background": true`（可配合选填 `"settle_secs": 3` 设置启动观察秒数，默认 3 秒）：观察期内若进程未秒退，立即返回 PID 与端口并将当前 Turn 完成，进程转入后台托管。
  - 后续每轮对话的 `<system-reminder>` 中会自动显示 `[Active Background Tasks]` 存活状态；若后台进程崩溃，会在下一轮触发一次性 `[Background Task Alert]` 告警。
  - 结束后台任务使用系统原生命令：`kill <pid>`（Windows 上为 `taskkill /F /PID <pid>`）。
- **Windows PowerShell 模式 (`"shell": "powershell"`)**：
  - `"shell": "default"`（默认）：通过 Git Bash / CMD 执行。
  - `"shell": "powershell"`：通过 64 位原生 PowerShell (UTF-16LE EncodedCommand) 执行，避免 Bash 路径转义，适合 UNC 网络共享路径（如 `\\192.168.1.10\share$`）或 PowerShell 专有命令。

---

## 2. 进程内短超时预算 (`[tools.timeouts]`)

控制内部检索、HTTP、Skill 模板及钩子的独立超时（与 bash 硬寿命隔离）：

```toml
[tools.timeouts]
search_secs = 72            # grep / glob 文件遍历超时（秒）
web_connect_secs = 12       # HTTP 连接超时（秒）
web_request_secs = 72       # web_fetch / web_search 请求单次超时（秒）
mcp_secs = 180              # MCP 单次工具调用超时（秒）
skill_cmd_secs = 40         # Skill 模板命令超时（秒）
hook_secs = 30              # Hook 钩子执行超时（秒）
fs_gate_secs = 36           # 权限校验与路径解析超时（秒）

[mcp.session]
idle_ttl_secs = 600         # scope="session" 的 MCP 进程闲置回收超时（秒，默认 10 分钟；0 为关闭回收）
```

---

## 3. 工具输出折叠策略 (`[tools.tool_output]`)

防止大输出占满上下文窗口：

```toml
[tools.tool_output]
max_bytes = 65536               # 输出折叠阈值（字节，默认 65536 = 64KiB；设为 0 完全禁用折叠）
no_fold_tools = [               # 白名单工具列表：输出直接原样返回，绝不折叠
    "fetch_output",
    "repo_map",
    "code_explore",
    "web_fetch",
    "web_search"
]
```

- 超过 `max_bytes` 的工具输出将截断为首尾预览并存入临时产物，模型需按需调用 `fetch_output` 提取完整文本。

---

## 4. 任务清单策略 (`[tools.todo]`)

```toml
[tools.todo]
enabled = true                  # 是否开启任务清单机制（支持环境变量 JEIKCODE_TODO 覆盖）
eager = "auto"                  # 积极度："auto" (按需识别) | "preferred" (高频提醒) | "always" (首轮强制创建)
```

---

## 5. 会话轮次与首 Token 超时 (`[coding]`)

```toml
[coding]
max_rounds = 200                # 单会话模型思考交互最大轮次（0 表示无限制）
first_token_timeout_secs = 60   # 首 Token 响应超时（秒，防大推理模型无响应死锁）
first_token_timeout_retries = 3 # 首 Token 超时后自动重试次数
```

---

## 6. 子代理并发控制 (`[subagent]`)

```toml
[subagent]
max_concurrent = 3              # 最大并发子代理数（默认 3）
max_rounds = 200                # 每个子代理最大交互轮次（0 表示无限制）
```

---

## 7. 网络代理 (`[network.proxy]`)

```toml
[network.proxy]
mode = "follow_system"          # 模式："follow_system" (跟随系统) | "default_proxy" | "no_proxy"
# http = "http://127.0.0.1:7890"
# https = "http://127.0.0.1:7890"
```

---

## 8. 中断保护与界面配置

```toml
# 顶层标量配置（必须在所有 [table] 之前）
keep_interrupted_context = true # 按 Ctrl+C 中断时保留已生成上下文，方便无缝续接

[ui]
theme = "auto"                  # 终端主题："auto" | "dark" | "light"
ai_session_naming = true        # 异步通过 AI 自动生成会话标题
```

---

## 9. 热生效说明与触发方式

- **不会自动热生效**：编辑保存 `~/.jeikcode/config.toml` 后不会自动重载。
- **热生效触发方式**：
  1. **Agent 端**：调用内置工具 `jeikcode_config(action="reload")`，当前回合结束后在下一轮对话立即生效。
  2. **用户端**：在 WebUI 或 TUI 终端中输入 `/reload` 命令即刻重新加载。
- 两种方式均**无需重启 JeikCode 进程**。
