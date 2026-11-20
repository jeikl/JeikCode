# JeikCode WebUI 卡顿与稳定性根因报告（核验修正与完整修复清单版）

- 初始观测日期：2026-11-16（实测版本 `v7.5.1-beta.1`）
- 代码核验日期：2026-11-16（对照工作区 `beta` 分支 `v7.5.1-beta.3` 源码与用户补充截图交叉核验）
- 网络拓扑：`10.126.126.6` 为 VPN 服务器；`192.168.5.50:4098` 与 `192.168.5.100` 位于其后的内网，本机不可直达；`10.126.126.5:4098` 为该生产服务器的 VPN/远程地址，可直接 SSH
- 观测方式：诊断浏览器直连 `10.126.126.5:4098`；`5.x` 侧数据通过 SSH 进入 `10.126.126.5` 后从服务器侧执行 `ss`、`curl`、`ping`，结合用户 5 标签页截图、模型配置弹窗卡死截图及当前仓库源码逐行核对
- 客户端：用户浏览器 `192.168.5.100`（VPN 后内网）；诊断浏览器 `10.126.126.7`（仅直连 `10.126.126.5`）
- 关联 Issue：[#88](https://github.com/jeikl/JeikCode/issues/88)、[#89](https://github.com/jeikl/JeikCode/issues/89)
- 结论性质：只读诊断、报告核验修正与完整修复清单设计，未修改业务代码；**按当前决策，P2/P3（`#89` 状态机与诊断）暂缓**

---

## 1. 问题描述与新增现场现象

### 1.1 用户主诉与已有现场

- 只开了 3 个左右会话，但打开一个会话非常卡顿；
- 刷新页面一直转圈，经常停在“正在加载更早的消息…”；
- 使用 `192.168.5.100` 访问 `192.168.5.50:4098` 几乎完全动不了（两者均位于 `10.126.126.6` VPN 后的内网）；
- 但访问 `10.126.126.5:4098` 打开、刷新都很快；
- 浏览器现场同时打开了 5 个 JeikCode 标签页；
- 服务器侧有 6 个终端。

### 1.2 用户补充现场（模型配置弹窗链路卡死）

- 在页面卡顿时点击模型选择窗右上角的「模型配置」按钮，**「模型」弹窗直接立刻消失**；
- 界面长时间无反馈后，**过了很久才弹出「系统设置（模型与配置）」窗口**；
- 弹出后右侧主面板**只显示「加载中…」**，无法展示或编辑模型配置；
- 同时从该截图右上角可见：即便处于「新建对话」落地页且右侧检查器停在「本轮提问」，顶部检查器图标仍挂着 **`6` 个终端徽标、`2` 个 Git 徽标、`2` 个预览徽标**。

### 1.3 关联 Issue 与交集判定

- **[#88](https://github.com/jeikl/JeikCode/issues/88)**：Linux 进程扫描没有过滤当前线程组 TGID，迁移弹窗把 WebUI 自己的工作线程误判为“旧版遗留进程”；点击“立即执行”后 kill 自己的线程，WebUI 进程退出，前端一直卡死。
- **[#89](https://github.com/jeikl/JeikCode/issues/89)**：偶发倒灌、丢回复；多任务并发弹窗/转向时 steer 窜会话；多长任务时 ESC 乱套与不响应。

| Issue | 交集点 | 是否同一根因 | 处理建议 |
|---|---|---|---|
| [#88](https://github.com/jeikl/JeikCode/issues/88) | 迁移自毁导致 daemon 中途死亡/重启；刷新或重连后可能触发 `/chat/watch` 回放，看似“思考重复” | 否。根因是 TGID 误判 + kill 自己 | 独立 P0 修复（含前端失败展示与超时/关闭补齐） |
| [#89](https://github.com/jeikl/JeikCode/issues/89) | “不响应”与连接池、主线程/Tokio 阻塞有交集；长任务增加 `/chat/watch` 渲染压力 | 否。倒灌/steer 串会话/stop 路由属状态机问题 | **暂缓（P2/P3）**；待 P0/P1 连接、阻塞与渲染止血后再专项定位 |

---

## 2. 观测对象与对照实测（`v7.5.1-beta.1` 现场）

### 2.1 网络拓扑与生产服务器状态

- `10.126.126.5:4098` 与 `192.168.5.50:4098` 为同一台服务器上的同一个 `jeikcode-4098.service`（systemd 管理），仅监听地址不同；
- 进程 RSS 约 `1.4 GB`（cgroup 约 `2.0 GiB`，峰值 `2.1 GiB`），线程数 `28`，运行时间约 1 天 7 小时；
- 服务端 `/chat/active`：`2` 个运行中会话；`/runtime/sessions`：`2` 个 `running`；`/terminal/list`：`6` 个终端（用户体感 3 个运行会话与实际 2 个的差异不影响本次瓶颈结论）。

### 2.2 实测对照数据

#### 正常项（证明非硬件与单次基础链路瓶颈）

| 项目 | 实测 | 结论 |
|---|---|---|
| 服务器负载 / CPU / 内存 / 磁盘 | `0.37 / 0.26 / 0.24`，93% idle，10 GiB 可用，`VmSwap: 0`，磁盘 52% | 非硬件资源瓶颈 |
| LAN / VPN 健康检查 & 链路 | `/health`、`192.168.5.50/health`、`10.126.126.5/health` 均 `1 ms`；`ping` 0% 丢包（`0.38 ms`）；`ListenOverflows/Drops = 0` | 网络与监听队列正常 |
| 单次空闲 curl 接口 | `/chat/active` `1 ms`；`/projects/sidebar` `1 ms`；`/sessions` `25~44 ms`（`14 KB`）；项目会话列表 `30 ms`（`90 KB`）；`?tail=48` `22 ms`（`212 KB`）；`/chat/pending` `13 ms`；`/api/system/legacy-status` `17 ms` | 空载单次响应很快 |

#### 异常项（实测现象 + 源码复核补充数据）

| 异常 | 实测与代码复核 | 影响 |
|---|---|---|
| `5.100 -> 4098` TCP established 连接 | `30` 条 | 多标签 SSE + 全挂终端 WS 叠加 |
| 每标签页隐藏 xterm | `6` 个（尺寸 0×0，截图落地页右上角亦显示 `6`） | 面板折叠/切换仍全量初始化并连 WS |
| 单次页面冷启动请求数 | `77~101` 个 | 启动请求风暴 + 多模块各自重复拉取 |
| 重复接口并发 | `/chat/active`、`resolve`、`/chat/pending`、`/git/branches`、`/git/status` 各 `7` 次；`/projects/sidebar` `5` 次；`/sessions`、`/models` 各 `4` 次 | 缺单飞去重 + 隐藏面板预挂 + 回调/依赖抖动重触发 |
| `/api/update/check` | 耗时 `3.0 s / 4.7 s / 13.8 s`，体积 `804,381` 字节，`107` 个版本（单条 notes 最大约 `14.6 KB`） | 无缓存直拉外部源与全量历史（注：`beta.3` 已加 `update_dead`/离线熔断，未开启时仍触发） |
| 大会话加载与翻页 | `336` 条消息；`tail=48` 返回 `94` 条 / `212 KB`；`before_seq=0.953` 报 400；`offset=0` 返回 `171` 条 / `421 KB` | 向 user turn 起点回溯放大首屏 + 小数游标 400 卡死 |
| 主线程与前端产物体积 | LCP `1,120 ms`（render delay `1,097 ms`）；布局 `233 ms`；强制回流 `243 ms`；主包 `index-*.js` `2.17 MB`、CSS `400 KB` | 主线程渲染阻塞 + 首屏同步加载全部语种和 xterm |
| 401 与 `#88` | `/token=` 401 后 `Er.filter is not a function`；`#88` 误杀同 TGID 线程导致进程自杀 | 认证异常直接白屏/崩组件；迁移点击即自杀且失败无提示 |

---

## 3. 原报告属实性核验与事实修正

经逐行核对仓库当前源码，原报告 **核心诊断（P0-1 ~ P0-6）全部属实**，但需做出 **4 项重要修正与版本校准**：

### 3.1 修正一：catalog 并非“无缓存每次全量读盘”，真问题在重复校验、绕路全扫与未隔离阻塞

- **原报告表述（8.5 / P1-2）**：“catalog 每次全量扫描，应按 mtime/revision 缓存”。
- **源码实情**：[`crates/jeikcode-capabilities/src/session/manager.rs`](file:///e:/code/jeikcode/crates/jeikcode-capabilities/src/session/manager.rs#L3571-L3620) **已经实现了 `scan_catalog_cached` / `catalog_cache()`**，通过 `catalog_signature()` 遍历目录树对 `(bucket, filename, mtime, len)` 做摘要，指纹未变即复用内存 `CatalogScan`，跳过 `.meta` 的打开与 JSON 解析。
- **真正漏掉的问题**（见第 4 节）：
  1. `list_projects`、`list_sessions`、`list_all_sessions` 每个接口内部各执行了 **2 次** `catalog_scan_in_root`（每次重算整棵目录树 `metadata()` 指纹）；
  2. `load_catalog_session_view_in_project_root`（服务 `GET /projects/:hash/sessions/:id`）明明已拿到精确的 `project_bucket` 和 `id`，第一行仍调用全盘 `SessionManager::scan_catalog`；
  3. `get_session_detail` 与 `resolve_session` 直接在 Tokio async worker 上同步 IO，未放入 `spawn_blocking`。

### 3.2 修正二：禁止恢复 `.timeline-message` 的 `content-visibility: auto`

- **原报告建议（8.5）**：“非激活面板/消息 `content-visibility` / 懒渲染”。
- **源码实情**：[`webui/src/styles/app.css`](file:///e:/code/jeikcode/webui/src/styles/app.css#L3889-L3917) 与 [`webui/src/components/chat/AssistantMessageView.tsx`](file:///e:/code/jeikcode/webui/src/components/chat/AssistantMessageView.tsx#L103-L108) 中留有明确回退注释：**此前已对 `.timeline-message` 加过 `content-visibility: auto`，但会导致 Chromium 在代码块闭合、表格出现等高度剧烈变化时把元素误判为离屏并跳过绘制（「代码框闭合瞬间消失，stop 后才跳出来」），现已显式回退**。
- **修正方向**：列表与流式渲染不能直接回加 `content-visibility: auto`；应改为摘除每秒顶层重渲染、优化 `Markdown` 管线与局部化重绘（见第 4 节与第 5 节）。

### 3.3 修正三：`tail` ETag 禁用原因校准

- **原报告表述（8.5）**：“`tail` 禁用 ETag，应增加 revision ETag”。
- **源码实情**：后端 [`session_detail_response`](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs#L8045-L8084) **已经**对包括 `tail` 在内的所有 `SessionDetail` 按完整序列化字节 `serde_json::to_vec(&detail)` 计算 `response_etag(&body)` 并处理 `If-None-Match` -> `304`。真正跳过缓存在**前端** [`webui/src/api.ts`](file:///e:/code/jeikcode/webui/src/api.ts#L2588)（`const cacheable = opts?.tail == null && opts?.afterSeq == null && opts?.turnsOnly !== true`）。启用 `tail` 条件缓存主要需解除前端限制并确保 `sessionDetailEtagCache` 按完整 `requestPath`（含 `?tail=...`）区分缓存键；若要连后端序列化开销也省掉，则另需在反序列化前做轻量 version 校验。

### 3.4 修正四：版本演进差异与 `#88` 前端缺陷补全

- `v7.5.1-beta.1 -> v7.5.1-beta.3` 期间，[`api_update.rs`](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/api_update.rs#L415-L428) 与 [`app.tsx`](file:///e:/code/jeikcode/webui/src/app.tsx#L882) 已加入 `update_dead` / 离线模式短路，但普通默认配置不会触发该短路，因此线上 3~14 秒大响应阻塞依然成立。
- `#88` 的前端弹窗 [`LegacyMigrationModal.tsx`](file:///e:/code/jeikcode/webui/src/components/LegacyMigrationModal.tsx#L52-L56)、[#L126-L128](file:///e:/code/jeikcode/webui/src/components/LegacyMigrationModal.tsx#L126-L128) 除了无超时和无关闭按钮外，在 `catch` 分支写入 `setResultMsg(...)` 时 `done` 仍为 `false`，而 JSX 写死 `{done ? resultMsg : t('migration.desc')}`，导致接口报错时连错误文案都不会渲染。

---

## 4. 关键根因全图（原报告已验证项 + 本次核验补全的遗漏项）

### 4.1 已验证主链（原报告 P0/P1）

1. **连接池耗尽**：[app.tsx](file:///e:/code/jeikcode/webui/src/app.tsx#L159) 启动全局 `/events`，[Chat.tsx](file:///e:/code/jeikcode/webui/src/components/Chat.tsx#L2959-L2960) 与 [#L3602-L3636](file:///e:/code/jeikcode/webui/src/components/Chat.tsx#L3602-L3636) 在活跃或空闲时都开启 `/chat/watch`。HTTP/1.1 同 origin 上限 6 条，3 标签即满，5 标签占 10 条长连接，`update/check`（[api_update.rs](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/api_update.rs#L444-L454)）以 804 KB / 3~14s 抢槽加剧雪崩。
2. **隐藏终端常驻全连**：[RightInspectorPanel.tsx](file:///e:/code/jeikcode/webui/src/components/RightInspectorPanel.tsx#L280-L284)、[#L382-L400](file:///e:/code/jeikcode/webui/src/components/RightInspectorPanel.tsx#L382-L400) 与 [TerminalPanel.tsx](file:///e:/code/jeikcode/webui/src/components/TerminalPanel.tsx#L966-L1039)、[#L1180-L1239](file:///e:/code/jeikcode/webui/src/components/TerminalPanel.tsx#L1180-L1239) 使 5 个标签页 × 6 个终端建立约 30 条 `/terminal/ws` 与 30 个 xterm 实例，且允许关闭全部无效（立即重建 1 个）。
3. **「加载更早」小数游标 400**：[lib.rs](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs#L367)、[#L8458](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs#L8458)、[#L9209-L9215](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs#L9209-L9215)、[#L9309](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs#L9309) 与 [merge_catalog_session_messages_for_display](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs#L9667-L9710) 允许返回前置 `seq: None` 行；前端 [canvasStore.ts](file:///e:/code/jeikcode/webui/src/lib/canvas/canvasStore.ts#L157-L166) 将无 `seq` 头部插值为小数（如 `0.953`），[Chat.tsx](file:///e:/code/jeikcode/webui/src/components/Chat.tsx#L7846-L7849)、[#L7926-L7930](file:///e:/code/jeikcode/webui/src/components/Chat.tsx#L7926-L7930) 将其传给 `before_seq: Option<u64>` 触发 400 并吞错保留按钮。
4. **`#88` 迁移自毁**：[api_config.rs](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/api_config.rs#L1391-L1502) 在 Linux `sysinfo 0.33.1` 枚举 `/proc/<PID>/task/<TID>` 时只过滤 `my_pid` 而未过滤同 TGID / 同 exe，点击迁移直接 `kill` 同组线程致进程死亡。
5. **路由 token 与错误 JSON 未校验**：[lib.rs](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs#L22193-L22194) 与 [api.ts](file:///e:/code/jeikcode/webui/src/api.ts#L51-L57) 不处理 `/token=`；[api.ts](file:///e:/code/jeikcode/webui/src/api.ts#L1499-L1502) 等处未校验 `resp.ok` 与返回值类型导致 [Sidebar.tsx](file:///e:/code/jeikcode/webui/src/components/Sidebar.tsx#L2331)、[#L2341](file:///e:/code/jeikcode/webui/src/components/Sidebar.tsx#L2341) 对错误对象调用 `.filter` 崩溃。

### 4.2 新增根因链：点「模型配置」弹窗消失 → 久等弹出 → 停在「加载中…」

```text
用户点击 ModelSelector 右上角「模型配置」
  -> ModelSelector.tsx:742 立刻调用 setOpen(false)，选模型浮层当场消失
  -> app.tsx:1986-1990 渲染 <LazyBoundary><SystemSettingsDialog .../></LazyBoundary>
  -> app.tsx:35,40-42 中 SystemSettingsDialog 为 lazy() 且 LazyBoundary 是 <Suspense fallback={null}>
  -> HTTP/1.1 6 连接池被塞满期间，SystemSettingsDialog-*.js (5.4KB) + SettingsDialogs-*.js (24KB) 排队阻塞
  -> fallback={null} 没有任何弹窗骨架反馈 -> 界面空白久等后才突然弹出「系统设置」窗体
  -> 弹出后 SystemSettingsDialog.tsx:41-70 并发请求 getDesktopSettings() + getHealth()
  -> ModelConfigView (SettingsDialogs.tsx:377-392,489-490) 初始 config=null 并发起无缓存、无超时的 GET /config (apiFetch 无 timeout)
  -> 请求在连接池或阻塞的 daemon 队列中挂起 -> 页面死停在「加载中…」
```

### 4.3 原报告漏掉的前端根因

1. **右侧检查器不止预挂终端，还无条件预挂 `<GitPanel>`**
   - [RightInspectorPanel.tsx](file:///e:/code/jeikcode/webui/src/components/RightInspectorPanel.tsx#L350-L377) 中 `<GitPanel>` 在面板折叠或停留在其他 tab 时也始终挂载；
   - [GitPanel.tsx](file:///e:/code/jeikcode/webui/src/components/GitPanel.tsx#L617-L653) 挂载即调度全套 Git 刷新（解释报告中冷启动 `/git/branches`、`/git/status` 各 7 次的来源），并挂起全局 `focus`/`visibilitychange` 与 `180s` `triggerAutoFetch`；
   - [Chat.tsx](file:///e:/code/jeikcode/webui/src/components/Chat.tsx#L13555)（`landing`）与 [#L14049](file:///e:/code/jeikcode/webui/src/components/Chat.tsx#L14049)（会话）各自渲染 `<RightInspector>`，导致连新会话落地页都触发上述隐藏面板加载。
2. **重复请求风暴的明确代码诱因**
   - **`/models` 重复**：[ModelSelector.tsx](file:///e:/code/jeikcode/webui/src/components/ModelSelector.tsx#L215-L243) 依赖 `[onDefaultChange]`，而传入它的 [`followDefaultProvider`](file:///e:/code/jeikcode/webui/src/components/Chat.tsx#L2013-L2026) 依赖 `[activeSession]`（会话元信息加载变化就会重拉），叠加 [Chat.tsx](file:///e:/code/jeikcode/webui/src/components/Chat.tsx#L2028-L2046) 的 `useEffect([provider])` 与弹窗展开时的静默拉取（[ModelSelector.tsx](file:///e:/code/jeikcode/webui/src/components/ModelSelector.tsx#L246-L255)）。
   - **侧栏四联级联重拉 + 组件各自发请求**：[Sidebar.tsx](file:///e:/code/jeikcode/webui/src/components/Sidebar.tsx#L759-L817) 的主 `useEffect` 依赖 `[reloadKey, refreshProjectSessions, loadSidebar]`，因 `refreshProjectSessions` 依赖 `[projectHash, expandedProjects]`，每次切换项目、确定 `projectHash` 或展开/折叠项目都会重跑整套 `loadSessions(true)` + `refreshProjectSessions()` + `loadSidebar()` + `getActiveChatSessions()`；外加 [NotificationDock.tsx](file:///e:/code/jeikcode/webui/src/components/NotificationDock.tsx#L390-L441) 冷启动各自请求 `listSessions`、`getRuntimeSessions`、`getActiveChatSessions` 及 [app.tsx](file:///e:/code/jeikcode/webui/src/app.tsx#L415-L440) 的 `12s`/`15s` 轮询。
   - **除 `listSessions` 外仍有未校状态码接口**：[api.ts](file:///e:/code/jeikcode/webui/src/api.ts#L2031-L2105) 中 `getProject()`、`getSkills()`、`getCommands()`、`postLiveMcpTrust()` 同样缺少 `!resp.ok` 与返回结构校验。
3. **主线程卡顿与首屏包体积膨胀**
   - **1 秒全局重渲染**：[Chat.tsx](file:///e:/code/jeikcode/webui/src/components/Chat.tsx#L951-L956) 在 `busy && turnStartedAt != null` 时每秒 `setNowMs(Date.now())`，使超大规模 `Chat` 组件每秒整树重渲染并重跑 [Chat.tsx](file:///e:/code/jeikcode/webui/src/components/Chat.tsx#L13721-L13790) 的 `O(N)` 文本聚合（且 [UserMessageView.tsx](file:///e:/code/jeikcode/webui/src/components/chat/UserMessageView.tsx#L27) 未做 `memo`）；
   - **`Markdown` 无条件 `DOMParser` 与流式整块 `innerHTML`**：[Markdown.tsx](file:///e:/code/jeikcode/webui/src/components/Markdown.tsx#L129-L143) 对每段 Markdown 即使没有任何 `<img>` 也强行执行 `new DOMParser().parseFromString(...)`；流式快路径（[#L228-L238](file:///e:/code/jeikcode/webui/src/components/Markdown.tsx#L228-L238)）要求 `prev[prev.length - 1] !== '>'`，面对 `marked` 的闭合标签输出极易退回整段 `root.innerHTML = next` + `enhanceMarkdownTables()`；
   - **首屏主包过大与拆包倒置**：[`webui/dist/assets`](file:///e:/code/jeikcode/webui/dist/assets) 主 JS `2.17 MB`、主 CSS `400 KB`——因为 [i18n.ts](file:///e:/code/jeikcode/webui/src/i18n.ts#L9-L17) 静态导入全部 10 份外语字典，[TerminalPanel.tsx](file:///e:/code/jeikcode/webui/src/components/TerminalPanel.tsx#L2-L5) 静态打入 `@xterm/xterm` 全套插件，[main.tsx](file:///e:/code/jeikcode/webui/src/main.tsx#L9-L14) 同步打入 `@fontsource/source-serif-4` 与 `katex.min.css`。

### 4.4 原报告漏掉的后端根因

1. **大量重 IO / 子进程调用直接运行在 Tokio async worker 线程上（缺少 `spawn_blocking`）**
   - **`api_git.rs` 几乎全线同步等待子进程**：除 [#L1913](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/api_git.rs#L1913) 的 `git fetch` 外，[`get_git_repos`](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/api_git.rs#L437)、[`get_git_branches`](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/api_git.rs#L579)、[`get_git_graph`](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/api_git.rs#L766)、[`get_git_status`](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/api_git.rs#L1309) 等数十处 `git_cmd(...)` 全在 async handler 里同步 `.output()`；
   - **`api_config.rs` 全机进程枚举同步运行**：[`get_legacy_status`](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/api_config.rs#L1548-L1561) 与 [`post_migrate_legacy`](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/api_config.rs#L1563-L1606) 同步调用 `scan_zombie_processes()` / `kill_zombie_processes_all()` 读取全机 `/proc`；
   - **`resolve_session` 与 `get_session_detail` 同步读盘**：[`resolve_session`](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs#L7900-L7909) 与 [`get_session_detail`](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs#L8168-L8175) 未像旁边的 [`get_sessions_by_working_dir`](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs#L7937) 一样通过 `run_session_catalog_io` 进入 `spawn_blocking`。
2. **Catalog 单请求双倍扫盘、已知桶+ID 仍扫全局**
   - [`list_projects`](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs#L7215-L7226)、[`list_sessions`](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs#L7468-L7483)、[`list_all_sessions`](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs#L7500-L7510) 在一次请求内调用 **2 次** `catalog_scan_in_root`，重复计算两遍全目录 `catalog_signature()`；
   - [`load_catalog_session_view_in_project_root`](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/legacy_convert.rs#L1230-L1254) 已携带精确 `(project_bucket, id)`，却仍先执行整库 `SessionManager::scan_catalog(sessions_root)`。

---

## 5. 完整修复清单（按优先级排序；P2/P3 按要求暂缓）

> 排序原则：**P0 先止血（防自杀、打通 HTTP/1.1 阻塞与 WS/弹窗黑洞、修功能性 400/崩溃）→ P1 再深度瘦身与解阻塞（请求风暴、后端 async 隔离、主线程渲染与首屏体积）→ P2/P3 暂缓**。

### 【P0 阶段】立即止血（解决自杀、卡死、白屏、弹窗无响应、翻页 400）

#### P0-1：`#88` 迁移扫描防自杀 + 前端弹窗容错补齐
- **涉及位置**：
  - [api_config.rs](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/api_config.rs#L1391-L1502)、[#L1548-L1606](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/api_config.rs#L1548-L1606)
  - [LegacyMigrationModal.tsx](file:///e:/code/jeikcode/webui/src/components/LegacyMigrationModal.tsx#L36-L57)、[#L123-L209](file:///e:/code/jeikcode/webui/src/components/LegacyMigrationModal.tsx#L123-L209)
- **修改内容**：
  1. 扫描过滤：在 Linux 借助 `sysinfo` 的 `thread_kind()` / `Process::tasks` 或比较当前进程的 TGID（同进程 `pid`、同 `current_exe()` 规范化路径、所有属于当前 `my_pid` 的子线程 `TID`）一律跳过，禁止纳入 zombie 列表；
  2. `kill_zombie_processes_all` 执行 `proc_.kill()` 前加硬断言守卫：绝不向当前 `my_pid`、当前 TGID 下的任何线程、当前运行中的 `current_exe` 发信号；
  3. 仅对确实运行在外置旧路径（如 `.local/bin` 且 exe 非自身）的**主进程**执行终止，先异步返回或由 `spawn_blocking` 执行扫描与清理，不阻塞响应；
  4. 前端弹窗补齐：分离 `error` 状态（不再受 `done === true` 门控）、请求加超时控制、增加「关闭/跳过/重试」按钮，且 `get_legacy_status` 失败或超时不锁死界面。
- **验收**：Linux 多线程环境下触发 `/api/system/legacy-status` 与 `/api/system/migrate-legacy`，当前 daemon 存活、不自杀；接口超时或报错时弹窗可关闭、能看见错误提示。

#### P0-2：右侧检查器（Terminal + Git + Preview）真懒挂载 + 终端允许彻底关闭
- **涉及位置**：
  - [RightInspectorPanel.tsx](file:///e:/code/jeikcode/webui/src/components/RightInspectorPanel.tsx#L280-L418)
  - [TerminalPanel.tsx](file:///e:/code/jeikcode/webui/src/components/TerminalPanel.tsx#L704-L812)、[#L955-L1039](file:///e:/code/jeikcode/webui/src/components/TerminalPanel.tsx#L955-L1039)、[#L1180-L1239](file:///e:/code/jeikcode/webui/src/components/TerminalPanel.tsx#L1180-L1239)、[#L1414](file:///e:/code/jeikcode/webui/src/components/TerminalPanel.tsx#L1414)
  - [GitPanel.tsx](file:///e:/code/jeikcode/webui/src/components/GitPanel.tsx#L617-L653)
- **修改内容**：
  1. `RightInspector` 在 `collapsed === true` 且未激活过对应 tab 时，**不挂载** `TerminalPanel` 与 `GitPanel`（角标计数改由轻量状态或后端全局事件增量维护，不依赖重组件实例常驻）；
  2. `TerminalPanel` 内部对非当前激活 tab 延迟实例化 `new Terminal` 与 `/terminal/ws`（只对用户实际打开看过的活跃终端建 WS 与 fit）；
  3. 解除「至少保留 1 个终端」限制：允许 `tabs = []`，关闭最后一个终端不再报错拦截，`closeAllTabs` 真正 `dispose` + 关闭 WS + 清空列表而不自动新建；刷新与切目录保持空列表状态不自动复活 6 个隐藏终端。
- **验收**：新建会话或折叠右侧栏打开 5 个标签页时，页面初始终端 WS 为 `0`（仅当用户点开终端 tab 才出现最多 1 条激活 WS）；点「关闭所有终端」后徽标与后端列表归零。

#### P0-3：模型配置弹窗链路与全局 `apiFetch` 超时/反馈修复（解决补充截图问题）
- **涉及位置**：
  - [ModelSelector.tsx](file:///e:/code/jeikcode/webui/src/components/ModelSelector.tsx#L734-L754)
  - [app.tsx](file:///e:/code/jeikcode/webui/src/app.tsx#L35-L42)、[#L1986-L1995](file:///e:/code/jeikcode/webui/src/app.tsx#L1986-L1995)
  - [SystemSettingsDialog.tsx](file:///e:/code/jeikcode/webui/src/components/SystemSettingsDialog.tsx#L23-L70)
  - [SettingsDialogs.tsx](file:///e:/code/jeikcode/webui/src/components/SettingsDialogs.tsx#L359-L392)、[#L489-L490](file:///e:/code/jeikcode/webui/src/components/SettingsDialogs.tsx#L489-L490)
  - [api.ts](file:///e:/code/jeikcode/webui/src/api.ts#L401-L431)、[#L1753-L1756](file:///e:/code/jeikcode/webui/src/api.ts#L1753-L1756)
- **修改内容**：
  1. 取消 `SystemSettingsDialog` 的 `fallback={null}` 盲等：要么将其（或轻量模态外壳 + 骨架）随主包同步加载（仅 ~5.4 KB），要么将 `LazyBoundary` 的 `fallback` 改为立即弹出带关闭按钮的「正在打开设置…」模态框架，杜绝原窗秒关后的漫长真空期；
  2. 点击「模型配置」时等待设置窗口激活或平滑替换，同时 `ModelConfigView` 先用**内存 SWR 缓存**或 `ModelSelector` 已有模型摘要先渲染可见结构，后台刷全量 `/config`；
  3. 为普通 JSON 接口的 `apiFetch`（可按长连接流 `watch`/`events` 豁免）增加默认请求超时（如 `10~15s` `AbortController`）与加载失败「重试 / 关闭」交互，`SystemSettingsDialog` 不在 `models` 页签打开时强抢 `getDesktopSettings` + `getHealth`（按页签或共用已知版本）。
- **验收**：弱网或并发忙时点「模型配置」立即看到配置弹窗骨架及缓存/状态，请求超时时明确给出错误与重试按钮，不再永久白关或死卡「加载中…」。

#### P0-4：连接模型收敛——消除 HTTP/1.1 6 连接池被多标签 SSE 挤死
- **涉及位置**：
  - [app.tsx](file:///e:/code/jeikcode/webui/src/app.tsx#L159)、[globalEvents.ts](file:///e:/code/jeikcode/webui/src/lib/globalEvents.ts#L72-L99)
  - [Chat.tsx](file:///e:/code/jeikcode/webui/src/components/Chat.tsx#L2954-L2960)、[#L3602-L3636](file:///e:/code/jeikcode/webui/src/components/Chat.tsx#L3602-L3636)
  - [crates/jeikcode-daemon/src/lib.rs](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs)（路由与实时流端点）
- **修改内容**（推荐分两步，可立即上过渡方案再上 WS 多路复用）：
  1. **最终/高收益方案（WebSocket 多路复用 `/stream/ws`）**：由后端提供单条 WS 复用通道同时承载原 `/events` 全局事件 + 当前关注的会话事件（客户端通过 `watch`/`unwatch` 消息切换会话）；WS 握手完成后**完全不占用浏览器 HTTP/1.1 的 6 个短连接槽**；
  2. **兼容过渡方案（Leader 标签页 + 可见性休眠）**：通过 `BroadcastChannel` / `SharedWorker`（Safari/旧 WebView 退化到 `localStorage` 选主）保证同一浏览器只保持 **1 条** `/events` 广播到各 tab；非活跃且 `document.hidden` 的后台标签页释放空闲 `/chat/watch` 待机连接，回到前台聚焦时按 `after_seq` / `freshness` 增量补齐。
- **验收**：5 个 JeikCode 标签页同时打开时，对同一 origin 的长连接从 `10 条 SSE` 降为 **`1 条 /stream/ws`（或最多 1 条共享 `/events` + 0~1 条前景 `/chat/watch`）**；刷新和普通 API 不再出现长期 `Queueing / Stalled`。

#### P0-5：`/api/update/check` 服务端缓存 + 轻量接口 + 前端单飞/错峰
- **涉及位置**：
  - [api_update.rs](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/api_update.rs#L405-L458)、`crates/jeikcode-updater/src/lib.rs`
  - [app.tsx](file:///e:/code/jeikcode/webui/src/app.tsx#L881-L934)
- **修改内容**：
  1. 服务端增加进程内 TTL 缓存（如 10~15 分钟，支持 `ETag` 与后台异步刷新，请求路径不等待外部网络、加外网请求超时与并发单飞锁 `OnceCell`/`Mutex` 合并同时到来的请求）；
  2. 拆分轻量角标接口（如 `?summary=1` 仅返回 `current_version` / `latest_version` / `has_update` / `channel` / `download_url`，`<1 KB`）；完整 107 个历史版本与动辄十几 KB 的 release notes 只在用户真正点开更新弹窗时再按需拉取；
  3. 前端多标签通过 `BroadcastChannel` / `localStorage` 共享最近检查时间戳与结果，移除「每次 `window.focus` 无防抖直接发请求」的设定（设最小冷却时间）。
- **验收**：首页静默检测载荷从 `804 KB / 3~14s` 降至 `< 1 KB / < 50ms`（缓存命中）；切回窗口不再反复请求外部接口。

#### P0-6：`before_seq=0.953` 小数游标 400 修复
- **涉及位置**：
  - [canvasStore.ts](file:///e:/code/jeikcode/webui/src/lib/canvas/canvasStore.ts#L157-L175)
  - [Chat.tsx](file:///e:/code/jeikcode/webui/src/components/Chat.tsx#L7846-L7863)、[#L7926-L7935](file:///e:/code/jeikcode/webui/src/components/Chat.tsx#L7926-L7935)
  - [lib.rs](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs#L365-L367)、[#L8458](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs#L8458)、[#L9209-L9309](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs#L9209-L9309)
- **修改内容**：
  1. **严格隔离「画布本地排序锚点」与「服务端分页游标 `serverSeq`」**：`normalizeCanvas` 生成的插值小数仅可留在本地排序字段中，绝不允许覆盖用于请求的 `beforeSeq`；
  2. **前端发包强校验与 400 自动回退**：[Chat.tsx](file:///e:/code/jeikcode/webui/src/components/Chat.tsx#L7846-L7849) 必须检查 `Number.isInteger(headSeq) && headSeq > 0`（优先取后端返回的权威 `cursor.oldest_seq`），否则直接走 `offset: nextOffset` 分页；若 `before_seq` 仍返回异常（400/空页），`catch` 分支内当场兜底回退到 `offset` 翻页并向用户给出失败提示，而不是静默保留按钮；
  3. **后端兜底对齐**：对 `display_prefix_messages` / `presentation` 等无 `seq` 行明确不参与客户端分页锚点，`cursor.oldest_seq` 只在存在真实可向前翻页的整数 `seq` 时返回，或由服务端直接支持稳定整数锚点。
- **验收**：复现 93 条无 `seq` 前置行 + `seq=1` 场景，点击「加载更早的消息」不再发出小数 `before_seq`，正常拉取前页并正确更新剩余条数直到闭合。

#### P0-7：`/token=` 路由引导与所有未校状态码 API 的防崩溃兜底
- **涉及位置**：
  - [lib.rs](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs#L22193-L22194)
  - [api.ts](file:///e:/code/jeikcode/webui/src/api.ts#L51-L57)、[#L1499-L1502](file:///e:/code/jeikcode/webui/src/api.ts#L1499-L1502)、[#L1509-L1551](file:///e:/code/jeikcode/webui/src/api.ts#L1509-L1551)、[#L2031-L2105](file:///e:/code/jeikcode/webui/src/api.ts#L2031-L2105)
- **修改内容**：
  1. 对错误路径 `/token=<value>` 在后端/前端 SPA 路由层识别并平滑重定向至 `/?token=<value>`（或引导走 `/?token=` 认证流），避免静默落回无鉴权静态页后全部接口 401；
  2. 将 [api.ts](file:///e:/code/jeikcode/webui/src/api.ts#L1499-L1502) `listSessions()` 以及 `getProject()`、`getSkills()`、`getCommands()`、`listProjectSessions()`、`searchSessions()` 全部补齐 `if (!resp.ok)` 抛错与 `Array.isArray` 结构校验，严禁错误 JSON 对象流入组件数组 state。
- **验收**：故意访问 `/token=abc` 或在 401 未认证下访问界面，触发正常的认证弹窗而非 `Er.filter is not a function` 运行时崩溃。

---

### 【P1 阶段】请求风暴治理、后端并发隔离与渲染瘦身

#### P1-1：消除重复请求风暴（请求单飞 + 依赖修剪 + `/bootstrap` 聚合）
- **涉及位置**：
  - [api.ts](file:///e:/code/jeikcode/webui/src/api.ts)（新增 GET in-flight 单飞复用表）
  - [ModelSelector.tsx](file:///e:/code/jeikcode/webui/src/components/ModelSelector.tsx#L215-L255) & [Chat.tsx](file:///e:/code/jeikcode/webui/src/components/Chat.tsx#L2013-L2046)
  - [Sidebar.tsx](file:///e:/code/jeikcode/webui/src/components/Sidebar.tsx#L759-L817) & [NotificationDock.tsx](file:///e:/code/jeikcode/webui/src/components/NotificationDock.tsx#L390-L441)
  - [app.tsx](file:///e:/code/jeikcode/webui/src/app.tsx#L396-L454)、[#L1015](file:///e:/code/jeikcode/webui/src/app.tsx#L1015)、[#L1086](file:///e:/code/jeikcode/webui/src/app.tsx#L1086)
- **修改内容**：
  1. `api.ts` 增加 `GET` 请求 in-flight Promise 去重（按完整 path+auth 维度合并并发重复请求，如 `/sessions`、`/projects/sidebar`、`/chat/active`、`/models`、`/sessions/resolve/:id`）；
  2. 修复 `ModelSelector` 随 `activeSession` 引用变化反复触发 `getModels()`：`followDefaultProvider` 改用最新引用 `ref` 稳定回调，并由单一数据来源提供模型列表给 `Chat` 与 `ModelSelector`；
  3. 拆解 `Sidebar.tsx` 的 [主 refresh effect](file:///e:/code/jeikcode/webui/src/components/Sidebar.tsx#L794-L817)：**把展开新项目（`expandedProjects`）的按需加载从全量 `refresh` 依赖中剥离**，展开单个项目仅拉取该新增项目会话列表，不再顺带重拉 `/sessions`、`/projects/sidebar` 和 `/chat/active`；
  4. 提供服务端 `/api/bootstrap` 一次性聚合冷启动必需首屏元数据（当前项目、项目侧栏配置、活跃会话 ID、审批模式、轻量模型列表等），并将 12s `/chat/active` 与 15s `/health` 改为仅由 Leader 标签页或 SSE 断开恢复时触发。
- **验收**：单标签冷启动请求总数从 `77~101` 降至 **`< 20`**；同接口冷启动重复并发降为 **`1` 次**；侧栏点击展开任意项目仅产生 `<= 1` 个增量请求。

#### P1-2：后端 Tokio worker 解阻塞 + Catalog 扫描去重 + `tail` 条件缓存恢复
- **涉及位置**：
  - [api_git.rs](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/api_git.rs#L437-L1328)（全文件所有同步 `git_cmd`）
  - [api_config.rs](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/api_config.rs#L1548-L1606)
  - [lib.rs](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs#L7215-L7226)、[#L7468-L7510](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs#L7468-L7510)、[#L7900-L7909](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs#L7900-L7909)、[#L8168-L8175](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs#L8168-L8175)
  - [legacy_convert.rs](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/legacy_convert.rs#L1230-L1254)
  - [api.ts](file:///e:/code/jeikcode/webui/src/api.ts#L2588-L2591)
- **修改内容**：
  1. 将 `api_git.rs` 中所有同步 `git_cmd(...).output()`、`api_config.rs` 中 `scan_zombie_processes()` / `kill_zombie_processes_all()`，以及 `lib.rs` 中 `resolve_session`、`get_session_detail` 统一迁入 `tokio::task::spawn_blocking`（catalog 路径复用现有的 `run_session_catalog_io` 并发信号量），彻底停止饿死 Tokio async 线程；
  2. 消除 `list_projects`、`list_sessions`、`list_all_sessions` 内部的**双倍 `catalog_scan_in_root` 调用**（一次 scan 复用给 `active_catalog_location` 与过滤渲染）；
  3. 修复 `load_catalog_session_view_in_project_root`：已给出 `(project_bucket, id)` 时直接定位 `sessions_root/<project_bucket>` 读取该会话文件，仅在精确文件不存在/诊断异常时再按需查单桶或回退，去掉每次进会话必扫全盘 catalog 的开销；
  4. 在确认 [lib.rs](file:///e:/code/jeikcode/crates/jeikcode-daemon/src/lib.rs#L8045-L8084) 对完整序列化结果生成 ETag 的前提下，允许 [api.ts](file:///e:/code/jeikcode/webui/src/api.ts#L2588) 对 `?tail=N` 开启按 `requestPath` 隔离的条件缓存（`304 Not Modified`），消除重复回看/切会话的 212 KB 重复传输。
- **验收**：`git_status`/`git_graph` 与 `legacy-status` 不再占用 Tokio 工作线程；单次 `/sessions`、`/projects` 只做 1 次 `catalog_signature()`；切回未变动的会话返回 `304`（`0` 字节响应体）。

#### P1-3：主线程渲染与首屏体积优化（明确避开已回退的 `content-visibility: auto`）
- **涉及位置**：
  - [Chat.tsx](file:///e:/code/jeikcode/webui/src/components/Chat.tsx#L951-L956)、[#L13721-L13790](file:///e:/code/jeikcode/webui/src/components/Chat.tsx#L13721-L13790)、[#L13918-L14000](file:///e:/code/jeikcode/webui/src/components/Chat.tsx#L13918-L14000)
  - [UserMessageView.tsx](file:///e:/code/jeikcode/webui/src/components/chat/UserMessageView.tsx#L27)
  - [Markdown.tsx](file:///e:/code/jeikcode/webui/src/components/Markdown.tsx#L129-L143)、[#L228-L238](file:///e:/code/jeikcode/webui/src/components/Markdown.tsx#L228-L238)
  - [Sidebar.tsx](file:///e:/code/jeikcode/webui/src/components/Sidebar.tsx)（长会话列表虚拟化/窗口化）
  - [i18n.ts](file:///e:/code/jeikcode/webui/src/i18n.ts#L9-L17)、[main.tsx](file:///e:/code/jeikcode/webui/src/main.tsx#L9-L14)
- **修改内容**：
  1. **拆除 `Chat` 1 秒全局定时器**：将 `nowMs` 从顶层 `Chat` 下沉到独立轻量子组件（只重渲染末尾计时文案几字节，禁止每秒带动整个消息时间线重排和 `turnLastTexts`/`turnAllTexts` O(N) 扫描），把 `turnLastTexts`/`turnAllTexts` 包入基于 `[messages]` 的 `useMemo`，并为 `UserMessageView` 加上 `memo`；
  2. **修复 `Markdown` 高开销热路径**：在 `rewriteImageSources` 入口加 `if (!html.includes('<img')) return html;` 快速短路，彻底跳过 99% 无图消息的 `DOMParser` 解析；优化流式增量路径，处理 `marked` 常见 `</p>\n` 尾部增量，减少整块 `root.innerHTML` 重建与表格重复测量；
  3. **侧栏会话列表窗口化 / 折叠延迟渲染**：对 300+ 会话项目分组只渲染视口窗口或渐进分页，避免首屏创建全量 DOM 节点；
  4. **拆分首屏 2.17 MB 主包**：把 `i18n.ts` 的 10 份多语言文件改为按当前选中语种动态 `import()`；把 `TerminalPanel`（及其携带的 `@xterm/xterm` 全套插件）真正移出首屏主 chunk 按需加载；检查字库/KaTeX CSS 仅按需加载，显著压缩首屏 JS parse 与 LCP render delay。
- **注意边界**：遵循 [app.css](file:///e:/code/jeikcode/webui/src/styles/app.css#L3889-L3917) 已留存的回归教训，**不恢复 `.timeline-message` 的 `content-visibility: auto`**，确保流式代码块不消失。
- **验收**：AI 运行期间 `Chat` 根组件不再每秒触发全树渲染；非图片 Markdown 零 `DOMParser` 调用；首屏主 bundle JS 明显低于 2.17 MB，长任务 `< 100 ms`，LCP render delay 大幅下降。

---

### 【P2 / P3 阶段】按要求暂缓（后续独立专项）

- **P2 / P3：`#89` 倒灌 / steer 串会话 / ESC stop 路由状态隔离与结构化诊断日志**：本次**暂缓实施**。待 P0 与 P1 全数落地消除了连接池阻塞、进程自杀与主线程卡顿放大后，再单独复现和审计状态机及日志闭环。

---

## 6. 量化验收基线对照

| 指标 | 修复前（`v7.5.1-beta.1` / 现场截图） | 修复后目标 |
|---|---|---|
| 5 标签页 SSE / 复用通道 | `10` 条 HTTP/1.1 长连接（已超 6 槽上限） | `1` 条共享 `/stream/ws`（或最多 1 共享 `/events` + 0~1 前景 watch） |
| 5 标签页隐藏终端 / WS | `30` 个 xterm + `30` 条 WS（且禁止全关） | `0`（默认不挂载不建连）~ `1`（仅当前实际打开终端） |
| `/api/update/check` | `3~14s` / `804 KB` / 每次 focus & 多标签重复 | `< 50ms` / `< 1 KB`（摘要缓存命中，多标签共享） |
| 「模型配置」入口交互 | 原窗秒关 → 空白久等 → 长期卡死「加载中…」 | 秒开框架与缓存内容，10~15s 请求超时可控报错/重试 |
| 冷启动请求数 & 重复并发 | `77~101` 请求，单接口并发 `4~7` 次 | `< 20` 请求，并发去重后 `1` 次 |
| 重复 `tail` 拉取 | 每次 `212 KB` | 条件缓存命中 `304`（`0` 字节载荷） |
| `before_seq=0.953` / `#88` / 401 | 400 卡死 / 误杀自己 / `Er.filter` 崩页 | 整数游标 + offset 回退 / 永不误杀本 TGID / 正常鉴权提示 |
| 后端异步线程安全 | `api_git` / `sysinfo` / 会话详查同步阻塞 Tokio | 阻塞操作全部隔离至 `spawn_blocking` 且消除冗余扫描 |
