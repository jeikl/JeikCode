# 快速安装（TUI、桌面端）

JeikCode 提供了覆盖 **终端命令行 (TUI)** 与 **跨平台桌面客户端 (Desktop)** 的完整交付能力。你可以根据操作系统与使用习惯自由选择安装方式。

---

## 一、终端命令行模式 (TUI)

JeikCode 核心引擎采用高性能 Rust 构建，支持在各大主流操作系统（Linux、macOS、Windows、HarmonyOS PC）上一键快速安装。

### 官方一键在线安装

脚本会自动检测系统与 CPU 架构（x86_64、aarch64 等），下载最新的预编译二进制文件并自动配置环境变量 PATH：

::: code-group

```bash [Linux / macOS / HarmonyOS PC]
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | bash
```

```powershell [Windows (PowerShell)]
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

:::

---

## 二、桌面端图形客户端 (Desktop)（推荐）

JeikCode 提供了开箱即用的跨平台桌面客户端（基于 **Tauri 2.0** 构建）。

### 1. 核心优势与双端联动
- **极轻内存占用**：直接利用操作系统原生 WebView 内核（Windows WebView2 / macOS WebKit / Linux WebKitGTK），安装包小巧，常驻内存远低于传统的 Electron 应用；
- **终端与图形双向联动**：桌面端首次启动时，**会自动将同一版本的 `jeikcode` 命令行工具写入系统环境变量**（如 `~/.local/bin` 或 Windows AppData 目录），安装桌面端即相当于同时完成了终端命令行工具的配置；
- **原生系统集成**：支持系统托盘、桌面通知、多窗口分屏与原生快捷键。

### 2. 官方安装包下载
请前往官方发布页：👉 **[https://github.com/jeikl/JeikCode/releases](https://github.com/jeikl/JeikCode/releases)**，在最新版本的 **Assets** 列表中下载对应平台的安装包：

| 操作系统 / 芯片架构 | 推荐安装包文件名示例 | 说明 |
| :--- | :--- | :--- |
| **Windows** (64-bit) | `JeikCode.Desktop_<版本>_x64-setup.exe` | 带有图形向导的安装程序（推荐） |
| **macOS** (Apple Silicon M 系列) | `JeikCode.Desktop_<版本>_aarch64.dmg` | 适用于 M1 / M2 / M3 / M4 芯片 Mac |
| **macOS** (Intel 芯片) | `JeikCode.Desktop_<版本>_x64.dmg` | 适用于老款 Intel 芯片 Mac |
| **Linux** (Debian / Ubuntu) | `JeikCode.Desktop_<版本>_amd64.deb` | Debian / Ubuntu 系统安装包 |
| **Linux** (通用免安装) | `JeikCode.Desktop_<版本>_amd64.AppImage` | 各类主流 Linux 通用独立运行包 |

### 3. 各平台安装指引
- **Windows**：下载 `.exe` 安装程序，双击运行并按照向导提示点击“下一步”完成安装；
- **macOS**：下载对应芯片架构的 `.dmg` 文件，双击挂载后将 **JeikCode** 图标直接拖拽至 **Applications**（应用程序）文件夹；
- **Linux**：
  - *Debian / Ubuntu*：
    ```bash
    sudo dpkg -i "JeikCode.Desktop_<版本>_amd64.deb"
    ```
  - *AppImage*：
    赋予可执行权限后直接运行：
    ```bash
    chmod +x "JeikCode.Desktop_<版本>_amd64.AppImage"
    ./"JeikCode.Desktop_<版本>_amd64.AppImage"
    ```

---

## 三、其他安装方式

### 1. 预编译单文件下载 (GitHub Releases)

你也可以直接从 [GitHub Releases](https://github.com/jeikl/JeikCode/releases) 页面下载单文件独立预编译包并手动放置到环境变量目录：

| 平台 / 芯片架构 | 压缩包格式 | 说明 |
| :--- | :--- | :--- |
| **Windows** (x86_64) | `.zip` 压缩包 | 解压后将 `jeikcode.exe` 放置入环境变量 PATH |
| **macOS** (Apple Silicon / Intel) | `.tar.gz` 压缩包 | 解压后放置于 `/usr/local/bin` 或 `~/.local/bin` |
| **Linux** (x86_64 / aarch64) | `.tar.gz` 压缩包 | 解压后赋予执行权限放入系统 bin 目录 |

### 2. Cargo 源码编译安装

如果你拥有完整的 Rust 开发环境（推荐 Rust 1.80+）：

```bash
git clone https://github.com/jeikl/JeikCode.git
cd JeikCode
cd webui && npm run build && cd ..
cargo install --path crates/jeikcode-cli --bin jeikcode --locked
```

### 3. 卸载与清理

如需彻底移除 JeikCode，可以使用随附的一键卸载脚本：

::: code-group

```bash [Linux / macOS / HarmonyOS PC]
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/uninstall.sh | bash
```

```powershell [Windows (PowerShell)]
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/uninstall.ps1 | iex
```

:::

- **配置文件与状态**：用户配置与会话缓存默认存储于 `~/.jeikcode/`，如需彻底清除，可手动删除该目录。
