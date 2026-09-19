# 05 - 工具策略、超时与系统控制配置指南 (Tools, Timeouts & Policies)

全局配置文件路径：`~/.jeikcode/config.toml`。

---

## 1. 命令类工具硬寿命 (`[tools.bash]`)

**所有会 spawn 子进程并等待结束的工具** 共用 `[tools.bash] max_timeout_secs` 这条硬寿命，模型不要再传 per-call `timeout`：

- `run_command`：一直跑到退出、短命令空闲杀（`silent_kill_secs`）或硬上限；输出全程实时流式。一批多个非破坏性 run_command 会并行，先结束的先完成。
- `web_fetch` 的 curl 回退路径
- `parallel_edit_files` 的构建探测
- 用户 `!cmd` / `run_shell`：调用方超时再被此值封顶

```toml
[tools.bash]
max_timeout_secs = 1800         # 从启动算，子进程最长活多久（默认 30 分钟）；到点杀并返回超时说明（bash 保留已有输出）
default_timeout_secs = 120      # 仅用户 `!cmd` 省略超时时的默认墙钟；模型 run_command 不读
silent_kill_secs = 60           # 第一档探测空闲（默认 60）。没新字节再看 CPU
second_levell_secs = 120        # 第二档：有过输出但 CPU 空时，再等这么久。磁盘/网络 IO 不自动升长任务，二轮后交给模型。`0` 关闭宽限
long_bash_command_keyword = []  # 全局长任务关键字（整词）。覆盖内置短分类。long_bash_keyword_actions 默认只进本会话 sidecar（重启 resume 仍在），global=true 才写这里
```

模型常把多条命令用 `&&` / `;` 写进一次 `run_command`。其中一条如果是分页器、follow/watch（`tail -f`、`journalctl -f`、`watch`）、REPL，或 `systemctl status` 打出结果后还在等键盘 / Ctrl+C，后面的命令永远不会跑，整段会一直占着直到 `silent_kill_secs` 或 `max_timeout_secs`。工具会把**已经打出来的输出**一并返回。

应对：

- 短命令空闲杀：改 `silent_kill_secs`（默认 60；`0` 关闭）。
- **不在名单里的命令一律按短命令（探测）**。空闲到期再看进程组：**只有 CPU 在跑才自动升为批次**。磁盘 IO / 网络 IO（包括 ESTABLISHED 但不再传数据）**不**自动升长任务，走第一档 + `second_levell_secs` 第二档；两档都空闲且已经有过输出 → `[bash-await-decision]`，提示模型：网络/磁盘 IO 很可能已经超时，优先 `bash_kill_by_id`；慎重确认还在干活再用 `long_bash_keyword_actions` action=add 做**本次会话临时**长任务。完全空闲且从未输出 → 杀掉 pager。LISTEN 上的空闲服务（uvicorn/nginx）走常驻收回。
- **常驻服务与后台任务**（uvicorn / nginx / `npm run dev` / 无 `-d` 的 `compose up`）：
  - **推荐使用后台模式**：调用 `run_command` 时传入 `"background": true`（可配合选填 `"settle_secs": 3` 指定启动观察秒数，默认 3 秒）。工具会在观察期（Settle Period）先探测进程是否秒退（如端口冲突、语法错误）；若平稳存活则返回初始日志与 `bashid`（如 `b-00000001`）并让当前 Turn 立即完成返回，进程转入后台托管运行。
  - **跨 Turn 被动状态感知**：后台运行的任务会在后续轮次的 `<system-reminder>` 中以 `[Active Background Tasks]` 显示其存活状态与运行秒数；若后台任务意外崩溃，会在下一个 Turn 的 `<system-reminder>` 触发一次性的 `[Background Task Alert]` 崩溃告警（包含退出码与最近报错输出），并在本轮消费后自动清空消失。
  - **停止后台任务**：后续调用 `bash_kill_by_id` 传入对应的 `bashid` 即可干净终止整个子进程树。
  - **前台误跑拦截**：若未开启 `background: true` 在前台直接跑常驻服务，系统会在 CPU 空闲时自动拦截收回，提示改用 `background: true` 或 detached 运行。不要对常驻服务做 `long_bash_keyword_actions`。
