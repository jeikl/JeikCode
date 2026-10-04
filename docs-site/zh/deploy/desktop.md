# 桌面端应用

JeikCode 提供了开箱即用的跨平台桌面客户端（基于 **Tauri 2.0** 构建）。窗口内嵌了完整功能的 WebUI 界面，并在初次启动时会自动将同一版本的 `jeikcode` 命令行工具写入系统环境变量，开箱即用。

---

## 1. 安装包下载 (GitHub Releases)

请直接点击前往官方发布页面下载：👉 **[https://github.com/jeikl/JeikCode/releases](https://github.com/jeikl/JeikCode/releases)**

进入页面后，在最新版本的 **Assets** 附件列表中找到并点击下载对应操作系统的安装包：

| 操作系统 / 芯片架构 | 安装包文件名示例 | 说明 |
| :--- | :--- | :--- |
| **Windows** (64-bit) | `JeikCode.Desktop_<版本>_x64-setup.exe` | 带有图形向导的安装程序（推荐） |
| **macOS** (Apple Silicon M 系列) | `JeikCode.Desktop_<版本>_aarch64.dmg` | 适用于 M1 / M2 / M3 / M4 芯片 |
| **macOS** (Intel 芯片) | `JeikCode.Desktop_<版本>_x64.dmg` | 适用于老款 Intel 芯片 Mac |
| **Linux** (Debian / Ubuntu) | `JeikCode.Desktop_<版本>_amd64.deb` | Debian / Ubuntu 系统安装包 |
| **Linux** (通用免安装) | `JeikCode.Desktop_<版本>_amd64.AppImage` | 各类 Linux 发行版通用独立运行包 |

---

## 2. 各平台安装指引

### Windows 安装
1. 下载 `.exe` 安装程序；
2. 双击运行安装包，按照向导提示点击“下一步”完成安装；
3. 安装完成后即可从桌面快捷方式或开始菜单启动 JeikCode。

### macOS 安装
1. 根据你的 Mac 芯片类型下载对应的 `.dmg` 文件（Apple Silicon 选 `aarch64`，Intel 选 `x64`）；
2. 双击打开 `.dmg` 镜像文件；
3. 将 **JeikCode** 图标直接拖拽至 **Applications**（应用程序）文件夹中即可完成安装。

### Linux 安装
- **Debian / Ubuntu 用户**：
  ```bash
  sudo dpkg -i "JeikCode.Desktop_<版本>_amd64.deb"
  ```
- **AppImage 用户**：
  下载后赋予可执行权限，直接双击或在终端中运行：
  ```bash
  chmod +x "JeikCode.Desktop_<版本>_amd64.AppImage"
  ./"JeikCode.Desktop_<版本>_amd64.AppImage"
  ```

---

## 3. 核心特性与优势

1. **原生极轻内存占用**：利用操作系统原生的 WebView 内核（Windows WebView2 / macOS WebKit / Linux WebKitGTK），安装包小巧，运行内存消耗远低于传统的 Electron 应用；
2. **终端与图形界面合二为一**：桌面端首次启动时，会自动将 `jeikcode` 命令行工具放入用户系统路径（如 `~/.local/bin` 或 Windows AppData 目录），你可以在终端与桌面端之间无缝切换；
3. **系统深度集成**：支持原生系统通知、多窗口分屏操作与桌面托盘。
