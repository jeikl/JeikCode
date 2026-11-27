//! Hidden `jeikcode self ...` commands used by the desktop shell.
//!
//! The desktop shell never edits `~/.local/bin` or shell rc files itself. It
//! delegates here so ownership proof (marker + sha256), atomic replacement,
//! backups and PATH block editing stay in one place.
//!
//! Ownership rules:
//! - The desktop engine always runs the CLI bundled with the app; this module
//!   only manages the *terminal* copy.
//! - A target is "owned" only when `~/.jeikcode/cli-install.json` points at it
//!   and its sha256 still matches. Anything else is user/installer/package
//!   manager owned and is never overwritten without `--replace`.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(unix)]
const RC_COMMENT: &str = "# Added by JeikCode installer";
const MARKER_FILE: &str = "cli-install.json";
const DESKTOP_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliInstallMarker {
    pub installer: String,
    pub path: String,
    pub version: String,
    pub sha256: String,
    pub installed_at: String,
    pub rc_files: Vec<String>,
    pub prefix: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CliEntry {
    pub path: String,
    pub version: Option<String>,
    pub source: String,
    pub owned: bool,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CliStatus {
    pub platform: String,
    pub state: String,
    pub desktop_cli: CliEntry,
    pub target_path: String,
    pub target: Option<CliEntry>,
    pub active: Option<CliEntry>,
    pub active_is_target: bool,
    pub active_on_path: bool,
    pub entries: Vec<CliEntry>,
    pub path_has_target: bool,
    pub shell: String,
    pub rc_files: Vec<String>,
    pub writable: bool,
    pub managed_by_installer: bool,
    pub marker: Option<CliInstallMarker>,
    pub can_install: bool,
    pub can_update: bool,
    pub can_replace: bool,
    pub can_switch: bool,
    pub can_repair_path: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallResult {
    pub success: bool,
    pub path: String,
    pub version: String,
    pub backed_up: Option<String>,
    pub rc_files: Vec<String>,
    pub path_added: bool,
    pub path_already_present: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UninstallResult {
    pub success: bool,
    pub removed_path: Option<String>,
    pub rc_files: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct InstallOptions {
    pub replace: bool,
    pub ensure_path: bool,
    pub path_only: bool,
    pub verify_version: bool,
}

impl Default for InstallOptions {
    fn default() -> Self {
        Self {
            replace: false,
            ensure_path: true,
            path_only: false,
            verify_version: true,
        }
    }
}

/// Entry point called at the very top of `main()`. Returns `Some(exit_code)`
/// only for `jeikcode self ...`; every other invocation falls through to the
/// normal CLI startup.
pub fn try_run() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    let first = args.next()?;
    if first.to_str() != Some("self") {
        return None;
    }
    let rest: Vec<String> = args.map(|a| a.to_string_lossy().into_owned()).collect();
    Some(run(&rest))
}

fn run(args: &[String]) -> i32 {
    let mut sub: Option<String> = None;
    let mut json = false;
    let mut opts = InstallOptions::default();
    let mut from: Option<PathBuf> = None;
    let mut home_override: Option<PathBuf> = None;

    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        match arg {
            "status" | "install-cli" | "uninstall-cli" => sub = Some(arg.to_string()),
            "--json" => json = true,
            "--replace" => opts.replace = true,
            "--ensure-path" => opts.ensure_path = true,
            "--no-ensure-path" => opts.ensure_path = false,
            "--path-only" => opts.path_only = true,
            "--no-verify" => opts.verify_version = false,
            "--from" => {
                i += 1;
                from = args.get(i).map(PathBuf::from);
            }
            "--home" => {
                i += 1;
                home_override = args.get(i).map(PathBuf::from);
            }
            other if other.starts_with("--from=") => {
                from = Some(PathBuf::from(&other["--from=".len()..]));
            }
            other if other.starts_with("--home=") => {
                home_override = Some(PathBuf::from(&other["--home=".len()..]));
            }
            other => {
                eprintln!("unknown argument: {other}");
                return 2;
            }
        }
        i += 1;
    }

    let Some(sub) = sub else {
        eprintln!("usage: jeikcode self <status|install-cli|uninstall-cli> [--json]");
        return 2;
    };

    let Some(home) = home_override.or_else(dirs::home_dir) else {
        eprintln!("cannot resolve home directory");
        return 1;
    };
    let config_dir = jeikcode_config::config::Config::config_dir();
    let source = from
        .or_else(|| std::env::current_exe().ok())
        .unwrap_or_default();

    match sub.as_str() {
        "status" => {
            let status = status_for(&home, &config_dir, &source);
            if json {
                println!("{}", serde_json::to_string(&status).unwrap_or_default());
            } else {
                print_status_human(&status);
            }
            0
        }
        "install-cli" => {
            let result = install_for(&home, &config_dir, &source, opts);
            if json {
                println!("{}", serde_json::to_string(&result).unwrap_or_default());
            } else {
                print_install_human(&result);
            }
            if result.success {
                0
            } else {
                1
            }
        }
        "uninstall-cli" => {
            let result = uninstall_for(&home, &config_dir);
            if json {
                println!("{}", serde_json::to_string(&result).unwrap_or_default());
            } else {
                print_uninstall_human(&result);
            }
            if result.success {
                0
            } else {
                1
            }
        }
        _ => 2,
    }
}

#[derive(Default)]
struct StateInput<'a> {
    target_owned: bool,
    target_exists: bool,
    path_has_target: bool,
    active_is_target: bool,
    active_is_desktop: bool,
    active: Option<&'a CliEntry>,
    active_on_path: bool,
    active_newer_than_desktop: bool,
    desktop_newer_than_target: bool,
}

fn classify_state(input: &StateInput<'_>) -> &'static str {
    if input.target_owned {
        if !input.path_has_target {
            "path_missing"
        } else if input.active_is_target {
            if input.desktop_newer_than_target {
                "owned_outdated"
            } else {
                "owned_current"
            }
        } else {
            "owned_current"
        }
    } else if input.active_is_target {
        if !input.active_on_path {
            "path_missing"
        } else if input.active_newer_than_desktop {
            "external_newer"
        } else {
            "external"
        }
    } else if input.active_is_desktop {
        "owned_current"
    } else if let Some(active) = input.active {
        if active.source == "package_manager" {
            "package_managed"
        } else if input.active_newer_than_desktop {
            "external_newer"
        } else {
            "external"
        }
    } else if input.target_exists {
        "path_missing"
    } else {
        "not_installed"
    }
}

pub fn status_for(home: &Path, config_dir: &Path, desktop_cli: &Path) -> CliStatus {
    let platform = std::env::consts::OS.to_string();
    let target = target_path(home);
    let marker = read_marker(config_dir);
    let desktop_version = probe_version(desktop_cli).unwrap_or_else(|| DESKTOP_VERSION.to_string());
    let desktop_entry = CliEntry {
        path: desktop_cli.display().to_string(),
        version: Some(desktop_version.clone()),
        source: "desktop".to_string(),
        owned: true,
        active: false,
    };

    let target_exists = fs::symlink_metadata(&target).is_ok();
    let target_hash = target_exists
        .then(|| file_sha256_hex(&target).ok())
        .flatten();
    let target_owned = marker.as_ref().is_some_and(|m| {
        same_path(&target, Path::new(&m.path)) && target_hash.as_deref() == Some(m.sha256.as_str())
    });
    let target_version = target_exists.then(|| probe_version(&target)).flatten();
    let target_entry = target_exists.then(|| CliEntry {
        path: target.display().to_string(),
        version: target_version.clone(),
        source: if target_owned {
            "desktop".to_string()
        } else {
            source_for(home, &target)
        },
        owned: target_owned,
        active: false,
    });

    let entries = collect_path_entries(home, desktop_cli, &target, target_owned);
    let active = entries.first().cloned();
    let active_is_target = active
        .as_ref()
        .is_some_and(|a| same_path(Path::new(&a.path), &target));
    let active_is_desktop = active
        .as_ref()
        .is_some_and(|a| same_path(Path::new(&a.path), desktop_cli));
    let managed_by_installer = cfg!(windows);

    let shell = detect_shell();
    let rc_files: Vec<String> = if managed_by_installer {
        marker
            .as_ref()
            .map(|m| m.rc_files.clone())
            .unwrap_or_default()
    } else {
        marker
            .as_ref()
            .map(|m| m.rc_files.clone())
            .unwrap_or_else(|| vec![rc_file_for_shell(home, &shell).display().to_string()])
    };
    let proc_path_has_target = path_contains_dir(std::env::var_os("PATH"), target.parent());
    let path_has_target = proc_path_has_target
        || (!managed_by_installer
            && target
                .parent()
                .is_some_and(|dir| rc_contains_path_block(&rc_files, dir, &shell)));
    let active_on_path = active.as_ref().is_some_and(|a| {
        let path = Path::new(&a.path);
        if same_path(path, &target) {
            path_has_target
        } else if managed_by_installer {
            true
        } else {
            a.source == "package_manager"
                || a.source == "system"
                || path
                    .parent()
                    .is_some_and(|dir| path_contains_dir(std::env::var_os("PATH"), Some(dir)))
        }
    });
    let writable = target.parent().is_some_and(is_dir_writable);

    let active_version = active.as_ref().and_then(|a| a.version.clone());
    let desktop_newer_than_target = target_version.as_deref().map_or(true, |v| {
        jeikcode_updater::version_is_newer(&desktop_version, v)
    });
    let active_newer_than_desktop = active_version
        .as_deref()
        .is_some_and(|v| jeikcode_updater::version_is_newer(v, &desktop_version));

    let state = classify_state(&StateInput {
        target_owned,
        target_exists,
        path_has_target,
        active_is_target,
        active_is_desktop,
        active: active.as_ref(),
        active_on_path,
        active_newer_than_desktop,
        desktop_newer_than_target,
    });

    let can_update = !managed_by_installer
        && target_owned
        && active_is_target
        && path_has_target
        && desktop_newer_than_target;
    let can_replace =
        !managed_by_installer && active_is_target && !target_owned && active_on_path && writable;
    let can_install = !managed_by_installer && !target_exists && active.is_none() && writable;
    let can_switch = !managed_by_installer
        && !target_owned
        && !active_is_target
        && !active_is_desktop
        && writable
        && (active.is_some() || target_exists);
    let can_repair_path = !managed_by_installer && target_exists && !path_has_target && writable;

    CliStatus {
        platform,
        state: state.to_string(),
        desktop_cli: desktop_entry,
        target_path: target.display().to_string(),
        target: target_entry,
        active,
        active_is_target,
        active_on_path,
        entries,
        path_has_target,
        shell,
        rc_files,
        writable,
        managed_by_installer,
        marker,
        can_install,
        can_update,
        can_replace,
        can_switch,
        can_repair_path,
        error: None,
    }
}

pub fn install_for(
    home: &Path,
    config_dir: &Path,
    source: &Path,
    opts: InstallOptions,
) -> InstallResult {
    let target = target_path(home);
    let prefix = target.parent().unwrap_or(home).to_path_buf();
    let marker = read_marker(config_dir);
    let target_exists = fs::symlink_metadata(&target).is_ok();
    let target_hash = target_exists
        .then(|| file_sha256_hex(&target).ok())
        .flatten();
    let owned = marker.as_ref().is_some_and(|m| {
        same_path(&target, Path::new(&m.path)) && target_hash.as_deref() == Some(m.sha256.as_str())
    });

    if opts.path_only {
        if !target_exists {
            return install_err(&target, "target does not exist");
        }
        let shell = detect_shell();
        let (rcs, added, already) = match ensure_path_block(home, marker.as_ref(), &shell) {
            Ok(v) => v,
            Err(e) => return install_err(&target, format!("cannot update PATH: {e}")),
        };
        let version = probe_version(&target).unwrap_or_default();
        if let Some(mut m) = marker {
            if !rcs.is_empty() {
                m.rc_files = rcs.iter().map(|p| p.display().to_string()).collect();
                let _ = write_marker(config_dir, &m);
            }
        }
        return InstallResult {
            success: true,
            path: target.display().to_string(),
            version,
            backed_up: None,
            rc_files: rcs.iter().map(|p| p.display().to_string()).collect(),
            path_added: added,
            path_already_present: already,
            error: None,
        };
    }

    if target_exists && !owned && !opts.replace {
        return install_err(
            &target,
            "existing CLI is not managed by the desktop; pass --replace",
        );
    }
    if target_exists && owned && !opts.replace {
        return install_err(&target, "target exists; pass --replace to update");
    }

    if let Err(e) = fs::create_dir_all(&prefix) {
        return install_err(&target, format!("cannot create {}: {e}", prefix.display()));
    }

    let tmp = temp_path(&target);
    let _ = fs::remove_file(&tmp);
    if let Err(e) = fs::copy(source, &tmp) {
        return install_err(&target, format!("cannot copy {}: {e}", source.display()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755));
    }
    if opts.verify_version && probe_version(&tmp).is_none() {
        let _ = fs::remove_file(&tmp);
        return install_err(&target, "copied CLI failed --version check");
    }

    let mut backup: Option<PathBuf> = None;
    if target_exists {
        let b = backup_path(&target);
        if let Err(e) = fs::rename(&target, &b) {
            let _ = fs::remove_file(&tmp);
            return install_err(&target, format!("cannot back up existing CLI: {e}"));
        }
        backup = Some(b);
    }
    if let Err(e) = fs::rename(&tmp, &target) {
        if let Some(ref b) = backup {
            let _ = fs::rename(b, &target);
        }
        let _ = fs::remove_file(&tmp);
        return install_err(&target, format!("cannot install CLI: {e}"));
    }

    let installed_version = if opts.verify_version {
        probe_version(&target)
            .or_else(|| probe_version(source))
            .unwrap_or_else(|| DESKTOP_VERSION.to_string())
    } else {
        DESKTOP_VERSION.to_string()
    };
    let hash = match file_sha256_hex(&target) {
        Ok(h) => h,
        Err(e) => return install_err(&target, format!("cannot hash installed CLI: {e}")),
    };

    // Write ownership before touching PATH: if the shell rc update fails, the
    // binary is still provably ours and the UI can offer "Repair PATH".
    let mut new_marker = CliInstallMarker {
        installer: "desktop".to_string(),
        path: target.display().to_string(),
        version: installed_version.clone(),
        sha256: hash,
        installed_at: now_secs(),
        rc_files: marker
            .as_ref()
            .map(|m| m.rc_files.clone())
            .unwrap_or_default(),
        prefix: prefix.display().to_string(),
    };
    if let Err(e) = write_marker(config_dir, &new_marker) {
        return install_err(&target, format!("cannot write install marker: {e}"));
    }

    let shell = detect_shell();
    let (rcs, added, already) = if opts.ensure_path {
        match ensure_path_block(home, marker.as_ref(), &shell) {
            Ok(v) => v,
            Err(e) => return install_err(&target, format!("cannot update PATH: {e}")),
        }
    } else {
        (
            marker
                .as_ref()
                .map(|m| m.rc_files.iter().map(PathBuf::from).collect())
                .unwrap_or_default(),
            false,
            false,
        )
    };

    new_marker.rc_files = rcs.iter().map(|p| p.display().to_string()).collect();
    let _ = write_marker(config_dir, &new_marker);

    InstallResult {
        success: true,
        path: target.display().to_string(),
        version: installed_version,
        backed_up: backup.map(|p| p.display().to_string()),
        rc_files: rcs.iter().map(|p| p.display().to_string()).collect(),
        path_added: added,
        path_already_present: already,
        error: None,
    }
}

pub fn uninstall_for(_home: &Path, config_dir: &Path) -> UninstallResult {
    let Some(marker) = read_marker(config_dir) else {
        return UninstallResult {
            success: true,
            removed_path: None,
            rc_files: Vec::new(),
            error: None,
        };
    };
    let target = PathBuf::from(&marker.path);
    let target_exists = fs::symlink_metadata(&target).is_ok();
    if target_exists {
        match file_sha256_hex(&target) {
            Ok(hash) if hash == marker.sha256 => {
                if let Err(e) = fs::remove_file(&target) {
                    return UninstallResult {
                        success: false,
                        removed_path: None,
                        rc_files: Vec::new(),
                        error: Some(format!("cannot remove installed CLI: {e}")),
                    };
                }
            }
            Ok(_) => {
                return UninstallResult {
                    success: false,
                    removed_path: None,
                    rc_files: Vec::new(),
                    error: Some(
                        "installed CLI changed since it was managed; refusing to delete"
                            .to_string(),
                    ),
                };
            }
            Err(e) => {
                return UninstallResult {
                    success: false,
                    removed_path: None,
                    rc_files: Vec::new(),
                    error: Some(format!("cannot hash installed CLI: {e}")),
                };
            }
        }
    }

    let mut cleaned = Vec::new();
    for rc in &marker.rc_files {
        let p = PathBuf::from(rc);
        let Ok(content) = fs::read_to_string(&p) else {
            continue;
        };
        if let Some(next) =
            crate::uninstall::actions::strip_jeikcode_path_block(&content, &marker.prefix)
        {
            let _ = fs::copy(&p, rc_backup_path(&p));
            if fs::write(&p, next).is_ok() {
                cleaned.push(rc.clone());
            }
        }
    }
    let _ = fs::remove_file(marker_path(config_dir));

    UninstallResult {
        success: true,
        removed_path: target_exists.then(|| target.display().to_string()),
        rc_files: cleaned,
        error: None,
    }
}

fn ensure_path_block(
    home: &Path,
    marker: Option<&CliInstallMarker>,
    shell: &str,
) -> io::Result<(Vec<PathBuf>, bool, bool)> {
    #[cfg(windows)]
    {
        let _ = (home, marker, shell);
        return Ok((Vec::new(), false, false));
    }
    #[cfg(unix)]
    {
        let prefix = home.join(".local").join("bin");
        let rc = marker
            .and_then(|m| m.rc_files.first())
            .map(PathBuf::from)
            .unwrap_or_else(|| rc_file_for_shell(home, shell));
        if let Some(parent) = rc.parent() {
            fs::create_dir_all(parent)?;
        }
        let content = fs::read_to_string(&rc).unwrap_or_default();
        let line = path_block_line(&prefix, shell);
        if content.lines().any(|l| l.trim() == line.trim()) {
            return Ok((vec![rc], false, true));
        }
        if rc.exists() {
            let _ = fs::copy(&rc, rc_install_backup_path(&rc));
        }
        let mut next = content;
        if !next.is_empty() && !next.ends_with('\n') {
            next.push('\n');
        }
        next.push('\n');
        next.push_str(RC_COMMENT);
        next.push('\n');
        next.push_str(&line);
        next.push('\n');
        fs::write(&rc, next)?;
        Ok((vec![rc], true, false))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (home, marker, shell);
        Ok((Vec::new(), false, false))
    }
}

#[cfg(any(unix, test))]
fn path_block_line(prefix: &Path, shell: &str) -> String {
    let prefix = prefix.display().to_string();
    if shell == "fish" {
        format!("fish_add_path --prepend \"{prefix}\"")
    } else {
        format!("export PATH=\"{prefix}:$PATH\"")
    }
}

fn collect_path_entries(
    home: &Path,
    desktop_cli: &Path,
    target: &Path,
    target_owned: bool,
) -> Vec<CliEntry> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        if let Ok(iter) = which::which_all("jeikcode") {
            candidates.extend(iter);
        }
    } else {
        // The desktop app is often launched by Finder/launchd with a minimal
        // PATH that does not include the user's shell PATH. Search the standard
        // per-user and package-manager locations directly so the settings page
        // does not falsely report "not installed" for an existing CLI.
        candidates.push(home.join(".local").join("bin").join(cli_file_name()));
        if let Ok(iter) = which::which_all("jeikcode") {
            candidates.extend(iter);
        }
        #[cfg(target_os = "macos")]
        candidates.push(PathBuf::from("/opt/homebrew/bin/jeikcode"));
        #[cfg(target_os = "linux")]
        {
            candidates.push(home.join(".linuxbrew").join("bin").join("jeikcode"));
            candidates.push(PathBuf::from("/home/linuxbrew/.linuxbrew/bin/jeikcode"));
        }
        candidates.push(PathBuf::from("/usr/local/bin/jeikcode"));
        candidates.push(PathBuf::from("/usr/bin/jeikcode"));
        candidates.push(PathBuf::from("/bin/jeikcode"));
    }

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for path in candidates {
        if !path.is_file() {
            continue;
        }
        let key = canonical_or_normalized(&path);
        if !seen.insert(key) {
            continue;
        }
        let owned = target_owned && same_path(&path, target);
        let source = if same_path(&path, desktop_cli) || owned {
            "desktop".to_string()
        } else {
            source_for(home, &path)
        };
        out.push(CliEntry {
            path: path.display().to_string(),
            version: probe_version(&path),
            source,
            owned,
            active: false,
        });
    }
    for (i, entry) in out.iter_mut().enumerate() {
        entry.active = i == 0;
    }
    out
}

#[cfg(unix)]
fn rc_contains_path_block(rc_files: &[String], prefix: &Path, shell: &str) -> bool {
    let line = path_block_line(prefix, shell);
    rc_files.iter().any(|rc| {
        fs::read_to_string(rc)
            .ok()
            .is_some_and(|content| content.lines().any(|l| l.trim() == line.trim()))
    })
}

#[cfg(windows)]
fn rc_contains_path_block(_rc_files: &[String], _prefix: &Path, _shell: &str) -> bool {
    false
}

fn source_for(home: &Path, path: &Path) -> String {
    let p = canonical_or_normalized(path);
    let s = p.to_string_lossy().to_ascii_lowercase();
    if cfg!(windows) {
        if s.contains("\\jeikcode\\") || s.contains("\\programs\\jeikcode") {
            return "desktop".to_string();
        }
        if s.contains("\\.local\\bin\\") {
            return "user".to_string();
        }
        return "unknown".to_string();
    }
    let home_s = home.to_string_lossy().to_ascii_lowercase();
    if s.starts_with(&format!("{home_s}/.local/bin")) {
        return "user".to_string();
    }
    if s.contains("/cellar/") || s.contains("/homebrew/") || s.contains("/linuxbrew/") {
        return "package_manager".to_string();
    }
    if s.starts_with("/usr/bin") || s.starts_with("/usr/local/bin") || s.starts_with("/bin") {
        return "system".to_string();
    }
    "unknown".to_string()
}

fn detect_shell() -> String {
    #[cfg(windows)]
    {
        return "windows".to_string();
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_default();
        let base = Path::new(&shell)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        let shell = match base {
            "zsh" => "zsh",
            "bash" => "bash",
            "fish" => "fish",
            "sh" => "sh",
            _ if cfg!(target_os = "macos") => "zsh",
            _ => "sh",
        };
        shell.to_string()
    }
}

fn rc_file_for_shell(home: &Path, shell: &str) -> PathBuf {
    match shell {
        "zsh" => home.join(".zshrc"),
        "bash" => home.join(".bashrc"),
        "fish" => home.join(".config").join("fish").join("config.fish"),
        _ => home.join(".profile"),
    }
}

fn target_path(home: &Path) -> PathBuf {
    home.join(".local").join("bin").join(cli_file_name())
}

fn cli_file_name() -> &'static str {
    if cfg!(windows) {
        "jeikcode.exe"
    } else {
        "jeikcode"
    }
}

