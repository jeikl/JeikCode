# 系统事件提示：位置、叠加与超时误判诊断报告

- **日期**：2026-11-19
- **分支**：`beta`
- **基线**：`ffe20fb2f`（最新提交）
- **范围**：断网重试、压缩、限流、系统错误等所有“系统类提示/通知/错误”的展示与持久化
- **结论**：运行态收尾问题已由 `ffe20fb2f` 修复主链路；**提示位置错乱与事件身份缺失仍未修复**，需要按“系统事件部件化”统一改造。

---

## 1. 用户反馈问题

1. 重试/异常提示出现在回合**开头**，而不是发生断网的那个模型部件之后。
2. 同一条提示**文本叠加**（如 `1/9` 与 `5/9` 连在一起），或停留在 `1/9` 不更新。
3. 长上下文下，思考结束后本应出现「断网卡」，实际只看到**两个连续的思考块**，卡片消失。
4. 回合结束后**停止按钮停不下来**，需要刷新、切前台或截图才恢复。
5. 模型思考完、准备正文/工具时停顿较久，被误判为**滑动超时**而不是等待超时。

---

## 2. 浏览器实机测试

### 2.1 环境

| 项 | 值 |
| :--- | :--- |
| 服务端 | 当前代码构建的 debug daemon（`cargo build --bin jeikcode`） |
| 端口 | `127.0.0.1:13480` |
| 隔离配置 | `JEIKCODE_HOME=F:/temp/jc-e2e` |
| 浏览器 | Chrome DevTools 实机操作 |
| 测试会话 | `339e34d4-0508-4592-a4fa-16a6ba2fbe4d` |

### 2.2 用例

1. 新建**空白会话**（URL 无 `session`，页面显示「今天想构建点什么？」）。
2. 发送任务：`200 轮串行读取，每轮只发起一个 read 工具调用（limit: 1）`。
3. 发送后约 **1 秒**，用户**物理断网 10 秒**再恢复。
4. 观察实时画面；随后刷新页面再次观察。

### 2.3 实测证据

- 断网期间服务端继续执行：累计读取从 `50` 增至 `57`，恢复后页面补齐并继续。
- 页面出现**两张完全相同的**：

  ```
  连接中断，已保留当前输出，重试 1/9 次
  ```

- 两张卡均位于**提问正下方**，在思考、Glob、Read 之前。
- 刷新后两张卡**仍在最上方**，位置不变；模型部件仍在下方。
- 两张卡对应**两次独立断网事件**（不同轮），不是同一次事件的重复渲染。
- 服务端最终处于运行状态，读取继续推进，说明这不是“客户端补齐失败”，而是展示坐标错误。

---

## 3. 预期顺序 vs 实际顺序

### 3.1 预期

```text
用户提问
A.thinking
🔵 连接中断，重试 1/9 → … → 终态      ← 第一次断网，锚定 A
B.thinking
🔵 连接中断，重试 1/9 → … → 终态      ← 第二次断网，锚定 B
Glob
Read × 200
最终汇总
```

### 3.2 实际

```text
用户提问
🔵 连接中断，重试 1/9
🔵 连接中断，重试 1/9
A.thinking
Glob
Read × 200
最终汇总
```

**结论**：卡片数量本身不是错误（两次断网两张卡是正确语义）；错误在于**两张卡都丢失了锚点，被按写入顺序排到了本轮内容之前**。

---

## 4. 诊断

### 4.1 位置错误：账本有两个写入者，`seq` 按写入时刻分配

相关代码：

- `crates/jeikcode-capabilities/src/session/display.rs`
  - `append_display_notice`：回合中途追加通知，`seq = last_seq + 1`
  - `append_display_turn`：回合结束时由显示钩子整批写入本轮消息
  - `DisplayHook` 在 `turn_complete` 时调用 `append_display_turn`

时序：

```text
回合开始        user 记录写入          seq = N
回合中途        重试/压缩通知写入      seq = N+1   ← 本轮助手记录尚不存在
回合结束        思考/正文/工具整批写入  seq = N+2 … N+k
```

刷新/对账按 `seq` 排序 → 通知（`N+1`）必然排到本轮所有内容之前。

**这不是前端计算错误，而是通知获得了一个比它所描述内容更早的持久坐标。**

