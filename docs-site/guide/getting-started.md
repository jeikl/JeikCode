# Quickstart

This tutorial walks you through the core workflow of JeikCode from scratch.

---

## 1. Install JeikCode

Before getting started, please refer to the [Installation Guide](/guide/installation) to install JeikCode.

---

## 2. Three Ways to Launch JeikCode

JeikCode supports three launch modes tailored to your development preference and network environment:

### Method 1: Terminal Interactive CLI (TUI)

If you prefer the command line, open a terminal in your project directory, type `jeikcode`, and press Enter:

```bash
jeikcode
```

On first run, JeikCode guides you through basic model configuration. You can also pass a project path or a single one-off task directly:

```bash
# Launch interactive TUI in a specific directory
jeikcode /path/to/my-project

# Non-interactive headless execution of a single task
jeikcode run "Analyze dependencies in this project and generate a security report"
```

### Method 2: Launch WebUI from the Terminal

Once inside the interactive terminal, if you want to use the WebUI, simply type in the input prompt:

```text
/webui
```

JeikCode starts a local HTTP service and opens your browser automatically. The browser interface and terminal stay in **real-time bi-directional sync (Live Sync)**. To stop the service, type `/webui stop`.

### Method 3: Remote LAN / Public WebUI Access

If you want the WebUI to be accessible across your local network (LAN) or public internet (for example, on a cloud workstation or mobile device), start the server directly specifying the host, port, and authentication token:

```bash
# Listen on all interfaces with a secret token (Recommended)
jeikcode --host 0.0.0.0 --port 13457 --token your-token

# No-token mode (Only recommended in trusted private LAN environments)
jeikcode --host 0.0.0.0 --port 13457 --no-token
```

Once started, navigate to `http://<server-ip>:13457/?token=your-token` on any device to begin coding remotely.

---

## 3. Interactive Terminal (TUI)

Upon entering the terminal environment, you will see JeikCode's rich text terminal:

```text
┌────────────────────────────────────────────────────────┐
│ JeikCode v7.1.x                [Model: claude-3-7-sonnet]│
├────────────────────────────────────────────────────────┤
│ > Hello! I'm JeikCode. Ready to help with your code.   │
│                                                        │
├────────────────────────────────────────────────────────┤
│ Type your prompt and press Enter. Type / for commands. │
└────────────────────────────────────────────────────────┘
```

- **Bottom Input Field**: Enter natural language tasks (e.g., "Refactor authentication from JWT to Session cookies").
- **Slash Commands**: Type `/` to open the quick command menu (`/help`, `/webui`, `/model`, `/clear`, etc.).
- **Live Tool Cards**: Tool executions (file reading/writing, shell commands, searches) display expandable real-time cards with execution status.

---

## 4. Next Steps

- Learn core configuration and auto-setup: [AI Quick Configuration](/guide/configuration)
- Learn how to configure models and provider accounts: [Model Configuration](/guide/login)
- Explore commands and keyboard shortcuts: [Slash Commands & Keybindings](/usage/slash-commands)
- Master subagent parallelism: [Subagent Parallel Dispatch](/usage/subagents)
