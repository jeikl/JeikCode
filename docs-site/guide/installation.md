# Quick Installation (Terminal, Desktop, Docker, Standalone)

JeikCode ships two product lines from the same Rust core:

- **Headless** — one self-contained `jeikcode` binary with the embedded WebUI, HTTP API, host-service registration and self-updater. This is the right choice for boxes, NAS, servers and CI.
- **Desktop** — a Tauri shell for GUI machines. It opens the same WebUI and adds the CLI to `PATH`.

The exact artifact matrix is maintained on [Supported Platforms](./supported-platforms).

---

## 1. Terminal Command-Line (Terminal / TUI)

The core engine is written in Rust. One-liner installation is supported on Linux, macOS, Windows and OpenWrt (x86_64 / aarch64):

```bash [Linux / macOS / OpenWrt]
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | sh
```

```powershell [Windows (PowerShell)]
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

The installer detects the OS and CPU architecture, verifies the release manifest (SHA256 + size) and installs a single binary. 32-bit userlands (`armv7l`, `armv8l`, `i686`) and MIPS fail closed with an explicit message.

---

## 2. Desktop GUI Client (Desktop)

The desktop client is for machines with a graphical session. Headless devices should use the CLI binary — the Tauri shell only adds a system WebView dependency.

| Platform / Architecture | Package Format | Notes |
| :--- | :--- | :--- |
| **Windows** (x64) | `JeikCode.Desktop_<version>_x64-setup.exe` | Graphical installer |
| **macOS** (Apple Silicon) | `JeikCode.Desktop_<version>_aarch64.dmg` | M1 / M2 / M3 / M4 |
| **macOS** (Intel) | `JeikCode.Desktop_<version>_x64.dmg` | Intel Macs |
| **Linux** (x64) | `JeikCode.Desktop_<version>_amd64.deb` | Debian / Ubuntu |
| **Linux** (x64) | `JeikCode.Desktop_<version>_amd64.AppImage` | Portable package |

> macOS "app is damaged" fix: drag the app into `/Applications`, then run `xattr -cr "/Applications/JeikCode Desktop.app"`.

---

## 3. Docker Containerization (Docker)

There is no prebuilt multi-arch image yet. Build one from a released Linux binary:

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

The image runs `jeikcode daemon --host 0.0.0.0`. A non-loopback bind requires `JEIKCODE_SERVER_TOKEN`; startup fails closed without it. Open `http://<SERVER_IP>:13456/?token=sk-your-secret-token`.

---

## 4. Standalone Binary & Source Build

Release assets are a **single executable per target** (`.exe` on Windows, no archive). Download it from [GitHub Releases](https://github.com/jeikl/JeikCode/releases), make it executable and place it on `PATH`.

To build from source (Rust 1.93+, pinned by `rust-toolchain.toml`):

```bash
git clone https://github.com/jeikl/JeikCode.git
cd JeikCode
cd webui && npm run build && cd ..
cargo install --path crates/jeikcode-cli --bin jeikcode --locked
```
