# Changelog

<!--
【发版标准模板 / Release Notes Standard Template】
发版时在此顶部追加版本块。格式严格要求：
1. 先写完整英文段落（English Section）；
2. 插入分割线 `---`；
3. 再写完整中文段落（Chinese Section）。
模型与维护者直接按此结构填入内容即可。

## vX.Y.Z (YYYY-MM-DD)

- **[Module/Category in English] Main summary sentence in English**:
  - **Technical Root Cause / Detail**: Detailed technical explanation...
  - **Implementation Mechanism**: Affected files, functions, and defensive logic...
  - **Verification & Testing**: Tests executed and coverage details...

---

- **[模块分类中文] 中文概述主标题**:
  - **技术机理 / 现象溯源**: 详细原理解释...
  - **实现防线 / 核心改动**: 受影响文件、核心函数与端到端防线建设...
  - **验证与交付**: 运行的单元测试与端到端验证...
-->

## v7.2.1-beta.5 (2026-10-09)

- **[Performance & Cold-Start Acceleration] Static Asset HTTP Cache-Control, Dynamic Code Splitting, and Deferred Initialization**:
  - **Tiered HTTP Cache-Control for Embedded Assets**: Introduced standard Cache-Control headers in `crates/jeikcode-daemon/src/webui.rs`. Static hashed bundle assets under `/assets/*` are now marked with `Cache-Control: public, max-age=31536000, immutable`, enabling 0ms instant disk cache loading for both Tauri desktop shell (WebView2) and remote browser clients. Entry `index.html` strictly enforces `Cache-Control: no-cache` to guarantee atomic and immediate version updates without stale cache retention.
  - **Dynamic Lazy Loading & Code Splitting**: Extracted heavy secondary panels and dialogs (`GitPanel`, `DiffViewer`, `SettingsDialogs`, `UpdateDialog`, `ConfigSyncModal`, `OnboardingWizard`) into independent asynchronous chunks via `preact/compat` `lazy()` with smooth `<Suspense>` fallbacks, reducing the initial JavaScript main bundle from 894 kB down to 824 kB (over 70 kB core bundle reduction).
  - **Non-Critical Startup Deferred Execution**: Shifted post-upgrade configuration diff checks (`fetchUpgradeDiffs`) and update polling away from initial render frames, deferring them by 1.5 seconds to eliminate CPU and network contention during cold start first-paint.
  - **Remote Chunk Resilience**: Registered a global `vite:preloadError` listener in `webui/src/main.tsx` to automatically self-heal and refresh remote or LAN clients when server daemon upgrades invalidate stale chunk hashes.

---

- **[性能优化与冷启动加速] 嵌入式静态资源 HTTP 强缓存、前端动态按需分包与启动错峰调度**:
  - **嵌入式资源动静分级 HTTP 强缓存**: 在 `crates/jeikcode-daemon/src/webui.rs` 中为内嵌静态资源注入工业级 Cache-Control 响应头。`/assets/*` 目录下带内容哈希的静态文件（JS/CSS/字体）配置 `public, max-age=31536000, immutable`，实现桌面外壳（WebView2）与远程浏览器二次冷启动 0 毫秒磁盘直出；入口 `index.html` 强制 `no-cache`，确保发版更新时原子级无缝生效，绝不残留旧缓存。
  - **核心主包瘦身与模态框动态懒加载**: 将非首屏必需的重量级面板与弹窗（`GitPanel`、`DiffViewer`、`SettingsDialogs`、`UpdateDialog`、`ConfigSyncModal`、`OnboardingWizard`）全面重构为 `lazy()` 动态按需加载并配置平滑 `<Suspense>` 兜底，首屏 JS 主包由 894 kB 压缩至 824 kB（削减逾 70 kB 纯核心代码），显著加快 V8 编译与首帧挂载速度。
  - **首屏非核心检测错峰延迟**: 将升级配置覆盖比对 (`fetchUpgradeDiffs`) 移出首帧生命周期，推迟 1.5 秒与版本检测合并执行，消除冷启动初期本地线程与请求争抢，集中算力优先保障聊天主视图与历史记录瞬间呈现。
  - **异地与局域网版本自愈监听**: 在 `webui/src/main.tsx` 挂载 `vite:preloadError` 监听器，异地客户端或手机开着旧标签页经历服务端重启发版时自动自愈刷新，杜绝动态 chunk 404 脚本加载异常。


## v7.2.1-beta.4 (2026-10-09)

- **[Release Pipeline & CI Matrix] Multi-Architecture Matrix Parallelism, Global Rust Cache, and Runner De-congestion**:
  - **Full Matrix Parallelism**: Refactored release workflows to compile x86_64 and ARM64 targets concurrently on separate GitHub Actions runners across Linux, Windows, and macOS, eliminating sequential compilation bottlenecks and cutting critical-path build time by nearly half.
  - **Global Dependency Caching**: Integrated `Swatinem/rust-cache` across all compiler targets and Tauri desktop bundlers, enabling instant dependency reuse and caching upstream crates.
  - **Runner De-congestion & Dedicated Release Bandwidth**: Streamlined CI gating during release pushes to prevent redundant test execution and dedicate 100% runner capacity to release builds, while keeping full cross-platform regression suites intact.

- **[Turn Clock & Replay Synchronization] Accurate Session Resumption, Watch Timestamp Alignment, and Detached Chat Guard**:
  - **Daemon Replay Timestamp Calibration**: Extended `ActiveChatRegistry` to track exact millisecond operation start timestamps and propagate them into synthetic `ChatEvent::User` replay snapshots, preventing timestamp loss when background sessions stream without initial message metadata.
  - **Frontend Turn Clock Alignment**: Enhanced `Chat.tsx` turn clock anchoring to respect explicit message epochs on background watch reconnections, tab switching, and snapshot restoration, preventing elapsed timers from resetting or drifting.

---

- **[发布流水线与 CI 矩阵] 全架构矩阵真并行、全局 Rust 编译缓存与 Runner 算力解耦**:
  - **架构级矩阵真并行**: 全面重构 `build.yml`，将 Windows、Linux、macOS 的 x86_64 与 ARM64 目标彻底拆分为独立的 GitHub Actions 并行矩阵，消除单机串行等待瓶颈，关键路径编译等待时间缩短近半。
  - **全局 Rust 编译缓存**: 全面接入 `Swatinem/rust-cache@v2`，按 Target Triple 隔离缓存，实现三方依赖（tokio、serde、axum、tauri 等）毫秒级增量复用。
  - **Runner 配额智能避让**: 发版提交智能让路，消除多重流水线并发抢占 Runner，发版期间全量算力专享发版任务。

- **[回合时钟与重放定序] 毫秒级后台流时钟对齐、会话恢复精准校准与防飘移防护**:
  - **服务端重放时间戳校准**: 增强 `ActiveChatRegistry` 记录精确的毫秒级操作启动时间戳，补齐后台推送 `ChatEvent::User` 重放快照中的时间数据，杜绝重连缺少时间戳导致的假死与时钟错乱。
  - **前端回合计时器锚定**: 优化 `Chat.tsx` 中的 `adoptTurnUserTs` 与回合时钟初始化，在后台 Watch 重连、会话切换以及快照恢复时精准锚定用户提问时间点，保证计时器单调平滑递增且不跳变。


## v7.2.1-beta.3 (2026-10-09)

- **[Chat Architecture & Event Bus] Full Alignment with OpenCode Architecture: Unified Event Bus, Stateless RPC, and Entity State Machine**:
  - **Single Source of Truth Event Bus**: Deprecated legacy dedicated duplex streaming (`streamChat`) in WebUI, fully converging chat event reception onto the centralized broadcast event bus (`watchChatSession`). Re-architected daemon `POST /chat` as a high-performance stateless asynchronous RPC returning `202 Accepted`, and broadcasted all prompt submissions as `ChatEvent::User` through `fan_tx` with strict message coordinates (`message_id`, `turn_id`, `client_seq`).
  - **12-Entity Discrete State Machine**: Refactored `sessionStore.ts` into a declarative, monotonic entity state machine covering 12 message and interaction entity types. Replaced brittle optimistic text splicing with strict topological ordering for reasoning blocks and assistant streams, completely eliminating text tearing and inverted thinking-block rendering.
  - **Steer 4-State Lifecycle & Race Defense**: Standardized prompt steer states into `queued`, `consumed`, `cancelled`, and `superseded`. Completely eliminated frontend dual-stream mutual exclusion guards and redundant message replay locks, guaranteeing deterministic UI rendering across hot reconnects, multi-tab sync, and cold startups.

---

- **[对话架构与事件总线] 全面深度对齐 OpenCode 架构：单广播事件总线、无状态 RPC 触发与实体状态机**:
  - **唯一可信单广播事件总线**: 彻底下线 WebUI 历史专有双工流 (`streamChat`)，将所有消息交互全量收敛至唯一的广播事件总线 (`watchChatSession`)。将守护进程 `POST /chat` 改造为返回 `202 Accepted` 的高性能无状态异步 RPC，用户提问统一作为 `ChatEvent::User` 携带精准坐标元数据 (`message_id`、`turn_id`、`client_seq`) 经由 `fan_tx` 全局广播。
  - **12 实体离散状态机与防撕裂拓扑**: 重构 `sessionStore.ts` 为覆盖 12 种消息与交互实体的声明式状态机。为思考块 (`reasoning`) 与助手回复流建立严格的拓扑定序约束，彻底消除了并发流式传输中的乱序、文本撕裂与思考块倒置渲染风险。
  - **Steer 4 态生命周期与竞态防护**: 规范转向控制提示词为 `queued`、`consumed`、`cancelled`、`superseded` 四态流转。全面移除前端脆弱的双流互斥锁与重复消息重放保护，确保在热重连、多标签页并发及冷启动场景下的状态强一致性与确定性渲染。


## v7.2.1-beta.2 (2026-10-08)

- **[WebUI & Kernel Steer Control] Steer Cancellation Lifecycle, Monotonic Turn Deduplication, Composer Input History, and Auto-Follow Scrolling**:
  - **Steer Cancellation & Buffer Purge**: Introduced `AgentCommand::CancelSteer` in `jeikcode-kernel` and `cancel_steer` in `CodingRuntimeHandle` to purge unconsumed steer messages from the per-turn buffer and pending fallback queue. Added daemon `POST/DELETE /chat/steer/cancel` endpoints and WebUI `cancelChatSteer` API, ensuring that cancelling a queued steer card or clicking stop immediately clears the kernel buffer and prevents unexpected subsequent execution.
  - **Turn Replay Deduplication**: Replaced fragile greedy heuristics with a global monotonic match-pairs algorithm across `messages` and session cache using normalized `userTextsMatch`, preventing duplicate prompt insertion and freezing queue drain during session load. Fixed multiline regex bleeding in diff stats.
  - **Composer Input History**: Added bounded per-session/project in-memory composer history navigation via `Up`/`Down` arrow keys (`inputHistory.ts`), preserving multiline caret editing while deferring to autocomplete, IME, and modified keystrokes.
  - **Timeline Auto-Follow**: Introduced `timelineFollow.ts` to automatically pin scrolling to newest messages while preserving manual inspection positions when browsing older history.

- **[Capabilities & Tool Hardening] Interactive Bash Guard, Lossy Edit Rejection, and Deprecated Routing Removal**:
  - **Interactive Bash Detection**: Implemented proactive detection in `bash` tool to fail fast when interactive commands, pagers, or text editors (e.g. `vim`, `nano`, `top`) are invoked without non-interactive flags, providing helpful hints instead of hanging execution.
  - **Lossy Edit Rejection**: Enforced strict pre-application checks in `edit` tool to reject lossy recovery before modifying files. Preserved Windows venv launcher context in place.
  - **Deprecated Routing Removal**: Physically purged obsolete `shell_route.rs` and deprecated route hints from bash execution to eliminate dead code and unnecessary token overhead.

- **[i18n & Architecture] Comprehensive Vietnamese Localization, OS Detection, and Strict Agent Boundary**:
  - **Vietnamese Catalog**: Added full Vietnamese localization (`vi-VN`) across WebUI, TUIx phrasebooks, daemon, and onboarding.
  - **Cross-Platform OS Locale Detection**: Implemented 3-tier locale resolution: User Config > OS Auto-detection (Windows registry `LocaleName`, macOS `AppleLocale`, Linux `/etc/locale.conf`) > English Fallback baseline.
  - **Agent Core Purity**: Strictly isolated human-facing interfaces from agent internals—system prompts, tool definitions, schemas, and execution traces strictly remain native English.

---

- **[WebUI 与内核转向控制] 转向取消闭环与内核缓冲清除、单调轮次防重、输入历史回溯与平滑跟屏**:
  - **转向撤回与内核缓冲清理**: 在 `jeikcode-kernel` 中引入 `AgentCommand::CancelSteer`，在 `CodingRuntimeHandle` 中暴露 `cancel_steer` 控制方法，精准清除未消耗的每轮转向缓冲区与 fallback 队列。在守护进程中增加 `POST/DELETE /chat/steer/cancel` 端点，并在前端实现 `cancelChatSteer` API，使得用户点击取消转向卡片或点击停止键时立即清除内核缓冲区，彻底根绝下一小步被意外触发的问题。
  - **会话防重放与单调匹配**: 使用全局单调匹配对算法替换脆弱的贪心双指针比对，结合 `userTextsMatch` 规范化比对当前会话与全局缓存，杜绝重复提问气泡并在会话加载过渡期间冻结排队发送。修复 diff 统计中的多行正则穿透问题。
  - **输入框历史回溯**: 在 `inputHistory.ts` 中实现基于内存的会话级/项目级输入历史（支持方向键 `Up`/`Down` 快速召回历史输入），保留多行光标编辑并对齐自动补全与 IME 输入法行为。
  - **时间线自适应跟屏**: 引入 `timelineFollow.ts`，在有新输出时自动平滑滚动触底，而在用户手动回滚查阅历史记录时保持视口稳定不跳动。

- **[能力与工具强化] 交互式 Bash 挂起防护、失真编辑拒绝与废弃 Shell 路由物理清理**:
  - **交互式命令主动拦截**: 在 `bash` 工具中增加前置检测，对交互式命令、分页器与文本编辑器（如 `vim`、`nano`、`top`）实施快速失败拦截并给出明确提示，防止后台静默挂起。
  - **失真编辑拒绝**: 在 `edit` 工具中执行应用前检查，在任何代码块应用前拒绝失真恢复。在 Windows 虚拟环境中原地保留 venv 启动器上下文。
  - **废弃路由物理清理**: 物理删除已废弃的 `shell_route.rs` 模块及相关尾巴提示，精简底层工具说明与 token 消耗。

- **[多语言与架构纯正性] 越南语全栈本地化、操作系统语言自探测与 Agent 核心防污染**:
  - **越南语本地化支持**: 在 WebUI、TUIx 交互、守护进程与引导页面中全栈新增越南语（`vi-VN`）语言包。
  - **跨平台系统语言自探测**: 建立三层语言决策机制：用户显式配置 > 跨平台系统语言探测（Windows 注册表 `LocaleName`、macOS `AppleLocale`、Linux `/etc/locale.conf`） > 英语兜底基准。
  - **Agent 核心纯正原则**: 严格界定人机交互与 Agent 核心边界，多语言仅限人机交互界面，系统提示词、工具定义、架构 schema 与底层执行痕迹一律保持原生英文，杜绝翻译污染。

## v7.2.1-beta.1 (2026-10-08)

- **[WebUI & Canvas Replay] Steer-Safe User Message Deduplication, Robust Turn Projection, and Harmonious Reasoning Spacing**:
  - **Technical Root Cause**: When a mid-turn steer message was submitted, the canvas user tail became the steer message while the turn continued in-flight. On session switch, reconnect, or page refresh, the daemon replayed the admitted prompt of the ongoing turn via `/chat/watch`. Previous backwards-scanning heuristics mistakenly evaluated any subsequent user row as evidence of a settled historical turn, causing `userMessageAlreadyOnCanvas` to evaluate to `false` and re-appending the original user prompt at the bottom of the canvas below ongoing tool steps.
  - **Steer-Safe Turn Projection & Replay Defense**: Overhauled `userMessageAlreadyOnCanvas` in `chatTerminal.ts` to properly evaluate subsequent turns, recognizing that mid-turn steers and in-flight execution belong to the active turn. Fortified `paintUserMessage` in `sessionProjection.ts` with a canvas-wide `alreadyHasUserText` check, ensuring that unless explicitly marked with `repeatAfterSettled` by an idle observer watch, replayed prompts already on canvas are never duplicated at the bottom.
  - **Harmonious Reasoning Block Spacing**: Updated `.reasoning-block` styles in `app.css` with adaptive `margin: 12px 0 10px`, `:first-child { margin-top: 0 }`, and `.markdown-root + .reasoning-block { margin-top: 14px }`, eliminating cramped text-to-thinking transitions and creating balanced vertical rhythm across all prose and thinking segments.
  - **Verification & Testing**: Added unit tests in `sessionProjection.test.ts` verifying that replayed original prompts with multi-minute timestamp drifts and finished intermediate tool steps never duplicate user bubbles. Ran all 333 WebUI unit tests (100% pass) and completed clean production build (`tsc --noEmit && vite build`).

---

- **[WebUI 与会话投影] Steer 转向消息防重保护、稳态轮次投影与思考块垂直间距平衡**:
  - **技术机理 / 现象溯源**: 用户在生成中途发送 Steer 转向消息后，画布最新的用户消息变成了 Steer。当页面刷新或切换会话切回时，后端通过 `/chat/watch` 重放本轮被接受的初始提问。原回溯算法因在 Steer 之后发现已完成的中间工具步骤，误将初始提问判定为“已结算的历史旧轮次”，导致 `userMessageAlreadyOnCanvas` 误判为 `false`，从而在 Steer 和最新工具交互下方错误地再次追加原始提问气泡。此外，`.reasoning-block` 原 `margin-top: 0` 且富文本段落底间距为 0，导致正文接思考块时上下完全贴死。
  - **Steer 稳态投影与多端重放防线**: 重构 `chatTerminal.ts` 中的 `userMessageAlreadyOnCanvas`，精准识别中途 Steer 与在途轮次的归属关系；在 `sessionProjection.ts` 的 `paintUserMessage` 中筑牢 `alreadyHasUserText` 防线，确保在非 `repeatAfterSettled` 场景下，画布已有的提问绝不再次追加。
  - **思考块垂直排版间距优化**: 在 `app.css` 中为 `.reasoning-block` 增加自适应上外边距（`margin: 12px 0 10px`）、首节点顶间距归零（`:first-child { margin-top: 0 }`）以及 `.markdown-root + .reasoning-block { margin-top: 14px }`，彻底解决正文紧贴思考块的不协调感，恢复统一优雅的呼吸感排版。
  - **验证与交付**: 编写定向单测覆盖两分钟以上时间戳漂移及多步骤工具已结算场景下的 Steer 重放防重；全量 333 个前端单测 100% 通过；生产构建与类型检查 0 报错通过。

## v7.2.1-beta.0 (2026-10-08)

- **[Network & Remote Access] IPv6 Dual-Stack WebUI Binding, Universal Platform Interface Discovery, and RFC-Compliant Remote Access Surface**:
  - **Technical Root Cause & Architecture**: Historically, WebUI startup utilized `bind_scanning` with prebound listeners to resolve dynamic ports, but `run_server` hardcoded `dual_stack_v6` to `None` for prebound sockets while `bind_scanning` only bound IPv4. Consequently, WebUI instances never listened on IPv6, and the remote access panel only exposed IPv4 addresses.
  - **Dual-Stack Socket Implementation**: Overhauled `bind_scanning` and `run_server` to return and spawn primary and secondary listeners across both IPv4 (`0.0.0.0`) and IPv6 (`[::]`). Enabled isolated `IPV6_V6ONLY = true` on the secondary socket to prevent Windows dual-stack socket collisions and gracefully fallback to single-stack when IPv6 is unavailable.
  - **IPv6 Shareability & Address Ranking**: Implemented bitmask filtering in `ipv6_is_shareable` to strictly exclude loopback, multicast, link-local (`fe80::/10`), IPv4-mapped, and documentation prefixes, while allowing Global Unicast (GUA `2000::/3`) and Unique Local Addresses (ULA `fc00::/7`). Added `network_ip_rank` to prioritize primary LAN IPv4, followed by primary outbound IPv6, other GUA/ULA IPv6, and public IPv4.
  - **RFC 3986 URL Formatting & Cross-Platform Discovery**: Wrapped IPv6 hostnames in standard brackets (`http://[...]:port/?token=...`) across `format_access_url` and `ensure_webui`. Enhanced IPv6 parsing with CIDR mask stripping (`/64`) and added non-blocking interface inspection for Linux (`ip -o addr` / `ifconfig`) and macOS (`ifconfig`), paired with kernel routing table UDP dummy connect detection.

- **[WebUI & Session Projection] Isolated Multi-Session Active Streams and In-Place Reasoning Deduplication**:
  - **Technical Root Cause**: Rapidly switching between active sessions could cause local SSE stream controllers to leak or overlap, occasionally resulting in duplicate reasoning blocks or displaced user echoes when transitioning back to an active turn.
  - **Session-Scoped Stream Lifecycle**: Introduced `localActiveStreamsBySessionRef` and `pendingSelfEchoBySessionRef` in `Chat.tsx` to cleanly isolate abort controllers and pending echoes per session ID, ensuring clean handover and eliminating dual-stream race conditions.
  - **In-Place Reasoning Extension**: Fortified `paintAssistantReasoning` in `sessionProjection.ts` to detect existing identical or prefix reasoning parts, updating thinking content in place rather than appending redundant reasoning cards.

---

- **[网络与远程访问] WebUI IPv6 双栈全量绑定、多平台网卡探测与规范化远程面板发现**:
  - **技术机理 / 现象溯源**: 历史版本中 WebUI 启动为了支持动态端口分配采用了 `bind_scanning` 预绑定模式，但 `run_server` 在接收预绑定监听器时将次级 IPv6 监听器硬编码置为 `None`，同时 `bind_scanning` 仅单向绑定 IPv4。这导致 WebUI 实例完全未监听 IPv6，且地球图标远程访问面板仅展示 IPv4 地址，公网与局域网 IPv6 无法直连。
  - **双栈 Socket 分离与实现防线**: 重构 `bind_scanning` 与 `run_server`，使其在通配地址（`0.0.0.0` 与 `::`）下同时生成主监听器与次级双栈监听器。显式启用 `IPV6_V6ONLY = true` 分离双栈 Socket，规避 Windows 下 `[::]` 占用导致 IPv4 冲突的系统级陷阱，并在 IPv6 不可用时优雅回退。
  - **规范化地址过滤与优先级矩阵**: 在 `ipv6_is_shareable` 中采用严格位掩码过滤，精准剔除链路本地（`fe80::/10`）、IPv4 映射、组播、回环及测试网段，仅放行全球单播公网地址（GUA `2000::/3`）与唯一本地地址（ULA `fc00::/7`）。引入 `network_ip_rank` 形成“局域网私网 IPv4 -> 首选出网 IPv6 -> 其余 GUA/ULA -> 公网 IPv4”的清晰权重梯队。
  - **RFC 3986 标准中括号包裹与跨平台发现**: 在 `ensure_webui` 终端输出与面板链接中全面为 IPv6 补充中括号包裹；增强对 Linux CIDR 掩码（`/64`）的截断兼容，并为 Linux 与 macOS 补充带超时保护的接口探测，结合 UDP 路由选路全面覆盖各种复杂双栈网络拓扑。

- **[WebUI 与会话投影] 会话级流生命周期隔离与思考块就地去重**:
  - **技术机理 / 现象溯源**: 快速切换不同会话标签页时，未隔离的全局活跃流控制器容易在异步回调中产生跨会话干扰，导致重切回活跃会话时出现重放流重叠或思考过程卡片重复追加。
  - **会话级流生命周期隔离**: 在 `Chat.tsx` 中建立 `localActiveStreamsBySessionRef` 与 `pendingSelfEchoBySessionRef`，按会话 ID 严格隔离 AbortController 与回声去重队列，杜绝会话交替时的并发流污染。
  - **思考块防重与就地扩展**: 升级 `sessionProjection.ts` 中的 `paintAssistantReasoning` 防线，当新到推理片段包含在已有思考块中或为其更长前缀时，执行原地更新而非新建卡片，彻底根除思考块重复渲染。

## v7.2.0 (2026-10-08)

- **[Core Tools Overhaul & Robustness] Unified and Streamlined Tool Architecture, Enhanced `read` & `grep`, Deterministic Shell Execution, and LLM Glob Normalization**:
  - Streamlined the built-in toolset into canonical primitives, retiring fragmented helpers and consolidating all configuration guide and reload actions under `jeikcode_config`.
  - Unified codebase exploration into a modern, all-in-one `read` tool, permanently retiring the legacy `codeintel::repo_map` module. The new `read` tool seamlessly handles multi-hundred-line safe reads, directory trees, images, and centered keyword matching (`key_string`) with customizable upward and downward contexts.
  - Enhanced `grep` with multi-mode outputs (`content`, `files_with_matches`, `count`), dedicated context lines control (`context`, `before_context`, `after_context`), unified regex parsing, and word-boundary matching.
  - Hardened `glob` pattern matching with automatic `./` and `././` prefix stripping, backslash-to-slash normalization on Windows, empty pattern fallback to `*`, and strict subdirectory confinement.
  - Overhauled `run_command` terminal execution: eradicated heuristic shell guessing in favor of deterministic execution, added explicit workspace-relative `cwd` support, hardened MSYS2 and Git Bash path injection, provided native UTF-16LE PowerShell support on Windows (`shell: "powershell"`), and introduced process grace windows (`settle_secs`) with idle timeouts.
  - Revamped tool parameter validation with multi-field and hierarchical diagnostic reporting, delivering comprehensive and actionable error messages in a single turn.

- **[Prompts & Agentic Workflow Discipline] Overhauled Core System Prompts, Reinforced Operational Discipline, Stable High-Concurrency Tool Dispatch, and Aggressive Reading Strategy**:
  - Completely redesigned system prompts and workflow discipline across `rules.yaml` and `system.yaml`, enforcing strict task boundary awareness, atomic commit discipline, and checklist closure verification.
  - Enhanced multi-turn reasoning and tool invocation pipelines to launch independent tool calls (file inspections, grep searches, subagent tasks) in parallel concurrently whenever no data dependency exists, drastically reducing interaction latency.
  - Mandated wide-window context reading (reading several hundred lines or entire files in a single pass) to build a comprehensive mental model upfront, eliminating fragmented blind edits and incomplete inspections.
  - Hardened in-flight steer prompt guidance to safely incorporate user priority pivots without losing existing execution checklists or mid-edit consistency.

