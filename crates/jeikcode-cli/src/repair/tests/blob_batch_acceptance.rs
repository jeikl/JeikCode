use super::*;
use std::fs;

fn commit(fixture: &Fixture, message: &str) {
    fixture.git(&["add", "."]);
    fixture.git(&[
        "-c",
        "user.name=Repair fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        message,
    ]);
}

fn object_id(fixture: &Fixture, spec: &str) -> String {
    String::from_utf8(fixture.git(&["rev-parse", spec]))
        .unwrap()
        .trim()
        .to_owned()
}

fn test_blob(fixture: &Fixture, sha: &str, budget: u64) -> Result<Vec<u8>> {
    workspace::test_blob(&fixture.source, sha, budget)
}

#[test]
fn batch_prepare_and_baseline_bound_git_processes_and_preserve_every_digest() {
    let fixture = Fixture::new();
    for index in 0u8..32 {
        let path = fixture
            .source
            .join(format!("crates/example/src/batch_{index:02}.bin"));
        fs::write(&path, [index, 0, b'\n', 0xff]).unwrap();
    }
    commit(&fixture, "batch reader fixture");

    let before = workspace::git_command_count();
    let run = fixture.prepare();
    let prepare_spawned = workspace::git_command_count() - before;

    assert!(
        prepare_spawned <= 24,
        "prepare spawned {prepare_spawned} Git processes for 35 tracked files"
    );
    let state = load_state(&run).unwrap();
    assert_eq!(state.files.len(), 35);
    assert_eq!(state.source.commit, object_id(&fixture, "HEAD"));
    assert_eq!(state.source.tree, object_id(&fixture, "HEAD^{tree}"));

    let keys: Vec<_> = state.files.keys().cloned().collect();
    let mut sorted = keys.clone();
    sorted.sort();
    assert_eq!(keys, sorted, "tracked object identity order must be stable");
    for (path, entry) in &state.files {
        let bytes = fs::read(fixture.source.join(path)).unwrap();
        assert_eq!(
            entry.sha256,
            workspace::digest(&bytes),
            "wrong content digest for {path}"
        );
        assert_eq!(
            entry.blob,
            object_id(&fixture, &format!("HEAD:{path}")),
            "wrong Git object identity for {path}"
        );
        assert_eq!(
            fs::read(run.join("candidate").join(path)).unwrap(),
            bytes,
            "prepare materialized different bytes for {path}"
        );
    }

    let before_baseline = workspace::git_command_count();
    let baseline = workspace::baseline(&state).unwrap();
    let baseline_spawned = workspace::git_command_count() - before_baseline;
    assert!(
        baseline_spawned <= 3,
        "baseline spawned {baseline_spawned} Git processes for {} tracked files",
        state.files.len()
    );
    assert_eq!(baseline.bytes.len(), state.files.len());
    for (path, entry) in &state.files {
        let bytes = &baseline.bytes[path];
        assert_eq!(
            workspace::digest(bytes),
            entry.sha256,
            "baseline digest changed for {path}"
        );
    }
}

#[test]
fn prepare_and_baseline_preserve_binary_newline_empty_blobs_and_packet_diff() {
    let fixture = Fixture::new();
    let cases: [(&str, &[u8]); 3] = [
        ("crates/example/src/raw.bin", b"\0raw\nbytes\xff\0"),
        ("crates/example/src/newlines.bin", b"first\nsecond\n"),
        ("crates/example/src/empty.bin", b""),
    ];
    for (path, bytes) in cases {
        fs::write(fixture.source.join(path), bytes).unwrap();
    }
    commit(&fixture, "raw blob fixtures");

    let run = fixture.prepare();
    let state = load_state(&run).unwrap();
    let baseline = workspace::baseline(&state).unwrap();
    for (path, expected) in cases {
        let entry = &state.files[path];
        assert_eq!(entry.blob, object_id(&fixture, &format!("HEAD:{path}")));
        assert_eq!(entry.sha256, workspace::digest(expected));
        assert_eq!(baseline.bytes[path], expected);
        assert_eq!(
            fs::read(run.join("candidate").join(path)).unwrap(),
            expected
        );
    }

    fixture.change(&run);
    let packet = fixture.freeze(&run);
    let patch = fixture.temp.path().join("batch-roundtrip.diff");
    fs::write(&patch, &packet.files["source.diff"]).unwrap();
    fixture.git(&["apply", "--check", patch.to_str().unwrap()]);
    fixture.git(&["apply", patch.to_str().unwrap()]);
    assert_eq!(
        fs::read(fixture.source.join("crates/example/src/answer.rs")).unwrap(),
        fs::read(run.join("candidate/crates/example/src/answer.rs")).unwrap()
    );
    for (path, expected) in cases {
        assert_eq!(fs::read(fixture.source.join(path)).unwrap(), expected);
    }
}

#[test]
fn batch_blob_reader_rejects_wrong_type_missing_object_and_size_over_budget() {
    let fixture = Fixture::new();
    let answer_blob = object_id(&fixture, "HEAD:crates/example/src/answer.rs");
    let commit_object = object_id(&fixture, "HEAD");
    let missing = "0".repeat(40);

    let wrong_type = test_blob(&fixture, &commit_object, 1024).unwrap_err();
    assert!(
        wrong_type.to_string().contains("blob"),
        "wrong object type error lost context: {wrong_type:#}"
    );

    let missing_error = test_blob(&fixture, &missing, 1024).unwrap_err();
    assert!(
        missing_error.to_string().contains("missing"),
        "missing object error lost context: {missing_error:#}"
    );

    let size_error = test_blob(&fixture, &answer_blob, 1).unwrap_err();
    assert!(
        size_error.to_string().contains("limit") || size_error.to_string().contains("size"),
        "oversized blob error lost context: {size_error:#}"
    );
}

#[test]
fn batch_backed_candidate_still_rejects_original_source_drift() {
    let fixture = Fixture::new();
    let run = fixture.prepare();
    let state = load_state(&run).unwrap();
    fs::write(
        fixture.source.join("crates/example/src/answer.rs"),
        "user changed source after prepare\n",
    )
    .unwrap();

    let error = workspace::candidate(&run, &state).unwrap_err();
    assert!(
        error.to_string().contains("drifted"),
        "source drift guard changed unexpectedly: {error:#}"
    );
}
