# Phase 4 — CI, release, and supply-chain convergence roadmap

## Priority

Recommended next engineering lane after the security boundary fixes land. The current PR's baseline attribution showed that non-hermetic assets, stale assertions, platform fixtures, and broad suite-order failures make regression evidence unnecessarily expensive; strengthen this foundation before expanding the next security lane.

## Scope

- Make PR CI gate `cargo check/test/fmt/clippy` plus WebUI `npm ci`, typecheck, tests, and build; add SDK/extension checks where maintained.
- Repair WebUI lockfile drift and use lock-preserving installs in CI.
- Pin the supported Rust/toolchain and release build helpers; remove developer-absolute linker paths.
- Remove `~/.jeikcode` source-tree mutation from `crates/jeikcode-cli/build.rs`; make asset sync an explicit developer operation.
- Verify installer artifact size/digest before installation and remove stale fallback/update-channel copy.
- Publish release metadata from the exact tag/SHA, reduce workflow permissions to least privilege, and make advertised desktop artifacts transactionally available.
- Consolidate obsolete NPM/Docker/release paths and add a version-consistency gate.

## Acceptance criteria

A clean checkout can reproduce the build without developer-home state, required CI catches the failures observed in the audit, and release/install artifacts are traceable to one source revision with verified integrity.
