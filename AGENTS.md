# JeikCode Project Global Development Guidelines

---

## 1. Core Mechanics & Knowledge Base Maintenance

- **Prompt Lifecycle**: User directory `~/.jeikcode/prompts/` supports hot-reloading. Production baseline prompts are maintained exclusively in `crates/jeikcode-coding/assets/prompts/` and distributed via binaries.
- **Teaches Sync**: `crates/jeikcode-capabilities/assets/teaches/` serves as the authoritative source for `jeikcode_config` (`action="guide"`). Always sync documentation here when adjusting model configuration logic or tool parameters.

---

## 2. Branching & Collaboration Contracts

- **Dual-Channel Baseline**: Official repository: `https://github.com/jeikl/JeikCode`.
  - `main`: Stable production releases, production tags (`vX.Y.Z`), and official distribution assets only.
  - `beta`: Active collaboration branch for feature development, PR aggregation, and pre-release validation (`vX.Y.Z-beta.n`).
- **Branch Checkout & Reuse**: Branch daily features off `origin/beta`, hotfixes off `origin/main`. Verify whether the requirement is already addressed on `beta` before starting.
- **Shared Branch Safety**: Check in-flight PRs (`gh pr list`) and preserve local `backup/*` branches before rewriting history. Never force-push to shared branches. Major refactors and new features must be validated on `beta` before merging into `main`.

---

## 3. Commit & PR Discipline

- **Git Commit Standards**: Follow Conventional Commits (`feat(...)`, `fix(...)`, `refactor(...)`, `docs(...)`, etc.). Provide clear commit bodies describing the final effective state and rationale. Avoid fragmented 1–3 file micro-commits, except during iterative CI fix loops; consolidate repetitive CI fix commits into a single unified commit once green.
- **PR Scope & Quality**:
  - **Single Responsibility**: Each PR must address exactly one category of change. Never bundle unrelated edits.
  - **Atomic & Reversible**: Commits within a PR must be self-contained and independently revertible.
  - **Local Convergence**: Audit and squash exploratory trial commits before merging; preserve only the final effective state and reason.
  - **Template Alignment**: Strictly fill out `.github/PULL_REQUEST_TEMPLATE.md`. Content may be authored in either English or Chinese, but the template structure must remain intact.
- **Contributor Respect**: Prefer squash-merging contributors' original PRs; state modification costs upfront; provide file-by-file explanations and actionable next steps when rejecting a PR.

---

## 4. Formatting & Targeted Verification

- **Code Formatting**: Run `cargo fmt` on any Rust changes.
- **Targeted Verification Matrix**:
  - **Frontend (`webui/`)**: `cd webui && npm run build`.
  - **Rust (`crates/`)**: `cargo check --lib -p jeikcode-daemon`.
  - **Static / Lightweight**: Constants, copy, prompts, and minor configs may be committed directly without compilation.
  - **Targeted Unit Tests**: Run dedicated tests directly (e.g., `node --test webui/src/lib/xxx.test.ts`).
  - **Missing Toolchains**: When local toolchains are absent, skip execution and explicitly document unverified paths in your response to be verified by GitHub Actions CI.

---

## 5. Automated Release Pipeline

The release process strictly adheres to [`docs/release-tutorial.md`](./docs/release-tutorial.md):

1. **Version Bump**: Run `npm run bump[:beta|patch|minor|major]` to cascade version numbers repository-wide.
2. **Changelog**: Document updates at the top of `CHANGELOG.md` following the bilingual template (English section + single line `---` + Chinese section). For stable releases, sync the latest 2 version logs across the 3 README files.
3. **Commit & Push**: Commit release notes and push to the remote tracking branch (`main` for stable, `beta` for pre-release).
4. **Trigger Workflow**: Tag and push (`git tag vX.Y.Z && git push origin vX.Y.Z`).
5. **Delivery Closure**: Run `gh run list --limit 3` to verify the `Build and Release` workflow is `in_progress`. When observing pipeline progress, introduce a 180s delay script between polling intervals to avoid spamming the API.

---

## 6. Code Comment Discipline

- **Comment Language**: Use Chinese comments for Chinese-speaking users, English for non-Chinese users. Maintain comment density and style consistent with surrounding code.

---

## 7. Documentation Language Consistency

- **Single-Language Integrity**: Maintain Chinese-dominant documents entirely in Chinese, and English-dominant documents entirely in English. Never insert arbitrary foreign-language sections into single-language documents.

---

## 8. Internationalization & Agent Purity

- **Human-Agent Boundary Isolation**:
  - **Localization Scope**: Confined strictly to human-facing interfaces and onboarding (TUI `/` command guides, WebUI, desktop shell, CLI host service output links, update/sync notifications, asset docs).
  - **Agent Core Purity**: System prompts, built-in tool definitions and schemas, execution traces, and raw tool outputs must strictly remain in native English without localization or translation pollution.
