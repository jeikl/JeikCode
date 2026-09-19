use assert_cmd::Command;

#[test]
fn completion_exits_before_startup_side_effects() {
    let jeikcode_home = tempfile::tempdir().unwrap();

    Command::cargo_bin("jeikcode")
        .unwrap()
        .env("JEIKCODE_HOME", jeikcode_home.path())
        .arg("completion")
        .arg("bash")
        .assert()
        .success()
        .stderr("")
        .stdout(predicates::str::contains("jeikcode"));

    assert!(
        jeikcode_home.path().read_dir().unwrap().next().is_none(),
        "completion generation must not create logs, config, or telemetry state"
    );
}
