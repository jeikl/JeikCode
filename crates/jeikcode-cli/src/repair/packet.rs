use super::*;
use anyhow::ensure;
use regex::Regex;
use similar::TextDiff;
use std::fs;

const FILES: [&str; 5] = [
    "repair.json",
    "source.diff",
    "reproduction.md",
    "verification.json",
    "report.md",
];

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FrozenPacket {
    pub(super) schema_version: u32,
    pub(super) sha256: String,
    pub(super) files: BTreeMap<String, String>,
}

fn redactors() -> Vec<Regex> {
    [
        r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
        r"\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b",
        r"(?i)\b(?:bearer|basic)\s+[A-Za-z0-9_./+=-]{8,}",
        r#"(?im)\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[^\s"',;]{8,}["']?"#,
        r#"(?i)(?:/home/|/users/)[^\s"<>]+"#,
        r#"(?i)[a-z]:\\users\\[^\s"<>]+"#,
        r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
    ].iter().map(|p| Regex::new(p).expect("constant redaction expression")).collect()
}

fn redact(text: &str) -> Result<(String, usize)> {
    ensure!(!text.contains('\0'), "notes cannot contain NUL bytes");
    let mut text = text.to_owned();
    let mut count = 0;
    for rule in redactors() {
        count += rule.find_iter(&text).count();
        text = rule.replace_all(&text, "[REDACTED]").into_owned();
    }
    ensure!(
        !text.contains("PRIVATE KEY-----"),
        "incomplete private-key material: remove it before collecting"
    );
    Ok((text, count))
}

fn sensitive_diff(text: &str) -> bool {
    text.contains("PRIVATE KEY-----") || redactors().iter().any(|r| r.is_match(text))
}

fn source_diff(
    state: &State,
    baseline: &workspace::Snapshot,
    candidate: &workspace::Snapshot,
) -> Result<String> {
    let mut diff = String::new();
    for path in &candidate.changed {
        workspace::validate_allowed(path)?;
        let old = baseline
            .bytes
            .get(path)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let new = candidate
            .bytes
            .get(path)
            .map(Vec::as_slice)
            .unwrap_or_default();
        ensure!(baseline.bytes.contains_key(path) == candidate.bytes.contains_key(path)
            || !old.is_empty() || !new.is_empty(),
            "empty-file creation/deletion needs a separate reviewed Git change; this text repair diff cannot represent it");
        ensure!(
            old.len() as u64 <= MAX_TEXT_BYTES && new.len() as u64 <= MAX_TEXT_BYTES,
            "patch file exceeds text limit"
        );
        let old = std::str::from_utf8(old).context("baseline patch file is not UTF-8 text")?;
        let new = std::str::from_utf8(new).context("candidate patch file is not UTF-8 text")?;
        let before = if state.files.contains_key(path) {
            format!("a/{path}")
        } else {
            "/dev/null".into()
        };
        let after = if candidate.bytes.contains_key(path) {
            format!("b/{path}")
        } else {
            "/dev/null".into()
        };
        diff.push_str(
            &TextDiff::from_lines(old, new)
                .unified_diff()
                .context_radius(3)
                .header(&before, &after)
                .to_string(),
        );
        ensure!(
            diff.len() as u64 <= 4 * MAX_TEXT_BYTES,
            "repair diff exceeds packet size limit"
        );
    }
    // Redacting a diff silently changes the program. Refuse it instead and ask
    // for a smaller/sanitized change, while notes can safely be redacted.
    ensure!(!sensitive_diff(&diff), "source diff contains possible credentials or personal data; remove them from the proposed change before collecting");
    Ok(diff)
}

fn receipt_view(
    run: &Path,
    phase: &str,
    source_digest: &str,
    state: &State,
) -> Result<serde_json::Value> {
    let Some(receipt) = read_receipt(run, phase)? else {
        return Ok(serde_json::json!({ "status": "not_run" }));
    };
    let expected_probe = state.probe.as_ref().map(|v| v.sha256.as_str());
    let captured_probe_matches = expected_probe.is_some_and(|expected| {
        workspace::file_digest(&run.join("probe.sh"))
            .ok()
            .as_deref()
            == Some(expected)
    });
    let valid = receipt.source_digest == source_digest
        && captured_probe_matches
        && Some(receipt.probe_sha256.as_str()) == expected_probe
        && ["checks_passed", "failed", "blocked", "timeout"].contains(&receipt.status.as_str())
        && receipt.argv == ["/bin/sh", "/probe.sh"]
        && receipt.cwd == "/work"
        && (receipt.status != "checks_passed"
            || (receipt.exit_code == Some(0)
                && receipt.boundary == "linux_bubblewrap"
                && receipt
                    .sandbox_runtime
                    .as_ref()
                    .is_some_and(sandbox_runtime::Identity::matches_policy)));
    if !valid {
        return Ok(
            serde_json::json!({ "status": "stale_or_invalid", "reason": "receipt does not establish a check against this snapshot and captured probe" }),
        );
    }
    // Reconstruct an allowlisted receipt. Private paths, logs and arbitrary
    // agent-authored fields do not become share payloads through serialization.
    Ok(serde_json::json!({
        "status": receipt.status, "phase": receipt.phase,
        "source_digest": receipt.source_digest, "probe_sha256": receipt.probe_sha256,
        "argv": receipt.argv, "cwd": receipt.cwd, "started_at_unix_ms": receipt.started_at_unix_ms,
        "duration_ms": receipt.duration_ms, "exit_code": receipt.exit_code,
        "stdout_sha256": receipt.stdout_sha256, "stderr_sha256": receipt.stderr_sha256,
        "output_truncated": receipt.output_truncated, "boundary": receipt.boundary,
        "sandbox_runtime": receipt.sandbox_runtime.filter(sandbox_runtime::Identity::matches_policy)
    }))
}

