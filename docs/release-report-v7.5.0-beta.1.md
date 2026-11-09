# JeikCode v7.5.0-beta.1 增量发版报告

> 起点：`docs/release-report-v7.5.0.md` 的终点 — `beta @ 0e2c2f0f4`（2026-11-08）  
> 终点：`beta @ 1cb4e58cb`（2026-11-09），tag `v7.5.0-beta.1`  
> 增量范围：17 个提交 / 108 个文件 / +5,878 / -2,018  
> 报告生成：2026-11-09  
> 当前版本：`7.5.0-beta.1`  
> 当前状态：`v7.5.0-beta.2` 已发布；Beta native portability 全平台通过，Build and Release 构建中（详见第 11 节）

---

## 1. 结论摘要

`v7.5.0-beta.1` 是在 `v7.5.0-beta.0` 的会话画布、持久化、运行时权威与 steer 状态机重构之上的增量 beta。

本期没有新的超大重构，主要交付 9 个方向：

1. **工具搜索与审批策略**：grep/glob 可见性双开关、独立 `include_logs`、零匹配/溢出提示、旧 `*.log` 配置迁移。
2. **EDIT 工具 schema**：对外只暴露 `path`，内部兼容 `file_path` 等别名，不再改写路径字段名。
3. **技能与用户命令架构**：`SKILL.md` 技能与用户斜杠命令彻底解耦，新增共享命令注册表与 `/commands`。
4. **WebUI 因果渲染**：`streamSeq` 流式排序、回放锚定、缓存 schema 升级。
5. **WebUI 移动端与输入台**：虚拟键盘贴合、输入历史、时间线固定、内联编辑器滚动隔离。
6. **Todo 权威同步**：空清单也能作为权威状态，基于 `(daemon instance, revision)` 仲裁。
7. **Windows Shell 集成**：进程内 COM STA 调用替代外部 `explorer.exe` / `cmd.exe`。
8. **更新公告回源**：修复 Cloudflare 边缘约 10k 字符截断，完整展示 release notes。
9. **提示词清理**：移除首轮强制 `code_explore` 提醒，清理 11 种语言文案。

**发布判断：源码和 CHANGELOG 内容完整；但最新 tag 的跨平台 native CI 有一个环境相关的 `sensitive_path` 失败，正式发布前应先修复并重新跑 CI。**

---

## 2. 版本与范围

| 项目 | 值 |
| :--- | :--- |
| 起点 | `0e2c2f0f4` — `test(coding): align persona snapshot assertions with modernized identity prompt` |
| 终点 | `1cb4e58cb` — `chore(release): bump version to v7.5.0-beta.1` |
| 分支 | `beta` |
| tag | `v7.5.0-beta.1` → `1cb4e58cb` |
| 远端 tag | 已存在 `refs/tags/v7.5.0-beta.1` |
| 提交数 | 17 |
| 文件数 | 108 |
| 行数 | +5,878 / -2,018 |
| 工作区 | 代码工作区干净；本报告为新增文档 |

主要目录分布：

| 目录 | 文件数 |
| :--- | ---: |
| `webui/src` | 31 |
| `crates/jeikcode-capabilities` | 31 |
| `crates/jeikcode-config` | 12 |
| `crates/jeikcode-tuix` | 4 |
| `crates/jeikcode-coding` | 4 |
| `crates/jeikcode-daemon` | 3 |
| `desktop/src-tauri` | 3 |
| `docs` / `docs-site` / `webui` / `packages` / `functions` 等 | 其余 |

---

## 3. 提交索引

