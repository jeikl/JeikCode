# JeikCode v7.5.0 发版总结报告

> 生成日期：2026-11-08  
> 代码基线：`beta` @ `0e2c2f0f4`  
> 对比基线：`main` @ `3eefee292`；最后发布标签 `v7.3.2-beta.1`；最后稳定标签 `v7.2.8`  
> 结论：这是一次以「会话画布/持久化/运行时权威」超大重构为主干、叠加转向状态机、历史去重、版本仲裁、Provider Schema、EDIT 加固、上下文预算与多项前端体验修复的稳定版发布。代码已在 beta 通过 CI 与完整发布构建；`v7.5.0-beta.0` 的 GitHub Release 公告与 `CHANGELOG.md` 已在 2026-11-08 补充更新，覆盖 main 上 11 个未发版提交（含超大重构）与 beta 13 个后续提交。

---

## 1. 发布范围与版本现状

### 1.1 三个对比口径

| 对比口径 | 提交数 | 文件数 | 新增 | 删除 | 说明 |
| :--- | ---: | ---: | ---: | ---: | :--- |
| `main` → `beta` | 13 | 90 | 5,617 | 937 | beta 在 main 之上的最后一段后续修复 |
| `v7.3.2-beta.1` → `beta` | 24 | 291 | 43,475 | 17,831 | 上一次已发布标签之后、本次稳定版应交付的完整增量 |
| `v7.2.8` → `beta` | 178 | 426 | 91,438 | 25,115 | 若稳定版说明需要覆盖「上一个稳定版以来」的全部变更 |

其中：

- `2f0984f59 refactor(webui,daemon): overhaul session canvas identity, runtime authority, and persistence` 是你提到的「超大重构」：**249 个文件，+34,760 / -15,776**，由 113 个原始提交收敛为 1 个提交。
- 另有 `6e2e9631d`（MCP HTTP/SSE 与管理 API，1,050 行）、`94d359272`（离线/气隙网络屏蔽，306 行）、`c9a7904c3`（Git 轮询客户端池与限流退避，393 行）。
- `main` 当前是 `beta` 的祖先，**合并 beta 到 main 可以 fast-forward，无冲突**。
- 当前版本号统一为 `7.5.0-beta.0`；没有 `v7.4.x` 发布记录。下一次稳定版建议明确为 `v7.5.0`，不要被自动 bump 脚本带到 `7.5.1` 或 `7.6.0`（见第 9 节）。

### 1.2 为什么 `main` → `beta` 只有 13 个提交

你记忆中的超大重构已经在 `main` 上（`2f0984f59`），所以 `git log main..beta` 只剩 beta 后续的 13 个提交。但发版内容必须把 main 上「已合入但尚未发布」的 11 个提交一起算上，否则会漏掉画布重构、MCP、离线屏蔽、Git 轮询、EDIT 路径修复、提示词收紧等一大块内容。本报告按「上一次发布标签 → beta」的 24 个提交给全量结论，同时单列 `main` → `beta` 的 13 个后续提交。

---

## 2. 一页看懂：本期交付主线

1. **会话画布超大重构**：稳定身份、因果顺序、单一 reducer/store 写入口、纯投影、重连回放去重、磁盘尾部拼接、缓存 schema 升级。
2. **持久化与恢复**：`display.jsonl` v4、输入日志、partial 流恢复、快照合并写、压缩占用持久化、rewind 账本。
3. **运行时权威与重连**：`GET /chat/runtime` 单一权威、显式 `replay` 标记、daemon epoch 游标、多实例同步、busy 状态不再靠本地启发式。
4. **转向/队列/待办状态机**：`admitted → submitted → promoted | rejected | cancelled | rewound`，daemon 单写、原子准入、刷新重放、身份锚点、基于身份的回溯截断。
5. **历史去重**：同一提问只保留一行；修复「快照预写 + 内核再次 submit」导致的重复用户气泡与双倍 Token。
6. **单调 revision 仲裁**：TodoBoard、`/chat/queue`、IndexedDB 画布缓存全部拒绝陈旧/乱序快照。
7. **Provider 工具 Schema 对齐**：Gemini/Responses/Chat Completions/Anthropic 统一投影；Gemini 改用 `parametersJsonSchema`；Responses/Chat 显式 `strict: false`；保留标准 JSON Schema union。
8. **前端体验与修复**：完成态绿勾、行为与快捷键设置、ESC 撤销偏好、发送后回焦、侧栏 5 条折叠与右键多选批量删除、端口/监听地址快速切换、图片灯箱、Markdown 表格列宽拖拽、编辑器/预览/会话记忆。
9. **前端渲染稳定性**：思考与正文不再重复/劈裂；旧历史不再倒灌到回答底部；SSE 回放不再重复或错位；流式文字不再抖动；Markdown 围栏代码不再被单个 `#` 截断。
10. **EDIT 工具加固**：原子写、fsync、冲突重读、进程内/跨进程锁、敏感路径与软链逃逸防护、编辑历史内存上限、平台路径别名修复。
11. **上下文预算与压缩水位**：`max_tokens` 回归「能力上限」而非每次请求目标；动态输出预算按窗口/剩余空间夹取；思考预算不得反向抬升输出预算；压缩与预发送预警共用同一水位。
12. **MCP / 离线 / Git 轮询**：HTTP/SSE MCP 与 CLI/REST 管理、气隙离线网络屏蔽、共享 HTTP 客户端与 429/5xx 指数退避。
13. **提示词现代化**：`init.yaml` 2.2.0、`rules.yaml` 2.1.0、停用 `<todo_rules>` 块、四层规则优先级与防主动探索边界。

---

## 3. 超大重构：会话画布、持久化与运行时权威

### 3.1 画布身份与单一写入口

- 每条画布记录统一携带稳定 `id`、会话内 `seq`、派生 `kind` 与有序 `parts`。
- 所有写入收敛到单一 reducer/store 边界：`normalizeCanvas`、`reduceCanvas`、`reduceCanvasEvent`、`SessionStoreMap`，不再由各调用点自行拼数组。
- 重复记录按 `id` 合并：**位置取首次出现，内容取最后一次出现**；数组顺序即因果顺序，`seq` 只用于分页/磁盘对齐，绝不参与渲染排序。
- `projectCanvas` 变为纯透传投影，渲染层不得再按 `seq` 重排。这直接消灭了「断线重连/切会话后中间一段正文和转向卡被搬到会话开头」的根因。
- 编辑、删除、回溯、重新生成、大纲跳转全部按消息 `id` 解析目标，不再依赖陈旧的 `sourceIndex`。

