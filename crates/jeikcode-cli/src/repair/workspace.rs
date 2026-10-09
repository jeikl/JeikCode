use super::git_objects::BlobBatch;
use super::*;
use anyhow::ensure;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::Component;
use std::process::Command;

pub(super) const MAX_SOURCE_BYTES: u64 = 256 * 1024 * 1024;

#[cfg(test)]
thread_local! {
    static GIT_COMMAND_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(super) fn git_command_count() -> usize {
    GIT_COMMAND_COUNT.with(std::cell::Cell::get)
}

pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn file_digest(path: &Path) -> Result<String> {
    no_links(path)?;
    ensure!(fs::metadata(path)?.is_file(), "expected a regular file");
    let mut file = fs::File::open(path)?;
    ensure!(file.metadata()?.is_file(), "expected a regular file");
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub(super) fn current_binary_digest() -> Option<String> {
    std::env::current_exe()
        .ok()
        .and_then(|p| file_digest(&p).ok())
}

/// Reject links, including Windows junctions/reparse points, before local I/O.
/// This protects against path mistakes; it is not a hostile same-user OS sandbox.
#[cfg(windows)]
fn nonlocal_windows_path(path: &Path) -> bool {
    use std::path::Prefix;

    matches!(
        path.components().next(),
        Some(Component::Prefix(prefix))
            if matches!(
                prefix.kind(),
                Prefix::UNC(_, _)
                    | Prefix::VerbatimUNC(_, _)
                    | Prefix::DeviceNS(_)
                    | Prefix::Verbatim(_)
            )
    )
}

pub(super) fn no_links(path: &Path) -> Result<()> {
    // On Windows a UNC path is absolute, but inspecting its metadata can
    // contact an SMB host. Reject network/device namespaces before any I/O.
    #[cfg(windows)]
    ensure!(
        !nonlocal_windows_path(path),
        "network-share and device paths are not supported for local repair"
    );
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        match fs::symlink_metadata(ancestor) {
            Ok(meta) => {
                ensure!(
                    !meta.file_type().is_symlink(),
                    "symbolic links are not supported: {}",
                    ancestor.display()
                );
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    ensure!(
                        meta.file_attributes() & 0x400 == 0,
                        "reparse points are not supported"
                    );
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

#[cfg(all(test, windows))]
#[test]
fn windows_network_device_prefixes_are_rejected_without_filesystem_access() {
    for path in [
        r"\\server.invalid\share\repair",
        r"\\?\UNC\server.invalid\share\repair",
        r"\\.\pipe\repair",
        r"\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1\repair",
    ] {
        assert!(
            nonlocal_windows_path(Path::new(path)),
            "path must be rejected before metadata access: {path}"
        );
        assert!(
            no_links(Path::new(path)).is_err(),
            "no_links must reject nonlocal paths without probing them: {path}"
        );
    }
    for path in [r"C:\Work\JeikCode", r"\\?\C:\Work\JeikCode"] {
        assert!(!nonlocal_windows_path(Path::new(path)));
    }
}

pub(super) fn relative(path: &str) -> Result<()> {
    ensure!(
        !path.is_empty() && !path.contains(['\\', ':', '\n', '\r', '\t', '\0']),
        "unsupported relative path"
    );
    for component in Path::new(path).components() {
        match component {
            Component::Normal(part) => {
                let part = part.to_string_lossy();
                ensure!(
                    !part.eq_ignore_ascii_case(".git") && !part.ends_with(['.', ' ']),
                    "protected or ambiguous path component"
                );
            }
            _ => bail!("path must be relative without dot or parent components"),
        }
    }
    ensure!(
        !path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == ".."),
        "path must be normalized"
    );
    Ok(())
}

pub(super) fn validate_allowed(path: &str) -> Result<()> {
    relative(path)?;
    ensure!(
        !path.split('/').any(|part| part.starts_with('.')),
        "hidden configuration and instruction directories are not repair scope"
    );
    // These are the repair boundary and recovery/authentication owners. Changing
    // them requires an ordinary maintainer-reviewed development task.
    let lower = path.to_ascii_lowercase();
    let protected = [
        ".git",
        ".jeikcode",
        ".claude",
        ".agents",
        ".github",
        "crates/jeikcode-updater",
        "crates/jeikcode-auth",
        "crates/jeikcode-cli/src/repair",
        "crates/jeikcode-cli/src/build_info.rs",
        "crates/jeikcode-cli/build.rs",
        "crates/jeikcode-capabilities/src/skills",
        "crates/jeikcode-kernel/src/policy",
        "crates/jeikcode-coding/src/execution_policy.rs",
        "crates/jeikcode-coding/src/plan_mode.rs",
        "crates/jeikcode-coding/src/parts.rs",
        "crates/jeikcode-capabilities/src/tools/write_approval.rs",
        "crates/jeikcode-capabilities/src/tools/bash_workspace_gate.rs",
        "crates/jeikcode-capabilities/src/tools/approval.rs",
        "crates/jeikcode-capabilities/src/tools/sensitive_path.rs",
    ];
    ensure!(
        !protected
            .iter()
            .any(|p| lower == *p || lower.starts_with(&format!("{p}/"))),
        "path belongs to repair, policy, authentication, or recovery infrastructure"
    );
    ensure!(
        lower.starts_with("crates/")
            || lower.starts_with("webui/")
            || lower.starts_with("docs/")
            || lower.starts_with("extensions/"),
        "repair scope must be an exact product source or documentation file"
    );
    let file = Path::new(&lower).file_name().unwrap().to_string_lossy();
    ensure!(
        !file.starts_with('.')
            && ![".pem", ".key", ".p12", ".pfx", ".env"]
                .iter()
                .any(|s| file.ends_with(s)),
        "private configuration is not repair input"
    );
    ensure!(
        ![
            "agents.md",
            "claude.md",
            "skill.md",
            "cargo.toml",
            "cargo.lock",
            "package.json",
            "package-lock.json",
            "build.rs"
        ]
        .contains(&file.as_ref()),
        "build or instruction policy changes require a separate reviewed task"
    );
    Ok(())
}

pub(super) fn contained(root: &Path, relative_path: &str) -> Result<PathBuf> {
    relative(relative_path)?;
    let path = root.join(relative_path);
    no_links(&path)?;
    if path.try_exists()? {
        ensure!(
            path.canonicalize()?.starts_with(root),
            "path escapes candidate"
        );
    }
    Ok(path)
}

/// Keep one exact spelling for every path component, including new scope paths.
/// This is a conservative portable policy, not a filesystem normalization oracle.
pub(super) fn validate_scope_spelling(
    files: &BTreeMap<String, FileIdentity>,
    allowed: &[String],
) -> Result<()> {
    let mut spellings = BTreeMap::<String, String>::new();
    for path in files.keys().chain(allowed.iter()) {
        relative(path)?;
        let mut prefix = String::new();
        for component in path.split('/') {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(component);
            let key = prefix.to_uppercase();
            if let Some(existing) = spellings.get(&key) {
                ensure!(
                    existing == &prefix,
                    "ambiguous case spelling: {prefix}; use {existing}"
                );
            } else {
                spellings.insert(key, prefix.clone());
            }
        }
    }
    Ok(())
}

pub(super) fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    no_links(path)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("create {} without overwriting", path.display()))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

pub(super) fn replace_private(path: &Path, bytes: &[u8]) -> Result<()> {
    no_links(path)?;
    let parent = path.parent().context("file has no parent")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

pub(super) fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    no_links(path)?;
    let meta = path.metadata()?;
    ensure!(
        meta.is_file() && meta.len() <= 16 * MAX_TEXT_BYTES,
        "invalid or oversized repair metadata"
    );
    serde_json::from_slice(&fs::read(path)?).context("parse repair metadata as data")
}

pub(super) struct Lock(PathBuf);
impl Lock {
    pub(super) fn acquire(root: &Path) -> Result<Self> {
        let path = root.join("operation.lock");
        write_new(&path, std::process::id().to_string().as_bytes())
            .context("repair run is locked; after a crash, inspect the run before removing its stale operation.lock")?;
        Ok(Self(path))
    }
}
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub(super) fn run_root(path: &Path) -> Result<PathBuf> {
    no_links(path)?;
    let root = path.canonicalize()?;
    ensure!(root.is_dir(), "repair run must be a directory");
    Ok(root)
}

pub(super) fn git_command(root: &Path) -> Command {
    #[cfg(test)]
    GIT_COMMAND_COUNT.with(|count| count.set(count.get() + 1));
    let mut cmd = Command::new("git");
    cmd.current_dir(root).env_clear();
    // Never inherit Git injection variables, global helpers, hooks or fsmonitor.
    for key in ["PATH", "SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(key) {
            cmd.env(key, value);
        }
    }
    cmd.env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .args([
            "--no-replace-objects",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.pager=cat",
        ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let output = git_command(root)
        .args(args)
        .output()
        .context("run installed Git")?;
    ensure!(
        output.status.success(),
        "Git operation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    ensure!(
        output.stdout.len() as u64 <= MAX_SOURCE_BYTES,
        "Git output is too large"
    );
    Ok(output.stdout)
}

fn git_text(root: &Path, args: &[&str]) -> Result<String> {
    Ok(String::from_utf8(git(root, args)?)?.trim().to_owned())
}

#[cfg(test)]
pub(super) fn test_blob(root: &Path, sha: &str, budget: u64) -> Result<Vec<u8>> {
    ensure_complete_clone(root)?;
    let mut batch = BlobBatch::new(root)?;
    let bytes = batch.read(sha, budget)?;
    batch.finish()?;
    Ok(bytes)
}

pub(super) fn inspect_source(
    path: &Path,
) -> Result<(
    PathBuf,
    SourceIdentity,
    BTreeMap<String, FileIdentity>,
    String,
)> {
    no_links(path)?;
    let root = path.canonicalize()?;
    ensure_complete_clone(&root)?;
    ensure!(
        Path::new(&git_text(&root, &["rev-parse", "--show-toplevel"])?).canonicalize()? == root,
        "--source must name the repository root"
    );
    let commit = git_text(&root, &["rev-parse", "--verify", "HEAD^{commit}"])?;
    inspect_commit(root, commit)
}

fn ensure_complete_clone(root: &Path) -> Result<()> {
    // Reject partial clones before asking Git for any object. The environment
    // guard above is defense in depth; older Git may not recognize it. Include
    // repo includes and worktree config; global/system scopes remain disabled.
    let config = git(root, &["config", "--null", "--list", "--includes"])?;
    for entry in config.split(|b| *b == 0) {
        let key = entry.split(|b| *b == b'\n').next().unwrap_or_default();
        let key = String::from_utf8_lossy(key).to_ascii_lowercase();
        ensure!(key != "extensions.partialclone" && !key.ends_with(".promisor") && !key.ends_with(".partialclonefilter"), "partial/promisor clones are not supported for offline repair; use a complete local clone");
    }
    Ok(())
}

fn inspect_commit(
    root: PathBuf,
    commit: String,
) -> Result<(
    PathBuf,
    SourceIdentity,
    BTreeMap<String, FileIdentity>,
    String,
)> {
    let tree = git_text(
        &root,
        &["rev-parse", "--verify", &format!("{commit}^{{tree}}")],
    )?;
    ensure!(
        commit.len() == 40 && tree.len() == 40,
        "unsupported source object format"
    );
    let manifest = git(&root, &["show", &format!("{commit}:Cargo.toml")])?;
    let manifest: toml::Value = toml::from_str(std::str::from_utf8(&manifest)?)?;
    ensure!(
        manifest
            .get("workspace")
            .and_then(|v| v.get("package"))
            .and_then(|v| v.get("repository"))
            .and_then(toml::Value::as_str)
            == Some(REPOSITORY),
        "source is not the JeikCode product workspace"
    );
    let raw = git(&root, &["ls-tree", "-rz", &commit])?;
    let mut batch = BlobBatch::new(&root)?;
    let mut files = BTreeMap::new();
    let mut total = 0u64;
    for record in raw.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        let record = std::str::from_utf8(record)?;
        let (metadata, path) = record.split_once('\t').context("invalid Git tree entry")?;
        relative(path)?;
        let fields: Vec<_> = metadata.split_whitespace().collect();
        ensure!(
            fields.len() == 3 && fields[1] == "blob" && ["100644", "100755"].contains(&fields[0]),
            "source symlinks and submodules are not supported by repair"
        );
        ensure!(files.len() < 20_000, "source exceeds repair file limit");
        let bytes = batch.read(fields[2], MAX_SOURCE_BYTES - total)?;
        total += bytes.len() as u64;
        ensure!(
            total <= MAX_SOURCE_BYTES && files.len() < 20_000,
            "source exceeds repair snapshot limit"
        );
        files.insert(
            path.to_owned(),
            FileIdentity {
                blob: fields[2].to_owned(),
                sha256: digest(&bytes),
                executable: fields[0] == "100755",
            },
        );
    }
    batch.finish()?;
    ensure!(
        files.contains_key("crates/jeikcode-cli/src/main.rs"),
        "missing JeikCode CLI source"
    );
    let (checkout_digest, dirty) = checkout_state(&root, &files, &commit)?;
    ensure!(
        git_text(&root, &["rev-parse", "HEAD"])? == commit,
        "source HEAD moved during inspection; retry on a stable checkout"
    );
    Ok((
        root,
        SourceIdentity {
            repository: REPOSITORY.to_owned(),
            commit,
            tree,
            dirty,
        },
        files,
        checkout_digest,
    ))
}

fn checkout_state(
    root: &Path,
    files: &BTreeMap<String, FileIdentity>,
    commit: &str,
) -> Result<(String, bool)> {
    let index = git(root, &["ls-files", "--stage", "-z"])?;
    let untracked = git(root, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    let mut state = BTreeMap::new();
    let mut dirty = !untracked.is_empty();
    for (path, expected) in files {
        let path_on_disk = contained(root, path)?;
        let actual = if path_on_disk.try_exists()? {
            file_digest(&path_on_disk)?
        } else {
            "missing".into()
        };
        let executable = file_executable(&path_on_disk)?;
        dirty |= actual != expected.sha256
            || executable.is_some_and(|value| value != expected.executable);
        state.insert(path.clone(), (actual, executable));
    }
    // Staged-only changes also make the checkout dirty, without invoking filters.
    let staged = git(root, &["diff-index", "--cached", "--raw", commit, "--"])?;
    dirty |= !staged.is_empty();
    let value = serde_json::to_vec(&(state, digest(&index), digest(&untracked)))?;
    Ok((digest(&value), dirty))
}

fn file_executable(path: &Path) -> Result<Option<bool>> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return match fs::metadata(path) {
            Ok(meta) => Ok(Some(meta.permissions().mode() & 0o111 != 0)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        };
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(None)
    }
}

pub(super) fn prepare(
    source: &Path,
    output: &Path,
    mut allowed: Vec<String>,
    probe: Option<&Path>,
) -> Result<PathBuf> {
    ensure!(
        !allowed.is_empty(),
        "at least one exact --allow path is required"
    );
    for path in &allowed {
        validate_allowed(path)?;
    }
    allowed.sort();
    allowed.dedup();
    let (root, identity, files, original_checkout_digest) = inspect_source(source)?;
    validate_scope_spelling(&files, &allowed)?;
    no_links(output)?;
    let parent = output
        .parent()
        .context("run directory needs a parent")?
        .canonicalize()?;
    ensure!(
        !parent.starts_with(&root),
        "place the repair run outside the source checkout"
    );
    let output = parent.join(output.file_name().context("run directory needs a name")?);
    fs::create_dir(&output).context("run directory must not already exist")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&output, fs::Permissions::from_mode(0o700))?;
    }
    let _lock = Lock::acquire(&output)?;
    let captured_probe = match probe {
        Some(path) => {
            let body = read_note(path)?;
            ensure!(
                body.len() <= 64 * 1024 && !body.is_empty(),
                "probe must be a nonempty shell reproduction of at most 64 KiB"
            );
            write_new(&output.join("probe.sh"), body.as_bytes())?;
            Some(Probe {
                sha256: digest(body.as_bytes()),
            })
        }
        None => None,
    };
    let candidate = output.join("candidate");
    let candidate_arg = candidate
        .to_str()
        .context("Git worktree paths must be UTF-8")?;
    // Keep canonical native paths for containment and state, but do not pass
    // Windows verbatim prefixes to Git's pathname parser.
    #[cfg(windows)]
    let git_candidate = jeikcode_capabilities::pathnorm::strip_verbatim(candidate_arg);
    #[cfg(windows)]
    let candidate_arg = git_candidate.as_ref();
    git(
        &root,
        &[
            "worktree",
            "add",
            "--detach",
            "--no-checkout",
            candidate_arg,
            &identity.commit,
        ],
    )?;
    // Materialize raw blobs, never `checkout`: repository smudge filters and
    // checkout hooks must not execute while preparing a community repair.
    ensure_complete_clone(&root)?;
    let mut batch = BlobBatch::new(&root)?;
    for (path, entry) in &files {
        let dest = contained(&candidate, path)?;
        fs::create_dir_all(dest.parent().unwrap())?;
        let bytes = batch.read(&entry.blob, MAX_SOURCE_BYTES)?;
        ensure!(
            digest(&bytes) == entry.sha256,
            "source blob drifted during preparation"
        );
        write_new(&dest, &bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                dest,
                fs::Permissions::from_mode(if entry.executable { 0o755 } else { 0o644 }),
            )?;
        }
    }
    batch.finish()?;
    git(&candidate, &["read-tree", &identity.commit])?;
    ensure!(
        git_text(&root, &["rev-parse", "HEAD"])? == identity.commit
            && checkout_state(&root, &files, &identity.commit)?.0 == original_checkout_digest,
        "source changed during preparation; preserve this run for inspection and prepare a new one"
    );
    let state = State {
        schema_version: SCHEMA_VERSION,
        run_id: uuid::Uuid::new_v4().to_string(),
        source_root: root,
        source: identity,
        original_checkout_digest,
        files,
        allowed_paths: allowed,
        observer: BuildInfo::current(),
        observer_binary_sha256: current_binary_digest(),
        probe: captured_probe,
    };
    write_new(
        &output.join("state.json"),
        &serde_json::to_vec_pretty(&state)?,
    )?;
    Ok(output)
}

