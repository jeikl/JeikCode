# Quickstart

This tutorial walks you through the core workflow of JeikCode from scratch.

---

## 1. Install JeikCode

Before getting started, please refer to the [Installation Guide](/guide/installation) to install JeikCode.

---

## 2. Four Ways to Launch JeikCode

JeikCode supports four launch modes tailored to your development preference and network environment:

### Method 1: Desktop Application (Recommended)

If you prefer a native GUI application, launch JeikCode directly from your desktop or application launcher:

- **Ready-to-use GUI**: Starts instantly with a native desktop window, no manual commands required;
- **Network-wide Binding with Auto Token**: The desktop background server binds to `0.0.0.0` by default and generates a cryptographically secure random access token;
- **Seamless Cross-device Collaboration**: In addition to local instant usage, open the displayed URL with the token on your phone, tablet, or another laptop within the same network to collaborate seamlessly.

---

### Method 2: Terminal Interactive CLI (TUI)

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

---

### Method 3: Launch WebUI from the Terminal

Once inside the interactive terminal, if you want to switch to the browser Web view, simply type the slash command in the input prompt:

```text
/webui
```

JeikCode starts a local HTTP service and opens your browser automatically. The browser interface and terminal stay in **real-time bi-directional sync (Live Sync)**. To stop the service, type `/webui stop`.

---

### Method 4: Standalone Service and Remote Daemon (Serve / Daemon)

For headless server deployments or persistent team instances, start the service specifying the host, port, and authentication token:

```bash
# Listen on all interfaces with an access token (Security: Token is REQUIRED for non-loopback binds)
jeikcode --host 0.0.0.0 --port 13457 --token sk-your-secret-token

# Equivalent daemon and serve subcommands
jeikcode daemon --host 0.0.0.0 --port 13457 --token sk-your-secret-token

# No-token mode (Only permitted in completely trusted and isolated private networks)
jeikcode --host 0.0.0.0 --port 13457 --no-token
```

> ⚠️ **Security Requirement**: To protect systems against unauthorized command execution and remote access, **binding to any non-loopback interface strictly requires `--token` or the `JEIKCODE_SERVER_TOKEN` environment variable**. Unauthenticated external exposure will be rejected on startup.

---

## 3. CodeExplore & Semantic Retrieval

> 💡 **Dedicated Chapter**: For deeper details on bilingual thesauruses, AST topologies, and language support, refer to the dedicated [CodeExplore](/usage/codegraph) page.

CodeExplore provides deep architectural and code flow intelligence, giving the Agent a repository-wide structural overview.

Under normal circumstances, if you are developing in a standard project repository, you generally do not need to build code indices manually. The Agent is automatically guided to build indices at the right time and keep them updated in real time. **However, if you are running in a multi-repo root folder and these repositories do not belong to the same project, it is strongly recommended to create indices manually (prefer entering each specific sub-repository to build individual indices, avoiding excessive cross-project noise and symbol confusion; unless your multi-repo setup is a tightly coupled frontend + backend of the same project, where joint indexing makes sense)**.

The manual index creation commands are as follows:

### Manual Index Construction

Run the init command at your target repository root to parse the codebase and build cache in seconds:

```bash
# First-time or incremental index build
jeikcode init

# Force full clean re-index of the repository
jeikcode init --force
```

---

### Key Capabilities

1. **Broad Multi-language Support**:
   - Powered by Tree-Sitter syntax engines, supporting **Rust, TypeScript, JavaScript, Python, Go, Java, C, C++, C#, Vue, PHP, Ruby**, and more;
2. **Ultra-low Overhead & Zero-touch Incremental Patching**:
   - Extremely low memory footprint without idle CPU churn;
   - Real-time file change monitoring with 1~3ms single-file incremental patch updates—**hands-free thereafter, automatically monitoring file changes with zero maintenance**;
3. **Beyond Traditional Tools: Natural & Business Language Retrieval**:
   - Traditional code search tools rely strictly on exact symbol and AST name matching;
   - JeikCode CodeExplore integrates bilingual domain thesauruses (`thesaurus`) with calling topology. **Most importantly, it supports asking questions in pure natural language or business terminology** (e.g., "how does order cancellation work upon timeout?", "where does the authentication interceptor take effect?"), and the Agent accurately locates relevant implementations and upstream/downstream call chains.

---

## 4. Interactive Terminal (TUI)

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

## 5. Next Steps

- Explore CodeGraph and semantic retrieval: [CodeExplore](/usage/codegraph)
- Learn core configuration and auto-setup: [AI Quick Configuration](/guide/configuration)
- Learn how to configure models and provider accounts: [Model Configuration](/guide/login)
- Explore commands and keyboard shortcuts: [Slash Commands & Keybindings](/usage/slash-commands)
- Explore WebUI and remote collaboration: [WebUI & Remote Access](/usage/webui)