### 3.2 持久化与恢复

- `display.jsonl` 升级为 v4 投影：追加式记录、单调 `seq`、`display.meta.json` 覆盖度、`display.idx.jsonl` 偏移索引、回合追加幂等、会话级 display 锁、原子重写、容忍末尾半行，并支持 v3 迁移/回填。
- 用户提问在准入时、任何模型请求之前即落盘；压缩与警告通知以带权威磁盘 `id`/`seq` 的 display 记录持久化；瞬时提示不进入 transcript 与缓存。
- 持久输入日志记录 prompt/steer/queue 的准入与状态；读取按 `id` 去重、按 `seq` 排序、忽略残缺行，并暴露 `after_seq` 增量游标。
- partial 流在回合中断时保留；新回合前归档，支持 `.json.tmp` 撕裂恢复；半截回答在 display 切片落盘前持续可见。
- 快照写入合并：进度/并行工具的突发更新只保留最新待写快照，不再为每个事件排队一次完整序列化。
- 压缩后的上下文占用持久化为 `compacted_context_tokens`；冷启动与异地端在下一次真实 usage（或 undo）清除前都读到压缩后的值。
- rewind/delete/edit 会同时清理 snapshot、display、原始 transcript、输入日志中的未来分支，避免 recall 或冷启动把已删除分支复活。

### 3.3 运行时权威与重连

- `GET /chat/runtime` 成为运行状态、阶段/status、revision、owner、压缩起点、turn id、loop/goal 状态、最近终态与 terminal seq 的唯一服务端权威。
- `runtime_activity` 把同一份 revision/owner 推给所有实例；WebUI 的 busy 状态完全由 daemon 权威派生，不再依赖本地启发式。
- 每一帧显式携带 `replay` 布尔值；客户端不再用 `seq` 是否存在来猜回放。
- daemon epoch 使旧游标失效；adopted canvas 与 hydrated cursor 对齐；程序化停止标记携带被替换回合的 operation id，避免新回合终态被吞。
- 多实例实时同步、唤醒时拉取权威快照、空闲确认、steer/队列原子认领、跨会话流隔离与重连重放矩阵均已落地。

### 3.4 Chat 组件拆分与 UI 能力

- Chat 拆分为消息、工具、思考、通知、队列、输入区、@/斜杠菜单、灯箱、todo 面板、状态行、右侧检查器等聚焦组件。
- 新增/强化：Markdown 表格列宽拖拽与双击自适应、图片画廊/灯箱与一键复制、完成态绿勾、移动端视口/键盘修复、编辑器标签状态与磁盘实时刷新、查找替换、SVG 源码/预览、图片缩放、单面板文件拖放、侧栏多重展开、远程访问关闭、跨面板文件保存。
- 新增的聊天状态、@ 提及、编辑器、预览、面板与 Markdown 文案全部接入 `zh/en/vi` 及另外 8 个语言目录。

### 3.5 工具、内核与压缩

- EDIT 写入改为同目录临时文件 + `fsync` + 原子替换；拒绝硬链接、逃逸工作区的软链、敏感目标、只读文件与所有权变更；进程内按路径锁 + 跨进程 sidecar 锁串行化并发编辑；编辑历史内存有界。
- 内核输入身份由调用方铸造：`UserInput.id`、`SendMessageWithId`、steer 提交会把客户端 id 保留到 snapshot、display、wire 事件与大纲。
- 内核按每个并行调用发出 `ToolFinished`，快工具先结算行状态；权威 `ToolResult` 仍按发射顺序落地，保证 provider 配对与前缀缓存确定性。
- 内部/通知/系统行在唯一 wire 投影边界被排除出模型上下文；空助手回合（含仅 reasoning）在 reasoning 回显前被丢弃，严格网关不会再收到没有 tool_calls 的 `content: null`。
- 手动压缩登记为 `ActiveChatRegistry` 操作，不绑定 HTTP handler；刷新/关页不会取消它；压缩阶段、起点、边界与占用跨刷新恢复。

---

## 4. 你补充的 7 项：逐条核实与补全

> 说明：以下「归属」标注该能力最终落在哪个发布区间。部分单项提交在超大重构压缩前存在，最终内容通过 `2f0984f59` 收敛进 main/beta；另有部分能力属于 7.3.x 已发布 beta、但尚未进入任何稳定版，因此本次稳定版仍应纳入说明。

### 4.1 任务完成的会话显示绿色「√」标识

**归属：超大重构（`2f0984f59` 收敛，原始提交 `df3bc8dab` / `7a28b67eb`）。**

- 侧栏中真正跑完的会话，会把蓝色运行圈圈原地换成绿色对勾。
- 只有内核权威终态 `terminal: "completed"` 才点亮；用户停止、失败、临时空闲帧一律不点亮。
- 徽标是一次性、内存态：点进会话（点行、点对勾、通知跳转）或会话再次开跑即熄灭；刷新后不重放。
- 跨标签页/多端同步：新增 `session_seen` 全局事件与 `POST /sessions/:id/seen`，任一实例查看后所有实例一起熄灭；当前正在观察的会话在窗口重新聚焦、时间线获得焦点或用户真实滚动时自动熄灭。
- 状态机抽到 `lib/completedBadge.ts`，带单元测试；样式使用主题成功色、轻微弹入与 `prefers-reduced-motion` 降级；`sidebar.completed` 已覆盖全部语言。

### 4.2 新增通用设置：系统行为与快捷键

**归属：beta 后续提交 `84a4c6965`。**

- 设置页「桌面与系统」更名为「行为与快捷键」（`Behavior & Shortcuts`）。
- 新增「ESC 撤销上一条消息」偏好，默认开启；保存在 `localStorage`（`jeikcode.escUndo`），跨标签页通过 `storage` 事件同步，修改后立即生效。
- ESC 统一受该开关控制：
  - 输入框 ESC 取消尾部待发/转向卡；
  - 无待发卡且回合运行中时，ESC 停止当前回合并回填上一条用户消息；
  - 待发卡片内 ESC 取消卡片；
  - 内联消息编辑 ESC 退出编辑。
