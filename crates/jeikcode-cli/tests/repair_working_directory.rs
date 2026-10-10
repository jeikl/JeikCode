//! Exercise the early repair dispatch in a separate process: a directory
//! override must affect every relative path without starting the application.

use assert_cmd::Command;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

const SOURCE: &str = "crates/example/src/answer.rs";
const CONFIG: &[u8] = b"deliberately invalid [toml";

struct Fixture {
    temp: tempfile::TempDir,
    caller: PathBuf,
    selected: PathBuf,
    home: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let caller = temp.path().join("caller");
        let selected = temp.path().join("selected/source with spaces");
        let home = temp.path().join("app-home");
        fs::create_dir(&home).unwrap();
        fs::write(home.join("config.toml"), CONFIG).unwrap();
        for (root, marker) in [(&caller, "caller"), (&selected, "selected")] {
            fs::create_dir_all(root.join("crates/jeikcode-cli/src")).unwrap();
            fs::create_dir_all(root.join("crates/example/src")).unwrap();
            fs::write(
                root.join("Cargo.toml"),
                "[workspace.package]\nrepository = \"https://github.com/jeikl/JeikCode\"\n",
            )
            .unwrap();
            fs::write(
                root.join("crates/jeikcode-cli/src/main.rs"),
                format!("fn main() {{}} // {marker}\n"),
            )
            .unwrap();
            fs::write(root.join(SOURCE), "pub fn answer() -> i32 { 41 }\n").unwrap();
            git(root, &["init", "-q"]);
            git(root, &["add", "."]);
            git(
                root,
                &[
                    "-c",
                    "user.name=Repair fixture",
                    "-c",
                    "user.email=fixture@example.invalid",
                    "commit",
                    "-qm",
                    marker,
                ],
            );
        }
        Self {
            temp,
            caller,
            selected,
            home,
        }
    }

    fn command(&self) -> Command {
        let mut command = Command::cargo_bin("jeikcode").unwrap();
        command
            .current_dir(&self.caller)
            .env("JEIKCODE_HOME", &self.home)
            .timeout(Duration::from_secs(45));
        command
    }

    fn assert_home_untouched(&self) {
        assert_eq!(fs::read(self.home.join("config.toml")).unwrap(), CONFIG);
        assert_eq!(fs::read_dir(&self.home).unwrap().count(), 1);
    }
}

fn git(root: &Path, args: &[&str]) -> Vec<u8> {
    Command::new("git")
        .current_dir(root)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.autocrlf=false",
        ])
        .args(args)
        .timeout(Duration::from_secs(20))
        .assert()
        .success()
        .get_output()
        .stdout
        .clone()
}

fn json(command: &mut Command) -> Value {
    serde_json::from_slice(&command.assert().success().get_output().stdout).unwrap()
}

#[test]
fn repair_directory_override_selects_the_requested_checkout() {
    let fixture = Fixture::new();
    for flag in ["-C", "--dir"] {
        let value = json(
            fixture
                .command()
                .arg(flag)
                .arg(&fixture.selected)
                .args(["repair", "info", "--source", "."]),
        );
        assert_eq!(
            Path::new(value["source_root"].as_str().unwrap())
                .canonicalize()
                .unwrap(),
            fixture.selected.canonicalize().unwrap()
        );
    }
    let relative = json(fixture.command().args([
        "-C",
        "../selected/source with spaces",
        "repair",
        "info",
        "--source",
        ".",
    ]));
    assert_eq!(
        Path::new(relative["source_root"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        fixture.selected.canonicalize().unwrap()
    );
    let no_override = json(fixture.command().args(["repair", "info", "--source", "."]));
    assert_eq!(
        Path::new(no_override["source_root"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        fixture.caller.canonicalize().unwrap()
    );
    fixture.assert_home_untouched();
}

#[test]
fn invalid_repair_directory_fails_before_creating_a_candidate() {
    let fixture = Fixture::new();
    fixture
        .command()
        .args([
            "-C",
            "../missing",
            "repair",
            "prepare",
            "--source",
            ".",
            "--run",
            "../unexpected-run",
            "--allow",
            SOURCE,
        ])
        .assert()
        .failure();
    assert!(!fixture.temp.path().join("unexpected-run").exists());
    assert!(git(&fixture.caller, &["status", "--porcelain"]).is_empty());
    // Embedded metadata remains independent of the selected directory.
    let info = json(fixture.command().args(["-C", "../missing", "--build-info"]));
    assert_eq!(info["repair_protocol"], 1);
    fixture.assert_home_untouched();
}

#[test]
fn repair_directory_override_applies_to_candidate_notes_and_export() {
    let fixture = Fixture::new();
    let parent = fixture.selected.parent().unwrap();
    let original = fs::read(fixture.selected.join(SOURCE)).unwrap();
    let before_index = git(&fixture.selected, &["ls-files", "--stage", "-z"]);
    let prepared = json(fixture.command().arg("-C").arg(&fixture.selected).args([
        "repair",
        "prepare",
        "--source",
        ".",
        "--run",
        "../repair-run",
        "--allow",
        SOURCE,
    ]));
    let run = parent.join("repair-run");
    assert_eq!(
        Path::new(prepared["run"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        run.canonicalize().unwrap()
    );
    fs::write(
        run.join("candidate").join(SOURCE),
        "pub fn answer() -> i32 { 42 }\n",
    )
    .unwrap();
    fs::write(
        parent.join("reproduction.md"),
        "Expected 42; baseline returned 41.\n",
    )
    .unwrap();
    fs::write(
        parent.join("report.md"),
        "Changed the incorrect constant; probe not run.\n",
    )
    .unwrap();
    let checked = json(fixture.command().arg("--dir").arg(&fixture.selected).args([
        "repair",
        "check",
        "--run",
        "../repair-run",
    ]));
    assert_eq!(checked["status"], "scope_checked");
    json(fixture.command().arg("-C").arg(&fixture.selected).args([
        "repair",
        "collect",
        "--run",
        "../repair-run",
        "--reproduction",
        "../reproduction.md",
        "--report",
        "../report.md",
    ]));
    let preview = json(fixture.command().arg("-C").arg(&fixture.selected).args([
        "repair",
        "preview",
        "--run",
        "../repair-run",
    ]));
    fixture
        .command()
        .arg("-C")
        .arg(&fixture.selected)
        .args([
            "repair",
            "export",
            "--run",
            "../repair-run",
            "--accept",
            preview["sha256"].as_str().unwrap(),
            "--output",
            "../export",
        ])
        .assert()
        .success();
    let export = parent.join("export");
    for (name, content) in preview["files"].as_object().unwrap() {
        assert_eq!(
            fs::read(export.join(name)).unwrap(),
            content.as_str().unwrap().as_bytes()
        );
    }
    assert_eq!(fs::read_dir(&export).unwrap().count(), 5);
    git(
        &fixture.selected,
        &[
            "apply",
            "--check",
            export.join("source.diff").to_str().unwrap(),
        ],
    );
    assert_eq!(fs::read(fixture.selected.join(SOURCE)).unwrap(), original);
    assert_eq!(
        git(&fixture.selected, &["ls-files", "--stage", "-z"]),
        before_index
    );
    assert!(!fixture.temp.path().join("repair-run").exists());
    assert!(!fixture.temp.path().join("export").exists());
    fixture.assert_home_untouched();
}
