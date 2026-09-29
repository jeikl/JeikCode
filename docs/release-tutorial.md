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
     - **Linux**：`jeikcode-<tag>-linux-arm64` 与 `jeikcode-<tag>-linux-x64`（基于 zigbuild 的纯静态 musl，无 libc 依赖；ARM64 按 16K 页对齐，4K 和 16K 内核都能跑）
     - **Windows**：`jeikcode-<tag>-windows-arm64.exe` 与 `jeikcode-<tag>-windows-x64.exe`
  3. 六个二进制都上传为 artifact 后，由单独的 `publish` 作业创建 **一次** GitHub Release（带更新说明），并把 `latest.json` 作为 Release 资产上传。不向 `main` 回写。

### 2. 极致简化的“纯打 Tag 发版”闭环 (Zero-Manual-Effort)

**不用手改** `Cargo.toml`、`Cargo.lock`、安装脚本、README 徽章或 `latest.json`。发版前只手写 `CHANGELOG.md` 和 README 的更新说明（见 `AGENTS.md` 6.3），再打 Tag：

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
2. **六个架构齐了再发布**：
   - Windows / Linux / macOS 仍各编 x64 与 arm64，但只上传 artifact，不中途创建 Release，也不按架构提交；
   - 任一架构失败则不会发布半套产物；
3. **一次 Release，清单不进 git**：
   - `publish` 用本地六个二进制计算 SHA256 与大小，生成 `latest.json`，和二进制一起上传到这次 Release；
   - 客户端与 `install.sh` / `install.ps1` 读取 `https://github.com/jeikl/JeikCode/releases/latest/download/latest.json`，下载后仍校验 SHA256；
   - Release 正文来自上一 Tag 到本次 Tag 的 Conventional Commits，GitHub 再追加 What's Changed；
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
