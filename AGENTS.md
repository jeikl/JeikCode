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
- **Bilingual Contract Across Commits, PRs & Issues**:
  - **Commit Bodies**: Commit titles stay English-only (`feat(...)`, `fix(...)`). Bodies must be written in two complete passes in exact order: (1) full English version first; (2) standalone `---` line; (3) full Chinese version. Inside Chinese sections, technical identifiers (paths, symbols, commands, APIs) remain in original English without translation.
  - **PR & Issue Submissions**: PR titles follow English Conventional Commits. PR descriptions (filling `.github/PULL_REQUEST_TEMPLATE.md`) and Issue bodies must provide dual-pass bilingual content (or bilingual-mirrored headings and sections) so global collaborators can audit without friction. When initiated by Chinese-speaking contributors, Chinese precedes `---` and English follows; for non-Chinese contributors, English precedes and Chinese follows.
  - **PR & Issue Comment Interactions**:
    - If the user/author communicates in Chinese: respond in full Chinese first, a standalone `---` divider line, followed by the full English translation at the bottom.
    - If the user/author communicates in non-Chinese (e.g., English): respond in full non-Chinese (e.g., English) first, a standalone `---` divider line, followed by the full Chinese translation at the bottom.
- **Issue & PR Traceability**: When referencing or addressing specific PRs or issues, explicitly state in both the commit title and body what was fixed, added, or changed regarding the target and the resulting outcome.
- **PR Scope & Quality**:
  - **Single Responsibility**: Each PR must address exactly one category of change. Never bundle unrelated edits.
  - **Atomic & Reversible**: Commits within a PR must be self-contained and independently revertible.
  - **Local Convergence**: Audit and squash exploratory trial commits before merging; preserve only the final effective state and reason.
  - **Template Alignment**: Strictly fill out `.github/PULL_REQUEST_TEMPLATE.md` with bilingual integrity. The template structure, headings, and checklist anchors must remain intact.
- **Contributor Respect**: Prefer squash-merging contributors' original PRs; state modification costs upfront; provide file-by-file explanations and actionable next steps when rejecting a PR.

---

## 4. Formatting & Verification (CI-first)

- **Code Formatting**: Run `cargo fmt` on any Rust changes.

### CI-first — Builds, tests, and disk usage

- MUST prefer existing GitHub Actions workflows for broad builds/tests,
  cross-platform validation, and packaging. Do not run them locally by default.
- MUST verify that CI results match the exact commit SHA and cover the changes;
  results from an older commit do not validate newer code.
- Limit local checks to the minimum needed to reproduce a bug, validate unpushed
  changes, or smoke-test behavior that requires the local environment.
  Before a heavy local build, MUST explain why CI cannot meet the requirement.
- MUST NOT repeat local builds/tests for the same scope already validated by CI
  at the same commit unless there is a concrete reason.
- MUST NOT commit/push work in progress solely to trigger CI without authorization;
  respect the authorized scope for commits, pushes, and target branches.
- When running a built product, prefer downloading the binary/artifact for the
  required commit and platform; do not download Cargo target directories/caches.
- If CI is unavailable or lacks required checks, MUST report what remains
  unverified; do not claim that verification is complete.

### Targeted verification commands

Prefer CI for every command below; run locally only under the CI-first exceptions above.

- **Frontend (`webui/`)**: `cd webui && npm run build`.
- **Rust (`crates/`)**: `cargo check --lib -p jeikcode-daemon`.
- **Static / Lightweight**: Constants, copy, prompts, and minor configs may be committed directly without compilation.
- **Targeted Unit Tests**: Dedicated tests (e.g., `node --test webui/src/lib/xxx.test.ts`).
- **Missing Toolchains**: When a required toolchain is absent, skip the local run, keep the change minimal, and explicitly report what remains unverified for GitHub Actions CI.

---

## 5. Automated Release Pipeline

The release process strictly adheres to [`docs/release-tutorial.md`](./docs/release-tutorial.md):

1. **Version Bump**: Run `npm run bump[:beta|patch|minor|major]` to cascade version numbers repository-wide.
2. **Changelog**: Document updates at the top of `CHANGELOG.md` following the bilingual template (English section + single line `---` + Chinese section, direct feature and bug fix bullet points without internal technical mechanism paragraphs). The 3 README files maintain a single authoritative reference.
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
- **Full Multi-Language Localization Coverage**: Every newly added or updated human-facing frontend component label, button, placeholder, tooltip, modal notice, CLI configuration prompt, and user-visible system notice must integrate into **all** supported i18n catalogs across both WebUI (`webui/src/i18n.ts`, `webui/src/vi.ts`, `webui/src/locales/*.ts`) and Rust (`crates/jeikcode-config/src/i18n/`), covering all supported locales (`en`, `vi`, `zh`/`zh_CN`, `zh-TW`/`zh_TW`, `ja`, `ko`, `ru`, `fr`, `es`, `de`, `ar`). Hardcoded user-facing strings and relying on wildcard fallback delegation (`_ => super::...`) to skip translating new user-visible messages are strictly prohibited.
- **Catalog Purity & Anti-Hybridization**: Maintain single-language purity across all language catalogs. Never pollute monolingual entries with hybrid constructs such as `Chinese (Non-Chinese)` or mixed parenthetical dual-language aliases (except universally recognized protocol acronyms such as `PAT`, `HMAC`, `API`, `URL`, `SSH`). Each locale must express meaning cleanly in its native wording.
