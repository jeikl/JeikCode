# JeikCode 项目全局开发约束

---

## 1. 核心机制与知识库维护

- **提示词生效机制**：用户目录 `~/.jeikcode/prompts/` 支持热重载。生产基准提示词仅在源码仓 `crates/jeikcode-coding/assets/prompts/` 维护，随编译分发。
- **Teaches 知识库同步**：`crates/jeikcode-capabilities/assets/teaches/` 是 `jeikcode_config`（action="guide"）的知识源。调整模型配置逻辑或工具参数时，需同步更新该处文档。

---

## 2. 分支通道与协作契约 (Branching & Staging)

- **双通道分支基准**：官方仓为 `https://github.com/jeikl/JeikCode`。
  - `main`：仅承载正式稳定版、生产 Tag（`vX.Y.Z`）与官网发布资产。
  - `beta`：日常主力协作分支，承载特性开发、PR 汇聚与预发布验证（`vX.Y.Z-beta.n`）。
- **分支检出与复用**：日常特性基于 `origin/beta` 检出，紧急热修基于 `origin/main`；开发前先识别需求是否已在 `beta` 解决。
- **共享分支安全**：历史重写前必须查在途 PR（`gh pr list`）并保留本地 `backup/*` 分支；严禁在共享分支强推。重大重构与新功能必须先在 `beta` 验证稳定再合入 `main`。

---

## 3. 提交规范与 PR 治理 (Commit & PR Discipline)

- **Git 提交与署名**：遵循 Conventional Commits 规范，提交正文与 Trailer 间保留空行，末尾强制包含官方共同署名：
  ```text
  Co-Authored-By: JeikCode <code@jeikcode.top>
  ```
- **PR 范围与提交质量**：
  - **单一职责**：一个 PR 仅聚焦单一类别变更，严禁夹带无关改动。
  - **原子可回退**：PR 内 commit 必须独立完整、可单独 revert。
  - **本地收敛**：合并前必须审计压缩试错 commit，每个合并提交仅保留最终生效状态与原因。
  - **模板对齐**：必须严格填写 `.github/PULL_REQUEST_TEMPLATE.md`。
- **贡献者尊重**：优先采用贡献者原 PR 进行 squash 合并；合并前明示改动成本；拒绝 PR 时附带逐文件（file-by-file）明细与后续建议。

---

## 4. 格式化与定向验证机制 (Targeted Testing)

- **代码格式化**：涉及 Rust 改动时执行 `cargo fmt`。
- **定向验证矩阵**：
  - **前端改动 (`webui/`)**：`cd webui && npm run build`。
  - **Rust 改动 (`crates/`)**：`cargo check --lib -p jeikcode-daemon`。
  - **静态/轻量改动**：常量、文案、提示词、配置微调等直接提交，无需编译。
  - **单模块定向验证**：定向运行对应单测（如 `node --test webui/src/lib/xxx.test.ts`）。
  - **环境缺失**：宿主机缺少工具链时跳过测试并在回复中说明未验证路径，由 GitHub Actions CI 承接。

---

## 5. 自动化发版流水线 (Release Pipeline)

发版规范与操作细节严格以 [`docs/release-tutorial.md`](./docs/release-tutorial.md) 为准，核心闭环如下：

1. **版本递增**：使用 `npm run bump[:beta|patch|minor|major]` 自动级联全仓版本号。
2. **日志编写**：在 `CHANGELOG.md` 顶部按**双语分段标准模板**（英文段落 + 单行 `---` + 中文段落）记录，稳定版同步更新 3 份 README 的近 2 版日志。
3. **提交与推送**：提交版本日志并推送到远程基准（正式版推 `main`，预发布版推 `beta`）。
4. **触发流水线**：打 Tag 并推送（`git tag vX.Y.Z && git push origin vX.Y.Z`）。
5. **交付结项**：执行 `gh run list --limit 3` 确认对应 `Build and Release` 工作流进入 `in_progress` 即可结项，**严禁长轮询**。
