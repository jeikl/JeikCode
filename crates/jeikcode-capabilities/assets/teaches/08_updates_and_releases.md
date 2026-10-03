# JeikCode 升级与发版配置指南 (Updates & Releases Guide)

本文档详细说明 JeikCode 的自升级机制、默认更新源、环境变量覆盖、发版打包流程与交叉编译规范。

---

## 1. 核心默认更新源架构

JeikCode 采用集中式端点解析机制（位于 `crates/jeikcode-config/src/endpoints.rs`），自升级模块完全脱离上游托管依赖，默认指向 GitHub 主仓与 Release 资产库：

| 配置项 | 默认地址 (Default URL) | 环境变量覆盖 (Env Override) | 用途说明 |
| :--- | :--- | :--- | :--- |
| **版本清单 (Manifest)** | `https://github.com/jeikl/JeikCode/releases/latest/download/latest.json` | `JEIKCODE_UPDATE_MANIFEST_URL` | Release 附件里的版本号、发布时间、全平台 SHA256 与文件大小。不在 `main` 上，发版不会多一次 git 提交 |
| **下载基址 (Download Base)** | `https://github.com/jeikl/JeikCode/releases/download` | `JEIKCODE_UPDATE_DOWNLOAD_BASE` | 发版二进制下载基址，拼接规则为 `{base}/{version}/{asset_name}` |
| **官方代码仓 (Repository)** | `https://github.com/jeikl/JeikCode` | - | 官方源码、Issue 与 Release 追踪主页 |

---

## 2. 客户端自升级机制 (`/upgrade`)

### 2.1 触发方式
- **交互式命令**：在 TUI 终端中输入 `/update`、`/upgrade` 或运行 CLI `jeikcode update` / `jeikcode upgrade`（两者完全等价）；
- **一键配置并持久化更新源**：运行 `jeikcode update set <URL>`（或 `jeikcode upgrade set <URL>`），自动解析并持久化记录到 `~/.jeikcode/config.toml` 中，后续所有更新均从该地址拉取；
- **版本检查**：客户端启动时在后台静默轮询 `latest.json`，发现新版本时在状态栏或终端顶部提示。

### 2.2 `latest.json` 结构规范
升级检查器通过解析 `latest.json` 匹配本地当前平台 Target：
```json
{
  "version": "6.0.27",
  "released_at": "2026-08-25",
  "binaries": {
    "windows-x64": {
      "sha256": "8381f402e8faa3c6187a81721e2099be0e2b9fec99d08c96542511c9b13e6592",
      "size": 63383040
    },
    "linux-x64": {
      "sha256": "d8169e78e5eb1cfe18f669df1722b217db24b1376fb1d0840b9aabec666760cf",
      "size": 53956368
    }
  }
}
```

### 2.3 安全与原子更新保障（零停机热替换）
1. **SHA256 强校验**：下载二进制后必须计算本地 SHA256，与清单不匹配立即回滚并报错；
2. **原子文件替换（解决 Linux ETXTBSY 锁）**：采用 `atomic_copy_replace` 机制，先在目标同目录下生成临时文件并赋予 `0755` 权限，再通过 `rename` 原子覆盖目标路径。Linux 内核允许对运行中进程的文件名进行重命名解引用（原进程继续持有旧 inode 句柄），彻底杜绝常驻 systemd 服务在执行升级时因 `ETXTBSY (Text file busy)` 导致的写入失败与假成功问题；
3. **别名同步原子化**：主二进制升级完成后，同步 `jeikcode`/`atomcode` 别名同样使用原子替换，确保服务平滑重启。

### 2.4 交互式配置同步默认勾选
升级二进制后会扫描 `~/.jeikcode` 与内置模板的差异，弹出交互勾选列表（空格切换、`a` 全选、Enter 应用、ESC 跳过）：

| 类别 | 默认勾选 | 原因 |
| :--- | :--- | :--- |
| 提示词、词林、teaches、`config.toml`（已保护用户模型/账号） | **勾选** | 官方工作流与知识库应跟上发版 |
| **`mcp.json`、`skills/`** | **不勾选** | 多为用户自定义 MCP 接线与技能包，避免覆盖本地改动 |
| 废弃遗留文件 | **勾选** | 建议清理旧路径 |

需要覆盖 MCP / skills 时，在列表里用空格勾选对应项再回车即可。`teaches/03_mcp_and_skills.md` 是文档，仍默认勾选。