- 批次按**子命令分别识别**：`cargo test` / `javac` / `docker build` 为长；`docker ps` / `go env` 为短。链条里有一条批次，整段不走探测空闲。
- `long_bash_keyword_actions`：`action=add|delete`，`keyword`，`global` 默认 false。false 写入当前会话 `<id>.bashkw.json`（重启 JeikCode 后 `/resume` 同一会话仍生效）；`global=true` 才写入 `long_bash_command_keyword`。会话临时列表非空时会打进当日 `<system-reminder>`。
- 端口/服务探测用 `ss`/`lsof` 和 `systemctl is-active`/`show`，不要对很大的 slice/root unit 跑 `systemctl status`。
- 一次性标志：`--no-pager`、`-n`、`-c`、`--batch`。不要把会阻塞的命令和后续步骤写在同一条 `run_command` 里。
- `run_command` 会给子进程强制 `PAGER=cat`、`GIT_PAGER=cat`、`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`，避免 git pager / Credential Manager 把 TUI 的键盘抢走。模型仍应写 `git --no-pager` / `git status -sb`，不要依赖分页器。
- 链条里只要有一条长任务，整次调用都不走空闲杀（`cargo test && systemctl status` 会等到硬上限）。

下列 **不是** 这条硬寿命，走 `[tools.timeouts]`（分层，不要并进 1800s）：

- 进程内 `grep` / `glob` 搜索
- `web_fetch`：连接短、收包空闲短；整段下载硬上限仍是 `max_timeout_secs`（慢网但还在传不杀）
- `web_search`：整请求预算
- MCP：`mcp_secs` 是**单次调用**空闲预算（无新帧 / 无 `notifications/progress` 才杀）；有进度则等到 `max_timeout_secs`。`scope=session` 进程闲置回收是另一项：`[mcp.session] idle_ttl_secs`（默认 600；切走后距上次 `call_tool` 的滑动窗口，探测/`tools/list`/连接不刷新；仍挂着的 runtime 与正在跑的调用不杀）
- skill 模板 `` !`cmd` ``
- CC hooks（默认 + 封顶）
- 权限门 hung-FS canonicalize

Windows 上 `run_command` 工具支持可选的 `shell` 调用参数：

- `"shell": "default"`：默认行为，使用 Git Bash/MSYS2；未安装时回退到 `cmd.exe`。
- `"shell": "powershell"`：直接启动 PowerShell，并通过 UTF-16LE `EncodedCommand` 传递脚本，不经过 Bash/cmd 二次解析。访问 UNC 或隐藏共享时应配合单引号和 `-LiteralPath`，例如 `Get-ChildItem -LiteralPath '\\192.168.5.50\erp_code$'`。

原生 PowerShell 模式只解决解释器边界与参数保真问题；工具的超时、取消、进程树回收及危险/写入型命令审批策略保持不变。

---

## 1.1 短超时预算 (`[tools.timeouts]`)

进程内搜索、HTTP、skill 模板命令、hooks 的墙钟。缺省即推荐值；不要配得太短（大仓库/代理会误杀），也不要配成命令硬寿命。

```toml
[tools.timeouts]
search_secs = 72            # grep / glob 遍历（Grok WSL 60s +20%）
web_connect_secs = 12       # HTTP 连接（Grok 10s +20%）
web_request_secs = 72       # web_fetch：两次收包之间的空闲；web_search：整请求（Grok 60s +20%）
mcp_secs = 180              # MCP 单次调用空闲预算；有 progress 则等到 max_timeout_secs
skill_cmd_secs = 40         # skill 模板 !`cmd`
hook_secs = 30              # CC hook 缺省超时，也是上限（Grok 观察类默认 5s）
fs_gate_secs = 36           # 权限门 canonicalize（Grok 30s +20%）
```

```toml
[mcp.session]
idle_ttl_secs = 600         # scope=session：切走后距上次 call_tool 多久回收（默认 10 分钟，滑动窗口）。探测/list/连接不刷新。0 关闭
```

---

## 2. 工具大输出折叠与代码探索核心工具体系

### 2.1 大输出折叠与预览策略 (`[tools.tool_output]`)

防止 `run_command` 或大型工具输出瞬间占满上下文窗口。这是 **通用折叠**（头尾预览 + `fetch_output`）：

```toml
[tools.tool_output]
max_bytes = 65536               # 输出折叠阈值（默认 64KiB = 65536 字节）。超过此大小的输出将自动折叠为头尾预览并存入临时 Artifact（可通过 fetch_output 提取完整内容）；设为 0 完全禁用折叠
no_fold_tools = [               # 白名单工具列表：以下工具的输出无论多大均直达模型，绝不折叠
    "fetch_output",
    "repo_map",
    "code_explore",
    "web_fetch",
    "web_search"
]
```

### 2.2 代码探索与定位核心工具体系 (`glob` / `grep` / `read_file`)

核心工具链采用**漏斗式检索**体系（Funnel Pipeline：`glob` → `grep` → `read_file` 定向切片），杜绝大模型在代码检索中陷入贪婪机械翻页与死循环：

1. **`glob`（文件名模式匹配）**：
   - 支持标准 glob 通配符（如 `**/*.rs`）。
   - **时间倒序排序（mtime descending）**：搜索结果严格按文件最后修改时间倒序排列（最近修改优先），优先展示当前活跃开发与热点代码。
   - 自动忽略构建缓存与版本控制目录（`target/`, `node_modules/`, `.git/` 等）。