| # | 提交 | 类型 | 主题 | 文件规模 |
| ---: | :--- | :--- | :--- | :--- |
| 1 | `accf225c0` | fix | 更新公告完整回源 | 3 files, +248/-4 |
| 2 | `a1e88be5c` | fix | WebUI 输入期间时间线固定、内联编辑器滚动 | 7 files, +272/-39 |
| 3 | `faffb38fe` | fix | 输入历史仅在空输入/全选时触发 | 3 files, +51/-24 |
| 4 | `444bf383f` | feat | grep/glob 双开关搜索可见性 | 17 files, +1,421/-371 |
| 5 | `c1030c0a0` | docs | v7.5.0 发版总结报告 | 1 file, +552 |
| 6 | `a217ed60f` | fix | grep 日志可见性拆分为 `include_logs` | 8 files, +103/-46 |
| 7 | `d46c76ae5` | fix | edit 对外 `path`、内部别名兼容 | 5 files, +188/-124 |
| 8 | `9df49c4cc` | refactor | 技能指南与用户命令解耦 | 29 files, +1,119/-967 |
| 9 | `132080851` | fix | 空 Todo 清单跨重连权威同步 | 9 files, +365/-60 |
| 10 | `3a8faf903` | fix | Windows 进程内 Shell API | 7 files, +359/-77 |
| 11 | `de2a482ed` | fix | 移动端输入台贴合虚拟键盘 | 5 files, +283/-20 |
| 12 | `9d5fd99f1` | fix | 旧 `*.log` 迁移与零匹配提示共存 | 4 files, +45/-3 |
| 13 | `1139a7ec2` | fix | 流式助手轮次因果排序 | 4 files, +416/-79 |
| 14 | `48b0abb4e` | fix | 已有会话与新会话的输入历史 | 3 files, +52/-13 |
| 15 | `690950581` | fix | 回放助手帧锚定到下一个 user 之前 | 9 files, +342/-17 |
| 16 | `c542dde37` | refactor | 移除首轮 `code_explore` 提醒注入 | 16 files, +24/-197 |
| 17 | `1cb4e58cb` | chore | 版本号 bump 到 `7.5.0-beta.1` | 15 files, +102/-41 |

---

## 4. 工具搜索与审批策略

对应提交：`444bf383f`、`a217ed60f`、`9d5fd99f1`、`d46c76ae5`

### 4.1 grep / glob 可见性

- `.gitignore` / `.ignore` 不再参与搜索可见性；VCS ignore 只描述提交范围，不再让 Agent 误以为文件不存在。
- 默认过滤由 `.codegraphignore` / `.codegraignore` 噪声规则和构建/缓存/依赖目录负责。
- `grep` 默认跳过日志内容；`glob` 默认包含日志路径（路径发现成本低）。
- 零匹配时独立展示三类提示：
  - 敏感路径提示
  - 日志过滤提示
  - `.codegraphignore` 噪声提示
- 输出窗口满时按形态给建议：
  - `files_with_matches`
  - `count`
  - 缩小 `path` / `glob`
  - 单文件聚焦 `grep`
  - `read` 的 keyword 窗口

### 4.2 三个独立开关

| 开关 | 默认 | 作用 |
| :--- | :--- | :--- |
| `include_ignored` | false | 打开构建产物、缓存、依赖等非敏感过滤路径 |
| `include_logs` | false | 独立打开 grep 日志内容；`glob` 默认已包含日志路径 |
| `include_sensitive` | false | 打开敏感凭据路径；Build/AcceptEdits/Plan 需审批，Auto 自动继续 |

`include_ignored` 与 `include_logs` **互相独立**；不能再用 `include_ignored` 代替日志开关。

### 4.3 旧配置迁移

源码资产已移除 `.codegraphignore` 中单独一行 `*.log`。

启动时 `migrate_legacy_log_ignore` 会：

- 只移除独立 `*.log` 行；
- 保留用户自定义规则；
- 保证已有用户升级后 `include_logs` 与 glob 日志可见性立即生效。

### 4.4 read 与敏感路径

`read` / `grep` / `glob` 统一通过 `SensitivePathGate` 读取 `.codegraphignore.graph`：

- `include_ignored` 不会暴露敏感凭据；
- `include_sensitive=true` 需要审批（Auto 继续）；
- 显式 `read` 与搜索使用同一套敏感规则。

### 4.5 EDIT 工具 schema

- 对外 schema 只暴露 `path`。
- 内部 serde 兼容：
  - `file_path`
  - `filePath`
  - `target_file`
  - `filename`
- `normalize_edit_file_args` **不再改写路径字段名**，只修复 hunk 形状，避免污染模型调用习惯。
- edit 合并/恢复保留原始路径字段名。
- `write_approval`、`task` 作用域检查、子代理 schema 断言识别同一组别名。
- 旧的 `file_path` 调用继续可用；新调用应使用 `path`。

### 4.6 工具相关测试

本轮定向验证：

- `tools::grep::tests`：48 passed
- `tools::glob::tests`：28 passed
- `tools::edit::tests`：90 passed，1 ignored
- `argument_repair::tests`：70 passed
- `tools::write_approval::tests`：20 passed
- `tools::task::tests`：36 passed
- 旧日志迁移测试：1 passed
- 子代理挂载 schema 测试：1 passed