- **[CodeIntel & CodeGraph] Multi-Ecosystem Source Protection, Context-Aware MSBuild Pruning, and Adaptive Workspace Indexing**:
  - Purged all obsolete `codeintel::repo_map` references across the codebase and user configuration templates.
  - Unlocked language-level executable and toolchain source bins, preserving Rust crate binaries (`src/bin/*.rs`), Ruby tools (`bin/rails`), and Node entrypoints (`bin/cli.js`) from accidental exclusion.
  - Reclaimed ASP.NET/Blazor `wwwroot` web assets and hand-written legacy C# metadata (`Properties/AssemblyInfo.cs`), pruning only generated assembly attributes and context-situated build folders (`Debug`/`Release` directly nested under `bin/` or `obj/`).
  - Expanded standardized `.codegraphignore` ignore presets across modern ecosystems, including .NET SDK artifacts, Elixir/Erlang (`_build`, `deps`), Flutter (`.dart_tool`), Zig (`zig-cache`, `zig-out`), Haskell (`.stack-work`), Swift/Xcode (`.build`, `DerivedData`), Unreal Engine (`Binaries`, `Intermediate`), CocoaPods, and root-anchored Unity editor caches (`/Library/`).
  - Enabled automatic index generation for single-repository workspaces, improved guidance for unindexed workspaces, and wired bundled ignore template updates into config diff review.

- **[WebUI & Visual Polish] Refined Charcoal Palette, Streamlined Single-Line Composer, Interactive Mermaid Diagrams, and VSCode-Style Git Inspector**:
  - Completely redesigned the WebUI color palette inspired by Gemini, adopting an eye-friendly, deeply immersive charcoal canvas and setting dark mode as the default experience.
  - Redesigned the composer input box into a sleek, minimalist single-line pill, removing redundant menus and introducing a prominent live green-lightning token telemetry badge.
  - Integrated full interactive Mermaid diagram rendering for architecture topologies, flowcharts, and sequence diagrams directly in chat streams.
  - Overhauled the Git panel with a VSCode-style commit hover details card, a responsive Git Graph visualization, and a compact action menu.
  - Resolved nested Markdown code block fragmentation and double-fence rendering glitches.

- **[Mobile Experience] Comprehensive Mobile-First UI Overhaul, Touch Navigation, and Resilient Connection Architecture**:
  - Implemented an adaptive top navigation bar that automatically condenses and stacks controls on smaller mobile screens, preventing overlapping and visual clutter.
  - Optimized mobile virtual keyboard interaction: Enter key defaults to soft newlines, composer cleanly docks above the keyboard, and viewport resizes smoothly without jumpiness.
  - Introduced a dedicated Mobile Approval Dock with optimized touch targets, thumb-friendly button placement, and bottom anchoring to eliminate accidental taps.
  - Hardened mobile reconnection: seamlessly reconnects SSE streams and synchronizes authoritative session state upon app foregrounding or network transitions without screen blanking.
  - Fixed chat bubble displacement and scroll jittering during live generation and turns replaying on mobile viewports.

