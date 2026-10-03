# WebUI 界面与远程访问

除了终端富文本交互 (TUI)，JeikCode 还内置了基于现代 Web 技术的浏览器图形界面。它不仅支持在本地浏览器中开展多轮对话与项目管理，还能与终端通过实时双向同步（Live Sync）复用同一会话上下文，并支持灵活的局域网与公网远程访问。

---

## 启动 WebUI 的方式

### 方式一：从交互终端一键唤出

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

### 方式二：通过命令行参数直接启动

在服务器后台、无图形终端或希望直接使用浏览器的场景下，可在命令行直接传入参数启动服务：

```bash
# 局域网/公网监听并设置访问令牌（推荐）
jeikcode --host 0.0.0.0 --port 13457 --token your-secret-token

# 免密访问模式（仅建议在受信任的专用内网/VPN 环境使用）
jeikcode --host 0.0.0.0 --port 13457 --no-token

# 也可以使用等价的 serve 子命令
jeikcode serve --host 127.0.0.1 --port 8080
```

> 💡 **提示**：当在 Linux 系统中使用 `--host` 参数启动服务时，JeikCode 会自动检测并提示你是否将其一键注册为系统持久化服务（Systemd Service），方便服务器开机自启。

---

## 远程与跨设备访问安全指南

::: warning 安全第一：切勿将端口裸露至公网
JeikCode 拥有执行系统命令、读写本地代码的高级权限。**绝对不要**在无密码或无防火墙保护的情况下直接将带 `--host 0.0.0.0` 的服务端口映射至开放公网！
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
