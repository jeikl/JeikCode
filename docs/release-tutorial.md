# JeikCode 本地编译与自动化发版权威指南

> **核心声明**：
> 1. 本文档为 JeikCode 项目**唯一的本地编译与发布权威指南**，所有历史旧版文档与手动交叉编译流程已全部废除。
> 2. 官方代码仓为 **`https://github.com/jeikl/JeikCode`**，发布主干严格以 **`main`** 分支为准（`local-dev` 仅作为向下兼容与阶段性研发分支）。
> 3. 本文仅保留日常开发与发版最核心的 **3 个标准场景**。

---

## 场景一：改动了前端 (WebUI) 时，如何快速编译出最终 Windows 成品

当你修改了 `webui/` 目录下的 React 前端代码、组件或样式，需要输出包含最新界面的 Windows 可执行程序成品时：

### 1. 执行命令
在项目根目录下依次执行：

```powershell
# 步骤 1：构建 WebUI 前端生产静态包
cd webui
npm ci
npm run build
cd ..

# 步骤 2：编译 Windows 最终 Release 成品
cargo build --release --bin jeikcode --locked
```

### 2. 成品输出路径
- **可执行文件**：`target/release/jeikcode.exe`

### 3. 底层机制与注意事项
- **打包内嵌原理**：`crates/jeikcode-cli` 使用了 `rust-embed`，在 Rust 编译期会将 `webui/dist/` 目录下的所有 HTML/JS/CSS 资源直接压缩内嵌进生成的 `jeikcode.exe` 单一二进制文件中，运行时由 Axum 本地 Web 服务直接在内存中提供。
- **为什么必须先 `npm ci && npm run build`**：`npm ci` 严格使用仓库中的 `webui/package-lock.json`，依赖与 CI 保持一致；随后生成新的 `dist`，避免 RustEmbed 打包旧前端。
- **构建不再读取开发者 `~/.jeikcode` 回写源码树**：仓库资产是唯一构建输入。构建保持纯净与确定性输入。

---

## 场景二：没改前端 (仅后端/核心逻辑) 时，如何快速复用缓存秒级编译

当你只修改了 Rust 后端代码（例如 `jeikcode-coding`、`jeikcode-capabilities`、`jeikcode-kernel` 等），没有动 `webui/` 前端时：

### 1. 执行命令

- **输出 Release 正式成品**：
  ```powershell
  cargo build --release --bin jeikcode --locked
  ```
- **日常快速调试运行 (Debug 模式，编译速度最快)**：
  ```powershell
  cargo build --bin jeikcode --locked
  ```

### 2. 成品输出路径
- **Release 模式**：`target/release/jeikcode.exe`
- **Debug 模式**：`target/debug/jeikcode.exe`

### 3. 底层机制
- **无需构建前端**：Rust 编译器在编译 `crates/jeikcode-cli` 时，会自动复用已经存在的 `webui/dist` 资源。
- **Cargo 增量构建缓存**：未变动的 crate、中间构件以及第三方依赖全部直接命中 `target/` 缓存，仅重新编译有代码变动的 crate，通常 5~15 秒即可快速产出最新程序。

---

## 场景三：如果要彻底发版到新版，标准发版流程应该是怎样

当前项目已全面收敛至 **GitHub Actions 一键打 Tag 自动化流水线**（配置位于 `.github/workflows/build.yml`），无需任何人工在本地繁琐地进行跨平台交叉编译或打包。

### 1. 发版流水线机制 (CI Trigger)
- **触发源**：`.github/workflows/build.yml` 监听 `push: tags: - "v*"`；
- **全自动构建矩阵**：
  1. `build-webui`：在 Ubuntu 环境下独立构建 WebUI SPA 并生成构件；
  2. 三端物理 Runner 并发编译 6 套目标架构：
     - **macOS**：`jeikcode-<tag>-darwin-arm64`（Apple Silicon）与 `jeikcode-<tag>-darwin-x64`（Intel）
     - **Linux**：`jeikcode-<tag>-linux-arm64` 与 `jeikcode-<tag>-linux-x64`（基于 zigbuild 的纯静态 musl，无 libc 依赖；ARM64 按 16K 页对齐，4K 和 16K 内核都能跑）
     - **Windows**：`jeikcode-<tag>-windows-arm64.exe` 与 `jeikcode-<tag>-windows-x64.exe`
  3. 六个二进制都上传为 artifact 后，由单独的 `publish` 作业从**触发 Tag 对应的精确 SHA**生成 Release 元数据并创建 **一次** GitHub Release（带更新说明），同时上传 `latest.json`。发布阶段不会重新 checkout 会继续移动的 `main`。

### 2. 标准自动化发版 5 步闭环流程

发版遵循权威自动化脚本，稳定版从 `main` 分支发布（Tag 格式为 `vX.Y.Z`），预发布版从 `beta` 分支发布（Tag 格式为 `vX.Y.Z-beta.n`）。

#### 步骤 1：一键同步更新全仓版本号 (Version Bump)
在更新日志前，使用根目录自带的 `bump` 脚本一键同步全仓版本号（自动级联更新根目录及各子模块 `Cargo.toml`、`tauri.conf.json`、多端 `package.json` 及官网组件版本）：

