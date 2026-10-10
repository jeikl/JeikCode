use super::*;
use jeikcode_daemon::api_repair::{RepairBackend, RepairRequest};

fn preview(source: &Path, run: &Path) -> Result<serde_json::Value> {
    WebuiRepairBackend.execute(RepairRequest::Preview {
        source: source.to_owned(),
        run: run.to_owned(),
    })
}

fn export(source: &Path, run: &Path, accept: &str, output: &Path) -> Result<serde_json::Value> {
    WebuiRepairBackend.execute(RepairRequest::Export {
        source: source.to_owned(),
        run: run.to_owned(),
        accept: accept.into(),
        output: output.to_owned(),
    })
}

#[test]
fn webui_info_uses_explicit_source_without_switching_cwd_or_claiming_runtime_match() {
    let fixture = Fixture::new();
    let cwd = std::env::current_dir().unwrap();
    let source = fixture.source.canonicalize().unwrap();
    let info = WebuiRepairBackend
        .execute(RepairRequest::Info {
            source: source.clone(),
        })
        .unwrap();
    let expected_commit = String::from_utf8(fixture.git(&["rev-parse", "HEAD"])).unwrap();
    assert_eq!(info["source_root"], source.to_str().unwrap());
    assert_eq!(info["source"]["commit"], expected_commit.trim());
    assert_eq!(info["source"]["dirty"], false);
    assert_eq!(info["observer"]["repair_protocol"], 1);
    assert_eq!(info["observer"]["source_artifact_relation"], "unknown");
    assert_eq!(info["installed_runtime_match"], "unknown");
    assert_eq!(std::env::current_dir().unwrap(), cwd);

    let error = WebuiRepairBackend
        .execute(RepairRequest::Info {
            source: source.join("crates"),
        })
        .unwrap_err();
    assert!(!error.to_string().is_empty());
    assert!(WebuiRepairBackend
        .execute(RepairRequest::Info {
            source: PathBuf::from(".")
        })
        .is_err());
    assert_eq!(std::env::current_dir().unwrap(), cwd);
}

#[test]
fn webui_preview_and_export_preserve_all_frozen_bytes_after_source_and_candidate_changes() {
    let fixture = Fixture::new();
    let run = fixture.prepare();
    fixture.change(&run);
    let state = load_state(&run).unwrap();
    let (reproduction, report) = fixture.notes(
        "First line\r\nVietnamese: đường dẫn\nNo final newline",
        "Literal <script>text</script> and control \u{1b}[31m stay data.\n",
    );
    let frozen = packet::collect(&run, &state, &reproduction, &report).unwrap();
    workspace::replace_private(
        &run.join("preview.json"),
        &serde_json::to_vec_pretty(&frozen).unwrap(),
    )
    .unwrap();
    let shown = preview(&fixture.source, &run).unwrap();
    assert_eq!(shown["source_root"], state.source_root.to_str().unwrap());
    assert_eq!(shown["run_root"], run.to_str().unwrap());
    assert_eq!(shown["packet"]["sha256"], frozen.sha256);
    assert_eq!(shown["packet"]["files"].as_object().unwrap().len(), 5);
    for (name, contents) in &frozen.files {
        assert_eq!(shown["packet"]["files"][name], *contents);
    }
    // Export binds to the reviewed frozen bytes, not the subsequent mutable
    // candidate or notes. No new claim of current-source verification is made.
    fs::write(
        run.join("candidate/crates/example/src/answer.rs"),
        "later candidate\n",
    )
    .unwrap();
    fs::write(report, "later notes\n").unwrap();
    fs::write(
        fixture.source.join("crates/example/src/answer.rs"),
        "new original revision\n",
    )
    .unwrap();
    fixture.git(&["add", "crates/example/src/answer.rs"]);
    fixture.git(&[
        "-c",
        "user.name=Repair fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "later source revision",
    ]);
    let current = WebuiRepairBackend
        .execute(RepairRequest::Info {
            source: fixture.source.clone(),
        })
        .unwrap();
    assert_ne!(current["source"]["commit"], state.source.commit);
    let reopened = preview(&fixture.source, &run).unwrap();
    assert_eq!(
        reopened["packet"], shown["packet"],
        "reopening must not restamp the historical packet"
    );
    let output = fixture.temp.path().join("packet reviewed");
    let result = export(&fixture.source, &run, &frozen.sha256, &output).unwrap();
    assert_eq!(result["status"], "exported_local");
    assert_eq!(result["sha256"], frozen.sha256);
    assert_eq!(
        result["output"],
        output.canonicalize().unwrap().to_str().unwrap()
    );
    assert_eq!(fs::read_dir(&output).unwrap().count(), 5);
    for (name, contents) in &frozen.files {
        assert_eq!(fs::read(output.join(name)).unwrap(), contents.as_bytes());
    }
    assert!(!run.join("operation.lock").exists());
}