---

## 5. 技能与用户命令架构

对应提交：`9df49c4cc`（29 files, +1,119/-967）

### 5.1 技能注册表

- `SkillRegistry` 只加载 `*/SKILL.md` / `*/skill.md`（大小写不敏感）。
- 扁平 `*.md` 不再被当作技能，统一归入用户命令。
- 移除冗余的 `ListSkillsTool` 与 `allowed_tools`。

### 5.2 用户命令注册表

新增共享 `UserCommandRegistry`：

- 支持 `$ARGUMENTS`、`$N`、内嵌 shell 命令展开；
- 覆盖 `$JEIKCODE_HOME`、`.claude`、`.agents`、项目 `.jeikcode` 等目录；
- TUI `/skills <name> <task>` 改为提交 `use_skill(<canonical>)\n\n<task>`，不再本地展开指南模板。

### 5.3 Daemon / WebUI

- Daemon 新增 `/commands` 端点，在会话持久化前解析斜杠命令。
- WebUI 斜杠菜单直接查询可用命令，不再自行解析技能模板。

### 5.4 兼容性

这是行为边界变化：

- 以前放在技能目录里的扁平 `*.md` 需要迁移为 `*/SKILL.md`，否则会被视为用户命令；
- 用户命令与技能现在是两套独立资源。

---

## 6. WebUI 因果渲染、回放与移动端

对应提交：`a1e88be5c`、`faffb38fe`、`de2a482ed`、`1139a7ec2`、`48b0abb4e`、`690950581`

### 6.1 流式因果排序

- 流式助手轮次引入单调 `streamSeq`。
- 新 live 行插入到对应轮次之前，避免较晚订阅者导致思考/正文/工具行短暂倒挂。
- 修复多轮对话中旧回答被错误插到新问题之后的问题。

### 6.2 回放锚定

- 助手回放帧以 user 边界为锚点；
- 新提问到达时先处理 user，再回插上一轮暂存 assistant 帧；
- 窗口展开回放不再让旧回答倒挂在下一轮提问之后。

### 6.3 缓存与兼容

- 升级 canvas cache schema；
- 安全失效旧版本产生的不一致派生画布；
- 从服务端重新同步，避免旧缓存污染。

### 6.4 输入历史

- Up/Down 召回仅在输入框为空或全文选中时触发；
- 不再覆盖草稿或局部选中文本；
- 已投递提问全部记录输入历史；
- 已有会话可上下翻阅；
- 新会话首条输入在项目绑定后保持稳定 key。

### 6.5 移动端与布局

- 声明 `interactive-widget=resizes-content`；
- 动态同步 visual viewport 高度；
- 键盘弹起时消除输入台底部死区；
- 输入框 `height:auto` 计算期间冻结消息视口，避免丢失底部贴合；
- 隔离内联编辑器滚动链。

### 6.6 WebUI 测试资产

新增或加强：

- `webui/src/lib/canvas/ordering.test.ts`
- `webui/src/lib/replayFold.test.ts`
- `webui/src/lib/timelineFollow.test.ts`
- `webui/src/lib/viewport.test.ts`
- `webui/src/lib/composerLayout.test.ts`
- `webui/src/lib/stopReorder.test.ts`
- `webui/src/lib/todoWire.test.ts`

---

## 7. Todo 权威同步

对应提交：`132080851`（9 files, +365/-60）

- TodoBoard 始终序列化 `todos`，包括空数组。
- 待办项和 revision 原子返回。
- 关闭/清空/完成动作推进 revision。
- 增加 `daemon_instance_id`，daemon 重启后客户端重置 revision 水位。
- WebUI 在 `getSession` 边界统一归一化，按 `(daemon instance, revision)` 仲裁。
- 权威空板之后丢弃 replay 的旧 Todo 帧，防止旧清单死灰复燃。

行为变化：

- 空清单现在是权威状态，不再被旧缓存覆盖；
- 客户端必须理解 daemon 实例边界。

---

## 8. Windows Shell 集成

对应提交：`3a8faf903`（7 files, +359/-77）

- 新增 `crates/jeikcode-daemon/src/shell_open.rs`。
- 使用进程内 Windows Shell COM STA：
  - `SHOpenFolderAndSelectItems`
  - `ShellExecuteW`
