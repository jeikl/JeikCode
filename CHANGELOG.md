# Changelog

<!-- 发版前在此追加 `## vX.Y.Z (YYYY-MM-DD)`。流水线不会改这个文件。 -->

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