- 弹窗、菜单、搜索等通用 UI 的 ESC 关闭行为保持独立，不受该偏好影响。
- 新增文案已覆盖 `zh/en/vi/zh-TW/ja/ko/ru/fr/es/de/ar` 全部语言目录。
- 该设置页同时保留既有的「关闭主窗口时」行为（托盘/退出/每次询问）与 Git 自动同步等系统偏好。

### 4.3 前端重构修复的大量 BUG

**归属：跨越 7.3.x 已发布 beta + 超大重构 + beta 后续修复（`f400c6d19`、`551e071c0`、`1c8e04050`、`d0ecd1715`、`2f0984f59`、`23c1b7a99`、`d25da2c93`）。**

#### 4.3.1 思考块与正文重复、劈裂

- 同一回合内的新 LLM round 续写上一次的 reasoning/正文部件，不再开启第二个部件。
- 同一助手消息内的同 kind 连续段重新合并；正文不会再被每个 Thinking 块劈成两半。
- 工具调用与通知仍是硬边界，保持时间顺序。
- 回放帧按 `(message_id, kind)` 收敛到规范显示块；同一 `message_id` 的后续 `part_seq` 必须回到已存在的规范块，不能在工具 barrier 之后另开一块。
- `withAssistantIdentity` 只在部件尚未认识该 `part_id` 时补身份，避免把后面的工具卡误盖成正文/思考。

#### 4.3.2 旧历史倒灌到回答底部

- 结算对账引入「part id + 内容强指纹」双校验，即使流式段落没有 `part_id`，也能识别已落盘内容并永久剔除。
- 磁盘尾部与画布合并增加「interleaved gap」保护：如果磁盘尾部包含更晚的行、却跳过了中间某条画布行，不把磁盘当因果超集，保留画布顺序，避免旧回答跑到新回答上面、转向卡被挪位。
- 长会话/多轮工具调用结束时，不再把早先轮次的工具卡与思考块重新灌到最终回答下面。
- `display.jsonl` v4 的追加式记录与权威 `id/seq` 让「已上屏内容」有稳定身份，减少文本启发式对账。

#### 4.3.3 SSE 渲染异常

- 每一帧显式携带 `replay`；客户端不再猜回放。
- daemon epoch 让旧游标失效；流游标与 adopted canvas 对齐。
- `part_id`/`part_rev` 身份优先路由；跨工具边界仍能找到原部件；回放时同 `message_id` 的后续段回到规范块。
- 会话缓存 schema 升至 16；旧结构缓存整体作废并重新水合，避免旧坐标污染新画布。
- 转向帧的 `anchor_message_id` 是服务端权威锚点；锚点不在当前窗口时延迟落笔，绝不追加到时间线尾部。

#### 4.3.4 画面抖动

- 渲染顺序只认数组因果序，不再按 `seq` 重排；`seq` 只做分页/磁盘对齐元数据。
- 流式 Markdown 纯文本追加改为就地扩展尾部文本节点，不整体替换子树；图片、嵌套滚动位置、选区与行布局保持稳定。
- 行内文件路径徽章恢复布局中性（`display:inline`），装饰在 `useLayoutEffect` 中于绘制前完成，消除「无徽章帧 → 有徽章帧」的双帧闪烁与逐 token 上下抖动。
- 回合结算只在 `!prevWasRunning` 时向末尾助手行写入 `elapsedMs`，避免热切换/结算瞬间跳动。

#### 4.3.5 附带修复

- 流式代码围栏（Markdown/Python/Mermaid）在未闭合时正常高亮，闭合后不再坍塌成普通正文或消失；后端 `ArtifactDetector` 与前端 `markdownPrep` 对齐，单个 `#` 注释不再提前劈裂代码块。
- 搜索高亮改为高对比明亮黄色；命中折叠工具卡时自动展开并居中。
- 图片灯箱覆盖输入区缩略图、消息区、内联编辑附件与待发附件，支持桌面/移动端左右切换。
- Markdown 表格支持列宽拖拽、双击自适应与刷新后保持。

### 4.4 新增端口、监听地址快速重置

**归属：7.3.x 已发布 beta（`7cce97168` / `f23444df3`），超大重构继续收敛；本次稳定版一并交付。**

- 远程访问面板的监听地址输入框旁新增 `127.0.0.1 ↔ 0.0.0.0` 一键切换按钮，避免手动输入。
- 端口可直接编辑；应用时区分「仅保存下次启动」与「立即重启生效」。
- 变更 host/port 时弹出重启确认；立即重启会：
  - 调用后端 `/remote-access`，携带 `apply_launch: true` 与 `restart: true`；
  - 同端口重启先等旧进程下线（最多 5 秒），再探活新实例（最多 45 秒，覆盖 systemd `RestartSec` / procd respawn）；
  - 跨端口探活保留浏览器当前主机名，禁止跳转到 `0.0.0.0`；
  - 保留/轮换访问 Token 与桌面端 `desktop=1` 标记；
  - 新实例未上线时给出超时提示，不无限转圈。
- 后端状态返回 `next_port` / `next_host` / `launch_mode`，用于区分「当前监听」与「下次启动生效」。
- 非回环地址关闭 Token 时后端拒绝保存，前端不再假转圈。

### 4.5 MD 预览区与会话选择新增记忆；修复切换标签导致的状态丢失

**归属：超大重构（`2f0984f59` 收敛，原始提交 `8c1ff1b0d`、`40dfc4369`、`eba82da7a`）。**

#### 4.5.1 编辑器/MD 预览记忆

- 画布内所有已打开文件标签保持挂载，仅切换显隐，不再卸载重建；切到会话、其它文件或右侧预览再切回时，编辑/预览模式、未保存草稿、光标选区、滚动位置与撤销栈全部保留。
- 新增按画布隔离的标签现场快照：
  - 键前缀 `main:` / `preview:`，主编辑器与右侧预览互不串草稿；
  - 快照包含 `content`、`isDirty`、`viewMode`、图片缩放、选区、滚动位置、磁盘文件戳；
  - LRU 上限 32，关闭标签写墓碑（最多 256），防止卸载清理把刚关闭标签的草稿写回。
