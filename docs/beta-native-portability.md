# Beta native portability review

## Target and ownership

`portability.yml` targets pull requests into `beta`, pushes to `beta`, and manual
runs. It supplements, rather than replaces, `ci.yml` (version/installer/WebUI and
Linux workspace checks) and `build.yml` (tag-driven release builds and publishing).
WebUI remains in the existing CI to avoid a duplicate Node 22 `npm ci`/build job.
Neither existing workflow is changed.

The checkout used for this change matches `origin/beta` at `197e4b69f`.
The requested `origin/beta7ac80ed7a` reference was not available locally; no remote,
branch configuration, or release source was changed.

## Coverage and limits

- Ubuntu, Windows, and macOS run the capabilities, coding, and telemetry library
  tests in one Cargo invocation, allowing Cargo to compile the unified native
  runtime test graph once, followed by a library check.
- Separate subset jobs disable defaults explicitly and test `provider,tools` and
  `provider,tools,cc-hooks`. These are reduced supported combinations, **not full
  minimal-feature isolation**. Coding intentionally assembles the broader runtime.
- Current beta's bare `--no-default-features` library check fails on Windows:
  ungated process utilities require `tokio::process` and `dirs`. `cc-hooks` alone
  also fails because tools reference the gated `paths` module. These baseline
  feature-isolation issues are not fixed across domains in this CI change.
- No retired `repo_map` test filters, live-provider/API-key tests, desktop packages,
  cross-compilation targets, or background-drain production changes are added.
- All jobs have timeouts at most 60 minutes, read-only contents permissions,
  credential persistence disabled, and no secrets. Cancellation is scoped to the
  PR/ref. The final gate requires both matrices to succeed: skipped, cancelled,
  and failed jobs do not count as a pass.
- Artifacts contain only explicitly named command logs under runner temporary
  storage. Runtime home data is not uploaded.

The diagnostic regression sends real Chinese `产品需求` text through hook stdin,
checks unescaped UTF-8 JSON stdout, exact UTF-8 stderr, and exit code 2. Python byte
I/O is explicit in this fixture only; production hook behavior is unchanged.

## Local review evidence

- Parent `.jeikcode/validation-tools/actionlint.exe`: new workflow passed.
- `cargo fmt` applied; no production Rust changes.
- Node 22.22.0: WebUI `npm ci --ignore-scripts --no-audit --no-fund` passed;
  the package lock was not changed. This verifies locked installation, not the
  WebUI build or install scripts (existing CI still owns those).
- Focused `cc_hooks::tests::` with `provider,tools,cc-hooks`, debug profiles 0,
  incremental 0, target `C:/Work/JeikCode/target/beta-validation`: 20 passed,
  6 failed. The new Unicode diagnostic passed. Existing Windows fixtures using
  POSIX shell quoting/exit syntax failed (deny/ask, deliberate exit 2,
  post-tool matcher, prompt block/exit contract). They remain visible failures,
  not ignored tests or a claimed green baseline.
- No full suite was run locally; hosted Ubuntu/macOS and complete native/subset
  results remain for CI review.

## Review and release lock

Review this change against `beta` and retain visible failing gates until their
causes are reviewed. Adding this workflow is not a declaration that beta is
portable or ready to release. Stable release remains locked to reviewed `main`
source and stable tags; beta prereleases retain the existing reviewed `beta`
source/tag path. Existing release gates, publishing permissions, version files,
Cargo/npm locks, and release workflows are unchanged. No release date or promotion
promise is implied.
