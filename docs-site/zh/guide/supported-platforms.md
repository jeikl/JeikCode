# 支持的平台

JeikCode 基于同一套 Rust 核心，提供两种交付形态：

- **无头（Headless）** —— 单个自包含的 `jeikcode` 二进制。内置 WebUI、HTTP API、系统服务注册（`systemd` / `procd` / `launchd` / Windows 登录任务）与自更新器，不需要 Node.js、WebView 或桌面运行时。
- **桌面端（Desktop）** —— 轻量 Tauri 外壳，打开同一个内置 WebUI，并把同一份 CLI 写入 `PATH`。

本页是发布流水线实际产出范围的唯一事实源。下方表格由 [`scripts/platforms.json`](https://github.com/jeikl/JeikCode/blob/main/scripts/platforms.json) 生成，并在 CI 中校验。

---

## 支持策略

- **仅支持 64 位用户态。** 发布产物面向 `x86_64` 与 `aarch64`；64 位硬件上运行 32 位用户态（`armv8l`）不在当前产物覆盖范围内。
- **磁盘：** 至少 **256 MB 可用空间**，用于二进制、内置种子缓存、SQLite 代码索引与会话文件。
- **内存：** 二进制本体很小，512 MB 内存足以在小项目上运行 TUI/守护进程；CodeGraph 会把工作区符号图驻留在内存中，中型仓库建议 1 GB 以上，Agent 拉起的编译/测试进程还需单独预留。
- **验证优先于“能编译”。** 每个发布产物都会校验机器类型；Linux 产物必须为静态链接且页对齐兼容；Linux 产物在发布前会以原生或 QEMU 方式执行 `--version`、`--host` 与 `GET /health` 冒烟测试。

---

## 无头 CLI

<!-- >>> platforms:cli -->
| 无头二进制 | 操作系统 | 架构 | 说明 |
| --- | --- | --- | --- |
| `darwin-arm64` | macOS | ARM64 | Mach-O 单文件 |
| `darwin-x64` | macOS | x64 | Mach-O 单文件 |
| `linux-arm64` | Linux | ARM64 | 静态 musl 单文件 |
| `linux-x64` | Linux | x64 | 静态 musl 单文件 |
| `windows-arm64` | Windows | ARM64 | `.exe` 单文件 |
| `windows-x64` | Windows | x64 | `.exe` 单文件 |
<!-- <<< platforms:cli -->

官方一键安装：

```bash
# Linux / macOS / OpenWrt
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

启动无头服务（不需要桌面端）：

```bash
jeikcode --host 0.0.0.0 --port 4096 --token sk-your-secret-token
# 等价写法：
jeikcode serve --host 0.0.0.0 --port 4096 --token sk-your-secret-token
```

随后访问 `http://<主机>:4096/?token=sk-your-secret-token`。

---

## 桌面端

<!-- >>> platforms:desktop -->
| 桌面安装包 | 操作系统 | 架构 | 格式 |
| --- | --- | --- | --- |
| `windows-x64` | Windows | x64 | NSIS `.exe` |
| `macos-arm64` | undefined | ARM64 | `.dmg` / `.app` |
| `macos-x64` | undefined | x64 | `.dmg` / `.app` |
| `linux-x64` | Linux | x64 | `.deb` / `.AppImage` |
<!-- <<< platforms:desktop -->

桌面安装包只面向图形化机器。盒子、NAS、软路由、CI 节点等无头设备应直接使用 CLI 二进制——Tauri 外壳只会额外引入系统 WebView 依赖，并不提供无头能力。

---

## 明确不发布的平台

| 平台 | 状态 | 原因 |
| --- | --- | --- |
| HarmonyOS / OpenHarmony | 不支持 | 发布流水线、安装器、更新器与 npm 包装中的相关支持已移除。 |
| 32 位 ARM（`armv7l` / `armv8l`） | 暂未发布 | 作为未来的 **limited** 目标跟踪：静态 musl `armv7` 可以构建，但不在当前发布清单中。安装器会给出明确的 64 位提示，而不会下载错误架构的二进制。 |
| 32 位 x86（`i386` / `i686`） | 不支持 | 对该 Agent 而言没有有意义的非低端设备存量。 |
| MIPS / MIPSEL | 不支持 | Rust tier-3 目标且无预编译 `std`，不符合发布预算。 |
| 32 位 Android / Termux | 不支持 | 不构建 Android 产物；请使用 64 位 Linux 主机。 |

安装器与 `jeikcode upgrade` 在这些平台上都会明确失败（fail-closed），绝不会回退到其它架构的二进制。

---

## CI 对各平台的验证内容

| 产物 | 架构校验 | 运行时冒烟 |
| --- | --- | --- |
| `linux-x64` | ELF `x86_64`、无 `PT_INTERP`、静态链接 | `--version` + `--host` + `/health` |
| `linux-arm64` | ELF `aarch64`、静态链接、`PT_LOAD` 对齐 ≥ 16 KiB | `qemu-aarch64` 下执行 `--version` + `--host` + `/health` |
| `windows-x64` / `windows-arm64` | PE machine `0x8664` / `0xAA64` | `windows-latest`（x64）原生 `--version` |
| `darwin-x64` / `darwin-arm64` | Mach-O CPU type | macOS Runner 原生 `--version` |
| 无头 arm64（源码构建） | `ubuntu-24.04-arm` 原生构建 | `cargo test --workspace --lib` + `--version` + `--host` + `GET /health` |
| 安装器（arm64） | 原生 `linux-arm64` 清单夹具 | 原生 arm64 上运行 `scripts/test_installers.py` |

> 无头冒烟测试是支持与否的验收标准：只能编译、不能启动并响应 `/health` 的构建，不算支持。
