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

The unaccepted 409 retry is not deduplicated by matching user text against
the entire transcript: historical turns may contain the same text, and two
distinct rejected submissions can differ by attached images or approval mode.
Use the already-supported string `id` in `/chat/queue` as a stable rejected
request marker, preserve it across local/server queue restore, and deduplicate
only identical request IDs. Serialize the existing `approval_mode` field so
cross-device restoration preserves the requested mode without changing the
queue endpoint schema. Once explicitly steered, the item follows the existing
steer delivery lifecycle.

Post-review identity/receipt closure: a rejected retry with kind `steering`
remains unaccepted while its steer POST is in flight, including across A→B→A;
only an accepted/folded `steer` may use ordinary transcript settlement. A
stale server queue snapshot cannot rehydrate a retry already confirmed
cleared by this tab. More importantly, retry draining (including Send Now)
serializes this tab's `/chat/queue` writes and requires an acknowledged
successful queue removal before sending or stopping an active turn; on an
unavailable queue endpoint the item remains queued. A delayed 409 after
switching to B repairs only originating A's uniquely stamped optimistic
cache and persists A's retry with its exact request id/images/mode; B's
foreground state is never mutated. The existing queue JSON protocol is not
expanded. Cross-device concurrent last-writer queue writes and real two-client
browser behavior still need separate native/browser evidence.

The queue-clear receipt uses the existing `/chat/queue` `{ success: true }`
response. A rejected retry cannot be sent if the receipt fails; this tab's
queue writes are chained per session so a delayed previous enqueue cannot
overwrite the clear. A pre-clear GET response is filtered by the exact
cleared request id. Failed or view-switched sends restore the originating
queue entry, and unmounted views cannot admit another request. The submitted
message is never inferred from a historical text match.

## Pre-delivery queue recovery hardening

- A pending 'steering' retry remains unaccepted until Steer HTTP completes.
  On off-screen resolution, the same session's server queue updates to
  'steer' (accepted) or 'queue' (failed), not only local storage.
- The /chat/queue endpoint acknowledges a successful persisted-file update,
  not merely a change in memory. A same-directory temporary file protects
  nonempty writes; file permission/I/O failures fail closed before mutating
  the map. Session IDs cannot supply path components.
- Automatic retry and Send Now use session-scoped reservations, not one
  global in-flight lock. Send Now also guards its original session at and
  after Stop and at the actual dispatch boundary, restoring the retry if
  its view changed instead of submitting through another session's canvas.
- Upstream beta advanced again to 08b9fe065 with Stop-and-Wait and direct
  Send Now changes. The next integration must preserve those maintainer
  improvements, not revive the superseded arbitrary 250 ms timeout.

### Historical upstream build blocker (resolved by #30)

The freshly fetched upstream beta commit 08b9fe065 has a failing Rust quality
workflow (jeikl/JeikCode Actions run 38045706167). Its session-deletion path
calls two capabilities which are absent from the corresponding upstream
source: bash_runtime::kill_by_session_id and tools::cleanup_session_logs.
Windows targeted daemon tests also fail to compile on cleanup_session_logs.
These pre-existing beta source errors are separate from M05b; do not silently
add a filesystem/log-delete implementation or claim final Rust verification
while the upstream baseline remains broken. The M05b queue-file persistence
tests last passed at the previous c5fdd705 baseline; revalidation on a
repaired beta remains REQUIRED.

## Historical 2026-10-10 handoff checkpoint (superseded below)

- Fork branch: fix/m05-approval-replay-20261010. Last published fork HEAD:
  09d872b8a7350a96e241c671031506b745ea8ecc. Local newer commit:
  eceb79b6f275e8ffbbf00b22244a71bb6b938f66 (not pushed).
- In-progress normal merge: local HEAD eceb79b6, MERGE_HEAD upstream beta
  08b9fe065fddde602495d939eba6f9037bbe2ca5. Conflicts in Chat.tsx
  were resolved; the merge has NOT been committed or pushed.
- The staged candidate integrates upstream Stop-and-Wait/direct Send Now,
  preserving view/generation ownership without a 250 ms timer. New M05b
  queue logic serializes updates per session, requires a disk-backed clear
  acknowledgement before retry admission, excludes pending/cleared IDs from
  stale GET reconciliation, persists off-view Steer results and late-409
  retries to their original session, and locks GET fallback against queue
  update to prevent stale in-memory resurrection.
- On Windows, combined-source WebUI suite: 459 passed, 0 failed; TypeScript
  typecheck PASS; production Vite build PASS; cargo fmt check PASS. Real
  two-browser and packaged/native smoke are NOT YET VERIFIED.
- Current Rust daemon test and check are BLOCKED by the two upstream 08b9
  undefined functions (same failure in upstream CI run 38045706167). Prior
  daemon 393/393 tests belong to c5fdd705, not the current combined tree.
- Independent exact-final-tree review was requested but worker revival was
  blocked during conversation transfer. Do not claim clean independent
  review, FORK_VERIFIED, submission readiness or upstream CI green.
  Next: resolve or coordinate the beta compilation break, rerun Rust tests,
  complete independent exact-tree review, then fork push and PR if ready.

## 2026-10-11 published beta integration

- PR: https://github.com/jeikl/JeikCode/pull/31. Source integration commit:
  `4a8c32063908075c5bd657d5589969ddd393a818`, a normal merge of the
  reviewed replay head `131fa6af22941d32bc8556117af51e18c80335c9` and beta
  `efd9b1864e81fd42d32bf00e9560d6af12a0ee5d`. No history rewrite.
