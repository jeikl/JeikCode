# WebUI & Remote Access

In addition to the interactive terminal environment (TUI), JeikCode features an integrated web-based graphical user interface. It not only provides a visual canvas for multi-turn conversations and workspace management in your browser, but also shares the exact live session context with your terminal in real time, supporting flexible remote access across local networks and the public internet.

---

## Ways to Launch WebUI

### Method 1: Desktop Application (Recommended)

Install the official desktop application (Windows / macOS / Linux) and launch it directly:

- **Instant Native GUI**: Double-click the icon to open a native window with full chat and workspace features;
- **Automatic Network-wide Binding & Token**: The desktop background server binds to `0.0.0.0` by default and generates a cryptographically secure random access token;
- **Seamless Local & Multi-Device Collaboration**: The local window opens automatically with the token injected. Other devices on the same local network (phones, tablets, laptops) can access `http://<your-ip>:13457/?token=<random-token>` directly in their browsers to collaborate seamlessly.

---

### Method 2: One-Click Launch from Interactive Terminal

In any active JeikCode terminal session, simply type the slash command:

```text
/webui
```

This will automatically:
1. Start a lightweight HTTP / WebSocket server on your local machine (default: `127.0.0.1:13457`);
2. Open your default web browser to `http://127.0.0.1:13457/?token=<security-token>`;
3. Synchronize your active terminal session with the browser interface in real time.

To stop the WebUI service, type in your terminal:

```text
/webui stop
```

---

### Method 3: Launch Directly via CLI Command

In headless server environments, or when you want to bypass the terminal TUI, pass arguments directly from the command line:

```bash
# Listen on all interfaces with an authentication token (Security: Token is REQUIRED for public exposure)
jeikcode --host 0.0.0.0 --port 13457 --token your-secret-token

# Or use the equivalent serve / daemon subcommand
jeikcode serve --host 0.0.0.0 --port 13457 --token your-secret-token

# No-token mode (Only permitted in completely trusted and isolated private networks)
jeikcode --host 0.0.0.0 --port 13457 --no-token
```

> 🔒 **Security Requirement**: When binding to any non-loopback address (other than `127.0.0.1` or `localhost`), **the server strictly enforces an access token via `--token` or the `JEIKCODE_SERVER_TOKEN` environment variable**. Starting without a token on external interfaces will fail closed to prevent unauthorized command execution or filesystem tampering.

---

## Secure Remote & Mobile Access Guide

::: danger Security First: Mandatory Authentication for Public Exposure
JeikCode possesses privileges to execute arbitrary shell commands and edit local code files. **Public exposure requires an access token, and unauthenticated public ports are strictly rejected.**
:::

### Option 1: Private Overlay Network (EasyTier / Tailscale / WireGuard / P2P VPN)
1. Install EasyTier, Tailscale, or WireGuard on your development machine and your mobile device/laptop;
2. Bind the server to your VPN address:
   ```bash
   jeikcode --host <VPN-IP> --port 13457 --token your-token
   ```
3. Connect from your mobile browser using the encrypted VPN IP with zero public exposure risk.

### Option 2: SSH Port Forwarding Tunnel (SSH Tunnel)
When developing on a remote cloud server:

```bash
# Run port forwarding on your local workstation
ssh -N -L 13457:127.0.0.1:13457 user@your-remote-server
```

Open `http://127.0.0.1:13457/?token=...` in your local browser to access the remote session securely.

### Option 3: Nginx Reverse Proxy + HTTPS + HTTP Basic Auth
When providing shared access over a custom domain, enforce SSL encryption and password authentication:

```nginx
location / {
    # Enforce basic HTTP authentication
    auth_basic "JeikCode Workspace";
    auth_basic_user_file /etc/nginx/.htpasswd;

    # Proxy to local daemon
    proxy_pass http://127.0.0.1:13457;
    proxy_http_version 1.1;

    # Mandatory WebSocket headers for Live Sync
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

### Option 4: Public IPv6 + DDNS + Token Access (Blazing Fast & Recommended)
When launched with standard `--host 0.0.0.0`, JeikCode by default automatically attempts dual-stack listening for both IPv4 and IPv6 (`[::]`), with no complex configuration required. Most residential broadband and mobile networks now come with native public IPv6 addresses:
1. **Server Startup (Dual-Stack by Default)**:
   ```bash
   # --host 0.0.0.0 automatically attempts dual-stack (IPv4 + IPv6) listening with a secure token
   jeikcode --host 0.0.0.0 --port 13457 --token your-secret-token
   ```
2. **Pair with Dynamic DNS (DDNS)**: If you own a domain, use a DDNS tool (such as DDNS-Go, Cloudflare DDNS, or cloud provider DNS) to automatically map your host's dynamic IPv6 to a subdomain (e.g. `jeik.yourdomain.com`);
3. **Blazing-Fast Direct Access**: Access directly from your phone or remote laptop via `http://jeik.yourdomain.com:13457/?token=your-secret-token` (or `http://[your-ipv6-address]:13457/?token=...`) without third-party VPN overhead, secured by your secret token.