### 2.5 安装脚本与首次启动配置同步保障
1. **安装脚本检测**：当用户已安装过或卸载后保留有 `~/.jeikcode` 配置时，执行 `install.sh` / `install.ps1` 脚本会在安装完成后自动检测已有配置并拉起配置更新可选覆盖操作；
2. **WebUI 与桌面端检测更新**：WebUI 界面右上角配备检测更新按钮；应用会自动或手动发起更新检测，若存在新版本，按钮切换为绿色向上箭头提示更新。点击后弹出确认框；
3. **桌面端一键升级**：桌面版确认更新后会自动下载对应的 setup 安装包并展现进度，下载完成后退出当前进程并拉起安装包重新安装；
4. **首启多选配置覆盖弹窗**：升级完成后首次启动桌面端或 WebUI 时，系统会自动比对新版本内置资产与本地配置差异，并弹窗展示与 upgrade 命令完全一致的多选框（默认选中规则相同），支持一键确认覆盖。

### 2.6 登录自启（systemd / launchd / Windows 登录项）
在终端执行 `jeikcode --host 0.0.0.0 --port <port>` 时，绑定监听之前会询问是否登记为登录后自动启动。提示语言跟随 `config.toml` 的 `language`（未选择时为英文）。

- **Linux**：systemd 单元，询问是否开机自启。
- **macOS**：`~/Library/LaunchAgents` 的 launchd agent。
- **Windows**：不使用会静默失败的 `schtasks /SC ONLOGON`（缺 `/RU /IT`，且 `/TR` 有 261 字符上限）。改为把启动命令写进 `%USERPROFILE%\.jeikcode\services\JeikCode-<port>.cmd`，并登记 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`。下次登录会拉起这个脚本。`jeikcode server uninstall <ID>` 会删掉登录项和脚本。

在 Linux 终端执行 `jeikcode --host 0.0.0.0 --port <port>` 或 `jeikcode serve` 时：
1. **交互式向导**：服务启动并打印访问地址后，按当前语言询问是否登记为系统服务并开机自启；
2. **默认命名**：默认服务名为 `jeikcode-<port>`，支持自定义名称与防重复覆盖校验；
3. **全环境自动捕获**：自动从当前 SSH 会话中抓取完整的 `$PATH`（包含 nvm/node、cargo、bun、go、.local/bin 等）、`$HOME`、`$USER`、`$SHELL`、`$LANG`，写入生成的 `/etc/systemd/system/<service>.service`，彻底免除常驻服务下 MCP/skills 因缺少环境变量而无法运行的困扰；
4. **无缝退出与信息保留**：服务安装并启动后，释放临时端口并优雅退出回到终端输入态，退出前完整打印带 Token 的访问 URL 与 `systemctl status/restart/stop` 管理命令。

---

## 3. 自定义更新源与多层级配置优先级 (Configuration & Precedence)

JeikCode 严格支持三层更新源配置裁决，优先顺序如下：

```text
┌────────────────────────────────────────────────────────┐
│ 1. 环境变量 (最高优先级，CI / 临时重定向)              │
│    JEIKCODE_UPDATE_MANIFEST_URL                        │
│    JEIKCODE_UPDATE_DOWNLOAD_BASE                       │
├────────────────────────────────────────────────────────┤
│ 2. ~/.jeikcode/config.toml 顶层标量配置 (持久化配置)   │
│    update_manifest_url = "..."                         │
│    update_download_base = "..."                        │
│    auto_update = false                                 │
├────────────────────────────────────────────────────────┤
│ 3. 编译期内置默认源 (官方 GitHub 仓库)                 │
│    Manifest: https://raw.githubusercontent.com/...     │
│    Download: https://github.com/jeikl/JeikCode/...     │
└────────────────────────────────────────────────────────┘
```

### 3.1 在 `~/.jeikcode/config.toml` 中持久化配置

在 `config.toml` **最顶层（任何 `[` 表头之前）** 或通过顶层键直接指定自定义源与自动更新：

```toml
# ==============================================================================
# 自升级与更新源配置 (顶层标量配置，位于所有 [table] 之前)
# ==============================================================================

# 自定义版本清单 Manifest 地址 (JSON 格式)
update_manifest_url = "https://github.com/jeikl/JeikCode/releases/latest/download/latest.json"

# 自定义发版二进制下载基址 (会自动拼接 /<version>/<asset_name>)
update_download_base = "https://github.com/jeikl/JeikCode/releases/download"

# 是否在后台自动检测并预暂存更新 (默认 false，手动运行 /upgrade 随时可用)
auto_update = false

# 自动检测更新的时间间隔 (单位：分钟，默认 30 分钟)
# 支持别名：auto_update_mins, auto_update_interval_mins, auto-update-mins, auto_update_sec, auto-update-sec
auto_update_mins = 30
```

### 3.2 命令行升级与更新源配置 (`update` / `upgrade`)
- **`update` 与 `upgrade` 等价**：无论在 CLI（`jeikcode update` / `jeikcode upgrade`）还是在 TUI 交互式斜杠命令中（`/update` / `/upgrade`），二者行为与参数完全一致；
- **一键设置并记住更新源 (`set`)**：
  ```bash
  # 传入 GitHub 仓库地址（支持完整 URL、短名或自建源）
  jeikcode update set https://github.com/jeikl/JeikCode
  # 或等价
  jeikcode upgrade set jeikl/JeikCode
  ```
  设置一次后将自动写入 `~/.jeikcode/config.toml`，后续无论是自动检测还是手动运行 `jeikcode update` 均永久生效；
- **查看与重置更新源 (`get` / `reset`)**：
  ```bash
  # 查看当前生效的更新源与解析地址
  jeikcode update get
  # 重置为官方默认内置更新源
  jeikcode update reset
  ```
- **常规交互升级**：`jeikcode update` 下载新版本并弹出配置差异多选列表；
- **全自动静默升级 (`-y` / `--yes`)**：
  ```bash
  jeikcode update -y
  # 或
  jeikcode upgrade --yes
  ```
  完成二进制原子替换后，**自动确认并应用系统默认选中的所有配置文件更新**（提示词、规则、teaches、词林、清理废弃项，并自动保护用户模型配置），同时**绝不覆盖**用户的 `mcp.json` 与自定义 `skills/`。
- **快速版本回退 (`rollback`)**：
  ```bash
  jeikcode update rollback
  # 或
  jeikcode rollback
  ```

### 3.3 环境变量临时覆盖

在局域网、CI/CD 自动化构建或临时联调时，可通过环境变量立即生效，无需修改 `config.toml`：

```bash
# Linux / macOS
export JEIKCODE_UPDATE_MANIFEST_URL="https://my-internal-repo.corp.com/jeikcode/latest.json"
export JEIKCODE_UPDATE_DOWNLOAD_BASE="https://my-internal-repo.corp.com/jeikcode/releases"

# Windows PowerShell
$env:JEIKCODE_UPDATE_MANIFEST_URL = "https://my-internal-repo.corp.com/jeikcode/latest.json"
$env:JEIKCODE_UPDATE_DOWNLOAD_BASE = "https://my-internal-repo.corp.com/jeikcode/releases"
```

---

## 4. 自动化流水线发版与 Release 规范

当前项目已全面收敛归一至 **GitHub Actions 一键打 Tag 自动化流水线**（定义于 `.github/workflows/build.yml`），无需手动在本地交叉编译。主干发布严格基于 `main` 分支，`local-dev` 仅作为历史特性兼容分支。

### 4.1 核心发版流程 (One-Tag Release)

日常不用手改版本号。代码在 `main` 上之后：

```bash
git tag v7.0.1
git push origin v7.0.1
```

`.github/workflows/build.yml` 随后：

1. **前端构建**：`build-webui` 先把 Tag 写入 `Cargo.toml` 与 `JEIKCODE_VERSION`，再编译 SPA。WebUI 侧栏版本号在 `vite build` 时烘进 JS。运行时还会再读 `GET /health`（`CARGO_PKG_VERSION`）覆盖侧栏，与正在跑的二进制一致。
2. **三端并发**：macOS（darwin-arm64、darwin-x64）、Linux（linux-arm64、linux-x64，zigbuild musl）、Windows（windows-arm64、windows-x64）。Rust job 同样从 Tag 改 `Cargo.toml`，因此 `jeikcode --version` / `/health` 为本次 Tag。产物只上传 artifact，不按架构创建 Release，也不按架构提交。
3. **一次发布**：`publish` 等六个二进制都在，才创建标题为 `JeikCode vX.Y.Z` 的 GitHub Release。正文来自上一 Tag 到本次 Tag 的 Conventional Commits，并追加 GitHub 自动生成的 What's Changed。缺任一架构则失败，不发半套。
4. **清单只挂在 Release 上**：`publish` 用六个二进制算出 SHA256，把 `latest.json` 和安装包一起上传。客户端和安装脚本读 `releases/latest/download/latest.json`，下载后再按 SHA256 校验。`main` 不再为发版追加提交，下游不用先 pull 才能继续开发。
5. **预发布**：Tag 含 `-`（如 `v7.0.2-beta.1`）标成 prerelease，且 `make_latest` 为 false，所以 `releases/latest` 仍指向最近的稳定版。

版本号在编译期从 Tag 写入二进制。仓库里的 `Cargo.toml` 不必跟着发版改。

---

## 5. 本地手动编译与调试备用流程

若在离线环境或定制开发场景下需要手动编译二进制：

### 5.1 生产前端构建 (WebUI)
```bash
cd webui && npm run build
```
*(必须在 Rust 编译前运行，产物位于 `webui/dist/`，通过 `rust_embed` 直接编译内嵌进二进制)*

### 5.2 Windows 本地 Release 编译
```powershell
cargo build --release --bin jeikcode
```

### 5.3 Linux 静态二进制编译 (通过 cargo-zigbuild)
```bash
cargo zigbuild --release --target x86_64-unknown-linux-musl --bin jeikcode
cargo zigbuild --release --target aarch64-unknown-linux-musl --bin jeikcode
```

