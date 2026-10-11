# M05 / JC-14 — TUI test contract reconciliation

## Outcome and source pin

Reconcile ten inherited TUI unit-test assertions with the current source-build
contracts, without changing runtime behavior. This is a separately reviewable
fork-first test/CI maintenance milestone, not part of PR #30 or PR #31.

- Source baseline: upstream `beta` at `c0e315473b34a45cb18831fda5be8169b085ca29`.
- Failure evidence: [PR #31 Rust quality job 114391037560](https://github.com/jeikl/JeikCode/actions/runs/38112532381/job/114391037560)
  on `202e97538671e3b4f519c5f9862f9e9a116d06e2`, with 1,752 TUI
  library tests passing and ten failing. The failing event loop, retained
  renderer and auth gateway source blobs are identical at the pinned upstream
  beta, so the failure is not introduced by PR #31.

## Root causes and narrow corrections

1. Four provider-auth assertions assume the retired CodingPlan gateway signer
   still identifies protected gateways. Current source
   `jeikcode-auth::gateway_crypto` explicitly disables signing and gateway
   classification. Confirm ordinary configuration changes remain reloadable
   without login; do not resurrect signing or auth-driven deactivation.
2. Two skill-menu assertions still search `atom smoke` after the registered
   fixture was renamed to `jeikcode-smoke-test`. Match actual name fragments
   while preserving the menu's AND-filtering and negative case.
3. Two streaming slash-command assertions say `/new` or `/clear` are blocked,
   contradicting the existing explicit session-command allowlist and its
   positive tests. Preserve the allowlist and negative tests for commands
   outside it.
4. One Todo detail assertion expects an unsupported `list` action. Pin the
   supported `clear` rendering and the unsupported `list` fallback; do not
   expand the canonical Todo action schema.
5. One steady-state renderer assertion counts the Unix 3-byte DA1
   input-parser recovery query as a fifth frame write. Verify that separate
   terminal-safety write and keep the four-write frame budget unchanged.

## Verification contract

- Explicitly run `cargo test --locked -p jeikcode-tuix --lib -- --test-threads=1`
  in hosted CI, and in the native Ubuntu, Windows and macOS portability matrix.
  Existing checks alone did not cover this TUI test suite.
- Run repository-format and diff hygiene checks locally only where they do not
  build large Cargo caches. Attribute successful CI to the exact candidate SHA;
  missing, skipped or failed jobs are not PASS.
- Review the final Git diff independently before publication. Preserve
  repository-owned documentation and all existing released bilingual changelog.
- Scope excludes gateway signer restoration, public protocol changes,
  additional delegation/orchestration, new features, PR #30/#31 source edits,
  upstream PR publication, merge, tags, release, installation and activation.

## Delivery gate

Target `FORK_VERIFIED` on a dedicated fork branch. An upstream contribution
or integration into protected `jeikl/JeikCode:beta` remains a separate,
explicitly authorized and reviewed step. A passing fork check cannot replace
the required maintainer approval for existing PR #30/#31.
