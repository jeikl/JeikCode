# M05b / JC-14 — Restore unanswered approval after replay

## Outcome and ownership

Fix the reproduced WebUI session-reconnect failure in existing /chat/pending
replay handling. A tool's ToolCallStarted record may precede its
PermissionRequest, so it must not suppress that later unanswered card.
Likewise, a pending-permission fallback file must not be misclassified as
resolved because of a start before the request.

This is existing single-agent/session behavior, not new delegation,
persistence, scheduling, or an API-contract expansion.
Tracker: https://github.com/xuan2261/JeikCode/issues/2

## Baseline and reproducibility

- Branch: fix/m05-approval-replay-20261010 on the user fork.
- Isolated worktree: C:\Work\JeikCode\.worktrees\m05-approval-replay.
- Fresh upstream jeikl/JeikCode:beta at
  8f7d49d9efdb596cd1c74b2acf546ed0386d8722 (7.2.1-beta.8).
  Re-fetch before delivery.
- Unmodified upstream test
  channel_mode_tests::pending_interactive_from_replay_keeps_unanswered_permission
  FAILED (0 passed / 1 failed) on an isolated clean detached baseline
  control, and repeated twice on the unmodified resolver in another worktree.
  Root cause: ToolCallStarted(c1) inserted c1 into the resolved set before
  a later PermissionRequest(c1) was examined.

## Acceptance

1. ToolCallStarted(c1) followed by PermissionRequest(c1) remains pending until
   a subsequent execution/result/output or terminal event.
2. A subsequent start/output/result resolves the pending card; a terminal
   turn never restores it.
3. If call_id is reused after a prior resolution, a later request is again
   pending. A different call ID must not alter it.
4. pending_interactive_from_replay and the disk fallback's
   replay_resolves_call agree on event ordering, including the checkpoint gap
   when the log contains only a pre-approval ToolCallStarted.
5. The WebUI must render a current server permission event or /chat/pending
   response even if an earlier tool row with that call_id appears pending or
   completed on the canvas. A subsequent execution start/output/result may
   close only the exact approval observed in that ordered stream; a terminal
   closes the turn. A pre-approval replayed start cannot clear a card that
   /chat/pending already restored. Auto/bypass never prompts.
6. Where the provider reuses call_id, old result/replay events must not clear
   a new checkpoint or modal. Use the existing approval_id and exact active
   responder registration to reject stale sidecars and historical results.
   GET restoration outranks earlier events in a concurrent watch replay.
   A slow GET from a disconnected watcher must be invalidated on same-session
   watcher replacement and terminal, even when session generation is unchanged.
   If an SSE permission changes while a GET is in flight, a conflicting older
   GET payload must trigger a fresh authoritative check, not overwrite the
   newer modal; this is separate from watcher replacement.
7. Preserve existing WebUI and GET /chat/pending protocol shape, user-input
   replay behavior and single-agent ownership. Test with isolated home,
   pinned Rust and --locked; independent review and fork-only CI follow
   the exact final SHA.
8. If a replay edge is withheld until a fresh /chat/pending check and that
   GET fails, a quiet SSE stream must not leave the newer approval hidden.
   Retry the existing GET with per-watcher bounded backoff (1/2/4/8s cap),
   no overlapping retry timers and fail-closed replay authority. Responses
   and retries from replaced/terminal/unmounted watchers must not restore a
   card. An authoritative empty GET must settle the exact previously restored
   approval (without dismissing a newer approval sharing the provider call ID).
   The persisted GET replay barrier and the most recently surfaced approval
   must be tracked separately: a newer SSE card replaces the visible identity
   even if the GET barrier still references a prior approval.

## Post-commit UI recovery follow-up

The fork-verified `c4f339ec` revision predates acceptance #8. A later
independent read-only review identified the unhandled transient GET failure:
`Chat.tsx` caught the error without retry; the replay cursor could remain
behind `restoredApprovalId` indefinitely with no subsequent SSE edge.
The corrective candidate changes only WebUI GET retry handling and pure
cursor tests. The old fork CI and native daemon results apply only to
`c4f339ec`; any new candidate requires its own revision-bound checks.