- 新增 `/fs/stat`，`/fs/read`、`/fs/write` 返回 `size + modified_ms`；前台单例轮询器每 2.5 秒最多检查两个标签，页面隐藏即停，失败指数退避，切标签不增殖计时器。
- 外部修改保持当前模式原地刷新；脏标签保留草稿并显示「保留 / 重新加载」冲突条；保存后推进磁盘基线，自己的写入不会被误判为外部更新。
- Markdown 预览、SVG 源码/预览、图片缩放、查找替换、二进制说明等工具栏文案已全部本地化。

#### 4.5.2 会话选择与侧栏记忆

- 新增浏览器本地导航记忆 `lib/navState.ts`：
  - 记住上次选中的会话完整 id、项目 hash、工作目录与名称；
  - 刷新优先用 URL 短 id 直达，其次用本地完整 id 恢复；
  - 只在显式新建会话或确认 404 时清除记忆，普通刷新不得把用户踢回落地页。
- 侧栏记住展开/手动折叠的项目集合；同一浏览器刷新恢复原状态，跨设备/无痕冷启动才走 daemon 默认行为。
- 侧栏首屏快照缓存项目顺序、会话行、隐藏/固定状态与滚动位置，首帧直接画出上次列表，随后用服务端权威数据就地校准，避免「展开的空分组 → 重排 → 假刷新」。
- 运行中项目仍可自动展开，但不得覆盖用户手动折叠意图；展开更多/收起改为页面内瞬态，不再跨刷新保持全量展开。
- 该记忆同时修复了切换标签页、切到会话画布、项目切换等场景下编辑器/预览/选中会话状态丢失的问题。

### 4.6 优化 EDIT 工具

**归属：超大重构（`de53b659e` 收敛）+ main 后续修复 `c7d5659c9`。**

- **原子写**：同目录临时文件、`fsync`、`rename`、父目录 `fsync`；Windows 共享冲突按 25/50/100/200/400 ms 重试。
- **目标安全**：拒绝非普通文件、只读文件、Unix 硬链接、非当前属主文件；写 canonical 目标，编辑软链时更新真实文件而不是替换软链本身。
- **冲突处理**：获取按文件锁后重新读取并做字节比较；文件已变则基于新内容重跑 hunk 再写；超时或文件身份变化 fail closed，不落盘。
- **并发协调**：进程内按路径异步互斥锁 + 跨进程 `fs2` sidecar 锁；两种等待都支持 `CancellationToken` 与 10 秒超时。
- **最终目标复核**：读取字节前再次检查软链/junction 是否解析到工作区外或敏感目标；除非调用方显式使用目标路径，否则拒绝，关闭审批分类到编辑快照之间的路径重定向提权窗口。
- **平台路径别名**：macOS `/var` → `/private/var`、Windows 8.3 短路径（`RUNNER~1`）不再把显式工作区内敏感文件误判为软链跳转；最终组件是普通文件且 canonical 目标仍在工作区内时放行；最终组件软链与工作区外目标仍拒绝。
- **历史内存**：Full/BaseOnly/Skip 分级（1 MB/10 MB）、生成文件跳过、128 MB 进程级整 ring LRU 预算；`Arc` 拷贝与最近文件磁盘读取移出全局锁。
- **诊断与状态**：跨文件「找错路径」提示限制在当前 workspace，磁盘提示读取上限 1 MB；`write_state` 按路径状态上限 4096，按最旧 turn 淘汰；拓扑消歧/排序增加取消检查，预检外层 30 秒 CPU 超时。

### 4.7 上下文思考预算与压缩水位算法调整

**归属：7.3.x 已发布 beta（`db3021d5a`、`f18e97970`）+ 超大重构收敛（`7d14e3f6f`）。**

#### 4.7.1 `max_tokens` 回归能力上限，不再压垮输入预算

- `[models.X] max_tokens` 是模型输出能力的声明，不是每次请求的目标值。
- 发送到 wire 的输出预算为：
  - `min(能力上限, window / 8, window - prompt - 4K guard)`；
  - 未配置时默认 65,536；窗口未知时回退到该默认值。
- 此前把 `max_tokens` 直接当输出预留，导致 1M 窗口模型被压成 491K 输入预算，并在 49% 占用时就提示「接近上限」；该缺陷已消除。
- 输入水位固定为 `window - min(20K, window / 4)`；自动压缩、发送前超窗预警、`CompactionView` 全部共用这一条水位线，不再出现「每轮警告但从不压缩」的裂缝。
- 估算锚点使用 provider 最近一次真实 `prompt + completion`，加上新增消息的 CJK 保守估算（每个非 ASCII 字符按 1 token）；宁可高估而缩小输出预算，也不能低估而触发网关 400。
- 任务边界与回合内自动压缩使用同一阈值，并以当前即将发出的 prompt 估算；CJK 重的会话也会在水位线上触发压缩。

#### 4.7.2 思考预算成为输出预算的下游约束

- 思考预算不再反向抬升 `max_tokens`，而是夹取到为答案保留 `MIN_ANSWER_TOKENS = 1024` 以内。
- `provider/thinking.rs` 统一解析：
  - Anthropic ≤ 4.6：`thinking.budget_tokens`；
  - Anthropic 4.7+：adaptive thinking + `output_config.effort`；
  - Gemini 2.5：仅 `thinkingBudget`；
  - Gemini 3+：仅 `thinkingLevel`；
  - Responses：仅 effort，忽略数值预算；
  - OpenAI-compat：默认仅发 `reasoning_effort`，不再强制 thinking 对象。
- 剩余答案空间不足时直接关闭思考；Anthropic disabled 变体不携带 budget；WebUI 模型选择器与 provider 对话框把手动预算下限夹到 1024。

#### 4.7.3 压缩连续性与水位观测

