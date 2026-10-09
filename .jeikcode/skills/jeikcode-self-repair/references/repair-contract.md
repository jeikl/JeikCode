# Source repair contract

Read this reference when interpreting identity, verification, packet approval, or a proposed lesson.

## Identity and provenance

`jeikcode repair info --source` inspects an explicitly selected JeikCode checkout. Record its full commit and tree identifiers and whether the original checkout is dirty. A branch name, version label, or short commit alone is insufficient to replay a candidate.

`jeikcode --build-info` describes the binary answering the command. Require its self-reported `repair_protocol: 1` and `skill_shell_expansion_opt_out: true` declarations before using this workflow. Its build metadata and binary hash are observations, not authenticated proof that it matches the checkout or the user's installed desktop application. The MVP reports `installed_runtime_match: unknown`; preserve that uncertainty in the report.

`prepare` creates a clean detached candidate from the selected checkout's committed HEAD. It records the original checkout separately and preserves staged, unstaged, and untracked work. Uncommitted changes are not silently imported into the candidate. If the defect depends on them, explain the mismatch and decide which evidence is reproducible before proposing a fix.

Use the candidate path printed by the command. Work only on the exact relative files declared with `--allow`. If a necessary file is outside that scope, explain why and prepare a new appropriately scoped run. A changed source checkout, changed probe, or unexpected candidate path is a reason to re-establish the run, not edit its state to make it pass.

## What the host enforces

| Boundary | Owner | Meaning |
| --- | --- | --- |
| Shell pre-execution during skill expansion | JeikCode skill loader | This skill sets `disable-shell-expansion: true`, so its body and supplied arguments are not executed by that expansion stage. |
| Candidate scope and source drift | Native repair commands | Paths and recorded file identities are checked before a packet is accepted. |
| Reproduction process | Native `repair run` | The captured probe runs only inside the supported Linux bubblewrap boundary. Missing support blocks execution. |
| Frozen sharing payload | Native `collect`, `preview`, and `export` | Export requires the digest of the exact frozen payload shown in preview. |
| General agent tools | The surrounding session's actual permissions | Markdown and `allowed-tools` metadata do not sandbox arbitrary shell, file, browser, or connector calls. |

The worktree provides a separate source candidate; it does not contain arbitrary processes. Keep repair reproduction commands within `repair run`. A blocked runner does not justify copying its command into a normal terminal. Continue diagnosis, diff review, and honest reporting where possible.

The supported runner uses an independently supplied probe captured once during `prepare`, with the same probe bytes for baseline and candidate. It exposes source read-only and temporary output space, clears inherited application credentials, and does not provide network access or the user's home directory. It does not install toolchains or dependencies. A required unavailable tool or dependency is an explicit verification limitation.

## Verification interpretation

| State | Report it as |
| --- | --- |
| `not_run` | No native reproduction receipt exists for this phase. |
| `blocked` | The required execution boundary or prerequisite was unavailable; the check did not establish behavior. |
| `timeout` | The probe exceeded its time limit; no passing result is established. |
| `failed` | The probe ran and reported failure. Explain whether that failure is the intended baseline symptom or another problem. |
| `checks_passed` | The captured probe passed for the recorded source digest in that boundary. |
| `stale_or_invalid` | A collected receipt does not establish a check for the current snapshot and captured probe. |

Use the exact receipt, including phase, source digest, probe digest, exit status, and limitations. A scope check is not a behavior check. A passing candidate without a relevant failing baseline provides weaker evidence: report what was actually observed. A candidate edited after verification needs another candidate run, because its receipt no longer describes the final diff.

Never describe `checks_passed` as authenticated provenance, a comprehensive security review, installed runtime repair, or successful desktop restart. Applying, rebuilding for installation, activating, restarting, and rolling back a released application are outside this MVP.

## Packet and approval

The outgoing packet has exactly these files:

| File | Purpose |
| --- | --- |
| `repair.json` | Source identity, candidate scope, and observed build information. |
| `source.diff` | The proposed source change. |
| `reproduction.md` | Human-readable steps, expected and observed behavior, and relevant environment. |
| `verification.json` | Native verification evidence and its limitations. |
| `report.md` | Diagnosis, change rationale, remaining gaps, and optional candidate lesson. |

The captured `probe.sh` and raw output logs stay local; they are not additional packet files. Describe the assertions and steps precisely enough for a maintainer to reconstruct and review a check. A probe digest alone does not let a recipient recreate its contents.

Compose concise reproduction and report notes from the provided templates. Include the smallest useful evidence. Inspect the diff and notes for tokens, credentials, private prompts, personal paths, customer data, and unrelated logs. Collection applies conservative redaction patterns to notes and rejects source diffs matching possible sensitive material, because changing a diff's text would change the program. Review remains necessary; do not claim that pattern checks or a packet allowlist prove its contents are secret-free.

`collect` freezes the packet. `preview` displays the complete payload as escaped JSON strings and its SHA-256 digest. Review all five files, not only a summary. Use that exact digest with `export --accept` after the owner has accepted that payload, or when an earlier instruction already authorizes that exact local export. A changed packet needs a new preview and corresponding acceptance. Do not silently replace the accepted digest or modify the frozen state by hand.

Export creates a local directory. Sending its contents to GitHub, a support service, or another person requires the owner's instruction to send that concrete material. Keep community submission separate from local preparation.

## Version-scoped learning

An optional lesson is a candidate in `report.md`, tied to this repository, source revision, affected component, platform, and relevant provider or configuration. State the symptom, supporting evidence, proposed rule, limitations, and a counterexample or expiry condition. Remove unrelated private context.

Do not promote one report into global memory, modify an existing user skill, or infer that model weights were trained. Maintainers can review a packet, independently replay its probe, run their normal CI, and merge a source fix through the project's usual process. A later, separately reviewed change may turn repeated evidence into a project rule or regression test.
