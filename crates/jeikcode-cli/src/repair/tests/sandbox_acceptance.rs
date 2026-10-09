#![cfg(target_os = "linux")]

use super::*;
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

struct EnvGuard {
    key: &'static str,
    previous: Option<OsString>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

fn prepare_with_probe(fixture: &Fixture, probe: &str) -> (PathBuf, State) {
    let probe_path = fixture.temp.path().join("acceptance-probe.sh");
    fs::write(&probe_path, probe).unwrap();
    let run = workspace::prepare(
        &fixture.source,
        &fixture.temp.path().join("run"),
        vec!["crates/example/src/answer.rs".into()],
        Some(&probe_path),
    )
    .unwrap();
    let state = load_state(&run).unwrap();
    (run, state)
}

fn setup_error_log(run: &Path, phase: &str) -> String {
    let setup_log = run.join(format!("{phase}-sandbox-error.txt"));
    fs::read(&setup_log)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_else(|error| format!("<no setup error log: {error}>"))
}

fn sandbox_diagnostics(run: &Path, phase: &str, receipt: &Receipt) -> String {
    let setup_error = setup_error_log(run, phase);
    let probe_stderr = fs::read(run.join(format!("{phase}-stderr.txt")))
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_else(|error| format!("<no probe stderr log: {error}>"));
    format!(
        "status={}, boundary={}, exit={:?}, detail={}, probe_stderr={probe_stderr:?}, setup_error={setup_error:?}",
        receipt.status, receipt.boundary, receipt.exit_code, receipt.detail,
    )
}

fn execute_required(run: &Path, state: &State, phase: &str, timeout: u64) -> Receipt {
    let input_probe = state
        .probe
        .as_ref()
        .map(|probe| probe.sha256.as_str())
        .unwrap_or("<missing>");
    let input_source = if phase == "baseline" {
        workspace::baseline(state).unwrap().digest
    } else {
        workspace::candidate(run, state).unwrap().digest
    };
    eprintln!(
        "repair sandbox acceptance input {phase}: source_digest={input_source}, probe_sha256={input_probe}"
    );
    let receipt = runner::execute(run, state, phase, timeout).unwrap_or_else(|error| {
        let setup_error = setup_error_log(run, phase);
        panic!(
            "repair sandbox acceptance {phase} runner error: {error:#}; setup_error={setup_error:?}"
        )
    });
    let diagnostics = sandbox_diagnostics(run, phase, &receipt);
    eprintln!("repair sandbox acceptance {phase}: {diagnostics}");
    assert_ne!(
        receipt.status,
        "blocked",
        "Linux acceptance requires working bubblewrap namespaces; blocked is a failing result: {diagnostics}"
    );
    assert_eq!(
        receipt.boundary, "linux_bubblewrap",
        "acceptance must exercise the enforced Linux sandbox: {diagnostics}"
    );
    receipt
}

fn persist_receipt(run: &Path, receipt: &Receipt) {
    workspace::replace_private(
        &run.join(format!("{}-receipt.json", receipt.phase)),
        &serde_json::to_vec_pretty(receipt).unwrap(),
    )
    .unwrap();
}

fn verification(packet: &packet::FrozenPacket) -> serde_json::Value {
    serde_json::from_str(&packet.files["verification.json"]).unwrap()
}

fn host_process_contains(marker: &str) -> bool {
    let marker = marker.as_bytes();
    for entry in fs::read_dir("/proc").expect("Linux acceptance requires /proc") {
        let Ok(entry) = entry else {
            continue;
        };
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let Ok(cmdline) = fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        if cmdline.windows(marker.len()).any(|window| window == marker) {
            return true;
        }
    }
    false
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "Requires a Linux host with bubblewrap namespaces; run explicitly for acceptance"]
fn sandbox_isolated_probe_fails_baseline_and_passes_candidate_with_same_digest() {
    let fixture = Fixture::new();
    let synthetic_env_key = "JEIKCODE_REPAIR_ACCEPTANCE_HOST_ONLY_SENTINEL";
    let synthetic_env_value = format!("host-only-{}", uuid::Uuid::new_v4());
    let _environment = EnvGuard::set(synthetic_env_key, &synthetic_env_value);
    assert_eq!(
        std::env::var_os(synthetic_env_key).as_deref(),
        Some(std::ffi::OsStr::new(&synthetic_env_value)),
        "synthetic host environment sentinel must exist before sandbox execution"
    );
    let host_namespaces: Vec<_> = ["user", "ipc", "pid", "net", "uts", "cgroup", "mnt"]
        .into_iter()
        .map(|name| {
            let inode = fs::metadata(format!("/proc/self/ns/{name}"))
                .unwrap_or_else(|error| panic!("stat host {name} namespace inode: {error}"))
                .ino();
            assert_ne!(inode, 0, "host {name} namespace inode must be nonzero");
            (name, inode)
        })
        .collect();
    assert!(
        fixture.temp.path().is_dir(),
        "fixture host temp directory must exist before sandbox execution"
    );
    let host_temp = shell_quote(
        fixture
            .temp
            .path()
            .to_str()
            .expect("tempfile path must be UTF-8 for shell acceptance probe"),
    );
    let mut probe = r#"set -eu
fail() {
    code="$1"
    shift
    printf '%s\n' "$*" >&2
    exit "$code"
}
[ "$(pwd)" = "/work" ] || fail 30 "cwd boundary mismatch"
[ "$HOME" = "/home/repair" ] || fail 31 "HOME boundary mismatch"
[ "$TMPDIR" = "/tmp" ] || fail 32 "TMPDIR boundary mismatch"
[ -z "${JEIKCODE_HOME+x}" ] || fail 33 "JEIKCODE_HOME leaked into sandbox"
[ -z "${SSH_AUTH_SOCK+x}" ] || fail 34 "SSH_AUTH_SOCK leaked into sandbox"
[ -z "${GITHUB_TOKEN+x}" ] || fail 35 "GITHUB_TOKEN leaked into sandbox"
[ -z "${AWS_ACCESS_KEY_ID+x}" ] || fail 36 "AWS_ACCESS_KEY_ID leaked into sandbox"
printf 'tmp-ok' > "$TMPDIR/write-check" || fail 37 "TMPDIR is not writable"
printf 'home-ok' > "$HOME/write-check" || fail 38 "sandbox HOME is not writable"
[ "$(cat "$TMPDIR/write-check")" = "tmp-ok" ] || fail 39 "TMPDIR write did not persist"
[ "$(cat "$HOME/write-check")" = "home-ok" ] || fail 40 "HOME write did not persist"
if (printf 'forbidden\n' >> crates/example/src/answer.rs) 2>/dev/null; then
    fail 41 "read-only source accepted a write"
fi
[ -r /proc/self/net/route ] || fail 42 "sandbox route table is unreadable"
while read -r interface destination rest; do
    if [ "$destination" = "00000000" ]; then
        fail 43 "sandbox unexpectedly has a default route"
    fi
done < /proc/self/net/route
"#
    .to_owned();
    probe.push_str(&format!(
        "[ -z \"${{{}+x}}\" ] || fail 44 \"synthetic host environment leaked into sandbox\"\n",
        synthetic_env_key
    ));
    probe.push_str(&format!(
        "[ ! -e {host_temp} ] || fail 45 \"fixture host temp directory is visible in sandbox\"\n"
    ));
    for (offset, (name, host_inode)) in host_namespaces.into_iter().enumerate() {
        let code = 46 + offset;
        probe.push_str(&format!(
            "ns_inode=$(stat -Lc %i /proc/self/ns/{name}) || fail {code} \"cannot read {name} namespace inode\"\n\
             case \"$ns_inode\" in ''|*[!0-9]*) fail {code} \"invalid {name} namespace inode\" ;; esac\n\
             [ \"$ns_inode\" != '{host_inode}' ] || fail {code} \"{name} namespace inode matches host\"\n"
        ));
    }
    probe.push_str(
        "grep -q '42' crates/example/src/answer.rs || fail 1 \"answer mismatch: expected 42\"\n",
    );
    let (run, state) = prepare_with_probe(&fixture, &probe);
    fixture.change(&run);

    let baseline = execute_required(&run, &state, "baseline", 5);
    assert_eq!(baseline.status, "failed");
    assert_eq!(baseline.exit_code, Some(1));

    let candidate = execute_required(&run, &state, "candidate", 5);
    assert_eq!(candidate.status, "checks_passed");
    assert_eq!(candidate.exit_code, Some(0));
    assert_eq!(baseline.probe_sha256, candidate.probe_sha256);
    assert_eq!(candidate.probe_sha256, state.probe.as_ref().unwrap().sha256);
    assert_ne!(baseline.source_digest, candidate.source_digest);
    assert_eq!(
        fs::read_to_string(run.join("candidate/crates/example/src/answer.rs")).unwrap(),
        "pub fn answer() -> i32 { 42 }\n"
    );
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "Requires a Linux host with bubblewrap namespaces; run explicitly for acceptance"]
fn collected_receipts_become_stale_after_source_or_probe_drift() {
    let fixture = Fixture::new();
    let probe = "set -eu\ngrep -q '42' crates/example/src/answer.rs\n";
    let (run, state) = prepare_with_probe(&fixture, probe);
    fixture.change(&run);

    let baseline = execute_required(&run, &state, "baseline", 5);
    let candidate = execute_required(&run, &state, "candidate", 5);
    assert_eq!(baseline.status, "failed");
    assert_eq!(candidate.status, "checks_passed");
    persist_receipt(&run, &baseline);
    persist_receipt(&run, &candidate);

    let fresh = verification(&fixture.freeze(&run));
    assert_eq!(fresh["baseline"]["status"], "failed");
    assert_eq!(fresh["candidate"]["status"], "checks_passed");

    fs::write(
        run.join("candidate/crates/example/src/answer.rs"),
        "pub fn answer() -> i32 { 43 }\n",
    )
    .unwrap();
    let source_drift = verification(&fixture.freeze(&run));
    assert_eq!(source_drift["baseline"]["status"], "failed");
    assert_eq!(source_drift["candidate"]["status"], "stale_or_invalid");

    fixture.change(&run);
    fs::write(
        run.join("probe.sh"),
        "set -eu\ngrep -q '42' crates/example/src/answer.rs\n# drift\n",
    )
    .unwrap();
    let probe_drift = verification(&fixture.freeze(&run));
    assert_eq!(probe_drift["baseline"]["status"], "stale_or_invalid");
    assert_eq!(probe_drift["candidate"]["status"], "stale_or_invalid");
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "Requires a Linux host with bubblewrap namespaces; run explicitly for acceptance"]
fn timeout_terminates_marked_descendants() {
    let fixture = Fixture::new();
    let marker = format!("jeikcode-repair-timeout-{}", uuid::Uuid::new_v4());
    let start_marker = format!("descendant-started-{}", uuid::Uuid::new_v4());
    let probe = format!(
        "set -eu\n/bin/sh -c 'printf \"%s\\n\" \"$1\"; while :; do sleep 1; done' '{marker}' '{start_marker}' &\nwait\n"
    );
    let (run, state) = prepare_with_probe(&fixture, &probe);

    let receipt = execute_required(&run, &state, "candidate", 1);
    assert_eq!(receipt.status, "timeout");
    let stdout = fs::read_to_string(run.join("candidate-stdout.txt")).unwrap();
    assert!(
        stdout.lines().any(|line| line == start_marker),
        "timed-out probe never proved that its marked descendant started"
    );

    let deadline = Instant::now() + Duration::from_secs(1);
    while host_process_contains(&marker) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !host_process_contains(&marker),
        "sandbox timeout left a marked descendant running"
    );
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "Requires a Linux host with bubblewrap namespaces; run explicitly for acceptance"]
fn bounded_output_keeps_full_digest_and_truncates_private_preview() {
    const OUTPUT_BYTES: usize = 2 * 1024 * 1024;
    const PREVIEW_BYTES: u64 = 1024 * 1024;

    let fixture = Fixture::new();
    let probe = format!("set -eu\nhead -c {OUTPUT_BYTES} /dev/zero\n");
    let (run, state) = prepare_with_probe(&fixture, &probe);

    let receipt = execute_required(&run, &state, "candidate", 5);
    assert_eq!(receipt.status, "checks_passed");
    assert_eq!(receipt.exit_code, Some(0));
    assert!(receipt.output_truncated);
    assert_eq!(
        receipt.stdout_sha256,
        workspace::digest(&vec![0u8; OUTPUT_BYTES])
    );
    assert_eq!(
        fs::metadata(run.join("candidate-stdout.txt"))
            .unwrap()
            .len(),
        PREVIEW_BYTES
    );
}
