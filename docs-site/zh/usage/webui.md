# WebUI 界面与远程访问

除了终端富文本交互 (TUI)，JeikCode 还内置了基于现代 Web 技术的浏览器图形界面。它不仅支持在本地浏览器中开展多轮对话与项目管理，还能与终端通过实时双向同步（Live Sync）复用同一会话上下文，并支持灵活的局域网与公网远程访问。

---

## 启动 WebUI 的方式

### 方式一：桌面客户端启动 (Desktop，首选推荐)

安装官方桌面版安装包（Windows / macOS / Linux）后，直接启动桌面端：

- **开箱即用图形窗口**：双击图标即可打开原生窗口，本地直接进入图形化多轮对话与项目管理；
- **自动全网监听与安全 Token**：桌面端后台自动监听 `0.0.0.0`，并自动生成专属的高强度随机访问 Token；
- **多端与局域网跨设备协同**：本地窗口自动免密注入 Token 秒开，而在局域网同一网络下的手机、平板或其他电脑，只需在浏览器访问 `http://<电脑局域网IP>:13457/?token=<随机Token>`，即可无缝跨端协同编程。

---

### 方式二：从交互终端一键唤出

在已经运行的 JeikCode 终端交互界面中，直接输入斜杠命令：

```text
/webui
```

系统会自动：
1. 在本地启动轻量 HTTP / WebSocket 服务（默认绑定 `127.0.0.1:13457`）；
2. 自动唤起系统默认浏览器，打开带有一次性鉴权令牌的链接：`http://127.0.0.1:13457/?token=<安全令牌>`；
3. 将当前终端会话与浏览器端进行实时双向同步。

若需停止 WebUI 服务，在终端中输入：

```text
/webui stop
```

---

### 方式三：通过命令行参数直接启动服务

在服务器后台、无图形终端或希望直接使用浏览器的场景下，可在命令行直接传入参数启动服务：

```bash
# 局域网/公网监听并设置访问令牌（安全基线：公网开放必须设置 Token）
jeikcode --host 0.0.0.0 --port 13457 --token your-secret-token

# 也可以使用等价的 serve 或 daemon 子命令
jeikcode serve --host 0.0.0.0 --port 13457 --token your-secret-token

# 免密访问模式（仅在受信任的专用私有隔离网络/VPN 环境使用）
jeikcode --host 0.0.0.0 --port 13457 --no-token
```

> 🔒 **核心安全门禁**：绑定非 Loopback 地址（非 `127.0.0.1`、`localhost`）时，**服务端强制要求必须提供访问 Token（通过 `--token` 参数或 `JEIKCODE_SERVER_TOKEN` 环境变量）**，缺少 Token 将直接拒绝启动退出，从根本上防止命令执行与文件管理端点在公网被未授权利用。

---

## 远程与跨设备访问安全指南

::: danger 安全第一：公网开放必须强制配置 Token
JeikCode 拥有执行系统命令、读写本地代码的高级权限。**公网开放必须设置 Token，且绝对不要在未开启认证或无防火墙保护的情况下裸奔开放端口！**
:::

### 推荐方案一：私有虚拟局域网（EasyTier / Tailscale / WireGuard / 蒲公英等）
1. 在宿主机器与手机/笔记本上分别安装 EasyTier、Tailscale 或蒲公英等组网客户端；
2. 启动服务绑定虚拟内网 IP：
   ```bash
   jeikcode --host <VPN内部IP> --port 13457 --token your-token
   ```
3. 远程设备连接内部 VPN 即可实现极速、点对点加密的安全访问，杜绝任何公网扫描风险。

### 推荐方案二：SSH 本地端口转发 (SSH Tunnel)
如果你在远程 Linux 服务器上开发：

```bash
# 在你本地电脑的终端中执行端口映射
ssh -N -L 13457:127.0.0.1:13457 user@your-remote-server
```

然后在本地浏览器直接打开 `http://127.0.0.1:13457/?token=...` 即可安全访问远程工作空间。

### 推荐方案三：Nginx 反向代理 + HTTPS + 基础密码验证
若确需通过固定域名提供团队共享访问，请务必配合 Nginx 增加 SSL 证书加密与 HTTP Basic Auth：

```nginx
location / {
    # 强制基础密码鉴权
    auth_basic "JeikCode Workspace";
    auth_basic_user_file /etc/nginx/.htpasswd;

    # 代理至本地服务
    proxy_pass http://127.0.0.1:13457;
    proxy_http_version 1.1;

    # 必须支持 WebSocket 双向通信
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

### 推荐方案四：公网 IPv6 + DDNS 动态域名 + Token 访问（极速推荐）
使用标准的 `--host 0.0.0.0` 启动时，JeikCode 底层默认就会自动尝试绑定 IPv4 与 IPv6 (`[::]`) 双栈监听，无须额外设置复杂参数。目前绝大多数家用宽带与移动网络均已标配公网 IPv6 地址：
1. **服务启动（默认支持双栈）**：
   ```bash
   # --host 0.0.0.0 默认就会尝试监听 IPv4/IPv6 双栈，并强制设置访问令牌（推荐）
   jeikcode --host 0.0.0.0 --port 13457 --token your-secret-token
   ```
2. **配合 DDNS 动态域名**：如果你拥有自己的域名，强烈推荐使用 DDNS 工具（如 DDNS-Go、Cloudflare DDNS、阿里云/腾讯云 DDNS 等）将本机的动态公网 IPv6 自动绑定到二级域名（如 `jeik.yourdomain.com`）；
3. **极速直连协同**：外部手机或电脑无需额外安装任何第三方 VPN 组网客户端，在浏览器中直接打开 `http://jeik.yourdomain.com:13457/?token=your-secret-token`（或 `http://[你的IPv6地址]:13457/?token=...`）即可享受千兆宽带直连体验；配合高强度随机 Token 鉴权，既快速又安全。
