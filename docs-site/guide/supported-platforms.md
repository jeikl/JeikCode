# Supported Platforms

JeikCode ships two product lines from the same Rust core:

- **Headless** — one self-contained `jeikcode` binary. It embeds the WebUI, the HTTP API, the host-service installer (`systemd` / `procd` / `launchd` / Windows logon task) and the self-updater. No Node.js, WebView or desktop runtime is required.
- **Desktop** — a thin Tauri shell that opens the same embedded WebUI and copies the same CLI into your `PATH`.

This page is the single source of truth for what the release pipeline actually publishes. The tables below are generated from [`scripts/platforms.json`](https://github.com/jeikl/JeikCode/blob/main/scripts/platforms.json) and checked in CI.

---

## Support policy

- **64-bit userland only.** The published binaries target `x86_64` and `aarch64`. A 32-bit userland on 64-bit hardware (`armv8l`) is not supported by the current artifacts.
- **Disk:** at least **256 MB free** for the binary, the embedded seeds cache, the SQLite code index and session files.
- **Memory:** the binary itself is small; 512 MB RAM is enough for the TUI/daemon on small projects. CodeGraph holds the workspace symbol graph in memory, so medium repositories benefit from 1 GB+, and agent-spawned builds/tests need their own headroom.
- **Verification, not just compilation.** Every release artifact is checked for the correct machine type; Linux artifacts must be static and page-size compatible; Linux artifacts are smoke-tested (`--version` + `--host` + `GET /health`) natively or under QEMU before the release is published.

---

## Headless CLI

<!-- >>> platforms:cli -->
| Headless binary | OS | Architecture | Notes |
| --- | --- | --- | --- |
| `darwin-arm64` | macOS | ARM64 | Mach-O binary |
| `darwin-x64` | macOS | x64 | Mach-O binary |
| `linux-arm64` | Linux | ARM64 | Static musl binary |
| `linux-x64` | Linux | x64 | Static musl binary |
| `windows-arm64` | Windows | ARM64 | `.exe` binary |
| `windows-x64` | Windows | x64 | `.exe` binary |
<!-- <<< platforms:cli -->

Install with the official one-liner:

```bash
# Linux / macOS / OpenWrt
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

Start a headless server (the desktop shell is not required):

```bash
jeikcode --host 0.0.0.0 --port 4096 --token sk-your-secret-token
# or, equivalently:
jeikcode serve --host 0.0.0.0 --port 4096 --token sk-your-secret-token
```

Then open `http://<host>:4096/?token=sk-your-secret-token`.

---

## Desktop

<!-- >>> platforms:desktop -->
| Desktop package | OS | Architecture | Formats |
| --- | --- | --- | --- |
| `windows-x64` | Windows | x64 | NSIS `.exe` |
| `macos-arm64` | undefined | ARM64 | `.dmg` / `.app` |
| `macos-x64` | undefined | x64 | `.dmg` / `.app` |
| `linux-x64` | Linux | x64 | `.deb` / `.AppImage` |
<!-- <<< platforms:desktop -->

Desktop installers exist for GUI machines. Headless devices (boxes, NAS, routers, CI runners) should use the CLI binary instead — the Tauri shell adds a system WebView dependency and no headless capability.

---

## Deliberately not published

| Platform | Status | Reason |
| --- | --- | --- |
| HarmonyOS / OpenHarmony | Not supported | Support was removed from the release pipeline, installer, updater and npm wrapper. |
| 32-bit ARM (`armv7l` / `armv8l`) | Not published yet | Tracked as a future **limited** target: static musl `armv7` is buildable, but it is not part of the current release manifest. The installer fails with an explicit 64-bit message instead of downloading a wrong binary. |
| 32-bit x86 (`i386` / `i686`) | Not supported | No meaningful non-low-end device population for this agent. |
| MIPS / MIPSEL | Not supported | Rust tier-3 target without prebuilt `std`; not viable for the release budget. |
| 32-bit Android / Termux | Not supported | No Android artifact is built; use a 64-bit Linux host instead. |

The installer and `jeikcode upgrade` both fail closed on these platforms with a readable error — they never fall back to a different architecture's binary.

---

## What CI verifies per platform

| Artifact | Architecture check | Runtime smoke |
| --- | --- | --- |
| `linux-x64` | ELF `x86_64`, no `PT_INTERP`, static | `--version` + `--host` + `/health` |
| `linux-arm64` | ELF `aarch64`, static, `PT_LOAD` align ≥ 16 KiB | `--version` + `--host` + `/health` under `qemu-aarch64` |
| `windows-x64` / `windows-arm64` | PE machine `0x8664` / `0xAA64` | Native `--version` on `windows-latest` (x64) |
| `darwin-x64` / `darwin-arm64` | Mach-O CPU type | Native `--version` on macOS runners |
| Headless arm64 (source) | Native `ubuntu-24.04-arm` build | `cargo test --workspace --lib` + `--version` + `--host` + `GET /health` |
| Installer (arm64) | Native `linux-arm64` manifest fixture | `scripts/test_installers.py` on native arm64 |

> The headless smoke test is the acceptance criterion: a build that only compiles is not considered a supported platform.
