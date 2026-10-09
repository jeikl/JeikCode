use super::*;
use std::fs;
use std::process::Command;

struct Fixture {
    temp: tempfile::TempDir,
    source: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("JeikCode");
        fs::create_dir_all(source.join("crates/jeikcode-cli/src")).unwrap();
        fs::create_dir_all(source.join("crates/example/src")).unwrap();
        fs::write(
            source.join("Cargo.toml"),
            format!("[workspace.package]\nrepository = \"{REPOSITORY}\"\n"),
        )
        .unwrap();
        fs::write(
            source.join("crates/jeikcode-cli/src/main.rs"),
            "fn main() {}\n",
        )
        .unwrap();
        fs::write(
            source.join("crates/example/src/answer.rs"),
            "pub fn answer() -> i32 { 41 }\n",
        )
        .unwrap();
        let this = Self { temp, source };
        this.git(&["init", "-q"]);
        this.git(&["add", "."]);
        this.git(&[
            "-c",
            "user.name=Repair fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "fixture baseline",
        ]);
        this
    }

    fn git(&self, args: &[&str]) -> Vec<u8> {
        let result = Command::new("git")
            .current_dir(&self.source)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .args([
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "core.fsmonitor=false",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        result.stdout
    }

    fn prepare(&self) -> PathBuf {
        workspace::prepare(
            &self.source,
            &self.temp.path().join("run"),
            vec!["crates/example/src/answer.rs".into()],
            None,
        )
        .unwrap()
    }

    fn notes(&self, reproduction: &str, report: &str) -> (PathBuf, PathBuf) {
        let a = self.temp.path().join("reproduction.md");
        let b = self.temp.path().join("report.md");
        fs::write(&a, reproduction).unwrap();
        fs::write(&b, report).unwrap();
        (a, b)
    }

    fn change(&self, run: &Path) {
        fs::write(
            run.join("candidate/crates/example/src/answer.rs"),
            "pub fn answer() -> i32 { 42 }\n",
        )
        .unwrap();
    }

    fn freeze(&self, run: &Path) -> packet::FrozenPacket {
        let state = load_state(run).unwrap();
        let (a, b) = self.notes(
            "Expected answer 42, got 41.\n",
            "Changed the incorrect constant.\n",
        );
        let packet = packet::collect(run, &state, &a, &b).unwrap();
        workspace::replace_private(
            &run.join("preview.json"),
            &serde_json::to_vec_pretty(&packet).unwrap(),
        )
        .unwrap();
        packet
    }
}

#[test]
fn prepares_committed_baseline_without_losing_staged_unstaged_or_untracked_work() {
    let fixture = Fixture::new();
    let original = fixture.source.join("crates/example/src/answer.rs");
    fs::write(&original, "staged user work\n").unwrap();
    fixture.git(&["add", "crates/example/src/answer.rs"]);
    fs::write(&original, "unstaged user work\n").unwrap();
    fs::write(
        fixture.source.join("private-notes.txt"),
        "private user note\n",
    )
    .unwrap();
    let index = fixture.git(&["ls-files", "--stage", "-z"]);
    let run = fixture.prepare();
    let state = load_state(&run).unwrap();
    assert!(state.source.dirty);
    assert_eq!(
        fs::read_to_string(original).unwrap(),
        "unstaged user work\n"
    );
    assert_eq!(fixture.git(&["ls-files", "--stage", "-z"]), index);
    assert_eq!(
        fs::read_to_string(fixture.source.join("private-notes.txt")).unwrap(),
        "private user note\n"
    );
    assert_eq!(
        fs::read_to_string(run.join("candidate/crates/example/src/answer.rs")).unwrap(),
        "pub fn answer() -> i32 { 41 }\n"
    );
    assert!(!run.join("candidate/private-notes.txt").exists());
    assert_eq!(state.observer.source_artifact_relation, "unknown");
}

#[test]
fn preparation_does_not_execute_repository_checkout_filters() {
    let fixture = Fixture::new();
    fs::write(
        fixture.source.join(".gitattributes"),
        "*.rs filter=repairtrap\n",
    )
    .unwrap();
    fixture.git(&["add", ".gitattributes"]);
    fixture.git(&[
        "-c",
        "user.name=Repair fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "attributes fixture",
    ]);
    fixture.git(&[
        "config",
        "filter.repairtrap.smudge",
        "echo filter-executed > filter-sentinel",
    ]);
    fixture.git(&[
        "config",
        "filter.repairtrap.clean",
        "echo filter-executed > filter-sentinel",
    ]);
    let run = fixture.prepare();
    assert!(!fixture.source.join("filter-sentinel").exists());
    assert!(!run.join("candidate/filter-sentinel").exists());
    assert!(
        fs::read_to_string(run.join("candidate/crates/example/src/answer.rs"))
            .unwrap()
            .contains("41")
    );
}

#[test]
fn offline_repair_rejects_promisor_repositories_before_object_reads() {
    let fixture = Fixture::new();
    fixture.git(&["config", "remote.origin.promisor", "true"]);
    fixture.git(&["config", "remote.origin.url", "sentinel::must-not-run"]);
    let error = workspace::inspect_source(&fixture.source).unwrap_err();
    assert!(error.to_string().contains("partial/promisor"));
    assert!(!fixture.temp.path().join("run").exists());
}

#[test]
fn promisor_settings_in_includes_or_added_after_preparation_are_rejected() {
    let fixture = Fixture::new();
    let run = fixture.prepare();
    let state = load_state(&run).unwrap();
    let include = fixture.temp.path().join("partial-config");
    fs::write(
        &include,
        "[remote \"hidden\"]\n  promisor = true\n  url = sentinel::must-not-run\n",
    )
    .unwrap();
    fixture.git(&["config", "include.path", include.to_str().unwrap()]);
    assert!(workspace::inspect_source(&fixture.source).is_err());
    assert!(workspace::candidate(&run, &state).is_err());
    assert!(workspace::baseline(&state).is_err());
}

#[test]
fn refuses_foreign_product_and_reusing_an_existing_run() {
    let fixture = Fixture::new();
    let run = fixture.prepare();
    assert!(workspace::prepare(
        &fixture.source,
        &run,
        vec!["crates/example/src/answer.rs".into()],
        None
    )
    .is_err());
    fs::write(
        fixture.source.join("Cargo.toml"),
        "[workspace.package]\nrepository = \"https://example.invalid/other\"\n",
    )
    .unwrap();
    fixture.git(&["add", "Cargo.toml"]);
    fixture.git(&[
        "-c",
        "user.name=Repair fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "different product",
    ]);
    assert!(workspace::inspect_source(&fixture.source).is_err());
}

#[test]
fn refuses_unsafe_paths_and_protected_repair_owners() {
    for path in [
        "../secret",
        "/tmp/secret",
        "crates/a/../../secret",
        "crates/a\\secret",
        "C:/secret",
        ".jeikcode/config.toml",
        "crates/jeikcode-cli/src/repair/packet.rs",
        "crates/jeikcode-updater/src/lib.rs",
        "crates/jeikcode-capabilities/src/skills/skill.rs",
        "crates/jeikcode-coding/src/execution_policy.rs",
        "crates/jeikcode-coding/src/plan_mode.rs",
        "crates/jeikcode-capabilities/src/tools/sensitive_path.rs",
        "crates/jeikcode-coding/src/parts.rs",
        "crates/jeikcode-capabilities/src/tools/write_approval.rs",
        "crates/foo/Cargo.toml",
        "crates/foo/.env",
        "crates/foo/.cargo/config.toml",
        "crates/foo/.jeikcode/skills/example/SKILL.md",
    ] {
        assert!(
            workspace::validate_allowed(path).is_err(),
            "accepted unsafe path: {path}"
        );
    }
    assert!(workspace::validate_allowed("crates/example/src/answer.rs").is_ok());
}

#[cfg(unix)]
#[test]
fn executable_mode_drift_is_not_silently_treated_as_the_same_source() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let run = fixture.prepare();
    let state = load_state(&run).unwrap();
    fs::set_permissions(
        run.join("candidate/crates/example/src/answer.rs"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    assert!(workspace::candidate(&run, &state)
        .unwrap_err()
        .to_string()
        .contains("mode changed"));
    fs::set_permissions(
        run.join("candidate/crates/example/src/answer.rs"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    fs::set_permissions(
        fixture.source.join("crates/example/src/answer.rs"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    assert!(workspace::candidate(&run, &state)
        .unwrap_err()
        .to_string()
        .contains("drifted"));
}

#[cfg(unix)]
#[test]
fn digest_refuses_a_fifo_before_opening_it() {
    let temp = tempfile::tempdir().unwrap();
    let fifo = temp.path().join("not-a-regular-file");
    let c_path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
    assert!(workspace::file_digest(&fifo)
        .unwrap_err()
        .to_string()
        .contains("regular file"));
}

#[test]
fn detects_original_drift_and_changes_outside_the_frozen_scope() {
    let fixture = Fixture::new();
    let run = fixture.prepare();
    let state = load_state(&run).unwrap();
    fs::write(
        run.join("candidate/crates/jeikcode-cli/src/main.rs"),
        "unexpected edit\n",
    )
    .unwrap();
    assert!(workspace::candidate(&run, &state)
        .unwrap_err()
        .to_string()
        .contains("out-of-scope"));
    fs::write(
        run.join("candidate/crates/jeikcode-cli/src/main.rs"),
        "fn main() {}\n",
    )
    .unwrap();
    fs::write(
        fixture.source.join("crates/example/src/answer.rs"),
        "new user edit\n",
    )
    .unwrap();
    assert!(workspace::candidate(&run, &state)
        .unwrap_err()
        .to_string()
        .contains("drifted"));
    assert_eq!(
        fs::read_to_string(fixture.source.join("crates/example/src/answer.rs")).unwrap(),
        "new user edit\n"
    );
}

#[cfg(unix)]
#[test]
fn symlinked_files_and_candidate_directories_cannot_escape() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let run = fixture.prepare();
    let state = load_state(&run).unwrap();
    let file = run.join("candidate/crates/example/src/answer.rs");
    fs::remove_file(&file).unwrap();
    symlink(fixture.source.join("crates/example/src/answer.rs"), &file).unwrap();
    assert!(workspace::candidate(&run, &state).is_err());
    fs::remove_file(file).unwrap();
    fs::rename(run.join("candidate"), run.join("moved-candidate")).unwrap();
    symlink(run.join("moved-candidate"), run.join("candidate")).unwrap();
    assert!(workspace::candidate(&run, &state).is_err());
}

#[test]
fn lock_prevents_overlapping_operations_and_releases_on_scope_exit() {
    let fixture = Fixture::new();
    let run = fixture.prepare();
    let first = Lock::acquire(&run).unwrap();
    assert!(Lock::acquire(&run).is_err());
    drop(first);
    assert!(Lock::acquire(&run).is_ok());
}

#[test]
fn exported_diff_applies_to_baseline_and_preserves_program_bytes() {
    let fixture = Fixture::new();
    let run = fixture.prepare();
    fixture.change(&run);
    let packet = fixture.freeze(&run);
    let patch_path = fixture.temp.path().join("proposed.diff");
    fs::write(&patch_path, &packet.files["source.diff"]).unwrap();
    fixture.git(&["apply", "--check", patch_path.to_str().unwrap()]);
    fixture.git(&["apply", patch_path.to_str().unwrap()]);
    assert_eq!(
        fs::read(fixture.source.join("crates/example/src/answer.rs")).unwrap(),
        fs::read(run.join("candidate/crates/example/src/answer.rs")).unwrap()
    );
}

#[test]
fn notes_are_inert_redacted_and_private_run_state_is_not_exported() {
    let fixture = Fixture::new();
    let run = fixture.prepare();
    fixture.change(&run);
    let sentinel = fixture.temp.path().join("must-not-exist");
    let payload = format!("!`touch {}`\napi_key=sk-abcdefghijklmnopqrstuvwx\n/home/privateuser/work/report.log\nuser@example.invalid\n", sentinel.display());
    let (a, b) = fixture.notes(&payload, "A plain report.");
    let packet = packet::collect(&run, &load_state(&run).unwrap(), &a, &b).unwrap();
    assert!(!sentinel.exists());
    assert!(!packet.files["reproduction.md"].contains("sk-abcdefghijklmnopqrstuvwx"));
    assert!(!packet.files["reproduction.md"].contains("privateuser"));
    assert!(!packet.files["reproduction.md"].contains("user@example.invalid"));
    let public: serde_json::Value = serde_json::from_str(&packet.files["repair.json"]).unwrap();
    assert_eq!(public["installed_runtime_match"], "unknown");
    assert_eq!(public["runtime_status"], "not_tested");
    assert!(public.get("source_root").is_none());
    assert_eq!(packet.files.len(), 5);
}

#[test]
fn sensitive_diff_is_refused_without_silently_rewriting_source() {
    let fixture = Fixture::new();
    let run = fixture.prepare();
    let file = run.join("candidate/crates/example/src/answer.rs");
    let content = "const LEAK: &str = \"sk-abcdefghijklmnopqrstuvwx\";\n";
    fs::write(&file, content).unwrap();
    let (a, b) = fixture.notes("report", "report");
    assert!(packet::collect(&run, &load_state(&run).unwrap(), &a, &b).is_err());
    assert_eq!(fs::read_to_string(file).unwrap(), content);
}

#[test]
fn empty_file_creation_cannot_produce_a_misleading_empty_diff() {
    let fixture = Fixture::new();
    let run = workspace::prepare(
        &fixture.source,
        &fixture.temp.path().join("run"),
        vec!["crates/example/src/new.rs".into()],
        None,
    )
    .unwrap();
    fs::write(run.join("candidate/crates/example/src/new.rs"), "").unwrap();
    let (a, b) = fixture.notes("report", "report");
    assert!(packet::collect(&run, &load_state(&run).unwrap(), &a, &b)
        .unwrap_err()
        .to_string()
        .contains("empty-file"));
}

#[test]
fn export_requires_preview_and_exact_digest_and_uses_only_frozen_bytes() {
    let fixture = Fixture::new();
    let run = fixture.prepare();
    fixture.change(&run);
    let frozen = fixture.freeze(&run);
    let output = fixture.temp.path().join("contribution");
    assert!(packet::export(&run, &frozen.sha256, &output).is_err());
    packet::mark_previewed(&run, &frozen.sha256).unwrap();
    assert!(packet::export(&run, &"0".repeat(64), &output).is_err());
    fs::write(
        run.join("candidate/crates/example/src/answer.rs"),
        "a later unverified edit\n",
    )
    .unwrap();
    fs::write(run.join("candidate-stdout.txt"), "later private log\n").unwrap();
    packet::export(&run, &frozen.sha256, &output).unwrap();
    for (name, content) in &frozen.files {
        assert_eq!(fs::read(output.join(name)).unwrap(), content.as_bytes());
    }
    assert_eq!(fs::read_dir(&output).unwrap().count(), 5);
    assert!(packet::export(&run, &frozen.sha256, &output).is_err());
}

#[test]
fn changed_frozen_payload_and_unexpected_filenames_are_rejected() {
    let fixture = Fixture::new();
    let run = fixture.prepare();
    let mut frozen = fixture.freeze(&run);
    frozen
        .files
        .insert("report.md".into(), "changed after collection".into());
    workspace::replace_private(
        &run.join("preview.json"),
        &serde_json::to_vec(&frozen).unwrap(),
    )
    .unwrap();
    assert!(packet::load_frozen(&run).is_err());
    frozen.files.remove("report.md");
    frozen
        .files
        .insert("../escape".into(), "untrusted member".into());
    frozen.sha256 = workspace::digest(&serde_json::to_vec(&frozen.files).unwrap());
    workspace::replace_private(
        &run.join("preview.json"),
        &serde_json::to_vec(&frozen).unwrap(),
    )
    .unwrap();
    assert!(packet::load_frozen(&run).is_err());
}

#[test]
fn a_receipt_for_an_earlier_candidate_never_marks_new_bytes_checked() {
    let fixture = Fixture::new();
    let probe = fixture.temp.path().join("probe.sh");
    fs::write(&probe, "exit 0\n").unwrap();
    let run = workspace::prepare(
        &fixture.source,
        &fixture.temp.path().join("run"),
        vec!["crates/example/src/answer.rs".into()],
        Some(&probe),
    )
    .unwrap();
    let state = load_state(&run).unwrap();
    let receipt = Receipt {
        phase: "candidate".into(),
        status: "checks_passed".into(),
        source_digest: workspace::candidate(&run, &state).unwrap().digest,
        probe_sha256: state.probe.as_ref().unwrap().sha256.clone(),
        argv: vec!["/bin/sh".into(), "/probe.sh".into()],
        cwd: "/work".into(),
        started_at_unix_ms: 1,
        duration_ms: 1,
        exit_code: Some(0),
        stdout_sha256: workspace::digest(&[]),
        stderr_sha256: workspace::digest(&[]),
        output_truncated: false,
        boundary: "linux_bubblewrap".into(),
        detail: "fabricated test receipt, not product verification".into(),
    };
    workspace::write_new(
        &run.join("candidate-receipt.json"),
        &serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    fixture.change(&run);
    let frozen = fixture.freeze(&run);
    let verification: serde_json::Value =
        serde_json::from_str(&frozen.files["verification.json"]).unwrap();
    assert_eq!(verification["candidate"]["status"], "stale_or_invalid");
    assert_eq!(verification["installed_runtime"], "not_tested");
}

#[test]
fn changing_the_captured_probe_invalidates_execution() {
    let fixture = Fixture::new();
    let probe = fixture.temp.path().join("probe.sh");
    fs::write(&probe, "exit 0\n").unwrap();
    let run = workspace::prepare(
        &fixture.source,
        &fixture.temp.path().join("run"),
        vec!["crates/example/src/answer.rs".into()],
        Some(&probe),
    )
    .unwrap();
    fs::write(run.join("probe.sh"), "exit 1\n").unwrap();
    assert!(runner::execute(&run, &load_state(&run).unwrap(), "candidate", 1).is_err());
}

#[test]
fn a_preflight_failure_does_not_leave_the_previous_attempt_as_current() {
    let fixture = Fixture::new();
    let run_path = fixture.prepare();
    let prior = b"previous local receipt preserved for inspection";
    workspace::write_new(&run_path.join("candidate-receipt.json"), prior).unwrap();
    let args: Vec<OsString> = vec![
        "run".into(),
        "--run".into(),
        run_path.as_os_str().to_owned(),
        "--phase".into(),
        "candidate".into(),
    ];
    assert!(run(&args).is_err(), "there is no captured probe");
    assert!(!run_path.join("candidate-receipt.json").exists());
    let archived: Vec<_> = fs::read_dir(run_path.join("receipt-history"))
        .unwrap()
        .collect();
    assert_eq!(archived.len(), 1);
    assert_eq!(
        fs::read(archived[0].as_ref().unwrap().path()).unwrap(),
        prior
    );
    let packet = fixture.freeze(&run_path);
    let verification: serde_json::Value =
        serde_json::from_str(&packet.files["verification.json"]).unwrap();
    assert_eq!(verification["candidate"]["status"], "not_run");
}

#[test]
fn runner_does_not_fall_back_to_host_execution() {
    let fixture = Fixture::new();
    let sentinel = fixture.temp.path().join("outside-write-must-not-happen");
    let probe = fixture.temp.path().join("probe.sh");
    fs::write(&probe, format!("touch '{}'\n", sentinel.display())).unwrap();
    let run = workspace::prepare(
        &fixture.source,
        &fixture.temp.path().join("run"),
        vec!["crates/example/src/answer.rs".into()],
        Some(&probe),
    )
    .unwrap();
    let receipt = runner::execute(&run, &load_state(&run).unwrap(), "candidate", 2).unwrap();
    assert!(!sentinel.exists(), "untrusted probe escaped to host");
    assert!(["blocked", "failed"].contains(&receipt.status.as_str()));
    eprintln!(
        "repair sandbox observation: status={}, boundary={}",
        receipt.status, receipt.boundary
    );
}