## Exclusions and separate issue

- No code-file rewind, agent orchestration architecture, schema migration,
  package install, native activation, upstream PR, merge, or release.
- History edit/delete/truncate targeting remains a separate BLOCKED
  DESIGN-ONLY investigation in m05-history-target-index at the same base.
  Its locally staged candidate had three independently reviewed Important
  targeting regressions caused by folded tool messages, injected/presentation
  rows and display-only truncation. Do not publish that candidate; stable raw
  source identity requires public-contract coordination.
- Other unrelated baseline failures are not claimed resolved.

## Beta integration checkpoint — 2026-10-10

This section supersedes only the *fork-only, no-upstream-PR* delivery
restriction above: the user subsequently authorized integration testing,
fork verification and a focused PR to beta, but **not** merge, release,
installation or native activation.

- Prior verified fork tip: `dae015bf096c1093f42814e9655b398107c143c8`.
- Fresh beta base: `c7732470fccde79531de5df0a0e2ddc962c1151e`.
  Preserve both histories with a normal merge commit, never rewrite the
  published contributor branch.
- Preserve beta's flash-disconnect circuit breaker, idle-watch cache and
  background execution while merging M05b's approval replay cursor, epoch
  invalidation and bounded GET retry. A suppressed reconnect still invalidates
  the previous watch's in-flight GET.
- Independent cross-branch review identified background session hazards:
  an off-screen approval edge being consumed without warm-return recovery,
  off-screen watch close settling the visible session, and detached EOF/error
  cleanup terminating unrelated watchers. Bound cleanup and modal restoration
  to session/controller identity; a running warm return must recheck current
  GET /chat/pending even when its watcher survived in the background.
  Retained SSE and warm GET **share the same per-controller replay cursor**:
  a P3 event overtaking a slow GET P2 increments one common revision, and a
  background P2 must remain paired with its own later tool result. A rejected
  watch closes the same identity-scoped route as clean EOF; when SSE remains
  down, the existing 8-second disconnected-only fallback also rechecks pending
  approval instead of relying on a single GET.
- A stopped-but-not-yet-terminal operation must not appear active to GET
  /chat/pending; the ACK-to-runtime-cancellation interval cannot surface
  a stale approval even if its responder and sidecar still exist.
- Acceptance gates: exact combined source review with no outstanding
  Critical/Important; cargo fmt and daemon library tests/check with --locked
  and isolated JEIKCODE_HOME; WebUI pure-cursor and cross-session regressions,
  typecheck, full tests and production build; fork branch HEAD/CI verification.
  Record browser two-client reconnection, real IDE/native and packaged smoke
  as NOT YET VERIFIED unless actually exercised.
- Separate M05a persisted history identity remains design-only/blocked; never
  integrate its staged history action changes into this milestone.

## Final upstream refresh

Before fork delivery, upstream `beta` advanced from `c7732470f` to
`c5fdd7052ae92cc220cca96e9129d02fb371c3e0` (three commits). The existing
M05b merge commit `62d164140208182a7eabb8f4021f6afdfe814b3c` retains
its original two parents; integrate the new beta commits with an additional
non-rewriting merge commit. Preserve upstream's bash runtime lifetime,
409-conflict rollback, background queue-drain guard, translated notice and
todo-panel rendering in the final tree. Recheck this exact combined revision
and state the remaining browser/native smoke gaps in the PR.

The new beta 409 `session_busy` rollback path has one additional recovery
requirement: submitting while another client wins admission must remove the
rejected optimistic local-turn owner, preserve the queued user prompt, and
immediately resume the *existing* session's `/chat/watch` plus authoritative
`/chat/pending` GET. Without that reattach, an approval arriving after 409
remains hidden until a sidebar switch. The callback is gated by the original
submission's current view/session identity; it must not create a new runtime,
attach the wrong session, or bypass the queue-drain guard.