- 不再外部拉起 `explorer.exe` 或 `cmd.exe /c start`。
- 后台分离线程异步派发，daemon HTTP handler 立即返回。
- 非致命失败静默处理，不弹无意义错误气泡。

这是 Windows 专属实现；其他平台保持原有行为。

---

## 9. 更新公告、提示词与版本发布

### 9.1 更新公告回源

对应提交：`accf225c0`（3 files, +248/-4）

- 修复 Cloudflare 边缘公告约 10k 字符处截断。
- 通过 GitHub Atom feed + REST API 回源完整正文。
- 更新弹窗完整展示版本日志。
- `functions/api/releases.js` 新增 77 行回源逻辑。

### 9.2 首轮 `code_explore` 提醒清理

对应提交：`c542dde37`（16 files, +24/-197）

- 移除 `CodeToolsFirstHook` 的首轮强制 `code_explore` 提醒注入。
- 清理 11 种语言相关 i18n 文案。
- 对齐系统提示词环境事实与测试断言。
- `code_explore` 工具本身仍然可用，只是不再强制提醒。

### 9.3 发版报告与版本 bump

对应提交：`c1030c0a0`、`1cb4e58cb`

- 新增 `docs/release-report-v7.5.0.md`（552 行）。
- 版本号统一 bump 到 `7.5.0-beta.1`：
  - `Cargo.toml`
  - `package.json`
  - desktop / docs-site / webui / npm 包
  - Tauri 配置
- `CHANGELOG.md` 的 `v7.5.0-beta.1` 区块已包含 9 个主题，中英双语完整。

---

## 10. CHANGELOG 审计

当前 `CHANGELOG.md` 的 `v7.5.0-beta.1` 区块覆盖：

1. Tool Search & Approval
2. EDIT Tool
3. Skills & User Commands Architecture
4. WebUI Timeline, Replay & Rendering
5. WebUI Mobile & Composer Experience
6. Session Checklist & State Synchronization
7. Windows & Shell Integration
8. Release Notes & Updater
9. Prompt & Persona Modernization

对照 17 个提交：

- `accf225c0` → 第 8 项
- `a1e88be5c`、`faffb38fe`、`de2a482ed`、`1139a7ec2`、`48b0abb4e`、`690950581` → 第 4/5 项
- `444bf383f`、`a217ed60f`、`9d5fd99f1` → 第 1 项
- `d46c76ae5` → 第 2 项
- `9df49c4cc` → 第 3 项
- `132080851` → 第 6 项
- `3a8faf903` → 第 7 项
- `c542dde37` → 第 9 项
- `c1030c0a0`、`1cb4e58cb` → 报告与版本号，不需要单独列为用户功能

结论：**CHANGELOG 没有漏掉 17 个提交中的用户可见变更。**

---

## 11. 验证与 CI 状态

### 11.1 本地定向验证

本轮已执行：

```text
cargo fmt --all -- --check
cargo test -p jeikcode-capabilities --lib tools::grep::tests
cargo test -p jeikcode-capabilities --lib tools::glob::tests
cargo test -p jeikcode-capabilities --lib tools::edit::tests
cargo test -p jeikcode-capabilities --lib argument_repair::tests
cargo test -p jeikcode-capabilities --lib tools::write_approval::tests
cargo test -p jeikcode-capabilities --lib tools::task::tests
cargo test -p jeikcode-capabilities --lib --features codeintel legacy_log_ignore_is_removed_but_custom_rules_stay
cargo test -p jeikcode-coding --lib parts::tests::subagent_registry_mounts_code_explore
cargo check --lib -p jeikcode-daemon
```

结果：

| 测试 | 结果 |
| :--- | :--- |
| grep | 48 passed |
| glob | 28 passed |
| edit | 90 passed, 1 ignored |
| argument_repair | 70 passed |
| write_approval | 20 passed |
| task | 36 passed |
| 旧日志迁移 | 1 passed |
| 子代理挂载 | 1 passed |
| daemon check | passed |
| fmt | passed |

真实工具黑盒验证也已通过：

- `.gitignore` 不参与搜索；
- grep 默认排除日志/噪声/敏感文件；
- `include_ignored` 打开构建/缓存/依赖/噪声但不打开日志；
- `include_logs` 独立打开日志；
- glob 默认包含日志路径；
- `include_sensitive` 在 Auto 下可读取敏感路径；
- 零匹配同时显示敏感/日志/噪声提示；
- grep/glob 溢出提示正常；
- 旧全局 `*.log` 已迁移。

