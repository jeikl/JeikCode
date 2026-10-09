# JeikCode source self-repair

JeikCode's repair MVP prepares a source change and a local evidence packet for review. It combines a project skill with native CLI checks for source identity, candidate scope, reproduction isolation, and frozen export. It does not update or restart the installed application.

The project skill is `.jeikcode/skills/jeikcode-self-repair/SKILL.md`. It is independent of existing user skills and requires no global skill installation. Invoke `jeikcode-self-repair` without arguments in a JeikCode session for this checkout, then describe the JeikCode bug in the conversation. The CLI workflow also works without a model or the skill.

## Requirements and source identity

Use a JeikCode executable built with this MVP. Check its declarations first:

```sh
jeikcode --build-info
jeikcode repair --help
jeikcode repair info --source .
```

Build information must include `repair_protocol: 1` and `skill_shell_expansion_opt_out: true`. An older executable may not have the command group and may ignore the new frontmatter field. These declarations, the reported build commit, and a hash of the answering executable are useful observations; they do not authenticate its relationship to the selected checkout or to an installed desktop app. `installed_runtime_match` remains `unknown` in this MVP.

The source checkout must be the intended JeikCode repository. Use its full commit and tree identities when reporting a candidate. A branch name such as `beta` can move, and a version label alone cannot replay a repair.

Use a complete local Git clone. Partial/promisor clones are refused before reading objects, so missing source cannot trigger a background fetch or remote helper. The MVP materializes regular tracked files, not symlinks or submodules. It supports bounded UTF-8 text changes and rejects executable-mode changes, hidden configuration, known permission/recovery owners, and empty-file creation/deletion; take those changes through ordinary maintainer review.

The native reproduction runner supports Linux with working bubblewrap isolation. It fails closed when required support is missing. Source investigation and packet preparation can continue with an explicit verification gap. The runner does not download or install missing tools or dependencies.

## Workflow

### 1. Diagnose and choose the exact scope

Locate the reported failure in JeikCode's source. Identify a small root-cause hypothesis and the files needed to address it. Use ordinary application debugging when the defect belongs to a project JeikCode is helping develop.

The examples below run from the JeikCode checkout. Replace the example source file, probe, note paths, and new sibling directories with paths chosen for the actual defect. The probe is a reviewed, independently authored shell script outside the candidate, not a bundled script supplied by this skill.

```sh
jeikcode repair prepare --source . --run ../jeikcode-repair-run --allow crates/jeikcode-daemon/src/webui.rs --probe ../reproduce-jeikcode.sh
```

Repeat `--allow` for every exact file that may change. Omit `--probe` when there is no useful reproducible check; that leaves verification unperformed. Directory wildcards and broad scope are not substitutes for naming the relevant files.

Preparation creates a clean detached candidate from committed HEAD and prints its path. It preserves the original checkout, including staged, unstaged, and untracked work. It does not automatically import that local work into the candidate. If a failure depends on uncommitted changes, record that distinction before drawing conclusions from a clean baseline.

Use the returned candidate path for edits. Keep the run directory outside the original source. If the scope needs another file, start a new run with the revised scope rather than modifying repair state.

### 2. Record the baseline

When preparation captured a probe, run it against the baseline:

```sh
jeikcode repair run --run ../jeikcode-repair-run --phase baseline --timeout-seconds 60
```

The probe uses the same captured bytes for both phases. A useful baseline fails because of the reported defect. A failure caused by a missing dependency or a broken probe does not establish that baseline.

The runner launches the probe with `/bin/sh` inside Linux bubblewrap, using system tools, a read-only source view, and temporary output space. It does not expose the user's home directory, inherited application credentials, or network access. Preserve any receipt reporting a blocked or timed-out run. A preflight error can stop before a receipt is produced; that also establishes no passing evidence. Do not rerun a blocked probe in an unrestricted terminal and describe that as equivalent verification.

### 3. Edit and check the candidate

Make the smallest relevant change in the candidate path printed by preparation. Check the paths and run the candidate probe:

```sh
jeikcode repair check --run ../jeikcode-repair-run
jeikcode repair run --run ../jeikcode-repair-run --phase candidate --timeout-seconds 60
```

The first command checks scope and drift; it does not test behavior. The second produces a receipt for the candidate source digest. If the candidate changes afterward, run it again. Do not change the independent probe or weaken assertions to make the patch pass.

