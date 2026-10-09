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

The root `-C` / `--dir` option, placed before `repair`, selects the working directory for all relative repair paths. For example, `jeikcode -C /path/to/JeikCode repair info --source .` inspects that selected checkout. Relative run, probe, note and export paths use the same directory; absolute paths remain explicit. Without the option, repair uses the caller's current directory. An invalid selected directory fails before repair creates any files rather than silently using the caller's checkout. `--build-info` still reads embedded metadata only and does not require that directory to exist.

Use a complete local Git clone. Partial/promisor clones are refused before reading objects, so missing source cannot trigger a background fetch or remote helper. The MVP materializes regular tracked files, not symlinks or submodules. It supports bounded UTF-8 text changes and rejects executable-mode changes, hidden configuration, known permission/recovery owners, and empty-file creation/deletion; take those changes through ordinary maintainer review.

The native reproduction runner supports Linux with working bubblewrap isolation and a qualified runtime. The current reviewed policy accepts only upstream bubblewrap **0.13.0** at the fixed `/usr/bin/bwrap` path. Before any sandbox setup it checks canonical root-owned parents, a root-owned regular executable, no group/other write permission, no setuid/setgid or file capabilities, and the exact version with a time-bounded, environment-cleared invocation. It records the executable SHA-256 and checks it again around execution. Older, customized, unrecognized and future unreviewed versions fail closed; a claimed backport needs a separate policy review. There is no path override or automatic download/install. Source investigation and packet preparation can continue with an explicit verification gap.

Use exact tracked spelling for every path component, including parent directories of new files. Repair rejects case aliases among tracked and allowed paths before creating a run, and when loading saved state. Its Unicode-uppercase comparison is a conservative portability rule, not a promise to model every filesystem's normalization. On Windows, canonical paths remain internal; only the pathname passed to Git is stripped of its verbatim prefix using the shared path normalizer.

Choose a parent directory already private to your account. On Unix the run/files use restrictive modes. On Windows the MVP inherits the parent's DACL; it does not create or audit a protected DACL. Do not place diagnostic state in a shared or broadly writable folder and assume the word "private" enforces confidentiality.

Source inspection, candidate materialization and baseline reconstruction each use one raw `git cat-file --batch` reader, not two Git subprocesses per tracked file. Requests contain full object IDs only. The reader checks response identity, blob type, bounded header and decimal byte size before allocation, then reads exactly the payload and delimiter. Per-pass source size remains limited to 256 MiB. No checkout filters, text conversion, replacement objects, hooks or lazy fetch are enabled. Candidate materialization and baseline reconstruction recheck the recorded SHA-256; final source drift checks still apply. Malformed data stops the operation and closes/reaps the batch process.

## Developer-assisted WebUI pilot

The **Source repair** action in the WebUI toolbar opens a source and evidence dialog. It uses the existing daemon and native repair implementation. Selecting a source in this dialog does not switch the current project, create a chat session, or invoke an agent.

Use a build containing this pilot and start its authenticated `jeikcode webui` entry point. The CLI `serve` and `daemon` hosts also inject the repair backend, but repair requests require a real valid WebUI token even when other daemon APIs permit access without one. The existing desktop launcher starts `jeikcode webui`; packaging and native desktop activation still need their own verification. Standalone `jeikcode-daemon`, the old TUI server wrapper, and an already-running server created without the backend report the feature unavailable. Passing a backend to a launcher does not upgrade an existing server instance.

1. **Inspect the intended source.** Select the absolute JeikCode repository root on the machine running the daemon. The browser's current project is only a suggestion. A remote browser or phone selects the daemon's filesystem, not a directory on that browser's device. The selection-only directory browser does not call the project's change-directory endpoint. An invalid or nested source path is rejected; the pilot does not silently walk up to a parent checkout.
2. **Read the source and build observations separately.** The source card displays the current full commit, tree and raw-byte dirty state. The answering executable's build commit, tree, dirty observation, version and hash belong to a separate card. A Windows Git-clean checkout can have raw-byte differences due to CRLF; inspection does not normalize those bytes. Neither a matching version nor matching commit establishes an installed-runtime relationship.
3. **Prepare and collect with the native CLI.** Continue the workflow below from that explicit repository root: choose exact allowed files, prepare the candidate, perform the supported probe and collect notes. This pilot exposes no HTTP candidate preparation, probe execution, collection, shell command or agent-dispatch endpoint. The checked-in `jeikcode-self-repair` skill can be loaded from the selected root with shell expansion disabled; automatic parent-directory discovery from an arbitrary nested session is not part of its contract.
4. **Load the frozen run.** Enter the absolute run directory. Native code binds the selected canonical source root to the run's recorded source, then binds the packet's run ID, repository, base commit and base tree to that state under the same operation lock. It validates the five-file allowlist and digest before returning all file strings. The current source revision and the packet's frozen base revision are shown independently. A frozen historical packet does not become current-source verification when re-opened.
5. **Review and export.** Inspect the complete five files and full SHA-256. File contents remain plain text; the escaped JSON view exposes control characters and exact string boundaries. A new load or source/run edit clears the previous acknowledgment. An explicit export action sends the accepted digest to native repair, which revalidates the run binding, prior preview marker, frozen digest and new destination. The five files are written to a new directory on the daemon host, outside the source and run. Nothing is uploaded or sent to a maintainer.

Loading a preview writes the existing local `previewed.sha256` marker and briefly acquires `operation.lock`. That marker records presentation of a packet, not proof that a person read it. Export still requires acknowledgment of the displayed digest. Later candidate or note changes do not replace the frozen bytes: collect and preview again when a new packet is wanted.

