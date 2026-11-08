# 05 - 工具与超时配置教程 (Tools & Timeouts)

配置文件路径：`~/.jeikcode/config.toml`。

---

## 1. 命令类工具硬寿命与空闲探测 (`[tools.bash]`)

控制 `run_command` 等生成子进程的执行超时与空闲体检：

```toml
[tools.bash]
max_timeout_secs = 1800         # 子进程硬上限（秒，默认 1800 = 30 分钟）。到期强制终止，模型无法覆盖
default_timeout_secs = 120      # 仅供用户 !cmd 省略超时参数时的默认超时（秒）
silent_kill_secs = 60           # 短命令复查间隔（秒）：到点只体检，不因安静等待就杀（0 为关闭复查）
second_levell_secs = 120        # 自动升档后的空闲窗口（秒）
long_bash_command_keyword = []  # 长任务关键词列表（如 ["build", "test"]）。匹配的命令豁免空闲复查，可跑至硬上限
```

短命令每到 `silent_kill_secs` 做一次体检：pager/REPL/全屏 TUI 指纹与前台常驻服务会被终止；CPU 忙碌则升为长任务；进程仍活着、CPU 空闲、没有新字节、也没有交互指纹时当作等待，继续跑到自己退出或 `max_timeout_secs`。

### 1.1 `run_command` 细微调用参数说明
- **后台常驻服务 (`"background": true`)**：
  - 前台运行常驻服务（`npm run dev`、`uvicorn` 等）会被空闲检测拦截终止。
  - 传入 `"background": true`（可配合选填 `"settle_secs": 3` 设置启动观察秒数，默认 3 秒）：观察期内若进程未秒退，立即返回 PID 与端口并将当前 Turn 完成，进程转入后台托管。启动回报会做**就绪体检**：逐端口探测 `127.0.0.1` 是否可连接（`Port: 8899 (accepting on 127.0.0.1)` / `(not reachable on 127.0.0.1 yet)`）；当“无输出且无端口”时明确标注 readiness **UNVERIFIED**——不再把“进程还活着”当作“启动成功”。
  - 后续每轮对话的 `<system-reminder>` 中会自动显示 `[Active Background Tasks]` 存活状态（含 `pid` 与停止命令）；若后台进程非零退出，会在下一轮触发一次性 `[Background Task Alert]` 告警。
  - 结束后台任务：**启动消息里直接给出可用的停止命令**。Windows 会同时回报两个真实 PID——工作负载的 `WinPID`（用于 `taskkill /F /T /PID <WinPID>`）与其 Git Bash PID（用于 `kill <GitBashPID>`）；两者都是真实进程号，`kill` 只认后者。推荐 `taskkill /F /T /PID <WinPID>`（`/T` 必需，否则子进程残留），或 `kill <GitBashPID>`（杀掉工作负载后包装 shell 会自然退出）。若消息只给出 `WinPID <包装 shell>`（尚未识别到子进程），仍用 `taskkill /F /T /PID <WinPID>` 整树终止。Unix 用 `kill -TERM -<pid>`（负号 = 整个进程组）。
- **Windows PowerShell 模式 (`"shell": "powershell"`)**：
  - `"shell": "default"`（默认）：通过 Git Bash / CMD 执行。
  - `"shell": "powershell"`：通过 64 位原生 PowerShell (UTF-16LE EncodedCommand) 执行，避免 Bash 路径转义，适合 UNC 网络共享路径（如 `\\192.168.1.10\share$`）或 PowerShell 专有命令。

### 1.2 路径解析与环境变量（内置工具）

- 内置工具（`read` / `grep` / `glob` / `edit` / `write` / `code_explore` 等）的路径参数与
  `run_command` **共用同一解析器**：支持 `~`、`$VAR` / `${VAR}`（Windows 另支持 `%VAR%`），
  以及成对引号包裹的形式（如 `"$TMPDIR/x"`）。
- 用 `"$TMPDIR"`（含 `"$TMP"` / `"$TEMP"`）而不是写死 `/tmp`，用 `"$DESKTOP"` 而不是假设
  `~/Desktop`：两者在 shell 内与**传给原生程序的参数**（python / node / curl）里都能直接用。
  `"$TMPDIR_WIN"` / `"$DESKTOP_WIN"` 是同一路径的备用名字（嵌套的非 bash shell 场景）。
