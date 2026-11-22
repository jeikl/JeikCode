# 快速安装（终端、桌面端、Docker、单文件）

JeikCode 基于同一套 Rust 核心，提供两种交付形态：

- **无头（Headless）**——单个自包含的 `jeikcode` 二进制，内置 WebUI、HTTP API、系统服务注册与自更新器。盒子、NAS、服务器与 CI 应选这一种。
- **桌面端（Desktop）**——面向图形化机器的 Tauri 外壳，打开同一个 WebUI，并把 CLI 写入 `PATH`。

精确的产物矩阵以 [支持的平台](./supported-platforms) 为准。

---

## 一、终端命令行模式 (Terminal / TUI)

核心引擎采用 Rust 构建，支持在 Linux、macOS、Windows 与 OpenWrt（x86_64 / aarch64）上一键安装：

```bash [Linux / macOS / OpenWrt]
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | sh
```

```powershell [Windows (PowerShell)]
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

安装器会检测操作系统与 CPU 架构、校验发布清单（SHA256 + 大小），然后安装单个二进制。32 位用户态（`armv7l`、`armv8l`、`i686`）与 MIPS 会以明确错误 fail-closed，不会下载错误架构的产物。

---

## 二、桌面端图形客户端 (Desktop)

桌面端面向带图形会话的机器。无头设备应直接使用 CLI 二进制——Tauri 外壳只会额外引入系统 WebView 依赖。

| 平台 / 架构 | 包格式 | 说明 |
| :--- | :--- | :--- |
| **Windows** (x64) | `JeikCode.Desktop_<version>_x64-setup.exe` | 图形化安装程序 |
| **macOS** (Apple Silicon) | `JeikCode.Desktop_<version>_aarch64.dmg` | M1 / M2 / M3 / M4 |
| **macOS** (Intel) | `JeikCode.Desktop_<version>_x64.dmg` | Intel 芯片 Mac |
| **Linux** (x64) | `JeikCode.Desktop_<version>_amd64.deb` | Debian / Ubuntu |
| **Linux** (x64) | `JeikCode.Desktop_<version>_amd64.AppImage` | 便携运行包 |

> macOS 提示“已损坏，无法打开”：将应用拖入 `/Applications`，然后执行 `xattr -cr "/Applications/JeikCode Desktop.app"`。

---

## 三、Docker 容器化部署 (Docker)

目前**没有**预构建的多架构镜像。请基于已发布的 Linux 二进制自行构建：

```bash
git clone https://github.com/jeikl/JeikCode.git
cd JeikCode

docker build \
  --build-arg JEIKCODE_BIN=/path/to/jeikcode-vX.Y.Z-linux-x64 \
  -t jeikcode-daemon -f docker/Dockerfile-Daemon .

docker run -d \
  --name jeikcode-server \
  -p 13456:13456 \
  -e JEIKCODE_SERVER_TOKEN="sk-your-secret-token" \
  -v ~/.jeikcode:/root/.jeikcode \
  -v /path/to/your/projects:/workspace \
  jeikcode-daemon
```

镜像以 `jeikcode daemon --host 0.0.0.0` 启动。非 loopback 绑定必须提供 `JEIKCODE_SERVER_TOKEN`，缺失时会 fail-closed。浏览器访问 `http://<服务器IP>:13456/?token=sk-your-secret-token`。

---

## 四、独立单文件与源码编译

Release 资产是**每个目标一个可执行文件**（Windows 为 `.exe`，不打包压缩）。从 [GitHub Releases](https://github.com/jeikl/JeikCode/releases) 下载后赋予执行权限并放入 `PATH` 即可。

源码编译（Rust 1.93+，由 `rust-toolchain.toml` 固定）：

```bash
git clone https://github.com/jeikl/JeikCode.git
cd JeikCode
cd webui && npm run build && cd ..
cargo install --path crates/jeikcode-cli --bin jeikcode --locked
```