### 11.2 最新 tag 的 CI 状态

`gh run list --branch beta` 显示最新 tag 提交 `1cb4e58cb`：

| Workflow | 结论 |
| :--- | :--- |
| `CI` | skipped |
| `Beta native portability` | **failure** |

失败详情：

- `Native libraries (macos-latest)`：failure
- `Native libraries (windows-latest)`：failure
- `Native libraries (ubuntu-latest)`：success
- Supported subset（provider/tools、cc-hooks）：success
- `Beta portability result`：failure，因为 native 结果不是 success

具体失败测试：

```text
tools::sensitive_path::tests::safe_ordinary_read_passes_without_round_trip
```

错误：

```text
thread 'tokio-rt-worker' panicked at ignore-0.4.25/src/gitignore.rs:232:
path is expected to be under the root

thread 'tools::sensitive_path::tests::safe_ordinary_read_passes_without_round_trip' panicked:
assertion failed: !gate.before(&mut call, &tool, &silent_rt()).await.is_deny()
```

根因判断：

`codegraph_sensitive_match` 使用：

```rust
let rel = target.strip_prefix(cwd).unwrap_or(target);
gi.matched_path_or_any_parents(rel, target.is_dir())
```

当 `target` 经过 canonicalize 后与 `cwd` 的前缀不一致时（macOS `/var` ↔ `/private/var`，Windows 临时目录 canonical 前缀），`rel` 仍是绝对路径，`ignore` crate 会 panic：

```text
path is expected to be under the root
```

这属于**跨平台路径规范化问题**，Linux 通过、macOS/Windows 失败。

建议修复：

- 仅当 `target.strip_prefix(cwd)` 成功时调用 `matched_path_or_any_parents`；
- 失败时返回 `false`，继续依赖 `path_is_sensitive` / `references_sensitive_path`；
- 增加“目标不在 cwd 下不 panic”的回归测试；
- 修复后 bump `v7.5.0-beta.2`，不要移动已推送的 `v7.5.0-beta.1` tag。

已实施（`c287b32c0`）：

- 直接 `strip_prefix` 失败时回退到 canonicalize 后的 `cwd`；
- 仍无法得到相对路径时返回 `false`，绝不再把绝对路径交给 `ignore`；
- 工作区内 `.codegraphignore.graph` 自定义规则仍正常匹配；
- 新增 `graph_match_outside_root_returns_false_instead_of_panicking` 回归测试；
- `tools::sensitive_path::tests`：12 passed；
- 修复提交位于 `v7.5.0-beta.1` tag 之后，需发布 `v7.5.0-beta.2` 并重跑 CI。

### 11.3 v7.5.0-beta.2 验证结果

- tag：`v7.5.0-beta.2` → `be28e0cfa`
- `Beta native portability`：**success**
  - Native libraries (ubuntu-latest)：success
  - Native libraries (windows-latest)：success
  - Native libraries (macos-latest)：success
  - Supported subsets：success
- `Build and Release`：in progress
  - `check-version`：success
  - `build-webui`：success
  - Windows / Linux / macOS 各架构构建中

---

## 12. 行为变化与风险

| 变化 | 影响 |
| :--- | :--- |
| `.gitignore` 不再过滤搜索结果 | 用户会看到更多被 Git 忽略但本地存在的文件；可通过 `.codegraphignore` 收敛 |
| `include_ignored` 不再打开日志 | 旧调用若依赖它搜日志，需要改用 `include_logs` |
| 新增 `include_logs` | grep 默认仍跳过日志；glob 默认包含日志路径 |
| `before_context` / `after_context` 删除 | 统一使用 `context`；非对称上下文改用 `read` 的 keyword 窗口 |
| edit 对外只暴露 `path` | 旧 `file_path` 仍兼容，但不再出现在 schema |
| 路径字段不再被归一化改写 | 调用方传入的字段名原样保留；模型习惯不被改写 |
| 技能目录中的扁平 `*.md` 归为用户命令 | 旧技能目录需迁移为 `*/SKILL.md` |
| Todo 空板成为权威状态 | 客户端需按 `(daemon instance, revision)` 重置/仲裁 |
| 首轮 `code_explore` 提醒移除 | 不再强制注入；工具仍可用 |
| Windows 使用进程内 Shell COM | 不再依赖外部 `explorer.exe` / `cmd.exe` |