- 未定义变量**原样保留**（绝不静默删除），因此写错变量名时路径会以相对形式落在工作区内并在
  报错信息中暴露，而不是逃逸到盘根。

### 1.3 grep / glob 搜索可见性

- 默认搜索源码、文档、测试、普通配置；构建产物/缓存/依赖默认忽略。
- `glob` 默认包含日志路径（只列路径）；`grep` 默认跳过日志内容。
- `include_ignored=true`：打开构建产物/缓存/依赖；grep 同时打开日志内容。
- `include_sensitive=true`：打开敏感凭据路径；Build/AcceptEdits/Plan 弹审核，Auto 自动继续。
- `read` 的显式路径不套 ignore；敏感路径统一走 `SensitivePathGate`。

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

## 3. 工具输出压缩策略 (`[tools.tool_output]`)

防止大输出占满上下文窗口。非豁免工具超过阈值即折叠并存为 `artifact`；完整文本落盘，模型按需调用 `read(path="artifact://<id>")` 按行或关键字取回：

```toml
[tools.tool_output]
max_bytes = 65536               # 通用压缩阈值（字节，默认 65536 = 64KiB；0 完全禁用压缩）
terminal_max_bytes = 24576      # 终端（run_command/bash）更早的压缩线（字节，默认 24KiB；0 表示跟随 max_bytes）
no_fold_tools = [               # 白名单工具列表：输出直接原样返回，绝不压缩
    "code_explore",
    "web_fetch",
    "web_search"
]
```

- 终端类工具的生效阈值 = `min(max_bytes, terminal_max_bytes)`；调低任意一项都会对终端收紧。
- 豁免工具（`no_fold_tools` 名单 + 工具自带 `never_truncate_result()`）完全跳过压缩。
- 两个阈值均支持 env 覆盖：`JEIKCODE_TOOL_OUTPUT_THRESHOLD_BYTES` / `JEIKCODE_TOOL_OUTPUT_TERMINAL_THRESHOLD_BYTES`（env 优先于 config.toml）。

---

## 4. 任务清单策略 (`[tools.todo]`)

```toml
[tools.todo]
enabled = true                  # 是否开启任务清单机制（支持环境变量 JEIKCODE_TODO 覆盖）
eager = "auto"                  # 积极度："auto" (按需识别) | "preferred" (高频提醒) | "always" (首轮强制创建)
```

---

## 5. 会话轮次与流式超时 (`[coding]`)

```toml
[coding]
max_rounds = 230                # 单会话模型思考交互最大轮次（0 表示无限制）
connect_timeout_secs = 10       # TCP/TLS 建连
open_timeout_secs = 180         # 等 HTTP 响应头（TTFB），不截断流式 body
ttft_secs = 180                 # 首个思考/正文/工具 token（别名 first_token_timeout_secs）
transition_secs = 180           # 思考结束到正文/工具首字
streaming_sliding_secs = 120    # 相邻业务 token 滑动窗口
first_token_timeout_retries = 3 # 首 Token 超时后自动重试次数
```

环境变量覆盖：`JEIKCODE_CONNECT_TIMEOUT_SECS`、`JEIKCODE_OPEN_TIMEOUT_SECS`、`JEIKCODE_TTFT_SECS`（或 `JEIKCODE_FIRST_TOKEN_TIMEOUT_SECS`）、`JEIKCODE_TRANSITION_SECS`、`JEIKCODE_STREAMING_SECS`（或 `JEIKCODE_STREAM_TIMEOUT_SECS`）。内容钟为 `0` 表示关闭该档。SSE ping / `ResponseId` / `Usage` 不重置内容滑动窗口。

---

## 6. 子代理并发控制 (`[subagent]`)

```toml
[subagent]
max_concurrent = 0              # 最大并发子代理数（0 表示不限制，默认；>0 表示上限）
max_rounds = 230                # 每个子代理最大交互轮次（0 表示无限制）
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
keep_interrupted_context = true # 按 Ctrl+C 中断时保留已生成上下文，方便无缝续接（WebUI / HTTP 回合始终开启）

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