> **补充（实时阶段为何在刷新前就已经置顶）**：  
> 实机在**未刷新前**同样看到卡片插到 `A.thinking` / `Glob` 之前，直接推手在于 `webui/src/lib/canvas/actions.ts` 的 `authoritative_notice` 插入逻辑混用了两套不一致的 `seq` 坐标系：  
> 1. 实时阶段助手与工具行尚未写入 `display.jsonl`，`canvasStore.ts` 的 `normalizeCanvas` 会为它们在本地按数组顺序合成递增 `seq`；  
> 2. 服务端 `append_display_notice` 却只看到账本里已落盘的记录并分配 `last_seq + 1`；  
> 3. `actions.ts` 使用 `rows.findIndex(r => r.seq > action.seq)` 查找插槽，**只要该通知的账本 `display_seq` 小于画布上已有某条实时行的本地合成 `seq`**，就会命中那条更早的实时行并把它倒插到前面（具体落在 `A` 之前还是某个工具之前取决于当时的序差时序）。此外若发生 `OpenTransient` 失败（如 `agent.rs` 在 HTTP 流打开前失败），此时尚未发射 `AgentEvent::AssistantMessage`，`notice_anchor()` 退回到提问本身也是正确语义（此时尚无 `A.thinking`）；只有已产出部分内容的 `StreamDrop`/`Stall` 才应锚定于对应 `A` 之后。

### 4.2 叠加/不更新：事件身份与终态闭合的真实成因

- 重试事件 id 由 `turn-{turn_id}-r{round}:retry` 生成：在“第 1 轮断网恢复后，第 N 轮再次断网”场景下生成两个不同 id 并各自从 `1/9` 开始**属于正确语义**，本身不是导致不更新的 bug；
- 同一事件在文案发生变化时（如进度从 `1/9 → 2/9`）会向 `display.jsonl` 追加新记录（仅同 `(id, content)` 有尾部窗口幂等去重，进度递增仍不断 append 并推高 `last_seq` 与分页跨度）；同页内 `normalizeCanvas` 按“位置 = 首次出现、内容 = 最后一次出现”合并，但在跨分页切片时仍会导致位置锚点与最新文案被页边界割裂；
- 真正导致进度停在 `1/9` 不更新的，是此前 `authoritative_notice` 的 `const next` 变量遮蔽直接丢弃了覆写结果（`ffe20fb2f` 已修复），以及实时流与账本 id 未对齐/重试未落新文案；
- **补充遗漏 1（重试耗尽终态仍裂成两张卡）**：`RetryEngine` 虽然为每次重试维护了 `incident_id`，但当预算耗尽失败退出时（`agent.rs` 的 `OpenTransient` / `Stall` / `StreamDrop` 耗尽分支），内核转为发射不带 `incident_id` 的 `AgentEvent::Error` 与 `Self::persist_turn_diagnostic(...)`，**并未复用原 `incident_id` 把原卡改写为终态错误**；即便前端支持原地覆写，重试失败时仍会残留“卡在 `9/9` 的进度卡 + 一张新增错误卡”；
- **补充遗漏 2（漏网重试路径）**：目前仅 `OpenTransient`、`Stall`、`StreamDrop` 走了 `AgentEvent::RetryNotice`；`FirstToken` 超时重试与 `EmptyResponse`（含只返回思考 / 空响应 / 格式异常）重试**仍在直接发 `AgentEvent::Warning`**，`429 RateLimited` 也独立走诊断写入，均尚未并入统一的带身份通知通道；
- 实时卡与账本卡一度使用不同 id，前端无法识别为同一张卡（已通过 `${noticeId}:1:notice` 对齐部分链路）。

### 4.3 两个思考块之间缺卡：通知没有锚点

- 通知只带 `notice_id`/`part_id`，没有 `anchor_message_id`；
- daemon 的锚点来自可变游标 `notice_anchor()`（当前流式消息 id）；
- 断流续写后“当前消息”变成 B，A 又可能不在当前窗口；
- 实时卡在无合适锚点或未匹配 `seq` 时容易回退到尾部或与实时行错位；刷新后又被过小的 `seq` 推到开头。

### 4.4 停不下来：终帧丢失后无权威收尾

- 终帧丢失/断流后，本地 busy 标记阻挡了磁盘对账与空闲订阅；
- `/chat/runtime` 的短 TTL 缓存可能返回旧状态；
- 焦点/截图触发的权威对账是当时唯一的兜底。