- **预发布版升级 (Beta)**：执行 `npm run bump` 或 `npm run bump:beta`
  - 自动递增 beta 序号或开启新版本 beta 轮次（例如 `7.1.53` $\to$ `7.1.54-beta.1`，或 `7.1.54-beta.1` $\to$ `7.1.54-beta.2`）；
- **正式发布版小补丁 (Patch)**：执行 `npm run bump:patch`（例如 `7.1.53` $\to$ `7.1.54`）；
- **次版本 / 主版本升级 (Minor / Major)**：
  - 次版本：执行 `npm run bump:minor`（例如 `7.1.53` $\to$ `7.2.0`）；
  - 主版本：执行 `npm run bump:major`（例如 `7.1.53` $\to$ `8.0.0`）；
- **指定特定版本**：支持直接传参，如 `node scripts/bump-version.js 7.1.54-beta.3`。

#### 步骤 2：更新 `CHANGELOG.md`
在文件顶部追加 `## vX.Y.Z (YYYY-MM-DD)`。发版说明采用**双语分段标准模板**（英文讲完一整段，再插入单独一行的分割线 `---`，后接中文段落；禁止中英混排）：

```markdown
## vX.Y.Z (YYYY-MM-DD)

- **[Category/Module in English] Main summary sentence in English**:
  - **Technical Root Cause / Detail**: Detailed technical explanation...
  - **Implementation Mechanism**: Affected files, functions, and defensive logic...
  - **Verification & Testing**: Tests executed and coverage details...

---

- **[模块分类中文] 中文概述主标题**:
  - **技术机理 / 现象溯源**: 详细原理解释...
  - **实现防线 / 核心改动**: 受影响文件、核心函数与端到端防线建设...
  - **验证与交付**: 运行的单元测试与端到端验证...
```

#### 步骤 3：同步更新 README 文档日志
将上述更新内容同步更新至以下三份文档的「更新日志 / Changelog」章节（位于 License 之前），仅保留最近 2 个版本的更新记录，并附带 CHANGELOG.md 与 GitHub Releases 链接：
- `README.zh-CN.md`（同步中文段落）
- `README.md`（同步英文段落）
- `README.en.md`（同步英文段落）

> **注**：预发布版本带 `-`（如 `vX.Y.Z-beta.1`）仅需更新 `CHANGELOG.md`。

#### 步骤 4：提交与推送
提交上述版本与日志变动，推送到远程仓库对应分支（正式版推 `origin/main`，预发布版推 `origin/beta`），保持工作区干净。

#### 步骤 5：打 Tag 并触发发布流水线
```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```
- **流水线监控与交付结项规范**：推送 Tag 触发流水线后，仅需通过 `gh run list --limit 3` 监控确认对应的 `Build and Release` 工作流已成功触发并进入运行状态（`in_progress`），即可立即向用户总结汇报结项，**无需等到流水线完全结束，严禁无限期长轮询**。
- **预发布说明**：带 `-` 的 Tag（如 `vX.Y.Z-beta.1`）作为 Pre-release 发布，不占用 `releases/latest` 标记。

#### 流水线在云端自动完成的全部闭环工作：
1. **编译期自动版本注入**：
   - `build-webui` 与 3 大 Rust Runner 都会在编译前从 Git Tag 提取纯数字版本号（`v7.0.2` → `7.0.2`），动态写入 `Cargo.toml` / `JEIKCODE_VERSION`；
   - 编译出的全部 6 平台二进制内部直接烙印本次 Tag 版本号（`jeikcode --version` 与 WebUI 侧栏 / `GET /health` 均为本次 Tag）；
2. **六个架构齐了再发布**：
   - Windows / Linux / macOS 仍各编 x64 与 arm64，但只上传 artifact，不中途创建 Release，也不按架构提交；
   - 任一架构失败则不会发布半套产物；
3. **一次 Release，清单不进 git**：
   - `publish` 先验证 checkout HEAD 与触发 Tag 都等于 `GITHUB_SHA`，再用本地六个二进制计算 SHA256 与大小，生成 `latest.json` 并上传；
   - 客户端与 `install.sh` / `install.ps1` 读取 `https://github.com/jeikl/JeikCode/releases/latest/download/latest.json`，下载后仍校验 SHA256；
   - Release 正文顶部提供稳定的 Release Assets 页面入口；桌面安装包由后续矩阵追加到同一 Release，正文不再提前发布尚未生成的文件直链，避免构建中或失败时出现 404。下方仍采用“英文段落 + 分割线 `---` + 中文段落”的规范结构；
   - **不**修改 `Cargo.toml`、锁文件、README，也**不**再推送 `chore(release)`。下游分支不会因为发版而落后 `main`。
   - 带 `-` 的 Tag 标为 prerelease，不占 `releases/latest`。

> **打 Tag 之前**：按 `AGENTS.md` 6.3 写好 `CHANGELOG.md`，稳定版同步 README 更新说明并推到 `main`。流水线不会再改这些文件，也不会为清单往 `main` 追加提交。

---

## 附：用户端官方安装一键命令 (参考)

- **Linux / macOS**：
  ```bash
  curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | bash
  ```
- **Windows (PowerShell)**：
  ```powershell
  irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
  ```