- 压缩后的占用持久化为 `compacted_context_tokens`；压缩标记、阶段、起始时间跨刷新恢复。
- 每次被压缩掉的 span 在摘要调用前逐字写入会话 artifact store（内容寻址，含完整工具输出、reasoning、签名、用户回合索引）；摘要末尾带 `artifact://<id>` 指针，可用现有 read 语法回读。
- 摘要模板升级为 13 个连续性小节；无摘要器、provider 报错或空摘要时生成锚定指针摘要，而不是静默丢弃。
- 旧压缩锚点中的过期 artifact 指针会被剥离；压缩归档带 `.pin`，不受 3 天清理周期影响，只在 7 GiB 硬上限下最后淘汰。
- 思考耗尽诊断也改用 `input_watermark_budget`：高上下文压力下明确提示 `/compact` 或精简输入，不再泛泛建议重试。

---

## 5. beta 后续 13 个提交的详细变更

| 提交 | 主题 | 核心内容 |
| :--- | :--- | :--- |
| `879f83f21` | 状态 revision 仲裁 | TodoBoard revision、`/chat/queue` revision CAS、IndexedDB queue+queueRevision 原子缓存、`stateRevision` 共享模块与测试。 |
| `85aa3ca75` | 版本号 | 7.3.2-beta.1 → 7.5.0-beta.0，级联 Cargo/package/Tauri/docs-site。 |
| `fe12d8fa0` | todo/steer 刷新保持 | 恢复 `todo_write` 完整动作枚举；拒绝 `clear` 携带任务文本；已完成面板保留到终态；队列快照先读盘再 CAS；仅唯一文本匹配才对齐 steer。 |
| `a43519d01` | Provider Schema | 新增 `tool_schema.rs`；Gemini `parametersJsonSchema`；Chat/Responses `strict:false`；Moonshot/Kimi 方言；保留 `oneOf/anyOf`。 |
| `e9aa8d8db` | steer 原子状态机 | 持久化 `admitted → submitted → promoted/rejected/cancelled`；`POST /chat/steer/admit`；daemon 单写队列卡；启动/回合收尾对账；`anchor_message_id`；partial 归档/撕裂恢复；todo 稳定 id；队列卡统一 `client_input_id`；L2 剔除 provisional 大纲行。 |
| `a1fc17d82` | 发送后回焦 | 立即发送、附件上传、斜杠命令后焦点回输入框；弹窗打开时不抢焦点；排队/转向卡焦点链路不变。 |
| `bceca69dc` | 侧栏折叠与多选 | 项目分组 5 条折叠 + 展开更多/收起；运行中/当前选中永不隐藏；右键菜单复用三点动作；Ctrl/Cmd 切换选中、Shift 连续范围、Ctrl+Shift 扩展；批量删除按完整项目桶解析；菜单坐标按页面缩放归一化。 |
| `84a4c6965` | 行为与快捷键 | 设置页更名；ESC 撤销偏好默认开启、localStorage + storage 事件同步；覆盖 11 种语言；全部 ESC 聊天回退统一受控。 |
| `cc21c9778` | 提问单行幂等 | 移除 daemon 两处 canonical 快照预写；内核成为会话行唯一写入方；`Conversation::push` 对带 id 的真实用户消息幂等；修复 243 组本地快照重复 id。 |
| `d25da2c93` | steer 回放/回溯收敛 | 编辑回溯、用户分支删除、assistant/tool-run 删除统一按身份截断；`mark_rewound_not_in` 清理未幸存输入；首轮不 drain steer，后续 round 边界短静默再 drain；回放帧按 `(message_id, kind)` 收敛；权威锚点不在窗口时延迟落笔；尾部合并 interleaved gap 保护；缓存 schema 16。 |
| `0e23f9e15` | 提示词 2.2.0 | 身份/语言/模型身份结构化；防主动读取配置边界；配置目录说明；四层优先级；对外规范性工作仅适用公共项目规范；运行环境事实现代化；中英文 teaches 同步。 |
| `59746b3f1` | CHANGELOG | 记录 v7.5.0-beta.0 更新日志（仅覆盖 beta 最后一段，未覆盖 main 上 11 个提交）。 |
| `0e2c2f0f4` | 测试对齐 | persona 快照/系统上下文测试对齐 2.2.0 与结构化 `- Identity:` 格式；修复 native portability 的索引越界。 |

---

## 6. main 上未发版的 11 个提交（超大重构之外）

| 提交 | 主题 | 核心内容 |
| :--- | :--- | :--- |
| `6e2e9631d` | MCP HTTP/SSE 与管理 API | `merge_http_mcp_server_*`、`remove_mcp_server_from_json_file`、`load_all_mcp_configs`；CLI `mcp add-http/remove/list`、`--env/-e`、`--trust`；Daemon `POST /api/mcp/add`、`POST /api/mcp/remove`、`DELETE /api/mcp/:name`；热重载；双语文档。 |
| `94d359272` | 气隙离线屏蔽 | 子代理调度、`web_fetch`、`web_search` 入口强制离线拒绝；`ResetGuard`；跨 crate 离线测试串行化。 |
| `f447720c7` | 离线策略修正 | 离线网络出口使用 `Deny` 而非 `DenyTurn`，worker 收到 blocked 结果后可继续本地工具；敏感路径策略仍用 `DenyTurn`。 |
| `c9a7904c3` | Git 轮询韧性 | GitHub/GitLab/Gitee/GitHub App 共享 reqwest client；解析 `Retry-After`/限流重置头；429/5xx/瞬时失败自适应指数退避 + FNV-1a jitter。 |
| `2f0984f59` | 会话画布超大重构 | 见第 3 节；249 文件，+34,760/-15,776，113 个原始提交收敛。 |
| `c7d5659c9` | EDIT 平台路径别名 | macOS `/var` → `/private/var`、Windows 8.3 短路径不再误拒显式工作区内敏感文件；最终组件软链与工作区外目标仍拒绝。 |
| `23c1b7a99` | 因果顺序与画布保持 | 移除热切换 `.slice(-HISTORY_PAGE)` 截断；`spliceAuthoritativeDiskTail` 按因果区间锚定用户/转向行；大纲跳转改增量 `older` 合并；`client_input_id` 补齐；`Steered` 写 queue_claims 墓碑并清理 `/chat/queue`；输入区图片灯箱。 |
| `ca48b992f` | 停用 todo_rules 块 | 停止注入 Block 3；`TODO_RULES` 与门控保留为注释；`rules.yaml` 重写；删除任务纪律/探索策略交叉引用；新增 `## TASK CHECKLIST TIPS AND RULES:`；persona 测试对齐。 |
| `3eefee292` | persona 快照测试 | 修复 native libraries 的 `index out of bounds`；夹具改为 3 个 persona 消息；`cargo test -p jeikcode-coding --lib parts::tests` 41 个通过。 |
| `c2560fce4` | 合并提交 | 将 canvas overhaul 合入 beta。 |
| `1bf25336c` | 合并提交 | 合入 PR #80（MCP HTTP/SSE）。 |