#[derive(Debug)]
pub(super) struct Snapshot {
    pub(super) bytes: BTreeMap<String, Vec<u8>>,
    pub(super) digest: String,
    pub(super) changed: Vec<String>,
}

fn snapshot(bytes: BTreeMap<String, Vec<u8>>, changed: Vec<String>) -> Result<Snapshot> {
    let hashes: BTreeMap<_, _> = bytes.iter().map(|(p, b)| (p.clone(), digest(b))).collect();
    Ok(Snapshot {
        digest: digest(&serde_json::to_vec(&hashes)?),
        bytes,
        changed,
    })
}

pub(super) fn baseline(state: &State) -> Result<Snapshot> {
    ensure_complete_clone(&state.source_root)?;
    let mut bytes = BTreeMap::new();
    let mut batch = BlobBatch::new(&state.source_root)?;
    for (path, entry) in &state.files {
        relative(path)?;
        let content = batch.read(&entry.blob, MAX_SOURCE_BYTES)?;
        ensure!(
            digest(&content) == entry.sha256,
            "baseline blob digest mismatch"
        );
        bytes.insert(path.clone(), content);
    }
    batch.finish()?;
    snapshot(bytes, vec![])
}

pub(super) fn candidate(run: &Path, state: &State) -> Result<Snapshot> {
    ensure_complete_clone(&state.source_root)?;
    ensure!(
        git_text(&state.source_root, &["rev-parse", "HEAD"])? == state.source.commit,
        "original source HEAD changed; prepare a new run"
    );
    ensure!(
        checkout_state(&state.source_root, &state.files, &state.source.commit)?.0
            == state.original_checkout_digest,
        "original checkout drifted; preserve it and prepare a new run"
    );
    no_links(&run.join("candidate"))?;
    let root = run.join("candidate").canonicalize()?;
    ensure!(
        root.parent() == Some(run),
        "candidate is outside the repair run"
    );
    no_links(&root)?;
    ensure_complete_clone(&root)?;
    ensure!(
        git_text(&root, &["rev-parse", "HEAD"])? == state.source.commit,
        "candidate HEAD changed"
    );
    let mut bytes = BTreeMap::new();
    let mut changed = vec![];
    let mut paths: Vec<_> = state
        .files
        .keys()
        .cloned()
        .chain(state.allowed_paths.iter().cloned())
        .collect();
    paths.sort();
    paths.dedup();
    let mut total = 0u64;
    for path in paths {
        let file = contained(&root, &path)?;
        let expected = state.files.get(&path);
        if !file.try_exists()? {
            if expected.is_some() {
                ensure!(
                    state.allowed_paths.contains(&path),
                    "out-of-scope deletion: {path}"
                );
                changed.push(path);
            }
            continue;
        }
        let meta = file.metadata()?;
        ensure!(
            meta.is_file() && meta.len() <= MAX_SOURCE_BYTES,
            "candidate contains an invalid file"
        );
        let content = fs::read(file)?;
        ensure!(
            !file_executable(&root.join(&path))?
                .is_some_and(|value| value != expected.is_some_and(|v| v.executable)),
            "candidate executable mode changed; source repair does not support mode changes"
        );
        total += content.len() as u64;
        ensure!(
            total <= MAX_SOURCE_BYTES,
            "candidate snapshot exceeds size limit"
        );
        if expected.map(|v| v.sha256.as_str()) != Some(digest(&content).as_str()) {
            ensure!(
                state.allowed_paths.contains(&path),
                "out-of-scope change: {path}"
            );
            ensure!(
                content.len() as u64 <= MAX_TEXT_BYTES && std::str::from_utf8(&content).is_ok(),
                "repair patches support UTF-8 text up to 2 MiB only"
            );
            changed.push(path.clone());
        }
        bytes.insert(path, content);
    }
    // Unknown files never enter the snapshot or the exported diff. They cannot
    // affect the probe: the runner only mounts the bytes above, not this worktree.
    snapshot(bytes, changed)
}
