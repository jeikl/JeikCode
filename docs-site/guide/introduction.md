# Introduction

JeikCode is a full-featured, high-performance AI Coding Agent designed for professional software engineers. Built from the ground up in Rust, it delivers lightning-fast responsiveness and minimal resource usage, providing a unified developer ecosystem spanning rich terminal TUI, modern browser WebUI, desktop apps, and headless daemon services.

---

## Why JeikCode?

### 1. Ultra-Lightweight Native Speed
Unlike heavy Node/Electron-based coding assistants, JeikCode's core runtime is written in Rust. It has a tiny memory footprint, launches in milliseconds, and remains silky smooth even under intense multi-turn, multi-file refactoring sessions.

### 2. Multi-Interface Unified Experience
- **Interactive TUI**: A responsive terminal interface with syntax-highlighted diffs, tool execution cards, and keyboard shortcuts.
- **Embedded WebUI**: Type `/webui` in your terminal to instantly launch a local web interface with live bi-directional sync, drag-and-drop image uploads, and visual model management.
- **Desktop Shell**: Lightweight desktop application powered by Tauri 2.0.
- **Background Daemon**: Headless service with SSE and HTTP endpoints for CI/CD pipelines and remote workspaces.

### 3. Decoupled Provider & Model Architecture
JeikCode decouples provider accounts (API keys, base URLs, credentials) from model specifications (reasoning effort, context window, vision support). Developers can map multiple distinct model behaviors to a single account or seamlessly switch between local and cloud providers.

### 4. Advanced Tooling & Extensibility
- **CodeIntel Graph**: Semantic code search enhanced by a bilingual thesaurus that bridges cross-language concepts and builds symbol call graphs.
- **Model Context Protocol (MCP)**: Native support for standard MCP servers to connect external databases, browser automation, search engines, and enterprise APIs.
- **Dynamic Skills & Hooks**: Automated lifecycle hooks and reusable prompt workflow packages.

---

## Core Design Principles

1. **Context Immutability & KV Cache Optimization**: Strict append-only prefixes guarantee high server-side prompt caching hit rates, cutting latency and API costs significantly.
2. **Subagent Parallelism**: Concurrently dispatches read-only `explore` subagents and scoped `worker` subagents to divide and conquer large codebases.
3. **Safety & Permission Gates**: Destructive shell commands and broad file rewrites require explicit user approval.