2. **`grep`（代码内容与符号极速检索）**：
   - 进程内基于 ripgrep 引擎驱动，快速检索精确字面量、错误字符串与代码符号。
   - **输出模式 (`output_mode`)**：
     - `"content"`（默认）：返回匹配行及行号。
     - `"files_with_matches"`：仅输出匹配的文件路径，单个文件首次命中即短路跳过，用于跨仓库快速圈定受影响文件。
     - `"count"`：仅统计各文件命中次数。
   - **就地上下文行预览 (`-A` / `-B` / `-C`)**：
     - `after_context` (`-A`)：匹配行后的行数。
     - `before_context` (`-B`)：匹配行前的行数。
     - `context` (`-C`)：前后对称行数。
     - **优势**：允许模型直接在 grep 结果中获知函数签名、分支逻辑等就地上下文，免去冗余的 `read_file` 调用。
   - **语言类型过滤 (`type`)**：支持按语言别名（`rust`, `ts`, `py`, `go`, `json`, `yaml` 等）精准过滤。

3. **`read_file`（精准切片阅读与大文件防护）**：
   - **稀疏行号锚点（Sparse Line Anchors）**：
     - 首行标记 `1→`，后续仅逢十标记行号（如 `10→`, `20→`），其余行输出纯内容。在保留编辑定位坐标的同时节省 30%~40% 的 Token。
   - **1500 行默认单页防护（Bounded Page）**：
     - 未指定切片范围时默认单页上限 1500 行，绝大多数配置文件和常规源码可一屏完整读出；超过 1500 行时截断并附带中立警示 `Showing lines 1-1500 of total. Avoid reading large files end-to-end... (Next offset: 1501)`，杜绝显式提示剩余行数以消除信息焦虑，并指导模型优先使用 `grep` 定位。触底读完时标注 `(End of file)` 杜绝模型向下试探。
   - **彻底废除连续翻页 JSON 模板与祈使命令**：
     - 移除旧版诱导模型无限翻页的 `read_file({"file_path":...})` JSON 页脚及 `Use offset=... to continue` 祈使句，将下一偏移降级为非指令属性 `(Next offset: ...)`，防止模型陷入机械翻页死循环与上下文耗尽。
   - **跨平台绝对路径判定**（`read_file` / `write_file` / `edit_file` / `grep` / `glob` / `change_dir` / `repo_map` / `code_explore` 共用 `pathutil::resolve_path`）：
     - POSIX `/…`、Windows 盘符 `C:\` / `C:/`、UNC `\\server\share` 在 Linux / macOS / Windows 一律视为绝对路径，禁止拼到工作区下面。
     - Windows 上 Git Bash 的 `/tmp/foo` 映射到 `%TEMP%\foo`（避免工作区在 `E:` 时误解析为 `E:/tmp/foo`）；`/c/Users/...`、WSL `/mnt/c/...`、Cygwin `/cygdrive/c/...` 映射为 `C:/Users/...`。
     - Unix 上 `/tmp/foo` 保持原生 `/tmp/foo`，不会改写成 `$TMPDIR`。

### 2.3 精准代码编辑与容错自愈 (`edit_file`)

`edit_file` 支持字符串级精确替换与多级容错自愈机制：
1. **多层智能容错自愈体系**：
   - 包含去箭头前缀（`1→`）、行两端空白宽容（`line-trimmed whitespace`）、Unicode/符号与空白归一化（`token-normalized`）、注释折叠对齐（`comment-style`）、块级首尾锚点对齐（`anchored block`）以及边界上下文宽容（`trimmed boundary`）。
2. **空间维度：同批多 Hunk 拓扑调序（Topological Reordering）**：
   - 当单个 `edit_file` 请求包含多个改动块（`edits`）时，自动进行读取与写入区间依赖分析（WAR：Write-After-Read）。
   - 若某 Hunk 仅读取某行作为上下文，而另一 Hunk 重写了该行，系统自动让“只读上下文”的 Hunk 优先应用，彻底解决顺序踩踏；非交叠 Hunk 统一采用自底向上（按行号降序）执行，防止上方改动导致下方偏移。
3. **时间维度：轻量 Git 状态机（`VersionRing` + 3-Way Auto-Rebase）**：
   - 内存中为每个活跃文件维护最近 32 个改动快照（`VersionRing`），并对首次观测的原始底本（$V_0$）进行永久锚定锁定，绝不被滑动挤出。
   - 在高频“改代码 $\to$ 跑测试 $\to$ 报错 $\to$ 再改代码”循环中，若模型注意力时空穿梭、使用前序轮次甚至会话最初的旧代码作为 `old_string`，系统自动检索历史快照并通过 3-Way Auto-Rebase 算法将修改变基合入当前文件，零感救活。
4. **冲突自动安全修改提示**：
   - 当触发容错自愈或历史变基时，工具输出带显式指令提示：
     `⚠️ **[自动安全修改提示]**：你的 old_string 存在冲突，已为你自动执行成功后的安全修改，请你下次如果修改涉及到这块old str 请记得使用新的old str 不用去读源文件。`
     并附带当前位置最新的实际 `old_string` 文本与修改后的生效差异（Unified Diff），彻底避免模型因不确定性而陷入重复调用 `read_file` 的低效死循环。
5. **失配局部 TextDiff 辅助定位**：
   - 当 `old_string` 完全无法匹配（相似度 $\ge 30\%$）时，自动生成期望与文件现状的紧凑 Unified Diff，指引模型直接校准 `old_string`，无需重新全盘通读源文件。

### 2.4 全写状态机与未读拦截自愈 (`write_file`)

为杜绝模型在多轮长会话中因注意力漂移直接盲目覆盖覆写已存在的文件，`write_file` 内置基于独立轮次隔离的文件状态机：
1. **新建文件无感放行**：
   - 当目标文件在磁盘上尚不存在时，判定为创建新文件，不受状态机拦截，直接放行写入创建。
2. **每轮独立与已读状态持久性**：
   - 只要在对目标已存在文件的第一次 `write_file` 之前，最后一次文件操作是 `read_file`，即视为已读取确认，状态持续有效直至本轮 agent turn 结束（同一轮内后续继续调用 `write_file` 无需重复 `read_file`）。
   - 下一轮用户发起新交互（新 Turn）时，已读状态全部重新归 0。
3. **未读拦截与自动附赠内容**：
   - 若模型尝试覆盖写入处于未读取状态的已存在文件，系统直接拦截写入（磁盘保持原状），并给出强安全指令：`请读取确认欲写入文件内容后再写入`。
   - 随拦截响应直接返回目标文件最新前 1500 行（默认分页 limit）带有稀疏行锚点（`1→`, `10→`...）的内容；
   - 若文件超过 1500 行发生截断，明确提示剩余行数，要求模型使用 `read_file` 全部读取确认后再写入。

---

## 3. 任务清单策略 (`[tools.todo]`)

```toml
[tools.todo]
enabled = true                  # 是否开启任务清单机制（支持 JEIKCODE_TODO 环境变量覆盖）
eager = "auto"                  # 积极程度："auto" (按需模型识别) | "preferred" (高 recency 提醒) | "always" (首轮强制创建)
```

---

## 4. 主 Agent 轮次与首 Token 超时控制 (`[coding]`)

```toml
[coding]
max_rounds = 200                # 单轮会话模型思考交互的硬上限（检查点门限，0 表示无限制，可通过 JEIKCODE_TURN_MAX_ROUNDS 覆盖）
first_token_timeout_secs = 60   # 首 Token 响应超时（秒）：等待模型返回首个数据块的最大耗时（防止大推理模型静默死锁）
first_token_timeout_retries = 3 # 首 Token 超时后的自动重试次数
```

---

## 5. 子代理并发与轮次 (`[subagent]`)

针对 `task` 工具派生的并发子 Agent 限制：

```toml
[subagent]
max_concurrent = 3              # 最大并发子代理数（默认 3）
max_rounds = 200                # 每个子代理执行任务的最大交互轮次（0 表示无限制）
```

---

## 6. 网络代理 (`[network.proxy]`)

语义探索用 `code_explore` / `repo_map`，不再挂载语言服务器工具。

```toml
[network.proxy]
mode = "follow_system"          # 代理模式："follow_system" (跟随系统) | "default_proxy" | "no_proxy"
# http = "http://127.0.0.1:7890"
# https = "http://127.0.0.1:7890"
```

---

## 7. 会话审计、UI 与中断保护

```toml
# 顶层中断保护开关（必须置于顶层）
keep_interrupted_context = true # 按 Ctrl+C 中断时，保留已生成的上下文并安全闭合 tool_calls，方便下一句无缝续接

[datalog]
enabled = true                  # 是否记录全量结构化执行审计日志
dir = "~/.jeikcode/datalog"

[ui]
theme = "auto"                  # 终端主题："auto" | "dark" | "light"
ai_session_naming = true        # 自动通过 AI 为会话生成简明标题（未完成命名时异步并行生成）
terminal_status_glyph = true    # 终端标题栏显示状态圆点（🟢空闲/🟡运行/🔴待审批）
truncate_resumed_history = true # 恢复长会话时截断超长历史展示以防终端卡顿
```
