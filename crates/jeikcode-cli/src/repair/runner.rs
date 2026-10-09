use super::*;
use anyhow::ensure;
use std::fs;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub(super) fn execute(run: &Path, state: &State, phase: &str, timeout: u64) -> Result<Receipt> {
    ensure!(
        ["baseline", "candidate"].contains(&phase),
        "unknown verification phase"
    );
    ensure!(
        (1..=600).contains(&timeout),
        "timeout must be between 1 and 600 seconds"
    );
    let probe = state
        .probe
        .as_ref()
        .context("prepare a new run with --probe to capture an independent reproduction")?;
    ensure!(
        workspace::file_digest(&run.join("probe.sh"))? == probe.sha256,
        "captured reproduction changed; prepare a new run"
    );
    let candidate = workspace::candidate(run, state)?;
    let snapshot = if phase == "baseline" {
        workspace::baseline(state)?
    } else {
        candidate
    };
    let started_at_unix_ms = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
    let started = Instant::now();
    let mut receipt = Receipt {
        phase: phase.to_owned(), status: "blocked".into(), source_digest: snapshot.digest.clone(),
        probe_sha256: probe.sha256.clone(), argv: vec!["/bin/sh".into(), "/probe.sh".into()],
        cwd: "/work".into(), started_at_unix_ms, duration_ms: 0, exit_code: None,
        stdout_sha256: workspace::digest(&[]), stderr_sha256: workspace::digest(&[]),
        output_truncated: false, boundary: "unavailable".into(),
        detail: "No probe executed. Requires Linux bubblewrap with all requested namespaces; there is no unsandboxed fallback.".into(),
    };
    #[cfg(target_os = "linux")]
    {
        let temporary = tempfile::Builder::new().prefix("verify-").tempdir_in(run)?;
        let source = temporary.path().join("source");
        fs::create_dir(&source)?;
        for (path, bytes) in &snapshot.bytes {
            let dest = workspace::contained(&source, path)?;
            fs::create_dir_all(dest.parent().unwrap())?;
            workspace::write_new(&dest, bytes)?;
            use std::os::unix::fs::PermissionsExt;
            let executable = state.files.get(path).map(|e| e.executable).unwrap_or(false);
            fs::set_permissions(
                dest,
                fs::Permissions::from_mode(if executable { 0o755 } else { 0o644 }),
            )?;
        }
        let captured = fs::read(run.join("probe.sh"))?;
        ensure!(
            workspace::digest(&captured) == probe.sha256,
            "reproduction drifted before execution"
        );
        let captured_path = temporary.path().join("probe.sh");
        workspace::write_new(&captured_path, &captured)?;
        let bwrap = ["/usr/bin/bwrap", "/bin/bwrap"]
            .into_iter()
            .map(Path::new)
            .find(|p| p.is_file());
        if let Some(bwrap) = bwrap {
            // Check the exact namespace/mount policy before executing any input.
            let setup = bounded(sandbox(bwrap, &source, &captured_path, true), 10)?;
            if setup.code == Some(0) && !setup.timeout {
                let result = bounded(sandbox(bwrap, &source, &captured_path, false), timeout)?;
                receipt.boundary = "linux_bubblewrap".into();
                receipt.status = if result.timeout {
                    "timeout"
                } else if result.code == Some(0) {
                    "checks_passed"
                } else {
                    "failed"
                }
                .into();
                receipt.exit_code = result.code;
                receipt.stdout_sha256 = result.stdout.sha256;
                receipt.stderr_sha256 = result.stderr.sha256;
                receipt.output_truncated = result.stdout.truncated || result.stderr.truncated;
                receipt.detail = "Probe ran against a frozen, read-only source snapshot with private temporary storage, no host home/config, no network, and bounded process/output time. Exit success alone does not establish the reported bug is fixed.".into();
                workspace::replace_private(
                    &run.join(format!("{phase}-stdout.txt")),
                    &result.stdout.preview,
                )?;
                workspace::replace_private(
                    &run.join(format!("{phase}-stderr.txt")),
                    &result.stderr.preview,
                )?;
            } else {
                receipt.stderr_sha256 = setup.stderr.sha256;
                workspace::replace_private(
                    &run.join(format!("{phase}-sandbox-error.txt")),
                    &setup.stderr.preview,
                )?;
            }
        }
    }
    receipt.duration_ms = started.elapsed().as_millis();
    Ok(receipt)
}

