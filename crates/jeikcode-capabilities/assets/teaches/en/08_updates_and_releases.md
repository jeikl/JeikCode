# 08 - Updates and Releases Configuration Guide (Updates & Releases)

---

## 1. Default Update Sources & Environment Overrides

JeikCode pulls updates and version manifests from the official GitHub repository by default:

| Item | Default Endpoint | Environment Variable Override | Description |
| :--- | :--- | :--- | :--- |
| **Version Manifest** | `https://github.com/jeikl/JeikCode/releases/latest/download/latest.json` | `JEIKCODE_UPDATE_MANIFEST_URL` | Contains platform versions, SHA256 checksums, and asset sizes. |
| **Download Base** | `https://github.com/jeikl/JeikCode/releases/download` | `JEIKCODE_UPDATE_DOWNLOAD_BASE` | Concatenates `/{version}/{asset_name}` to download binary packages. |
| **Official Repository** | `https://github.com/jeikl/JeikCode` | - | Official source repository. |

---

## 2. Persisting Update Sources in `config.toml`

Configure at the **very top of `~/.jeikcode/config.toml` (before any `[table]`)**:

```toml
# ==============================================================================
# Updates & Release Source Configurations (Top-level scalars)
# ==============================================================================

# Custom version manifest URL
update_manifest_url = "https://github.com/jeikl/JeikCode/releases/latest/download/latest.json"

# Custom binary download base URL
update_download_base = "https://github.com/jeikl/JeikCode/releases/download"

# Automatically check and download updates in background (default false)
auto_update = false

# Auto-check interval in minutes (default 30)
auto_update_mins = 30
```

- **Behavioral Distinction**: When `auto_update = false`, startup checks only compare versions and display notices in terminal/UI without downloading; when set to `true`, background intervals automatically download and stage new releases.

---

## 3. Upgrade Commands & Mode Differences (`/update` / `/upgrade`)

Entering `/update` or `/upgrade` in the TUI/WebUI slash command bar is completely equivalent to terminal CLI commands:

```bash
# Interactive upgrade: Downloads new release and displays config diff dialog for selective overwrite
jeikcode update
jeikcode upgrade

# Fully unattended silent upgrade: Applies official default updates (prompts, rules, teaches, thesaurus); strictly preserves user mcp.json and skills
jeikcode update -y
jeikcode upgrade --yes

# Set custom update source and persist to config.toml
jeikcode update set https://github.com/jeikl/JeikCode

# Inspect currently effective update endpoints
jeikcode update get

# Reset to official default update sources
jeikcode update reset

# Quick rollback to previous version
jeikcode update rollback
```

---

## 4. Service Listening & Auto-Start Configuration

```bash
# Start Web daemon and register as system service (auto-start on boot)
jeikcode --host 0.0.0.0 --port 13457
```

- **Linux**: Generates and registers as a systemd service.
- **macOS**: Registers as a launchd service.
- **Windows**: Writes to registry under current user Run keys.
- Port and token configurations persist in `~/.jeikcode/webui-listen.json`.

---

## 5. Reload & Effective Semantics

- **Environment Variables**: Take effect immediately with highest priority.
- **CLI Commands**: `jeikcode update set <URL>` persists immediately to `config.toml`.
- **Manual Edits**: Modifying `config.toml` directly requires invoking `jeikcode_config(action="reload")` or entering `/reload` to apply without process restart.