- **[Remote Browsing & Workspace Sync] Seamless Remote Directory Selection, Multi-Observer Project Synchronization, and Windows Verbatim Path Normalization**:
  - Replaced native OS directory dialog blocking on remote browser sessions with a built-in, responsive in-page directory picker, while preserving native file dialogs for local loopback connections.
  - Added user confirmation for project removal/hiding in the sidebar while strictly preserving session data on disk.
  - Introduced persistent sidebar project synchronization via `GET/POST /projects/sidebar`, syncing pinned and hidden project states across multiple tabs, devices, and observers in real time.
  - Implemented automatic recovery of running projects: background sessions actively executing a turn automatically resurface and expand in the sidebar with live progress indicators.
  - Stripped Windows extended verbatim path prefixes (`\\?\`, `//?/`, `/?/`) prior to breadcrumb generation and routing, preventing broken paths and hash partition mismatches.

- **[Session Architecture & Daemon Robustness] Direct Session Deep-Linking, Retirement of Legacy Sync Streams, Hardened Permissions, and Disk Quota Governance**:
  - Enhanced the TUI `/webui` command to pass the active session ID directly in the launcher URL (`&session=<id>`), enabling immediate browser navigation to current in-flight tasks.
  - Permanently retired legacy dual-stream synchronization (deprecated `/sync` slash command, `?sync=1` URL flags, and background disk polling), consolidating all real-time canvas updates onto unified `/chat` and `/chat/watch` SSE pipelines.
  - Hardened approval permission handling: instant one-click card dismissal, asynchronous response confirmation awaiting, and strict response correlation to prevent duplicate toasts or cross-session misrouting.
  - Hardened daemon security boundaries, path confinement, and session isolation.
  - Disabled overly verbose data logs by default, enforced hard disk storage quotas to prevent disk exhaustion, and provided automatic legacy configuration migration.
  - Synchronized authoritative Todo item status across all clients, fixing glyph imports in completion reminders.
  - Standardized universal Agent Skills discovery under plural `.agents/skills` directories across project and global hierarchies.

- **[Docs, CI/CD & Engineering Discipline] Full-Stack Docs Refresh, Hardened Native CI Matrix, and Upgraded Release Infrastructure**:
  - Revamped the official documentation website: elevated built-in tools to top-level navigation parallel with CodeGraph, condensed architecture overviews, and updated remote deployment security guides.
  - Hardened cross-platform desktop bundles on Linux x64 with unified Ubuntu 22.04 / 24.04 compatibility and reproducible build gates.
  - Automated multi-crate workspace version bumping in `Cargo.lock`.
  - Coupled `tsc --noEmit` into `npm run build` as an automated type-checking gate, preventing invisible frontend regressions.
  - Fixed CI workflow YAML command-string quoting and standardized Node test imports with explicit `.ts` specifiers.
  - Adopted a standardized Pull Request template (`.github/PULL_REQUEST_TEMPLATE.md`) to maintain strict review hygiene and self-contained commits.

---

- **[核心工具体系大精简与鲁棒性全面加固] 工具链收敛规范化、全能 `read` 与高级 `grep`、确定性命令执行与大模型 Glob 模式高容错适配**:
  - 全面精简核心内置工具链：废除碎片化的冗余辅助工具，将配置指引与配置热重载功能统一收敛至 `jeikcode_config` 工具下。
  - `read` 工具全能化统一：彻底淘汰旧式独立的 `codeintel::repo_map` 模块，将大范围安全读文件、目录树探查、多模态图片阅读全量收敛至 `read` 工具；新增 `key_string` 关键字居中匹配与上下文透视（`upward`/`downward`），格式全面对齐纯文本以极度节省大模型 Token 开销。
  - `grep` 工具全面增强：支持多模式输出（`content` 包含行号与上下文、`files_with_matches` 仅文件路径、`count` 统计匹配行数），支持独立的上下文行数控制（`context`、`before_context`、`after_context`），统一正则表达式与单词边界匹配机制。
  - `glob` 路径匹配兼容性防线：自动循环剥离大模型习惯性生成的 `./` 与 `././` 相对前缀；无条件规范化 Windows 反斜杠 `\` 为 `/`，规避正则转义歧义；空匹配模式（如纯 `./`）自动安全回退为 `*` 通配符；严格限定子目录匹配作用域，防止意外泄露根目录同名文件。
  - `run_command` 终端与命令执行重大架构加固：彻底废除不可靠的启发式 Shell 猜测，改为确定性分层路由；新增 `cwd` 工作目录参数，相对路径严格相对于工作区根目录解析；Windows 环境原生支持 `shell: "powershell"` 原生运行 PowerShell 脚本（UTF-16LE 直通），深度加固 MSYS2 与 Git Bash 分层 PATH 注入；引入进程启动宽限期（`settle_secs`）与空闲静默杀死策略，防御终端劫持。
  - 参数校验反馈机制重大升级：支持多字段（multi-field）与深层级（hierarchy）结构化错误诊断反馈，参数填写有误时一次性返回完整定位指引，消除单字段反复重试的死循环。

- **[系统提示词与 Agent 工作流纪律] 全新优化核心提示词、强化执行纪律、无依赖全并发调度与激进式上下文读取策略**:
  - 全面升级 `rules.yaml` 与 `system.yaml` 基础提示词体系，确立严格的任务范围意识（Task Scope Awareness）、原子化提交与清单闭环原则。
  - 全面优化多轮推理与工具调用链路，支持在无数据依赖时全并发发射独立工具调用（文件读取、grep 检索、子智能体派发等），大幅削减等待时延。
  - 确立大范围安全读取标准（Read Generously），单次调用鼓励阅读数百行乃至全量文件，快速构建完整代码认知全局图景，彻底杜绝盲目小步试探与片段式猜解。
  - 增强飞行中即时转向（Steer）提示词规范，保障用户中途调整需求时平滑挂起、优先级智能插队与上下文连贯恢复。

- **[代码智能与图谱引擎] 多语言生态源码资产保护、MSBuild 构建产物精准剪枝与自适应索引引导**:
  - 彻底清除全仓代码与用户配置模板中对已废弃 `codeintel::repo_map` 的全部引用。
  - 解绑粗暴拦截裸 `bin/` 的规则，完整放行各语言生态可执行源码：保留 Rust 二进制 crate 源码（`src/bin/*.rs`）、Ruby 命令行脚本（`bin/rails`）和 Node/npm 入口脚本（`bin/cli.js`）。
  - MSBuild 产物路径上下文感知过滤：仅当 `Debug`、`Release`、`RelWithDebInfo`、`MinSizeRel` 位于 `bin/` 或 `obj/` 层级下时才执行剪枝；解禁 ASP.NET/Blazor 的 `wwwroot` 静态源码；精准保留手写 `Properties/AssemblyInfo.cs`，仅过滤自动生成的 `*.AssemblyAttributes.cs`。
  - 全生态构建忽略规则库全面扩充：在 `.codegraphignore` 中原生补齐 .NET SDK artifacts、Elixir/Erlang（`_build`, `deps`）、Flutter（`.dart_tool`）、Zig（`zig-cache`, `zig-out`）、Haskell（`.stack-work`）、Swift/Xcode（`.build`, `DerivedData`）、Unreal Engine（`Binaries`, `Intermediate`）、CocoaPods 及根目录 Unity 编辑器缓存（`/Library/`）。
  - 单仓自适应索引与配置差异比对：单工程工作区无需额外干预即可自动构建图谱索引；内置 `.codegraphignore` 模板种子更新接入 `scan_jeikcode_config_diffs`，供用户透明审查同步。

- **[WebUI 颜值重构与深色交互美学] 灵感源自 Gemini 的高级炭灰调色板、极简单行输入框、交互式 Mermaid 图表与 VSCode 风格 Git 检视器**:
  - 深度重构 WebUI 调色板：汲取 Gemini 界面质感，默认启用护眼且沉浸的高级炭灰深色美学（eye-friendly charcoal canvas）。
  - 极简 Composer 输入框重构：流线型单行胶囊设计，剥离冗余折叠菜单，引入灵动醒目的绿色闪电（green-lightning）Token 实时监测徽标。
  - 交互式 Mermaid 图表支持：在对话画布中直接渲染交互式架构图、时序图与流程图。
  - Git 面板全套体验升级：引入 VSCode 风格的 Commit 悬停详情浮窗卡片，新增响应式 Git Graph 可视化提交拓扑图与紧凑型操作菜单。
  - 修复 Markdown 嵌套代码块碎裂与反引号（double-fence glitch）渲染瑕疵。

- **[移动端深度优化与触控体验飞跃] 顶栏自适应收纳排布、输入键盘平滑贴合、移动端专属审批停靠坞与断线韧性重连**:
  - 顶栏自适应收纳排布：小屏幕视口下自动折叠收纳顶部导航与工具栏，彻底消除拥挤遮挡。
  - 移动端虚拟键盘与输入体验加固：移动端点击回车默认换行，输入框平滑吸附键盘上方，视口弹性贴合无跳变。
  - 移动端专用审批停靠坞（Mobile Approval Dock）：重构权限审批浮层，优化触控靶心大小与吸边排布，彻底消除手机端误触。
  - 移动端断线韧性重连（Mobile Reconnect）：移动端切换后台或网络波动恢复后，自动重建连接并平滑同步最新会话状态，杜绝界面白屏与数据脱节。
  - 气泡防抖与滚动稳固：防止移动端消息流由于重绘导致的对话气泡位移与视觉跳变。

- **[远程浏览器体验与多端工作区项目同步] 远程环境内置网页目录选择器、跨端项目侧边栏同步与 Windows 驱动级路径规范化**:
  - 远程浏览器选目录无缝支持：彻底解决远程浏览器访问时点击“添加目录”触发服务器端原生不可见弹窗导致请求卡死的顽疾；远程环境自动切为网页端内置目录浏览器，本机访问保留原生文件选择器。
  - 侧边栏项目管理防误触与持久化同步：新增项目隐藏/移除安全二次确认，绝对不删磁盘会话文件；`GET/POST /projects/sidebar` 实现置顶与隐藏状态在多设备、多标签页、多观察者之间实时双向同步。
  - 运行中项目智能拉回：后台若有正在执行的活跃回合，被隐藏的项目会自动恢复至侧边栏并展开，带有加载动画，历史会话无损呈现。
  - Windows 扩展路径标准化：自动剥离 `\\?\`、`//?/`、`/?/` 等 Windows 驱动级扩展前缀，修复面包屑导航显示问号及跨平台路径哈希错位问题。

- **[会话流架构收敛与守护进程鲁棒性防线] 会话直连开箱即用、废弃冗余同步流、审批流精准关联与磁盘日志配额治理**:
  - TUI `/webui` 会话无缝直达：在 `/webui` 命令生成的 URL 中自动携带当前活跃会话短 ID（`&session=<id>`），打开浏览器直开对应任务。
  - 废弃历史遗留同步流：彻底移除 `/sync` 斜杠命令、`?sync=1` 参数及磁盘后台轮询，将全量会话同步统一收敛至高性能的 `/chat` 与 `/chat/watch` 画布 SSE 流。
  - 审批流（Approval）精准关联防线：强化权限请求与响应的相关性匹配，首击即消（instant dismissal），彻底解决多端会话切换时飞行中工具触发的重复审批通知 Bug。
  - 守护进程安全边界加固：强化进程、路径边界与沙箱访问权限，杜绝恶意跨路径或跨会话读取。
  - 数据日志磁盘硬配额：默认禁用详尽 datalog，增加磁盘硬配额限制，杜绝长时间运行占满磁盘空间；自动无感迁移老旧配置格式。
  - Todo 待办权威状态同步：跨端同步待办列表最终态，修复完成提醒中的字形导入异常。
  - 通用 Skills 规范对齐：统一采用复数 `.agents/skills` 约定，支持全层级技能自动发现与挂载。

- **[官方文档、CI/CD 与工程规范全方位升级] 官网结构与导航焕新、桌面端跨平台打包加固与严密类型门禁**:
  - 官网结构与指引升级：重排文档侧边栏，内置工具与代码图谱并列首位，精简架构说明，更新远程部署安全指南。
  - 跨平台编译与构建加固：修复 Ubuntu 22.04 / 24.04 Linux 桌面端打包兼容性，建立可复现构建防线。
  - 自动化版本联动：多 crate 工作区版本自动级联同步更新至 `Cargo.lock`。
  - 类型安全前置检查：将 `tsc --noEmit` 固化为 WebUI 构建前置门禁，彻底杜绝前端隐式类型回归。
  - CI 命令转义与单元测试修复：修复 CI 脚本中命令字符串带空格时的解析报错，完善 Node 单测覆盖与规范化导入。
  - 引入规范化 PR 模板（`.github/PULL_REQUEST_TEMPLATE.md`），严明分支与开发协作规约。

## v7.2.0-beta.11 (2026-10-08)

- **[WebUI / Node Test Imports] Give `api.ts` an explicit `.ts` import for `displayPath` so `node --test` can load the module**:
  - **Technical Root Cause / Detail**: `api.ts` imported `./lib/displayPath` without an extension. Vite resolves that form, but the WebUI CI job runs `node --test`, which requires a resolvable ESM specifier. All 25 `api.test.ts` cases failed with `ERR_MODULE_NOT_FOUND` and blocked the beta.10 CI gate.
  - **Implementation Mechanism**: Changed the import to `./lib/displayPath.ts`, matching the rest of the Node-tested library modules under `webui/src/lib/`.
  - **Verification & Testing**: `node --test src/api.test.ts src/lib/displayPath.test.ts` — 34 passed. `cargo check --lib -p jeikcode-daemon` succeeded.

---

- **[网页 / Node 单测导入] 给 `api.ts` 的 `displayPath` 补上 `.ts` 后缀，让 `node --test` 能加载模块**:
  - **技术机理 / 现象溯源**: `api.ts` 写成了无后缀的 `./lib/displayPath`。Vite 能解析，但 WebUI CI 用的 `node --test` 不行，导致 `api.test.ts` 25 条全部 `ERR_MODULE_NOT_FOUND`，beta.10 CI 被拦住。
  - **实现防线 / 核心改动**: 改为 `./lib/displayPath.ts`，与 `webui/src/lib/` 下其他 Node 单测模块一致。
  - **验证与交付**: `api.test.ts` 与 `displayPath.test.ts` 共 34 条通过；`cargo check --lib -p jeikcode-daemon` 通过。

## v7.2.0-beta.10 (2026-10-08)

- **[WebUI & Daemon / Sidebar Projects] Confirm project removal, sync the list across observers, and bring a running project back**:
  - **Technical Root Cause / Detail**: The sidebar trash control wrote a browser-local hide set and removed the row immediately, so other tabs and machines never saw the change. Clicking add-folder called the daemon native folder dialog, which blocks the HTTP request on the instance; a remote browser waited on a dialog it could not see. After a folder was chosen, the client only opened a blank chat and left a previously hidden project off the list, so historical sessions never returned. Windows extended paths (`\\?\`, `//?/`, `/?/`) were split into a literal `?` breadcrumb and could hash into a different session bucket.
  - **Implementation Mechanism**: `POST /projects/sidebar/hide|show|reveal` plus `GET /projects/sidebar` persist pin and hide state beside the session catalog. Hiding asks for confirmation and keeps session files. A live turn unhides that project on the next sidebar read and on the client that sees `/chat/active` or optimistic output; the row expands, its sessions reload, and running sessions stay pinned with the spinner. Loopback pages still use the native picker; any other host opens the in-page directory browser. `strip_verbatim` and the webui path helpers collapse extended prefixes before breadcrumbs, joins, and `/cd`.
  - **Verification & Testing**: `node --test webui/src/lib/displayPath.test.ts` covers `E:/`, `D:/`, `\\?\`, `//?/`, and `/?/`. `cargo test -p jeikcode-capabilities --lib pathnorm::tests` passed. Sidebar hide/show unit tests live in `sidebar_projects`; the webui production build and a live remote-browser pass were not run in this workspace.

---

- **[网页与守护进程 / 侧栏项目] 移除项目需确认，列表在各观察者之间同步，运行中的项目会回到左侧**:
  - **技术机理 / 现象溯源**: 垃圾桶原先只写浏览器本地隐藏集合并立刻删行，其他标签页和机器看不到。加号走守护进程上的原生选目录，异地浏览器会一直等到实例机上那个看不见的对话框关掉。选完目录后右侧只开一个空会话，已被隐藏的项目不会回到左侧，历史会话也不出现。Windows 的 `\\?\`、`//?/`、`/?/` 会被拆成问号面包屑，并可能落进另一个会话桶。
  - **实现防线 / 核心改动**: `GET/POST /projects/sidebar` 把置顶和隐藏记在会话目录旁。隐藏先确认，不删会话文件。回合仍在跑时，侧栏读取和看到活跃会话的客户端会把该项目展开并拉回会话，转圈条目置顶。本机回环地址仍用原生选目录；其他主机打开网页目录浏览器。扩展路径前缀在面包屑、拼接和 `/cd` 之前被剥掉。
  - **验证与交付**: `displayPath` 单测覆盖 `E:/`、`D:/` 与三种扩展前缀；`pathnorm` 单测已通过。侧栏隐藏/显示单测在 `sidebar_projects`。本次未跑网页生产构建，也未在真实异地浏览器里点选。

## v7.2.0-beta.9 (2026-10-07)

- **[Tools & Capabilities / Glob Input Normalization & Pattern Compatibility] Harden `glob` pattern normalization for LLM path prefixes, Windows delimiters, and empty fallback semantics**:
  - **Technical Root Cause / Detail**: Large Language Models habitually formulate file glob queries with leading relative path prefixes (e.g., `./*.rs`, `./src/**/*.ts`) or Windows native separators (`.\\src\\*.rs`). In previous implementations, `GlobBuilder` evaluated patterns with `literal_separator(true)` strictly against walkdir relative paths (which do not contain `./` prefixes). This mismatch led to silent empty result sets for common model queries. Furthermore, Windows backslashes (`\`) were vulnerable to being misinterpreted as regex/glob escaping characters rather than directory delimiters.
  - **Implementation Mechanism**: Introduced `normalize_match_pattern` in `crates/jeikcode-capabilities/src/tools/glob.rs`:
    1. Unconditionally normalizes backslashes (`\`) to forward slashes (`/`) to eliminate Windows path escaping hazards;
    2. Repeatedly strips leading `./` path components (`strip_prefix("./")`), harmonizing relative model queries (such as `./*.toml` or `./nested/*.rs`) with canonical directory walk paths;
    3. Gracefully maps empty stripped queries (e.g., `./`) to `*` to safely enumerate base directories without triggering matcher errors or empty responses.
  - **Verification & Testing**: Added comprehensive unit tests in `tools::glob::tests` covering `./*.toml`, repeated `././`, Windows `.\\src\\*.rs`, nested path confinement (`./nested/*.rs` strictly scoping into subdirectories), and shipped `.codegraphignore` asset integration tests (`shipped_ignore_keeps_source_bins_in_glob`).

- **[CodeIntel & CodeGraph / Multi-Ecosystem Source Protection & MSBuild Output Pruning] Decouple bare `bin/` directory pruning, protect language source bins & ASP.NET assets, expand multi-language build ignores, and enable config sync diff tracking**:
  - **Technical Root Cause / Detail**: A naive bare `bin/` entry in `.codegraphignore` and the engine's hardcoded `SKIP_DIR_NAMES` caused catastrophic collateral damage across multiple language ecosystems: Rust binary crates (`src/bin/*.rs`, `src/bin/<name>/main.rs`), Ruby executable toolchains (`bin/rails`, `bin/setup`), and Node npm binary entrypoints (`bin/cli.js`) were entirely dropped from semantic indexing and symbol navigation. Similarly, ASP.NET/Blazor web assets under `wwwroot` (e.g., `site.js`, CSS) were prematurely suppressed as build dumps, and hand-written legacy .NET metadata in `Properties/AssemblyInfo.cs` was indiscriminately filtered out alongside generated assembly attributes. Moreover, modern ecosystems (Elixir, Flutter, Zig, Haskell, Swift, Unreal, Unity) lacked standardized build/cache pruning.
  - **Implementation Mechanism**:
    1. **Context-Aware MSBuild Pruning**: Pruned bare `"bin"` and configuration names (`"Debug"`, `"Release"`) from `SKIP_DIR_NAMES`. Replaced them with context-aware `should_prune_index_dir` and `parent_name_is_bin_or_obj`, specifically targeting `Debug`, `Release`, `RelWithDebInfo`, and `MinSizeRel` only when situated under `bin/` or `obj/` hierarchies (supporting multi-target/architecture outputs like `App/bin/x64/Release`), while keeping top-level and source-level `bin/` trees intact;
    2. **Source Asset Reclamation**: Removed `wwwroot` from `SKIP_DIR_NAMES` to retain ASP.NET web sources, and narrowed generated C# filtering in `is_generated_source` from all `assemblyinfo.cs` to `*.AssemblyAttributes.cs`, preserving hand-written `Properties/AssemblyInfo.cs`;
    3. **Multi-Ecosystem Ignore Hardening**: Expanded `.codegraphignore` to cover .NET SDK artifacts (`**/artifacts/bin/`, `**/artifacts/obj/`), Elixir/Erlang (`_build/`, `deps/`), Flutter (`.dart_tool/`), Zig (`zig-cache/`, `zig-out/`), Haskell (`.stack-work/`, `dist-newstyle/`), Swift (`.build/`, `DerivedData/`), Unreal Engine (`Binaries/`, `Intermediate/`, `DerivedDataCache/`), CocoaPods (`Pods/`), and root-anchored Unity editor cache (`/Library/`);
    4. **Config Sync Diff Tracking**: Clarified `CodeExploreTool::seed_fork_defaults` asset seeding lifecycle so updates to bundled ignore assets (`.codegraphignore`) are exposed through `scan_jeikcode_config_diffs` for safe, transparent user-reviewed synchronization.
  - **Verification & Testing**: Validated with `codeintel::index::tests::skips_msbuild_output_but_keeps_source_bins` asserting that Rust `src/bin`, npm `bin/`, ASP.NET `wwwroot`, and `AssemblyInfo.cs` are indexed while `App/bin/Debug` and `App/bin/x64/Release` remain pruned.

- **[WebUI & TUI Architecture / Direct Session Binding & Deprecated Sync Stream Retirement] Pass current session to WebUI launcher, consolidate canvas streaming to `/chat` and `/chat/watch`, and eliminate obsolete `/sync` commands**:
  - **Technical Root Cause / Detail**: Previously, the `/webui` command opened a generic browser window without session binding, requiring users to locate their active session manually. Meanwhile, a legacy dual-stream sync architecture (`/sync`, `?sync=1`, `postLiveSwitchSession`, background disk polling) created race conditions and UI flickering against the unified SSE stream.
  - **Implementation Mechanism**: Updated `ensure_server_and_open` in `crates/jeikcode-daemon` to accept `session_id: Option<&str>` and append `&session=<short_id>` so TUI's `/webui` command immediately opens the user's active session. Permanently removed the obsolete `/sync` slash command, its i18n entries, and `CreateSessionRequest.sync` broadcast logic; prioritized `/sessions` over `/setup` in TUI completion prefix matching. Unified WebUI canvas streaming onto `/chat` and `/chat/watch`, cleaning up leftover `?sync=1` URL parameters upon mounting, and refined `paintUserMessage` in `sessionProjection.ts` to ensure Working placeholders render correctly during watch mode while preventing duplicate user message echoes.
  - **Verification & Testing**: Verified `cargo check --lib -p jeikcode-daemon`, `cargo check --bin jeikcode`, passed `commands::tests::s_prefix_lists_sessions_before_setup`, executed full webui suite (323 tests passed via `npm test`), and built production assets via `npm run build`.

---

- **[工具与能力层 / Glob 输入规范化与路径匹配兼容性防线] 强化 `glob` 模式规范化，消除大模型路径前缀漏匹配、Windows 分隔符转义与空模式异常**:
  - **技术机理 / 现象溯源**: 大模型在生成文件匹配模式时极常携带相对路径前缀（如 `./*.rs`、`./src/**/*.ts`）或 Windows 反斜杠（如 `.\\src\\*.rs`）。在原有实现中，`GlobBuilder` 开启了 `literal_separator(true)`，且遍历文件系统产生的相对路径不包含 `./` 前缀，导致该类模式与实际相对路径字面不匹配而静默返回空结果；同时，Windows 反斜杠 `\` 易被底层构建器误判为正则/glob 转义字符，导致匹配行为偏离预期。
  - **实现防线 / 核心改动**: 在 `crates/jeikcode-capabilities/src/tools/glob.rs` 中实现 `normalize_match_pattern` 路径规范化机制：
    1. 无条件将反斜杠 `\` 转换为正斜杠 `/`，彻底消除 Windows 路径下的分隔符转义歧义；
    2. 循环剥离模式开头的 `./`（`strip_prefix("./")`），使大模型生成的 `./*.toml`、`./nested/*.rs` 等模式与标准相对路径完美对齐；
    3. 针对剥离后为空的边界情况（例如纯 `./` 查询），安全回退为 `*` 通配模式，保证稳定列出当前目录项而非报错或返回空集合。
  - **验证与交付**: 在 `tools::glob::tests` 中补充全套单元测试，涵盖 `./*.toml`、多层嵌套 `././`、Windows `.\\src\\*.rs`、子目录作用域限定（`./nested/*.rs` 严格匹配子目录内容而不泄露根目录同类文件）以及系统分发忽略规则测试（`shipped_ignore_keeps_source_bins_in_glob`）。

- **[代码智能与图谱引擎 / 多语言生态源码保护与 MSBuild 构建产物精准剪枝] 解耦粗暴的裸 `bin/` 规则，完整保留各生态源码级可执行目录与 ASP.NET 资产，扩充全生态忽略规则并打通配置同步差异比对**:
  - **技术机理 / 现象溯源**: 原先 `.codegraphignore` 与引擎硬编码的 `SKIP_DIR_NAMES` 中直接配置了裸 `bin/` 规则，导致多语言生态中的核心源代码被无差别误杀：Rust 二进制 crate 源码（`src/bin/*.rs`、`src/bin/<name>/main.rs`）、Ruby 命令行工具（`bin/rails`、`bin/setup`）以及 Node/npm 入口脚本（`bin/cli.js`）在构建代码图谱时被全量忽略，严重破坏符号跳转与代码理解。同时，ASP.NET/Blazor 的 `wwwroot` 静态源码（JS、CSS）被误当成构建产物剔除，旧式 .NET 工程手写的 `Properties/AssemblyInfo.cs` 也被当作生成代码拦截；现代语言生态（Elixir、Flutter、Zig、Haskell、Swift、虚幻、Unity 等）也缺乏系统级构建目录过滤。
  - **实现防线 / 核心改动**:
    1. **MSBuild 路径上下文感知过滤**: 从 `SKIP_DIR_NAMES` 中移除裸 `"bin"` 与配置目录名（`"Debug"`, `"Release"`），改由 `should_prune_index_dir` 与 `parent_name_is_bin_or_obj` 依据父级路径动态判定，仅当配置目录位于 `bin/` 或 `obj/` 层级下时（支持 `App/bin/x64/Release` 等多目标架构）执行剪枝，并扩充识别 `RelWithDebInfo` 与 `MinSizeRel`；
    2. **源码资产回收与精准放行**: 从 `SKIP_DIR_NAMES` 中解禁 `wwwroot`，保留 Web 静态源码索引；在 `is_generated_source` 中将 `assemblyinfo.cs` 粗暴拦截收敛为精准过滤 `*.AssemblyAttributes.cs`，手写 `Properties/AssemblyInfo.cs` 得以正常参与索引；
    3. **多生态构建忽略规则库扩充**: 在 `.codegraphignore` 中全面补齐 .NET SDK artifacts（`**/artifacts/bin/`, `**/artifacts/obj/`）、Elixir/Erlang（`_build/`, `deps/`）、Flutter（`.dart_tool/`）、Zig（`zig-cache/`, `zig-out/`）、Haskell（`.stack-work/`, `dist-newstyle/`）、Swift/Xcode（`.build/`, `DerivedData/`）、Unreal Engine（`Binaries/`, `Intermediate/`, `DerivedDataCache/`）、CocoaPods（`Pods/`）以及严格锚定项目根目录的 Unity 编辑器缓存（`/Library/`，杜绝误伤名为 Library 的源码目录）；
    4. **内置忽略规则配置同步比对闭环**: 在 `CodeExploreTool::seed_fork_defaults` 中确立资产种子生命周期，更新后的 `.codegraphignore` 不强制无感覆盖，而是接入 `scan_jeikcode_config_diffs` 配置比对链路，供用户透明审查并勾选同步。
  - **验证与交付**: 补充并运行 `codeintel::index::tests::skips_msbuild_output_but_keeps_source_bins` 专项测试，断言验证 Rust `src/bin`、npm `bin/`、ASP.NET `wwwroot` 及手写 `AssemblyInfo.cs` 均能被正常索引，而 MSBuild 构建产物被严格拦截。

- **[WebUI 与 TUI 架构 / 会话直连打通与废弃同步流收敛] TUI `/webui` 直开当前会话，统一收敛为 `/chat` + `/chat/watch` 画布链路并彻底移除冗余 `/sync` 机制**:
  - **技术机理 / 现象溯源**: 原先 TUI `/webui` 命令打开浏览器时未携带会话锚定，用户需在侧边栏手动寻找当前会话；同时，历史遗留的独立同步机制（`/sync` 命令、`?sync=1` 参数、`postLiveSwitchSession` 与磁盘后台轮询）与标准的 `/chat` / `/chat/watch` 流产生竞争，引发双流冲突、多端新建会话误广播及画布跳变。
  - **实现防线 / 核心改动**: 在 `crates/jeikcode-daemon` 的 `ensure_server_and_open` 中引入 `session_id` 参数，向打开的 URL 自动追加 `&session=<前8位短ID>`，实现 TUI `/webui` 无缝直达当前会话；彻底移除 `/sync` 斜杠命令及其国际化文案与后端的 `CreateSessionRequest.sync` 广播逻辑，并在 TUI 命令前缀匹配中将 `sessions` 优先级前置于 `setup`；WebUI 画布全面收敛至 `/chat` 与 `/chat/watch` 单一链路，挂载时自动净化旧 URL 中的 `?sync` 参数；增强 `sessionProjection.ts` 的 `paintUserMessage` 状态机，保证 watch 观察者模式下准确保留 Working 占位符且避免已结算轮次的文本回放抖动。
  - **验证与交付**: 通过 `cargo check --lib -p jeikcode-daemon` 与 `cargo check --bin jeikcode` 编译，通过 `s_prefix_lists_sessions_before_setup` 命令单测，前端 323 项单元测试全部通过 (`npm test`)，`webui` 构建生产包成功。

## v7.2.0-beta.8 (2026-10-07)

- **[WebUI / Live Turn Sync] External `--host` observers and a refreshed sender both keep the open turn and continue painting it**:
  - **Technical Root Cause / Detail**: An external browser joins with `sync=1`. Its `/live` snapshot is often the previous completed turn, so the idle-replay gate treated the in-flight prompt as leftover journal: Working never appeared, refresh dropped the latest bubble, and later tokens were discarded. The sender tab does not use that gate. After refresh, `/chat/watch` replay includes `session_assigned`, and the client marked every viewer as the owner of POST `/chat`, which dropped every following user, thinking, and tool event until the turn was fully on disk.
  - **Implementation Mechanism**: An open user tail is a live turn: it does not arm the idle gate, and an empty assistant is inserted so Working can render. Disk inflight is merged onto a sync canvas instead of being skipped. `session_assigned` claims the turn only when this tab already owns the POST `/chat` stream. A repeated prompt is held during idle replay and released only when the next delta does not continue the previous assistant, so an already-painted thinking block is still not appended a second time.
  - **Verification & Testing**: `node --test src/lib/chatTerminal.test.ts src/lib/sessionProjection.test.ts` (45 passed) and `npx tsc --noEmit` in `webui`.

---

- **[WebUI / 实时回合同步] 外部 `--host` 观察者和刷新后的发送端都会保住正在进行的回合并继续渲染**:
  - **技术机理 / 现象溯源**: 外部浏览器带 `sync=1` 进入。`/live` 快照经常仍是上一轮已完成的对话，空闲回放闸门把本轮提问当成残留日志：不显示 Working，刷新后最新气泡消失，随后的 token 被丢掉。发送端不走这条闸门。刷新后 `/chat/watch` 回放带有 `session_assigned`，客户端把所有观看者都标成 POST `/chat` 的拥有者，于是后面的用户消息、思考块和工具事件全部被丢弃，直到整轮落盘。
  - **实现防线 / 核心改动**: 以用户提问结尾、后面还没有助手正文的记录视为进行中的回合：不开启空闲闸门，并补上空白助手气泡，Working 才能画出来。同步画布会并入磁盘上的进行中记录，不再跳过。只有本标签已经持有 POST `/chat` 流时，`session_assigned` 才会把回合记成自己的。重复的提问在空闲回放里先挂起，只有下一截内容不属于上一条助手回复时才放出来；已经画过的思考块不会再追加一次。
  - **验证与交付**: `webui` 下 `node --test src/lib/chatTerminal.test.ts src/lib/sessionProjection.test.ts`（45 项通过）以及 `npx tsc --noEmit`。

## v7.2.0-beta.7 (2026-10-07)

- **[Docs Site & Navigation / Streamlined Installation Guide & Clean Sidebar Layout] Restructure Quick Installation to cover TUI & Desktop, eliminate top-left title border artifact, and widen sidebar for single-line title display**:
  - **Technical Root Cause / Detail**: The docs site installation guides had redundant WebUI daemon sections already covered in Quickstart, Desktop application guides were fragmented into a separate deploy section, top-left logo link had an orphaned 136px `border-bottom` artifact under `.VPNavBarTitle .title`, and sidebar width (`272px`) forced long Chinese and English feature titles to wrap awkwardly.
  - **Implementation Mechanism**: Unified desktop app installation into `Quick Installation (TUI, Desktop)` / `快速安装（TUI、桌面端）` while removing duplicate WebUI and verification sections; eliminated standalone `deploy/desktop.md` pages; explicitly cleared `.VPNavBarTitle .title` border-bottom and adjusted navbar glassmorphism borders; expanded `--vp-sidebar-width` to `324px` (`340px` on wide screens) for clean single-line title rendering; updated API compatibility titles to `API 兼容端点（OpenAI、Anthropic）`.
  - **Verification & Testing**: Successfully built with VitePress `npm run docs:build` (0 errors), verified dev server hot reloads, and verified layout fidelity.

- **[Capabilities & Engine / Directory Reading Budgeting & Git Panel Real-Time Fingerprinting] Enhance `read` directory pagination budgeting and real-time Git status tracking in WebUI**:
  - **Technical Root Cause / Detail**: Large directory listings could breach payload byte limits or leave ambiguous continuation footers; additionally, WebUI Git panel polling lacked stable fingerprinting to avoid unnecessary DOM redraws or dropped turn replays during live reconnections.
  - **Implementation Mechanism**: Refactored `ReadFileTool` directory rendering with strict output budgeting reserve (`DIR_CHROME_RESERVE`) and comprehensive pagination continuation footers recommending `glob`, `grep`, and `code_explore`; added `gitPanelFingerprint` to track worktree status and commit history immutably; introduced `idleReplayAlreadyPainted` to prevent stale journal playback while gracefully streaming live assistant thinking and tool results.
  - **Verification & Testing**: Executed `cargo check --lib -p jeikcode-daemon`, `cargo test` on read tools, `node --test` across 61 webui test suites (all 61 passed), and `npm run build` in `webui`.

---

- **[文档站点与导航体验 / 快速安装精简重构与侧边栏体验升级] 重构「快速安装（TUI、桌面端）」指南，消除左上角标题下边框孤立残影，加宽侧边栏实现标题单行完整展示**:
  - **技术机理 / 现象溯源**: 官方文档中桌面端应用原先散落在独立的 `deploy` 章节，且安装指南夹杂了快速开始中已有的 WebUI 远程访问与启动命令；顶栏站点标题 `.VPNavBarTitle .title` 在含有侧边栏时生成了 136px 孤立下边框灰色横条；原侧边栏宽度（272px）导致多处中英文长标题被被迫折行。
  - **实现防线 / 核心改动**: 将桌面端安装完全并入「快速安装（TUI、桌面端）」指南，剔除多余启动验证与重复 WebUI 内容并彻底清理废弃独立页面；在 `custom.css` 中重写 `.VPNavBarTitle .title` 边框样式彻底消除灰色孤立条条，加宽 `--vp-sidebar-width` 至 324px（大屏 340px）保证标题单行优雅展示；同步对齐「API 兼容端点（OpenAI、Anthropic）」双语大标题与侧边栏路由。
  - **验证与交付**: VitePress `npm run docs:build` 验证通过（0 警告 0 报错），本地服务热重载验证通过。

- **[运行时与交互引擎 / 目录读取预算控制与 WebUI Git 面板指纹监听] 增强目录列表分段读取与自适应引导，健全 Git 面板状态指纹与重放去重**:
  - **技术机理 / 现象溯源**: 大目录读取容易超出单次响应字节预算且缺乏直观指引；WebUI Git 面板在并发工具执行与重连时缺乏稳定指纹机制以避免不必要的界面抖动与重放文本冗余。
  - **实现防线 / 核心改动**: 在 `ReadFileTool` 目录输出中引入字节预留预算与引导尾注（推荐使用 `glob`/`grep`/`code_explore`）；在 WebUI 中实现 `gitPanelFingerprint` 实时监听工作区变更，增加 `idleReplayAlreadyPainted` 状态门控精准识别已渲染推理流与工具执行状态。
  - **验证与交付**: 运行 `cargo check --lib -p jeikcode-daemon`，执行 WebUI 61 项单元测试全量通过，`webui` 构建成功。

## v7.2.0-beta.6 (2026-10-07)

- **[Tools & Capabilities / Config Action Unification & Obsolete Tool Purge] Consolidate `jeikcode_config_reload` into `jeikcode_config` and cleanly eliminate deprecated tools**:
  - **Technical Root Cause / Detail**: Configuration management tools were historically fragmented across separate implementations (`jeikcode_config_guide` and `jeikcode_config_reload`), and internal prompts/documents still retained obsolete tools (`list_directory`, `bash_kill_by_id`, `open_file`, `global_search_replace`) and stale tool names (`read_file`, `bash`).
  - **Implementation Mechanism**: Unified configuration operations under `jeikcode_config` with `action: "guide" | "reload"`, adding `#[serde(default, alias = "actions")]` to gracefully tolerate alias serialization and removing the dead `jeikcode_config_reload` module. Purged all traces of defunct tools from `root_docs_内置工具.yaml`, `builtin-tools.txt`, and modular `teaches/` guides without writing noisy deprecation warnings. Canonized `read` with its strict schema (`path`, `offset`, `limit`, `key_string`, `upward`, `downward`, `max_matches`), verified plain text responses with dynamic footers for markdown and edit safety, and updated `run_command` documentation to detail native OS PID and port inspection.
  - **Verification & Testing**: Executed `cargo test -p jeikcode-capabilities --lib tools::jeikcode_config_guide::` (9 passed), `tools::read::` (38 passed), and verified schema integrity via `ci_check_keywords_and_constants_integrity`.

- **[WebUI & Canvas Engine / Truncated Thinking Stream In-Place Extension] Fix duplicate reasoning block generation during watch replay under display truncation**:
  - **Technical Root Cause / Detail**: When the daemon replayed streaming transcript events over `/chat/watch`, reasoning tokens that underwent display truncation carried `DISPLAY_TRUNCATION_MARK` (`\n… [truncated for display]`). Strict prefix matching treated the truncated block as distinct, causing the UI to paint a second, disconnected thinking block.
  - **Implementation Mechanism**: Enhanced `chatTerminal.ts` and `sessionProjection.ts` to detect `DISPLAY_TRUNCATION_MARK` during watch replay and transcript extension. Rather than appending a duplicate thinking node, the canvas projection strips the truncation marker and performs an in-place extension on the active reasoning buffer.
  - **Verification & Testing**: Added unit tests in `sessionProjection.test.ts` for truncated thinking in-place extension (4/4 passed) and verified clean production compilation with `npm run build` in `webui`.

---

- **[工具与能力层 / 配置工具动作收敛与废弃工具彻底清理] 将配置重载工具并入 `jeikcode_config`，彻底清理历史废弃工具与文档命名偏差**:
  - **技术机理 / 现象溯源**: 历史版本中配置管理分散在独立工具 `jeikcode_config_reload` 与 `jeikcode_config_guide`，且内置文档与提示词存在已废弃工具（`list_directory`、`bash_kill_by_id`、`open_file`、`global_search_replace`）残留与旧工具名（`read_file`、`bash`）混用问题。
  - **实现防线 / 核心改动**: 将配置管理功能统一收敛至 `jeikcode_config(action="reload"|"guide")`，通过 `#[serde(default, alias = "actions")]` 支持 `actions` 别名字段无缝兼容，并彻底物理移除 `jeikcode_config_reload` 冗余模块；在 `root_docs_内置工具.yaml`、`builtin-tools.txt` 与全部 9 篇 `teaches/` 文档中彻底剔除废除工具，不添加任何陈旧废弃声明；全面对齐权威工具命名（`read`、`write`、`edit`、`run_command`），确保 `read` 文本响应与动态尾注机制兼容语法高亮与局部编辑，完善 `run_command` 后台任务返回 PID 与端口的原生管理说明。
  - **验证与交付**: 运行 `jeikcode_config_guide`（9 项通过）、`read` 全量测试（38 项通过）及 `ci_check_keywords_and_constants_integrity` 确保契约一致。

- **[WebUI 与会话投影 / 截断思考流平滑原地扩展] 修复前端在重放截断推理流时产生重复思考气泡的渲染缺陷**:
  - **技术机理 / 现象溯源**: 当 `/chat/watch` 流重放包含 `DISPLAY_TRUNCATION_MARK`（`\n… [truncated for display]`）的截断思考块时，严格前缀匹配误判新旧内容不连续，导致前端在会话画布中额外追加一个新的断裂思考卡片。
  - **实现防线 / 核心改动**: 在 `webui/src/lib/chatTerminal.ts` 与 `sessionProjection.ts` 中引入截断标记感知的流重合比对逻辑，在检测到已有思考块带有显示截断标记时自动原地剥离并平滑补全，避免重复生成思考节点。
  - **验证与交付**: 补充 `sessionProjection.test.ts` 专项单测（4/4 通过），并在 `webui` 目录下执行 `npm run build` 成功完成生产打包。

## v7.2.0-beta.5 (2026-10-07)

- **[Capabilities & Tools / Read Tool Lifecycle & Schema Hardening] Complete bidirectional mode closure, 3A-3D / 4A-4D footer state machines, and discriminated union serialization for `read`**:
  - **Technical Root Cause / Detail**: Previously, the `read` tool suffered from leaky defaults in its parameter schema, conflicting mutex requirements, and incomplete footer lifecycles. Slice paging and `key_string` anchor mode lacked unified recovery paths under byte truncation, risking conversational deadlocks and redundant roundtrips.
  - **Implementation Mechanism**: Hardened `ReadFileTool` schema by pruning schema defaults and retaining only `path` as required, silently absorbing mutually exclusive parameters across modes. Established comprehensive 3A–3D range slicing footers and 4A–4D `key_string` anchor templates, notably implementing dynamic `fallback_offset` / `fallback_limit` calculations in 4C to guarantee single-pass recovery to range paging under byte-budget limits. Refactored response payload into `ReadResponse` with `ReadMeta` discriminated union (`#[serde(tag = "mode")]`), deriving top-level `mode` immutably to eliminate drift while pruning all optional fields to prevent `null` contamination.
  - **Verification & Testing**: Added and executed 38 dedicated unit tests in `tools::read::tests`, validating negative offsets, sparse line anchors, mode transitions, and schema invariants cleanly.

- **[Knowledge Base & System / Modular Teaches Streamlining & Subtle Parameter Hardening] Distill full modular `teaches` guides into crisp configuration tutorials, eliminate architectural theory bloat, and document critical subtle parameter behaviors**:
  - **Technical Root Cause / Detail**: Modular teaches documents (`teaches/*.md`) were cluttered with hundreds of lines of internal architectural narratives, theoretical justifications (Topological Reordering, VersionRing, 3-Way Auto-Rebase, Linux ETXTBSY lock mechanics), diluting high-density signal needed by models and developers.
  - **Implementation Mechanism**: Refactored all 9 documents across `crates/jeikcode-capabilities/assets/teaches/` down to a strict four-element model: exact configuration paths, precise snippet syntax, hot-reload behavior (mtime automatic vs explicit trigger), and direct operational effects. Restrainedly clarified subtle parameter distinctions, including `scope: "session"` MCP process reclamation after 10 minutes of inactivity (`idle_ttl_secs`), `maxConcurrentCalls` UI tool concurrency gating, `reasoning_history` ("exclude" vs "include") multi-turn trace transmission, `coalesce_system`, and the 3-tier bash timeout hierarchy.
  - **Verification & Testing**: Passed all 8 `jeikcode_config_guide` tests with zero regressions.

- **[CI Pipeline & Quality Engineering / Capabilities Integration Test Suite Activation] Fix legacy tool assertions in `tools_integration.rs` and officially integrate the 35-test integration suite into CI**:
  - **Technical Root Cause / Detail**: The 11 integration test files under `crates/jeikcode-capabilities/tests/` were compiled via `cargo check --all-targets` but never actually executed in CI pipelines. Furthermore, `tools_integration.rs` retained stale assertions referencing pre-unification tool names (`read_file`, `write_file`, `edit_file`, `list_directory`), causing it to fail if run.
  - **Implementation Mechanism**: Modernized core tool assertions in `crates/jeikcode-capabilities/tests/tools_integration.rs` to match authoritative unified tools (`read`, `write`, `edit`, `run_command`, `grep`, `glob`). Updated `.github/workflows/ci.yml` in the `rust-quality` job to run the comprehensive capabilities integration suite (`tools_integration`, `http_mock`, `anthropic_mock`, `ollama_mock`, `compaction_cache`, `session_fixture_invariants`), transforming dormant integration tests into an active gating defense.
  - **Verification & Testing**: Ran the full 35-test suite locally in under 2 seconds with 100% pass rate, and verified end-to-end compilation with `cargo check --lib -p jeikcode-daemon`.

- **[WebUI & Canvas Engine / Multi-Stream Projection & Session State Reconciliation] Introduce dedicated `sessionProjection` canvas pipeline, prevent watch-replay duplicate turns, and synchronize live TodoList baseline**:
  - **Technical Root Cause / Detail**: During active turns, concurrent `/chat/watch` events, background disk polling, tab switching, and page reloads could fight over the React messages canvas. A fixed lookback limit in `userMessageAlreadyOnCanvas` risked duplicate user bubble appends in long sessions. When watch streams replayed coalesced deltas, text was often duplicated, and incremental `todowrite` events dispatched before React state hydration folded against empty arrays, dropping prior task items.
  - **Implementation Mechanism**: Introduced decoupled `webui/src/lib/sessionProjection.ts` and `sessionProjection.test.ts` to manage deterministic canvas rendering across cold starts, incognito sessions, and active stream reconciliations (`reconcileRunningTranscript`). Expanded `userMessageAlreadyOnCanvas` to scan across the complete canvas length. Added `unpaintedReplaySuffix` and `visibleToolChunk` to deduplicate coalesced replay text, reasoning tokens, and streaming tool outputs. Implemented `todoBaselineForLiveApply` in `todos.ts` to prioritize hydrated ref baselines over uninitialized React state, ensuring incremental task updates never drop previous checklist plans.
  - **Verification & Testing**: Passed all 317 WebUI unit tests including new `sessionProjection.test.ts` and `todos.test.ts`, and verified production bundle with `npm --prefix webui run build`.

---

- **[能力层与工具系统 / Read 工具生命周期与契约收网] 全面闭合 `read` 工具双模式状态机、3A-3D / 4A-4D 尾注契约与标签化联合元数据序列化**:
  - **技术机理 / 现象溯源**: 此前 `read` 工具在参数 Schema、执行层和提示词层存在默认值污染与约束冲突，切片分页与 `key_string` 锚点模式在遇到字节预算截断时缺乏闭环的续读引导，容易导致模型在多轮会话中陷入死循环翻页或冗余调用。
  - **实现防线 / 核心改动**: 精简 `read` 的参数 Schema，仅保留必填 `path`，其余模式互斥参数改为静默吸收策略；确立了 Range 模式（3A-3D）与 `key_string` 锚点模式（4A-4D）的完整尾注模板，特别是在 4C 字节截断场景下自动换算 `fallback_offset` / `fallback_limit`，实现锚点模式向分页模式的单向状态转移；重构响应信封为带 `#[serde(tag = "mode")]` 的 `ReadMeta` 标签化联合（Discriminated Union），顶层 `mode` 纯函数派生保证恒等，可选字段按需序列化消灭 `null` 冗余。
  - **验证与交付**: `tools::read::tests` 38 项单测全绿通过，覆盖负数 offset、稀疏行锚点、状态机四态流转及防漂移断言。

- **[知识库与系统指南 / 内置 Teaches 文档全面治理与精简] 彻底剔除底层机理与长篇理论描述，收敛为极简配置教程并讲透微小参数细微差异**:
  - **技术机理 / 现象溯源**: 原 `teaches/*.md` 知识库包含大量底层算法原理解析（如 Topological Reordering、VersionRing 历史快照环、3-Way 变基算法、Linux ETXTBSY 内核锁机制），信息密度低且冗余，不符合指南知识源的高信噪比需求。
  - **实现防线 / 核心改动**: 重构并精简 `crates/jeikcode-capabilities/assets/teaches/` 下全部 9 篇文档，收敛为统一的“文件在哪 + 改动什么 + 是否自动热生效 + 触发方式”四要素结构；以克制精准的语言讲透关键微小参数的行为差异，涵盖 `scope: "session"` 模式下 10 分钟闲置自动回收机制（`idle_ttl_secs`）、`maxConcurrentCalls` 独占保护、`reasoning_history` 思考过程多轮回传策略、`coalesce_system` 缓存控制及 `[tools.bash]` 三档超时判定阶梯。
  - **验证与交付**: `jeikcode_config_guide` 8 项测试全量通过，文档体积缩减逾 50%。

- **[CI 流水线与质量工程 / Capabilities 集成测试套件正式纳管] 修复 `tools_integration.rs` 历史工具名断言，将 35 项端到端集成测试接入 CI 必跑防线**:
  - **技术机理 / 现象溯源**: `crates/jeikcode-capabilities/tests/` 下的 11 个集成测试文件此前仅在 CI 中参与类型编译检查，从未真正执行；且 `tools_integration.rs` 内部断言仍匹配历史旧工具名（`read_file`, `write_file`, `edit_file`, `list_directory`），导致集成测试一旦执行便会报错挂掉。
  - **实现防线 / 核心改动**: 将 `tools_integration.rs` 的核心工具断言更新为当前权威统一的 `read`、`write`、`edit`、`run_command`、`grep`、`glob`；在 `.github/workflows/ci.yml` 的 `rust-quality` 任务中增加集成测试套件执行步骤（覆盖 `tools_integration`, `http_mock`, `anthropic_mock`, `ollama_mock`, `compaction_cache`, `session_fixture_invariants`），使 35 项关键集成测试成为流水线每次触发的真实防线。
  - **验证与交付**: 35 项跨模块集成测试本地 1.3 秒极速通过，`cargo check --lib -p jeikcode-daemon` 编译校验通过。

- **[WebUI 与画布状态引擎 / 多流投影重合与会话状态调和] 重构引入独立 `sessionProjection` 状态管道，杜绝 Watch 重放气泡错位倒置与重复追加，并端到端同步实时任务清单基线**:
  - **技术机理 / 现象溯源**: 在活跃轮次中，并发的 `/chat/watch` 流、后台磁盘轮询、多标签页切换及页面刷新容易在 React 消息状态上产生竞争冲突。原画布检测窗口仍有边界限制，极长会话中用户提问仍可能被当作新消息置底追加；watch 重放的聚合增量容易导致文本与思考重复渲染；且在 React 状态未水合前到达的增量 `todowrite` 动作容易基于空数组 `[]` 折叠，导致已有任务清单被冲刷覆盖。
  - **实现防线 / 核心改动**: 构建独立的 `webui/src/lib/sessionProjection.ts` 投影层，统筹冷启动、无痕模式与活跃流的数据调和（`reconcileRunningTranscript`）；将 `userMessageAlreadyOnCanvas` 扩展为全画布穿透比对；引入 `unpaintedReplaySuffix` 与 `visibleToolChunk` 精准剥离重放中的已渲染文本、思考与工具输出增量；在 `todos.ts` 中实现 `todoBaselineForLiveApply`，优先绑定已水合的 ref 基准，确保增量任务操作绝不丢失既有清单。
  - **验证与交付**: `sessionProjection.test.ts` 与 `todos.test.ts` 等 317 项前端单测全绿，`webui` 生产构建（Vite）打包验证通过。

## v7.2.0-beta.4 (2026-10-07)

- **[Capabilities & Tools / Codebase Tools Streamlining] Retire standalone `repo_map` from model-facing tools catalog, consolidating all structural tree capability into `read`**:
  - **Technical Root Cause / Detail**: With `read` natively adopting index-backed 2-level architectural directory mapping and single-level fallbacks, keeping `repo_map` in the model-facing tool catalog introduced redundant cognitive tool-choice overhead and conflicting prompt guidance.
  - **Implementation Mechanism**: Removed `repo_map` from `codeintel_tool_names()` and `register_codeintel_tools_with_mode()` in `crates/jeikcode-capabilities/src/codeintel/mod.rs`, leaving `code_explore` as the sole specialized code-intelligence tool. Purged `repo_map` from `default_no_fold_tools` across `config/mod.rs`, `default-config.toml`, and builtin tool catalogs. Updated `crates/jeikcode-coding/src/assemble.rs` test suite to assert `repo_map` is cleanly retired.
  - **Verification & Testing**: Passed all `assemble::tests` and `codeintel` test suites, and verified with `cargo check --lib -p jeikcode-daemon`.

- **[WebUI & Task Engine / Mobile Reconnect Resilience & TodoList State Sync] Fix mobile background disconnects, prevent user message bubble displacement after reload, and synchronize authoritative TodoList state**:
  - **Technical Root Cause / Detail**: Mobile browsers freeze background tabs, silently breaking long-lived SSE connections. Upon foreground switch, `refreshOnFocus` failed to detect severed sockets, leaving the UI deadlocked in a broken state. When users refreshed or re-entered via incognito, a narrow 8-message deduplication window (`userMessageAlreadyOnCanvas`) caused existing user questions to slip past detection and get erroneously re-appended to the very bottom, causing AI tokens to stream below the user bubble. Furthermore, incremental `todo_write` calls during detached reattach reduced against an empty baseline when the initial full plan fell outside the message history window, shrinking multi-task checklists into a single card.
  - **Implementation Mechanism**: Enhanced `userMessageAlreadyOnCanvas` in `webui/src/lib/chatTerminal.ts` to scan across a deep 100-message canvas window, completely preventing misplaced user echo appends. Added automatic active-session reconnection and freshness catch-up to `refreshOnFocus` in `Chat.tsx` on `visibilitychange`. Extended backend `SessionDetail` in `crates/jeikcode-daemon/src/lib.rs` to derive and deliver authoritative `todos` from the full session transcript, and updated `reduceTodosFromCalls` in `webui/src/lib/todos.ts` to fold incremental actions against prior baseline stashes rather than empty arrays. Uncollapsed `SessionTodoPanel` by default to display the full multi-step task list.
  - **Verification & Testing**: Passed all 25 `todos.test.ts` tests, 36 `chatTerminal.test.ts` tests, 63 backend `tools::todo::tests`, and executed `npm run build` in `webui` cleanly.

---

- **[能力层与工具系统 / 核心工具集精简化] 正式从面向模型的工具集中退役 `repo_map` 工具，代码全览能力完全归一至 `read`**:
  - **技术机理 / 现象溯源**: 鉴于 `read` 工具已在底层全面接管基于代码图谱的 2 层架构树全览与单层自适应降级，继续在模型工具集中挂载独立的 `repo_map` 工具会导致模型在工具选择上产生认知困扰，且提示词出现冗余分支。
  - **实现防线 / 核心改动**: 在 `crates/jeikcode-capabilities/src/codeintel/mod.rs` 中将 `repo_map` 从 `codeintel_tool_names()` 和挂载注册中彻底移除，代码智能核心工具统一收敛为唯一主角 `code_explore`；从全局配置与各端资产的 `default_no_fold_tools` 白名单中移除 `repo_map`；同步更新 `crates/jeikcode-coding/src/assemble.rs` 单元测试，将 `repo_map` 纳入已退役工具断言列表。
  - **验证与交付**: `assemble::tests` 及 `codeintel` 单元测试全绿通过，`cargo check --lib -p jeikcode-daemon` 编译校验通过。

- **[WebUI 与任务状态机 / 移动端重连韧性与任务清单状态同步] 根治移动端退后台断开、修复大退刷新后用户气泡错位倒置、并端到端同步权威 TodoList 状态**:
  - **技术机理 / 现象溯源**: 移动端切后台后系统挂起导致 SSE 长连接中断，切回前台时原 `refreshOnFocus` 缺乏重连机制导致连接假死；大退或断线刷新后，因前端回溯窗口硬编码为 8 条，导致长回合中的用户提问滑出检测范围，在 watch 重放时被错误重新追加到画布最末尾，使得后续 AI 回复从该气泡下方吐出；此外，当最初的全量 plan 处于历史分页之外时，重连后的增量 `todo_write` 动作由于缺乏基准状态而退化为从空数组 `[]` 开始计算，导致前端多任务清单诡异消失仅剩 1 张卡片。
  - **实现防线 / 核心改动**: 在 `webui/src/lib/chatTerminal.ts` 中将 `userMessageAlreadyOnCanvas` 扩展为 100 条全量穿透回溯比对，彻底杜绝已存在的用户提问被置底追加；在 `Chat.tsx` 的 `visibilitychange` 事件中注入自动重连守卫，移动端切回前台时静默探测活跃状态并无感恢复连接；在后端 `SessionDetail` 中直接利用全量快照推导权威 `todos` 下发前端，并在前端 `reduceTodosFromCalls` 中增加 `baselineFallback` 兜底防线，杜绝从空列表开始累加增量动作；默认展开 `SessionTodoPanel` 完整任务清单。
  - **验证与交付**: `todos.test.ts` 25 项测试、`chatTerminal.test.ts` 36 项测试、Rust `tools::todo::tests` 63 项测试全部通过，`webui` 前端构建全量通过。

## v7.2.0-beta.3 (2026-10-07)

- **[Capabilities & Tools / Codebase Exploration & Adaptive Reading] Consolidate `repo_map` architectural overview into `read`, eliminate negative offset prompt steering, remove file size noise from directory listings, purge symbol extraction bloat, and introduce project-level `.codegraphignore`**:
  - **Technical Root Cause / Detail**: Previously, the `read` tool's schema carried negative prompting ("Only provide if the file is too large to read at once"), misleading LLMs into omitting `offset` during initial reads and file paging. Directory listings performed unnecessary file-metadata lookups and appended noisy size tags (`(60.9 KB)`), diluting context tokens. The standalone `repo_map` tool suffered from scope leakage (leaking unrelated project symbols into scoped paths) and symbol bloat (extracting low-signal HTML tags).
  - **Implementation Mechanism**: Upgraded `read` in `crates/jeikcode-capabilities/src/tools/read.rs` to automatically render an index-backed 2-level architectural tree when reading directories without explicit pagination, seamlessly falling back to clean single-level listings when unindexed. Removed negative phrasing from `offset` parameter schema and eliminated file-size formatting from directory entries. Streamlined `repo_map.rs` by removing legacy symbol extraction and obsolete `full`/`symbols` modes. Purged legacy `repo_map` references across system prompts (`rules.yaml`, `root_docs_内置工具.yaml`, `persona.rs`, `code_tools_first.rs`) and Teaches documents. Added project-level `.codegraphignore` rules ignoring static sites, caches, and test artifacts.
  - **Verification & Testing**: Passed all 35 `tools::read` tests, 2 `repo_map` tests, 42 `persona` tests, and 11 `code_tools_first` tests. Validated with `cargo fmt` and `cargo check --lib -p jeikcode-daemon`.

- **[WebUI & Streaming Engine / Watch Conflict Isolation & Local Turn Protection] Protect local in-flight turns from premature state resets and isolate streaming from idle watch conflicts**:
  - **Technical Root Cause / Detail**: During active turns initiated by the local web client, background watch polling or slight synchronisation delays in active session lists could prematurely drop the busy state or attach duplicate watch connections, risking dual-stream race conditions and transcript fragmentation.
  - **Implementation Mechanism**: Fortified `webui/src/components/Chat.tsx` by tracking local active session turns (`localTurnSessionsRef`) across generation lifetimes; ensured `setBusyAndClock(true)` remains enforced when in-flight, preventing 2.5s timeouts from misidentifying active turns as idle; strictly prevented idle watch connection creation when local turns are active; and added `requireReplayDedup` protection when handling replay and watch events.
  - **Verification & Testing**: Ran `npm run build` in `webui` successfully.

---

- **[能力层与工具系统 / 代码库全览与自适应阅读] 将 `repo_map` 架构全览能力收敛至 `read` 工具、彻底消除 offset 负向诱导与目录文件大小杂余、移除符号提取噪音并配置项目级 `.codegraphignore`**:
  - **技术机理 / 现象溯源**: 此前 `read` 工具参数 schema 存在“只有文件过大才提供”的负向暗示，导致模型在初次调用或需要分页时本能偷懒不传 `offset`；目录展示对每个文件执行元数据系统调用并追加冗余的大小标记（如 `(60.9 KB)`），浪费 Token 并分散注意力；独立 `repo_map` 工具存在子目录查询时泄露全局不相关符号的作用域 Bug，且符号大纲提取中充斥无意义的纯 HTML 原生标签（如 `ui div`、`ui span`）。
  - **实现防线 / 核心改动**: 在 `crates/jeikcode-capabilities/src/tools/read.rs` 中将 `repo_map` 的全览能力融合接入：在读取目录且未传分页参数时优先自动渲染紧凑的 2 层架构树，无索引时平滑降级为纯净单层展示；彻底剔除 `offset` schema 中的负向诱导描述，并在截断尾注中提供显式动作指引；去除目录列表中的文件大小拼接；重构 `repo_map.rs`，彻底废弃冗余的 `full`/`symbols` 模式与符号打分杂余；地毯式清理全仓提示词（`rules.yaml`、内置工具字典、`persona.rs`、`code_tools_first.rs`）及 Teaches 知识库中关于 `repo_map` 的残留唠叨；在 `.jeikcode/.codegraphignore` 中配置项目级站点产物与缓存过滤。
  - **验证与交付**: `tools::read` 的 35 项单测、`repo_map` 2 项单测、`persona` 42 项单测、`code_tools_first` 11 项单测全部绿灯通过，`cargo fmt` 格式化规范检查通过，`cargo check --lib -p jeikcode-daemon` 编译校验通过。

- **[WebUI 与流式引擎 / 待机冲突隔离与本地轮次守护] 守护本地活跃生成状态免遭提前重置，并杜绝待机监听流与主流冲突**:
  - **技术机理 / 现象溯源**: 当 Web 端正在发起本地流式生成时，后端会话活跃列表的微秒级同步滞后或超过 2.5 秒的耗时可能会导致忙碌状态被意外解除；同时待机监听流（idle watch）的不当连接可能产生双流竞争与正文撕裂隐患。
  - **实现防线 / 核心改动**: 在 `webui/src/components/Chat.tsx` 中通过 `localTurnSessionsRef` 登记并守护本地轮次；无论后端同步状态如何，只要本端有活跃轮次即坚决锁定忙碌态（`busyRef`）；在存在本地活跃发送流时坚决杜绝建立任何待机 watch 连接；在消费重放与监听事件时追加 `requireReplayDedup` 去重保护。
  - **验证与交付**: `webui` 目录下执行 `npm run build` 构建编译全量通过。

## v7.2.0-beta.2 (2026-10-07)

- **[Capabilities & Tools / Shell Hardening & Precision Reading] Fix Windows WSL bash hijacking in `run_command`, enhance `read` with anchor matching, and modernize notification audio**:
  - **Technical Root Cause / Detail**: On Windows environments with WSL enabled, running scripts with `#!/usr/bin/env bash` shebangs (such as Node.js `npm`/`npx` wrappers) through `run_command` previously triggered exit code 127 (`No such file or directory`) because Windows `System32\bash.exe` shadowed Git Bash's `/usr/bin/bash` in `PATH` and failed to resolve MSYS2 drive paths (`/d/...`). Furthermore, inspecting symbols in large files previously required reading entire pages or manual offset guessing, OS desktop toasts suffered from unstackable popup spam, and legacy `.atomcode` database paths lingered in `index_db.rs`.
  - **Implementation Mechanism**: Hardened Windows shell execution in `crates/jeikcode-capabilities/src/tools/bash.rs` by prepending a dedicated `/tmp/.jeikcode_shims` directory containing Git Bash `bash`/`sh` symlinks to `PATH`, completely eliminating WSL binary shadowing while preserving native Windows compiler precedence. Upgraded `read` tool with `key_string`, `upward`, `downward`, and `max_matches` arguments supporting 4-tier fuzzy matching and centered inspection windows with line numbers. Replaced OS popup toasts with pure platform alert sounds (`MessageBeep`, `afplay`, `paplay`) protected by an 800ms atomic debounce lock in `notify.rs`. Purged legacy `.atomcode` fallback in `index_db.rs`.
  - **Verification & Testing**: Passed all 34 read tool unit tests in `jeikcode-capabilities`, verified `npm` execution via the new shim mechanism, and passed `cargo check --lib -p jeikcode-daemon`.

- **[WebUI & Chat Interface / Stream Integrity & Multi-Repo Navigation] Shield active streaming against watch stream tearing, eliminate scroll jitter, and add multi-repo Git switching**:
  - **Technical Root Cause / Detail**: During active agent generation, watch stream reattachment could race with local streams and pop typing message bubbles, resulting in truncated or shredded assistant transcripts. In addition, browser scroll anchoring caused visual jitter during rapid streaming, user steering envelopes leaked into the session outline rail, and multi-repo workspaces lacked Git panel switching.
  - **Implementation Mechanism**: Fortified `Chat.tsx` with guard rails that forbid watch stream connection or bubble dropping while `abortRef` or `activeStreamRequestIdRef` holds an active stream. Applied `overflow-anchor: none` to the chat scroll container to ensure silky smooth pinned scrolling. Applied `stripSteerEnvelopeForDisplay` across `turnNav.ts` to keep navigation clean. Implemented `fetchGitRepos` workspace repository switching and status auto-refresh in `Chat.tsx`.
  - **Verification & Testing**: Executed `npm run build` in `webui` (tsc + vite) successfully and passed all 20 tests in `historyMessages.test.ts` and `turnNav.test.ts`.

---

- **[能力层与工具系统 / Shell 加固与精准阅读] 根治 Windows WSL bash 路径劫持、强化 `read` 锚点定位并升级轻量系统通知音**:
  - **技术机理 / 现象溯源**: 在启用了 WSL 的 Windows 机器上，`run_command` 执行带 `#!/usr/bin/env bash` Shebang 的脚本（如 Node.js 自带的 `npm`/`npx` 包装器）时，因系统 `System32\bash.exe` 在 PATH 中先于 Git Bash 被 `env` 检索，导致 WSL 的 Linux bash 被误唤起并因无法识别 MSYS2 盘符路径（如 `/d/...`）报出 127 错误；同时大文件符号检视缺乏精准锚点窗口支持、系统级 Toast 弹窗存在无法堆叠的弹窗轰炸问题，且 `index_db.rs` 存在历史遗留路径。
  - **实现防线 / 核心改动**: 在 `crates/jeikcode-capabilities/src/tools/bash.rs` 的 Windows bash 初始化逻辑中，注入最高优先级的 `/tmp/.jeikcode_shims` 目录并建立指向当前 Git Bash `bash`/`sh` 的软链接，彻底杜绝 WSL `System32\bash.exe` 劫持 `env bash`，同时严密保护宿主原生编译工具链（Cargo/MSVC/Python）的优先级；为 `read` 工具引入 `key_string`、`upward`、`downward` 与 `max_matches`，支持四级容错匹配、居中行窗口与精确定位；在 `notify.rs` 中全面移除 OS 弹窗，改为纯系统提示音（`MessageBeep`/`afplay`/`paplay`）并配合 800ms 原子防抖锁；清理 `index_db.rs` 中已废弃的 `.atomcode` 路径。
  - **验证与交付**: `jeikcode-capabilities` 的 34 项 read 工具单测全绿通过，实测 Git Bash 下 `npm` 顺利执行，`cargo check --lib -p jeikcode-daemon` 编译校验通过。

- **[WebUI 与交互界面 / 流式防撕裂与多仓库支持] 阻断流式会话被重放撕裂、消除滚动锚定抖动并支持多仓 Git 切换**:
  - **技术机理 / 现象溯源**: 当本地前端正持有活跃流式输出时，watch stream 的重连与快照重放可能与主流冲突，并错误地将正在打字的消息气泡弹栈截断，造成正文吞字或撕裂；浏览器默认的 `overflow-anchor` 机制在密集吐字时易引发视图抖动与跳动；会话中途插话转向（Steer）信封结构会泄露至右侧大纲导航栏；包含多个 Git 仓库的工作区缺乏仓库切换能力。
  - **实现防线 / 核心改动**: 在 `Chat.tsx` 中建立关键防线，凡本端持有活跃主流（`abortRef` 或 `activeStreamRequestIdRef` 存在），严禁接入 watch stream 或弹栈气泡；在 `#chat-scroll-container` 增加 `overflow-anchor: none`，消除密集流式输出时的滚动位移冲突；在 `turnNav.ts` 中引入 `stripSteerEnvelopeForDisplay` 深度过滤转向信封噪音；在 `Chat.tsx` 中新增多仓库探测（`fetchGitRepos`）与动态切仓支持。
  - **验证与交付**: `webui` 构建（`npm run build`）全量成功，`historyMessages.test.ts` 和 `turnNav.test.ts` 的 20 项单元测试全部通过。

## v7.2.0-beta.1 (2026-10-07)

- **[Prompts & Workflow Rules / Steer & Execution Discipline] Upgrade mid-turn steer prompt guidance and enforce architectural root-cause workflow rules**:
  - **Technical Root Cause / Detail**: Previously, mid-turn steer requests lacked explicit safeguards against accidental task cancellation or dropping pending TodoLists, causing models to prematurely abort ongoing user goals upon receiving follow-up input. Furthermore, workflow prompt instructions lacked clear multi-task scope boundaries, objective technical review discipline, and concurrent commit isolation constraints, while redundant `doing_tasks` blocks in prompt configurations caused cognitive duplication.
  - **Implementation Mechanism**: Overhauled `steer_prompt.rs` with a robust 4-pillar guidance framework: non-destructive default retention (`Acknowledge and Retain by Default`), safe-checkpoint transition with automatic resumption (`TodoList Priority Injection and Safe Transition`), testing phase fast-path (`Testing Phase Fast-path`), and surgical conflict replacement (`Surgical Conflict Replacement`). Upgraded `rules.yaml` system prompts with imperative, non-prohibitive task scope awareness, architectural root-cause problem solving (pattern matching, normalization, strategy/adapter patterns, dynamic upstream fallbacks), objective technical review against sycophancy and architectural debt, and commit scope discipline to prevent multi-session collision. Purged redundant `doing_tasks` blocks from prompt templates to ensure a single source of truth under `raw`.
  - **Verification & Testing**: Updated and passed prompt unit tests and integration tests in `crates/jeikcode-coding`, formatted modified Rust code with `cargo fmt`, synchronized user prompts under `~/.jeikcode/prompts/`, and validated version consistency across manifests.

---

- **[提示词工程与工作流规范 / 转向机制与工程执行纪律] 升级会话中途转向 (Steer) 提示词引导架构，并确立架构级根因治理工作流规约**:
  - **技术机理 / 现象溯源**: 此前会话在执行中途接收插话转向请求（Steer）时，缺乏对既有任务及待办清单（TodoList）的明确保留与断点续做约束，导致模型在处理新输入时极易误将新需求当成覆盖指令，从而提前清空或放弃原任务；同时系统工作流提示词缺乏多任务讨论时的执行边界确认、技术方案客观审视准则以及并发提交隔离纪律，且提示词配置文件中存在 `raw` 与 `doing_tasks` 双重冗余。
  - **实现防线 / 核心改动**: 彻底重构 `steer_prompt.rs`，确立四维健壮转向准则：默认保留原任务及清单（非显式指令绝不丢弃）、在语法合规与自洽的检查点安全切换并于新任务完成后自动回跳续做、单测阶段快速暂停并待新老需求合并统一验证、局部冲突仅外科手术式精准置换（A $\to$ B）而不干扰其余不冲突项；在 `rules.yaml` 中以纯祈使避免句式重构任务执行规范，确立任务范围意识（指定任务完成即停机交付，避免擅自扩大范围）、架构级治本原则（倡导模式匹配、归一化、适配器/策略模式与动态兜底，替代死代码与硬编码穷举）、客观技术审视（拒绝盲从讨好与吹毛求疵，主动识别并优化架构隐患）以及严格的提交范围纪律（仅提交自己改动的文件以保障并发安全）；彻底移除 `doing_tasks` 冗余块，统一收敛为单一事实来源。
  - **验证与交付**: 同步更新并验证了 `jeikcode-coding` 模块下的转向提示词单元测试及集成测试断言，执行 `cargo fmt` 确保格式合规，完成本地 `~/.jeikcode/prompts/` 实时配置同步与热重载验证，全仓版本号一致性校验通过。


## v7.2.0-beta.0 (2026-10-07)

- **[Capabilities & Tools / Core Coding Suite] Streamline core coding tools, upgrade file inspection resilience, and direct-pass shell execution**:
  - **Technical Root Cause / Detail**: Previous tool proliferation introduced cognitive confusion and fragmentation across file operations (`list_directory`, `open_file`, `global_search_replace`), prompt bloat with negative nagging, fragile file reading under Windows/CRLF and escaped newlines, and unnecessary wrapper abstractions over bash background processes (`bashid`). Furthermore, `code_explore` and `repo_map` required more precise identifier prioritization and accurate subdirectory scope boundaries.
  - **Implementation Mechanism**: Upgraded the `read` tool into a unified file and directory inspector with negative-offset tail reads, asymmetric anchor slicing, backward keyword search, and 4-tier escape/newline fault tolerance; enhanced `grep` with `word_match` and compact grouped outputs; unchained `run_command` with full flags and pipeline passthrough to native shells; replaced pseudo-bashid with real OS process PID and port reporting; consolidated configuration actions under `jeikcode_config` (guide and reload); purged redundant tools (`list_directory`, `open_file`, `global_search_replace`, `bash_kill_by_id`); hardened WebUI session switching against 409 concurrency conflicts; and modernized GitPanel commit details with responsive layouts and compact action menus.
  - **Verification & Testing**: Executed Rust capability unit test suites (`cargo check --lib -p jeikcode-daemon`), verified version consistency, and tested WebUI builds.

---

- **[能力层与工具系统 / 核心编码工具栈] 全面精简核心编码工具集、强化多层容错文件检查并直通原生 Shell 执行**:
  - **技术机理 / 现象溯源**: 此前核心文件操作存在工具膨胀与认知分歧（`list_directory`、`open_file`、`global_search_replace` 职责重叠），提示词存在负面唠叨（negative nagging）与内部别名噪音；在 Windows CRLF 及跨平台换行转义场景下文件截取存在脆弱性；后台进程过度封装虚拟 `bashid` 掩盖了系统原生进程管控能力；同时 `code_explore` 与 `repo_map` 在子目录过滤与符号精确匹配上仍有优化空间。
  - **实现防线 / 核心改动**: 彻底升级 `read` 工具，统一文件与目录浏览能力，原生支持负数 offset 尾部切片读取、非对称锚点上下切片、反向关键字定位及四级跨平台转义/换行容错；强化 `grep` 支持整词匹配（`word_match`）与紧凑分组输出；直通 `run_command` 支持任意标志位（如 `ls -la`）与复杂管道，废除 `bashid` 改由系统真实 PID 与端口接管后台任务；收敛配置工具为单一 `jeikcode_config`；剔除冗余工具；加固 WebUI 会话并发切换防止 409 竞态，重构 Git 面板响应式提交详情卡片。
  - **验证与交付**: 运行 `cargo check --lib -p jeikcode-daemon` 校验通过，运行版本一致性检查无漂移，WebUI 构建通过。


## v7.1.53-beta.13 (2026-10-06)

- **[Daemon / Approval & Runtime Correlation] Harden interactive approval correlation, eliminate liveness races, and enforce fail-closed runtime semantics**:
  - **Technical Root Cause / Detail**: Tool approvals previously suffered from correlation and liveness races across `/chat`, native `/live`, clients, and desktop notifications. Stale approval responses could outlive their source request; `/chat/permission` could return success before the runtime consumed the decision; daemon and kernel timeouts competed; cancellation could race already-ready approvals; native runtime generations reset upon runtime owner replacement so `(session, generation, request_id)` alone was not durable; reused request ids could resolve against wrong runtime owners; and UI deduplication/notification tags collapsed distinct approvals.
  - **Implementation Mechanism**: Correlated `/chat` approvals by exact `(session_id, approval_id)` with `Expired` tombstones and ACK-on-consume delivery; unified timeout ownership under daemon and disabled competing kernel timers; linearized user stop against approval consumption via per-operation stop gates with fail-closed semantics; assigned stable UUID instance IDs to `CodingRuntimeHandle`; bound `/live/permission` to exact `(session_id, runtime_instance_id, generation, request_id)` and verified `APPROVAL_KIND`; aligned strong live identity across WebUI state, JetBrains / VS Code extensions, and OS notification URIs/tags.
  - **Verification & Testing**: Merged PR #8; passed all targeted unit and concurrency tests across `session_runtime_registry`, `live_hub`, `live_permission`, `chat_permission`, `permission_bridge`, and `tuix`; validated WebUI and Rust CI checks.

---

- **[Daemon / 审批与运行时关联] 全面加固交互式工具审批关联机制、根治生命周期竞态并推行 Fail-Closed 安全语义**:
  - **技术机理 / 现象溯源**: 此前在 `/chat`、原生 `/live`、WebUI、IDE 扩展与系统通知的多端流转中存在多处审批关联失效与生命周期竞态问题：陈旧或重复的审批响应可能穿透至后续不相关的工具调用；`/chat/permission` 在运行时实际消费决定前即提前返回成功；Daemon 与 Kernel 双重定时器相互竞争；用户中断（Stop）与审批确认存在纳秒级调度竞态；原生运行时替换时世代（generation）重置导致三元组无法跨实例隔离；客户端与操作系统通知标签未绑定具体运行时实例，存在幽灵卡片与误放行风险。
  - **实现防线 / 核心改动**: `/chat` 审批改由精确的 `(session_id, approval_id)` 路由并引入 `Expired` 墓碑与两阶段 ACK 确认机制；将交互式超时所有权统一收敛至 Daemon 层并关闭竞争内核定时器；通过各操作独立的 `stop_gate` 线性化停止与审批消费，并发时中断优先并严格 Fail-Closed；为 `CodingRuntimeHandle` 分配全局唯一的实例 ID（`runtime_instance_id`），保留 generation 0 并实施来源戳记；将 `/live/permission` 严格升级为四元组验证并确认 `APPROVAL_KIND`；全链路对齐 WebUI 状态机、VS Code / JetBrains 扩展及系统通知 URI/Tag。
  - **验证与交付**: 合并 PR #8；全量通过 `session_runtime_registry`、`live_hub`、`live_permission`、`chat_permission`、`permission_bridge` 以及 `tuix` 等模块的并发与边界单测；CI 质量门禁全绿通过。


## v7.1.53-beta.12 (2026-10-06)

- **[Release Pipeline / Build & Release] Trigger fresh beta release pipeline and re-synchronize distribution assets**:
  - **Technical Root Cause / Detail**: Re-triggered release pipeline as a clean prerelease re-cut to ensure seamless end-to-end asset distribution and installer script routing across all supported target platforms.
  - **Implementation Mechanism**: Incremented prerelease version sequence to `v7.1.53-beta.12` across core shipping manifests and verified multi-target configuration consistency.
  - **Verification & Testing**: Passed version consistency verification via `node scripts/check-version-consistency.js`.

---

- **[发布流水线与版本交付] 重新触发 Beta 发布流水线并同步多端安装分发资产**:
  - **技术机理 / 现象溯源**: 为确保多端构建产物、Release 资产与一键安装脚本路由在全平台环境下的分发可用性，重新触发全量构建与发版流水线。
  - **实现防线 / 核心改动**: 将预发布版本号一键同步递增至 `v7.1.53-beta.12`，保持各端配置清单严格对齐。
  - **验证与交付**: 运行 `node scripts/check-version-consistency.js` 验证全仓版本清单一致性通过。


## v7.1.53-beta.11 (2026-10-06)

- **[CI & Quality Gates] Restore pull request CI triggers, isolate concurrency keys, and reinstate Windows installer integrity coverage**:
  - **Technical Root Cause / Detail**: Following pipeline streamlining, the `pull_request` trigger was removed while `ci.yml` only listened on branch `push` events, leaving incoming PRs targeting `main` and `beta` without automated quality gate validation prior to merging. Furthermore, installer integrity tests were reduced to Ubuntu-only, leaving Windows PowerShell installers unexercised on hosted Windows runners, and the previous concurrency key lacked event scoping, which could allow branch push events to cancel PR validation runs.
  - **Implementation Mechanism**: Restored `pull_request` triggers for `main` and `beta` branches in `.github/workflows/ci.yml`; isolated concurrency groups using `ci-${{ github.event_name }}-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.ref_name }}` to prevent push/PR run collisions; expanded the `installer-integrity` job into a matrix spanning both `ubuntu-latest` and `windows-latest`.
  - **Verification & Testing**: PR #7 checks passed across Ubuntu and Windows installer integrity suites, Rust quality checks, WebUI build, and version consistency.

---

- **[CI 与质量门禁] 恢复 Pull Request 自动化 CI 触发、隔离并发分组并补回 Windows 安装脚本完整性测试**:
  - **技术机理 / 现象溯源**: 此前流水线精简时移除了 `pull_request` 触发，而 `ci.yml` 仅监听 `push` 事件，导致提交至 `main` 和 `beta` 的 PR 在合并前缺少自动化 CI 门禁；同时安装脚本完整性测试被缩减为仅在 Ubuntu 上运行，导致 Windows PowerShell 安装脚本与包装器缺少托管 Windows Runner 的自动化覆盖；原 concurrency key 亦未隔离事件类型，分支 push 存在误取消 PR 运行的隐患。
  - **实现防线 / 核心改动**: 在 `.github/workflows/ci.yml` 中为 `main` 与 `beta` 分支重新挂载 `pull_request` 触发器；将 concurrency 组重构为 `ci-${{ github.event_name }}-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.ref_name }}`，显式隔离 push 与 PR 事件避免相互抢占；将 `installer-integrity` 作业扩展为 `ubuntu-latest` 与 `windows-latest` 跨平台矩阵测试。
  - **验证与交付**: PR #7 对应各项质量门禁（Ubuntu/Windows 安装脚本完整性、Rust 代码质量、WebUI 构建与版本一致性）均验证通过。


## v7.1.53-beta.10 (2026-10-06)

- **[Release Pipeline / Desktop Bundle] Keep the Linux x64 desktop bundle on ubuntu-22.04 and treat the runner image as a compatibility contract**:
  - **Technical Root Cause / Detail**: The desktop matrix built the x64 deb/appimage/rpm bundles on `ubuntu-22.04`. A migration to `ubuntu-24.04` was attempted on the assumption that the job's `Install Linux WebKit` step could not resolve `libwebkit2gtk-4.1-dev` on 22.04. The assumption was wrong, and the move raised the glibc floor from 2.35 to 2.39, silently dropping Ubuntu 22.04, Debian 12 (glibc 2.36) and Debian 11 (glibc 2.31) from the deb. The runner image is therefore not a free upgrade: it decides which distributions can install the package.
  - **Implementation Mechanism**: `.github/workflows/build.yml` desktop matrix x64 entry restored to `ubuntu-22.04`, keeping the arm64 entry on `ubuntu-24.04-arm` by design. The CLI artifacts are unaffected because they are musl statically linked; only the desktop installers carry the glibc constraint. The migration is deferred until GitHub announces the 22.04 deprecation date, at which point the correct fix is a `ubuntu-24.04` runner hosting a `ubuntu:22.04` container rather than changing the image.
  - **Verification & Testing**: Confirmed against the beta.6 release run (37343831117) and its `Desktop ubuntu-22.04 deb,appimage,rpm` job (111888657395) that `Install Linux WebKit`, `Build desktop installers` and `Upload desktop installers` all conclude `success` on `ubuntu-22.04`, proving the 4.1 packages resolve correctly there. Workflow-only change; no Rust or WebUI sources touched.

---

- **[发布流水线与桌面安装包] Linux x64 桌面安装包维持在 ubuntu-22.04，并把 runner 镜像确立为兼容性契约**:
  - **技术机理 / 现象溯源**: desktop 矩阵此前在 `ubuntu-22.04` 上构建 x64 的 deb/appimage/rpm。因误判该镜像无法解析 `Install Linux WebKit` 步骤所需的 `libwebkit2gtk-4.1-dev`，一度迁移至 `ubuntu-24.04`；但该判断不成立，而迁移会把 glibc 下限从 2.35 抬升到 2.39，导致 Ubuntu 22.04、Debian 12（glibc 2.36）与 Debian 11（glibc 2.31）用户无法安装 deb。runner 镜像不是可随意升级的版本号，它直接决定安装包的发行版覆盖面。
  - **实现防线 / 核心改动**: 将 `.github/workflows/build.yml` desktop 矩阵的 x64 条目回退为 `ubuntu-22.04`，arm64 条目按设计继续使用 `ubuntu-24.04-arm`。CLI 二进制走 musl 静态链接不受影响，glibc 约束仅作用于桌面安装包。迁移推迟到 GitHub 正式公告 22.04 弃用日期之后，届时的正确解法是 runner 使用 `ubuntu-24.04`、构建放进 `ubuntu:22.04` 容器，而不是更换镜像。
  - **验证与交付**: 依据 beta.6 发布运行（37343831117）中 `Desktop ubuntu-22.04 deb,appimage,rpm`（job 111888657395）的实测结果确认：`Install Linux WebKit`、`Build desktop installers`、`Upload desktop installers` 三个步骤在 `ubuntu-22.04` 上均为 `success`，证明 4.1 系列包在该镜像上可正常解析。本次为纯 workflow 改动，未触及任何 Rust 或 WebUI 源码。

## v7.1.53-beta.9 (2026-10-06)

- **[Datalog & Disk Protection] Disable per-turn datalog by default, enforce hard disk quotas, and migrate legacy configurations**:
  - **Technical Root Cause / Detail**: Datalog dumps raw per-turn requests and responses into `~/.jeikcode/datalog/` for offline model training/debugging without size caps or retention policies, causing long-term sessions to accumulate up to 26+ GB of dump files and fill user system disks; default configs previously shipped with `enabled = true`.
  - **Implementation Mechanism**: Switched default initialization of `datalog.enabled` to `false` in `DatalogConfig` and all bundled templates (`default-config.toml`); introduced `max_total_mb` (512 MB) and `max_days` (7 days) bounds with automatic FIFO pruning in `crates/jeikcode-capabilities/src/datalog.rs`; updated `merge_user_config_preserving_models` in `crates/jeikcode-coding/src/config_sync.rs` so template sync diff checks actively detect and flip legacy enabled datalogs to `false`.
  - **Verification & Testing**: Passed `prune_datalog_directory_cleans_excess_files` and config roundtrip tests, formatted with `cargo fmt`, and passed full WebUI build gate.

---

- **[会话日志与磁盘保护] 默认彻底关闭 datalog 全量 dump，加设容量硬上限并自动迁移关闭历史遗留开启项**:
  - **技术机理 / 现象溯源**: 历史版本中 `[datalog]` 默认开启且缺乏文件容量限制与保留期机制，导致每一轮对话都将完整提示词、代码上下文与工具输出全量 dump 到 `~/.jeikcode/datalog`，长期使用后累积达到数十 GB 甚至撑爆 C 盘；且模板默认初始化均为 `enabled = true`。
  - **实现防线 / 核心改动**: 将 `DatalogConfig` 核心初始化与所有内置模板（`default-config.toml`）默认值彻底改为 `enabled = false`；增加 `max_total_mb`（512 MB）与 `max_days`（7 天）双重硬顶上限，并在写入前自动执行基于 mtime 的 FIFO 滚动淘汰清理（`prune_datalog_directory`）；在 `config_sync.rs` 配置更新合并逻辑中加入安全防线，在检测到配置更新时自动将老用户遗留开启的 `datalog.enabled` 修正覆盖为 `false`，彻底保护磁盘空间。
  - **验证与交付**: 增加目录超限自动修剪单测并验证通过，`cargo fmt` 格式化通过，前端 TypeScript 强类型校验与生产构建顺利通过。

## v7.1.53-beta.8 (2026-10-06)

- **[Daemon & Session Switch] Prevent duplicate approval toast prompts when switching sessions during tool execution**:
  - **Technical Root Cause / Detail**: In `pending_interactive_from_replay` and `replay_resolves_call` within the daemon, only `ToolCallResult` and `ToolOutputChunk` marked a tool call as resolved, omitting `ChatEvent::ToolCallStarted`. During long-running or silent tool executions (such as `run_command`), `GET /chat/pending` incorrectly classified the running tool as waiting for approval. In WebUI, `transcriptToolCallIsResolved` returned false for in-flight tools with `status === 'pending'`, causing `restorePendingInteractive` to falsely demote executing tools to `waiting_approval` upon session switching and repeatedly trigger OS approval toasts.
  - **Implementation Mechanism**: Added `ChatEvent::ToolCallStarted` to `resolved_call_ids` and `replay_resolves_call` in `crates/jeikcode-daemon/src/lib.rs` to recognize started tools as resolved; updated `transcriptToolCallIsResolved` in `webui/src/lib/chatTerminal.ts` so that tools not in `waiting_approval` (i.e. `pending`, `done`, `error`, `incomplete`) are treated as resolved, preventing resurrecting approval cards or firing desktop notifications when switching sessions.
  - **Verification & Testing**: Passed 36/36 unit tests in `chatTerminal.test.ts` including tests verifying `pending` in-flight tools are resolved, and verified clean TypeScript build.

---

- **[守护进程与会话切换] 彻底修复工具执行期间来回切换会话反复触发审批通知的缺陷**:
  - **技术机理 / 现象溯源**: 后端守护进程中的 `pending_interactive_from_replay` 与 `replay_resolves_call` 在判断某个 `call_id` 是否已解决时仅匹配了 `ToolCallResult` 和 `ToolOutputChunk`，漏掉了 `ChatEvent::ToolCallStarted`，导致耗时或无输出的正在运行中工具在 `GET /chat/pending` 中被误判为未审批；前端 `transcriptToolCallIsResolved` 对处于 `'pending'` 执行中的工具返回了 false，导致用户来回切换 session 时 `restorePendingInteractive` 将正在运行的工具误改回 `waiting_approval` 并反复调用 `dispatchSystemNotification` 触发系统 Toast 弹窗通知。
  - **实现防线 / 核心改动**: 在 `crates/jeikcode-daemon/src/lib.rs` 中为 `resolved_call_ids` 及 `replay_resolves_call` 增加对 `ChatEvent::ToolCallStarted` 的匹配，工具一旦启动即标记为已解决；重构 `webui/src/lib/chatTerminal.ts` 中的 `transcriptToolCallIsResolved`，只要工具状态不为 `waiting_approval`（即处于 `pending` 运行中或已完成）均判定为已处理，彻底杜绝切换会话时卡片复活与重复弹窗。
  - **验证与交付**: `chatTerminal.test.ts` 36 项单测全绿，涵盖运行中状态判定用例，前端全量构建通过。

## v7.1.53-beta.7 (2026-10-06)

- **[Approval & Multi-Client Sync] Real-time approval mode synchronization across mobile and desktop clients**:
  - **Technical Root Cause / Detail**: ApprovalMode changes triggered on mobile devices or secondary browser tabs were updated in daemon memory, but other active WebUI clients lacked live cross-client notification and only queried the mode upon initial mount.
  - **Implementation Mechanism**: Introduced the `broadcastApprovalMode` utility leveraging `BroadcastChannel('jeikcode_approval_mode')` and custom events in `api.ts`; added edge-triggered broadcast dispatch in `NotificationDock.tsx`; and subscribed `Chat.tsx` to broadcast channels, document visibility changes, and window focus events to seamlessly sync `ApprovalMode` without page reloads.
  - **Verification & Testing**: WebUI production build passed cleanly, and real-time mode transitions verified across active tabs and polling ticks.

- **[Mobile UX & Notification Dock] Fix approval capsule collapse persistence and header edge placement**:
  - **Technical Root Cause / Detail**: Once a mobile user expanded an approval card, `mobileExpanded` remained true even after the review completed, forcing subsequent approval tasks to display as expanded cards instead of compact capsules; additionally, the capsule top offset of `12px` overlapped top navigation actions and model triggers.
  - **Implementation Mechanism**: Tracked card lifecycle in `NotificationDock.tsx` to automatically restore collapsed capsule state when all cards resolve; ensured newly incoming approval requests default to collapsed capsules; added a dedicated "Collapse ▲" button in the deck header for single and multi-card states; and repositioned `.notify-dock` top anchor to `calc(48px + env(safe-area-inset-top, 0px) + 6px)` immediately flush beneath the top navigation boundary.
  - **Verification & Testing**: Verified responsive mobile breakpoint layout in CSS and automated test pass in `sessionNotify.test.ts`.

- **[Localization & Action Buttons] Pure language notifications and eliminate bilingual button mixing**:
  - **Technical Root Cause / Detail**: Toast action buttons previously displayed mixed bilingual text ("Approve / 同意", "Deny / 拒绝", "Answer / 作答") and hardcoded a Chinese "会话:" prefix regardless of the active language setting.
  - **Implementation Mechanism**: Refactored Windows Toast XML and Linux `notify-send` scripts in `crates/jeikcode-capabilities/src/notify.rs` to dynamically detect language context; enforced pure English ("Approve", "Deny", "Answer", "Session:") and pure Chinese ("同意", "拒绝", "作答", "会话:") with zero bilingual mixing; expanded `i18n.ts` with localized notification action keys.
  - **Verification & Testing**: Executed `cargo fmt` and updated unit tests in `notify.rs` verifying strict unilingual button content.

- **[Theme & Visual System] Refine dark canvas background to eye-friendly charcoal and preserve message bubble contrast**:
  - **Technical Root Cause / Detail**: The main chat stage previously defaulted to pure pitch-black (`#131314`), causing harsh visual contrast and eye fatigue, while message bubbles and todo panels required balanced separation from both the canvas and the sidebar.
  - **Implementation Mechanism**: Softened `--app-primary-background` and `--app-header-background` in `theme.css` to warm charcoal grey (`#1b1c1e`), visually aligning with the sidebar (`#1e1f20`); refined the user message bubble background to `#2c2e32` to maintain prominent, comfortable contrast against the canvas; and styled `.session-todo-panel` with a subtle translucent secondary fill.
  - **Verification & Testing**: Verified dark and light palette readability, border consistency, and successful TypeScript typecheck and build.

---

- **[审批系统与多端同步] 移动端与多标签页 WebUI 跨端实时同步审批模式 (ApprovalMode)**:
  - **技术机理 / 现象溯源**: 移动端手机或其他浏览器标签页切换 Build / Auto 等审批模式后，后端进程虽然更新了模式，但已打开的其他 WebUI 客户端仅在组件初次挂载时读取一次，导致客户端之间无法感知对端模式切换。
  - **实现防线 / 核心改动**: 在 `api.ts` 中封装 `broadcastApprovalMode`，利用 `BroadcastChannel('jeikcode_approval_mode')` 与自定义 DOM 事件广播最新模式；在 `NotificationDock.tsx` 2 秒周期轮询中检测模式跳变并触发跨端广播；在 `Chat.tsx` 中监听广播、窗口重新聚焦与可见性恢复事件，使各端无需手动刷新即可毫秒级无感同步审批模式。
  - **验证与交付**: WebUI 生产打包通过，多端模式广播与轮询边缘触发逻辑验证完备。

- **[移动端交互体验] 修复审批卡折叠状态保持失效并下移横条贴齐顶栏下沿**:
  - **技术机理 / 现象溯源**: 移动端审批卡在用户点击展开一次后，`mobileExpanded` 状态未在卡片审批完成或清空时重置，导致后续新的审批请求直接以全屏卡片形式弹出而无法恢复为消息小胶囊；且收纳小条原定位在 `top: 12px`，恰好重叠遮挡了顶栏菜单按钮与模型选择器。
  - **实现防线 / 核心改动**: 在 `NotificationDock.tsx` 中监听卡片总数与变更生命周期，当卡片清空或新审批到来时自动恢复折叠横条态；单张卡片或多张卡片展开时均在顶部提供常驻“收起 ▲”按钮；将 `.notify-dock` 移动端顶部定位调整为 `calc(48px + env(safe-area-inset-top, 0px) + 6px)`，紧贴状态栏与顶栏下沿首位展示，彻底消除按钮遮挡。
  - **验证与交付**: 移动端视口样式校验通过，`sessionNotify.test.ts` 8 项单测全绿。

- **[国际化与通知操作] 纯英文/纯中文系统通知与审批按钮，杜绝中英混杂**:
  - **技术机理 / 现象溯源**: Windows Toast 与桌面通知按钮此前采用 "Approve / 同意"、"Deny / 拒绝" 等中英混排，且会话行强行硬编码中文“会话:”，在英文语言模式下弹出体验割裂。
  - **实现防线 / 核心改动**: 重构 `crates/jeikcode-capabilities/src/notify.rs` 中的 Windows Toast XML 与桌面通知脚本生成逻辑，按标题语言上下文精准路由：英文语言下输出纯英文（`Approve` / `Deny` / `Answer` / `Session:`），中文语言下输出纯中文（`同意` / `拒绝` / `作答` / `会话:`），严禁中英交叉混排；在 `i18n.ts` 中补全通知操作的中英文字典。
  - **验证与交付**: 执行 `cargo fmt` 代码格式化，更新 `notify.rs` 单元测试并通过断言验证。

- **[主题视觉与护眼调色] 会话面板告别刺眼纯黑，对齐左侧炭灰质感并强化气泡层级**:
  - **技术机理 / 现象溯源**: 暗色模式主会话面板底色原为高对比深黑（`#131314`），长时间凝视容易产生视觉疲劳；同时用户消息气泡、任务面板与侧栏底色需兼顾整体一致性与层次区分度。
  - **实现防线 / 核心改动**: 将 `theme.css` 中 `--app-primary-background` 与顶栏底色调优为护眼炭灰黑（`#1b1c1e`），与左侧会话栏（`#1e1f20`）形成平滑柔和的同阶质感；将用户消息气泡背景调优为 `#2c2e32`，确保气泡轮廓层次鲜明不融底；将任务面板底色适配为半透明二次表面，亮色模式保持清晰规范。
  - **验证与交付**: 经 TypeScript 编译与 Vite 生产构建全流程验证，色彩对比度舒适护眼。

## v7.1.53-beta.6 (2026-10-06)

- **[TypeScript & Type Safety] Fix WebUI typecheck regressions across Chat, GitPanel, Markdown, and NotificationDock**:
  - **Technical Root Cause / Detail**: `tsc --noEmit` detected TS2367 narrow type comparison on queued message kind in `Chat.tsx`; `SettingsCtx` had no `settings` field in `GitPanel.tsx` and `Markdown.tsx`; `commitFiles` was referenced before block declaration in `GitPanel.tsx`; `TransformWrapper` render props lacked parameter type annotation in `MermaidDiagram.tsx`; and `NotificationDock.tsx` lacked the `ask.title` translation key.
  - **Implementation Mechanism**: Removed redundant narrowed `disabled` check in `Chat.tsx`; aligned `useSettings()` callers to use `theme` and `lang` directly; hoisted `commitFiles` state declaration above helper closures in `GitPanel.tsx`; typed `TransformWrapper` render props parameters; and added bilingual `ask.title` entries in `i18n.ts`.
  - **Verification & Testing**: WebUI typecheck passed with zero errors (`npm run typecheck`), 19/19 test suite passed, and clean production build verified.

- **[WebUI & Git Graph] Align commit hover details with VSCode, support full %B message, diff stats, and fix hover card obstruction**:
  - **Technical Root Cause / Detail**: Previously, the git log graph API truncated commit messages to single-line subjects (`%s`), omitting multi-line bodies, descriptions, and co-authorship trailers; hover cards lacked file insertion/deletion stats; and hover cards could be occluded by lower-left floating docks due to insufficient z-index and viewport overflow.
  - **Implementation Mechanism**: Upgraded daemon git log formatter to `%B` with control-character field separators and `--shortstat` parsing; enhanced `GitCommitItem` and `GitCommitDetailResp` with `total_files`, `total_additions`, and `total_deletions`; overhauled the Git hover details card with author metadata, formatted timestamps, multi-line pre-wrap bodies, diff stats pills, and remote GitHub/GitLab links; elevated hover card z-index to 9999 with dynamic viewport height clamping.
  - **Verification & Testing**: Passed 6/6 unit tests in `gitGraph.test.ts` and verified responsive positioning.

- **[WebUI & Navigation Layout] Header tab overflow auto-collapse, deduplicate Chat tab, mobile viewport-safe drawer, and composer layout refinement**:
  - **Technical Root Cause / Detail**: Opening diffs created a redundant "Chat" tab when clicking the session title already returns to chat; desktop tabs collapsed prematurely leaving wide gaps before the right toolbar; mobile tabs overflowed screen bounds; and the lower-left `current:` elapsed timer compressed mobile composers, pushing the send button offscreen.
  - **Implementation Mechanism**: Removed redundant "Chat" tab and title dropdown menus—clicking the session title now switches straight to chat; eliminated `header-spacer` so tabs span fully until approaching the right toolbar buttons, revealing a chevron overflow menu for remaining tabs; redesigned mobile session/diff switcher into a viewport-constrained floating drawer (`left: 8px; right: 8px`) immune to screen truncation; removed redundant composer floating elapsed timer and polished context token pill typography.
  - **Verification & Testing**: Verified desktop resizing boundaries and mobile viewport constraints with zero overflow.

- **[WebUI & Chart Media] Modern interactive Mermaid diagram integration with pan/zoom gestures, subtle grid, and full-screen modal**:
  - **Technical Root Cause / Detail**: Model-generated ````mermaid` blocks previously rendered as plain text code boxes without visual rendering or diagram navigation capabilities.
  - **Implementation Mechanism**: Integrated official `mermaid`, `react-zoom-pan-pinch`, and `lucide-react` libraries; intercepted `mermaid` code fences in `markdownRender.ts` into dedicated mount points; developed `MermaidDiagram.tsx` featuring subtle grid canvas, floating frosted action pill, mouse wheel/pinch-to-zoom navigation, dark/light theme alignment, code/diagram toggle, SVG download, and fullscreen modal mode with graceful streaming syntax fallback.
  - **Verification & Testing**: Passed 13/13 markdown render tests in `markdownRender.test.ts` and completed clean Vite production bundle code splitting.

---

- **[TypeScript 与类型安全] 修复 WebUI 全流程类型校验错误（Chat、GitPanel、Markdown 与 NotificationDock）**：
  - **技术机理 / 现象溯源**: 流水线执行 `tsc --noEmit` 报出 5 项类型错误：`Chat.tsx` 在类型窄化块内冗余比较 `q.kind` 触发 TS2367；`GitPanel.tsx` 与 `Markdown.tsx` 解构不存在的 `settings` 属性；`GitPanel.tsx` 在 `commitFiles` 声明前闭包访问触发 TS2448；`MermaidDiagram.tsx` 的 `TransformWrapper` 解构形参缺乏类型注解；`NotificationDock.tsx` 缺少 `ask.title` 国际化键。
  - **实现防线 / 核心改动**: 精简 `Chat.tsx` 按钮禁用属性；对齐 `useSettings()` 标准协议，统一使用 `theme` 与 `lang`；提前提升 `commitFiles` 状态定义；补充解构形参类型约束；在 `i18n.ts` 中补齐 `ask.title` 中英文案。
  - **验证与交付**: `npm run typecheck` 零错误通过，全量生产打包与单测全绿。

- **[WebUI 与 Git 图谱] 对齐 VSCode 风格详细提交信息、支持完整 %B 消息与增删统计、修复悬浮卡片遮挡**：
  - **技术机理 / 现象溯源**: 历史 Git 图谱接口仅截取单行标题（`%s`），导致多行正文与共同署名信息完全丢失；悬浮卡片缺失文件增删行数统计；且在较低高度下容易被左下角待办托盘等高层级浮窗遮挡。
  - **实现防线 / 核心改动**: 后端 `api_git.rs` 升级为安全控制字符定界与 `%B` 完整提交消息解析，并引入 `--shortstat` 解析器自动提取文件数与增删行；重构前端 VSCode 风格 Commit 悬浮卡片（展示作者与时间、突出标题、支持滚动的多行正文、红绿增删统计行、分支胶囊与外链）；将卡片层级提升至 `9999` 并添加自适应高度与视口边界保护。
  - **验证与交付**: `gitGraph.test.ts` 6 项单测全绿，生产界面悬浮与点击展开验证通过。

- **[WebUI 导航与布局优化] 顶栏 Diff 标签触界自适应收纳、去除冗余 Chat 标签、手机端视口防截断与输入框空间释放**：
  - **技术机理 / 现象溯源**: 打开 Diff 后顶栏额外生成冗余的 Chat 标签；电脑端标签栏过早压缩导致右侧大片空白未被利用；手机端标签栏容易超出屏幕边缘；输入框左下角 `current:` 实时计时器挤占横向空间导致发送按钮被顶出界。
  - **实现防线 / 核心改动**: 去除冗余 Chat 标签与会话标题多余菜单，会话标题直接作为返回聊天的主入口；移除抢占空间的 `header-spacer`，标签栏完全撑满到最右侧按钮组边界，触界才收缩并在最右侧提供向下箭头展开菜单；移动端重构为绝对视口安全边距布局（`left: 8px; right: 8px`），绝不偏左偏右被截断；移除输入框底部冗余计时器，微调优化上下文窗口字数排版。
  - **验证与交付**: 经过桌面端横拉缩放边界与移动端视口防溢出测试。

- **[WebUI 图媒体系统] 引入主流 Mermaid 交互式矢量图展示、支持手势平移缩放、微质感网格与全屏模态**：
  - **技术机理 / 现象溯源**: 大模型输出的 ````mermaid` 流程图与架构图此前降级为普通纯文本代码框，缺乏交互式矢量图表展现能力。
  - **实现防线 / 核心改动**: 引入官方 `mermaid` 核心、`react-zoom-pan-pinch` 与 `lucide-react` 现代图标；在 Markdown 管道中精准拦截并水合挂载；打造兼具桌面滚轮/拖拽漫游与移动端双指捏合（Pinch-to-zoom）的图表系统，配备微质感点阵背景、毛玻璃悬浮胶囊栏、一键全屏模态框、代码/图表切换、SVG 下载及大模型流式未闭合语法防白屏优雅容灾。
  - **验证与交付**: `markdownRender.test.ts` 13 项单元测试全部通过，全量生产打包按需代码分割顺畅。

## v7.1.53-beta.4 (2026-10-05)

- **[Release & CI Security] Harden reproducible builds, locked dependencies, and installer integrity**:
  - **Technical Root Cause / Detail**: Builds and public installations previously lacked fail-closed integrity gates: `build.rs` performed non-hermetic asset mutations from developer homes; cargo/npm builds were unpinned; release publishing checked out moving branches; and public installers lacked SHA256 and byte-size verification before replacing binaries.
  - **Implementation Mechanism**: Pinned Node 22.22.0 and Rust 1.93.0 with `--locked` across all build paths; removed build-time host mutations from `build.rs`; enforced scoped GHA permissions and exact-SHA checkout in release workflows; added strict SHA256 and size verification in `install.sh` and `install.ps1`; unified legacy alias wrappers; and instituted automated version consistency checks across all 11 shipping manifests.
  - **Verification & Testing**: Passed 12 cross-platform installer integrity fixture tests in `scripts/test_installers.py`, version consistency checks, and WebUI/Rust quality gates.

- **[WebUI & Responsive Layout] Adaptive top navigation, mobile composer refinement, and multi-version update resolution**:
  - **Technical Root Cause / Detail**: On mobile and narrow desktop viewports, header action buttons overflowed and misaligned; mobile keyboards sent messages on Enter prematurely; and update checks could be trapped by stale caches or stop at intermediate releases.
  - **Implementation Mechanism**: Implemented 3-tier adaptive header collapse (collapsing low-frequency actions into overflow menus on narrow screens); optimized mobile composer with soft-keyboard Enter newlines; implemented backend `find_highest_release` SemVer resolution for direct single-step updates to the latest release; and enhanced the update dialog with on-open cache bypass and background polling.
  - **Verification & Testing**: WebUI typecheck passed with zero errors (`tsc --noEmit`), 293/293 test suite passed, and production builds verified.

- **[TypeScript & Type Safety] Repair notification dock, provider groupings, and i18n typing**:
  - **Technical Root Cause / Detail**: `NotificationDock.tsx` mismatched string vs number request IDs in local dismissal; `SettingsDialogs.tsx` inferred `unknown[]` on provider/account mapping; and `Sidebar.tsx` lacked the `sidebar.dragToResize` translation key.
  - **Implementation Mechanism**: Normalized `callOrReqId` handling in `NotificationDock`; strongly typed `AccountInfo[]` and `ProviderInfo[]` in `SettingsDialogs`; added bilingual `sidebar.dragToResize` keys to `i18n.ts`; and integrated automatic `package-lock.json` version bumping in `bump-version.js`.
  - **Verification & Testing**: Verified via `npm run typecheck` and `node scripts/check-version-consistency.js`.

---

- **[发布与构建安全] 全面加固可复现构建、锁定依赖门禁与安装器防篡改完整性**：
  - **技术机理 / 现象溯源**: 历史构建与分发缺乏强完整性校验：`build.rs` 曾在编译期隐式抓取宿主机文件覆盖源码造成构建脏污；依赖未锁定导致不同环境产物漂移；发布流程依赖浮动分支；公共安装脚本下载未校验哈希与大小。
  - **实现防线 / 核心改动**: 锁定 Node 22.22.0 与 Rust 1.93.0 工具链，全流程启用 `npm ci` 与 `cargo --locked`；移除 `build.rs` 宿主机隐式副作用；发布流水线最小化权限并锚定触发 Tag 的精确 SHA；`install.sh` 与 `install.ps1` 增加强校验 SHA256 与字节大小，不匹配立即熔断，杜绝篡改与损坏；新增全仓 11 处清单版本一致性自动化门禁。
  - **验证与交付**: `scripts/test_installers.py` 12 项跨平台防篡改测试全绿通过，版本一致性门禁验证通过。

- **[WebUI 体验与响应式架构] 顶栏三级自适应收纳排布、移动端输入体验优化与跨版本一步直升**：
  - **技术机理 / 现象溯源**: 窄屏与手机端顶栏操作按钮容易挤占换行；移动端软键盘回车易误触发送；版本更新检查易受旧缓存干扰且无法一步直升最新版。
  - **实现防线 / 核心改动**: 构建顶栏三级自适应收纳机制（窄屏自动折叠次要操作至三点菜单，手机端保持极简单行）；优化移动端与触控设备输入条，软键盘回车保持物理换行；后端升级 `find_highest_release` 寻优算法，支持跨多版本一次直升最高发布版；前端更新弹窗支持无缓存即时探测与前台静默轮询。
  - **验证与交付**: WebUI 生产构建与 293 项前端单测全部通过。

- **[前端类型安全与细节修复] 修复通知托盘 ID 判定、账号分组类型推导与国际化缺失**：
  - **技术机理 / 现象溯源**: `NotificationDock.tsx` 中请求 ID 存在字符串与数字类型不匹配警告；`SettingsDialogs.tsx` 在处理账号映射时被推导为 `unknown[]`；侧栏拉伸把手缺少 `sidebar.dragToResize` 国际化文案。
  - **实现防线 / 核心改动**: 在 `NotificationDock` 中统一字符串化比对；在 `SettingsDialogs` 中显式约束 `AccountInfo[]` 与 `ProviderInfo[]`；在 `i18n.ts` 中补充中英双语文案；在 `bump-version.js` 中联动更新 `package-lock.json` 版本号。
  - **验证与交付**: `npm run typecheck`（`tsc --noEmit`）零错误通过。

## v7.1.53-beta.3 (2026-10-05)

- **[Security & Trust Boundaries] Harden daemon network exposure, git discard operations, and session boundaries**:
  - **Technical Root Cause / Detail**: A security audit identified four critical trust boundary weaknesses: daemon bound to non-loopback addresses without enforced authentication; `/git/discard` vulnerable to directory traversal and pathspec expansion; sensitive path gates bypassing checks through benign symlinks; and process-global bash state leaking across concurrent sessions.
  - **Implementation Mechanism**: Enforced mandatory access token for non-loopback daemon binds via `--token` or `JEIKCODE_SERVER_TOKEN` (failing closed on unauthenticated attempts); restricted `/git/discard` to validated repo-relative paths with `GIT_LITERAL_PATHSPECS=1` and untracked status verification; resolved filesystem symlink targets in `SensitivePathGate` and `WriteApprovalGate`; moved bash background registry, alerts, and keywords to per-`CodingRuntime` ownership.
  - **Verification & Testing**: Targeted security regression tests across daemon, git discard, symlink read/write gates, and session lifecycle passed.

- **[WebUI Markdown Rendering] Resolve nested code block fragmentation and double-fence glitch**:
  - **Technical Root Cause / Detail**: In `webui/src/lib/markdownPrep.ts`, `fenceClose` mistakenly treated opening sub-fences with language suffixes as closing tags. Furthermore, nested 3-backtick markdown blocks inside 3-backtick outer blocks caused premature termination and inverted code block selection.
  - **Implementation Mechanism**: Fixed `fenceClose` to require strictly pure backtick lines. Introduced `promoteNestedCodeFences` to dynamically elevate outer container fences to 4+ backticks, and tracked nesting depth in `findMatchingFenceClose` for markdown containers.
  - **Verification & Testing**: Added targeted regression test `nested markdown code blocks do not break outer block or trigger double fences`, 294 webui tests passed.

- **[CodeGraph & Index Guidance] Autonomous single-repo index creation and multi-repo noise prevention**:
  - **Technical Root Cause / Detail**: When navigating unindexed workspaces, models either hallucinated symbols or hesitated to initialize code intelligence. Additionally, indexing across root multi-repo directories caused severe noise and performance degradation.
  - **Implementation Mechanism**: Upgraded unindexed guidance in `codeintel/mod.rs` with clear scenario routing: directly instruct agents to execute `jeikcode init --force` on dedicated single repos and re-query tools; warn against global root indexing for multi-repo workspaces while recommending per-subproject indexing.
  - **Verification & Testing**: Verified `no_codegraph_guidance_routing_instructions` unit test; updated quickstart documentation.

- **[Git Panel Experience] Add VSCode-style interactive commit hover details card**:
  - **Technical Root Cause / Detail**: Commit rows only displayed basic truncated messages via browser native tooltips, lacking author emails, commit dates, parents, and full commit bodies.
  - **Implementation Mechanism**: Implemented floating `.git-commit-hover-card` displaying commit hash, quick copy button, ref pills, author info, exact formatted timestamp, parent hashes, and pre-wrapped multiline commit bodies, complete with 240ms hover debounce and viewport edge clamping.
  - **Verification & Testing**: Verified in WebUI build and component rendering.

- **[Skill System Universal Compatibility] Standardize on cross-agent `.agents/skills` and `.skills` conventions**:
  - **Technical Root Cause / Detail**: Diverse external agent frameworks (OpenCode, Grok, etc.) store reusable skills under shared directories, while legacy discovery only checked a subset.
  - **Implementation Mechanism**: Standardized `standard_skill_dirs` across user and workspace levels to support `.agents/skills`, `.agents/commands`, `.skills`, and `skills`, while ensuring `.jeikcode` native skills retain highest priority on collisions.
  - **Verification & Testing**: Passed `standard_dirs_include_agents_skills_between_claude_and_jeikcode` unit test and updated teaches documentation.

---

- **[安全与运行时信任防线] 全面加固守护进程网络暴露、Git 放弃修改与跨会话状态隔离**：
  - **技术机理 / 现象溯源**: 安全审计识别出 4 个核心信任边界隐患：非回环地址绑定时无鉴权暴露；`/git/discard` 易受目录穿越与 Git 通配符扩展误删文件；软链接绕过敏感路径审批；全局静态 Bash 任务在多会话并发下串扰。
  - **实现防线 / 核心改动**: 非回环地址启动 daemon 强制要求 `--token` 或 `JEIKCODE_SERVER_TOKEN`，未配置直接拒绝启动；`/git/discard` 限制为仓库相对白名单路径，开启 `GIT_LITERAL_PATHSPECS=1` 与双重 Git 校验；审批网关对齐文件系统物理实体解析符号链接；Bash 任务注册表下放到各自 `CodingRuntime`。
  - **验证与交付**: 覆盖 Daemon、Git discard、软链接审批及会话隔离的系列单测通过。

- **[WebUI Markdown 渲染防线] 彻底根除嵌套代码块断裂与二次反相框选缺陷**：
  - **技术机理 / 现象溯源**: 预处理器 `fenceClose` 误将带有语言标识的子围栏开启当成闭合，且内外层同为 3 个反引号时违反 CommonMark 规则导致外层代码块腰斩，使后续正文暴露并被尾部闭合标记反向框选。
  - **实现防线 / 核心改动**: 严格限定闭合标记仅允许纯反引号；新增 `promoteNestedCodeFences` 自适应将包含子代码块的外层围栏提升为 4+ 反引号；`findMatchingFenceClose` 引入栈深度跟踪。
  - **验证与交付**: 新增嵌套代码块回归单测，WebUI 全套 294 项单元测试 100% 通过。

- **[代码图谱与路由引导] 单仓库支持 Agent 自主构建索引，多仓库精准防噪音分流**：
  - **技术机理 / 现象溯源**: 项目未建索引时模型缺乏明确行动指引；多仓库全局建索引会产生严重符号混淆与检索噪音。
  - **实现防线 / 核心改动**: 升级 `no_codegraph_tool_guidance` 智能路由：单一项目直接引导 Agent 执行 `jeikcode init --force` 并在完成后重新检索；多项目综合目录强烈警告禁止在根目录建全局索引，指导进入各子目录分别执行。
  - **验证与交付**: 通过 `no_codegraph_guidance_routing_instructions` 单测，文档起步指南同步更新。

- **[Git 面板交互升级] 新增 VSCode 风格提交悬停卡片与多行提交详情展示**：
  - **技术机理 / 现象溯源**: 原生 `title` 提示简陋且无法展示长信息，用户无法便捷查阅提交哈希、作者邮箱、父提交与多行提交正文。
  - **实现防线 / 核心改动**: 实现 `.git-commit-hover-card` 浮层卡片，展示短哈希、一键复制、分支/标签徽标、作者邮箱、格式化绝对与相对时间、父哈希以及多行提交详情，附带 240ms 防抖与视口边缘安全避让。
  - **验证与交付**: 完成前端生产打包与交互验证。

- **[技能系统生态兼容] 规范对齐 `.agents/skills` 与 `.skills` 跨 Agent 共享目录**：
  - **技术机理 / 现象溯源**: 开源生态存在多种通用技能存储约定，需要无缝复用其他 coding agent 的已有技能资产。
  - **实现防线 / 核心改动**: 在 `standard_skill_dirs` 中规范扩展用户层与项目层 `.agents/skills`、`.agents/commands` 及 `.skills`，严格保持 JeikCode 本地技能最高优先级覆盖。
  - **验证与交付**: 运行技能发现目录单元测试通过，同步更新宿主机与源码 teaches 知识库。

## v7.1.53-beta.2 (2026-10-05)

- **[OS Notification Defense] Prevent terminal notifications from mistakenly adding Approve/Deny action buttons**:
  - **Technical Root Cause / Detail**: In `crates/jeikcode-capabilities/src/notify.rs`, any notification whose body contained review keywords (e.g. session titled "JeikCode PR 5 审核") was misclassified as an approval prompt, inappropriately attaching Approve/Deny buttons to finished turn toasts. Clicking them had no effect because the turn was already done.
  - **Implementation Mechanism**: Updated `windows_toast_xml` to inspect the title rather than body for review keywords, and strictly exclude terminal notifications (`done`, `finished`, `completed`, `stopped`, `failed`) from attaching action buttons.
  - **Verification & Testing**: Automated unit test `test windows_toast_approval_includes_action_buttons` passed.

- **[Git Panel & Turn Nav Experience] Default to Git view, prominent inspector rail buttons, and mobile bottom sheet**:
  - **Technical Root Cause / Detail**: The Git inspector was hidden by default and represented by a tiny icon that users overlooked, with no convenient mobile access.
  - **Implementation Mechanism**: Switched default inspector tab to `'git'` to highlight Git branch & commit graph. Replaced tiny icon rail buttons with prominent buttons displaying icons and labels (`Git`, `提问大纲`) with badges. On mobile devices, the inspector smoothly slides up as a bottom sheet.
  - **Verification & Testing**: WebUI unit tests passing (293 tests).

- **[Sidebar Project Management] Add "Reveal in File Explorer" and "Remove from Sidebar" actions**:
  - **Technical Root Cause / Detail**: Unwanted project folders accumulated in the left sidebar with no way to hide them without deleting files, and opening the folder on disk required manual navigation.
  - **Implementation Mechanism**: Added an explorer icon (calling `/fs/reveal` to open Windows Explorer / macOS Finder) and a trash icon (hiding the project from the sidebar with `localStorage` persistence while safely preserving all sessions and physical files).
  - **Verification & Testing**: Tested backend `/fs/reveal` handler and UI state persistence.

---

- **[系统通知防线] 彻底根除已完成通知误带 Approve/Deny 按钮与点击无响应缺陷**：
  - **技术机理 / 现象溯源**: 守护进程通知模块原先依据消息正文（`body`）模糊匹配审核关键字。当会话标题包含“审核”字样时，回合结束（`JeikCode done`）的完成通知会被错误判定为待审批通知，从而附加了无效的 Approve / Deny 动作按钮。
  - **实现防线 / 核心改动**: 重构 `crates/jeikcode-capabilities/src/notify.rs` 中的判断逻辑，严禁使用 `body` 判定审批，严格依据通知标题且无条件排除已完成/停止终态通知。
  - **验证与交付**: 运行 `windows_toast_approval_includes_action_buttons` 单元测试通过。

- **[Git 提交图谱与大纲优化] 默认首选 Git 面板，收起导轨按钮加大加显，移动端底抽屉自适应**：
  - **技术机理 / 现象溯源**: 用户不易发现 Git 提交历史图谱功能，且收起导轨上的微小图标不易察觉与点击。
  - **实现防线 / 核心改动**: 将检查面板默认标签页设为 `'git'`；收起导轨按钮加大加显，附带文字标签与数字徽标；移动端展开时自动升维为原生级平滑底部抽屉。
  - **验证与交付**: 前端 293 项测试全部通过。

- **[侧边栏项目管理] 新增资源管理器打开与隐藏项目显示功能**：
  - **技术机理 / 现象溯源**: 左侧边栏项目容易堆积且无法便捷打开本地实际物理文件夹。
  - **实现防线 / 核心改动**: 项目文件夹行增加 📂 按钮（一键调起 Windows 资源管理器/macOS 访达）与 🗑️ 垃圾桶按钮（纯前端隐藏项目展示，安全保留全部历史记录与物理文件）。
  - **验证与交付**: 验证后端 `/fs/reveal` 接口与前端项目过滤状态持久化。

## v7.1.53 (2026-10-05)

- **[Approval & Notification Hardening] Instant card dismissal on first click, session alias delivery, and OS duplicate toast suppression**:
  - **Technical Root Cause / Detail**: Approval cards in the notification dock lingered after clicks because polled prompts were not discarded immediately upon decision, causing users to click repeatedly. In desktop environments, alias mismatches between webview and daemon sometimes prevented decisions from reaching the active session. Furthermore, dual notifications were fired because both the chat stream and the background dock dispatched system toasts independently.
  - **Implementation Mechanism**: Added immediate local dismissal (`dismissedKeys`) and polled prompt removal in `NotificationDock.tsx` so cards vanish on the very first click. Enhanced daemon permission routing to resolve session aliases and fallback to any pending decider. Deduplicated system toasts by session and tag in `allow_system_notify`.
  - **Verification & Testing**: WebUI `npm test` passing (293 tests) and daemon unit tests passing.

- **[Minimalist Codex Streaming Status] Replace bubbly pill with borderless shimmer text and auto-hide during generation**:
  - **Technical Root Cause / Detail**: The status pill badge was visually intrusive, occupied extra vertical lines, and remained visible even while real tool calls or text were already streaming.
  - **Implementation Mechanism**: Removed pill background and borders. Implemented `.codex-shimmer-status` with subtle gradient shimmer text that displays strictly during initial IO wait and seamlessly vanishes once tokens, reasoning, or tools start streaming.
  - **Verification & Testing**: Verified responsive rendering and test coverage.

- **[Beta Release Channel] Prioritize latest pre-releases in Beta channel to properly display preview version numbers**:
  - **Technical Root Cause / Detail**: When fetching releases for the Beta channel, `compare_versions` favored formal releases over pre-releases with matching core versions per SemVer rules, causing the updater to display stable versions instead of active beta releases.
  - **Implementation Mechanism**: Updated `check_update` in `api_update.rs` so the Beta channel explicitly selects the latest release with `prerelease: true` before falling back to formal releases.
  - **Verification & Testing**: Daemon unit tests `test_compare_versions` passing.

- **[Image Lightbox Modal] Add prominent touch-friendly close button (✕) for image previews**:
  - **Technical Root Cause / Detail**: Clicking an image expanded it into full-screen without an explicit exit affordance, trapping mobile users on screen when touching the scaled image.
  - **Implementation Mechanism**: Added a floating `.img-lightbox-close` button positioned at top-safe-area right with high z-index and backdrop blur, allowing one-tap dismiss on mobile devices.
  - **Verification & Testing**: Tested component dismiss flow and responsive positioning.

- **[Collapsible Sticky Todo Panel] Mobile-first collapsible Todo list capsule**:
  - **Technical Root Cause / Detail**: Multi-item sticky Todo lists occupied excessive vertical space above the composer on compact mobile displays, pushing the input box and chat stream out of view.
  - **Implementation Mechanism**: Re-engineered `SessionTodoPanel` with an accordion toggle. On mobile views (≤768px), it collapses into a sleek single-line capsule showing status metrics and the active in-progress task snippet, expanding smoothly on tap.
  - **Verification & Testing**: WebUI `npm test` passing (293 tests).

- **[Mobile UI Layout & Defenses] Safe-area insets and compact Token badge prevent control clipping**:
  - **Technical Root Cause / Detail**: Phone status bars (dynamic island/cutouts) overlapped the top navigation bar, while lengthy Token meter chips pushed the Mode selector and Send button off-screen.
  - **Implementation Mechanism**: Anchored top/bottom chrome to `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)`. Streamlined `.footer-tokens` on mobile to show vital cache hit rates and total metrics without overflowing action controls.
  - **Verification & Testing**: Tested mobile viewports (360px - 768px).

---

- **[审批与通知防线] 审批卡片一键即刻消失、桌面端会话别名精准响应与系统双重弹窗消除**：
  - **技术机理 / 现象溯源**: 审批卡片此前未在前端本地状态中即时过滤轮询数据，导致用户点击同意/拒绝后卡片仍残留数秒并被迫重复点击；桌面端 WebView 与后端守护进程间因会话别名映射差异可能导致决策未能送达；且前端与后台双重触发系统通知导致 Windows 弹窗成对出现。
  - **实现防线 / 核心改动**: 在 `NotificationDock.tsx` 中建立即时消除机制与 `dismissedKeys` 过滤，首击即刻隐藏卡片；在后端增强会话别名解析与唯一决策兜底路由；在守护进程端基于会话与 Tag 实施严格通知去重。
  - **验证与交付**: 前端 293 项单测与后端单元测试全部通过。

- **[Codex 极简流光状态] 去除突兀气泡，生成期间自动隐去让出整行空间**：
  - **技术机理 / 现象溯源**: 原状态胶囊带有边框与背景底色较为突兀，且在工具执行与正文流式输出期间一直占位。
  - **实现防线 / 核心改动**: 彻底去除背景气泡与边框，采用 Codex 风格纯文字流光（`.codex-shimmer-status`）；在工具调用、思考或文字输出期间自动隐藏，仅在初始等待首包 IO 阶段低调提示。
  - **验证与交付**: 验证流式状态流转与样式渲染。

- **[预览版更新检测] Beta 预览通道优先匹配最新预发布版，正确展示预览版版本号**：
  - **技术机理 / 现象溯源**: 原更新检测逻辑因 SemVer 规范将同版本的正式版权重置于预发布版之上，导致用户切换到 Beta 预览通道时版本号被正式版覆盖。
  - **实现防线 / 核心改动**: 优化 `crates/jeikcode-daemon/src/api_update.rs`，在 Beta 通道下优先抓取标记为 `prerelease: true` 的最新版本，确保预览版版本号精准呈现。
  - **验证与交付**: 编译并运行后端 `test_compare_versions` 单元测试通过。

- **[多媒体图片灯箱] 全屏大图预览新增触控友好关闭按钮 (✕ 按钮)**：
  - **技术机理 / 现象溯源**: 点击图片放大预览时缺乏显式关闭按钮，手机端全屏展开后点击图片阻断事件冒泡，导致移动端用户无法退出。
  - **实现防线 / 核心改动**: 在 `ImageLightbox` 顶部安全区增加磨砂半透明圆形关闭按钮（`.img-lightbox-close`），支持手机端一键触控关闭。
  - **验证与交付**: 验证灯箱交互与移动端样式适配。

- **[移动端待办收纳] 待办面板可折叠胶囊化，释放手机宝贵垂直视口**：
  - **技术机理 / 现象溯源**: 手机屏幕空间有限，多项 Todo List 展开时占据半屏高度，将聊天内容和输入框严重遮挡。
  - **实现防线 / 核心改动**: `SessionTodoPanel` 升级支持手风琴式折叠收纳。移动端默认收纳为高度约 30px 的紧凑胶囊，直观展示已完成数与当前进行中任务内容，点击任意处平滑展开或收起。
  - **验证与交付**: 全量 293 项前端测试通过。

- **[移动端防遮挡防线] 顶部避让挖孔/灵动岛，Token 统计紧凑化，保障发送与模式按钮完全可用**：
  - **技术机理 / 现象溯源**: 顶部固定导航在带挖孔屏手机上与状态栏重叠；输入框底部长串 Token 指示器挤爆宽度，导致模式选择器与发送按钮被挤出屏幕。
  - **实现防线 / 核心改动**: 顶部及底部工具栏全面接入 `env(safe-area-inset-top)` 与 `env(safe-area-inset-bottom)`；移动端精简收纳 Token 缓存条，确保模式切换与发送按钮稳定显式。
  - **验证与交付**: 多断点响应式测试验证无误。

## v7.1.52 (2026-10-05)

- **[Universal Responsive & Mobile UX] Gemini-aligned responsive mobile architecture, bottom-sheet modals, bottom-docked composer, and native media/file upload button**:
  - **Technical Root Cause / Detail**: Mobile views previously suffered from rigid desktop-squished layouts: modals were cut off on phones, model configuration stats and paths overflowed horizontally, the top app bar clashed with the hamburger menu, and the landing page composer was awkwardly floating in the center. Furthermore, mobile users could not conveniently upload files/images without relying on desktop copy-paste.
  - **Implementation Mechanism**: Built a universal responsive design system across mobile (≤768px), tablet/iPad (769-1024px), and desktop (>1024px). Modals automatically elevate to native-style bottom sheets with top pull handles and safe-area insets. Overhauled model configuration into a fluid flex/grid layout preventing text truncation and clipping. Re-anchored mobile composer cleanly to the bottom (Gemini style) and added a dedicated native media/file upload button (`input[type="file"]`) to seamlessly attach images or files.
  - **Verification & Testing**: WebUI `npm test` passing (291 tests) and production build verified.

- **[Update Channels & Modal] Add Stable and Beta release channels with interactive modal and pre-release support**:
  - **Technical Root Cause / Detail**: Previously, the top update button checked only stable releases and prompted raw browser alerts on manual checks. There was no user-selectable release channel or visual feedback for preview/beta builds.
  - **Implementation Mechanism**: Added `UpdateDialog` modal with dual-channel toggle (Stable / Beta) aligned with Antigravity-Manager, persistent channel preference (`localStorage`), real-time channel switching, and progress indicators. Enhanced daemon backend `/api/update/check` and `/api/update/execute` with SemVer pre-release version comparison and GitHub API pre-release discovery.
  - **Verification & Testing**: Daemon unit tests `test_compare_versions` covering SemVer pre-release ordering; WebUI unit tests in `api.test.ts`.

- **[WebUI Session Switch & Queued Steers] Fix disappearing queued cards, preserve steer cards, and prevent message loss on session switch**:
  - **Technical Root Cause / Detail**: During an active turn, switching away and returning caused `(cacheInFlight && diskSettled)` to misidentify a prior turn's completed disk state as settled for the current turn, overwriting `currentCached` and dropping the current user message while appending new streaming deltas directly onto the previous turn. Furthermore, queued and steered cards disappeared on page refresh due to lack of persistence, and live snapshots prematurely wiped steered follow-up cards.
  - **Implementation Mechanism**: Refactored `diskSettled` check in `Chat.tsx` so an active turn requires the disk transcript to actually include the current user turn and not lag behind before replacing `currentCached`. Added `sessionStorage` persistence (`STORAGE_KEY_QUEUED_MESSAGES`) for queued and steered messages across refreshes. Bound `targetSid` in `handleSteerQueuedMessage` so asynchronous submission survives immediate session switching, and prevented `liveSnapshotQueueDisposition` from discarding steered items.
  - **Verification & Testing**: WebUI `npm test` covering `queuedDraft.test.ts` storage round-trip and `api.test.ts` (291 tests passing).

---

- **[全端响应式基建与移动端设计] 对标主流 Agent (Gemini) 重构全端响应式系统、底抽屉弹窗、底吸附输入框与原生媒体文件上传**:
  - **技术机理 / 现象溯源**: 移动端先前采用桌面端硬性压缩，导致模型配置卡片横向溢出截断、长路径被砍掉，手机端顶部导航与汉堡菜单错位重叠，落地页输入框浮在半空；同时手机端无法便捷复制粘贴上传文件，亟需原生文件选择器。
  - **实现防线 / 核心改动**: 建立手机 (≤768px)、iPad平板 (769-1024px)、电脑 (>1024px) 全端响应式体系。全域弹窗在移动端自动升维为原生级底部抽屉 (Bottom Sheet)，配备下拉把手与底部安全区避让；重构模型配置为自适应流体网格与路径自适应省略；输入框与落地页在移动端对标 Gemini 优雅吸底；在输入栏中新增原生媒体与文件上传按钮，一键调起系统相机、相册或文档管理器。
  - **验证与交付**: 前端自动化测试通过 (291项)，生产打包验证成功。

- **[更新通道与弹窗] 新增正式版与预览版双更新通道、交互式弹窗及预发布检测**：
  - **技术机理 / 现象溯源**: 原有更新逻辑仅支持正式版检测，手动点击时直接弹出浏览器原生 alert 提示，缺乏更新通道选择与平滑的交互式弹窗。
  - **实现防线 / 核心改动**: 对标 Antigravity-Manager 设计并重构 `UpdateDialog` 更新弹窗，提供正式版 (Stable) 与预览版 (Beta) 胶囊切换、琥珀色发光呼吸脉冲点、本地偏好持久化及即时通道检测。后端 `/api/update/check` 与 `/api/update/execute` 升级支持 `channel` 参数、GitHub 预发布版本检索与语义化版本号比较器（`compare_versions`）。
  - **验证与交付**: 后端 `test_compare_versions` 预发布版本大小比较单测通过；前端 `api.test.ts` 接口参数测试通过。

- **[WebUI 会话切换与排队转向] 修复切会话用户消息丢失、两轮 Agent 消息串联，以及排队转向卡片刷新/切换消失问题**：
  - **技术机理 / 现象溯源**: 会话执行期间切换离开再切回时，前端判定 `(cacheInFlight && diskSettled)` 误将上一轮已完结的磁盘历史当作本轮已完成，粗暴用旧磁盘数据覆盖了内存缓存，导致本轮 User 提问丢失、后续增量直接拼接到上一轮 Assistant 气泡中。此外，排队与转向卡片未做持久化，刷新页面或触发 Live 快照重连时会被误清空，且异步转向竞态可能丢失会话绑定。
  - **实现防线 / 核心改动**: 修正 `Chat.tsx` 中的磁盘结算判定，当回合处于活跃状态且磁盘尚未包含当前 User 提问时坚决保留内存缓存；在 `queuedDraft.ts` 与 `Chat.tsx` 中引入 `sessionStorage` 持久化，保证页面刷新后卡片依然存在；在 `handleSteerQueuedMessage` 中严格绑定 `targetSid` 消除异步竞态，并阻止快照重连误删转向卡片。
  - **验证与交付**: 前端 `queuedDraft.test.ts` 存储持久化单测通过，全量 291 项前端测试通过。

## v7.1.51 (2026-10-05)

- **[Prompt Discipline] One verification rule, no DeepSeek extra execution block, and no test ritual on review or tiny copy edits**:
  - **Technical Root Cause / Detail**: DeepSeek's `EXECUTION DISCIPLINE` restated verify/finish-the-job as hard rules, and fallback `RULES` still said batch compile/test was mandatory unless the user forbade it. Models ran formatters and checks on PR checkout, code review, and every small edit.
  - **Implementation Mechanism**: Drop `FIRM_EXECUTION_DISCIPLINE` for all models. Keep a single Modification Closure in live `rules.yaml` and fallback `RULES`: one complete check covering the code you changed this request after those edits are in, rather than testing after every small edit. Code review, read-only, checkout, and a few copy/comment/literal edits finish without a test run. WORKFLOW / CARRY IT THROUGH say deliver instead of verify.
  - **Verification & Testing**: `cargo test -p jeikcode-coding --lib persona::` (42 tests). `cargo test -p jeikcode-config --test unified_prompt`.

---

- **[提示词纪律] 验证只留一句，去掉 DeepSeek 额外执行块，审查和改两三处文案不跑测试**：
  - **技术机理 / 现象溯源**: DeepSeek 的 `EXECUTION DISCIPLINE` 把验证/收尾写成硬规则，fallback `RULES` 仍写用户没禁止就批量编译测试。模型拉 PR、做审查、每改一小处都会跑格式化和检查。
  - **实现防线 / 核心改动**: 全模型去掉 `FIRM_EXECUTION_DISCIPLINE`。live `rules.yaml` 与 fallback `RULES` 只留 Modification Closure：相关改动收齐后做一次覆盖这些改动的检查，而不是一点小修改就频繁测试。代码审查、只读、拉代码、改两三处文案/注释/字面量不跑测试。WORKFLOW / CARRY IT THROUGH 改成交付。
  - **验证与交付**: persona 42 个单测；`unified_prompt` 测试。

## v7.1.50 (2026-10-05)

- **[WebUI Session Switch] Sticky todos and queued follow-ups stay visible after leaving a running session and coming back**:
  - **Technical Root Cause / Detail**: Unfinished todo plans live only in the sticky composer panel. History after a sidebar switch often has `todowrite` rows without a trailing `todo_list` part, so looking only at frozen parts hid the panel. Queued steers were restored then immediately cleared when `/chat/active` still reported the session running.
  - **Implementation Mechanism**: `restoreStickyTodos` folds `todowrite` rows (TUI parity) and keeps a stash when the visible tail is incremental-only. `/chat/watch` replay applies each todo call once by id. Queued drafts and pending steers persist per session while the turn is live.
  - **Verification & Testing**: `webui` `npm test` for `todos.test.ts` and `queuedDraft.test.ts`.

- **[Coding Agent Reminders] Open with a `code_explore` tail, nudge wander searches on tool results, and put Plan Mode on the same user message**:
  - **Technical Root Cause / Detail**: `code_explore` was under-triggered. Independent synthetic User blocks stole recency or looked user-authored. A DeepSeek-only skill-first block and an edit-then-verify continuation (`You made code edits but have not verified them…`) added extra loop turns.
  - **Implementation Mechanism**: First real user query gets a stored `<system-reminder>` tail (with the date). A per-session meter counts `grep`+`glob`+`read_file`; the 8th combined call in a window of 10 appends a wander reminder to that tool result; a full window or one `code_explore` resets the count. Plan Mode appends to the current user block after the date. `SkillFirstHook` and `VerifyCadenceHook` are removed. Claude Code `SessionStart` additional context is `synthetic_user`.
  - **Verification & Testing**: `cargo test -p jeikcode-coding --lib` for `code_tools_first`, `plan_mode`, and `todo`. `cargo test -p jeikcode-capabilities --lib --features cc-hooks session_start_injects_synthetic`.

- **[Prompt Discipline] Safe CLIs run as the install/login check; irreversible steps get one cheap exists/login probe**:
  - **Technical Root Cause / Detail**: Models often ran `which` / `gh auth status` / `npm whoami` before a harmless command.
  - **Implementation Mechanism**: Live `rules.yaml` and fallback `RULES`: when the next step is safe (`gh pr list`, `npm test`, `cargo check`, `docker ps`), run it and treat its output as the check. When the next step is destructive, publishing, billing, credential-writing, or irreversible remote, and install/login/account is unclear, run one cheap check and reuse it.
  - **Verification & Testing**: `persona_carries_model_and_anchors` asserts `Prefer the real command`.

- **[Release Notes] Desktop installer links use the Tauri filename with a dot, and the docs site follows the GitHub latest tag**:
  - **Technical Root Cause / Detail**: Publish script used a filename that 404'd on GitHub Releases. Docs version lagged the tag.
  - **Implementation Mechanism**: `publish-release.js` uses the Tauri bundle name. Docs workflow injects the live GitHub release version.
  - **Verification & Testing**: Covered by the v7.1.49-era publish path already on `main` (`987b74fd7`); this tag is the first release that ships it.

---

- **[WebUI 会话切换] 离开仍在跑的会话再回来，粘性待办和排队追问还在**：
  - **技术机理 / 现象溯源**: 未完成的 todo 只活在输入框上方的粘性面板。侧栏切走再回来时，历史里常有 `todowrite` 行却没有末尾 `todo_list`，只看冻结块就会把面板弄丢。排队追问在 `/chat/active` 仍显示进行中时被清掉。
  - **实现防线 / 核心改动**: `restoreStickyTodos` 按 TUI 折叠 `todowrite`；可见窗口只有增量更新时保留 stash。`/chat/watch` 回放按 call id 各折叠一次。排队草稿与 pending steer 按会话保存。
  - **验证与交付**: `webui` `npm test`（`todos.test.ts`、`queuedDraft.test.ts`）。

- **[编码 Agent 提醒] 首条提问尾巴提示 `code_explore`，漫游检索挂在工具返回上，Plan 模式挂在同一条 user 上**：
  - **技术机理 / 现象溯源**: `code_explore` 触发弱。独立 synthetic User 块抢 recency 或看起来像用户说的。DeepSeek 专用 skill-first 与「改完必须 cargo check」续写会多绕几轮。
  - **实现防线 / 核心改动**: 第一条真实提问追加 `<system-reminder>` 尾巴（与日期同条）。按会话合计 `grep`+`glob`+`read_file`，窗口 10 内第 8 次把提醒接到该次工具结果；满 10 或一次 `code_explore` 清零。Plan 模式接在日期后面。删除 `SkillFirstHook` 与 `VerifyCadenceHook`。CC `SessionStart` 附加上下文改为 `synthetic_user`。
  - **验证与交付**: `code_tools_first` / `plan_mode` / `todo` 单测；`cc-hooks` 的 SessionStart synthetic 测试。

- **[提示词纪律] 安全命令直接当安装/登录检查；不可逆步骤只做一次廉价存在/登录核对**：
  - **技术机理 / 现象溯源**: 模型常在无害命令前先跑 `which` / `gh auth status` / `npm whoami`。
  - **实现防线 / 核心改动**: live `rules.yaml` 与 fallback `RULES`：下一步是 `gh pr list`、`npm test`、`cargo check`、`docker ps` 这类安全命令时直接执行。下一步是破坏性、发布、计费、写凭证或不可逆远端，且安装/登录/多账号不清楚时，做一次廉价检查并复用。
  - **验证与交付**: persona 单测包含 `Prefer the real command`。

- **[发版说明] 桌面安装包链接改用 Tauri 带点的文件名，文档站跟随 GitHub latest**：
  - **技术机理 / 现象溯源**: 发布脚本里的安装包文件名在 GitHub Releases 上 404。文档版本落后于 Tag。
  - **实现防线 / 核心改动**: `publish-release.js` 使用 Tauri 产物名。文档工作流注入当前 GitHub latest 版本。
  - **验证与交付**: 该修复已在 `main` 的 `987b74fd7`；本 Tag 是第一次随正式版发出。

## v7.1.49 (2026-10-04)

- **[Desktop Model Configuration Loading] Treat empty 401 as missing token rather than JSON syntax error, reporting genuine status even with existing configuration**:
  - **Manifestation of Empty 401**: When launching the desktop app and opening model settings, the modal displayed `加载失败: Failed to execute 'json' on 'Response': Unexpected end of JSON input`. Users already had `~/.jeikcode/config.toml` configured. The root cause was `GET /config` routed through webui token middleware; missing or invalid tokens made `require_webui_token` return `Err(StatusCode::UNAUTHORIZED)` with an empty HTTP body. The frontend `getConfig()` called `resp.json()` directly, throwing SyntaxError on empty responses.
  - **Authentication Failure JSON Response**: Added `unauthorized_payload()` in `crates/jeikcode-daemon/src/auth_token.rs`, responding with `{"success":false,"error":"Unauthorized: missing or invalid access token"}` instead of an empty status code across `require_webui_token` and `require_app_user_id`.
  - **Resilient Frontend Parsing**: Added `readApiJson()` in `webui/src/api.ts` to inspect body text before parsing. Empty 401 raises explicit Unauthorized, preventing `Unexpected end of JSON input`. Model settings modal maps 401/unauthorized errors to an informative message instructing users to reopen the desktop app.
  - **Robust Token Persistence in Desktop WebView**: URL query param `?token=` is written to both `sessionStorage` and `localStorage`, then scrubbed from address bar once persisted (CWE-598). Retains `?token=` if storage is unavailable. `authHeaders()` dynamically reads token per request rather than static module load constants.
  - **Onboarding Safeguard**: On `desktop=1`, failure in `getModels()` no longer forces first-time onboarding. Empty model list triggers onboarding only when request succeeded with zero models.
  - **Verification**: `cargo test -p jeikcode-daemon unauthorized_payload` passed. WebUI `npm test` passed 281 test suites including empty 401, JSON 401, and successful `GET /config`.

---

- **[桌面模型配置加载] 打开模型配置时不再把空 401 当成 JSON 解析失败，配置文件还在也能显示真实原因**：
  - **空 401 的表象**：桌面启动后打开模型配置，弹窗显示 `加载失败: Failed to execute 'json' on 'Response': Unexpected end of JSON input`。用户本机已有 `~/.jeikcode/config.toml`（新 schema 的 `[models.*]` / `[provider_accounts.*]`）。根因是 `GET /config` 走 webui token 中间件；缺 token 或 token 无效时，`require_webui_token` 返回 `Err(StatusCode::UNAUTHORIZED)`，Axum 给出**空 body**。前端 `getConfig()` 直接 `resp.json()`，浏览器对空响应抛出该 SyntaxError。
  - **鉴权失败返回 JSON**：`crates/jeikcode-daemon/src/auth_token.rs` 增加 `unauthorized_payload()`，401 正文为 `{"success":false,"error":"Unauthorized: missing or invalid access token"}`。`require_webui_token` 与 `require_app_user_id` 都走这条响应，不再返回空状态码。
  - **前端安全解析**：`webui/src/api.ts` 新增 `readApiJson()`。`getConfig()` 先读文本再解析；空 401 抛出明确的 Unauthorized，不再触发 `Unexpected end of JSON input`。模型配置弹窗把 401 / unauthorized / access token 映射为「访问令牌无效或缺失。配置文件还在，请关闭后重新打开桌面端。」
  - **token 在桌面 WebView 里更稳**：URL 里的 `?token=` 同时写入 `sessionStorage` 和 `localStorage`。存成功后再从地址栏去掉 token（CWE-598）。存储不可用时保留 `?token=`，避免刷新后所有 API 401。`authHeaders()` 每次请求现读 token，不再用模块加载时的一次性常量。
  - **首次向导不再把鉴权失败当成没配模型**：`desktop=1` 时 `getModels()` 失败不再弹出 onboarding。空模型列表（请求成功且长度为 0）才进入向导。
  - **验证**：`cargo test -p jeikcode-daemon unauthorized_payload` 通过。`webui` `npm test` 281 项通过，含空 401、带 JSON 的 401、以及成功 `GET /config`。已执行 `webui` `npm run build`。未在已安装的桌面窗口里再点一次。

## v7.1.48 (2026-10-04)

- **[桌面窗口打开本机地址] 桌面启动不再把窗口带到局域网 IP，没有控制台时 WebUI 进程也不会马上退出**：
  - **窗口用 127.0.0.1**：`start_webui` 仍执行 `jeikcode webui --host 0.0.0.0`。启动日志里的地址可能是网卡 IP（例如 `192.168.123.20`）。`window_url` 在导航前把主机改成 `127.0.0.1`，端口和 token 不变。其他设备继续用右上角面板列出的局域网地址。
  - **没有控制台就一直听着**：`wait_until_webui_stopped` 在 Windows 上先看 `GetConsoleWindow`。桌面壳用 `CREATE_NO_WINDOW` 拉起时没有控制台，进程停在这里，直到桌面壳退出时把它杀掉。终端里手动执行 `jeikcode webui` 仍按 Ctrl+C 结束。`ctrl_c()` 返回错误时同样不退出。
  - **不再读完地址就关掉 stderr**：`read_url` 找到地址后继续把标准错误读完。先前读完第一行就关掉管道，子进程后续写标准错误会触发二次 panic，以 `0xc0000409` 退出，窗口就显示拒绝连接。
  - **验证**：桌面 `window_url` 单测把 `192.168.123.20` 改写为 `127.0.0.1` 并保留 token。没有在装好的桌面窗口里再点一次。

## v7.1.47 (2026-10-04)

- **[桌面端直接监听 0.0.0.0] 桌面启动的 WebUI 与命令行 `--host 0.0.0.0` 走同一套监听，右上角面板改的是这个端口和 token，不再另开一个端口**：
  - **启动命令**：`desktop/src-tauri/src/main.rs` 的 `start_webui` 改为 `jeikcode webui --host 0.0.0.0 --port <端口> --no-open`。没有 `~/.jeikcode/webui-listen.json` 时端口是 `13457`（`WEBUI_DEFAULT_PORT`），并随机生成 token。文件里有端口和 token 时，下次启动带上该端口和 `--token`。`JEIKCODE_HOME` 优先于用户目录下的 `.jeikcode`。命令行自己执行 `jeikcode webui` 且不写 `--host` 时仍绑定 `127.0.0.1`，避免 TUI `/webui` 被一起暴露。
  - **固定 token 贯穿窗口和面板**：`Commands::Webui` 增加 `--token`。`ensure_webui` 经 `startup_webui_token` 登记非空 token，并调用 `WebuiTokenStore::set_display` 作为地址和面板上的那一个。未提供时沿用已有展示 token，否则 `mint`。`register` 只把 token 放进有效集合，不再覆盖展示值，所以已经打开的页面仍接受原来的 token。
  - **同端口的 token 马上生效**：右上角 `RemoteAccessControl` 显示这次实际绑定的地址和端口，并预填启动 token，用户可以改。端口与 `bind_port` 一致时，`apply_launch_settings` 登记新 token、设为展示值、打开校验，并写入 `webui-listen.json`。
  - **改端口下次启动生效**：端口不同时不重新绑定当前套接字，只把端口和 token 写入该文件。状态里的 `next_port` 与正在听的端口不同，面板小字说明新端口下次启动才换上；要马上换 token，把端口改回正在听的端口再应用。
  - **无 token 不落盘**：勾选无 token 只对这一次进程调用 `apply_remote_auth(true)`。文件不写 `no_token`，也不清掉已保存的 token。同时改了端口时只更新端口，沿用文件里原来的 token。下次启动仍带 token。
  - **面板不再另开第二个监听**：请求带 `apply_launch: true` 时走上述保存逻辑，不碰 `extra_remote`。主监听已是非回环地址时地球图标为绿色。关闭按钮去掉，因为这一个端口就是桌面窗口自己的服务。未带 `apply_launch` 的调用仍走原来的额外监听。打开面板时，只有额外监听还开着才查 Windows 防火墙，避免主监听为 `0.0.0.0` 时弹出放行提示。
  - **修复 CI 编译错误**：`firewall_rule_matches` 在返回 `bool` 的函数里对 `netsh_text` 的 `Option` 使用了 `?`。改为匹配不到规则文本时直接返回 `false`。
  - **验证**：`cargo check -p jeikcode-daemon --lib` 通过。`cargo test -p jeikcode-daemon --lib api_config::tests` 9 项通过，覆盖同端口立即生效、改端口只落盘、无 token 不落盘。桌面 `parse_webui_listen` 单测通过。

## v7.1.46 (2026-10-04)

- **[临时远程访问局域网可达与面板可再次操作] 修掉 WebUI「临时远程访问」应用 `0.0.0.0` 后只有本机能打开、以及应用后按钮和绿灯卡死的问题**：
  - **分享地址不再落到回环**：`remote_status` / `access_urls` 对 `0.0.0.0` 与 `::` 列出本机可分享的 IPv4（优先 `primary_lan_ipv4`，再扫描 `ipconfig`），不再把 `127.0.0.1` 或 `[::1]` 当作局域网链接。找不到网卡地址时留空，面板提示用本机 IPv4 加端口。
  - **IPv4 与 IPv6 分开绑定**：`bind_listener` 用 `socket2` 显式监听 `0.0.0.0`，IPv6 设置 `IPV6_V6ONLY`。避免 Windows 默认双栈套接字把外部 IPv4 占住，造成本机能开、别的设备不能开。
  - **Windows 入站放行**：桌面端原先只听 `127.0.0.1`，系统不会在启动时询问防火墙。临时监听改为对外后，按当前 `jeikcode.exe` 检查名为 `JeikCode` 的入站允许规则；没有规则时尝试添加，仍失败则对本进程提一次 UAC。面板在规则尚未就绪时提示放行。监听回环地址不查防火墙。
  - **同一地址再应用不再死锁**：同一主机和端口只更新 token，并在调用 `remote_status` 之前放开 `extra_remote` 这把不可重入的锁。此前第二次应用会一直不返回，前端停在忙碌，应用和关闭都不可点，绿灯保持亮着。
  - **换端口失败时保留仍在听的端口**：端口不同时先绑定新套接字，失败则旧监听还在。同一端口必须先停再绑，地址仍被占用时等待约 100ms 再试一次；最终失败会恢复原来的 token 校验，避免半套监听还留着免鉴权。
  - **面板可关、可改、超时会收回状态**：`RemoteAccessControl` 在应用进行中仍可点关闭；请求超过 12 秒放弃并重新查询。若服务器上已经没有监听，绿灯、链接和防火墙提示一并清掉。成功时列出全部可访问地址，并显示实际正在监听的地址和端口。

- **[会话切换与通知点击] 切会话不再丢掉未落盘的回答，通知点击不再闪出命令行窗口**：
  - **切会话以磁盘上真实的助手消息为准**：`Chat.tsx` 不再把「还没有助手消息」当成已经结算，避免离开再回来时用空结果盖掉内存里的进行中内容。进行中的会话继续走 `/chat/watch`，不再改成只轮询磁盘。
  - **Windows 通知点击不再弹出控制台**：`jeikcode-focus:` 改为由 `notify-focus.vbs` 经 `wscript` 隐藏启动 PowerShell。聚焦时优先找桌面进程 `jeikcode-desktop`，并跳过浏览器窗口；最小化窗口会先还原再置前。
  - **多页面不会抢掉同一次点击**：`/notify-focus` 改为带单调 `version` 的状态，GET 不再把待跳转会话取走。WebUI 记下已见版本，只有更新的点击才派发 `jeikcode:focus-session`。

## v7.1.45 (2026-10-04)

- **[临时远程访问与安全鉴权深度治理] 彻底根除 WebUI 临时远程监听鉴权失效与局域网不可达缺陷，全面支持双栈绑定与动态原子 Token 保护**：
  - **动态原子鉴权开关与 Token 强制执行**：针对守护进程以免鉴权模式启动后 `enforce_token` 静态写死导致临时暴露局域网时鉴权完全形同虚设的安全漏洞，将 `AppState.enforce_token` 升级为 `Arc<AtomicBool>` 动态原子控制，并在开启临时远程访问时即时激活 Token 强校验，坚决拦截无凭证请求返回 401 Unauthorized；
  - **全链路双栈监听与 CORS 放行修复**：在 `crates/jeikcode-daemon/src/api_config.rs` 中补齐 IPv6 `[::]:port` 双栈监听与多任务生命周期管理，并在 `is_allowed_cors_origin` 中放宽对客户端直连 Host 与公网双栈 IPv6 的校验，彻底打通局域网跨设备直连；
  - **状态持久化与 URL 完整回显**：解除了 `already` 状态死锁判定，在 `ExtraRemoteBind` 中持久化记录当前绑定的活跃 Token，保证 GET/POST 状态接口生成的访问链接 100% 完整携带 `?token=...`，支持随时热更新参数。

- **[跨平台桌面通知体系全面重构与交互动作升级] 消除双重通知重叠与窗口闪烁缩放顽疾，打通 Windows/macOS/Linux 原生交互通知与一键审批**：
  - **单通道通知收敛与消除双重重叠**：完全移除 Web 前端重复触发的浏览器内置 Web Notification，统一收敛至操作系统原生桌面通知（Windows Toast / macOS UserNotifications / Linux notify-send），彻底解决右下角多弹窗叠层遮挡问题；
  - **Windows WinRT Toast 原生交互按钮支持**：在 `crates/jeikcode-capabilities/src/notify.rs` 中升级 Toast XML 模板，当触发工具审批（`permission_request`）时原生注入 `[ Approve ]` 与 `[ Deny ]` 操作按钮，用户无需切换前台窗口即可在 Windows 屏幕右下角点击按钮秒级完成权限审批；提问（`request_user_input`）通知自动注入 `[ Answer / 作答 ]` 快捷按钮直达问题；
  - **Win32 窗口前台穿透激活与尺寸保护 (ForceActivate)**：彻底重构 `notify-focus.ps1` 窗口聚焦脚本，引入 Alt 键微秒级按键事件挂起 Windows 内核的 `ForegroundLockTimeout` 超时限制，结合 `AttachThreadInput` 与 `SwitchToThisWindow` 实现 100% 稳定置顶前台激活；未最小化时绝不调用 ShowWindow，彻底消除多次重绘引起的闪烁，100% 保护最大化与 Windows 11 Aero Snap 贴靠尺寸不缩水；
  - **macOS 与 Linux 提问与审批通知全支持**：在 `notify-focus.sh` 脚本中增加动作解析，Linux 下通过 `notify-send -A` 原生支持 Approve/Deny 按钮点击提交，macOS 下原生调用 `UNUserNotificationCenter` 弹窗提醒，点击秒级无损激活置顶前台会话。

## v7.1.44 (2026-10-04)

- **[Windows 桌面 Toast 通知协议唤醒与焦点穿透 (Windows Toast Protocol Activation & Session Focus)] 攻克 WinRT 原生通知点击无法唤醒应用与会话定位问题，建立完整系统 Protocol Scheme 与守护进程鉴权通知总线**：
  - **WinRT Toast 注册 AUMID 方案重构与 Banner 显示修复**：在 `crates/jeikcode-capabilities/src/notify.rs` 中排除无响应的未注册裸 `JeikCode` AUMID，优先使用标准 Windows PowerShell AUMID (`{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`) 触发 Toast 弹窗，根除 `Show()` 假成功但不弹出横幅通知缺陷；Toast 悬留时间延长至 `duration="long"`，并完善 XML 实体转义机制。
  - **注册 Windows 自定义 URI 协议 (`jeikcode-focus:`)**：在 `notify.rs` 中新增 `install_windows_focus_protocol`，自动注册 `HKCU\Software\Classes\jeikcode-focus` 协议，动态生成 `~/.jeikcode/notify-focus.ps1` 唤醒脚本；点击 Toast 通知时通过 Win32 API (`SetForegroundWindow`/`ShowWindow`/`BringWindowToTop`) 将最小化或后台的 JeikCode 窗口平滑置顶。
  - **守护进程安全通知通道与会话跳转**：在 `crates/jeikcode-daemon/src/lib.rs` 中新增 `/notify-focus` POST/GET 端点，基于 32 位 Hex 进程安全秘钥防护攻击；前端 `webui/src/api.ts` 与 `app.tsx` 引入轻量轮询探针，接收点击回调时自动触发 `jeikcode:focus-session` 全局事件并精准无缝跳转至对应会话。
  - **全量 OS 通知响应策略**：更新 `webui/src/lib/sessionNotify.ts` 与 `Chat.tsx`，将 `shouldOsNotifyTerminal` 优化为全量触发模式，保证无论前后台状态，回合完成时系统通知中心均能准确捕获，实现无遗漏的离线完成追溯。


## v7.1.43 (2026-10-04)

- **[桌面端通知系统深度治理与抗休眠加固] 根除 WebUI 套壳/桌面端窗口最小化与失焦时通知失效缺陷，打通系统原生通知与点击唤醒会话跳转闭环**：
  - **新建会话 Terminal 事件镜像修复**：修复 `crates/jeikcode-daemon/src/lib.rs` 的 `fanout_chat_events_for_session` 中因新建会话初始 `session_id` 为 `None` 导致 `ChatEvent::Done` 事件被静默跳过、未记录进全局会话运行时注册表（`SessionRuntimeRegistry`）的严重缺陷，动态提取权威会话 ID，保证第一轮消息完成时 `last_terminal` 与 `terminal_seq` 100% 递增生效。
  - **前端抗休眠零延迟直接通知通道**：针对 Chromium/WebView2 桌面套壳在窗口最小化或后台失焦时对 `setInterval` 定时器进行强制节流与冻结（Timer Throttling/Freeze）导致通知被阻断的问题，在 `webui/src/components/Chat.tsx` 的 SSE `case 'done'` 完成事件处理处建立零延迟直达通道，失焦时直接触发操作系统桌面通知，彻底绕过前端轮询休眠限制。
  - **点击通知唤醒置顶并自动定位会话 (Click-to-Focus & Auto-Navigate)**：在 `webui/src/lib/sessionNotify.ts` 中封装 `dispatchSystemNotification`，绑定 Web Notification 的 `onclick` 回调，在 `webui/src/app.tsx` 中建立 `jeikcode:focus-session` 全局事件响应总线；用户在桌面右下角点击系统通知或应用内卡片时，窗口自动还原置顶唤醒，并瞬时平滑跳转切换至对应会话的时间线。
  - **Windows Toast AUMID 通用兼容扩充**：在 `crates/jeikcode-capabilities/src/notify.rs` 的 PowerShell WinRT 脚本中扩充 Windows 常见系统级应用标识符（`JeikCode`、`Microsoft.Windows.Explorer`、`Microsoft.WindowsTerminal` 等），确保独立便携版与打包安装版均能 100% 成功唤起 Windows 系统的右下角横幅 Toast 通知。
  - **前台焦点智能免打扰**：在 `webui/src/lib/sessionNotify.ts` 与 `NotificationDock.tsx` 中新增智能免打扰判定，当用户正处于当前前台会话窗口亲眼看着 Agent 回复结束时，自动抑制多余的右下角应用内卡片与系统提示，实现“前台专注无打扰，后台离开准时报”。

- **[多项目会话树状归属与视觉层级重构] 彻底根治左侧栏会话字号倒挂与层级扁平错觉，建立工业级树形结构引导线与对话节点语义**：
  - **理顺父子字号与字重阶梯**：针对原项目标题 12.5px 偏小而子会话 14px 粗体导致的严重“会话比项目还大”层级倒挂问题，将项目父级标题提升至 `13.5px`（字重 `600`，主色骨架），子会话标题收敛规范至 `12.5px`，构建清晰自然的二级/三级父子权重阶梯。
  - **树状分支层级引导线 (Tree Indent Guide Line)**：在 `webui/src/styles/app.css` 中为 `.project-sessions-list` 增加 `1.5px solid var(--app-border)` 竖向半透明层级引导线与 `17px` 标准缩进，视觉视线顺着父级项目文件夹图标自然向下延展，一眼感知所有会话牢牢隶属于当前项目。
  - **专属对话图标语义 (ChatBubbleIcon)**：在 `webui/src/components/Sidebar.tsx` 中为每个子会话条目增加专属对话气泡小图标，与父级项目的 `FolderIcon` 文件夹图标形成标准的「文件夹 ➔ 旗下对话」认知模型；时间戳标签智能对齐缩进，整体排版更加精致、专业。

## v7.1.42 (2026-10-04)

- **[会话落盘与状态快速探测] 新增轻量级会话新鲜度端点与前端轮询减负，消除多余反序列化与频繁磁盘 I/O**：
  - **轻量会话新鲜度探针 (`/freshness`)**：在 `crates/jeikcode-daemon/src/lib.rs` 中新增 `GET /projects/:hash/sessions/:id/freshness` 路由，仅通过对 snapshot、jsonl 与 presentation 三个底层文件的 `fs::metadata` 快速 stat 聚合总字节数和最大 mtime（`bytes:mtime_ms`），不读取、不反序列化庞大消息体；结合服务端实时会话池返回当前会话 running 活跃状态。
  - **前端智能落盘感知与降频轮询**：`webui/src/components/Chat.tsx` 引入 `catchUpFromDisk` 机制，在途流式期间免触碰磁盘，仅在静默期通过签名比对探测真实落盘变化；将脱机轮询间隔平滑优化至 2000ms，在落盘终结后原子收敛至 `authoritative_terminal`，大幅降低前端重绘与系统 I/O 开销。

- **[会话完成通知与通知坞站系统] 引入全局通知坞站组件，跨平台支持事件捕获与系统通知**：
  - **通知坞站组件 (NotificationDock)**：新增 `webui/src/components/NotificationDock.tsx`，集中挂载并展示长耗时任务完成提醒、权限卡片审批及用户交互输入（UserInputCard）通知，支持状态机无缝闭环与桌面 Native 通知分发。
  - **底层能力与路由调度支持**：在 `crates/jeikcode-capabilities/src/notify.rs` 及 daemon 核心路由中打通通知事件流，并在前端 `webui/src/lib/sessionNotify.ts` 提供完备的状态管理与单元测试防线。

- **[自动化发版流水线与多分支演进] 引入自动 Bump 脚本、独立 Beta 预发布通道与英文优先规范**：
  - **跨生态版本号一键同步 (`npm run bump`)**：新增 `scripts/bump-version.js`，支持 `npm run bump:beta`、`bump:patch`、`bump:minor`、`bump:major`，一键联动同步 `Cargo.toml`、`webui/package.json`、`desktop/src-tauri` 及 `package.json` 版本声明。
  - **版本号门禁 SemVer 预发布支持**：升级 `scripts/check-version-gate.js` 的预发布比对器（`comparePrerelease`），原生支持类似 `v7.1.42-beta.1` 的预发布版本号比对，确保 Beta 发布自动标为 Prerelease 且绝不污染主 Releases 稳定版索引。
  - **Release 说明国际化标准重构**：调整 `scripts/publish-release.js`，发版说明模板实行「英文置前、中文在后（English First, Then Chinese）」，统一跨平台安装包与变更分类指引。

- **[官方教程站点与移动端体验全面革新] 搭建 VitePress 独立文档站 (docs.jeikcode.top)，移动端深度适配与全自动部署**：
  - **官方教程独立站点上线**：通过 Cloudflare Pages 全球 Edge CDN 节点与自定义域名绑定 `https://docs.jeikcode.top` 实现自动化构建上线。
  - **移动端全屏响应式深度优化**：彻底解决移动端 Hero 图片穿透覆盖顶部导航栏的缺陷，将 Logo 尺寸精调至 135px 黄金视觉尺寸，版本号与大标题间隙微调至 16px 舒适缓冲；代码块右上角移动端常驻显示 `[📋]` 复制按钮，语言标识左移避让防遮挡；右上角新增常驻 `Docs` 按钮直达产品简介。
  - **智能语言嗅探与个人偏好记忆**：站点 `<head>` 注入极速零闪烁语言嗅探逻辑，中文系统首次访问根路径自动无缝进入 `/zh/`，其他语言默认英文；同时联动 localStorage 记住用户的手动切换偏好。

- **[中英双语 README 全面精简重塑] 聚焦核心体验，收拢引流至官方教程站点**：
  - `README.zh-CN.md`、`README.md` 与 `README.en.md` 开头全面置顶官方使用教程与文档站点链接（`https://docs.jeikcode.top`）；
  - 精简冗长篇幅，聚焦保留产品核心优势介绍、跨平台安装包下载路由矩阵、终端一键命令与快速开始指南。

## v7.1.41 (2026-10-03)

- **[全局语言开关与英文默认] 未初始化时界面、安装文档与 `--host` 提示统一为英文，语言选择写回同一份配置**：
  - **配置种子与升级保护**：`crates/jeikcode-cli/assets/default-config.toml` 与 `crates/jeikcode-coding/assets/default-config.toml` 的 `language` 改为 `en`。`merge_user_config_preserving_models` 将 `language` 列入保留键，升级不会把用户已选的语言盖回模板。缺失该字段时，WebUI 与 daemon 按英文处理。
  - **WebUI / 桌面跟随同一开关**：`webui/src/settings.tsx` 启动时读取 `GET /config` 的 `language`，右上角切换调用 `POST /config/language` 写回 `config.toml`，并立刻 `set_locale`。桌面壳打开的是同一套 WebUI。
  - **`--host` 启动文案**：`host_service.rs`、`systemd.rs`、`server_cmd.rs` 的登录自启提问与结果说明按当前 locale 输出，不再写死中文。
  - **升级配置提示**：`config_sync.rs` 的差异说明与应用结果按当前语言生成；WebUI `ConfigSyncModal` 的已选计数走 i18n。
  - **文档站默认英文**：VitePress 根路径改为英文。原先截图中的「推荐方式：官方一键安装脚本」现为 `/guide/installation` 的 “Recommended: Official One-Line Install Script”。简体中文整站位于 `/zh/`。

- **[桌面首次向导、顶栏刷新与临时远程访问] 第一次打开桌面端补上语言和模型向导，右上角可以刷新页面并临时对局域网开放**：
  - **首次向导**：`desktop=1` 且还没有模型时弹出 `OnboardingWizard`，先选语言再进入模型配置，可跳过。
  - **刷新与更新图标**：右上角增加可点击刷新（整页重载）。检测更新按钮改为环形箭头。
  - **临时远程访问**：`RemoteAccessControl` 提供监听地址（默认 `0.0.0.0`）、端口（默认 `4096`）、token，以及「无 token」勾选。勾选后 token 框禁用并变为白底。`POST /api/remote-access` 在当前进程上再绑一个监听，不重启原来的页面；`token_optional` 打开后本进程不再校验 token。

- **[Windows 登录自启] 不再使用会静默失败的 `schtasks /SC ONLOGON`**：
  - 启动命令写入 `%USERPROFILE%\.jeikcode\services\JeikCode-<port>.cmd`，并登记 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`。`resolve_service_exe` 在 Windows 上使用当前正在运行的 `.exe`。`jeikcode server list/uninstall` 能看到并删除该登录项，同时清掉同名旧计划任务，避免两个进程抢端口。

- **[会话列表、模型入口与实时跟上] 新会话能看出项目路径，进行中的回合不再只靠 F5 才出现正文**：
  - **新会话**：落地页显示所属项目路径。模型选择和配置齿轮在发出第一条消息前就挂在右上角。
  - **项目排序**：左侧项目按该项目里最新一条会话消息的时间置顶，侧栏轮询同时刷新项目列表。
  - **实时跟上**：进行中的会话每秒用和刷新相同的 `tail` 读取已落盘记录。磁盘正文更长就立刻画上；磁盘已结束而页面仍在空转就停掉光标。实时流比磁盘更新时，旧 snapshot 不会盖掉更长的画布。本页刚发出的消息若切到新会话，会跟着那个会话，不再把后续输出丢掉。观察模式在 watch 仍连接时也会采用更长的磁盘正文。

## v7.1.40 (2026-10-01)

- **[多项目会话隔离与端到端目录穿透根治] 彻底消除 WebUI 在多项目间新建聊天与快速切换会话时的并发竞态与工作目录污染，草稿权威绑定与状态机原子化收敛**：
  - **前端导航序列号屏障与过期响应熔断 (NavSeq Cancellation & Race Guard)**：针对用户在项目 B 点击 `+`（新建聊天）异步请求 `createSession` 在途期间快速切换至项目 A 会话的并发竞态，在 `webui/src/app.tsx` 中引入单调递增导航序列号 `navSeqRef`。当用户在响应返回前切换会话、切换项目或重新新建时，递增序列号使在途请求立即失效；`createSession.then` 严格校验序列一致性，主动丢弃过期响应，坚决杜绝旧项目的延迟回调暴力覆盖当前视图的会话 ID 与元数据。
  - **前端会话权威工作目录原子收敛 (Authoritative Session Cwd Binding)**：在 `webui/src/components/Chat.tsx` 中建立以当前活跃会话自身为最高真理的 `effectiveWorkingDir` 计算模型（`activeSession.working_dir ?? cwd`），并将 `/chat` 流式会话、`/fs/upload` 附件上传、`/compact` 会话压缩、Git 状态面板以及 `@` 目录自动补全全面收敛绑定至会话专属目录；同时在 `openNewSession` 发起前立即预先同步 `cwd`，并在有效响应回调中原子补齐 `setCwd(data.working_dir)`，彻底根除前后端目录状态分裂与丢失。
  - **后端草稿目录绝对权威性校验与防篡改 (Session Draft Absolute Directory Authority)**：在 `crates/jeikcode-daemon/src/lib.rs` 的核心对话路由 `process_chat_request` 中，针对客户端请求携带的草稿 `session_id`，强制以 `crate::native_live::session_draft_working_dir` 在内存中登记的原初目录为绝对权威；无论客户端由于并发竞态或其他异常传入何种外层 `req.working_dir`，后端强行校正其 `working_dir` 与计算出的 `project_bucket`，彻底根除将草稿会话错误落盘至其他项目目录与 bucket 的安全漏洞，从根本上消除了会话“穿透跑到其他项目列表”的隐患。
  - **跨项目已落盘会话自动寻址校准 (Cross-Project Resolved Catalog Healing)**：在会话未命中当前请求目录所对应的 `project_bucket` 时，通过 `resolve_session_by_id` 自动跨项目扫描定位该会话真正的归属项目与权威目录，并在 `process_chat_request` 中自动对齐 `working_dir`；同时升级 `crates/jeikcode-daemon/src/live_api.rs` 的 `live_message` 路由，针对多项目并发调用优先解析草稿与已落盘会话目录，杜绝误用全局 `state.project`。
  - **自动化测试防线与多项目状态验证 (Full Test Coverage & Verification)**：在前端 `webui/src/lib/sessionList.test.ts` 中新增异步时序竞态单元测试，模拟高频点击切换与网络乱序返回，验证过期响应被精准丢弃；在后端 `crates/jeikcode-daemon/src/lib.rs` 中新增 `session_draft_working_dir_guards_against_cross_project_penetration` 跨项目隔离测试，验证在伪造恶意或竞态 working_dir 场景下后端权威目录与 bucket hash 的绝对物理隔离；全套 268 项前端测试及工作区 `cargo check` 100% 绿灯通过。

- **[Session 级 MCP 隔离与多会话环境注入] 为会话作用域 stdio MCP 子进程注入会话身份，并发 Schema 探测双重检查锁治理**：
  - **会话级环境变量安全注入 (`JEIKCODE_SESSION_ID`)**：在 `crates/jeikcode-capabilities/src/mcp/transport_stdio.rs` 中为 `StdioClient` 增加会话身份标识；在启动会话级 MCP 子进程时完成安全校验，并将 `JEIKCODE_SESSION_ID` 正式注入子进程运行环境变量，使下游 MCP 服务可原生感知并区分会话上下文。
  - **断线自愈重连状态保全**：升级 `clone_for_recovery` 机制，在 stdio 管道异常重连时完整继承会话 ID 与作用域身份，防止自愈后丢失会话上下文；沿 `McpRegistry` 与 `SessionMcpPool` 调用链路完整透传 `session_id`，严格仅对声明了 `scope: "session"` 的服务执行隔离。
  - **并发 Schema 探测双重检查锁 (Double-Checked Locking)**：在 `crates/jeikcode-capabilities/src/mcp/schema_cache.rs` 的 `ensure_session_mcp_schema` 中引入双重检查锁，根治多会话并发冷启动时重复拉起探测子进程的资源竞争，测试等待时序与后台异步探测稳定性大幅增强。

- **[WebUI 乐观会话集合与首发切走防丢] 乐观会话字典级去重保护，转圈动效即刻反馈与前后端状态无缝衔接**：
  - **会话集合级乐观持久化 (`optimisticSessions`)**：全面重构会话挂载机制，支持跨会话切换的多条乐观记录集合。用户在新建会话首发消息后立即切换至其他会话时，侧栏完整保留该正在进行中的新建会话，彻底解决因等待落盘而在侧栏瞬间消失的严重体验缺陷。
  - **点击发送即时视觉广播**：点击发送按钮时立即触发前端 running 广播并点亮转圈指示器，告别过去等待模型首字吐出或依赖切会话才能看到加载态的顿挫感；服务端分配真实 ID（`handleSessionAssigned`）时自动驱动侧栏列表无缝融合覆盖。

- **[发布流水线与发版说明工业级重构] CI 自动提取 CHANGELOG 结构化详述正文，规范发版动作并杜绝极简 Release 描述**：
  - **发布脚本 CHANGELOG 深度解析提取 (`scripts/publish-release.js`)**：新增 `extractChangelogSection` 解析引擎，发版流水线在构建各平台制品时，优先精准提取 `CHANGELOG.md` 中当前 Tag 对应的完整多层次更新说明注入 `release_notes.md`，使 GitHub Release Notes 完整承载工业级专业技术详述，告别仅有单行 Commit 的简陋发布。
  - **流水线 Release Notes 纯净交付 (`.github/workflows/build.yml`)**：移除 `action-gh-release` 冗余的 `generate_release_notes: true` 参数，防止 GitHub 自动生成的简短 commit 列表污染和冲淡经过严格编写的 Release 正文。
  - **发版规范长效可复用沉淀 (`AGENTS.md`)**：全面重构 6.3 节发版规范，以正面、直接的行动指南清晰列出发版涉及的核心文件与多层次结构化格式要求，便于 Agent 与维护者长期严格复用。

- **[前沿模型矩阵配置接入与官方文档体系重塑] 接入 Grok 4.7、Claude Opus 4.7 与 MiMo 2.6，重构中英 README 突出差异化优势**：
  - **前沿模型矩阵配置**：开箱即用支持包括 Grok 4.7、Claude Opus 4.7 与 MiMo 2.6 在内的全新一代前沿模型；
  - **文档结构优化**：精炼中英文 README，置顶快速上手指南与多平台一键安装命令，深度突出高并发进站流水线、词林双语检索及 Neutral Agent 纯净执行循环等核心架构优势；同步升级动态 GitHub Release 徽章。

## v7.1.39 (2026-09-30)

- WebUI 布局与模型控件重构：将模型选择控件从底部输入框完整移出并优雅集成到顶部标题栏右上角（刷新、主题、语言切换按钮右侧），彻底根除输入框底部空间拥挤导致的发送按钮被挤出边界、变形与截断的问题。
- 顶栏控件层级与防穿透优化：右上角操作栏严格垂直居中对齐在 40px 高度的顶栏内，下边缘保留 6px 安全呼吸间隙，彻底杜绝圆按钮或模型胶囊下沿穿透或压在下方 Git 面板及小三角形折叠指示器上的视觉缺陷。
- 现代化模型胶囊与级联下拉重塑：模型触发器升级为现代高质感微胶囊，新增微型模型图标与渠道微标，支持超长别名自适应优雅截断；下拉级联菜单改为顺应顶部直觉的向下平滑展开（向下弹出），采用完全不透明深色高质感背景配合细腻高斯模糊与深度柔和阴影，层级提升至最高，彻底防止文字半透明重叠穿透。

## v7.1.38 (2026-09-30)

- WebUI 布局与交互优化：右上角快捷工具栏（检测更新、主题、语言切换）新增右侧检视面板（提问记录 / Git面板）展开与折叠状态联动，支持平滑自适应避让，彻底解决穿透遮盖 Git 面板与“本轮提问”标题和折叠按钮的问题。
- 输入框响应式体验重构：移除桌面端在窗口缩略或分屏时不合理的强制两行堆叠，模型选择器自适应弹性收缩截断，输入工具（+号附件、同步、模式、模型）与发送操作自然舒展于单行流，彻底消除把+号和同步按钮强行堆叠到上一行的不美观视觉。
- 项目会话列表即时同步：多项目手风琴展开列表全面贯穿乐观会话并自动展开所属项目文件夹，新会话发送瞬间立即可见；首轮对话完成落盘后联动刷新项目会话缓存，无需手动按 F5 刷新网页即可无缝更新。
- 流式传输防丢与实时渲染：分离前台活跃流请求标识与脱机停止别名，免疫后台异步检测对请求 ID 的改写，移除发消息后 200ms 不必要的竞态列表刷新并增加 Sync 模式连通性自愈，彻底修复发消息后界面卡死在呼吸闪烁、手动刷新后才看到 Agent 输出了多条消息的问题。


- WebUI：彻底修复侧边栏残留的 `viewProjectHash` 引用异常，消除组件挂载抛出 `ReferenceError` 导致的黑屏崩溃；修复折叠导轨新建会话与转向消息图片类型定义。
- 桌面端：修复启动时将 `tauri.localhost` 虚拟协议误识别为外链并弹窗外部浏览器导致 ERR_CONNECTION_REFUSED 的问题，本地协议安全放行，禁止外部拉起内部虚拟域名。
- 图标与快捷方式：使用官方网页版高清透明 Logo 重新生成全套桌面与安装包图标，补充 128x128 等关键尺寸；新增 NSIS 安装后钩子，在安装与更新时显式绑定快捷方式图标并强制广播刷新 Windows 图标缓存，消除桌面绿色方块残留。

## v7.1.36 (2026-09-30)

- WebUI：右上角快捷工具栏新增检测更新按钮，支持自动静默检测与手动点击检测；检测到新版本后动态点亮醒目的绿色向上箭头图标，并弹出版本升级确认与下载对话框。
- 桌面端：在 WebUI 中确认升级后自动下载对应操作系统的 Setup 安装包并展示下载进度百分比，下载完成后优雅退出当前进程并自动拉起安装包重新安装。
- 安装与配置同步：修复保留已有配置或重新安装时无法触发更新配置覆盖的问题，`install.sh` / `install.ps1` 脚本在检测到已有配置时自动触发可选配置覆盖；升级后首次启动桌面端或 WebUI 时，自动弹出与 CLI 相同规则的多选覆盖弹窗（自动保护用户自定义模型/账号及 MCP/Skills），支持一键确认覆盖。

## v7.1.35 (2026-09-30)

- WebUI：左侧边栏重构为 Codex 风格多项目收纳列表，支持多项目收纳折叠、会话归类、展开更多及项目内快捷新建；添加项目支持调起系统原生文件资源管理器通用对话框，可直接配合 Everything 快速搜寻。
- 界面布局：左上角新建会话默认在用户家目录（`~`）创建全局会话，并彻底移除旧的左上角下拉框；输入框移除底部冗余目录行与快捷键提示并贴底，释放最大化垂直空间；右上角新增圆形主题（亮色/暗色/跟随系统）与语言（简/EN）快速切换，左下角直出独立模型配置。
- 桌面端：外部链接与弹窗统一拦截并调用系统原生默认浏览器正常多标签打开（绝非无痕模式），彻底防止当前 JeikCode WebUI 界面被网页覆盖。
- 转向功能（Steer）：重构转向机制，队列消息在单步安全边界完成后即刻转换为真实用户消息并流式开启新回复，避免一直挂在排队框；支持纯文本模型剥离丢弃图片载荷与多模态模型原样载荷传递，文本结构化包裹 `<user-query>` 与轻量原则指导。
- 工具协议：移除 `run_command` 的 `task_progress` 参数，`summary` 明确根据用户提问语言输出，防止模型固定输出英文。

- 桌面端：彻底消除 Windows 启动时附带常驻的 cmd 黑色控制台窗口（子系统配置为 Windows GUI）。
- 图标：使用官方正版 JeikCode 高清 Logo 重新生成全套桌面图标，桌面快捷方式、窗口与任务栏不再显示纯色块。
- WebUI：修复输入框底部控制栏在非全屏、分屏或窄窗口时的文字挤压与重叠问题（引入容器响应式双行自适应排版与溢出保护）。

## v7.1.33 (2026-09-29)

- WebUI：时间只出现在用户发出消息时和本轮最后一条助手回复上，并保留整轮「用时」。中间的思考、工具调用、分段正文不再打时刻。

## v7.1.32 (2026-09-29)

- Linux ARM64 安装包按 16K 页对齐，树莓派 5 这类 16K 页的盒子可以运行，4K 页的机器也不受影响。
- 桌面端：Windows 为 exe 安装包，macOS 为 dmg，Linux 为 deb / AppImage（x64 另有 rpm）。窗口打开本机 WebUI，并把同一个 `jeikcode` 放到 `~/.local/bin`。

## v7.1.31 (2026-09-29)

- WebUI：停止时把排队内容还回输入框；一次粘贴多张图会全部保留；排队消息可在下一步软转向。切走后，已完成的会话不再一直转圈，未完成清单不再挤进最新消息。
- 更新：SHA256 清单改为随 GitHub Release 上传，不再为发版往 `main` 追加提交。新版本从 `releases/latest/download/latest.json` 检查更新。
