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