- The old undefined-cleanup blocker is addressed by the reviewed #30
  implementation. Its final head `38d9f590d565401470784bc671d8ba74276b502b`
  passed all 15 hosted CI/native-portability checks; source is shared here.
- Every revisionless canonical history GET retains its reconciliation
  barrier. The integrated production-function smoke performs two canonical
  reads for patch followed by delayed delete and preserves the surviving
  turn in canvas, session cache and persistence publication. Its read and
  persistence adapters are controlled; it is not a real daemon HTTP smoke.
- Independent targeted canonical-barrier, cleanup-identity and regression
  isolation reviews found no remaining blocker in their inspected scopes.
- Existing browser ownership evidence is retained for unchanged paths.
  Exact-head hosted checks include WebUI, workspace, real cleanup, rolling
  logs, daemon channel/replay contracts and native platform/subset suites.
  Current results and exact run links are maintained in the PR body.
- Historical test counts above belong to their stated revisions. No new
  local Cargo compilation/tests, packaged native smoke or real two-client
  browser verification is claimed by this integration.
- Protected beta still requires independent maintainer approval;
  repository auto-merge is disabled. Submission is not an upstream merge.

## 2026-10-11 CI-first cleanup and native replay resumption

- Resumed from `plans/handoffs/pr30-pr31-ci-resume-20261011-paused.md`.
  The separate untracked handoff remains outside this milestone's Git changes.
- PR #30 cleanup was published to the fork at
  `4d594c2b25660ec4b742565676a48b3fff170ac1`, preserving its original
  `3ae5d8eecb257f9eed562036167be69e2cb4bd89` source and integrating
  upstream beta through `8ed5aaab3a32849b2e9613c7be7399348e056dda` via
  ordinary merges. Its exact-head CI/portability runs are
  `38107043999`/`38107043993`, superseded by the later compiler-fix update.
  Upstream `8ed5aaab3` initially introduced an unstable attribute on an
  assignment expression (E0658): upstream CI `38106799886` failed. Upstream
  corrected it in `4c43052477f041de1f8dea336203b01405773733` using
  `PgroupChild::mark_terminated()`; CI `38106997679` and portability
  `38106997683` passed. PR #30 then published a normal merge of that precise
  correction as `a82fb39fe0107f21e10e4964297d8cc5cd2367de`.
- The original unpushed native replay daemon correction
  `10c3a68fe366d313246ea43918dcba74bab6de5a` was retained, and the
  previously uncommitted cancellation test adjustments were independently
  reviewed and committed as `4f40ca8b1e012d34284c2047656f0bd65a960808`.
  The test keeps unsolicited progress snapshots distinct from native terminal
  receipts, asserts exact submitted/accepted input identities, and uses the
  kernel's actual Cancel -> TurnComplete -> requested Snapshot ordering.
- Local replay integration merge
  `7df9dfae371105eaf85560bc64fb56ababf0399c` has parents `4f40ca8b1`
  and cleanup `4d594c2b2`. Both source branches retain normal ancestry. Its
  two conflict resolutions preserve all three CI executions: actual assembled
  session DELETE/process-log smoke, persisted mixed-source catalog timestamp
  smoke, and native CodingRuntime -> daemon `/live` HTTP journal-gap smoke.
  The bilingual Unreleased history/cleanup/security entries are retained.
- Follow-up replay merge `496b49e3b7b5ffa952db43c7e1d3433a5216c650`
  has parents `7df9dfae3` and corrected cleanup `a82fb39fe`; it fixes the
  inherited beta E0658 while preserving the uncommitted handler SSE test and
  this plan bit-for-bit during the merge. No source reset or history rewrite.
- The merged beta includes the standalone #36 timestamp correction: native
  epoch-millisecond `both` 2000/4000 and `native` 1000/1000 remain unchanged;
  only legacy-second `legacy` 1000/2000 values are converted. PR #30 source
  SHA `3ae5d8e` exercised the actual catalog executable and targeted mixed
  native/legacy regression in CI run `38104863646`, as well as the full native
  library matrix in portability run `38104863652`. These successful older
  runs do not validate either newer integration head.
- An additional scoped daemon test exercises the real `chat_watch` handler's
  SSE serializer with a late admitted user (`replay=true`) followed by a new
  warning event (`replay=false`); it is handler-level verification, not a
  live HTTP transport or two-browser test. The existing Linux `/live` smoke
  uses a real daemon HTTP connection and real foreground Bash child, with a
  deterministic in-process LLM provider. Neither fixture proves packaged app
  installation, native activation, or physical multi-device reconnection.
- Upstream `beta` advanced during the review; its E0658 fix at
  `4c43052477f041de1f8dea336203b01405773733` is now present in BOTH
  branches through normal merges. The earlier `4d594c2b2` hosted runs cannot
  validate the corrected branches. Recheck the live beta tip and exact-head
  Actions before declaring either PR ready for maintainer review.
- Exact-head replay CI, cross-platform portability, the watch handler test,
  merged cleanup/catalog smokes, final independent source review, and
  maintainer approval remain gates. No broad local Cargo build, persistent
  Cargo cache, force push, upstream merge, release, install, or activation is
  authorized or claimed by this checkpoint.
