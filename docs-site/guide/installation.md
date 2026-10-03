# Installation

JeikCode provides several installation methods, ranging from automated one-line scripts to official package managers and standalone prebuilt binaries.

---

## Recommended: Official One-Line Install Script

The script automatically detects your OS architecture (x86_64, aarch64, etc.), downloads the latest verified release, and sets up your environment PATH.

::: code-group

```bash [Linux / macOS / HarmonyOS PC]
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | bash
```

```powershell [Windows (PowerShell)]
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

:::

After installation, verify by checking the version in your terminal:

```bash
jeikcode --version
```

---

## Desktop Graphical Installer (Recommended)

JeikCode offers a cross-platform desktop application built with Tauri 2.0. The desktop client embeds the full WebUI and **automatically adds the `jeikcode` CLI binary to your system PATH (e.g. `~/.local/bin` or Windows AppData path)** on first launch:

- **Windows**: Download and run the `.exe` (NSIS) installer;
- **macOS**: Download the `.dmg` package and drag it to Applications;
- **Linux**: Available as `.deb` or standalone `.AppImage`.

All official packages can be downloaded from [GitHub Releases](https://github.com/jeikl/JeikCode/releases).

---

## Source Compilation (Cargo)

If you have the Rust toolchain installed (Rust 1.80+ recommended):

```bash
git clone https://github.com/jeikl/JeikCode.git
cd JeikCode
cd webui && npm run build && cd ..
cargo install --path crates/jeikcode-cli --bin jeikcode --locked
```

---

## Prebuilt Binaries

You can also download standalone binaries directly from [GitHub Releases](https://github.com/jeikl/JeikCode/releases):

| Platform / Arch | Artifact | Description |
| :--- | :--- | :--- |
| **Windows** (x86_64) | `.zip` / NSIS installer | Extract and add `jeikcode.exe` to PATH or run installer |
| **macOS** (Apple Silicon / Intel) | `.tar.gz` / `.dmg` | Extract to `/usr/local/bin` or `~/.local/bin` |
| **Linux** (x86_64 / aarch64) | `.tar.gz` / `.deb` / `.AppImage` | Standard package for Ubuntu, Debian, Fedora, Arch, etc. |

---

## Uninstallation

To remove JeikCode, run the uninstallation script:

::: code-group

```bash [Linux / macOS]
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/uninstall.sh | bash
```

```powershell [Windows (PowerShell)]
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/uninstall.ps1 | iex
```

:::

Configuration files and conversation caches are stored in `~/.jeikcode/`. Delete this directory manually if you want a complete wipe.
