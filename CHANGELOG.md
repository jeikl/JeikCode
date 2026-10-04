# Changelog

<!-- 发版前在此追加 `## vX.Y.Z (YYYY-MM-DD)`。流水线不会改这个文件。 -->

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
