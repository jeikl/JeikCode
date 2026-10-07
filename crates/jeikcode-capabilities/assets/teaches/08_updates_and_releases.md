# 08 - 自升级与更新源配置指南 (Updates & Releases)

---

## 1. 默认更新源与环境变量覆盖

JeikCode 默认从官方 GitHub 仓库拉取更新与版本清单：

| 配置项 | 默认地址 | 环境变量覆盖 | 说明 |
| :--- | :--- | :--- | :--- |
| **版本清单 (Manifest)** | `https://github.com/jeikl/JeikCode/releases/latest/download/latest.json` | `JEIKCODE_UPDATE_MANIFEST_URL` | 包含各平台版本号、SHA256 与文件大小。 |
| **下载基址 (Download Base)** | `https://github.com/jeikl/JeikCode/releases/download` | `JEIKCODE_UPDATE_DOWNLOAD_BASE` | 自动拼接 `/{version}/{asset_name}` 下载二进制。 |
| **官方代码仓** | `https://github.com/jeikl/JeikCode` | - | 官方源码主页。 |

---

## 2. 在 `config.toml` 中持久化更新源

在 `~/.jeikcode/config.toml` **最顶部（所有 `[table]` 之前）** 配置：

```toml
# ==============================================================================
# 自升级与更新源配置（顶层标量配置）
# ==============================================================================

# 自定义版本清单地址
update_manifest_url = "https://github.com/jeikl/JeikCode/releases/latest/download/latest.json"

# 自定义下载基址
update_download_base = "https://github.com/jeikl/JeikCode/releases/download"

# 是否在后台自动检测并下载更新（默认 false）
auto_update = false

# 自动检测间隔（分钟，默认 30）
auto_update_mins = 30
```

- **参数差异**：`auto_update = false` 时启动仅静默比对版本并在终端/界面提示，绝不自动下载覆盖；设为 `true` 时后台按间隔自动下载新版本并暂存。

---

## 3. 升级命令与模式差异 (`/update` / `/upgrade`)

在 TUI / WebUI 中输入斜杠命令 `/update` 或 `/upgrade`，与终端 CLI 命令完全等价：

```bash
# 交互式升级：下载新版并弹出配置文件差异列表，由用户手动勾选是否覆盖（在终端或聊天框输入 /update 或 /upgrade）
jeikcode update
jeikcode upgrade

# 全自动静默升级：自动应用官方默认更新（提示词/规则/teaches/词林），严格保护用户 mcp.json 和 skills 绝不覆盖
jeikcode update -y
jeikcode upgrade --yes

# 一键设置更新源并持久化写入 config.toml
jeikcode update set https://github.com/jeikl/JeikCode

# 查看当前生效的更新源与解析地址
jeikcode update get

# 重置为官方默认更新源
jeikcode update reset

# 快速回退上一版本
jeikcode update rollback
```

---

## 4. 服务监听与自启配置

```bash
# 启动 Web 服务并根据引导登记为系统服务（开机自启）
jeikcode --host 0.0.0.0 --port 13457
```

- **Linux**：生成并注册为 systemd 服务。
- **macOS**：注册为 launchd 服务。
- **Windows**：写入注册表当前用户启动项。
- 端口与 Token 配置持久化于 `~/.jeikcode/webui-listen.json`。

---

## 5. 热生效说明

- **环境变量**：设置即刻生效，优先级最高。
- **命令行设置**：`jeikcode update set <URL>` 立即持久化写入 `config.toml`。
- **手改 `config.toml`**：保存后调用工具 `jeikcode_config_reload` 或输入 `/reload` 即刻生效，无需重启进程。