pub(super) fn collect(
    run: &Path,
    state: &State,
    reproduction: &Path,
    report: &Path,
) -> Result<FrozenPacket> {
    let candidate = workspace::candidate(run, state)?;
    let baseline = workspace::baseline(state)?;
    let patch = source_diff(state, &baseline, &candidate)?;
    let (reproduction, redactions_a) = redact(&read_note(reproduction)?)?;
    let (report, redactions_b) = redact(&read_note(report)?)?;
    let baseline_receipt = receipt_view(run, "baseline", &baseline.digest, state)?;
    let candidate_receipt = receipt_view(run, "candidate", &candidate.digest, state)?;
    let verification = serde_json::json!({
        "schema_version": SCHEMA_VERSION,
        "baseline": baseline_receipt,
        "candidate": candidate_receipt,
        "installed_runtime": "not_tested",
        "interpretation": "Receipts record an external captured probe's exit status and exact input digest. They are local observations, not signed attestations. Review the reproduction and root cause; a green build alone is not proof of a fix."
    });
    let public = serde_json::json!({
        "schema_version": SCHEMA_VERSION, "run_id": state.run_id,
        "repository": state.source.repository, "base_commit": state.source.commit, "base_tree": state.source.tree,
        "original_checkout_dirty": state.source.dirty,
        "baseline_source_sha256": baseline.digest, "candidate_source_sha256": candidate.digest,
        "observer": state.observer, "observer_binary_sha256": state.observer_binary_sha256,
        "installed_runtime_match": "unknown", "runtime_status": "not_tested",
        "candidate_status": if candidate.changed.is_empty() { "diagnostic_only" } else { "proposed" },
        "changed_paths": candidate.changed,
        "allowed_paths": state.allowed_paths,
        "note_redactions": redactions_a + redactions_b,
        "execution_scope": "Only repair run probes use the enforced runner. General agent tools and the editable worktree are not sandboxed by this skill.",
        "sharing": "Local export only. Explicit owner review and separate authorization are required to send this payload.",
        "limits": ["No binary activation or rollback", "No imported community package execution", "No automatic lesson promotion", "No authenticated source-to-binary provenance"]
    });
    let files = BTreeMap::from([
        (
            "repair.json".into(),
            serde_json::to_string_pretty(&public)? + "\n",
        ),
        ("source.diff".into(), patch),
        ("reproduction.md".into(), reproduction),
        (
            "verification.json".into(),
            serde_json::to_string_pretty(&verification)? + "\n",
        ),
        ("report.md".into(), report),
    ]);
    let sha256 = workspace::digest(&serde_json::to_vec(&files)?);
    Ok(FrozenPacket {
        schema_version: SCHEMA_VERSION,
        sha256,
        files,
    })
}

pub(super) fn load_frozen(run: &Path) -> Result<FrozenPacket> {
    let frozen: FrozenPacket = read_json(&run.join("preview.json"))?;
    ensure!(
        frozen.schema_version == SCHEMA_VERSION
            && frozen.files.len() == FILES.len()
            && FILES.iter().all(|f| frozen.files.contains_key(*f)),
        "invalid packet file allowlist"
    );
    ensure!(
        frozen.sha256 == workspace::digest(&serde_json::to_vec(&frozen.files)?),
        "frozen packet changed; collect and preview again"
    );
    Ok(frozen)
}

pub(super) fn mark_previewed(run: &Path, sha256: &str) -> Result<()> {
    workspace::replace_private(&run.join("previewed.sha256"), sha256.as_bytes())
}

pub(super) fn export(run: &Path, accept: &str, output: &Path) -> Result<()> {
    ensure!(
        accept.len() == 64 && accept.bytes().all(|c| c.is_ascii_hexdigit()),
        "--accept must be the full preview SHA-256"
    );
    let frozen = load_frozen(run)?;
    ensure!(
        accept == frozen.sha256,
        "acknowledged digest differs from this packet; preview again"
    );
    workspace::no_links(&run.join("previewed.sha256"))?;
    ensure!(
        fs::read_to_string(run.join("previewed.sha256"))
            .context("display repair preview before export")?
            == accept,
        "packet has not been previewed at this digest"
    );
    workspace::no_links(output)?;
    ensure!(!output.try_exists()?, "export destination must not exist");
    let parent = output
        .parent()
        .context("export needs a parent directory")?
        .canonicalize()?;
    ensure!(
        !parent.starts_with(run),
        "export outside the private repair run"
    );
    let state = load_state(run)?;
    ensure!(
        !parent.starts_with(&state.source_root),
        "export outside the original source checkout"
    );
    let output = parent.join(
        output
            .file_name()
            .context("export needs a directory name")?,
    );
    // Reserve a fresh destination. Read the frozen bytes once, never rebuild
    // from mutable candidate/log files after the user has seen the preview.
    fs::create_dir(&output)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&output, fs::Permissions::from_mode(0o700))?;
    }
    for (name, content) in &frozen.files {
        workspace::write_new(&output.join(name), content.as_bytes())?;
    }
    Ok(())
}