The dialog distinguishes recorded `checks_passed`, `failed`, `blocked`, `timeout`, `not_run` and `stale_or_invalid` results. Missing or unknown results supply no passing evidence. Installed runtime remains `not_tested` / `unknown`. UI state and packet contents stay in component memory rather than chat history or browser storage.

### HTTP boundary

The optional host backend implements only these operations:

| Endpoint | Request | Result |
| --- | --- | --- |
| `GET /repair/capability` | No paths | Actual backend/auth availability; no source or packet reads. |
| `POST /repair/info` | Absolute `source` | Selected source and separate observer build information. |
| `POST /repair/preview` | Absolute `source`, `run` | Bound canonical roots, frozen file strings and digest. |
| `POST /repair/export` | Absolute `source`, `run`, `output`; full `accept` digest | Explicit local export receipt. |

Data operations require actual token validation independently of the daemon's optional-auth flags. They also require a valid HTTP/HTTPS browser Origin whose host and effective port match the request Host. Forwarded-host headers are not trusted automatically; a reverse proxy must preserve the public Host. This is an origin-authority guard, not signed provenance or proof of an external TLS transport. Bodies and concurrent operations are bounded. Native repair keeps its existing path, metadata, source-scope, packet and export checks; no general file-reader or command executor is added.

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

User, IPC, PID, network, UTS and cgroup namespaces are mandatory, in addition to the mount namespace. The runner does not use bubblewrap's optional `--unshare-all` user/cgroup behavior. The system runtime directories `/usr`, `/bin`, `/lib` and `/lib64` are broad read-only mounts, not a curated tool allowlist; they must not contain private data on a verification host. A newer attempt archives the previous phase's receipt and output/error sidecars together under one history identifier, including sidecars left without a receipt after a crash.

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
| `checks_passed` | The captured probe passed for the recorded source digest in the runner's boundary, with the current runtime qualification policy. |
| `stale_or_invalid` | The collected receipt does not establish a check for the current snapshot and probe. |

A passing candidate is useful evidence about that check. It does not prove every code path works, authenticate a binary, or demonstrate that the installed application has changed. A passing candidate without a relevant failing baseline gives weaker evidence about causality. Report the exact baseline and candidate results rather than calling the application “fixed.”

New receipts include `sandbox_runtime` with the fixed path, reported version, executable SHA-256 and qualification-policy identifier. Legacy receipts remain readable, but a legacy `checks_passed` without this identity cannot be collected as a current passing check; rerun on a qualified host. Already frozen, owner-reviewed historical exports are not rewritten. These are unsigned local observations, not an authenticated supply-chain attestation. System administrator changes, kernel vulnerabilities and comprehensive resource quotas are outside the runtime qualification claim; a deployment must assess them separately.

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

## Milestone acceptance and branch workflow

Iterative implementation stays on the contributor's dedicated fork branch. The earlier proposal to open a small draft PR immediately is superseded by milestone-based batch review; do not open an upstream PR for each repair iteration.

The `Self-repair milestone acceptance` workflow checks the exact pushed revision on Ubuntu 22.04. It is opt-in: a push to `feat/community-self-repair-mvp` must include `[repair-acceptance]` in the head commit message, or an owner can explicitly dispatch the workflow where available. It has no upstream `beta`, PR, tag or release trigger. It does not replace the normal PR merge-result validation when a cohesive milestone is submitted.

Normal repair tests exercise deterministic missing/rejected-backend behavior. The four separate Linux acceptance tests are ignored in ordinary local runs and must be explicitly run on a capable host:

```sh
cargo test -p jeikcode --lib --locked repair::tests::sandbox_acceptance:: -- --ignored --test-threads=1 --nocapture
```

Set `JEIKCODE_HOME` to a disposable directory first. An unavailable or unqualified sandbox fails this acceptance command; it is not a skip or success. The workflow also rejects a zero-test invocation. Evidence includes source SHA, toolchain, sandbox source/binary hashes, qualification identity, test logs and run identity. Report Windows native tests, Linux sandbox acceptance and hosted CI separately.

The previous checkpoint used Jammy bubblewrap `0.6.1-1ubuntu0.3`. Ubuntu [USN-8779-2](https://ubuntu.com/security/notices/USN-8779-2) reverted its CVE-2026-87766 fix, so that historical behavioral PASS is not current deployment evidence. Upstream [GHSA-pxhw-h44j-8pfx](https://github.com/containers/bubblewrap/security/advisories/GHSA-pxhw-h44j-8pfx) identifies 0.12.0 as the first fixed release. This milestone selects [0.13.0](https://github.com/containers/bubblewrap/releases/tag/v0.13.0), released September 22, 2026; it also incorporates the earlier published advisory fixes and no longer supports a setuid build.

The ephemeral CI VM builds the official `bubblewrap-0.13.0.tar.xz` release asset only after verifying its **129260 bytes** and published SHA-256 `4734237473c0e5d695e4e9034a34e43b2dbf5164655bd13fa59ae376b2b7a765`. The workflow pins its direct build-package versions, records actual compiler/system inputs and installs only the resulting root-owned non-setuid binary on that disposable VM. This is source-pinned verification, not a claim of bit-for-bit reproducibility across different VM images. Optional upstream tests are not run by this minimal bootstrap; JeikCode's own real sandbox acceptance remains mandatory. No sandbox is installed on the user's machine, and no namespace/security policy is relaxed. A passing suite does not certify all possible probes or the host kernel: bubblewrap's own [security policy](https://github.com/containers/bubblewrap/blob/v0.13.0/SECURITY.md) makes the caller responsible for its sandbox model and arguments.
