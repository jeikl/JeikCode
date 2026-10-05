# Introduction

JeikCode is a full-featured, high-performance, open-source **AI Coding Agent** built for professional software engineers. Powered by an ultra-fast Rust runtime, JeikCode combines near-instant startup and minimal memory overhead with a complete developer ecosystem covering rich terminal TUI, modern browser WebUI, lightweight desktop apps, mobile-friendly access, and headless server daemons.

::: tip 🚀 Rapid Iteration & Open-Source Co-Creation
- **Hyper-Fast Updates & Rigorous Code Review**: JeikCode adheres strictly to a developer-first ethos. Whenever community members submit issues, suggest features, or open pull requests, the maintainer team promptly conducts thorough code reviews and releases verified test builds (Beta Channel).
- **Standing on the Shoulders of Giants**: JeikCode assimilates the finest engineering patterns and real-world advantages of leading AI coding agents while re-architecting the runtime from the ground up for superior performance and execution discipline.
- **Join the Co-Creation Movement**: We believe the next generation of autonomous coding agents should be shaped by the global developer community. We warmly invite contributors worldwide to submit PRs, share skills, and build the future of AI engineering together!
:::

---

## 1. What is JeikCode?

JeikCode is designed to provide professional developers with an ultra-lightweight, highly controllable, and end-to-end intelligent engineering experience:

- **⚡ Native High-Performance Concurrency**: Written entirely in Rust with zero heavy runtime dependencies, booting in milliseconds and remaining silky smooth during complex multi-turn, multi-file refactoring tasks.
- **🌐 Unified Multi-Interface Ecosystem**: Seamless workflows across a keyboard-centric terminal TUI, a full-fledged Web management workspace (WebUI), a lightweight Tauri-powered desktop client, and a headless daemon service designed for CI/CD pipelines and remote servers.
- **🤖 Full Lifecycle Intelligent Agent**: From repository-wide AST semantic code exploration and calling topology tracking to concurrent atomic file modifications, multi-protocol model orchestration, and Git-like atomic state machines, JeikCode serves as your ultimate engineering copilot and autonomous collaborator.

---

## 2. How Does JeikCode Differ from Other Agents?

JeikCode focuses on real-world engineering velocity, extreme context efficiency, rigorous tool discipline, and full-stack multi-client ergonomics:

### 2.1 CodeExplore: Native Tool-Level Deep Retrieval <Badge type="tip" text="Core Engine" />
**AST Calling Topology & Domain Thesaurus Semantic Search**

- **Broad Multi-Language Support**: Powered by built-in Tree-Sitter parsing engines, natively supporting **Rust, TypeScript, JavaScript, Python, Go, Java, C, C++, C#, Vue, PHP, Ruby**, and 12+ major programming languages.
- **Repository-Wide AST Topology Mesh**: Deeply traces function definitions, call topologies, trait/interface contracts, and module dependencies, providing the Agent with a global overview of the entire codebase.
- **Bilingual Thesaurus & Natural Language Retrieval**: While traditional tools rely solely on rigid symbol matches, JeikCode integrates domain bilingual thesauruses (`thesaurus`). **It empowers developers to query code using everyday natural language or business terminology** (e.g., "how is order timeout handled?", "where does the authentication interceptor take effect?"), and the Agent accurately locates core implementations and upstream/downstream call graphs via `code_explore`.
- **Zero-Touch Incremental Watching**: File changes update incrementally in just 1~3ms with minimal memory footprint and zero idle CPU churn, completely eliminating manual re-indexing.

::: info 💡 Thesaurus-Powered Exploration
Instead of firing naive brute-force greps across your repo, CodeExplore maps high-level developer questions directly into concrete symbol topology networks.
:::

---

### 2.2 98–99% KV-Cache Protection (Sacred Floor) <Badge type="tip" text="Core Moat" />
**Byte-Level Prefix Stability, Zero Cache Thrashing & Slashing Token Costs**

- **98–99% Prompt Caching Hit Rate**: Built upon strict append-only immutability and the `sacred_floor` memory preservation guarantee, keeping system prompts and repo rules byte-frozen across turns.
- **Eliminating Cache Thrashing**: Conventional agents continually modify system prompts or inject dynamic headers, triggering frequent cloud-side KV cache invalidation and latency spikes. JeikCode guarantees rock-solid prefix stability—compaction never touches the sacred floor.
- **Rapid Time-To-First-Token & 90%+ Cost Reduction**: Near-total cache hit rates dramatically compress TTFT to milliseconds and slash LLM token costs by over 90% in heavy production refactoring.

