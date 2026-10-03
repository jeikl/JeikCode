# AI Quick Configuration

JeikCode supports a rich suite of customizable configurations, including model endpoints, MCP services, Agent Skills libraries, tool timeouts, and security policies. The system provides two flexible ways to configure:

- **Method 1: AI Auto-Configuration (Highly Recommended)**: After initial setup, you don't need to memorize complex TOML syntax. Simply ask JeikCode in plain language what you want to configure (e.g., "Configure my DeepSeek API key as sk-xxx and set it as default model" or "Mount the Chrome DevTools MCP server"). The built-in AI will automatically update the configuration files and trigger an instant hot-reload, applying changes without restarting!
- **Method 2: Manual Configuration**: If you prefer granular manual control, JeikCode's core configuration files and persistent data are located by default under `~/.jeikcode`.

---

## 1. Core Configuration & Storage Paths (`~/.jeikcode`)

JeikCode's configuration files and persistent assets reside in your user home directory:
- **Linux / macOS**: `~/.jeikcode/config.toml` (or `$JEIKCODE_HOME/config.toml`)
- **Windows**: `C:\Users\<username>\.jeikcode\config.toml`

Key assets inside `~/.jeikcode`:
- `config.toml`: Core configuration file (model credentials, global parameters, timeouts)
- `mcp.json`: Global MCP (Model Context Protocol) server registry
- `skills/`: Custom Agent Skills catalog directory
- `teaches/`: Built-in modular system knowledge base (for AI reference and self-healing)

---

## 2. Global Default Configurations

```toml
# =============================================================================
# Global Top-Level Defaults (Must be at the very top of the file)
# =============================================================================
default_model = "deepseek/deepseek-v4.1-flash"  # Default model loaded on startup
language = "zh-CN"                             # Interface & interaction language
auto_update = false                            # Auto-update (disabled by default)
auto_commit = false                            # Automatically commit changes after each turn
keep_interrupted_context = true                # Retain partial turn context on Ctrl-C / interrupt
```

---

## 3. Timeouts & Long-Running Command Whitelist (`[timeouts]`)

To prevent hanging subshells or unintended interactive prompts from blocking turns:

```toml
[timeouts]
# Max idle time for short commands before prompting or backgrounding (seconds)
command_idle_secs = 30

# Whitelist of slow build/test commands to prevent premature timeouts
long_running_keywords = ["cargo", "npm", "pnpm", "mvn", "gradle", "docker", "make"]
```

---

## 4. Dedicated Configuration Guides

JeikCode modularizes specific capabilities into dedicated documentation pages:

- **[Model Configuration](/guide/login)**: Set up provider accounts (`provider_accounts`), model profiles (`models`), reasoning budgets, and vision preprocessors;
- **[MCP (Model Context Protocol)](/advanced/mcp)**: Connect external databases, browser automation, and local tool servers;
- **[Skills Ecosystem](/advanced/skills)**: Author and manage custom domain workflows and prompt templates.