The runner is intentionally limited. A test that requires a build toolchain or dependency not available inside its boundary cannot be treated as passed. Keep that gap explicit, and let maintainers run the repository's normal build and CI gates during review.

### 4. Write the notes and freeze the packet

Use the reproduction and report templates bundled with the project skill. Describe the steps, expected and observed behavior, diagnosis, change rationale, exact verification statuses, and remaining gaps. Describe the probe's inputs and assertions precisely: the raw captured script and output logs remain local, so a recipient cannot reconstruct them from their digests alone.

Inspect source changes and notes for credentials, private prompts, customer data, personal paths, and unrelated logs. Collection applies conservative redaction patterns to notes. It rejects diffs matching possible sensitive material instead of redacting program text. These checks and the fixed list of packet filenames do not guarantee that the contents are safe to share; inspect the full preview.

```sh
jeikcode repair collect --run ../jeikcode-repair-run --reproduction ../reproduction.md --report ../report.md
jeikcode repair preview --run ../jeikcode-repair-run
```

Preview prints the entire frozen payload as escaped JSON strings, along with its SHA-256 digest. Inspect all five files:

| File | Contents |
| --- | --- |
| `repair.json` | Source identity, scope, and observed build information. |
| `source.diff` | The proposed source change. |
| `reproduction.md` | Minimal steps, observations, and relevant environment. |
| `verification.json` | Native reproduction receipts and limitations. |
| `report.md` | Diagnosis, repair rationale, remaining gaps, and optional candidate lesson. |

### 5. Export the accepted snapshot

After reviewing and accepting the complete preview, run `jeikcode repair export` with the following arguments:

| Argument | Value |
| --- | --- |
| `--run` | The same run directory, such as `../jeikcode-repair-run`. |
| `--accept` | The exact SHA-256 digest printed by the accepted preview. |
| `--output` | A new local directory, such as `../jeikcode-repair-export`. |

Export copies the accepted frozen bytes; it does not send them anywhere. If the material needs revision, collect and preview it again before accepting the new digest. An agent must not silently replace the accepted digest with one for newly generated content.

The owner can then choose to submit the packet through the project's normal issue or pull request process. Local preparation or export does not authorize a GitHub post, upload, or message to someone else.

## Reading verification results

| Status | Meaning |
| --- | --- |
| `not_run` | This phase has no native reproduction receipt. |
| `blocked` | The required execution boundary or prerequisite was unavailable. |
| `timeout` | Execution exceeded the requested limit, which must be 1–600 seconds. |
| `failed` | The probe ran and failed; examine whether this demonstrates the intended symptom. |
| `checks_passed` | The captured probe passed for the recorded source digest in the runner's boundary. |
| `stale_or_invalid` | The collected receipt does not establish a check for the current snapshot and probe. |

A passing candidate is useful evidence about that check. It does not prove every code path works, authenticate a binary, or demonstrate that the installed application has changed. A passing candidate without a relevant failing baseline gives weaker evidence about causality. Report the exact baseline and candidate results rather than calling the application “fixed.”

This MVP has no install, activation, restart, or rollback command. A desktop build may include Rust code, embedded WebUI assets, and a shell that require a coordinated build and release. Maintainer review and the normal release process determine whether a candidate becomes an installed change.

## Skill loading and process boundaries

The new project skill declares:

```yaml
user-invocable: true
disable-shell-expansion: true
```

The second field prevents the skill loader from performing shell pre-execution on both its body and its arguments. Existing skills keep their previous default behavior when the field is absent. The canonical disabling value is the unquoted literal `true`. A present value other than literal `false` also disables expansion, and a later duplicate cannot undo a disabling value.

This protects one loading stage. It does not sandbox general agent tools, validate the meaning of a report, or turn `allowed-tools` metadata into a permission boundary. The repair skill contains instructions and templates, with no scripts, hooks, or argument templates. Reproduction execution belongs to the native runner; candidate path checks and frozen export belong to the native CLI.

## Community review and scoped lessons

A local report may propose a lesson tied to the source revision, component, platform, and relevant provider or configuration. Include supporting evidence and an expiry condition or counterexample. It remains a candidate for review, not an automatic global instruction or a modification to someone else's skills.

Maintainers can replay the submitted reproduction, inspect the minimal diff, and run normal CI before merging and releasing. Repeated, reviewed evidence may later justify a project regression test or a separately reviewed skill change. This is improvement of the software and its documented workflow; it does not update model weights.
