# JeikCode Architecture — Module Map

## Current Runtime Call Chain

```text
CLI / TUI / daemon / background / ACP / clix
                    │
                    ▼
       CodingRuntimeHandle / DriverCommand
                    │
                    ▼
       jeikcode-coding (CodingRuntime)
                    │
                    ▼
       jeikcode-kernel (Neutral Agent)
```

Drivers own input, rendering, and protocol adaptation. The coding runtime owns
the coding lifecycle. `jeikcode-core`, the old driver protocol, and bridges are
no longer part of the current workspace and are not fallback paths. Historical
migration documents are not the current module map.

## Crate Overview

| Crate | Role |
|-------|------|
| **jeikcode-kernel** | L0 neutral agent loop, messages/events, provider/tool traits, hooks/middleware, and checkpoint boundaries |
| **jeikcode-capabilities** | L1 reusable providers, tools, MCP, skills, sessions, memory, CodeIntel, and setup capabilities |
| **jeikcode-coding** | L2 coding assembly, persona, CodingRuntime lifecycle, approvals, and goal/loop coordination |
| **jeikcode-review** | Independent review specialization that assembles the kernel for its own use case |
| **jeikcode-tuix** | Terminal input, retained-mode rendering, modals, and runtime event presentation |
| **jeikcode-cli** | CLI entry point, background tasks, and ACP integration; starts and controls the coding runtime |
| **jeikcode-daemon** | HTTP/WS/SSE and WebUI services; controls business state through the runtime |
| **jeikcode-clix** | clix command-line integration |
| **jeikcode-config / auth / telemetry / updater** | Configuration, authentication, telemetry, and update infrastructure respectively |

Dependency direction: `kernel ← capabilities ← coding ← Driver`. The kernel
does not depend on business logic or frontends; capabilities do not depend on
L2; coding does not depend on frontends.

## Coding Assembly and State Ownership

| Source file | Responsibility |
|-------------|----------------|
| `crates/jeikcode-coding/src/parts.rs` | Two-stage `prepare` / `assemble` flow; `CodingParts` retains tools, hooks, MCP, approvals, and session binding |
| `crates/jeikcode-coding/src/assemble.rs` | Wires the kernel agent to the coding persona and capabilities; also provides the minimal synchronous assembly entry point |
| `crates/jeikcode-coding/src/provider_factory.rs` | Provider and subagent tier construction |
| `crates/jeikcode-coding/src/runtime.rs` | `CodingRuntime` owns a replaceable kernel `AgentHandle`; coordinates `DriverCommand`, generations, pending requests, reconfiguration, and terminal states |
| `crates/jeikcode-coding/src/session_runtime_registry.rs` | Live session runtime registration and event subscriptions, not a second agent lifecycle |
| `crates/jeikcode-capabilities/src/session/manager.rs` | Native session aggregate persistence, leases, directory metadata, and historical imports |
| `crates/jeikcode-capabilities/src/session/snapshot.rs` | Working-set snapshots and checkpoint persistence |
| `crates/jeikcode-capabilities/src/session/presentation.rs` / `transcript.rs` | Presentation records and per-turn transcripts, distinct from the model working set |

`SessionBinding` holds session identity, manager, lease, and the recovery
snapshot. Provider-only reassembly reuses session-owned parts. Operations that
change the conversation, provider, session binding, or generation must go
through runtime transactions; drivers must not bypass these by writing files.

## Integration and Data Flow

Entry points include CLI `src/main.rs`, ACP `src/acp/engine.rs`, and daemon
`src/kernel_runtime.rs`. TUI `src/event_loop/` consumes the runtime control plane
and events. WebUI embedding is defined by `WebuiAssets` in
`crates/jeikcode-daemon/src/webui.rs`; the CLI reuses that service implementation.
Build and release instructions are in [release-tutorial.md](release-tutorial.md).

```text
User input / protocol request
    ↓
Driver → CodingRuntimeHandle / DriverCommand
    ↓
CodingRuntime: submit, steer, cancel, approve, switch sessions, reconfigure
    ↓
kernel AgentCommand → neutral agent loop → provider / tool / hook
    ↓
AgentEvent → CodingRuntimeEvent (requests, state, terminal states, persistence warnings)
    ↓
Driver rendering / HTTP, WS, SSE responses
```

The native session snapshot is the source for restoring the model working set.
Metadata, presentation records, and JSONL each have separate responsibilities.
`SessionContextHook` keeps project instructions inside the protected prefix and
reconciles changed files at turn boundaries. Its legacy standalone baseline
block is removed: operating-environment facts are supplied by the persona
`<environment>` block, with Git branch captured when that persona is assembled.
“Frozen” here means protected from compaction, not a guarantee of byte-level
immutability across explicit hot-reloads. The append-only requirement and live
reload exception still need a separately agreed contract; this cleanup does
not change either mechanism.
Legacy JSON enters through an explicit historical importer, not a live dual-write
model. See [target-architecture.md](target-architecture.md) for detailed current
constraints and future consolidation principles.
