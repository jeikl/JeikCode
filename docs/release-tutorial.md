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
npm run build
cd ..

# 步骤 2：编译 Windows 最终 Release 成品
cargo build --release --bin jeikcode
```

### 2. 成品输出路径
- **可执行文件**：`target/release/jeikcode.exe`

### 3. 底层机制与注意事项
- **打包内嵌原理**：`crates/jeikcode-cli` 使用了 `rust-embed`，在 Rust 编译期会将 `webui/dist/` 目录下的所有 HTML/JS/CSS 资源直接压缩内嵌进生成的 `jeikcode.exe` 单一二进制文件中，运行时由 Axum 本地 Web 服务直接在内存中提供。
- **为什么必须先 `npm run build`**：如果仅运行 `cargo build` 而不重新执行前端构建，Rust 编译器只会将**上一次旧的** `webui/dist` 资源打包进去，导致你在浏览器或 Web 视图中看不到前端改动。因此改了前端后，必须先执行 `npm run build` 生成新的 `dist`，再编译 Rust 成品。

---

## 场景二：没改前端 (仅后端/核心逻辑) 时，如何快速复用缓存秒级编译

当你只修改了 Rust 后端代码（例如 `jeikcode-coding`、`jeikcode-capabilities`、`jeikcode-kernel` 等），没有动 `webui/` 前端时：

### 1. 执行命令

- **输出 Release 正式成品**：
  ```powershell
  cargo build --release --bin jeikcode
  ```
- **日常快速调试运行 (Debug 模式，编译速度最快)**：
  ```powershell
  cargo build --bin jeikcode
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
     - **Linux**：`jeikcode-<tag>-linux-arm64` 与 `jeikcode-<tag>-linux-x64`（基于 zigbuild 的纯静态 musl，无 libc 依赖）
     - **Windows**：`jeikcode-<tag>-windows-arm64.exe` 与 `jeikcode-<tag>-windows-x64.exe`
  3. 通过 `action-gh-release` 自动创建 GitHub Release 并上传全套 6 平台二进制。

### 2. 极致简化的“纯打 Tag 发版”闭环 (Zero-Manual-Effort)

**核心颠覆**：你**完全不需要手动修改** `Cargo.toml`、`Cargo.lock`、`install.sh`、`install.ps1`、`README*.md` 徽章或 `latest.json`！

日常开发中，你只需正常修改代码、修复 Bug 并正常提交 Commit。当你需要对外发布任意新版本（例如 `v7.0.2`）时，**整个发版流程仅需一行命令**：

```bash
# 1. 确保当前代码已推送到远程主干 main
git push origin main

# 2. 打上新版本 Tag 并推送到 GitHub（即可触发全自动化发布流水线！）
git tag v7.0.2
git push origin v7.0.2
```

#### 流水线在云端自动完成的全部闭环工作：
1. **编译期自动版本注入**：
   - `build-webui` 与 3 大 Rust Runner 都会在编译前从 Git Tag 提取纯数字版本号（`v7.0.2` → `7.0.2`），动态写入 `Cargo.toml` / `JEIKCODE_VERSION`；
   - 编译出的全部 6 平台二进制内部直接烙印本次 Tag 版本号（`jeikcode --version` 与 WebUI 侧栏 / `GET /health` 均为本次 Tag）；
2. **x86_64 优先编译与即时发布**：
   - Windows Runner 优先编译 x86_64 并**立即发布** `windows-x64.exe`；Linux/macOS 同样 x86_64 优先；
3. **全自动全量元数据同步回写**：
   - 流水线收尾 Job 会自动从 Releases 页面下载 6 大产物并计算真实的 SHA256 与文件大小；
   - 自动生成最新的 `latest.json` 升级清单；
   - 自动将 `Cargo.toml`、`Cargo.lock`、`scripts/install.ps1`、`scripts/install.sh` 及全套 `README*.md` 徽章版本统一提升为 `v7.0.2`；
   - 以 `github-actions[bot]` 自动提交并直接推送到 `main` 分支（附带 `[skip ci]`，防止循环触发）。

> **开发者唯一要做的事**：发版后，在本地执行一次 `git pull origin main`，即可拉取由 GitHub Actions 全自动同步好的最新版本元数据！

---

## 附：用户端官方安装一键命令 (参考)

- **Linux / macOS**：
  ```bash
  curl -fsSL https://raw.githubusercontent.com/JeikCode/JeikCode/main/scripts/install.sh | bash
  ```
- **Windows (PowerShell)**：
  ```powershell
  irm https://raw.githubusercontent.com/JeikCode/JeikCode/main/scripts/install.ps1 | iex
  ```
