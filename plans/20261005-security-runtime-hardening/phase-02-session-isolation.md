# Phase 2 — Session isolation roadmap

## Priority

P1 — included in the current security PR using per-runtime state ownership.

## Confirmed defects

- Bash background `REGISTRY` and `BACKGROUND_ALERTS` are process-global while `SessionRuntimeRegistry` supports concurrent sessions.
- `SESSION_KEYWORDS` and `BOUND_BASHKW` are a single process-global overlay/sidecar binding.
- `kill_by_pid` does not verify session ownership.
- `MAX_LIVE_SESSIONS` currently counts handle-less view rows, so view subscriptions can consume runner capacity.

## Target architecture

Own Bash runtime state by a per-CodingRuntime shared state object passed through tool assembly, and require ownership for list/log/kill/keyword operations. Primary tools, child/subagent tools, and the status-reminder hook share that runtime-local object. `Reprepare` reuses it; Fresh/Resume/ChangeDirectory create a replacement state and cancel the outgoing state's live Bash jobs only after rollback-capable transition steps have succeeded. Keep the neutral kernel free of session identity.

## Acceptance criteria

- A session sees only its own background commands, alerts, logs, and long-command keywords.
- A session cannot kill another session's `pid`.
- Starting/resuming session B cannot rebind or overwrite session A's keyword sidecar.
- Reprepare preserves the current runtime's Bash state; Fresh/Resume/ChangeDirectory do not leave detached jobs owned by the outgoing runtime.
- Concurrency/runtime-scope tests cover independent state objects rather than only sequential global rebinding.

## Deferred follow-up in this phase

`SessionRuntimeRegistry::MAX_LIVE_SESSIONS` still counts handle-less view rows. Correct runner-capacity accounting (including a regression for more than 32 view-only subscriptions) remains a separate architecture follow-up and is intentionally not part of this security PR.
