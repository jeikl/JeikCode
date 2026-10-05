# JeikCode 项目全局开发约束

---

## 1. ~/.jeikcode 配置与 Teaches 知识库同步规范

`crates/jeikcode-capabilities/assets/teaches/`（及宿主机 `~/.jeikcode/teaches/`）中的渐进式模块化文档是编译后成品中 **`jeikcode_config_guide` 工具的直接知识源**：

1. **同变同更硬性约束**：凡修改了 `~/.jeikcode` 相关配置项、解析逻辑、参数默认值、超时机制、模型协议或目录结构，**必须同步修改对应的 `teaches/` 分类文档**（`01_prompts_and_context.md` 至 `08_updates_and_releases.md`）；涉及提示词的修改必须同步更新 **`prompts/`** 目录；
2. **构建打包自动同步**：`crates/jeikcode-cli/build.rs` 会在编译时自动抓取宿主机 `~/.jeikcode` 最新资产注入成品，并保持配置更新的交互式勾选与用户模型保护机制。

---

## 2. 格式化与测试机制 (Formatting & Testing Discipline)

- **精准单元测试 (Unit Testing)**：
  - 本地仅针对修改涉及的具体模块运行精准单测；
  - 常量、文案、提示词（prompts）、配置微调等细微修改直接跳过跑测；
  - 严禁在本地无意义运行全仓全量跑测（依赖 CI 编译测试目标）。
- **环境缺失跳过策略 (Missing Environment Bypass)**：
  - 若当前宿主机缺乏运行或安装环境（如缺失外部依赖、特定系统环境、底层工具链等），直接跳过测试，并在任务回复或 PR 中明确说明跳过原因及未验证路径。
- **本地测试裁量权 (Local Test Discretion)**：
  - 针对字符串、常量、提示词或配置等细微修改，任务完成后主动询问用户是否需要测试，严禁自作主张跑测；
  - 仅在改动涉及 4 个及以上核心前后端交互文件时进行自测（纯硬编码改动不计入核心文件）；
  - 严格遵循用户的测试偏好。
- **预检门禁 (Pre-flight Checks)**：
  - 仅在最终发版打 Tag 时执行；日常开发、代码审查、简单修改、调试或纯硬编码变更严禁执行；
  - 发版前按需执行：
    - `cargo fmt -- --check`（Rust 代码改动）
    - `cargo clippy --workspace --all-targets`（全工作区静态检查，已包含编译检查，无需额外执行 `cargo check`）
    - `cd webui && npm run build`（仅当涉及 `webui/` 前端或前端配置变动时）
  - 全量构建与完整测试依赖 CI 流水线，本地预检仅覆盖格式、Clippy 与前端构建。

---

## 3. PR 规范与提交管理 (PR Scope & Commit Discipline)

- **单一职责范围 (Single Problem Scope)**：
  - 一个 PR 仅聚焦单一类别的修复或功能；
  - 严禁将治理、发版基建、文档等无关改动夹带进业务 PR；同类文档改动合并为一个单独 PR。
- **原子可回退提交 (Self-Contained & Individually Revertable)**：
  - PR 内各 commit 必须是独立完整、可单独 revert 的功能单元，严禁提交交织混乱的变更集。
- **本地收敛与最终态提交 (Local Convergence & Final-State Commits)**：
  - 本地分支调试时可自由提交；
  - 发起或合并 PR 前，必须审计并整理压缩中间试错提交，每个合并提交仅描述其最终生效状态与原因，消除试错噪音。
- **对齐 PR 模板 (Review & Template Alignment)**：
  - 发起 PR 必须走审查流程，并严格填写 `.github/PULL_REQUEST_TEMPLATE.md`（问题分类、改动影响面、未验证路径、回退清单与自检项）。

---

## 4. 开发协作与分支管理 (Branch Hygiene & Collaboration Protocol)

- **基准分支检出规范**：
  - 新建分支必须基于远端基准检出（特性分支基于 `origin/beta`，紧急修复基于 `origin/main`），严禁基于本地陈旧分支拉新分支。
- **共享分支与 PR 抢占检查**：
  - 重写已发布分支前，先通过 `gh pr list --base main`（或 `beta`）检查在途 PR，严禁在共享分支强制推送。
  - 历史重写前必须保留本地 `backup/*` 备份分支，并通过 `git diff --stat <backup> HEAD` 确认内容无漂移。
- **Beta 预发布暂存协议 (Maintainer Staging Protocol)**：
  - 引入新功能、重大架构重构或非简单修复时，主动向维护者确认并优先在 `beta` 分支实现与验证；
  - 在 `beta` 上验证稳定后，再合入 `main`。
- **贡献者尊重与署名 (Contributor Attribution)**：
  - 优先采用贡献者原 PR 进行 squash 合并；代理 PR 或合并提交末尾必须附加官方 Trailer：
    ```text
    Co-Authored-By: JeikCode <code@jeikcode.top>
    ```
  - 合并前明示改动成本：列出影响的既有行为与未验证路径；
  - 拒绝 PR 时必须附带逐文件（file-by-file）的采纳/丢弃明细与可操作的后续路径。