#[test]
fn webui_run_from_another_checkout_is_rejected_before_preview_or_export() {
    let fixture = Fixture::new();
    let other = Fixture::new();
    let run = fixture.prepare();
    let frozen = fixture.freeze(&run);
    let output = fixture.temp.path().join("wrong-source-export");
    assert!(preview(&other.source, &run)
        .unwrap_err()
        .to_string()
        .contains("different source"));
    assert!(!run.join("previewed.sha256").exists());
    assert!(export(&other.source, &run, &frozen.sha256, &output).is_err());
    assert!(!output.exists());
    assert!(!run.join("operation.lock").exists());
}

#[test]
fn webui_rejects_a_rehashed_packet_copied_from_another_run() {
    let fixture = Fixture::new();
    let other = Fixture::new();
    let run = fixture.prepare();
    fixture.freeze(&run);
    preview(&fixture.source, &run).unwrap();
    let other_run = other.prepare();
    let other_packet = other.freeze(&other_run);
    fs::copy(other_run.join("preview.json"), run.join("preview.json")).unwrap();
    // Its own hash/allowlist is valid, but the native run identity differs.
    packet::load_frozen(&run).unwrap();
    assert!(preview(&fixture.source, &run)
        .unwrap_err()
        .to_string()
        .contains("identity differs"));
    let output = fixture.temp.path().join("foreign-packet-export");
    assert!(export(&fixture.source, &run, &other_packet.sha256, &output).is_err());
    assert!(!output.exists());
}

#[test]
fn webui_export_requires_preview_acknowledgment_and_a_new_external_destination() {
    let fixture = Fixture::new();
    let run = fixture.prepare();
    let frozen = fixture.freeze(&run);
    let output = fixture.temp.path().join("export");
    assert!(export(&fixture.source, &run, &frozen.sha256, &output).is_err());
    assert!(!output.exists());
    preview(&fixture.source, &run).unwrap();
    assert!(export(&fixture.source, &run, &"0".repeat(64), &output).is_err());
    assert!(!output.exists());
    assert!(export(&fixture.source, &run, &frozen.sha256, &run.join("export")).is_err());
    assert!(export(
        &fixture.source,
        &run,
        &frozen.sha256,
        &fixture.source.join("export")
    )
    .is_err());
    fs::create_dir(&output).unwrap();
    fs::write(output.join("keep.txt"), "user data").unwrap();
    assert!(export(&fixture.source, &run, &frozen.sha256, &output).is_err());
    assert_eq!(
        fs::read_to_string(output.join("keep.txt")).unwrap(),
        "user data"
    );
    assert_eq!(fs::read_dir(&output).unwrap().count(), 1);
}

#[test]
fn checked_in_repair_skill_loads_at_the_selected_root_without_expansion() {
    use jeikcode_capabilities::skills::{standard_skill_dirs, SkillRegistry};

    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let skills = SkillRegistry::load(&[root.join(".jeikcode/skills")]);
    let skill = skills
        .get("jeikcode-self-repair")
        .expect("checked-in repair skill");
    assert!(skill.user_invocable);
    assert!(skill.disable_shell_expansion);
    assert!(skill
        .expand("", "repair-pilot-test")
        .contains("JeikCode self-repair"));

    // The pilot explicitly selects the repository root. The existing discovery
    // contract does not walk parents from an arbitrary nested working directory.
    let empty_home = tempfile::tempdir().unwrap();
    let nested_dirs = standard_skill_dirs(empty_home.path(), &root.join("crates/jeikcode-cli"));
    assert!(!nested_dirs.contains(&root.join(".jeikcode/skills")));
    assert!(SkillRegistry::load(&nested_dirs)
        .get("jeikcode-self-repair")
        .is_none());
}
