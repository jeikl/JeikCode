# Desktop Application

JeikCode provides an out-of-the-box cross-platform desktop application built with **Tauri 2.0**. It embeds the complete WebUI interface and automatically adds the matching `jeikcode` CLI binary to your system PATH on first launch.

---

## 1. Download Packages (GitHub Releases)

Click to visit the official release download page: 👉 **[https://github.com/jeikl/JeikCode/releases](https://github.com/jeikl/JeikCode/releases)**

On the release page, locate the **Assets** section of the latest version to download the installer for your operating system:

| OS / Architecture | Package Filename Example | Description |
| :--- | :--- | :--- |
| **Windows** (64-bit) | `JeikCode Desktop_<version>_x64-setup.exe` | Graphical installer with setup wizard (Recommended) |
| **macOS** (Apple Silicon M series) | `JeikCode Desktop_<version>_aarch64.dmg` | Native installer for Apple Silicon (M1/M2/M3/M4) |
| **macOS** (Intel chips) | `JeikCode Desktop_<version>_x64.dmg` | Native installer for Intel-based Macs |
| **Linux** (Debian / Ubuntu) | `JeikCode Desktop_<version>_amd64.deb` | Debian / Ubuntu system package |
| **Linux** (Standalone AppImage) | `JeikCode Desktop_<version>_amd64.AppImage` | Standalone portable executable for Linux distros |

---

## 2. Platform Installation Guides

### Windows Installation
1. Download the `.exe` setup package;
2. Double-click the installer and follow the setup wizard to complete installation;
3. Launch JeikCode from your desktop shortcut or Start Menu.

### macOS Installation
1. Download the appropriate `.dmg` file according to your Mac chip type (`aarch64` for Apple Silicon, `x64` for Intel);
2. Double-click to mount the `.dmg` image;
3. Drag the **JeikCode** icon directly into your **Applications** folder.

### Linux Installation
- **Debian / Ubuntu**:
  ```bash
  sudo dpkg -i "JeikCode Desktop_<version>_amd64.deb"
  ```
- **AppImage Users**:
  Grant execution permissions and run directly:
  ```bash
  chmod +x "JeikCode Desktop_<version>_amd64.AppImage"
  ./"JeikCode Desktop_<version>_amd64.AppImage"
  ```

---

## 3. Core Features & Advantages

1. **Native Low-Memory Footprint**: Uses the OS native WebView runtime (WebView2 on Windows, WebKit on macOS, WebKitGTK on Linux), resulting in tiny install packages and far lower RAM consumption than Electron apps;
2. **Unified CLI & GUI Integration**: On first launch, the desktop app automatically symlinks the `jeikcode` CLI into your PATH (e.g. `~/.local/bin` or Windows AppData), enabling seamless switching between terminal and GUI;
3. **Deep OS Integration**: Supports native notifications, multi-window tiling, system tray, and keyboard shortcuts.