安全相关：

- `include_sensitive=true` 在 Auto 模式自动继续；这是显式策略，但生产环境建议评估是否需要额外持久化开关。
- 敏感提示是路径级，不会读取敏感内容来判断 pattern。

---

## 13. 发布检查清单

- [x] 版本号 `7.5.0-beta.1`
- [x] `CHANGELOG.md` 的 `v7.5.0-beta.1` 中英双语区块
- [x] 9 个主题覆盖 17 个提交的用户可见变更
- [x] tag `v7.5.0-beta.1` 指向 `1cb4e58cb`
- [x] tag 已推送到远端
- [x] 修复 `sensitive_path` 跨平台 canonicalization 代码缺陷（`c287b32c0`）
- [x] 修复后重新跑 `Beta native portability`，确认 macOS/Windows/Linux 全绿
- [x] 发布 `v7.5.0-beta.2`，未移动 `v7.5.0-beta.1` tag
- [ ] 等待 `Build and Release` 完成并验证发布资产
- [ ] 验证 release notes 回源与更新弹窗
- [ ] 验证 Windows Shell reveal/open
- [ ] 验证移动端虚拟键盘与输入历史
- [ ] 验证技能/用户命令迁移后的旧用户目录

---

## 14. 附录：关键文件索引

### 工具与审批

- `crates/jeikcode-capabilities/src/tools/grep.rs`
- `crates/jeikcode-capabilities/src/tools/glob.rs`
- `crates/jeikcode-capabilities/src/tools/mod.rs`
- `crates/jeikcode-capabilities/src/tools/sensitive_path.rs`
- `crates/jeikcode-capabilities/src/tools/edit.rs`
- `crates/jeikcode-capabilities/src/argument_repair.rs`
- `crates/jeikcode-capabilities/src/tools/write_approval.rs`
- `crates/jeikcode-capabilities/src/tools/task.rs`
- `crates/jeikcode-capabilities/assets/.codegraphignore`
- `crates/jeikcode-capabilities/assets/.codegraphignore.graph`

### 技能与命令

- `crates/jeikcode-capabilities/src/skills/registry.rs`
- `crates/jeikcode-capabilities/src/skills/skill.rs`
- `crates/jeikcode-capabilities/src/skills/use_skill.rs`
- `crates/jeikcode-capabilities/src/commands/mod.rs`
- `crates/jeikcode-capabilities/src/commands/template.rs`
- `crates/jeikcode-daemon/src/lib.rs`（`/commands`）
- `crates/jeikcode-tuix/src/event_loop/commands.rs`
- `webui/src/components/chat/SlashMenu.tsx`

### WebUI

- `webui/src/components/Chat.tsx`
- `webui/src/lib/sessionProjection.ts`
- `webui/src/lib/replayFold.ts`
- `webui/src/lib/timelineFollow.ts`
- `webui/src/lib/viewport.ts`
- `webui/src/lib/composerLayout.ts`
- `webui/src/lib/todoWire.ts`
- `webui/src/lib/stateRevision.ts`
- `webui/src/lib/canvas/ordering.test.ts`

### Daemon / Shell / Updater

- `crates/jeikcode-daemon/src/shell_open.rs`
- `crates/jeikcode-updater/src/lib.rs`
- `functions/api/releases.js`

### 配置与版本

- `Cargo.toml`
- `Cargo.lock`
- `package.json`
- `desktop/src-tauri/tauri.conf.json`
- `webui/package.json`
- `docs-site/package.json`
- `packages/npm/package.json`

---

## 15. 最终结论

`v7.5.0-beta.1` 的 17 个提交、108 个文件变更已经全部落入当前 beta 历史；`CHANGELOG.md` 覆盖完整，本地定向测试与真实工具黑盒验证通过。

`v7.5.0-beta.1` 的阻塞项是 `sensitive_path` 的 canonicalization panic。生产代码修复已提交为 `c287b32c0`，并随 `v7.5.0-beta.2` 发布；**Beta native portability 已在 macOS/Windows/Linux 全绿**。当前只需等待 `Build and Release` 完成并验证发布资产。不要移动已推送的 `v7.5.0-beta.1` tag。