::: tip 🛡️ Why Cache Stability is a Productivity Lifeline
In complex codebases with tens of thousands of lines and multi-turn sessions, robust KV Cache protection ensures refactoring remains lightning fast without escalating bills.
:::

---

### 2.3 Minimalist Prompts & Strict Discipline <Badge type="tip" text="~9–11k Initial Tokens" />
**Extreme Context Efficiency, Fully Open-Source & Hot-Reloadable**

- **Extreme Token Efficiency**: JeikCode adheres to extreme engineering minimalism, eliminating bloated system context overhead. **A standard initial greeting requires only ~9–11k tokens**, reserving the vast majority of the valuable context window strictly for your source code.
- **Rigorous Behavioral Discipline**: Prompt designs balance cutting-edge frontier models and lightweight smaller models, enforcing strict guidelines (concurrency-first execution, immediate error self-correction, closed-loop verification) to eliminate hallucinations and destructive behavior.
- **Open-Source & Live-Reloadable**: All prompt assets are fully open-source and customizable at both project and global levels via Markdown and YAML. Changes take effect instantly without restarting sessions.

---

### 2.4 Cross-Platform & Remote Access <Badge type="info" text="Mobile Optimized" />
**Full Ecosystem Coverage, Mobile WebUI & Enterprise-Grade Security**

- **Multi-Client Unified Workflow**:
  - **Terminal TUI**: A terminal interface featuring syntax highlighting, keybindings, and collapsible live tool execution cards.
  - **Modern WebUI**: Built-in Git version control, multi-turn prompt history, multi-project workspace management, and drag-and-drop interactions.
  - **Desktop Client**: Built with Tauri 2.0, providing native system notifications, tray integration, and OS-level ergonomics.
  - **Mobile-Responsive Experience**: Specifically optimized for phone and tablet browsers with responsive touch controls, enabling on-the-go code reviews, task dispatching, and remote builds from anywhere.
- **Security-First Remote Authentication**: Run headlessly as a background daemon with remote access. Binding to non-loopback network interfaces strictly requires a secure authentication Token, safeguarding systems against unauthorized port scanning.

::: warning 🔒 Security Safeguards
When exposed over local networks or public IP addresses, the backend strictly requires token authentication (`--token` or `JEIKCODE_SERVER_TOKEN`), rejecting unauthenticated access by design.
:::

---

### 2.5 Rock-Solid Tooling & Concurrent Atomic Protection <Badge type="warning" text="Git-like State Machine" />
**Safe Concurrent File Editing for Both Frontier and Smaller Models**

- **Purpose-Built Production Tools**: Every built-in tool in JeikCode is designed as an industrial-strength instrument rather than a gimmick.
- **Concurrent Atomic Protection**: When refactoring multiple files simultaneously, JeikCode enforces strict atomic safeguards to prevent dirty writes, race conditions, or accidental data loss.
- **Git-like State Machine Lifecycle**: Tracks file modifications across turns using a formal state machine. Both powerful frontier models and lightweight smaller models operate safely within these defensive boundaries, backed by one-click undo/rollback checkpoints for worry-free experimentation.

---

### 2.6 Native Support for 5 Major LLM Protocols <Badge type="info" text="Decoupled Architecture" />
**Seamless Integration Across Global Foundation Models**

- **Native Compatibility with 5 Industry Protocols**:
  1. **OpenAI Chat Completions** (industry standard)
  2. **OpenAI Responses** (next-gen structured outputs and streaming)
  3. **Anthropic Claude** (native Messages protocol with Prompt Caching)
  4. **Google Gemini** (native multimodal streaming & ultra-long context)
  5. **Ollama** (local self-hosted open-source model ecosystems)
- **Decoupled Providers and Models**: Configure multiple distinct model variations (custom reasoning effort, context windows, vision fallback) under a single provider credential with effortless switching.

---

### 2.7 Open AI Chat & Third-Party Compatibility Endpoints <Badge type="tip" text="Ecosystem Ready" />
**Unified AI Gateway with Direct OpenClaw Integration**

- **Built-in Tri-Protocol Compatibility Endpoints**: In addition to powering its own interfaces, the JeikCode server exposes standard **OpenAI**, **Anthropic**, and **Gemini** compatible API endpoints.
- **Interoperability with Third-Party Agents**: External developer tools, translation plugins, IDE extensions, or agent frameworks (such as **OpenClaw**) can directly connect to JeikCode as a unified AI gateway and dialog proxy.