此外，`main` 上还有 `v7.3.2-beta.1` 之后、超大重构之前的 7.3.x 已发布 beta 内容；如果稳定版说明需要覆盖 `v7.2.8` 以来的全部变更，应额外参考 `CHANGELOG.md` 中 7.3.0/7.3.1/7.3.2 各 beta 段落。

---

## 7. 按模块的完整变更清单

### 7.1 会话与持久化

- 画布稳定 id / seq / kind / parts；单一 reducer/store；重复 id 合并；因果数组顺序；纯投影。
- `display.jsonl` v4、偏移索引、覆盖度元数据、v3 迁移、半行容忍、会话级锁。
- 准入即落盘用户提问；压缩/警告通知持久化；瞬时提示隔离。
- 持久输入日志、跨进程文件锁、seq 指纹缓存、原子压缩、图片型大日志退避。
- partial 流归档/恢复；崩溃检查点 overlay；取消时 display 先于 snapshot 清理。
- 快照合并写；`SessionSnapshot::model`；`compacted_context_tokens`；rewind 账本/事务日志。
- 写状态 4096 文件上限与最旧 turn 淘汰。

### 7.2 运行时与多实例

- `GET /chat/runtime` 单一权威；`runtime_activity` revision/owner；`replay` 显式标记；daemon epoch。
- busy 状态服务端派生；发送中/立即发送交接/手动停止防抖；30 秒静默停止回归。
- 终态通知只由本端最终 `done` 路径触发；`activity.terminal` 不通知；停止/steer/立即发送交接不误报 stopped。
- 队列 claim/release、原子认领、409 后降级/排空、陈旧卡降级。
- 跨会话流隔离、唤醒拉取、空闲确认、多客户端工作指示。

### 7.3 转向、队列、待办

- steer 状态机：`admitted → submitted → promoted | rejected | cancelled | rewound`。
- 按 `(session, client_input_id)` 单飞锁；`POST /chat/steer/admit`；daemon 单写队列卡。
- `anchor_message_id` 因果锚定；promoted steer 在 display 落盘前投影为用户消息。
- 首轮不 drain steer；后续 round 边界短静默 re-drain，保持点击顺序。
- 编辑回溯/删除按身份截断；未幸存输入标记 `rewound`；清理 partial/archived partial。
- TodoBoard 单调 revision；`SessionDetail.todos_revision`；已完成面板保留到终态；`clear` 携带文本拒绝。
- 队列 revision CAS；`base_revision`；claim/release/steer fold 递增；卡片图片刷新保留。
- IndexedDB 原子缓存 queue + queueRevision；冷启动仅接受不落后版本。
- `stateRevision` 共享仲裁；陈旧/乱序/重复快照拒绝。

### 7.4 前端渲染与交互

- 完成态绿勾与跨实例 `session_seen` 熄灭。
- 思考/正文单气泡；回放规范块；工具 barrier 硬边界。
- 旧历史倒灌双指纹拦截；interleaved gap 保护；磁盘尾部因果拼接。
- SSE `replay`/epoch/part revision；缓存 schema 16；转向延迟落笔。
- 流式 Markdown 就地追加；路径徽章布局中性；代码围栏账本；单 `#` 不截断。
- Markdown 表格列宽拖拽/双击自适应；图片灯箱/画廊/一键复制；输入区缩略图。
- 侧栏 5 条折叠、运行中置顶、右键菜单、Ctrl/Shift 多选、批量删除。
- 发送后回焦；ESC 撤销偏好；设置页更名；11 语言文案。
- 编辑器标签常驻、现场快照、LRU/墓碑、磁盘实时刷新、冲突条。
- 会话/侧栏导航记忆、首屏快照、滚动恢复、刷新不踢回落地页。
- 端口/监听地址快速切换与立即重启。

### 7.5 Provider 与内核

- 四协议工具 Schema 投影：object 根、Gemini/Kimi 方言、Gemini `parametersJsonSchema`、Chat/Responses `strict:false`、Moonshot `$ref` 兄弟清理、union 保留。
- 思考预算按模型族解析；`MIN_ANSWER_TOKENS=1024`；Responses effort-only；OpenAI-compat reasoning_effort-only。
- `max_tokens` 能力上限 vs 每次请求输出预算；`window/8` 软上限；`window - prompt - 4K` 剩余空间夹取。
- 输入水位 `window - min(20K, window/4)`；自动压缩/预发送预警共用；CJK 保守估算。
- 空/仅 reasoning 助手回合过滤；`ToolFinished` 逐调用结算；`ToolResult` 发射顺序。
- 首 token 超时重试默认 6 次，500 ms 起步、16 s 上限。
- 压缩归档 artifact、13 段摘要模板、pin/7 GiB 淘汰。

### 7.6 MCP、离线、Git

- HTTP/SSE MCP 配置合并、移除、全量读取；CLI `add-http/remove/list`；Daemon 管理 API；热重载。
- 子代理 / `web_fetch` / `web_search` 气隙离线屏蔽；离线出口 `Deny` 保留 worker 进度。
- Git 轮询共享 HTTP client；`Retry-After` / 限流重置；429/5xx 指数退避 + jitter；仓库级 backoff 状态。

### 7.7 提示词与文档

- `init.yaml` 2.2.0：结构化 Identity/Language/Model identity；防主动探索；配置目录；四层优先级；公共项目规范边界；运行环境事实。
- `rules.yaml` 2.1.0：停用 `<todo_rules>`；重写任务纪律/探索策略；新增 checklist tips；输出规则。
- 中英文 `teaches/01_prompts_and_context.md` 同步。
- MCP CLI/REST 中英文指南同步。

