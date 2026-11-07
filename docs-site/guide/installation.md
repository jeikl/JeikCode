# Quick Installation (Terminal, Desktop, Docker, Standalone)

JeikCode provides versatile delivery formats across **Terminal CLI (Terminal / TUI)**, **Cross-Platform Desktop Client (Desktop)**, **Containerized Environments (Docker)**, and **Standalone Binaries (Standalone)**. Choose the installation method that fits your environment.

---

## 1. Terminal Command-Line (Terminal / TUI)

The core JeikCode engine is written in Rust, supporting one-liner installation on Linux, macOS, Windows, OpenWrt, and HarmonyOS PC.

### Official One-Liner Script

The installer automatically detects your operating system and CPU architecture (x86_64, aarch64, etc.), fetches the latest binary, and adds it to your PATH:

::: code-group

```bash [Linux / macOS / OpenWrt / HarmonyOS PC]
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | sh
```

```powershell [Windows (PowerShell)]
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

:::

After installation, run `jeikcode` in any terminal to enter the interactive workspace.

---

## 2. Desktop GUI Client (Desktop) (Recommended)

JeikCode offers a zero-config, highly optimized desktop client built with **Tauri 2.0** (ultra-lightweight, using only tens of megabytes of RAM).

### 1. Key Features
- **Minimal Resource Footprint**: Leverages the system's native WebView (Windows WebView2 / macOS WebKit / Linux WebKitGTK), keeping installer sizes compact and memory consumption low;
- **CLI & GUI Synchronization**: When the desktop client is launched for the first time, it **automatically links the corresponding `jeikcode` CLI into your system PATH**;
- **Native OS Integration**: System tray support, desktop notifications, split-pane browsing, and native keybindings.

### 2. Official Desktop Downloads

Visit the official release page: 👉 **[https://github.com/jeikl/JeikCode/releases](https://github.com/jeikl/JeikCode/releases)**:

| Platform / Architecture | Package Format | Notes |
| :--- | :--- | :--- |
| **Windows** (64-bit) | `JeikCode.Desktop_<version>_x64-setup.exe` | Standard Windows graphical installer |
| **macOS** (Apple Silicon M-Series) | `JeikCode.Desktop_<version>_aarch64.dmg` | For Apple Silicon M1 / M2 / M3 / M4 Macs |
| **macOS** (Intel) | `JeikCode.Desktop_<version>_x64.dmg` | For older Intel-based Macs |
| **Linux** (Debian / Ubuntu) | `JeikCode.Desktop_<version>_amd64.deb` | Native `.deb` package |
| **Linux** (Universal) | `JeikCode.Desktop_<version>_amd64.AppImage` | Standalone AppImage for major Linux distros |

### 3. Platform Installation Guides
- **Windows**: Run the `.exe` installer and follow the setup wizard;
- **macOS**: Mount the `.dmg` image and drag the **JeikCode** app icon into the **Applications** folder;
  > 💡 **Fix for macOS "is damaged and cannot be opened" prompt**:  
  > Drag the app into `/Applications`, then open Terminal and run:  
  > `xattr -cr "/Applications/JeikCode Desktop.app"`
- **Linux**:
  - *Debian / Ubuntu*: Run `sudo dpkg -i "JeikCode.Desktop_<version>_amd64.deb"`;
  - *AppImage*: Grant execution rights and launch:
    ```bash
    chmod +x "JeikCode.Desktop_<version>_amd64.AppImage"
    ./"JeikCode.Desktop_<version>_amd64.AppImage"
    ```

---

## 3. Docker Containerization (Docker)

If you prefer isolated container environments, use the official Dockerfiles:

```bash
# 1. Clone the repository
git clone https://github.com/jeikl/JeikCode.git
cd JeikCode

# 2. Build the Daemon image
docker build -t jeikcode-daemon -f docker/Dockerfile-Daemon .

# 3. Run container mounting your workspace and configurations
docker run -d \
  --name jeikcode-server \
  -p 13457:13457 \
  -e JEIKCODE_SERVER_TOKEN="sk-your-secret-token" \
  -v ~/.jeikcode:/root/.jeikcode \
  -v /path/to/your/projects:/workspace \
  jeikcode-daemon
```

Access the WebUI directly at `http://<SERVER_IP>:13457/?token=sk-your-secret-token`.

---

## 4. Standalone Binaries & Source Build (Standalone)

For offline environments, automated CI/CD runners, or custom source compilations:

### 1. Standalone Binary Releases

Download single-file precompiled archives directly from [GitHub Releases](https://github.com/jeikl/JeikCode/releases):

| OS / Architecture | Format | Instructions |
| :--- | :--- | :--- |
| **Windows** (x86_64) | `.zip` archive | Extract and place `jeikcode.exe` into your system PATH |
| **macOS** (Apple Silicon / Intel) | `.tar.gz` archive | Extract and move binary to `/usr/local/bin` or `~/.local/bin` |
| **Linux** (x86_64 / aarch64) | `.tar.gz` archive | Extract, `chmod +x`, and move to a standard bin path |

### 2. Build from Source via Cargo

If you have a Rust toolchain installed (Rust 1.80+ recommended):

```bash
git clone https://github.com/jeikl/JeikCode.git
cd JeikCode
cd webui && npm run build && cd ..
cargo install --path crates/jeikcode-cli --bin jeikcode --locked
```