fn marker_path(config_dir: &Path) -> PathBuf {
    config_dir.join(MARKER_FILE)
}

fn read_marker(config_dir: &Path) -> Option<CliInstallMarker> {
    let bytes = fs::read(marker_path(config_dir)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_marker(config_dir: &Path, marker: &CliInstallMarker) -> io::Result<()> {
    fs::create_dir_all(config_dir)?;
    let bytes = serde_json::to_vec_pretty(marker)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(marker_path(config_dir), bytes)
}

fn path_contains_dir(path_var: Option<std::ffi::OsString>, dir: Option<&Path>) -> bool {
    let Some(dir) = dir else {
        return false;
    };
    let target = canonical_or_normalized(dir);
    let Some(path_var) = path_var else {
        return false;
    };
    std::env::split_paths(&path_var).any(|p| canonical_or_normalized(&p) == target)
}

fn canonical_or_normalized(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| {
        let mut out = PathBuf::new();
        for component in path.components() {
            out.push(component.as_os_str());
        }
        out
    })
}

fn same_path(a: &Path, b: &Path) -> bool {
    canonical_or_normalized(a) == canonical_or_normalized(b)
}

fn is_dir_writable(dir: &Path) -> bool {
    let mut candidate = dir;
    loop {
        if candidate.exists() {
            let probe = candidate.join(format!(
                ".jeikcode.probe.{}.{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            return match fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&probe)
            {
                Ok(_) => {
                    let _ = fs::remove_file(&probe);
                    true
                }
                Err(_) => false,
            };
        }
        match candidate.parent() {
            Some(parent) => candidate = parent,
            None => return false,
        }
    }
}

fn probe_version(path: &Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    let mut cmd = Command::new(path);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().ok()?;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let output = child.wait_with_output().ok()?;
    parse_version_output(&String::from_utf8_lossy(&output.stdout))
}

fn parse_version_output(raw: &str) -> Option<String> {
    for token in raw.split_whitespace() {
        let token = token
            .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.' && c != '-' && c != '+');
        let token = token.trim_start_matches('v');
        if token.chars().next().is_some_and(|c| c.is_ascii_digit()) && token.contains('.') {
            return Some(token.to_string());
        }
    }
    None
}

fn file_sha256_hex(path: &Path) -> io::Result<String> {
    let mut hasher = Sha256::new();
    let mut file = fs::File::open(path)?;
    io::copy(&mut file, &mut hasher)?;
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    use std::fmt::Write as _;
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    Ok(out)
}

fn now_secs() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default()
}

fn backup_path(target: &Path) -> PathBuf {
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("jeikcode");
    let stamp = now_secs();
    let mut n = 0u32;
    loop {
        let suffix = if n == 0 {
            format!("{file_name}.bak.{stamp}")
        } else {
            format!("{file_name}.bak.{stamp}.{n}")
        };
        let candidate = target.with_file_name(suffix);
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

fn temp_path(target: &Path) -> PathBuf {
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("jeikcode");
    let suffix = if cfg!(windows) { ".tmp.exe" } else { ".tmp" };
    target.with_file_name(format!(
        ".{file_name}.install.{}{suffix}",
        std::process::id()
    ))
}

#[cfg(unix)]
fn rc_install_backup_path(rc: &Path) -> PathBuf {
    let mut os = rc.as_os_str().to_os_string();
    os.push(".jeikcode-install.bak");
    PathBuf::from(os)
}

fn rc_backup_path(rc: &Path) -> PathBuf {
    let mut os = rc.as_os_str().to_os_string();
    os.push(".jeikcode-uninstall.bak");
    PathBuf::from(os)
}

fn install_err(target: &Path, message: impl Into<String>) -> InstallResult {
    InstallResult {
        success: false,
        path: target.display().to_string(),
        version: String::new(),
        backed_up: None,
        rc_files: Vec::new(),
        path_added: false,
        path_already_present: false,
        error: Some(message.into()),
    }
}

fn print_status_human(status: &CliStatus) {
    println!("state: {}", status.state);
    println!(
        "desktop: {} ({})",
        status.desktop_cli.version.as_deref().unwrap_or("unknown"),
        status.desktop_cli.path
    );
    println!(
        "target: {} (exists: {})",
        status.target_path,
        status.target.is_some()
    );
    if let Some(active) = &status.active {
        println!(
            "active: {} ({})",
            active.path,
            active.version.as_deref().unwrap_or("unknown")
        );
    }
    println!("path_has_target: {}", status.path_has_target);
    println!("shell: {} -> {:?}", status.shell, status.rc_files);
}

fn print_install_human(result: &InstallResult) {
    if result.success {
        println!("installed: {} ({})", result.path, result.version);
        if let Some(backup) = &result.backed_up {
            println!("backup: {backup}");
        }
        for rc in &result.rc_files {
            println!("path updated: {rc}");
        }
    } else if let Some(error) = &result.error {
        eprintln!("install failed: {error}");
    }
}

fn print_uninstall_human(result: &UninstallResult) {
    if result.success {
        if let Some(path) = &result.removed_path {
            println!("removed: {path}");
        } else {
            println!("nothing to remove");
        }
        for rc in &result.rc_files {
            println!("path cleaned: {rc}");
        }
    } else if let Some(error) = &result.error {
        eprintln!("uninstall failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_version_output() {
        assert_eq!(parse_version_output("jeikcode 7.5.4"), Some("7.5.4".into()));
        assert_eq!(parse_version_output("v7.5.4\n"), Some("7.5.4".into()));
        assert_eq!(
            parse_version_output("jeikcode 7.5.4-beta.1"),
            Some("7.5.4-beta.1".into())
        );
        assert_eq!(parse_version_output("no version here"), None);
    }

    #[test]
    fn path_block_lines_are_shell_specific() {
        assert_eq!(
            path_block_line(Path::new("/home/u/.local/bin"), "zsh"),
            "export PATH=\"/home/u/.local/bin:$PATH\""
        );
        assert_eq!(
            path_block_line(Path::new("/home/u/.local/bin"), "fish"),
            "fish_add_path --prepend \"/home/u/.local/bin\""
        );
    }

    #[cfg(unix)]
    #[test]
    fn ensure_path_block_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let (rcs, added, already) = ensure_path_block(home, None, "bash").unwrap();
        assert!(added);
        assert!(!already);
        let content = fs::read_to_string(&rcs[0]).unwrap();
        assert!(content.contains(RC_COMMENT));
        assert!(content.contains("export PATH="));
        let (_, added_again, already_again) = ensure_path_block(home, None, "bash").unwrap();
        assert!(!added_again);
        assert!(already_again);
    }

    #[test]
    fn state_machine_covers_ownership_and_path_boundaries() {
        let user = CliEntry {
            path: "/home/u/.local/bin/jeikcode".into(),
            version: Some("1.0.0".into()),
            source: "user".into(),
            owned: false,
            active: true,
        };
        let package = CliEntry {
            source: "package_manager".into(),
            ..user.clone()
        };

        assert_eq!(classify_state(&StateInput::default()), "not_installed");
        assert_eq!(
            classify_state(&StateInput {
                target_owned: true,
                target_exists: true,
                ..Default::default()
            }),
            "path_missing"
        );
        assert_eq!(
            classify_state(&StateInput {
                target_owned: true,
                target_exists: true,
                path_has_target: true,
                active_is_target: true,
                active: Some(&user),
                desktop_newer_than_target: true,
                ..Default::default()
            }),
            "owned_outdated"
        );
        assert_eq!(
            classify_state(&StateInput {
                target_owned: true,
                target_exists: true,
                path_has_target: true,
                active_is_target: true,
                active: Some(&user),
                ..Default::default()
            }),
            "owned_current"
        );
        assert_eq!(
            classify_state(&StateInput {
                target_exists: true,
                active_is_target: true,
                active_on_path: true,
                active: Some(&user),
                ..Default::default()
            }),
            "external"
        );
        assert_eq!(
            classify_state(&StateInput {
                target_exists: true,
                active_is_target: true,
                active_on_path: false,
                active: Some(&user),
                ..Default::default()
            }),
            "path_missing"
        );
        assert_eq!(
            classify_state(&StateInput {
                target_exists: true,
                active_is_target: true,
                active_on_path: true,
                active: Some(&user),
                active_newer_than_desktop: true,
                ..Default::default()
            }),
            "external_newer"
        );
        assert_eq!(
            classify_state(&StateInput {
                active: Some(&package),
                active_on_path: true,
                ..Default::default()
            }),
            "package_managed"
        );
        assert_eq!(
            classify_state(&StateInput {
                active_is_desktop: true,
                active: Some(&user),
                active_on_path: true,
                ..Default::default()
            }),
            "owned_current"
        );
        assert_eq!(
            classify_state(&StateInput {
                target_exists: true,
                ..Default::default()
            }),
            "path_missing"
        );
    }

    #[test]
    fn install_then_uninstall_removes_only_owned_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let config = tmp.path().join("config");
        fs::create_dir_all(&home).unwrap();
        let source = std::env::current_exe().unwrap();
        let opts = InstallOptions {
            replace: false,
            ensure_path: true,
            path_only: false,
            verify_version: false,
        };
        let result = install_for(&home, &config, &source, opts);
        assert!(result.success, "{:?}", result.error);
        let target = target_path(&home);
        assert!(target.is_file());
        assert!(read_marker(&config).is_some());

        let uninstall = uninstall_for(&home, &config);
        assert!(uninstall.success, "{:?}", uninstall.error);
        assert!(!target.exists());
        assert!(read_marker(&config).is_none());
    }

    #[test]
    fn uninstall_refuses_changed_target() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let config = tmp.path().join("config");
        fs::create_dir_all(&home).unwrap();
        let source = std::env::current_exe().unwrap();
        let opts = InstallOptions {
            replace: false,
            ensure_path: false,
            path_only: false,
            verify_version: false,
        };
        let result = install_for(&home, &config, &source, opts);
        assert!(result.success, "{:?}", result.error);
        let target = target_path(&home);
        fs::write(&target, b"changed").unwrap();
        let uninstall = uninstall_for(&home, &config);
        assert!(!uninstall.success);
        assert!(target.exists());
    }
}
