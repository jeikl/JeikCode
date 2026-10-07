# Quick Installation (TUI, Desktop)

JeikCode delivers full functionality across two primary modalities: **Terminal Command Line (TUI)** and **Cross-Platform Desktop Application (Desktop)**. Choose the installation method that fits your preferred environment.

---

## 1. Terminal Command Line (TUI) Installation

The core JeikCode engine is built with high-performance Rust, offering rapid one-line installation across Linux, macOS, Windows, and HarmonyOS PC.

### Official One-Line Script

The automated install script detects your operating system and CPU architecture (x86_64, aarch64, etc.), downloads the latest verified prebuilt binary, and configures your environment PATH:

::: code-group

```bash [Linux / macOS / HarmonyOS PC]
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | bash
```

```powershell [Windows (PowerShell)]
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

:::

---

## 2. Desktop Application (Desktop) (Recommended)

JeikCode provides an out-of-the-box cross-platform desktop application built with **Tauri 2.0**.

### 1. Key Features & Bidirectional Integration
- **Extremely Low Memory Footprint**: Uses OS-native WebView engines (WebView2 on Windows, WebKit on macOS, WebKitGTK on Linux), keeping binary sizes small and memory usage far lower than Electron apps;
- **Bidirectional Terminal & GUI Integration**: On first launch, the desktop app **automatically adds the matching `jeikcode` CLI binary to your system PATH** (e.g. `~/.local/bin` or Windows AppData), so installing the desktop app simultaneously configures the terminal CLI;
- **Native OS Integration**: Features system tray integration, desktop notifications, split-pane windows, and native shortcuts.

### 2. Official Desktop Installer Packages
Visit the official release download page: 👉 **[https://github.com/jeikl/JeikCode/releases](https://github.com/jeikl/JeikCode/releases)**, and locate the appropriate installer under **Assets**:

| OS / Architecture | Recommended Package | Description |
| :--- | :--- | :--- |
| **Windows** (64-bit) | `JeikCode.Desktop_<version>_x64-setup.exe` | Graphical NSIS setup wizard (Recommended) |
| **macOS** (Apple Silicon M series) | `JeikCode.Desktop_<version>_aarch64.dmg` | Native installer for Apple Silicon (M1/M2/M3/M4) |
| **macOS** (Intel chips) | `JeikCode.Desktop_<version>_x64.dmg` | Native installer for Intel-based Macs |
| **Linux** (Debian / Ubuntu) | `JeikCode.Desktop_<version>_amd64.deb` | Debian / Ubuntu deb package |
| **Linux** (Portable AppImage) | `JeikCode.Desktop_<version>_amd64.AppImage` | Portable universal standalone executable |

### 3. Platform Installation Guides
- **Windows**: Download the `.exe` installer, run setup wizard, and launch from your desktop or Start Menu;
- **macOS**: Download `.dmg`, open the image, and drag the **JeikCode** icon into the **Applications** folder;
- **Linux**:
  - *Debian / Ubuntu*: Run `sudo dpkg -i "JeikCode.Desktop_<version>_amd64.deb"`;
  - *AppImage*: Grant execution permissions and run:
    ```bash
    chmod +x "JeikCode.Desktop_<version>_amd64.AppImage"
    ./"JeikCode.Desktop_<version>_amd64.AppImage"
    ```

---

## 3. Other Installation Methods

### 1. Standalone Binary Downloads (GitHub Releases)

You can download single-file standalone binaries directly from [GitHub Releases](https://github.com/jeikl/JeikCode/releases) and manually place them in your system PATH:

| OS / Architecture | Archive Format | Description |
| :--- | :--- | :--- |
| **Windows** (x86_64) | `.zip` archive | Extract and place `jeikcode.exe` into your system PATH |
| **macOS** (Apple Silicon / Intel) | `.tar.gz` archive | Extract to `/usr/local/bin` or `~/.local/bin` |
| **Linux** (x86_64 / aarch64) | `.tar.gz` archive | Extract and move executable to system bin directory |

### 2. Cargo Source Compilation

If you have the Rust toolchain installed (Rust 1.80+ recommended):

```bash
git clone https://github.com/jeikl/JeikCode.git
cd JeikCode
cd webui && npm run build && cd ..
cargo install --path crates/jeikcode-cli --bin jeikcode --locked
```

### 3. Uninstallation & Data Cleanup

To remove JeikCode, run the uninstallation script:

::: code-group

```bash [Linux / macOS / HarmonyOS PC]
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/uninstall.sh | bash
```

```powershell [Windows (PowerShell)]
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/uninstall.ps1 | iex
```

:::

- **Configuration & State**: Session histories and configurations are stored in `~/.jeikcode/`. Delete this directory manually to completely reset.
