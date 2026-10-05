# Phase 3 — Process and filesystem hardening roadmap

## Priority

P1/P2 follow-up.

## Scope

- Treat opaque Bash/interpreter/custom-program execution as unproven for write safety; either escalate approval conservatively or introduce an enforceable writable-root boundary.
- Bound `/fs/upload` request/file/aggregate bytes and define an allowed working-root policy; review `/fs/mkdir` under the same capability boundary.
- Replace blocking `std::process::Command::output()` in async daemon Git handlers with supervised bounded process execution.
- Add Unix process-group cleanup for timed-out subprocess trees.
- Centralize typed approval round-trip handling so timeout/disconnect/cancel is not misreported as explicit user denial.
- Redact secrets before persistent diagnostic logging and make Windows auth persistence atomic/private to the extent supported by the platform.

## Acceptance criteria

Every mutation boundary has a server-side capability/root check, every long-running child has timeout/cancellation ownership, and approval/logging behavior distinguishes user decisions from infrastructure failure without leaking credentials.
