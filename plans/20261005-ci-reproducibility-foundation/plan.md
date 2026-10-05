---
title: CI and reproducibility foundation
status: ready_for_pr
branch: fix/ci-reproducibility-foundation
base: main@18824be4bfbe7a005fed9a4118c3f8ed6cc1ab03
mode: tdd
---

# CI and reproducibility foundation

## Outcome

Create a trustworthy PR/main quality gate without absorbing unrelated historical
test failures, and remove build/release behavior that depends on one developer's
machine or on a moving branch after a release tag is pushed.

## Current slice

1. Repair the tracked WebUI lockfile so `npm ci` is authoritative.
2. Gate WebUI typecheck, tests, and production build.
3. Gate workspace Rust compilation plus deterministic updater/embedded-WebUI
   regressions while the known broad-suite baseline failures remain separately
   tracked.
4. Pin Node and Rust used by CI/release jobs.
5. Remove build-time `~/.jeikcode` source mutation and preserve it as an
   explicit developer import script.
6. Remove the machine-specific musl linker path.
7. Make tag publishing use the exact tagged SHA and reduce workflow token
   permissions.
8. Make public installers fail closed on missing/invalid manifests and verify
   manifest SHA256 + byte size before replacing an existing installation.
9. Gate version consistency across the workspace/package/WebUI/docs/desktop
   manifests that ship together.

## Explicit non-goals for this PR

- Do not repair the known unrelated broad Rust-suite failures.
- Do not perform repo-wide rustfmt cleanup solely to make a new gate green.
- Do not redesign desktop packaging or legacy NPM/Docker release lanes.

## Verification

- `npm ci && npm run typecheck && npm test && npm run build` in `webui/`.
- `cargo check --workspace --all-targets --locked` with isolated
  `JEIKCODE_HOME`.
- updater distro-pm and embedded WebUI focused Rust tests.
- explicit asset-import helper fixture test proving dry-run/no-op/copy behavior.
- cross-platform local HTTP fixture tests for valid installer delivery, hash and
  size mismatch, manifest failure, missing target, version mismatch, and
  preservation of an existing installation on every failure.
- node scripts/check-version-consistency.js.
- workflow/source review for exact-SHA checkout and least permissions.

## Completed evidence

- WebUI locked install, typecheck, 293 tests, and production build: PASS.
- `cargo check --workspace --all-targets --locked` with isolated
  `JEIKCODE_HOME`: PASS.
- updater distro-pm regression and embedded WebUI tests: PASS.
- Windows installer integrity suite: PASS; POSIX-only wrapper cases are wired
  into `ubuntu-latest` CI because the development host has no POSIX shell.
- explicit asset-import regressions: PASS.
- docs-site locked install/build and desktop locked install: PASS.
- workflow YAML parse, version-consistency positive/negative gate, and
  `git diff --check`: PASS.
- independent CI/release, installer-security, and full-diff reviews: CLEAN
  after actionable findings were remediated.
