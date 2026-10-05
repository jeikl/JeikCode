---
title: Security runtime hardening
status: ready_for_pr
branch: fix/security-runtime-hardening
base: main@20d0f2a3ab82d35deeb4e331f90d42579c9491c9
mode: tdd
---

# Security runtime hardening

## Outcome

Close the highest-confidence local/remote security boundary defects found in the 2026-10-05 repository audit without changing JeikCode's neutral-kernel architecture or widening the PR into a general daemon/runtime rewrite.

## Scope for this PR

1. Fail closed when a standalone daemon is explicitly bound to a non-loopback interface without authentication.
2. Prevent `/git/discard` from deleting an untracked path outside the selected repository, including `..` and symlink/junction escapes.
3. Make sensitive read/write approval inspect the resolved filesystem target so a benign symlink/junction name cannot hide a credential path.
4. Replace process-global Bash background/session-keyword state with per-runtime ownership so concurrent sessions cannot leak/control each other's tasks.
5. Add regression tests that fail on the audited vulnerabilities and pass only with the boundary fixes.

## Explicit non-goals for this PR

- Do not redesign the kernel, provider abstraction, or daemon routing model.
- Keep Bash isolation to the per-runtime state refactor validated in Phase 2; do not broaden it into SessionManager persistence or kernel session-identity changes.
- Do not combine CI/release reproducibility, installer checksum, npm lockfile, or build.rs hermeticity repairs into this security-boundary PR.
- Do not add a new sandbox framework. Opaque Bash execution policy is Phase 3.

## Acceptance criteria

- [x] Loopback standalone daemon behavior remains compatible with existing IDE/VS Code clients.
- [x] A standalone daemon cannot expose protected mutation routes on a non-loopback bind with token enforcement disabled, including runtime remote-access expansion.
- [x] `/git/discard` untracked deletion accepts a Git-confirmed repository-relative target and rejects absolute/outside/traversal, forged-untracked, tracked-subtree, and pathspec-broadening cases.
- [x] Sensitive Safe read tools and write auto-approval classify the canonical target and fail closed when a missing target cannot be resolved safely.
- [x] Concurrent runtimes have isolated Bash tasks, alerts, kill control, and session keyword sidecars; session-changing reconfiguration cancels only the outgoing runtime's jobs.
- [x] Ordinary non-sensitive reads still bypass approval as before.
- [x] Regression tests cover all four repaired trust boundaries and the runtime transition lifecycle.
- [x] Relevant targeted tests pass and `cargo check --workspace --all-targets --locked` passes with an isolated `JEIKCODE_HOME`.
- [x] Pending diff received independent architecture and security reviews with 0 Critical and 0 Important unresolved findings.

## Execution phases

- [Phase 1 — Boundary repairs](phase-01-boundary-repairs.md): this PR.
- [Phase 2 — Session isolation](phase-02-session-isolation.md): included in this PR using per-runtime state; no SessionManager/kernel identity redesign.
- [Phase 3 — Process and filesystem hardening](phase-03-process-fs-hardening.md): follow-up P1/P2.
- [Phase 4 — CI, release, and supply-chain convergence](phase-04-ci-release-supply-chain.md): follow-up engineering lane.

## Verification matrix

| Contract | Lowest reliable check | Whole-scope check |
| --- | --- | --- |
| Non-loopback auth | daemon unit/integration tests around server auth policy | `cargo test -p jeikcode-daemon --lib --locked` |
| Git discard containment | `api_git` unit tests for descendant/traversal/symlink cases | `cargo test -p jeikcode-daemon --lib --locked` |
| Sensitive resolved target | `sensitive_path` middleware tests | `cargo test -p jeikcode-capabilities --lib --locked` |
| Cross-crate compatibility | targeted coding/daemon tests | `cargo check --workspace --all-targets --locked` |

## Verification evidence

- `cargo check --workspace --all-targets --locked` with isolated `JEIKCODE_HOME`: **PASS**.
- Final targeted security/runtime batch: **11 command groups PASS**, covering standalone auth, runtime remote-access guard, literal Git discard, sensitive read/write approval, Bash runtime isolation/status reminder, CLI token parsing, and CodingRuntime reprepare state reuse.
- WebUI embedding: initial worktree-only failures were traced to ignored `webui/dist/` assets and a cached empty RustEmbed binary. Re-running the two WebUI tests from a fresh `CARGO_TARGET_DIR` with the same-base generated assets produced **2/2 PASS**.
- The pre-existing telemetry integration test expected stale wording (`JEIKCODE_TELEMETRY=0`). The exact test fails on `main`; this branch updates only that assertion to the current `reason: env:TELEMETRY=0` output and the exact test now **PASS**.
- Full `cargo test --workspace --locked` progresses through the telemetry fix and reaches `jeikcode-capabilities`: **1537 pass / 31 fail**. Full-feature baseline filters on unmodified `main` reproduce the unrelated hook, codeintel, plugin, and skill-render failures. Previously compared capability/coding failures are also baseline-equivalent; the timeout helper is timing-sensitive and passes in isolation. The one new full-suite snapshot failure (`pending_code_rewind_restores_workspace_after_interrupted_transaction`) passes exact on both `main` and this branch, so it is order-sensitive rather than a demonstrated regression.
- Independent final architecture and security reviews: **0 Critical / 0 Important unresolved**.
- Local validation host is Windows. Real symlink regression tests guarded by `#[cfg(unix)]` were not executed locally; Linux CI remains required for that platform-specific path-resolution evidence.

## Failure protocol

A failing regression test is evidence, not a reason to weaken the test. Reproduce the failure at the narrowest layer, fix the owning code, rerun the affected test, then rerun the crate/whole-workspace gate. If a proposed fix requires a public behavior or trust-model change beyond these acceptance criteria, stop that lane and move it into the roadmap rather than silently expanding this PR.

## Roadmap priority

- **Completed in this PR:** Phase 1 trust-boundary repairs and the Phase 2 per-runtime Bash ownership/lifecycle slice.
- **Recommended next lane — Phase 4:** establish hermetic, required CI/reproducibility gates first. The baseline comparisons in this PR exposed how much unrelated test/environment drift currently obscures regression signals.
- **Then Phase 3:** opaque executor authority, upload/mkdir bounds, subprocess supervision, approval transport, and secret redaction.
- **Architecture follow-up:** correct `SessionRuntimeRegistry` occupancy so handle-less view rows do not consume live-runner capacity.

## Unresolved questions

- No product decision remains for the Phase 1/2 scope in this PR. Unix-only symlink tests still require Linux CI execution. Any need to add session identity to the neutral kernel remains a stop condition and moves that work to a follow-up.
