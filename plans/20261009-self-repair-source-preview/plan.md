# Source-selection and evidence-preview pilot

## Outcome and authorization

Continue the accepted source-only repair milestone with a developer-assisted WebUI dialog that prevents wrong-checkout selection and presents exactly the evidence later exported locally. This is the bounded next slice accepted in the 2026-10-09 continuation. Upstream submission, history replacement, installation and activation remain separate decisions.

Roadmap: https://github.com/xuan2261/JeikCode/issues/2

## Baseline and branch

- Existing branch: `feat/community-self-repair-mvp` on the user fork.
- Previous fork-verified P0: `3de4c9effdf658601ecbb446b61d65e10b5fa98d`.
- Fresh upstream beta: `d71653581cfe6b0a5b75ae0c9d349d66c3ea9012`, version `7.2.1-beta.6`.
- Deliberate ancestry-preserving integration: `10c9481b0213d463d2f42451d1d8bca20e9a46b9`, tree `48570db53300c106094b5299475ef7c7a714ee63`.
- Upstream's directory picker and session changes remain intact. The lockfile retains the three existing P0 CLI edges and upstream's Windows dependency/version changes.
- Foundation commit `a1665a11a8d593a4dcececc5b1e8f3ef5fa0e193` still lacks the requested co-author trailer. Preserve published history; this technical increment does not resolve historical attribution or authorize an upstream PR.

## Phase 1 — Native and authenticated transport

- Inject an optional typed backend from the CLI host; leave unsupported hosts explicitly unavailable.
- Reuse native source inspection, run locks, packet digest and local export. Do not change process cwd in an HTTP request.
- Bind source root and frozen packet identity to the selected run before presentation and export.
- Require actual credentials regardless of optional-auth flags, check browser Origin authority, bound JSON bodies and concurrent operations.
- Keep prepare/run/collect and every installed-runtime action outside this HTTP surface.

## Phase 2 — Integrated dialog

- Reuse App dialog ownership and responsive utility controls.
- Add a selection-only mode to the directory browser without session switching or file mutations.
- Show full source revision, separate build observations, frozen base revision and truthful probe status.
- Show all five original strings and their full digest, retain explicit acknowledgment, and invalidate it after source/run/load changes.
- Export to a new daemon-host directory only after explicit confirmation. Keep sensitive UI state in component memory.

## Phase 3 — Verification and disposition

- Native fixture tests: correct source without cwd changes, foreign source/run rejection, valid-hash foreign-packet rejection, exact frozen exports after candidate changes, acknowledgment/destination constraints, checked-in skill loading and explicit nested-directory limitation.
- Daemon route tests: mandatory credentials, origin/authority and schema validation, backend absence, bounded work and request-to-backend behavior.
- WebUI tests: exact packet parsing, truthful status mapping, selection-only behavior and stale acknowledgment protection; run the existing build/type gate with pinned Node and lockfile.
- Re-run affected P0 gates after the upstream integration; preserve Windows and actual Linux sandbox evidence separately.
- Independent review and focused correction precede a single feature commit and ordinary fork push. Record exact final SHA, commands and CI artifact evidence.

## Verification recorded before the feature commit

The native Windows working tree was based on integration commit `10c9481b0213d463d2f42451d1d8bca20e9a46b9`. These are new executions for the P1 source, not reused P0 results. Rust gates used toolchain 1.93.0, `--locked`, an isolated application home, and serial test execution. WebUI used Node 22.22.0 from `.node-version` and the existing npm lockfile.

| Gate | Result |
| --- | --- |
| CLI library `repair::` | 39 passed, including six new native WebUI acceptance cases |
| Daemon `api_repair::` | 6 passed, including real HTTP authentication/Origin checks and cancellation admission |
| Daemon `auth_token::` | 17 passed |
| Daemon embedded WebUI | 2 passed |
| CLI library `build_info::` | 2 passed |
| Capabilities `skills::` | 53 passed |
| CLI repair parser | 2 passed |
| Working-directory integration | 3 passed |
| Full WebUI `npm test` | 432 passed; no skipped or cancelled tests |
| WebUI typecheck and production build | Passed |
| Daemon library and standalone binary `cargo check --locked` | Passed |
| CLI binary `cargo build -p jeikcode --bin jeikcode --locked` | Passed |
| Changed-source formatting, diff whitespace, workflow YAML shape, dependency/lockfile drift | Passed; no P1 dependency or lockfile edits |

Native unit/integration total: **124 passed**. The focused WebUI batch of 59 is a subset of the 432-test full run and is not counted again. Native logs remain local, under the ignored task-specific target directory; they are not uploaded as user packet contents.

Two scoped independent static reviews found no Critical/Important issue: one covered native/daemon/auth/wiring and CI/docs, and a different reviewer covered the UI. Neither static review is a runtime or maintainer approval.

### Actual browser acceptance

One headless instance of the existing Edge 154.0.4258.62, controlled by Python Playwright 1.57.0, exercised the newly built CLI backend with a disposable Git fixture, isolated application home, offline/dev mode and telemetry disabled. The successful run passed **50/50 checks** on desktop and 390-by-844 viewports. This is a mobile-sized desktop browser, not a physical mobile-device test.

- Full current source commit/tree remained distinct from frozen base and observed executable metadata.
- All five original strings, including literal HTML/control characters, matched the browser text and escaped JSON. No markup executed.
- Run/source changes and an intentionally delayed real preview response could not restore obsolete acknowledgment.
- Preview rejected a different source checkout; source inspection rejected an explicit nested directory.
- The host directory picker hid mutations, left the authenticated current project unchanged and made **zero `/cd` calls**.
- The one accepted export produced exactly five files with matching UTF-8 bytes and digest, on the daemon host. No browser download or agent prompt was sent.
- Desktop Escape/focus restoration and mobile viewport containment passed. Both fixture screenshots were visually inspected.

The first browser attempt was stopped by the existing first-run Config Sync notice; its result was retained. The successful fresh attempt used that notice's existing Skip control before exercising repair. No production change was needed for this harness correction. No external page request or page script error was observed; the unrelated update-check endpoint was blocked. Both owned test servers were stopped.

The tested Windows executable has SHA-256 `04e8ff54d014f60b2315c5df765ee264a7d01b12f1850984c37afd4c5f5e4cec`. Its build observation correctly reports integration base `10c9481b0213d463d2f42451d1d8bca20e9a46b9` and `source_dirty: true`: this is pre-commit native evidence. Exact committed source verification belongs to the separate opt-in fork CI run and its artifact, not to an inferred executable provenance claim.

Repository-wide `cargo fmt -- --check` and `cargo clippy --workspace --all-targets` were not rerun as part of this bounded fork milestone; their upstream PR template boxes remain unchecked. Native OS folder-picker interaction, physical mobile devices, packaging, upstream merge-result and installed-runtime evidence stay **NOT YET VERIFIED**. Upstream submission and the historical attribution disposition are still pending decisions.