**状态**：`ffe20fb2f` 已修主链路（`runtime_status_for_session` 尊重 `terminal_reached`、`/chat/watch` 与 `/live` 对齐补发 `ChatEvent::State` 权威握手、移除 `/chat/runtime` 与 `/chat/active` 的 TTL 缓存、`done` 有限确认、停止按钮 `watchOnly` 隔离与手动停止保护窗）。`busyWatchdog` 仍保留为最终传输挂死兜底。

### 4.5 超时误判：思考相使用滑动预算

相关代码：

- `crates/jeikcode-kernel/src/timeouts.rs`：`phase_limit(Thinking | Streaming) = streaming`
- `crates/jeikcode-kernel/src/agent.rs`：
  - 出现任意思考增量 → `phase = Thinking`
  - 出现任意正文/工具增量 → `phase = Streaming`
  - `Thinking` 超时 → 切到 `Transition` 并重置
  - 其余超时 → 失败/重试

因此：

- 纯思考、未出过正文/工具：`120s` 后进入 `Transition`，再等 `180s`，合计 `300s` 才失败；
- 出过一点点正文或工具增量后停顿：直接按 `streaming` 滑动窗口（旧 `120s`）失败/重试。

`976c7cee0` 已将 `transition` 与 `streaming` 默认值提升到 `360s`，属于**配置缓解**；相位逻辑未修，完全静默的“思考→正文”间隙最长仍可能 `720s`（Thinking 360 + Transition 360）。

---

## 5. 横向排查：同型问题

| 问题 | 原因 |
| :--- | :--- |
| 压缩提示也会跑到开头 | 压缩走同一条“回合中途写账本”路径 |
| 压缩提示可能双写 | `/chat` 与 `/live` 两个投影器各自持久化 |
| 限流/错误可能出现两张 | 一张实时卡 + 一条诊断记录，身份不同 |
| 压缩/旧提示靠文案识别 | `isCompactionDoneNotice`、`TRANSIENT_ADVISORY_MARKERS` 多语言前缀匹配 |
| 跨实例/冷启动位置不一致 | 缺少统一事件身份与锚点，缓存与账本各有一套去重 |
| 同事件冗余 append / 终态分裂 | 同 id 进度变更每次追加新行推高 `last_seq`，跨分页位置与内容割裂；重试耗尽发新 `Error` 而不闭合原 `incident_id` |
| 断网卡在长上下文中消失 | 锚点不在当前窗口时没有挂起队列，回退到尾部或丢失；`FirstToken`/`EmptyResponse` 仍走 `Warning` |

---

## 6. 修复方案

### P0 事件模型：系统事件 = 消息部件

```ts
NoticePart {
  kind: 'notice'
  eventId: string                 // 一个事件一个，永不复用
  partId: string                  // {anchorMessageId}:{slot}:notice
  noticeKind: 'retry' | 'compaction' | 'rate_limit' | 'error' | 'warning' | 'command'
  severity: 'info' | 'warning' | 'error'
  status: 'active' | 'settled'
  revision: number
  text: string
  anchorMessageId?: string
  anchorPartId?: string
  turnId: string
}
```

规则：

- 一个事件一张卡；同 `partId` 只覆写，不新增；
- `status=settled` 后拒绝后续进度覆盖；
- 不同事件各自成卡（一个回合两次断网 = 两张卡）。

### P1 单写入口与锚点落盘

```text
事件发生
  ├─ 实时下发（不写账本）
  └─ 按 eventId 缓冲（同 id 只保留最新 revision）

回合结束（显示钩子，唯一写入者）
  ├─ 先写本轮消息记录
  ├─ 按锚点插入事件卡
  ├─ 同锚点按 slot 排序
  └─ 统一分配 seq → 一次性追加
```