#[cfg(target_os = "linux")]
fn sandbox(bwrap: &Path, source: &Path, probe: &Path, setup_only: bool) -> std::process::Command {
    let mut command = std::process::Command::new(bwrap);
    command.env_clear().args([
        "--die-with-parent",
        "--new-session",
        "--unshare-all",
        "--cap-drop",
        "ALL",
        "--clearenv",
    ]);
    // System tools and their libraries are the only host runtime surface. User
    // toolchains, package credentials, sockets, /etc and the original repo stay out.
    for path in ["/usr", "/bin", "/lib", "/lib64"] {
        if Path::new(path).exists() {
            command.args(["--ro-bind", path, path]);
        }
    }
    command
        .arg("--ro-bind")
        .arg(source)
        .arg("/work")
        .arg("--ro-bind")
        .arg(probe)
        .arg("/probe.sh")
        .args([
            "--tmpfs",
            "/tmp",
            "--dir",
            "/home/repair",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--setenv",
            "HOME",
            "/home/repair",
            "--setenv",
            "PATH",
            "/usr/bin:/bin",
            "--setenv",
            "LANG",
            "C.UTF-8",
            "--setenv",
            "TMPDIR",
            "/tmp",
            "--setenv",
            "CARGO_HOME",
            "/tmp/cargo",
            "--setenv",
            "CARGO_TARGET_DIR",
            "/tmp/target",
            "--setenv",
            "XDG_CONFIG_HOME",
            "/tmp/config",
            "--setenv",
            "XDG_CACHE_HOME",
            "/tmp/cache",
            "--chdir",
            "/work",
            "--",
        ]);
    if setup_only {
        command.arg("/bin/true");
    } else {
        command.args(["/bin/sh", "/probe.sh"]);
    }
    command
}

#[cfg(target_os = "linux")]
struct Captured {
    sha256: String,
    preview: Vec<u8>,
    truncated: bool,
}
#[cfg(target_os = "linux")]
struct ProcessResult {
    code: Option<i32>,
    timeout: bool,
    stdout: Captured,
    stderr: Captured,
}

#[cfg(target_os = "linux")]
fn capture(mut reader: impl std::io::Read) -> std::io::Result<Captured> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    let mut preview = Vec::new();
    let mut total = 0usize;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        total = total.saturating_add(count);
        let keep = count.min((1024 * 1024usize).saturating_sub(preview.len()));
        preview.extend_from_slice(&buffer[..keep]);
    }
    Ok(Captured {
        sha256: format!("{:x}", hasher.finalize()),
        preview,
        truncated: total > 1024 * 1024,
    })
}

#[cfg(target_os = "linux")]
fn bounded(mut command: std::process::Command, seconds: u64) -> Result<ProcessResult> {
    use std::io::{Read, Seek, SeekFrom};
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    use std::time::Duration;
    // Regular private files avoid waiting forever for pipe EOF when a process
    // broker or descendant retains a copied descriptor after the child exits.
    // RLIMIT_FSIZE bounds disk output; capture below bounds memory separately.
    let mut stdout = tempfile::tempfile()?;
    let mut stderr = tempfile::tempfile()?;
    command
        .stdin(Stdio::null())
        .stdout(stdout.try_clone()?)
        .stderr(stderr.try_clone()?)
        .process_group(0);
    // These per-process limits supplement the wall timeout, not a whole-machine
    // quota. A production build farm still needs its own CPU/memory/disk quotas.
    unsafe {
        command.pre_exec(move || {
            for (resource, value) in [
                (libc::RLIMIT_CORE, 0u64),
                (libc::RLIMIT_FSIZE, 16 * 1024 * 1024),
                (libc::RLIMIT_NOFILE, 256),
                (libc::RLIMIT_NPROC, 128),
                (libc::RLIMIT_AS, 4 * 1024 * 1024 * 1024),
                (libc::RLIMIT_CPU, seconds + 2),
            ] {
                let limit = libc::rlimit {
                    rlim_cur: value as libc::rlim_t,
                    rlim_max: value as libc::rlim_t,
                };
                if libc::setrlimit(resource, &limit) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .context("launch sandbox with resource limits")?;
    let start = Instant::now();
    let mut timeout = false;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if start.elapsed() >= Duration::from_secs(seconds) {
            timeout = true;
            // Kill the namespace supervisor/process group; the private PID
            // namespace and --die-with-parent also terminate descendants.
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            break child.wait()?;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    stdout.seek(SeekFrom::Start(0))?;
    stderr.seek(SeekFrom::Start(0))?;
    let stdout_length = stdout.metadata()?.len().min(16 * 1024 * 1024);
    let stderr_length = stderr.metadata()?.len().min(16 * 1024 * 1024);
    Ok(ProcessResult {
        code: status.code(),
        timeout,
        stdout: capture(stdout.take(stdout_length))?,
        stderr: capture(stderr.take(stderr_length))?,
    })
}