### 7.8 国际化

- 新增/修改文案覆盖 `zh/en/vi/zh-TW/ja/ko/ru/fr/es/de/ar`。
- 完成徽标、ESC 撤销、侧栏批量删除、编辑器预览、端口重启、Markdown 表格、图片灯箱等全部接入语言目录。

---

## 8. 测试与 CI 证据

### 8.1 已有验证

- `beta` 顶端 `0e2c2f0f4`：
  - `CI` 工作流成功；
  - `Beta native portability` 成功。
- `v7.5.0-beta.0` 标签 `59746b3f1`：
  - `Build and Release` 工作流成功（24m57s），六个平台产物构建通过。
- 失败记录与修复：
  - `59746b3f1` 的 `Beta native portability` 曾失败，原因是停用 `<todo_rules>` 后三个 `parts::tests` 夹具仍假设 4 个 persona 块，触发 `index out of bounds: len is 4 but index is 4`；
  - `0e2c2f0f4` 已把夹具改为 3 个 persona 消息并修复断言，随后 native portability 通过。
- 24 个提交区间共涉及 49 个测试文件；13 个 beta 提交区间涉及 13 个测试文件（含新增 `stateRevision.test.ts`、`menuPosition.test.ts`、`steerAnchor.test.ts`、`sessionProjection.test.ts`、`sessionList.test.ts`、`todos.test.ts`、`turnNav.test.ts`、`sessionCache.test.ts` 等）。
- 当前工作区干净；`beta` 与 `origin/beta` 一致。
- 本地 `main` 比 `origin/main` 领先 191 个提交（`origin/main` 仍停在 2026-10-19），发版 push 会把 main 上积压内容一并推上去。

### 8.2 本次报告未做的事

- 未在本地重复执行完整 `cargo check` / `cargo test` / `npm run build`。按项目 CI-first 规范，beta 顶端 CI 与 v7.5.0-beta.0 发布构建已覆盖同一代码；稳定版只需合并 + 版本号/CHANGELOG 提交，代码不变。
- 建议在合并后的 main 上再触发一次 CI（push main 会自动触发），确认 release commit 的 SHA 也绿。

---

## 9. CHANGELOG 补充记录与建议结构

### 9.1 补充结果（2026-11-08）

`v7.5.0-beta.0` 的 GitHub Release 公告与 `CHANGELOG.md` 已从「仅覆盖 beta 最后一段」扩展为覆盖 `v7.3.2-beta.1..beta` 的完整 24 个提交，已补齐：

- 超大重构（画布/持久化/运行时权威/EDIT 内核/Provider 预算）；
- MCP HTTP/SSE 与管理 API；
- 离线/气隙网络屏蔽；
- Git 轮询客户端池与退避；
- EDIT 平台路径别名修复；
- 因果顺序 / 大纲跳转 / 输入区灯箱修复；
- 停用 `<todo_rules>` 与 `rules.yaml` 2.1.0；
- 完成态绿勾、行为与快捷键、ESC 撤销、编辑器/预览/会话记忆、端口/监听地址快速重置、上下文预算与压缩水位。

当前 `v7.5.0-beta.0` 公告已能完整说明本次 beta 的实际内容。稳定版 `v7.5.0` 仍建议在此基础上写一个面向稳定通道的汇总段落，而不是直接复制 beta 标题。

### 9.2 建议的 v7.5.0 稳定版 CHANGELOG 结构

按项目模板，英文整段在前、单独 `---`、中文整段在后，直接列功能与修复，不展开源码机理。建议分类：

1. **Session Canvas & Persistence**：身份/因果顺序/单一 reducer/display v4/partial 恢复/缓存 schema 16。
2. **Runtime Authority & Reconnect**：`/chat/runtime`、replay、epoch、多实例、busy 状态。
3. **Turn Steering, Queue & Todo**：原子状态机、admit、anchor、rewind、revision CAS、队列卡。
4. **History Deduplication & Rewind**：单行幂等、身份回溯、幽灵卡清理。
5. **Frontend Rendering & UX**：思考/正文、旧历史倒灌、SSE、抖动、代码围栏、表格、灯箱、完成绿勾。
6. **Settings, Shortcuts & Sidebar**：行为与快捷键、ESC、回焦、5 条折叠、右键多选。
7. **Editor, Preview & Navigation Memory**：标签现场、磁盘刷新、冲突条、会话/侧栏记忆。
8. **Provider & Tool Schema**：四协议、Gemini/Kimi、strict、union。
9. **Thinking Budget & Compaction**：`max_tokens` 能力上限、动态输出预算、水位、artifact 压缩连续性。
10. **EDIT Tool Hardening**：原子写、锁、敏感路径、平台别名、历史内存。
11. **MCP, Offline & Git Polling**：HTTP/SSE MCP、气隙屏蔽、限流退避。
12. **Prompts & Documentation**：init 2.2.0、rules 2.1.0、todo_rules 停用、teaches 同步。
13. **i18n**：11 语言目录补齐。

> 如果产品希望稳定版说明覆盖「上一个稳定版 v7.2.8 以来」的全部内容，建议在 v7.5.0 段落中增加一句「本版本汇总 7.3.x 全部 beta 能力」，并保留 CHANGELOG 中已有 7.3.x 段落作为明细；不要把 178 个提交逐条搬进稳定版说明。

---

## 10. 发布操作清单（建议）

> 本报告最初只做分析；`v7.5.0-beta.0` 的 GitHub Release 公告与 `CHANGELOG.md` 已在 2026-11-08 补充更新。稳定版合并、版本 bump、tag 与 push 尚未执行，待你确认版本号后继续。

1. **确认版本号**：建议 `v7.5.0`。当前 `7.5.0-beta.0` 直接跑 `npm run bump:patch` 会得到 `7.5.1`，`npm run bump:minor` 会得到 `7.6.0`，都不对；应显式执行：
   ```bash
   node scripts/bump-version.js 7.5.0
   ```
2. **合并 beta 到 main**（fast-forward）：
   ```bash
   git checkout main
   git merge --ff-only beta
   ```
