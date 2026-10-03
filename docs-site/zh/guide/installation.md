# 快速安装

JeikCode 提供了多种安装方式，涵盖一键在线安装、预编译包、包管理器以及源码编译，你可以根据自身操作系统与偏好进行选择。

---

## 推荐方式：官方一键安装脚本

一键脚本会自动检测您的系统架构（x86_64, aarch64 等），下载最新的预编译二进制文件，并自动配置环境变量。

::: code-group

```bash [Linux / macOS / HarmonyOS PC]
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | bash
```

```powershell [Windows (PowerShell)]
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

:::

安装完成后，可以在新终端中验证版本：

```bash
jeikcode --version
```

---

## 桌面端图形安装包 (推荐)

JeikCode 提供了开箱即用的跨平台桌面客户端（基于 Tauri 2.0 构建）。窗口内嵌了完整功能的 WebUI，并在初次启动时**自动将 `jeikcode` 命令行工具放入系统路径（如 `~/.local/bin` 或 Windows AppData 路径）**，无需手动配置环境变量：

- **Windows**：下载运行 `.exe` (NSIS) 安装程序；
- **macOS**：下载 `.dmg` 文件拖入 Applications 目录；
- **Linux**：提供 `.deb` 或 `.AppImage` 格式。

所有安装包均可前往 [GitHub Releases](https://github.com/jeikl/JeikCode/releases) 页面获取。

---

## 源码编译安装

如果你拥有 Rust 工具链（推荐 Rust 1.80+）：

```bash
git clone https://github.com/jeikl/JeikCode.git
cd JeikCode
cd webui && npm run build && cd ..
cargo install --path crates/jeikcode-cli --bin jeikcode --locked
```

---

## 预编译二进制下载

你可以直接前往 [GitHub Releases](https://github.com/jeikl/JeikCode/releases) 页面，下载对应平台的最新安装包：

| 平台 / 架构 | 格式 | 说明 |
| :--- | :--- | :--- |
| **Windows** (x86_64) | `.zip` / NSIS 安装器 | 解压后将 `jeikcode.exe` 加入 PATH 或直接运行安装程序 |
| **macOS** (Apple Silicon / Intel) | `.tar.gz` / `.dmg` | 解压后放置于 `/usr/local/bin` 或 `~/.local/bin` |
| **Linux** (x86_64 / aarch64) | `.tar.gz` / `.deb` / `.AppImage` | 适用于 Ubuntu/Debian/CentOS/Arch 等各类主流发行版 |

---

## 卸载与清理

如需卸载 JeikCode，可以使用随附的卸载脚本或手动删除二进制文件：

::: code-group

```bash [Linux / macOS]
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/uninstall.sh | bash
```

```powershell [Windows (PowerShell)]
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/uninstall.ps1 | iex
```

:::

配置数据默认存放在 `~/.jeikcode/` 目录下，若需彻底移除配置与缓存，可手动删除该文件夹。