- 删除回合中途的 `append_display_notice`；
- 回合外手动压缩：无待写记录，立即落盘；
- `/chat` 与 `/live` 只负责把事件送入缓冲，不再各自持久化；
- **关键边界补充（防长回合压缩抹掉锚点 & 崩溃/取消丢卡）**：  
  1. 200 轮长回合若触发**回合内自动压缩**，`convo.messages` 中的前置轮次会被摘要替换。若完全等到大回合 `turn_complete` 才一次性写 `display.jsonl`，早期轮次所锚定的 `anchorMessageId = A` 在压缩后已从 `convo.messages` 消失，事件卡将失去目标锚点；且长回合中途进程重启或用户取消（`StopReason::Cancelled` 走 `write_cancelled_user` 回滚）会彻底丢失纯内存缓冲中的通知。  
  2. 因此“单写入口”应保证**写权限与顺序分配仍由 `DisplayHook`（及同一账本锁内的检查点）唯一掌控**，但刷新落盘时机必须绑定 **每轮/工具批结算点、回合内压缩提交前、Partial 持久化与取消/终态钩子**，在被压缩或回滚清理前先把已产出的前置切片连同其锚定事件卡顺序落盘；
  3. **切片级幂等与记录去重约束**：现行 `append_display_turn` 仅以整回合 `completed_prompt_ids` 作为幂等锁且不对助手/工具记录 `id` 去重——改成阶段性分段追加后，必须拆分出 **切片级幂等键**（如 `turn_id + round/batch_ordinal`）与单记录身份去重，并把 `completed_prompt_ids` 保留给整回合终态；否则第 1 轮提前落盘就会把后续第 2–200 轮拦掉，或在同一轮重试重入时重复落盘。

### P2 线上协议统一

- 新增 `system_notice` 帧，两个通道共用（同时把 `FirstToken`、`EmptyResponse`、`RateLimited` 统一收敛进来）；
- **重试耗尽必须复用同一 `incident_id` / `eventId` 发送 `status: 'settled', severity: 'error'` 闭合原卡**，终态控制事件（`Done` / `Error` / `Stopped`）不再额外制造第二张重复诊断卡；
- 终端控制事件（`Done` / `Error` / `Stopped`）与展示卡彻底分离；
- 提示文案区分 `stall`（等待超时）与 `drop`（连接中断）。

### P3 前端投影与缓存

- 同 `partId` → 原地覆写；新 `partId` → 按锚点插入；
- **废弃 `authoritative_notice` 中靠 `rows.findIndex(r => r.seq > action.seq)` 找位置的逻辑**：实时阶段禁止用账本 `display_seq` 对比前端合成 `seq`，全部改按 `anchorMessageId` + `slot` 归位；
- 锚点不在当前窗口 → `pendingAnchoredEvents`，窗口加载后归位，绝不静默丢弃；
- 瞬时卡无 `seq`、不参与磁盘合并；账本卡持久并按 `seq` 还原；
- 历史同 `eventId` 取最后一条（同时保留首次因果位置）；
- 删除文案启发式与“同 id 跳过”。

### P4 迁移与清理

- `DisplayRecord` 增加 `event_id`、`part_id`、`anchor_message_id`、`anchor_part_id`、`revision`、`severity`、`status`；
- `DISPLAY_VERSION` 升到 5，读取时惰性升级；
- v4 通知：`eventId = 原 id`、无锚点 → 重挂到所属回合末尾；
- 删除：`seq+0.5`、双投影器双写、`isCompactionDoneNotice`、`hasRecentCompactionNotice`、`TRANSIENT_ADVISORY_MARKERS`；待确认 SSE/WS 活性超时断开与 `ChatEvent::State` 重连收敛完全闭环无盲区后，再移除 `busyWatchdog`。

### P5 验收

- 200 轮 + 两次断网：

  ```text
  提问 → A.thinking → 卡1 → B.thinking → 卡2 → Glob → Read… → 汇总
  ```

- 卡片进度 `1/9 → 9/9` 原地更新；
- 刷新、冷启动、重连、双实例顺序与文案一致；
- 停止按钮在权威空闲后一个往返内复位，无轮询；
- 思考→正文停顿只触发 `transition`，不被滑动窗口误判；
- 全绿后编译 debug 成品。

---

## 7. 验收矩阵

| 场景 | 断言 |
| :--- | :--- |
| 一次断网 | 一张卡，位置在失败尝试之后，进度原地更新 |
| 一回合两次断网 | 两张卡，各自在对应位置 |
| 长上下文跨窗口 | 锚点不在窗口时挂起，加载后归位，不丢 |
| 压缩中途 | 分隔条落在压缩发生的那一轮之后 |
| 限流 | 同卡倒计时覆写，不新增 |
| 终态错误 | 同卡改写为错误，不再被进度覆盖 |
| 刷新/冷启动 | 位置、数量、文案与实时一致 |
| 断网重连 | 只补差量，无重复卡，无轮询 |
| 双实例 | 两端一致，同 id 覆写 |
| 200 轮长回合 | 无置顶、无叠加、无串接 |

---

## 8. 当前进度