---

## 5. 安装与自动化发版规范 (Installation & Release Pipeline)

为了保证所有 Agent 与维护者在发版与部署时有唯一权威路径，严禁使用任何废弃的历史手动流程。

### 5.1 组织、主干与分支定位

- **官方代码仓**：`https://github.com/jeikl/JeikCode`
- **主干与发版基准 (`main`)**：所有正式发布、Tag 标签、在线安装脚本默认抓取与 `latest.json` 均严格以 `main` 分支为准；
- **预发布版基准 (`beta`)**：较大变更、功能验证、PR 等优先合并并发布到 `beta` 分支。

### 5.2 自动化发版流程与规范

稳定版从 `main` 分支发布（Tag 格式为 `vX.Y.Z`），预发布版从 `beta` 分支发布（Tag 格式为 `vX.Y.Z-beta.n`）。发版时需按顺序完成以下文件更新与操作：

#### 步骤 1：一键同步更新版本号 (Version Bump)
在更新日志前，使用根目录自带的 `bump` 脚本一键同步全仓版本号（自动级联更新根目录及各子模块 `Cargo.toml`、`tauri.conf.json`、多端 `package.json` 及官网组件版本）：

- **预发布版升级 (Beta)**：执行 `npm run bump` 或 `npm run bump:beta`
  - 自动递增 beta 序号或开启新版本 beta 轮次（例如 `7.1.53` $\to$ `7.1.54-beta.1`，或 `7.1.54-beta.1` $\to$ `7.1.54-beta.2`）；
- **正式发布版小补丁 (Patch)**：执行 `npm run bump:patch`（例如 `7.1.53` $\to$ `7.1.54`）；
- **次版本 / 主版本升级 (Minor / Major)**：
  - 次版本：执行 `npm run bump:minor`（例如 `7.1.53` $\to$ `7.2.0`）；
  - 主版本：执行 `npm run bump:major`（例如 `7.1.53` $\to$ `8.0.0`）；
- **指定特定版本**：支持直接传参，如 `node scripts/bump-version.js 7.1.54-beta.3`。

#### 步骤 2：更新 `CHANGELOG.md`
在文件顶部追加 `## vX.Y.Z (YYYY-MM-DD)`。发版说明采用**双语分段标准模板**（英文讲完一整段，再插入单独一行的分割线 `---`，后接中文段落；安装路由由流水线统一自动生成纯英文直链，禁止中英混排）：

- **英文段落 (English Section)**：以 `- **[Module/Category] English summary**: ` 为主条目，展开二级子项详述 Root Cause、Implementation Mechanism 与 Verification；
- **分割线**：段落之间严格使用单独一行的 `---` 分隔；
- **中文段落 (Chinese Section)**：以 `- **[模块分类] 中文概述**: ` 为主条目，按技术机理、实现防线与验证层次展开二级子项；
- **编写模板**：

  ```markdown
  ## vX.Y.Z (YYYY-MM-DD)
  
  - **[Category/Module in English] Main summary sentence in English**:
    - **Technical Root Cause / Detail**: Detailed technical explanation...
    - **Implementation Mechanism**: Affected files, functions, and defensive logic...
    - **Verification & Testing**: Tests executed and coverage details...
  
  ---
  
  - **[模块分类中文] 中文概述主标题**:
    - **技术机理 /现象溯源**: 详细原理解释...
    - **实现防线 / 核心改动**: 受影响文件、核心函数与端到端防线建设...
    - **验证与交付**: 运行的单元测试与端到端验证...
  ```

#### 步骤 3：同步更新 README 文档日志
将上述更新内容同步更新至以下三份文档的「更新日志 / Changelog」章节（位于 License 之前），仅保留最近 2 个版本的更新记录，并附带 CHANGELOG.md 与 GitHub Releases 链接：
- `README.zh-CN.md`（同步中文段落）
- `README.md`（同步英文段落）
- `README.en.md`（同步英文段落）

> **注**：预发布版本带 `-`（如 `vX.Y.Z-beta.1`）仅需更新 `CHANGELOG.md`。完整更新历史由 [CHANGELOG.md](./CHANGELOG.md) 和 [GitHub Releases](https://github.com/jeikl/JeikCode/releases) 追溯。

#### 步骤 4：提交与推送
提交代码并推送到远程仓库对应分支（正式版推 `origin/main`，预发布版推 `origin/beta`），保持工作区干净。

#### 步骤 5：打 Tag 并触发发布流水线
```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```
GitHub Actions 流水线将自动读取 `CHANGELOG.md` 中对应章节生成详尽的 GitHub Release Notes（顶部为全英文桌面与终端安装路由，中英文日志以分割线清晰分段），编译六大架构二进制与安装包并发布。

> **预发布说明**：带 `-` 的 Tag（如 `vX.Y.Z-beta.1`）作为 Pre-release 发布，不占用 `releases/latest` 标记。

---

> 更多发版细则详见 [`docs/release-tutorial.md`](./docs/release-tutorial.md)。
