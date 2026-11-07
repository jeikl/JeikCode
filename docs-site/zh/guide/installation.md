# 快速安装（终端、桌面端、Docker、单文件）

JeikCode 提供了覆盖 **终端命令行 (Terminal / TUI)**、**跨平台桌面客户端 (Desktop)**、**Docker 容器化 (Docker)** 与 **独立单文件 (Standalone Binary)** 的多样化交付方式。你可以根据你的系统环境与使用习惯自由选择。

---

## 一、终端命令行模式 (Terminal / TUI)

JeikCode 核心引擎采用高性能 Rust 构建，支持在各大主流操作系统（Linux、macOS、Windows、OpenWrt、HarmonyOS PC）上一键快速安装。

### 官方一键在线安装

安装脚本会自动检测操作系统与 CPU 芯片架构（x86_64、aarch64 等），下载最新的预编译二进制文件并自动配置系统的 PATH 环境变量：

::: code-group

```bash [Linux / macOS / OpenWrt / HarmonyOS PC]
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | sh
```

```powershell [Windows (PowerShell)]
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

:::

安装完成后，直接在任意终端中输入 `jeikcode` 即可进入全功能交互终端界面。

---

## 二、桌面端图形客户端 (Desktop)（推荐）

JeikCode 提供了开箱即用的跨平台桌面客户端（基于 **Tauri 2.0** 构建，极致轻量，常驻内存仅数十兆）。

### 1. 核心优势与双端联动
- **极轻内存占用**：直接利用操作系统原生 WebView 内核（Windows WebView2 / macOS WebKit / Linux WebKitGTK），安装包小巧，常驻内存远低于传统的 Electron 应用；
- **终端与图形双向联动**：桌面端首次启动时，**会自动将同一版本的 `jeikcode` 命令行工具写入系统环境变量**，安装桌面端即相当于同时完成了终端命令行工具的配置；
- **原生系统集成**：支持系统托盘、桌面通知、多窗口分屏与原生快捷键。

### 2. 官方安装包下载

前往官方发布页：👉 **[https://github.com/jeikl/JeikCode/releases](https://github.com/jeikl/JeikCode/releases)**，下载对应平台的安装包：

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
  > 💡 **macOS 提示“已损坏，无法打开”的解决方法**：  
  > 将应用拖入 `/Applications`（应用程序）文件夹后，打开终端运行：  
  > `xattr -cr "/Applications/JeikCode Desktop.app"` 即可正常使用。
- **Linux**：
  - *Debian / Ubuntu*：
    ```bash
    sudo dpkg -i "JeikCode.Desktop_<版本>_amd64.deb"
    ```
  - *AppImage*：
    ```bash
    chmod +x "JeikCode.Desktop_<版本>_amd64.AppImage"
    ./"JeikCode.Desktop_<版本>_amd64.AppImage"
    ```

---

## 三、Docker 容器化部署 (Docker)

如果你偏好容器化环境或希望在隔离的容器沙盒中运行，可以使用官方提供的 Docker 镜像：

```bash
# 1. 克隆代码仓库
git clone https://github.com/jeikl/JeikCode.git
cd JeikCode

# 2. 构建 Daemon 服务端镜像
docker build -t jeikcode-daemon -f docker/Dockerfile-Daemon .

# 3. 运行容器并挂载项目工作区和本地配置
docker run -d \
  --name jeikcode-server \
  -p 13457:13457 \
  -e JEIKCODE_SERVER_TOKEN="sk-your-secret-token" \
  -v ~/.jeikcode:/root/.jeikcode \
  -v /path/to/your/projects:/workspace \
  jeikcode-daemon
```

启动完成后，即可直接通过浏览器访问 `http://<服务器IP>:13457/?token=sk-your-secret-token` 进入 WebUI 进行开发管理。

---

## 四、独立单文件下载与编译 (Standalone)

如果你需要在无外网访问权限的离线环境、CI 自动化构建节点中部署，或希望自行定制编译：

### 1. 预编译单文件下载 (GitHub Releases)

直接从 [GitHub Releases](https://github.com/jeikl/JeikCode/releases) 页面下载单文件独立预编译包，解压后放置于系统 PATH 目录即可免安装使用：

| 平台 / 芯片架构 | 压缩包格式 | 说明 |
| :--- | :--- | :--- |
| **Windows** (x86_64) | `.zip` 压缩包 | 解压后将 `jeikcode.exe` 放置入环境变量 PATH |
| **macOS** (Apple Silicon / Intel) | `.tar.gz` 压缩包 | 解压后放置于 `/usr/local/bin` 或 `~/.local/bin` |
| **Linux** (x86_64 / aarch64) | `.tar.gz` 压缩包 | 解压后赋予执行权限放入系统 bin 目录 |

### 2. Cargo 源码编译安装

如果你拥有完整的 Rust 开发工具链（推荐 Rust 1.80+）：

```bash
git clone https://github.com/jeikl/JeikCode.git
cd JeikCode
cd webui && npm run build && cd ..
cargo install --path crates/jeikcode-cli --bin jeikcode --locked
```