| 提交 | 内容 | 状态 |
| :--- | :--- | :--- |
| `96bb739c8` | 统一重试阶梯与断流续写 | 已完成 |
| `466c65445` | 重试提示落盘、部件 id、终态恢复、首帧 `state` | 已完成 |
| `a2beed974` | 部分回复超时文案本地化 | 已完成 |
| `976c7cee0` | `transition`/`streaming` 默认值提升到 360s | 已完成（配置缓解） |
| `ffe20fb2f` | 运行态权威收尾、停止按钮、同 id 覆写、持久通知保留 | 已完成 |
| 本次提交 | P0–P4：统一 `SystemNotice` 契约、Think→Transition 预算修正在内、Display v5 切片幂等与单写入口、因果锚点与缺席队列、移除文案启发式与双写 | **已完成**（单测/构建/Debug 成品已验证；`busyWatchdog` 按约定暂留待线下 200 轮实测闭环后清理） |

旧 provider 的“不重放”策略已在 `96bb739c8` 中移除；当前断流会保留部分输出并按统一阶梯续写。

关于 P5 验收与验证范围：已完成 Rust 单元测试与集成测试（`jeikcode-kernel` 42 项、`jeikcode-capabilities` display 30 项、`jeikcode-coding` 10 项、`jeikcode-daemon` 相关 25 项）、`webui` 全量单测（967/967）与 `npm run build`、以及 `target/debug/jeikcode.exe` 重编；物理断网长回合真机联调待线下实测验证。

---

## 9. 风险与边界

- `Thinking` 当前使用 `streaming` 预算，再进入 `Transition`；在配置层提升到 360s 后，最坏静默等待为 720s。根治需要在 P1 中按相位分配预算，避免重复计时。
- 若仅把所有通知缓存到 `turn_complete` 一次性写盘，长回合内的**自动压缩**会先裁掉前置轮次消息导致锚点丢失，且**进程重启/用户取消**会抹掉纯内存提示；必须让账本按轮/压缩点提前锁定前置切片与关联通知。
- `OpenTransient` 与首个 token 前的超时发生在 `AssistantMessage` 建立之前，此类通知天然锚定于用户提问（或上一可见节点）之后，不应强行预设 `A.thinking` 锚点。
- 旧 v4 通知没有锚点，迁移只能重挂到回合末尾；历史位置无法完全还原，但不会再置顶。
- 浏览器网络模拟（CDP offline）只会挂起已有流，真正断线需要物理断网或强制 abort；本报告中的关键证据来自用户物理断网。

---

## 附录 A：超时档位

| 档位 | 默认 | 计时对象 | 配置项 |
| :--- | :--- | :--- | :--- |
| `connect` | 10s | TCP/TLS 建连 | `connect_timeout_secs` |
| `open` | 180s | HTTP 响应头 | `open_timeout_secs` |
| `ttft` | 180s | 首个业务 token | `ttft_secs` |
| `transition` | 360s | 思考结束到首个正文/工具 token | `transition_secs` |
| `streaming` | 360s | 相邻业务 token 之间 | `streaming_sliding_secs` |

重试：首 token 最多 6 次（可配 `first_token_timeout_retries`）；流空闲 `Stall` 最多 9 次；阶梯固定 `[0,2,5,10,15,30,45,60,90]` 秒，累计 257 秒。

## 附录 B：关键文案

| 场景 | 中文 | 英文 |
| :--- | :--- | :--- |
| 重试进度 | `连接中断,已保留当前输出,重试 {x}/{max} 次` | `Connection interrupted; current output preserved; retry {x}/{max}` |
| 部分回复后超时 | `流在已产生部分回复后超时；已保留部分回复，可继续。` | `Stream timeout after partial response; the partial response was preserved and can be continued.` |
| 普通中断 | `网络连接中断:远端关闭或重置了连接,可重试。` | `Network connection interrupted: remote host closed or reset connection. You can retry.` |
| 重试耗尽 | `网络连接中断:…自动重连 {attempts} 次后仍失败,可重试。` | `Network connection interrupted: …, reconnect failed after {attempts} attempts. You can retry.` |

## 附录 C：复现步骤

1. 使用包含 `ffe20fb2f` 的构建启动 daemon（隔离 HOME 可选）。
2. 打开 WebUI，新建空白会话。
3. 发送 200 轮串行读取任务。
4. 发送后约 1 秒物理断网 10 秒，再恢复。
5. 观察提示位置与数量；刷新页面再次观察。
6. 预期（修复后）：提示出现在对应思考块之后，进度原地更新，刷新位置不变。
