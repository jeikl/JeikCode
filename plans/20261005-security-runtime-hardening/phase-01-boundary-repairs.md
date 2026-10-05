# Phase 1 — Boundary repairs

## Goal

Repair the three confirmed high-severity trust-boundary defects with the smallest ownership-correct changes.

## TDD tasks

1. **Standalone daemon authentication**
   - Add a pure policy/helper test that distinguishes loopback from non-loopback listener exposure and requires authentication for the latter.
   - Preserve unauthenticated loopback compatibility for IDE integrations unless the caller explicitly supplies tokens.
   - Route both standalone entrypoints through the same `standalone_daemon_tokens` resolver while preserving explicit `serve --no-token` behavior in the generic server path.
   - Reject runtime remote-access changes that would expand a loopback/no-token daemon to a non-loopback/no-token listener.

2. **`/git/discard` containment**
   - Add tests for in-repo untracked files/directories (allowed), `../outside` and absolute paths (rejected), forged `is_untracked`, tracked-parent subtrees, and Git pathspec metacharacters.
   - Validate a repository-relative path and delegate untracked deletion to Git itself: literal-pathspec `git clean -nd -- <path>` as the authority check, followed by literal-pathspec `git clean -fd -- <path>` only when the preview proves the target is cleanable.
   - Reject paths/subtrees known to Git as tracked before cleaning, so a forged untracked flag cannot widen authority over scratch descendants.
   - Keep tracked-file restore routed through literal-pathspec `git restore -- <path>`.

3. **Sensitive Safe-read resolution**
   - Give `SensitivePathGate` the same live cwd ownership used by the write/open gates.
   - Extract root path arguments for Safe filesystem-read tools, resolve against live cwd, canonicalize existing targets using JeikCode path normalization, and run `path_is_sensitive` on the resolved target.
   - Resolve the deepest existing ancestor for missing leaves so symlink/junction parents cannot hide a sensitive destination; fail closed when unresolved parent traversal cannot be classified safely.
   - Bind remembered sensitive-read/write grants to the resolved target identity so retargeting a benign alias invalidates the old grant.
   - Keep the existing cheap raw-argument check as a fail-closed fast path and run blocking filesystem resolution via the bounded helper so a stalled mount cannot freeze the async turn loop.

## Files expected to change

- `crates/jeikcode-daemon/src/auth_token.rs`
- `crates/jeikcode-daemon/src/main.rs`
- `crates/jeikcode-daemon/src/api_config.rs`
- `crates/jeikcode-daemon/src/api_git.rs`
- `crates/jeikcode-daemon/README.md`
- `crates/jeikcode-cli/src/main.rs`
- `crates/jeikcode-capabilities/src/tools/sensitive_path.rs`
- `crates/jeikcode-capabilities/src/tools/write_approval.rs`
- `crates/jeikcode-capabilities/src/tools/glob.rs`
- `crates/jeikcode-coding/src/parts.rs`
- Tests colocated with the owning modules; avoid new test-only abstractions unless needed.

## Success criteria

All regression cases above pass; loopback daemon and ordinary read behavior remain unchanged; no new permission bypass or async blocking path is introduced.
