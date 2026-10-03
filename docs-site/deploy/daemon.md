# Headless & Background Daemon

In addition to the interactive terminal (TUI), JeikCode provides two headless operational modes:
1. **Headless CLI Mode (`-p / --prompt`)**: Ideal for CI/CD automation, scheduled tasks, and command-line pipelines;
2. **Background Daemon Service (`jeikcode daemon`)**: An HTTP + SSE long-running server designed for remote WebUI clients and IDE integrations.

---

## 1. Headless CLI Mode

Passing `-p / --prompt` executes a single prompt non-interactively and writes the final output directly to stdout:

```bash
# Generate a quick summary of the project
jeikcode -p "Summarize tech stack and core architectural modules"

# Pipe agent output directly into a file
jeikcode -p "Draft a comprehensive README.md for this workspace" > README.draft.md

# Run in CI pipelines with turn limits
jeikcode -p "Run cargo test and fix any compilation errors without altering API signatures" \
         --max-turns 20 --disable-tools web_search,web_fetch
```

### Common Headless Arguments

| Flag | Description |
| :--- | :--- |
| `-p, --prompt TEXT` | Task description or prompt to execute |
| `--prompt-file PATH` | Read prompt from a file (useful for large multi-line prompts) |
| `-v, --verbose` | Stream tool execution logs and token stats to stderr without polluting stdout |
| `--max-turns N` | Enforce an upper bound on turns to prevent infinite loops |
| `--disable-tools LIST` | Comma-separated list of tools to disable (e.g. `bash,web_fetch`) |
| `-C, --dir PATH` | Set target working directory (defaults to current working directory) |
| `--provider / --model` | Temporarily override provider or model profile for this run |
| `--no-telemetry` | Disable telemetry reporting for this execution |

---

## 2. Background Daemon Service

The Daemon service exposes JeikCode's core capabilities over standard REST and Server-Sent Events (SSE) interfaces.

### Starting the Service
```bash
jeikcode daemon --host 0.0.0.0 --port 8000
```

### Systemd Service Configuration (Linux)

Create `/etc/systemd/system/jeikcode-daemon.service`:

```ini
[Unit]
Description=JeikCode Background Daemon Service
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu
ExecStart=/usr/local/bin/jeikcode daemon --host 127.0.0.1 --port 8000
Restart=always
RestartSec=5
Environment=JEIKCODE_CONFIG_DIR=/home/ubuntu/.jeikcode

[Install]
WantedBy=multi-user.target
```

Enable and start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now jeikcode-daemon
```

---

## 3. Docker Containerization

Production Docker files are provided in the `docker/` directory:

```bash
# Build the daemon image
docker build -t jeikcode-daemon -f docker/Dockerfile-Daemon .

# Run container mounting local configuration and code workspace
docker run -d \
  --name jeikcode \
  -p 8000:8000 \
  -v ~/.jeikcode:/root/.jeikcode \
  -v $(pwd):/workspace \
  jeikcode-daemon
```
