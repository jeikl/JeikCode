# 目标架构与当前收口方向

> 状态：当前有效的方向性约束。
>
> core driver 协议、v1 engine、`jeikcode-bridge` 与 `jeikcode-core` 已退役，当前 workspace
> 不再包含 core。本文描述现有 Driver → coding runtime → kernel 边界及后续约束，
> 不把历史迁移计划当作当前实现。目标是单一状态所有权、清晰依赖方向和可验证兼容性。

## 1. 当前目标调用链

```text
CLI / TUI / daemon / background / ACP / clix code
                    │
                    ▼
       CodingRuntimeHandle / DriverCommand
                    │
                    ▼
       jeikcode-coding (CodingRuntime)
                    │
                    ▼
          jeikcode-kernel Agent
```

`jeikcode-review` 等其他 L2 可以装配并驱动自己的 kernel agent；但每个业务只能有一个明确的
运行时 owner，不能让 driver、adapter 和 L2 同时持有多套 live `AgentHandle`。

## 2. 分层与依赖方向

```text
kernel ← capabilities ← L2 specialization ← frontend/transport

叶子基础设施：config、auth、telemetry、updater 等按职责被上层依赖
兼容边界：legacy session importer，只允许从旧格式流向当前模型
```

| 层 | 拥有 | 禁止 |
|---|---|---|
| `jeikcode-kernel` | 中立 agent 循环、hook/middleware/tool/provider trait、kernel message/event | coding、approval、plan、plugin、具体 provider/tool 实现 |
| `jeikcode-capabilities` | provider、tools、MCP、skills、session、memory、codeintel 等可复用能力 | 依赖 core、L2 或前端；读取前端状态 |
| `jeikcode-coding` | coding persona、runtime 生命周期、provider/session reassemble、goal/loop、审批协调 | 依赖 core；UI、HTTP、终端渲染 |
| CLI/TUI/daemon | 输入、展示、HTTP/WS/SSE、本地明确操作、历史格式接入 | 第二 runtime owner；把 coding 生命周期直接塞进 kernel 命令 |
| 历史兼容边界 | capabilities session store 的显式历史导入 | 恢复 core、旧 driver 协议、bridge 或 runtime fallback |

编译期不变量：

- kernel 不依赖 capabilities、L2 或前端；
- capabilities 不依赖 core、L2 或前端；
- coding 不依赖 core 或前端；
- frontend 可以依赖 L2 和叶子基础设施，但不得持有第二套业务 runtime。

## 3. Runtime 所有权

`CodingRuntime` 统一拥有：

- live agent、config、parts、provider、session binding；
- generation、pending request、snapshot broker；
- submit/steer/cancel/approval/request/compact；
- provider/model reload、fresh/resume/restore/undo/cd；
- goal/self-paced loop 和 shutdown。

driver 可以执行不需要运行中状态的本地操作。凡是会改变 conversation、snapshot、provider、
session binding 或 agent generation 的行为，必须通过 runtime 的显式事务完成，不能用本地文件写入
绕过 runtime。

kernel `AgentCommand/AgentEvent` 是运行时执行边界，不是承载所有产品命令的公共总线。

## 4. 当前持久化与兼容边界

### 4.1 Native session 聚合

`crates/jeikcode-capabilities/src/session/manager.rs` 管理 snapshot、meta、presentation
与 jsonl 等独立持久化表面：snapshot 用于 kernel working-set 恢复，meta 用于目录与命名等
元数据，presentation 用于 UI 展示，jsonl 用于逐回合 transcript / recall。这些不是多套
live conversation owner。

`crates/jeikcode-coding/src/parts.rs` 的 `SessionBinding` 绑定 identity、manager、lease
与恢复 snapshot；`runtime.rs` 负责发布、恢复与重配置。历史 JSON 通过显式 importer 与
native commit 边界接入，不再由已删除的 core 进行 live 双写。

### 4.2 后续收口原则

后续兼容清理必须由真实消费者决定，保护 session lease、聚合提交与展示/模型状态的职责分离。
不能为了删除历史文件而绕过 importer 的冲突检查或把 UI presentation 塞回 kernel working set。
只移动文件、增加 facade 或保留两份实现不算收口。

### 4.3 Prefix 与热重载的待裁决边界

当前 `SessionContextHook` 删除旧的独立 baseline block；环境事实由 persona 的
`<environment>` 注入，Git branch 在 persona 组装时采样。项目指令在 turn boundary
通过 `reconcile_frozen_user_block` 更新：文件不变时无操作，文件改变时会替换受保护 block。
因此 `frozen` / `sacred_floor` 表示压缩保护，不代表显式热重载期间字节不可变。
AGENTS.md 的 append-only 要求与 live reload 例外仍需单独裁决；本次清理只记录现状，
不修改规则或运行时语义。

## 5. Protocol 与 foundation 的决策门槛

不预设先创建 `jeikcode-protocol`。只有同时出现以下需求之一时才拆纯协议叶子：

- HTTP/WS 对外 schema 需要独立版本；
- 非 Rust 客户端需要稳定 codegen；
- kernel 类型演进已对外部消费者造成实际耦合。

拆分前应先证明现有 kernel/coding 中立类型不能满足需求，且新 crate 会删除现有重复协议，而不是
再增加一套类型。

不创建大而全的 `jeikcode-foundation`。config、auth、plugin、session、transport、process utilities
应按内聚职责复用现有叶子 crate 或单独拆分；目标是减少耦合，不是把 core 改名。

## 6. 收口顺序

1. 保持 native session 聚合、恢复与历史 importer 的一致性；
2. 保持 Driver 只通过 runtime 事务改变运行中状态；
3. 按实际消费者继续收口 plugin、live transport、MCP host 等边界；
4. 仅在消费者归零且兼容语义得到验证后删除旧路径；不得重新引入 core / bridge fallback。

每个垂直切片必须实际减少至少一项：状态 owner、数据模型、转换链、直接依赖或 fallback。
不得以移动文件、增加 facade、新建 crate 或净删除行数冒充架构进度。

## 7. 兼容与失败原则

- 历史格式读取必须有显式 schema/字段映射和真实 fixture 测试；
- importer 必须幂等，导入失败不得覆盖旧文件或生成可被误判为成功的半成品；
- legacy 与 native 同时存在时必须有明确冲突规则，禁止按 mtime 猜测后静默覆盖；
- runtime rebuild 失败必须显式失败或回滚，禁止 silent fresh、空 snapshot、noop handle；
- pending approval/request 在 cancel、reload、session switch 和 shutdown 时 fail-closed；
- 旧 generation 的迟到事件不得进入 replacement runtime；
- 未删除旧 writer、handler、依赖或 fallback 时必须明确“尚未退役”。