3. **写 CHANGELOG v7.5.0**：按第 9 节结构补齐英文 + `---` + 中文；确保覆盖 main 上 11 个未发版提交。
4. **格式化检查**：本次 release commit 只改版本号/CHANGELOG，不涉及 Rust 代码；若同时有任何代码改动，执行 `cargo fmt --all`.
5. **提交 release commit**：
   - 标题：`chore(release): release v7.5.0`
   - 正文：英文完整段 → 单独 `---` → 中文完整段
   - 末尾保留：
     ```text
     Co-Authored-By: JeikCode <code@jeikcode.top>
     ```
6. **推送 main**：
   ```bash
   git push origin main
   ```
7. **打标签并推送**：
   ```bash
   git tag v7.5.0
   git push origin v7.5.0
   ```
8. **监控发布流水线**：
   ```bash
   gh run list --limit 3
   ```
   确认 `Build and Release` 对应 `v7.5.0` 已进入 `in_progress` 即可结项；轮询之间按项目规范等待 180 秒，不要无限长轮询。
9. **发布后同步 beta（建议）**：
   ```bash
   git checkout beta
   git merge --ff-only main
   git push origin beta
   ```
   这样 beta 也带上 `v7.5.0` 的版本号与 CHANGELOG，下一次 beta bump 不会从旧版本号起算。

---

## 11. 风险与待确认

1. **版本号口径**：`v7.5.0` 是否确认？如果希望以 `v7.5.1` 或 `v7.6.0` 发布，需要改 bump 参数与 CHANGELOG 标题。
2. **CHANGELOG 覆盖范围**：`v7.5.0-beta.0` 已按 `v7.3.2-beta.1..beta` 的 24 个提交补齐；稳定版是否再覆盖 `v7.2.8..beta` 的 178 个提交，只需增加一句「汇总 7.3.x 全部 beta 能力」，不建议逐条罗列历史 beta。
3. **超大重构回归面**：画布/持久化/运行时权威改动面最大；beta 顶端 CI 与六平台发布构建已通过，但稳定版仍应在 push main 后确认 CI 绿。
4. **缓存 schema 升级**：`CACHE_SCHEMA = 16` 会让旧 IndexedDB 画布缓存整体作废并重新水合；用户升级后首次打开会话可能出现一次冷启动加载，这是预期行为。
5. **不要复用 beta 标签 SHA**：`v7.5.0-beta.0` 指向 `59746b3f1`，该提交的 native portability 曾失败；稳定版必须包含 `0e2c2f0f4` 的测试修复后再打 tag。
6. **origin/main 落后 191 个提交**：push main 会一次性更新大量历史；确认远端分支保护/权限允许，且没有其他人正在 main 上工作。
7. **发布后 beta 同步**：如果不把 main 合回 beta，beta 的 CHANGELOG/版本号会落后；建议按第 10 节第 9 步执行。

---

## 附录 A：关键提交索引

### A.1 `main` → `beta`（13 个）

```text
0e2c2f0f4 test(coding): align persona snapshot assertions with modernized identity prompt
59746b3f1 docs(changelog): record release notes for v7.5.0-beta.0
0e23f9e15 feat(prompt): modernize system environment facts and precedence hierarchy
d25da2c93 fix(session,webui): converge steer replay anchors, identity-based rewind, and active display state
cc21c9778 fix(chat): keep one history row per admitted user prompt
84a4c6965 feat(settings): add behavior & shortcuts with an ESC undo preference
bceca69dc feat(webui): restore sidebar session folding and add context-menu multi-select
a1fc17d82 fix(chat): restore composer focus after sending
e9aa8d8db refactor(steer): atomically admit intents and recover interrupted streams
a43519d01 feat(provider): align four protocol tool schemas with OpenCode
fe12d8fa0 fix(todo,chat): preserve live todo and steer state across refresh and validate task actions
85aa3ca75 chore(release): bump version to v7.5.0-beta.0
879f83f21 refactor(state): add monotonic revision arbitration across todo, queue, and canvas cache
```

### A.2 `v7.3.2-beta.1` → `main`（11 个，含 2 个合并）

```text
3eefee292 fix(prompt): update persona snapshot tests for the disabled todo_rules block
ca48b992f refactor(prompt): disable the todo_rules block and tighten system rules
23c1b7a99 fix(webui,daemon): preserve causal steer order on session switch, keep canvas on outline jump, and fix input image lightbox
c9a7904c3 feat(git_polling): pool http clients and add rate-limit backoff with jitter (#75)
f447720c7 fix(task): use Deny for offline network egress instead of DenyTurn
94d359272 feat(capabilities): enforce air-gap offline network shielding and test serialization (#74)
c7d5659c9 fix(edit): allow explicit sensitive paths under platform path aliases
2f0984f59 refactor(webui,daemon): overhaul session canvas identity, runtime authority, and persistence
6e2e9631d feat(mcp,cli,daemon): add HTTP MCP support, programmatic server removal, and management API
c2560fce4 merge: integrate canvas overhaul into beta
1bf25336c Merge pull request #80 from modded-soldier-9/feat/mcp-server-management-and-http-support
```

### A.3 超大重构验证记录（来自提交说明）

```text
cargo check --lib -p jeikcode-daemon
cargo test -p jeikcode-capabilities --features session --lib inputs::tests   (8 passed)
cargo fmt --all -- --check
cd webui && npx tsc --noEmit
cd webui && node --test src/lib/canvas/*.test.ts                            (24 passed)
```

原始 113 个提交尖端保留在 `backup/refactor-canvas-overhaul-pre-squash-20261107`。

---

## 附录 B：可直接复用的「发布前检查」勾选项

- [ ] 版本号确认 `v7.5.0`
- [ ] `beta` → `main` fast-forward 成功
- [ ] `CHANGELOG.md` 新增 v7.5.0 中英双段，覆盖 main 上 11 个提交
- [ ] 三份 README 不需要复制 CHANGELOG（保持权威引用）
- [ ] release commit 包含 `Co-Authored-By: JeikCode <code@jeikcode.top>`
- [ ] push main 后 CI 绿
- [ ] `v7.5.0` tag 指向包含 `0e2c2f0f4` 的 main SHA
- [ ] `Build and Release` 工作流进入 `in_progress`
- [ ] 发布后 `main` 合回 `beta`
