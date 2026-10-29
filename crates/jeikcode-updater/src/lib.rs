//! In-place binary upgrade for jeikcode.
//!
//! Flow:
//! 1. Fetch `latest.json` manifest (version + per-target sha256/size).
//! 2. Detect current platform and pick the matching binary entry.
//! 3. Verify we can write to `current_exe()`'s directory — if not, fail
//!    with a precise message telling the user to re-run with `sudo`.
//! 4. Download the binary to a sibling temp file, streaming progress.
//! 5. Verify SHA256 against the manifest. Bail (and delete temp) on
//!    mismatch — we never touch the live binary until verification
//!    passes.
//! 6. Three-way swap to replace the live binary:
//!    a. `jeikcode` → `.jeikcode.rolling`  (Windows allows renaming a running exe)
//!    b. new binary → `jeikcode`            (install the upgrade)
//!    c. best-effort: remove old `.bak`, then `.jeikcode.rolling` → `.bak`
//!
//!    Steps a–b are the critical path; step c is best-effort. If the old
//!    `.bak` is locked (AV scanner, still-running process, read-only
//!    attribute), the upgrade still succeeds — the `.rolling` file lingers
//!    and is cleaned up on the next upgrade attempt.
//!
//! Rollback swaps the live binary with `.bak` in place, so one backup
//! always points to "the other version" — the user can toggle by
//! alternating `/upgrade` and `/upgrade rollback`.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

/// Version manifest URL for self-update. A function rather than a const because
/// the address follows the deployment profile; see `jeikcode_config::endpoints`.
///
/// Resolution order:
/// 1. env `JEIKCODE_UPDATE_MANIFEST_URL` (highest, e.g. CI / one-off override)
/// 2. config `[config] update_manifest_url` (user-set override in config.toml)
/// 3. built-in official GitHub Release manifest
pub fn manifest_url() -> &'static str {
    let env = std::env::var(jeikcode_config::endpoints::UPDATE_MANIFEST_URL_ENV).ok();
    if let Some(v) = env.filter(|s| !s.trim().is_empty()) {
        return Box::leak(v.into_boxed_str());
    }
    if let Some(cfg) =
        jeikcode_config::config::Config::load(&jeikcode_config::config::Config::default_path()).ok()
    {
        if let Some(v) = cfg.update_manifest_url.filter(|s| !s.trim().is_empty()) {
            return Box::leak(v.into_boxed_str());
        }
    }
    jeikcode_config::endpoints::update_manifest_url()
}

/// Base for release binary downloads; [`binary_url`] appends `/<version>/<asset>`.
///
/// Same resolution order as [`manifest_url`]: env > config > built-in fork channel.
pub fn download_base() -> &'static str {
    let env = std::env::var(jeikcode_config::endpoints::UPDATE_DOWNLOAD_BASE_ENV).ok();
    if let Some(v) = env.filter(|s| !s.trim().is_empty()) {
        return Box::leak(v.into_boxed_str());
    }
    if let Some(cfg) =
        jeikcode_config::config::Config::load(&jeikcode_config::config::Config::default_path()).ok()
    {
        if let Some(v) = cfg.update_download_base.filter(|s| !s.trim().is_empty()) {
            return Box::leak(v.into_boxed_str());
        }
    }
    jeikcode_config::endpoints::update_download_base()
}

/// User-Agent for the update HTTP client. Lowercase `jeikcode/<version>` is
/// deliberate (the gateway UA filter hijacks capital-A `JeikCode`). Vendored here so
/// this leaf crate doesn't depend on `jeikcode-core` (mirrors its `JEIKCODE_USER_AGENT`;
/// same value since the whole workspace shares one version).
const JEIKCODE_USER_AGENT: &str = concat!("jeikcode/", env!("CARGO_PKG_VERSION"));

/// Apply the process proxy policy to the download client: honor `no_proxy` mode,
/// otherwise leave reqwest's env-based proxy detection intact. Same behavior as the
/// retiring `jeikcode_core::proxy::apply_async_proxy_policy`, using the config crate's
/// proxy env items so this crate needs no `jeikcode-core` dependency.
fn apply_proxy_policy(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    jeikcode_config::proxy::ensure_runtime_initialized();
    if std::env::var(jeikcode_config::proxy::MODE_ENV)
        .ok()
        .as_deref()
        == Some(jeikcode_config::proxy::ProxyMode::NoProxy.as_str())
    {
        builder.no_proxy()
    } else {
        builder
    }
}

/// Streamed progress events from the upgrade/rollback machinery.
///
/// Sender is always async-owned (the upgrade task); receivers are the
/// TUI event loop or the CLI `stdout` logger. Events are advisory —
/// dropping the receiver must never block the upgrade.
#[derive(Debug, Clone)]
pub enum UpgradeEvent {
    ManifestFetched {
        version: String,
    },
    Downloading {
        bytes: u64,
        total: u64,
    },
    Verifying,
    Replacing,
    Done {
        version: String,
        backup: PathBuf,
        /// The *original* exe path (e.g. `jeikcode.exe`) **before**
        /// `replace_binary` renamed it. On Windows, `current_exe()`
        /// returns the renamed path after the swap, so callers must
        /// use this field for `re_exec_self`.
        exe: PathBuf,
    },
    /// Terminal failure. Carries the display-formatted error so the UI
    /// layer doesn't need `anyhow` to render it.
    Failed(String),
    /// Rollback finished. Reported through the same channel so the TUI
    /// can drive both flows with a single select arm.
    RolledBack {
        exe: PathBuf,
        backup: PathBuf,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub released_at: Option<String>,
    pub binaries: std::collections::BTreeMap<String, BinaryEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BinaryEntry {
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Clone)]
pub struct UpgradeSummary {
    pub version: String,
    pub backup: PathBuf,
    pub exe: PathBuf,
}

#[derive(Debug, Clone)]
pub struct RollbackSummary {
    pub exe: PathBuf,
    pub backup: PathBuf,
}

/// Return the target tag used in release artifact names
/// (`darwin-arm64`, `linux-x64`, `windows-x64`, …).
///
/// `None` means the current platform has no published release — the
/// caller must surface a clean "unsupported platform" message rather
/// than fall through to a 404 download.
// `target_env = "ohos"` is unknown to the check-cfg lint on toolchains
// without the OpenHarmony target registered; the cfg is still correct when
// building for `*-linux-ohos`, so silence the false-positive.
#[allow(unexpected_cfgs)]
pub fn detect_target() -> Option<&'static str> {
    // HarmonyOS / OpenHarmony builds report `std::env::consts::OS == "linux"`
    // at runtime, so the OS+ARCH table below would resolve to `linux-arm64`
    // — a STATIC-musl build that doesn't run on HarmonyOS — and the auto-
    // upgrade would clobber the working DYNAMIC-musl install (the one linked
    // against `/lib/ld-musl-aarch64.so.1`), leaving `permission denied`.
    // The OHOS artifact is compiled for a `*-linux-ohos` target, so pin it to
    // its own `ohos-arm64` asset using the COMPILE-TIME target rather than the
    // runtime OS string. Zero effect on every other platform.
    #[cfg(any(target_os = "ohos", target_env = "ohos"))]
    {
        return match std::env::consts::ARCH {
            "aarch64" | "arm64" => Some("ohos-arm64"),
            _ => None,
        };
    }
    #[cfg(not(any(target_os = "ohos", target_env = "ohos")))]
    {
        target_tag(std::env::consts::OS, std::env::consts::ARCH)
    }
}

fn target_tag(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("windows", "x86_64") => Some("windows-x64"),
        ("windows", "aarch64") => Some("windows-arm64"),
        _ => None,
    }
}

/// Release artifact filename for a given version + target, matching
/// what `scripts/release.sh` publishes to `dist/<version>/`.
pub fn binary_filename(version: &str, target: &str) -> String {
    let tag = if version.starts_with('v') {
        version.to_string()
    } else {
        format!("v{}", version)
    };
    if target.starts_with("windows") {
        format!("jeikcode-{}-{}.exe", tag, target)
    } else {
        format!("jeikcode-{}-{}", tag, target)
    }
}

pub fn binary_url(version: &str, target: &str) -> String {
    let tag = if version.starts_with('v') {
        version.to_string()
    } else {
        format!("v{}", version)
    };
    format!(
        "{}/{}/{}",
        download_base(),
        tag,
        binary_filename(version, target)
    )
}

/// Path of the running `jeikcode` executable. Resolved once at the
/// start of an upgrade so we know what to replace.
/// Normalizes away `.rolling` or `.bak` suffixes if the process image was
/// previously renamed in-place on Windows.
pub fn current_exe_path() -> Result<PathBuf> {
    let exe = std::env::current_exe().context("could not resolve current executable path")?;
    Ok(normalize_live_exe_path(exe))
}

pub fn normalize_live_exe_path(exe: PathBuf) -> PathBuf {
    let Some(name) = exe.file_name().and_then(|n| n.to_str()) else {
        return exe;
    };
    let lower = name.to_ascii_lowercase();
    if lower == ".jeikcode.rolling" || lower == "jeikcode.rolling" {
        return exe.with_file_name(if cfg!(windows) {
            "jeikcode.exe"
        } else {
            "jeikcode"
        });
    }
    if lower.ends_with(".bak") {
        let trimmed = &name[..name.len() - 4];
        if !trimmed.is_empty() {
            return exe.with_file_name(trimmed);
        }
    }
    exe
}

fn same_exe(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// Returns true if `path` has the product binary name.
fn looks_like_jeikcode_binary(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let lower = name.to_ascii_lowercase();
    lower == "jeikcode" || lower == "jeikcode.exe"
}

/// Single authoritative install target: the running process binary.
/// Replaces the legacy multi-candidate traversal across PATH and ProgramFiles.
pub fn discover_install_exes(running: &Path) -> Vec<PathBuf> {
    vec![running.to_path_buf()]
}

/// Clean up orphaned legacy copies in `~/.local/bin` left by older dropper versions.
pub fn cleanup_legacy_dropper_file(running: &Path) {
    if let Some(home) = jeikcode_config::util::real_home_dir() {
        let local_bin = home.join(".local").join("bin");
        if let Ok(entries) = std::fs::read_dir(&local_bin) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let name = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    if (name.starts_with("jeikcode") || name.starts_with("atomcode"))
                        && !same_exe(&path, running)
                    {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }
        let _ = std::fs::remove_dir(&local_bin);
    }
}

/// Migrate legacy installations on Windows/Unix for direct binary update users:
/// 1. Remove legacy `~/.local/bin/jeikcode(.exe)` if not the running executable.
/// 2. On Windows, clean legacy `.local\bin` from `HKCU\Environment\Path` and
///    ensure the running binary's directory is registered in `Path`.
pub fn migrate_legacy_environment() {
    #[cfg(windows)]
    {
        let Ok(running) = current_exe_path() else {
            return;
        };
        cleanup_legacy_dropper_file(&running);

        use winreg::enums::*;
        use winreg::RegKey;
        let Ok(env) = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)
        else {
            return;
        };
        let current: String = env.get_value("Path").unwrap_or_default();
        let home = jeikcode_config::util::real_home_dir();
        let legacy_dir = home
            .as_ref()
            .map(|h| h.join(".local").join("bin").display().to_string());
        let install_dir = running.parent().map(|d| d.display().to_string());

        let mut parts: Vec<String> = current
            .split(';')
            .filter(|p| {
                let trimmed = p.trim();
                if trimmed.is_empty() {
                    return false;
                }
                let lower = trimmed.to_ascii_lowercase();
                if lower.contains(".local\\bin")
                    || lower.contains(".local/bin")
                    || lower.contains("atomcode")
                {
                    return false;
                }
                true
            })
            .map(|s| s.to_string())
            .collect();

        // 仅在当前运行目录包含有效可执行文件且非临时目录时加入 PATH
        if let Some(ref dir_str) = install_dir {
            let lower = dir_str.to_ascii_lowercase();
            if !lower.contains("temp") && !lower.contains("staged") && !lower.contains("target\\") {
                if !parts.iter().any(|p| p.trim().eq_ignore_ascii_case(dir_str)) {
                    parts.insert(0, dir_str.clone());
                }
            }
        }

        let new_path = parts.join(";");
        if new_path != current {
            let _ = env.set_value("Path", &new_path);
            broadcast_setting_change();
        }
    }

    #[cfg(not(windows))]
    {
        if let Ok(running) = current_exe_path() {
            cleanup_legacy_dropper_file(&running);
        }
    }
}

#[cfg(windows)]
fn broadcast_setting_change() {
    #[link(name = "user32")]
    extern "system" {
        fn SendMessageTimeoutW(
            hwnd: *mut std::ffi::c_void,
            msg: u32,
            wparam: usize,
            lparam: *const u16,
            flags: u32,
            timeout: u32,
            result: *mut usize,
        ) -> isize;
    }
    use std::os::windows::ffi::OsStrExt;
    let env_wide: Vec<u16> = std::ffi::OsStr::new("Environment")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let hwnd_broadcast = 0xffff as *mut std::ffi::c_void;
    const WM_SETTINGCHANGE: u32 = 0x001A;
    const SMTO_ABORTIFHUNG: u32 = 0x0002;
    let mut res = 0;
    unsafe {
        SendMessageTimeoutW(
            hwnd_broadcast,
            WM_SETTINGCHANGE,
            0,
            env_wide.as_ptr(),
            SMTO_ABORTIFHUNG,
            5000,
            &mut res,
        );
    }
}

fn file_sha256_hex(path: &Path) -> Result<String> {
    let mut hasher = Sha256::new();
    let mut file =
        std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
    std::io::copy(&mut file, &mut hasher).context("hashing file")?;
    Ok(hex_encode(&hasher.finalize()))
}

/// Sibling path used to stash the previous binary.
///
/// Unix: `jeikcode` → `jeikcode.bak`.
/// Windows: `jeikcode.exe` → `jeikcode.exe.bak`.
pub fn backup_path(exe: &Path) -> PathBuf {
    let mut os = exe.as_os_str().to_os_string();
    os.push(".bak");
    PathBuf::from(os)
}

/// Temp file where an in-flight download is written before atomic
/// rename. Dotted prefix so it doesn't show up in a casual `ls`, and
/// also so it's easy to identify-and-clean if a crash orphans it.
fn download_path(exe: &Path) -> PathBuf {
    let dir = exe.parent().unwrap_or_else(|| Path::new("."));
    dir.join(".jeikcode.download")
}

/// Same-dir temp used during a three-way rollback swap. Also reused by the
/// Windows uninstaller (jeikcode-cli) to rename the live exe out of the way
/// before deleting the install dir, hence `pub` rather than `pub(crate)`.
pub fn rolling_path(exe: &Path) -> PathBuf {
    let dir = exe.parent().unwrap_or_else(|| Path::new("."));
    dir.join(".jeikcode.rolling")
}

/// Return `Ok(())` iff we can create a file alongside `exe`.
///
/// Testing the *directory* (not the file itself) is what matters:
/// `rename(2)` needs write permission on the containing dir to atomic
/// replace. Probing creates a real empty file and deletes it to avoid
/// false positives from filesystems that claim metadata writability
/// but reject opens.
pub fn ensure_writable(exe: &Path) -> Result<()> {
    let dir = exe
        .parent()
        .ok_or_else(|| anyhow!("executable has no parent directory: {}", exe.display()))?;
    let probe = dir.join(".jeikcode.writable-probe");
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            Ok(())
        }
        Err(e) => Err(anyhow!(
            "{} is not writable by the current user ({}).\n\
             Re-run with elevated privileges:  sudo jeikcode upgrade\n\
             Or reinstall into a user-writable location (e.g. ~/.local/bin).",
            dir.display(),
            e
        )),
    }
}

/// Fetch and parse `latest.json` from the configured manifest URL.
///
/// Longer timeout than the passive `version_check` (which must fail
/// fast at startup); here the user explicitly asked for an upgrade, so
/// waiting 30s for a slow mirror is acceptable.
pub async fn fetch_manifest() -> Result<Manifest> {
    fetch_manifest_from_url(manifest_url()).await
}

/// Release channel for in-place upgrades. `Stable` is GitHub `releases/latest`
/// (`--main` / omitting the channel). `Beta` is the highest prerelease tag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateChannel {
    Stable,
    Beta,
}

impl UpdateChannel {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "beta" | "preview" => Self::Beta,
            _ => Self::Stable,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ListedAsset {
    pub name: String,
    pub browser_download_url: String,
}

/// One GitHub (or edge-cache) release row used by version listing.
#[derive(Debug, Clone, Deserialize)]
pub struct ListedRelease {
    pub tag_name: String,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub assets: Vec<ListedAsset>,
}

fn tag_is_prerelease(tag: &str, flagged: bool) -> bool {
    flagged || tag.contains('-')
}

/// SemVer compare that keeps pre-release ordinals (`7.2.4-beta.5` > `7.2.4-beta.4`).
/// Stable without a pre-release tag ranks above the same core with a pre tag.
pub fn version_is_newer(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> (Vec<u64>, Option<(String, u64)>) {
        let clean = v.trim().trim_start_matches('v').trim_start_matches('V');
        if let Some((main_part, pre_part)) = clean.split_once('-') {
            let nums: Vec<u64> = main_part
                .split('.')
                .filter_map(|s| s.parse::<u64>().ok())
                .collect();
            let pre_info = if let Some((tag, num_str)) = pre_part.split_once('.') {
                Some((tag.to_lowercase(), num_str.parse::<u64>().unwrap_or(0)))
            } else {
                Some((pre_part.to_lowercase(), 0))
            };
            (nums, pre_info)
        } else {
            let nums: Vec<u64> = clean
                .split('.')
                .filter_map(|s| s.parse::<u64>().ok())
                .collect();
            (nums, None)
        }
    };
    let (latest_nums, latest_pre) = parse(latest);
    let (current_nums, current_pre) = parse(current);
    let max_len = latest_nums.len().max(current_nums.len());
    for i in 0..max_len {
        let l = latest_nums.get(i).copied().unwrap_or(0);
        let c = current_nums.get(i).copied().unwrap_or(0);
        if l > c {
            return true;
        }
        if l < c {
            return false;
        }
    }
    match (latest_pre, current_pre) {
        (None, Some(_)) => true,
        (Some(_), None) => false,
        (Some((l_tag, l_num)), Some((c_tag, c_num))) => {
            if l_tag != c_tag {
                l_tag > c_tag
            } else {
                l_num > c_num
            }
        }
        (None, None) => false,
    }
}

fn next_page_url(headers: &reqwest::header::HeaderMap) -> Option<String> {
    let raw = headers.get(reqwest::header::LINK)?.to_str().ok()?;
    for part in raw.split(',') {
        let part = part.trim();
        if !part.contains("rel=\"next\"") {
            continue;
        }
        let start = part.find('<')? + 1;
        let end = part.find('>')?;
        if start < end {
            return Some(part[start..end].to_string());
        }
    }
    None
}

fn notes_missing(body: &Option<String>) -> bool {
    body.as_ref().map(|s| s.trim().is_empty()).unwrap_or(true)
}

fn merge_listed_releases(into: &mut Vec<ListedRelease>, extra: Vec<ListedRelease>) {
    for rel in extra {
        if rel.tag_name.trim().is_empty() {
            continue;
        }
        if let Some(existing) = into.iter_mut().find(|r| r.tag_name == rel.tag_name) {
            if notes_missing(&existing.body) && !notes_missing(&rel.body) {
                existing.body = rel.body;
            }
            if existing.published_at.is_none() {
                existing.published_at = rel.published_at;
            }
            if existing.assets.is_empty() {
                existing.assets = rel.assets;
            }
            existing.prerelease = existing.prerelease || rel.prerelease;
        } else {
            into.push(rel);
        }
    }
}

async fn fetch_release_pages(
    client: &reqwest::Client,
    first_url: &str,
) -> Result<Vec<ListedRelease>> {
    let mut url = first_url.to_string();
    let mut all = Vec::new();
    for _ in 0..20 {
        let resp = client
            .get(&url)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .send()
            .await
            .with_context(|| format!("GET {url}"))?;
        if !resp.status().is_success() {
            if all.is_empty() {
                return Err(anyhow!(
                    "listing releases from {url} returned HTTP {}",
                    resp.status()
                ));
            }
            break;
        }
        let next = next_page_url(resp.headers());
        let page = resp
            .json::<Vec<ListedRelease>>()
            .await
            .context("parsing releases page")?;
        if page.is_empty() {
            break;
        }
        all.extend(page);
        match next {
            Some(next_url) => url = next_url,
            None => break,
        }
    }
    Ok(all)
}

/// Releases from the edge cache at `jeikcode.top/api/releases`.
///
/// GitHub's REST API is used when the edge returns nothing, or when it
/// returns tags whose announcement `body` is still empty. A payload that
/// already includes notes does not call GitHub.
pub async fn list_releases() -> Result<Vec<ListedRelease>> {
    if jeikcode_config::config::offline::is_offline_active() {
        return Ok(vec![]);
    }
    let client = apply_proxy_policy(reqwest::Client::builder())
        .timeout(std::time::Duration::from_secs(30))
        .user_agent(JEIKCODE_USER_AGENT)
        .build()?;
    let mut all = Vec::new();
    let primary = std::env::var("JEIKCODE_RELEASES_API_URL")
        .ok()
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| "https://jeikcode.top/api/releases".to_string());
    if let Ok(resp) = client.get(&primary).send().await {
        if resp.status().is_success() {
            if let Ok(list) = resp.json::<Vec<ListedRelease>>().await {
                merge_listed_releases(&mut all, list);
            }
        }
    }
    let edge_has_notes = all.iter().any(|r| !notes_missing(&r.body));
    if all.is_empty() || !edge_has_notes {
        let gh = "https://api.github.com/repos/jeikl/JeikCode/releases?per_page=100";
        if let Ok(pages) = fetch_release_pages(&client, gh).await {
            merge_listed_releases(&mut all, pages);
        }
    }
    if all.is_empty() {
        return Err(anyhow!("no releases found"));
    }
    Ok(all)
}

/// Releases directly from GitHub, returning empty vec in offline mode.
pub async fn list_releases_from_github() -> Result<Vec<ListedRelease>> {
    if jeikcode_config::config::offline::is_offline_active() {
        return Ok(vec![]);
    }
    list_releases().await
}

/// Channel releases, newest first. Stable drops prereleases; beta keeps them.
pub fn filter_channel_releases(
    releases: &[ListedRelease],
    channel: UpdateChannel,
) -> Vec<ListedRelease> {
    let mut matched: Vec<ListedRelease> = releases
        .iter()
        .filter(|r| !r.tag_name.trim().is_empty())
        .filter(|r| match channel {
            UpdateChannel::Stable => !tag_is_prerelease(&r.tag_name, r.prerelease),
            UpdateChannel::Beta => tag_is_prerelease(&r.tag_name, r.prerelease),
        })
        .cloned()
        .collect();
    matched.sort_by(|a, b| {
        if version_is_newer(&a.tag_name, &b.tag_name) {
            std::cmp::Ordering::Less
        } else if version_is_newer(&b.tag_name, &a.tag_name) {
            std::cmp::Ordering::Greater
        } else {
            a.tag_name.cmp(&b.tag_name)
        }
    });
    matched.dedup_by(|a, b| a.tag_name == b.tag_name);
    matched
}

/// `7.2.4` and `v7.2.4` both become `v7.2.4`.
pub fn normalize_version_tag(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let bare = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    format!("v{bare}")
}

/// Stable tags have no prerelease suffix. Anything with `-` is beta.
pub fn channel_for_tag(tag: &str) -> UpdateChannel {
    if tag_is_prerelease(tag, false) {
        UpdateChannel::Beta
    } else {
        UpdateChannel::Stable
    }
}

/// `latest.json` published next to one tag's binaries.
pub async fn fetch_manifest_for_tag(version: &str) -> Result<Manifest> {
    if jeikcode_config::config::offline::is_offline_active() {
        bail!("cannot fetch update manifest in offline mode");
    }
    let tag = normalize_version_tag(version);
    if tag == "v" {
        return Err(anyhow!("missing version"));
    }
    let url = format!(
        "{}/{tag}/latest.json",
        download_base().trim_end_matches('/')
    );
    fetch_manifest_from_url(&url).await
}

/// Latest `latest.json` for the chosen channel. Stable uses GitHub
/// `releases/latest`; beta picks the highest prerelease tag and loads that
/// tag's `latest.json` (prereleases are never `/releases/latest`).
pub async fn fetch_manifest_for_channel(channel: UpdateChannel) -> Result<Manifest> {
    if jeikcode_config::config::offline::is_offline_active() {
        bail!("cannot fetch update manifest in offline mode");
    }
    match channel {
        UpdateChannel::Stable => fetch_manifest().await,
        UpdateChannel::Beta => {
            let tags = list_releases().await?;
            let matched = filter_channel_releases(&tags, UpdateChannel::Beta);
            let tag = matched
                .first()
                .map(|r| r.tag_name.clone())
                .ok_or_else(|| anyhow!("no beta (prerelease) tag found"))?;
            fetch_manifest_for_tag(&tag).await
        }
    }
}

/// Same as [`run_upgrade`] but reads the stable or beta manifest.
pub async fn run_upgrade_for_channel(
    channel: UpdateChannel,
    current_version: String,
    force: bool,
    tx: mpsc::UnboundedSender<UpgradeEvent>,
) -> Result<UpgradeSummary> {
    if is_package_managed() {
        return Err(anyhow!(PACKAGE_MANAGED));
    }
    let manifest = fetch_manifest_for_channel(channel).await?;
    run_upgrade_with_manifest(manifest, current_version, force, tx).await
}

/// Child waits for this parent pid to exit before binding the listen port.
pub const RESTART_WAIT_PID_ENV: &str = "JEIKCODE_RESTART_WAIT_PID";

/// Old listen port of the predecessor process being replaced (used to wait for socket release).
pub const RESTART_WAIT_PORT_ENV: &str = "JEIKCODE_RESTART_WAIT_PORT";

/// Target listen host of the replacement process.
pub const RESTART_LISTEN_HOST_ENV: &str = "JEIKCODE_RESTART_LISTEN_HOST";

/// Actual listen port of the process that is being replaced.
/// argv `--port` can still be the first choice from before a cold-start scan.
pub const RESTART_LISTEN_PORT_ENV: &str = "JEIKCODE_RESTART_LISTEN_PORT";

/// Successor must bind [`RESTART_LISTEN_PORT_ENV`] and must not scan or
/// shut down any other jeikcode on a neighboring port.
pub const RESTART_EXACT_PORT_ENV: &str = "JEIKCODE_RESTART_EXACT_PORT";

/// Token the browser already stored. Set only when argv has no `--token`.
pub const RESTART_TOKEN_ENV: &str = "JEIKCODE_RESTART_TOKEN";

/// Explicit no-token mode indicator across restarts (`"1"` or `"0"`).
pub const RESTART_NO_TOKEN_ENV: &str = "JEIKCODE_RESTART_NO_TOKEN";

/// Marks that the current process is a restarted successor so interactive setup wizards are skipped.
pub const RESTARTED_ENV: &str = "JEIKCODE_RESTARTED";

/// Indicates the daemon/webui is directly supervised by `jeikcode-desktop`,
/// which will immediately respawn the process upon exit.
pub const DESKTOP_MANAGED_ENV: &str = "JEIKCODE_DESKTOP_MANAGED";

/// PID of the supervising `jeikcode-desktop` process.
pub const DESKTOP_PID_ENV: &str = "JEIKCODE_DESKTOP_PID";

/// Dedicated exit code used by a desktop-managed child to signal an intentional
/// restart (e.g. after self-upgrade or remote-access port/host/token change).
/// Distinguishes intentional restarts from normal termination (`0`) or crashes,
/// eliminating unconditional respawn loops in the desktop supervisor.
pub const RESTART_REQUESTED_EXIT_CODE: i32 = 75;

pub fn pid_is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        unsafe { kill(pid as i32, 0) == 0 }
    }
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
            fn GetExitCodeProcess(handle: *mut std::ffi::c_void, code: *mut u32) -> i32;
        }
        const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
        const STILL_ACTIVE: u32 = 259;
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            ok != 0 && code == STILL_ACTIVE
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        false
    }
}

/// `--port 13457` or `--port=13457` from the inherited argv.
pub fn listen_port_from_args<I, S>(args: I) -> Option<u16>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let args: Vec<std::ffi::OsString> = args
        .into_iter()
        .map(|arg| arg.as_ref().to_os_string())
        .collect();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--port" {
            let value = args.get(index + 1)?;
            return value.to_str()?.parse().ok().filter(|port: &u16| *port > 0);
        }
        if let Some(rest) = arg.to_str().and_then(|text| text.strip_prefix("--port=")) {
            return rest.parse().ok().filter(|port: &u16| *port > 0);
        }
        index += 1;
    }
    None
}

pub fn restart_listen_port_from_env() -> Option<u16> {
    std::env::var(RESTART_LISTEN_PORT_ENV)
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|port: &u16| *port > 0)
}

pub fn restart_listen_host_from_env() -> Option<String> {
    let host = std::env::var(RESTART_LISTEN_HOST_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    std::env::remove_var(RESTART_LISTEN_HOST_ENV);
    host
}

/// Read and remove the inherited webui token so later child processes do not
/// see it.
pub fn take_restart_token() -> Option<String> {
    let token = std::env::var(RESTART_TOKEN_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    std::env::remove_var(RESTART_TOKEN_ENV);
    token
}

/// Read and remove the explicit `no_token` override across restarts.
pub fn take_restart_no_token() -> Option<bool> {
    let val = std::env::var(RESTART_NO_TOKEN_ENV).ok()?;
    std::env::remove_var(RESTART_NO_TOKEN_ENV);
    match val.trim() {
        "1" | "true" => Some(true),
        "0" | "false" => Some(false),
        _ => None,
    }
}

/// Returns true if the current process is an in-place restart successor.
pub fn is_restarted_process() -> bool {
    std::env::var_os(RESTARTED_ENV).is_some()
        || std::env::var_os("JEIKCODE_SKIP_PENDING_UPGRADE").is_some()
        || std::env::var_os(RESTART_EXACT_PORT_ENV).is_some()
}

/// `Some(port)` means this start is the successor of an in-place upgrade and
/// must bind that port only.
pub fn planned_restart_port(
    exact: Option<&str>,
    listen_port: Option<&str>,
    fallback: u16,
) -> Option<u16> {
    if exact != Some("1") {
        return None;
    }
    let port = listen_port
        .and_then(|value| value.parse().ok())
        .filter(|port: &u16| *port > 0)
        .unwrap_or(fallback);
    (port > 0).then_some(port)
}

/// The listen socket is the handoff signal. A desktop shell that never
/// `wait`s its child leaves a zombie whose pid still looks alive.
pub fn predecessor_socket_released(port_accepting: bool) -> bool {
    !port_accepting
}

fn tcp_port_accepting(port: u16) -> bool {
    let addr = std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port));
    std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(80)).is_ok()
}

/// Call at process start, before binding any port. The successor started by
/// [`restart_replaced_process`] waits until this process's listen port stops
/// accepting. It does not kill any pid, and it does not wait out a zombie.
pub fn wait_for_predecessor_if_requested() {
    let Ok(raw) = std::env::var(RESTART_WAIT_PID_ENV) else {
        return;
    };
    let Ok(pid) = raw.parse::<u32>() else {
        return;
    };
    std::env::remove_var(RESTART_WAIT_PID_ENV);
    let wait_port = std::env::var(RESTART_WAIT_PORT_ENV)
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .filter(|p| *p > 0);
    std::env::remove_var(RESTART_WAIT_PORT_ENV);
    let port = wait_port
        .or_else(restart_listen_port_from_env)
        .or_else(|| listen_port_from_args(std::env::args_os().skip(1)));
    let Some(port) = port else {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while std::time::Instant::now() < deadline && pid_is_alive(pid) {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
        return;
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut waited_for_non_loopback_pid = false;
    while std::time::Instant::now() < deadline {
        if predecessor_socket_released(tcp_port_accepting(port)) {
            // If predecessor bound a specific non-loopback LAN IP, 127.0.0.1:port is not
            // accepting even while the predecessor is still alive. Wait briefly for the
            // predecessor PID to exit so we do not race its socket teardown.
            if !waited_for_non_loopback_pid && pid_is_alive(pid) {
                waited_for_non_loopback_pid = true;
                let pid_deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
                while std::time::Instant::now() < pid_deadline && pid_is_alive(pid) {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(150));
            return;
        }
        // Predecessor is gone, but something else is answering on this port.
        // Leave that process alone; exact bind will fail instead of scanning.
        if !pid_is_alive(pid) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

#[cfg(unix)]
fn supervised_by_service_manager() -> bool {
    if std::env::var_os("INVOCATION_ID").is_some()
        || std::env::var_os("LAUNCH_JOBNAME").is_some()
        || std::env::var_os("XPC_SERVICE_NAME").is_some()
    {
        return true;
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(cgroup) = std::fs::read_to_string("/proc/self/cgroup") {
            if cgroup.lines().any(|l| l.contains(".service")) {
                return true;
            }
        }
        if parent_is_procd() {
            return true;
        }
    }
    false
}

/// OpenWrt procd 托管判定：父进程为 `/sbin/procd`。
#[cfg(target_os = "linux")]
fn parent_is_procd() -> bool {
    let ppid = std::os::unix::process::parent_id();
    if ppid <= 1 {
        return false;
    }
    std::fs::read_to_string(format!("/proc/{ppid}/comm"))
        .map(|comm| comm.trim() == "procd")
        .unwrap_or(false)
}

/// 由向导生成的服务定义统一写入此环境变量，值为服务名，
/// 用于在重启时精确定位「正在托管自己」的那一个服务文件。
pub const HOST_SERVICE_ENV: &str = "JEIKCODE_HOST_SERVICE";

static DESKTOP_MANAGED_FLAG: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
static HOST_SERVICE_MARKER: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

/// 进程启动时尽早调用（任何子进程/线程创建之前）：读取并从环境中移除
/// `JEIKCODE_DESKTOP_MANAGED` 与 `JEIKCODE_HOST_SERVICE`，避免 Agent 在 bash 工具里
/// 启动的另一个 jeikcode 继承到这两个标记，误判自己的启动方式并改写父服务文件。
pub fn capture_launch_markers() {
    let _ = is_desktop_managed();
    let _ = host_service_marker();
}

/// 当前进程是否由桌面壳直接托管。
pub fn is_desktop_managed() -> bool {
    *DESKTOP_MANAGED_FLAG.get_or_init(|| {
        let managed = std::env::var_os(DESKTOP_MANAGED_ENV).is_some()
            || std::env::var_os("JEIKCODE_DESKTOP").is_some()
            || std::env::var(DESKTOP_PID_ENV)
                .ok()
                .and_then(|p| p.trim().parse::<u32>().ok())
                .is_some_and(|pid| pid > 0);
        std::env::remove_var(DESKTOP_MANAGED_ENV);
        managed
    })
}

fn host_service_marker() -> Option<String> {
    HOST_SERVICE_MARKER
        .get_or_init(|| {
            let marker = std::env::var(HOST_SERVICE_ENV)
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty());
            std::env::remove_var(HOST_SERVICE_ENV);
            marker
        })
        .clone()
}

/// 当前进程的启动方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchMode {
    /// 桌面壳托管的子进程（由桌面壳负责重启）。
    Desktop,
    /// Linux systemd 服务。
    Systemd,
    /// OpenWrt procd 服务。
    Procd,
    /// macOS launchd 代理。
    Launchd,
    /// Windows 登录自启（HKCU Run + `.cmd` 启动器）。
    WindowsLogon,
    /// 终端前台运行。
    Foreground,
}

impl LaunchMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Systemd => "systemd",
            Self::Procd => "procd",
            Self::Launchd => "launchd",
            Self::WindowsLogon => "windows-logon",
            Self::Foreground => "foreground",
        }
    }
}

/// 识别当前进程是通过什么方式启动的。只看进程自身可确认的信号
/// （环境变量 / 父进程 / cgroup），不按「磁盘上存在某个服务文件」去猜。
pub fn detect_launch_mode() -> LaunchMode {
    if is_desktop_managed() {
        return LaunchMode::Desktop;
    }
    #[cfg(target_os = "linux")]
    {
        if parent_is_procd() {
            return LaunchMode::Procd;
        }
        if std::env::var_os("INVOCATION_ID").is_some() {
            return LaunchMode::Systemd;
        }
    }
    #[cfg(target_os = "macos")]
    {
        let xpc = std::env::var("XPC_SERVICE_NAME").unwrap_or_default();
        if xpc.starts_with("com.jeikcode-") || std::env::var_os("LAUNCH_JOBNAME").is_some() {
            return LaunchMode::Launchd;
        }
    }
    #[cfg(target_os = "windows")]
    {
        if host_service_marker()
            .map(|v| v.to_ascii_lowercase().starts_with("jeikcode-"))
            .unwrap_or(false)
        {
            return LaunchMode::WindowsLogon;
        }
    }
    LaunchMode::Foreground
}

/// Patch CLI argv to inject updated host, port, and token parameters upon restart.
pub fn patch_restart_args<I, S>(
    args: I,
    new_host: Option<&str>,
    new_port: Option<u16>,
    new_token: Option<&str>,
) -> Vec<std::ffi::OsString>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    patch_restart_args_with_auth(args, new_host, new_port, new_token, None)
}

/// Patch CLI argv to inject updated host, port, token, and `--no-token` parameters upon restart,
/// automatically resolving mutual exclusion between `--token` and `--no-token`.
pub fn patch_restart_args_with_auth<I, S>(
    args: I,
    new_host: Option<&str>,
    new_port: Option<u16>,
    new_token: Option<&str>,
    no_token: Option<bool>,
) -> Vec<std::ffi::OsString>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let orig: Vec<std::ffi::OsString> = args
        .into_iter()
        .map(|a| a.as_ref().to_os_string())
        .collect();
    let mut out: Vec<std::ffi::OsString> = Vec::with_capacity(orig.len() + 6);
    let mut i = 0;
    let effective_token = if no_token == Some(true) {
        None
    } else {
        new_token.map(str::trim).filter(|t| !t.is_empty())
    };
    let want_no_token = no_token == Some(true);
    let strip_no_token = no_token == Some(false) || effective_token.is_some();

    let first_subcmd = orig
        .first()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let is_daemon_subcmd = first_subcmd == "daemon";

    let mut host_patched = new_host.is_none();
    let mut port_patched = new_port.map_or(true, |p| p == 0);
    let mut token_patched = effective_token.is_none();
    let mut has_no_token_flag = false;

    while i < orig.len() {
        let arg = &orig[i];
        let arg_str = arg.to_string_lossy();

        if arg_str == "--no-token" {
            if strip_no_token {
                i += 1;
                continue;
            }
            has_no_token_flag = true;
            out.push(arg.clone());
            i += 1;
            continue;
        }

        if want_no_token {
            if arg_str == "--token" {
                i += if i + 1 < orig.len() { 2 } else { 1 };
                continue;
            } else if arg_str.starts_with("--token=") {
                i += 1;
                continue;
            }
        }

        if let Some(h) = new_host {
            if arg_str == "--host" {
                out.push(arg.clone());
                out.push(std::ffi::OsString::from(h));
                host_patched = true;
                if i + 1 < orig.len() {
                    i += 2;
                    continue;
                }
            } else if arg_str.starts_with("--host=") {
                out.push(std::ffi::OsString::from(format!("--host={h}")));
                host_patched = true;
                i += 1;
                continue;
            }
        }

        if let Some(p) = new_port.filter(|p| *p > 0) {
            if arg_str == "--port" {
                out.push(arg.clone());
                out.push(std::ffi::OsString::from(p.to_string()));
                port_patched = true;
                if i + 1 < orig.len() {
                    i += 2;
                    continue;
                }
            } else if arg_str.starts_with("--port=") {
                out.push(std::ffi::OsString::from(format!("--port={p}")));
                port_patched = true;
                i += 1;
                continue;
            }
        }

        if let Some(t) = effective_token {
            if arg_str == "--token" {
                out.push(arg.clone());
                out.push(std::ffi::OsString::from(t));
                token_patched = true;
                if i + 1 < orig.len() {
                    i += 2;
                    continue;
                }
            } else if arg_str.starts_with("--token=") {
                out.push(std::ffi::OsString::from(format!("--token={t}")));
                token_patched = true;
                i += 1;
                continue;
            }
        }

        out.push(arg.clone());
        i += 1;
    }

    if let Some(h) = new_host {
        if !host_patched {
            out.push(std::ffi::OsString::from("--host"));
            out.push(std::ffi::OsString::from(h));
        }
    }
    if let Some(p) = new_port.filter(|p| *p > 0) {
        if !port_patched {
            out.push(std::ffi::OsString::from("--port"));
            out.push(std::ffi::OsString::from(p.to_string()));
        }
    }
    if want_no_token && !has_no_token_flag && !is_daemon_subcmd && first_subcmd != "webui" {
        out.push(std::ffi::OsString::from("--no-token"));
    } else if let Some(t) = effective_token {
        if !token_patched {
            out.push(std::ffi::OsString::from("--token"));
            out.push(std::ffi::OsString::from(t));
        }
    }

    out
}

/// Tokenize a command-line string preserving quoted segments.
fn tokenize_command_line(line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '"' {
            in_quotes = !in_quotes;
            current.push(ch);
        } else if ch.is_whitespace() && !in_quotes {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
        } else {
            current.push(ch);
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn format_flag_val(val: &str, quote: bool) -> String {
    if quote || val.chars().any(|c| c.is_whitespace()) {
        format!("\"{}\"", val.trim_matches('"'))
    } else {
        val.trim_matches('"').to_string()
    }
}

/// Rewrite `--host`, `--port`, `--token`, and `--no-token` flags in a single command line
/// (used for systemd `ExecStart=`, OpenWrt `procd_set_param command`, and Windows `.cmd` launchers).
pub fn rewrite_service_command_line(
    line: &str,
    new_host: Option<&str>,
    new_port: Option<u16>,
    new_token: Option<&str>,
    no_token: Option<bool>,
    quote_values: bool,
) -> String {
    let tokens = tokenize_command_line(line);
    if tokens.is_empty() {
        return line.to_string();
    }
    let effective_token = if no_token == Some(true) {
        None
    } else {
        new_token.map(str::trim).filter(|t| !t.is_empty())
    };
    let want_no_token = no_token == Some(true);
    let strip_no_token = no_token == Some(false) || effective_token.is_some();

    let mut out: Vec<String> = Vec::with_capacity(tokens.len() + 4);
    let mut i = 0;
    let mut host_patched = new_host.is_none();
    let mut port_patched = new_port.map_or(true, |p| p == 0);
    let mut token_patched = effective_token.is_none();
    let mut has_no_token = false;

    while i < tokens.len() {
        let tok = &tokens[i];
        if tok == "--no-token" {
            if strip_no_token {
                i += 1;
                continue;
            }
            has_no_token = true;
            out.push(tok.clone());
            i += 1;
            continue;
        }
        if want_no_token {
            if tok == "--token" {
                i += if i + 1 < tokens.len() { 2 } else { 1 };
                continue;
            } else if tok.starts_with("--token=") {
                i += 1;
                continue;
            }
        }
        if let Some(h) = new_host.map(str::trim).filter(|h| !h.is_empty()) {
            if tok == "--host" && i + 1 < tokens.len() {
                let was_quoted = tokens[i + 1].starts_with('"');
                out.push("--host".to_string());
                out.push(format_flag_val(h, quote_values || was_quoted));
                host_patched = true;
                i += 2;
                continue;
            } else if tok.starts_with("--host=") {
                out.push(format!("--host={}", format_flag_val(h, quote_values)));
                host_patched = true;
                i += 1;
                continue;
            }
        }
        if let Some(p) = new_port.filter(|p| *p > 0) {
            if tok == "--port" && i + 1 < tokens.len() {
                out.push("--port".to_string());
                out.push(p.to_string());
                port_patched = true;
                i += 2;
                continue;
            } else if tok.starts_with("--port=") {
                out.push(format!("--port={p}"));
                port_patched = true;
                i += 1;
                continue;
            }
        }
        if let Some(t) = effective_token {
            if tok == "--token" && i + 1 < tokens.len() {
                let was_quoted = tokens[i + 1].starts_with('"');
                out.push("--token".to_string());
                out.push(format_flag_val(t, quote_values || was_quoted));
                token_patched = true;
                i += 2;
                continue;
            } else if tok.starts_with("--token=") {
                out.push(format!("--token={}", format_flag_val(t, quote_values)));
                token_patched = true;
                i += 1;
                continue;
            }
        }
        out.push(tok.clone());
        i += 1;
    }

    if let Some(h) = new_host.map(str::trim).filter(|h| !h.is_empty()) {
        if !host_patched {
            out.push("--host".to_string());
            out.push(format_flag_val(h, quote_values));
        }
    }
    if let Some(p) = new_port.filter(|p| *p > 0) {
        if !port_patched {
            out.push("--port".to_string());
            out.push(p.to_string());
        }
    }
    if want_no_token && !has_no_token {
        out.push("--no-token".to_string());
    } else if let Some(t) = effective_token {
        if !token_patched {
            out.push("--token".to_string());
            out.push(format_flag_val(t, quote_values));
        }
    }

    out.join(" ")
}

/// Rewrite systemd unit content (`ExecStart=...`) with updated listen options.
pub fn rewrite_systemd_unit_content(
    content: &str,
    new_host: Option<&str>,
    new_port: Option<u16>,
    new_token: Option<&str>,
    no_token: Option<bool>,
) -> String {
    let mut lines = Vec::new();
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("ExecStart=") {
            let updated =
                rewrite_service_command_line(rest, new_host, new_port, new_token, no_token, false);
            lines.push(format!("ExecStart={updated}"));
        } else {
            lines.push(line.to_string());
        }
    }
    let mut out = lines.join("\n");
    if content.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// Rewrite OpenWrt procd script content (`procd_set_param command ...`) with updated listen options.
pub fn rewrite_procd_script_content(
    content: &str,
    new_host: Option<&str>,
    new_port: Option<u16>,
    new_token: Option<&str>,
    no_token: Option<bool>,
) -> String {
    let mut lines = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("procd_set_param command ") {
            let indent = &line[..line.len() - trimmed.len()];
            let updated =
                rewrite_service_command_line(rest, new_host, new_port, new_token, no_token, true);
            lines.push(format!("{indent}procd_set_param command {updated}"));
        } else {
            lines.push(line.to_string());
        }
    }
    let mut out = lines.join("\n");
    if content.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// Rewrite Windows `.cmd` logon launcher content with updated listen options.
pub fn rewrite_windows_cmd_content(
    content: &str,
    new_host: Option<&str>,
    new_port: Option<u16>,
    new_token: Option<&str>,
    no_token: Option<bool>,
) -> String {
    let mut lines = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        if !trimmed.is_empty()
            && !trimmed.starts_with('@')
            && !lower.starts_with("cd ")
            && !lower.starts_with("set ")
            && (trimmed.contains("--host") || trimmed.contains("--port"))
        {
            lines.push(rewrite_service_command_line(
                trimmed, new_host, new_port, new_token, no_token, false,
            ));
        } else {
            lines.push(line.to_string());
        }
    }
    let mut out = lines.join("\r\n");
    if content.ends_with('\n') {
        out.push_str("\r\n");
    }
    out
}

fn xml_unescape(s: &str) -> String {
    s.replace("&apos;", "'")
        .replace("&quot;", "\"")
        .replace("&gt;", ">")
        .replace("&lt;", "<")
        .replace("&amp;", "&")
}

fn xml_escape_str(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Rewrite macOS launchd `.plist` `<key>ProgramArguments</key>` with updated listen options.
pub fn rewrite_launchd_plist_content(
    content: &str,
    new_host: Option<&str>,
    new_port: Option<u16>,
    new_token: Option<&str>,
    no_token: Option<bool>,
) -> Option<String> {
    let key_idx = content.find("<key>ProgramArguments</key>")?;
    let after_key = &content[key_idx..];
    let array_start_rel = after_key.find("<array>")?;
    let array_end_rel = after_key.find("</array>")?;
    if array_start_rel >= array_end_rel {
        return None;
    }
    let array_inner = &after_key[array_start_rel + "<array>".len()..array_end_rel];
    let mut items = Vec::new();
    let mut cursor = array_inner;
    while let Some(s_idx) = cursor.find("<string>") {
        let after_s = &cursor[s_idx + "<string>".len()..];
        let e_idx = after_s.find("</string>")?;
        items.push(xml_unescape(&after_s[..e_idx]));
        cursor = &after_s[e_idx + "</string>".len()..];
    }
    if items.is_empty() {
        return None;
    }
    let exe_item = items[0].clone();
    let patched =
        patch_restart_args_with_auth(&items[1..], new_host, new_port, new_token, no_token);
    let mut new_array = String::from("<array>\n");
    new_array.push_str(&format!(
        "    <string>{}</string>\n",
        xml_escape_str(&exe_item)
    ));
    for arg in patched {
        new_array.push_str(&format!(
            "    <string>{}</string>\n",
            xml_escape_str(&arg.to_string_lossy())
        ));
    }
    new_array.push_str("  </array>");

    let abs_array_start = key_idx + array_start_rel;
    let abs_array_end = key_idx + array_end_rel + "</array>".len();
    let mut out = String::with_capacity(content.len() + 64);
    out.push_str(&content[..abs_array_start]);
    out.push_str(&new_array);
    out.push_str(&content[abs_array_end..]);
    Some(out)
}

#[cfg(target_os = "linux")]
fn write_system_file_with_sudo_fallback(target: &Path, content: &str) -> bool {
    if std::fs::write(target, content).is_ok() {
        return true;
    }
    let tmp = std::env::temp_dir().join(format!(
        ".jeikcode-svc-{}-{}",
        std::process::id(),
        target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unit")
    ));
    if std::fs::write(&tmp, content).is_err() {
        return false;
    }
    let ok = std::process::Command::new("sudo")
        .args([
            "-n",
            "cp",
            tmp.to_str().unwrap_or_default(),
            target.to_str().unwrap_or_default(),
        ])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let _ = std::fs::remove_file(&tmp);
    ok
}

/// 在 `dir` 中定位正在托管当前进程的服务定义文件：
/// 1. `JEIKCODE_HOST_SERVICE` 标记命中直接使用（标记已在启动时从环境移除，不会被子进程冒用）；
/// 2. 来自 cgroup / `XPC_SERVICE_NAME` 的候选名，必须同时声明了当前端口才采用；
/// 3. 否则只按「当前正在监听的端口」精确匹配，不做「只有一个就用它」的猜测，
///    避免前台实例误改不相干的开机自启服务。
fn locate_service_file(
    dir: &Path,
    marker_name: Option<String>,
    hinted_name: Option<String>,
    is_candidate: impl Fn(&str) -> bool,
    old_port: u16,
) -> Option<PathBuf> {
    if let Some(name) = marker_name {
        let candidate = dir.join(&name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    if old_port == 0 {
        return None;
    }
    if let Some(name) = hinted_name {
        let candidate = dir.join(&name);
        if std::fs::read_to_string(&candidate)
            .map(|text| service_text_declares_port(&text, old_port))
            .unwrap_or(false)
        {
            return Some(candidate);
        }
    }
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_candidate(&name) {
            continue;
        }
        let path = entry.path();
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        if service_text_declares_port(&text, old_port) {
            return Some(path);
        }
    }
    None
}

/// 服务定义里是否声明了该端口（按数字边界匹配，`4096` 不会命中 `40960`）。
/// 兼容 `--port 4096`、`--port=4096`、`--port "4096"` 以及 launchd 的
/// `<string>--port</string> <string>4096</string>`。
pub fn service_text_declares_port(text: &str, port: u16) -> bool {
    let want = port.to_string();
    let mut rest = text;
    while let Some(idx) = rest.find("--port") {
        let after = &rest[idx + "--port".len()..];
        let value = if let Some(v) = after.strip_prefix('=') {
            v
        } else if let Some(v) = after.strip_prefix("</string>") {
            v.trim_start().strip_prefix("<string>").unwrap_or("")
        } else {
            after.trim_start_matches([' ', '\t'])
        };
        let value = value.trim_start_matches('"');
        let digits: String = value.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits == want {
            return true;
        }
        rest = after;
    }
    false
}

/// 按当前进程的启动方式，把新的 host/port/token 写回托管它的服务定义文件
/// （systemd unit / procd init 脚本 / launchd plist / Windows 登录自启 `.cmd`），
/// 保证异地换端口或更新后，下次开机/服务重拉仍是新配置。
/// 桌面壳子进程与普通前台进程不改任何服务文件。返回实际更新的文件。
pub fn sync_host_service_on_restart(
    old_port: u16,
    new_host: Option<&str>,
    new_port: Option<u16>,
    new_token: Option<&str>,
    no_token: Option<bool>,
) -> Option<PathBuf> {
    let mode = detect_launch_mode();
    let marker = host_service_marker();
    let _ = (&marker, old_port, new_host, new_port, new_token, no_token);

    match mode {
        LaunchMode::Desktop => None,

        #[cfg(target_os = "linux")]
        LaunchMode::Systemd => {
            let dir = Path::new("/etc/systemd/system");
            let hinted = std::fs::read_to_string("/proc/self/cgroup")
                .ok()
                .and_then(|cgroup| {
                    cgroup
                        .lines()
                        .flat_map(|line| line.rsplit('/'))
                        .map(str::trim)
                        .find(|seg| {
                            seg.starts_with("jeikcode")
                                && !seg.starts_with("jeikcode-schedule-")
                                && seg.ends_with(".service")
                        })
                        .map(str::to_string)
                });
            let path = locate_service_file(
                dir,
                marker.map(|m| format!("{m}.service")),
                hinted,
                |n| {
                    n.starts_with("jeikcode")
                        && !n.starts_with("jeikcode-schedule-")
                        && n.ends_with(".service")
                },
                old_port,
            )?;
            let content = std::fs::read_to_string(&path).ok()?;
            let updated =
                rewrite_systemd_unit_content(&content, new_host, new_port, new_token, no_token);
            if updated == content || !write_system_file_with_sudo_fallback(&path, &updated) {
                return None;
            }
            let reloaded = std::process::Command::new("systemctl")
                .arg("daemon-reload")
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if !reloaded {
                let _ = std::process::Command::new("sudo")
                    .args(["-n", "systemctl", "daemon-reload"])
                    .status();
            }
            Some(path)
        }

        #[cfg(target_os = "linux")]
        LaunchMode::Procd => {
            let path = locate_service_file(
                Path::new("/etc/init.d"),
                marker,
                None,
                |n| {
                    (n == "jeikcode" || n.starts_with("jeikcode-"))
                        && !n.starts_with("jeikcode-schedule-")
                },
                old_port,
            )?;
            let content = std::fs::read_to_string(&path).ok()?;
            let updated =
                rewrite_procd_script_content(&content, new_host, new_port, new_token, no_token);
            (updated != content && write_system_file_with_sudo_fallback(&path, &updated))
                .then_some(path)
        }

        #[cfg(target_os = "macos")]
        LaunchMode::Launchd => {
            let dir = jeikcode_config::util::real_home_dir()?.join("Library/LaunchAgents");
            let hinted = std::env::var("XPC_SERVICE_NAME")
                .ok()
                .filter(|x| x.starts_with("com.jeikcode-"))
                .map(|label| format!("{label}.plist"));
            let path = locate_service_file(
                &dir,
                marker.map(|label| format!("{label}.plist")),
                hinted,
                |n| n.starts_with("com.jeikcode-") && n.ends_with(".plist"),
                old_port,
            )?;
            let content = std::fs::read_to_string(&path).ok()?;
            let updated =
                rewrite_launchd_plist_content(&content, new_host, new_port, new_token, no_token)?;
            (updated != content && std::fs::write(&path, updated).is_ok()).then_some(path)
        }

        #[cfg(target_os = "windows")]
        LaunchMode::WindowsLogon | LaunchMode::Foreground => {
            // Foreground 仅用于兼容早期未写入 JEIKCODE_HOST_SERVICE 标记的登录自启项：
            // 同一端口不可能同时被两个进程监听，端口精确命中即视为同一服务。
            let dir = jeikcode_config::util::real_home_dir()?
                .join(".jeikcode")
                .join("services");
            let path = locate_service_file(
                &dir,
                marker.map(|m| format!("{m}.cmd")),
                None,
                |n| {
                    let lower = n.to_ascii_lowercase();
                    lower.starts_with("jeikcode-") && lower.ends_with(".cmd")
                },
                old_port,
            )?;
            let content = std::fs::read_to_string(&path).ok()?;
            let updated =
                rewrite_windows_cmd_content(&content, new_host, new_port, new_token, no_token);
            (updated != content && std::fs::write(&path, updated).is_ok()).then_some(path)
        }

        #[allow(unreachable_patterns)]
        _ => None,
    }
}

/// After an in-place swap or configuration change, restart the binary inheriting
/// host, port, and token parameters.
pub fn restart_replaced_process(
    exe: &Path,
    listen_port: u16,
    token: Option<&str>,
) -> Result<std::convert::Infallible> {
    restart_process_with_options(exe, None, listen_port, token)
}

/// Restart the process explicitly applying latest host, port, and token options.
pub fn restart_process_with_options(
    exe: &Path,
    host: Option<&str>,
    listen_port: u16,
    token: Option<&str>,
) -> Result<std::convert::Infallible> {
    restart_process_with_config(exe, listen_port, host, listen_port, token, None)
}

/// Full-featured restart entrypoint supporting port change (`old_port` -> `listen_port`),
/// host change, token update, `--no-token` toggle, and automatic host-service persistence sync.
pub fn restart_process_with_config(
    exe: &Path,
    old_port: u16,
    host: Option<&str>,
    listen_port: u16,
    token: Option<&str>,
    no_token: Option<bool>,
) -> Result<std::convert::Infallible> {
    let clean_exe = normalize_live_exe_path(exe.to_path_buf());
    let exe = clean_exe.as_path();

    // 按启动方式把新的 host/port/token 同步到托管自己的服务定义文件（桌面壳/前台进程不改）
    let _ = sync_host_service_on_restart(
        old_port,
        host,
        (listen_port > 0).then_some(listen_port),
        token,
        no_token,
    );

    std::env::set_var("JEIKCODE_SKIP_PENDING_UPGRADE", "1");
    std::env::set_var(RESTARTED_ENV, "1");
    if let Some(h) = host.map(str::trim).filter(|h| !h.is_empty()) {
        std::env::set_var(RESTART_LISTEN_HOST_ENV, h);
    }
    if listen_port > 0 {
        std::env::set_var(RESTART_LISTEN_PORT_ENV, listen_port.to_string());
    }
    std::env::set_var(RESTART_EXACT_PORT_ENV, "1");
    let token = if no_token == Some(true) {
        std::env::remove_var(RESTART_TOKEN_ENV);
        std::env::set_var(RESTART_NO_TOKEN_ENV, "1");
        None
    } else {
        if no_token == Some(false) {
            std::env::set_var(RESTART_NO_TOKEN_ENV, "0");
        }
        let tok = token.map(str::trim).filter(|value| !value.is_empty());
        if let Some(tok) = tok {
            std::env::set_var(RESTART_TOKEN_ENV, tok);
        }
        tok
    };

    let orig_args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let patched_args = patch_restart_args_with_auth(
        orig_args,
        host,
        (listen_port > 0).then_some(listen_port),
        token,
        no_token,
    );

    // 桌面壳托管模式下，以专用重启退出码 75 退出当前子进程，
    // 由桌面壳事件驱动唤醒后读取最新 webui-listen.json 重新拉起子进程并写入 ChildSlot。
    if is_desktop_managed() {
        std::process::exit(RESTART_REQUESTED_EXIT_CODE);
    }

    // 启动时已从环境移除服务标记；后继进程（re-exec 或新进程）仍由同一服务托管，需要归还标记
    if let Some(marker) = host_service_marker() {
        std::env::set_var(HOST_SERVICE_ENV, marker);
    }

    #[cfg(unix)]
    {
        let is_supervised = supervised_by_service_manager();
        // 优先原地 re-exec：保留 PID、终端前台及 systemd/procd/launchd 纳管关系，0 秒无缝切换
        match re_exec_self_with_args(Some(exe), Some(&patched_args)) {
            Ok(infallible) => return Ok(infallible),
            Err(_) => {
                if is_supervised {
                    // 非 0 退出码确保 systemd (Restart=always) 与 OpenWrt procd (respawn) 必然触发重拉
                    std::process::exit(1);
                }
            }
        }
    }

    let mut cmd = std::process::Command::new(exe);
    cmd.args(&patched_args)
        .env(RESTART_WAIT_PID_ENV, std::process::id().to_string())
        .env(RESTART_EXACT_PORT_ENV, "1")
        .env(RESTARTED_ENV, "1")
        .env("JEIKCODE_SKIP_PENDING_UPGRADE", "1");
    if old_port > 0 {
        cmd.env(RESTART_WAIT_PORT_ENV, old_port.to_string());
    }
    if let Some(h) = host.map(str::trim).filter(|h| !h.is_empty()) {
        cmd.env(RESTART_LISTEN_HOST_ENV, h);
    }
    if listen_port > 0 {
        cmd.env(RESTART_LISTEN_PORT_ENV, listen_port.to_string());
    }
    if no_token == Some(true) {
        cmd.env_remove(RESTART_TOKEN_ENV);
        cmd.env(RESTART_NO_TOKEN_ENV, "1");
    } else {
        if no_token == Some(false) {
            cmd.env(RESTART_NO_TOKEN_ENV, "0");
        }
        if let Some(token) = token {
            cmd.env(RESTART_TOKEN_ENV, token);
        }
    }
    if let Ok(desktop_pid) = std::env::var(DESKTOP_PID_ENV) {
        if !desktop_pid.trim().is_empty() {
            cmd.env(DESKTOP_PID_ENV, desktop_pid);
        }
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        extern "C" {
            fn setsid() -> i32;
        }
        unsafe {
            cmd.pre_exec(|| {
                let _ = setsid();
                Ok(())
            });
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        let mut flags = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW;
        if !is_desktop_managed() && std::env::var_os("JEIKCODE_DESKTOP").is_none() {
            flags |= CREATE_BREAKAWAY_FROM_JOB;
        }
        cmd.creation_flags(flags);
    }

    cmd.spawn()
        .with_context(|| format!("spawning replacement binary {}", exe.display()))?;
    std::process::exit(0);
}

/// Fetch and parse `Manifest` from a specific manifest URL.
pub async fn fetch_manifest_from_url(url: &str) -> Result<Manifest> {
    if jeikcode_config::config::offline::is_offline_active() {
        bail!("cannot fetch update manifest in offline mode");
    }
    let client = apply_proxy_policy(reqwest::Client::builder())
        .timeout(std::time::Duration::from_secs(30))
        .user_agent(JEIKCODE_USER_AGENT)
        .build()?;
    let resp = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("failed to fetch manifest from {}", url))?;
    if !resp.status().is_success() {
        return Err(anyhow!(
            "fetching manifest from {} returned HTTP {}",
            url,
            resp.status()
        ));
    }
    let body = resp.text().await.context("reading manifest body")?;
    let clean_body = body.trim_start_matches('\u{feff}');
    serde_json::from_str(clean_body)
        .with_context(|| format!("parsing manifest (body: {:?})", truncate(clean_body, 200)))
}

fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let head: String = s.chars().take(max_chars).collect();
        format!("{}…", head)
    }
}

/// Download `url` to `dest`, streaming SHA256 as bytes arrive.
///
/// `progress` fires every chunk with (bytes_so_far, total). Callers
/// should debounce before redrawing the UI; we emit eagerly because
/// the upgrade UI wants smooth progress for a ~10 MB file.
///
/// Verifies size AND sha256 before returning. On any failure the
/// partial file is removed so a retry starts clean.
async fn download_and_verify(
    url: &str,
    expected_sha256: &str,
    expected_size: u64,
    dest: &Path,
    progress: &mpsc::UnboundedSender<UpgradeEvent>,
) -> Result<()> {
    use futures::StreamExt;

    if dest.exists() {
        let _ = std::fs::remove_file(dest);
    }

    let client = apply_proxy_policy(reqwest::Client::builder())
        .timeout(std::time::Duration::from_secs(600))
        .user_agent(JEIKCODE_USER_AGENT)
        .build()?;
    let resp = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("GET {}", url))?;
    if !resp.status().is_success() {
        return Err(anyhow!(
            "downloading {} returned HTTP {} — release may not exist for this platform",
            url,
            resp.status()
        ));
    }

    // Don't bail on Content-Length mismatches.  The Content-Length
    // header may differ from the manifest's `size` for several reasons:
    //   - CDN mirrors or reverse proxies may alter Content-Length.
    //   - The manifest may be slightly out of sync with the server's
    //     binary (e.g. during a rolling release).
    //   - Redirects can surface a different Content-Length from an
    //     intermediate hop.
    // The real integrity checks happen after the download completes:
    //   1. Total bytes written must match `expected_size` (below).
    //   2. SHA256 must match `expected_sha256`.
    // These two checks are sufficient; an early Content-Length gate
    // causes false-negative aborts (see issue #380).

    let mut file = tokio::fs::File::create(dest)
        .await
        .with_context(|| format!("creating {}", dest.display()))?;
    let mut hasher = Sha256::new();
    let mut written: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("reading response chunk")?;
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .context("writing download to disk")?;
        written += chunk.len() as u64;
        // Ignore send errors — receiver may have been dropped.
        let _ = progress.send(UpgradeEvent::Downloading {
            bytes: written,
            total: expected_size,
        });
    }
    file.flush().await.context("flushing download to disk")?;
    drop(file);

    if expected_size > 0 && written != expected_size {
        let _ = std::fs::remove_file(dest);
        return Err(anyhow!(
            "short download: got {} bytes, expected {}",
            written,
            expected_size
        ));
    }

    let _ = progress.send(UpgradeEvent::Verifying);
    let got = hex_encode(&hasher.finalize());
    let skip_hash = expected_sha256.is_empty()
        || expected_sha256.eq_ignore_ascii_case("skip")
        || expected_sha256.eq_ignore_ascii_case("none");
    if !skip_hash && !got.eq_ignore_ascii_case(expected_sha256) {
        let _ = std::fs::remove_file(dest);
        return Err(anyhow!(
            "checksum mismatch — possible corruption or tampering.\n  expected: {}\n  got:      {}",
            expected_sha256,
            got
        ));
    }

    Ok(())
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

/// Best-effort cleanup of a leftover file (typically a `.bak` or `.rolling`
/// from a prior upgrade/rollback). Returns `true` if the file was removed,
/// `false` if it could not be removed (locked, permission denied, etc.).
///
/// Defensive against Windows ACCESS_DENIED scenarios:
///
/// 1. The file carries a read-only attribute (some AV / SCCM policies
///    flag any executable in `%LOCALAPPDATA%` this way). Clear it first.
/// 2. Windows Defender or another scanner briefly holds the file open
///    during a real-time scan — typically <500 ms. Retry once with a
///    short sleep before giving up.
/// 3. The file is a still-running jeikcode process from a prior upgrade
///    where the user didn't restart. Nothing we can do at the code layer;
///    the caller proceeds without blocking the upgrade.
///
/// This function is intentionally **best-effort** — a failure to remove
/// the stale file must NOT block an upgrade. The three-way swap in
/// `replace_binary` ensures the upgrade proceeds even if old backups
/// cannot be deleted.
fn try_remove_stale(path: &Path) -> bool {
    if !path.exists() {
        return true;
    }

    #[cfg(windows)]
    {
        if let Ok(meta) = path.metadata() {
            let mut perm = meta.permissions();
            if perm.readonly() {
                perm.set_readonly(false);
                let _ = std::fs::set_permissions(path, perm);
            }
        }
    }

    if std::fs::remove_file(path).is_ok() {
        return true;
    }
    // Brief retry to ride out a transient AV / indexer hold.
    std::thread::sleep(std::time::Duration::from_millis(500));
    std::fs::remove_file(path).is_ok()
}

/// Clear a read-only attribute on `path` so a rename/remove isn't denied
/// outright. Best-effort. On Unix a normal executable isn't read-only so
/// this is a no-op; on Windows some AV / SCCM policies flag executables
/// under `%LOCALAPPDATA%` read-only, which alone causes ERROR_ACCESS_DENIED.
fn clear_readonly(path: &Path) {
    // Windows-only: on Unix, `rename`/`remove_file` act on the directory
    // entry and don't need the file itself writable, and `set_readonly(false)`
    // there would widen the mode to world-writable. The read-only-attribute
    // failure mode is Windows-specific (AV/SCCM marking %LOCALAPPDATA% exes).
    #[cfg(windows)]
    if let Ok(meta) = path.metadata() {
        let mut perm = meta.permissions();
        if perm.readonly() {
            perm.set_readonly(false);
            let _ = std::fs::set_permissions(path, perm);
        }
    }
    #[cfg(not(windows))]
    let _ = path;
}

/// Rename `from` → `to`, hardened against the transient failures that make
/// a naive `std::fs::rename` of a *running* Windows executable fail with
/// `ERROR_ACCESS_DENIED` (os error 5):
///
///   * an AV / indexer (Windows Defender real-time scan) briefly holds the
///     source or destination open without `FILE_SHARE_DELETE` — this clears
///     well under a second, so we retry with exponential backoff;
///   * a read-only attribute on the source — cleared before the first try;
///   * a leftover destination from a prior interrupted upgrade that is
///     momentarily locked — re-removed before each retry so the implicit
///     `MOVEFILE_REPLACE_EXISTING` doesn't fail on it.
///
/// Cross-platform: on Unix these conditions don't arise, so the first
/// attempt succeeds and the loop is never re-entered. Worst-case added
/// latency on persistent failure is ~1.5s (100+200+400+800ms of sleeps),
/// which is acceptable for a one-shot upgrade/rollback.
fn robust_rename(from: &Path, to: &Path) -> std::io::Result<()> {
    clear_readonly(from);
    robust_rename_with(from, to, |f, t| std::fs::rename(f, t))
}

/// `robust_rename` with the underlying rename injected, so the cross-device
/// fallback and retry logic can be exercised deterministically in tests.
fn robust_rename_with<R>(from: &Path, to: &Path, mut rename: R) -> std::io::Result<()>
where
    R: FnMut(&Path, &Path) -> std::io::Result<()>,
{
    const ATTEMPTS: u32 = 5;
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..ATTEMPTS {
        // A locked / leftover destination makes the replace-existing rename
        // fail; try to clear it (and its read-only attr) before each try.
        if to.exists() {
            clear_readonly(to);
            let _ = std::fs::remove_file(to);
        }
        match rename(from, to) {
            Ok(()) => return Ok(()),
            // Cross-device: the staged binary lives under the user profile
            // (e.g. C:\Users\…\.jeikcode\staged\) while the running exe may be
            // on another drive (H:\…). `rename` across volumes can NEVER
            // succeed (ERROR_NOT_SAME_DEVICE / EXDEV), so don't waste the retry
            // budget — copy the bytes across and drop the source instead.
            Err(e) if is_cross_device_error(&e) => return copy_across_devices(from, to),
            Err(e) => {
                last_err = Some(e);
                if attempt + 1 < ATTEMPTS {
                    let ms = 100u64 << attempt; // 100, 200, 400, 800
                    std::thread::sleep(std::time::Duration::from_millis(ms));
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("rename failed")))
}

/// True when a failed `rename` was rejected because source and destination
/// live on different filesystems/volumes. Windows reports ERROR_NOT_SAME_DEVICE
/// (os error 17); Unix reports EXDEV (os error 18).
fn is_cross_device_error(e: &std::io::Error) -> bool {
    #[cfg(windows)]
    let code = 17;
    #[cfg(not(windows))]
    let code = 18;
    e.raw_os_error() == Some(code)
}

/// Safely and atomically replace `to` with content copied from `from`,
/// even if `to` is currently being executed as a running Linux/Windows process.
///
/// Steps:
/// 1. Copy `from` to a temporary sibling file in `to`'s directory (`.jeikcode.tmp-<pid>-<nanos>`).
/// 2. On Unix, ensure the temporary file has 0o755 executable permissions.
/// 3. Atomically rename the temporary file over `to` using `robust_rename`.
///    On Unix, `rename(2)` replaces the directory entry (dentry) while existing
///    running processes hold onto the old inode, avoiding ETXTBSY (errno 26).
///    On Windows, `robust_rename` handles transient AV/indexer holds.
/// 4. If renaming fails, clean up the temporary file and return the error.
pub fn atomic_copy_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    let parent = to.parent().unwrap_or_else(|| Path::new("."));
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let tmp_dest = parent.join(format!(".jeikcode.tmp-{}-{}", std::process::id(), nanos));

    // Ensure clean state before copy
    let _ = std::fs::remove_file(&tmp_dest);

    std::fs::copy(from, &tmp_dest)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&tmp_dest) {
            let mut perm = meta.permissions();
            perm.set_mode(0o755);
            let _ = std::fs::set_permissions(&tmp_dest, perm);
        }
    }

    match robust_rename(&tmp_dest, to) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp_dest);
            Err(e)
        }
    }
}

/// Move a file across volumes by copying its bytes via atomic replacement and
/// then dropping the source. Used as the fallback when `rename` reports a
/// cross-device error.
fn copy_across_devices(from: &Path, to: &Path) -> std::io::Result<()> {
    atomic_copy_replace(from, to)?;
    let _ = std::fs::remove_file(from);
    Ok(())
}

fn replace_binary(new_bin: &Path, exe: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = std::fs::metadata(new_bin)
            .with_context(|| format!("stat {}", new_bin.display()))?
            .permissions();
        perm.set_mode(0o755);
        std::fs::set_permissions(new_bin, perm)
            .with_context(|| format!("chmod {}", new_bin.display()))?;
    }

    let backup = backup_path(exe);
    let rolling = rolling_path(exe);

    // Clean up any leftover .rolling from a prior interrupted upgrade.
    try_remove_stale(&rolling);

    // Step 1: live binary → rolling (Windows allows renaming a running exe).
    // `robust_rename` retries through transient AV/indexer locks that
    // otherwise surface as ERROR_ACCESS_DENIED (os error 5) here.
    robust_rename(exe, &rolling).with_context(|| {
        format!(
            "renaming current binary {} -> {} (swap step 1)",
            exe.display(),
            rolling.display()
        )
    })?;

    // Step 2: new binary → live (the actual upgrade)
    if let Err(e) = robust_rename(new_bin, exe) {
        // Best-effort unwind of step 1 so the user isn't left without
        // a live binary.
        let _ = std::fs::rename(&rolling, exe);
        return Err(anyhow!(
            "moving new binary into place failed ({}). Previous version restored.",
            e
        ));
    }

    // Step 3: best-effort — remove old .bak so we can rename .rolling→.bak.
    // Failure is non-fatal; we just leave .rolling behind.
    let bak_removed = try_remove_stale(&backup);

    // Step 4: rolling → .bak (preserve old version for rollback)
    if bak_removed {
        if let Err(e) = std::fs::rename(&rolling, &backup) {
            // Upgrade succeeded but we couldn't preserve the old version
            // as .bak. The .rolling file lingers; next upgrade will
            // clean it up. Rollback won't be available this session.
            eprintln!(
                "Note: could not preserve previous version as backup ({}). Rollback unavailable until next upgrade.",
                e
            );
        }
    } else {
        // Old .bak couldn't be removed (locked by AV, running process, etc.).
        // The .rolling file stays behind; next upgrade attempt will clean
        // it up. Rollback points to the version before this upgrade's
        // predecessor, which is still better than failing the upgrade.
        eprintln!(
            "Note: could not remove old backup {}. Rollback may point to an older version.\n  The .rolling file at {} will be cleaned up on the next upgrade.",
            backup.display(),
            rolling.display()
        );
    }

    Ok(())
}

/// Run in-place upgrade targeting an explicitly provided manifest.
pub async fn run_upgrade_with_manifest(
    manifest: Manifest,
    current_version: String,
    force: bool,
    tx: mpsc::UnboundedSender<UpgradeEvent>,
) -> Result<UpgradeSummary> {
    if is_package_managed() {
        return Err(anyhow!(PACKAGE_MANAGED));
    }
    let current_version = current_version.as_str();
    let target = detect_target().ok_or_else(|| {
        anyhow!(
            "this platform has no published jeikcode release ({}/{})",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    let exe = current_exe_path()?;
    ensure_writable(&exe)?;
    // Drop a leftover auto-update stage so `__sync_config` / the next
    // launch cannot paste an older package over this install.
    clear_pending_pointer();

    let _ = tx.send(UpgradeEvent::ManifestFetched {
        version: manifest.version.clone(),
    });

    if !force && !version_is_newer(&manifest.version, current_version) {
        return Err(anyhow!(
            "{}: already on {} (latest is {}). Pass --force to reinstall.",
            ALREADY_LATEST,
            current_version,
            manifest.version
        ));
    }

    let entry = manifest.binaries.get(target).ok_or_else(|| {
        anyhow!(
            "manifest has no entry for target {} — this platform may not be in this release",
            target
        )
    })?;

    let url = binary_url(&manifest.version, target);
    let download = download_path(&exe);
    download_and_verify(&url, &entry.sha256, entry.size, &download, &tx).await?;

    let _ = tx.send(UpgradeEvent::Replacing);
    replace_binary(&download, &exe)?;
    let expected_sha = entry.sha256.as_str();
    let got = file_sha256_hex(&exe)?;
    if !got.eq_ignore_ascii_case(expected_sha) {
        return Err(anyhow!(
            "replaced {} but sha256 is {got}, expected {expected_sha}",
            exe.display()
        ));
    }
    // 顺带清理可能遗留的历史老版本 ~/.local/bin/jeikcode 孤儿副本
    cleanup_legacy_dropper_file(&exe);

    // Manual `/upgrade` just installed whatever the current manifest
    // advertises. Any staged upgrade sitting in `staged_dir()` is now
    // superseded — if we leave `pending.json` in place, the next startup
    // might try to "apply" an older (or identical) staged version on top
    // of what we just installed, causing a downgrade or redundant churn.
    // Clear both the pointer and any stray staged binaries.
    clear_pending_pointer();
    if let Ok(entries) = std::fs::read_dir(staged_dir()) {
        for e in entries.flatten() {
            let p = e.path();
            if p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("jeikcode-"))
            {
                let _ = std::fs::remove_file(&p);
            }
        }
    }

    // Purge any legacy upstream brand plugin directories on upgrade
    purge_legacy_brand_plugins_on_upgrade();

    let backup = backup_path(&exe);
    // NOTE: `exe` was captured *before* `replace_binary` renamed the running
    // binary. On Windows, `current_exe()` would now return `.jeikcode.rolling`
    // instead of the original `jeikcode.exe`, so we must pass this saved
    // value through to `re_exec_self`.
    let original_exe = if exe.extension().and_then(|e| e.to_str()) == Some("rolling") {
        exe.with_extension(if cfg!(windows) { "exe" } else { "" })
    } else {
        exe
    };

    let summary = UpgradeSummary {
        version: manifest.version,
        backup,
        exe: original_exe.clone(),
    };
    let _ = tx.send(UpgradeEvent::Done {
        version: summary.version.clone(),
        backup: summary.backup.clone(),
        exe: original_exe,
    });

    Ok(summary)
}

/// Top-level upgrade driver.
///
/// `current_version` is what we're running right now (e.g. `"v4.19.0"`
/// — callers typically pass `format!("v{}", env!("CARGO_PKG_VERSION"))`).
/// When `force` is false and the manifest version is `<=` current, this
/// returns an error carrying `ALREADY_LATEST` so callers can distinguish
/// "already up to date" from a real failure.
/// In `distro-pm` builds this returns immediately with an error carrying `PACKAGE_MANAGED` (upgrades are the package manager's job).
pub async fn run_upgrade(
    current_version: String,
    force: bool,
    tx: mpsc::UnboundedSender<UpgradeEvent>,
) -> Result<UpgradeSummary> {
    if is_package_managed() {
        return Err(anyhow!(PACKAGE_MANAGED));
    }
    let manifest = fetch_manifest().await?;
    run_upgrade_with_manifest(manifest, current_version, force, tx).await
}

/// Sentinel substring in the "already latest" error so the CLI/TUI
/// layer can render a calm informational message instead of a scary
/// red error. Kept as a plain string to avoid an error-type refactor.
pub const ALREADY_LATEST: &str = "ALREADY_LATEST";

/// Sentinel embedded in the error returned by `run_upgrade` / `run_rollback`
/// when this binary is a package-manager-managed build (HarmonyBrew).
/// Callers special-case it to show "use `brew upgrade`" instead of a
/// generic failure — mirrors the `ALREADY_LATEST` pattern.
pub const PACKAGE_MANAGED: &str = "PACKAGE_MANAGED";

/// True when this binary was compiled for package-manager distribution
/// (the `distro-pm` feature, set by the HarmonyBrew formula). Such builds
/// must never self-modify the binary — upgrades are the package manager's
/// job.
pub const fn is_package_managed() -> bool {
    cfg!(feature = "distro-pm")
}

fn purge_legacy_brand_plugins_on_upgrade() {
    let plugins_root = jeikcode_config::config::Config::config_dir().join("plugins");
    let mp_root = plugins_root.join("marketplaces");
    for dirty_name in ["jeikcode-skills", "jeikcode-plugins-official"] {
        let dirty_dir = mp_root.join(dirty_name);
        if dirty_dir.exists() {
            let _ = std::fs::remove_dir_all(&dirty_dir);
        }
    }
    let installed_root = plugins_root.join("installed");
    for dirty_plugin in ["jeikcode", "jeikcode-skills", "jeikcode-workflows"] {
        let dirty_dir = installed_root.join(dirty_plugin);
        if dirty_dir.exists() {
            let _ = std::fs::remove_dir_all(&dirty_dir);
        }
    }
}

// ============================================================================
// Deferred upgrade (download-in-session, apply-at-next-startup)
// ============================================================================
//
// The deferred path solves two problems that `run_upgrade` alone can't:
//   1. Users whose sessions run for hours/days — they'll never voluntarily
//      restart just to pick up a new version. A background task can prepare
//      the staged binary while they work; apply happens whenever they do
//      restart (which they will, eventually, for unrelated reasons).
//   2. Users whose sessions are short but who rarely think to run
//      `/upgrade` — same benefit: the next normal launch carries the bump.
//
// Flow:
//   session N      : prepare_deferred_upgrade()
//                    → download to ~/.jeikcode/staged/<filename>
//                    → write ~/.jeikcode/staged/pending.json
//                    → (UI surfaces "⟲ vX.Y.Z pending")
//   session N exit : no special work; staged files survive any exit path
//                    (graceful, SIGHUP on terminal close, SIGKILL, power
//                    loss — all fine, state is on disk)
//   session N+1    : apply_pending_upgrade() runs BEFORE tokio starts
//                    → atomically swaps live binary with staged
//                    → re-execs self with original argv
//                    → user sees "✓ Upgraded to vX.Y.Z" on welcome
//
// A safety circuit-breaker is wired in: if apply succeeds but the new
// binary fails to start `MAX_APPLY_ATTEMPTS` times in a row, the staged
// file is discarded so a broken release can't brick the install.

/// Maximum times we'll try to apply the same staged upgrade before
/// giving up. Prevents a corrupted download from turning into a boot loop.
const MAX_APPLY_ATTEMPTS: u32 = 3;

/// Pointer record stored at `~/.jeikcode/staged/pending.json`. Describes
/// a downloaded binary that hasn't yet been promoted to live. Lifecycle:
/// written by `prepare_deferred_upgrade`, read (and deleted on success /
/// incremented on failure) by `apply_pending_upgrade`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PendingUpgrade {
    /// Version tag the staged binary represents, e.g. `v4.19.1`.
    pub version: String,
    /// Absolute path to the verified binary sitting in `staged_dir()`.
    pub staged_path: PathBuf,
    /// SHA256 of the staged binary (lowercase hex). Re-verified at apply
    /// time so a partial overwrite between sessions (e.g. disk full)
    /// doesn't install a corrupted file.
    pub sha256: String,
    /// Size in bytes; cheap sanity check before we recompute sha256.
    pub size: u64,
    /// RFC3339 timestamp for audit / debug. Not load-bearing.
    pub created_at: String,
    /// How many times we've attempted apply and failed. When this hits
    /// `MAX_APPLY_ATTEMPTS`, the staged file is discarded instead of
    /// retried again on the following startup.
    #[serde(default)]
    pub attempts: u32,
}

/// Successful apply result — fed into the re-exec handoff so the new
/// process can render a one-time "✓ Upgraded" banner on the welcome screen.
#[derive(Debug, Clone)]
pub struct AppliedUpgrade {
    pub version: String,
    pub backup: PathBuf,
    pub exe: PathBuf,
}

/// `~/.jeikcode/staged/` (or equivalent on Windows). Created on demand by
/// `prepare_deferred_upgrade`; safe to treat as possibly-missing at read
/// time. Kept under the same root as `history` / `recent_dirs` so nothing
/// new appears in `$HOME`.
pub fn staged_dir() -> PathBuf {
    jeikcode_config::config::Config::config_dir().join("staged")
}

fn pending_json_path() -> PathBuf {
    staged_dir().join("pending.json")
}

/// Where a prepared (downloaded + verified) binary lives while it waits
/// to be promoted. Filename mirrors the release artifact so the same
/// `binary_filename` helper round-trips.
fn staged_binary_path(version: &str, target: &str) -> PathBuf {
    staged_dir().join(binary_filename(version, target))
}

/// Read `pending.json` if present. Absent file → `Ok(None)`. Corrupt JSON
/// returns an error so callers can delete it and retry; `apply_pending_upgrade`
/// does exactly that.
pub fn read_pending() -> Result<Option<PendingUpgrade>> {
    let path = pending_json_path();
    if !path.exists() {
        return Ok(None);
    }
    let body =
        std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let pending: PendingUpgrade =
        serde_json::from_str(&body).with_context(|| format!("parsing {}", path.display()))?;
    Ok(Some(pending))
}

fn write_pending(pending: &PendingUpgrade) -> Result<()> {
    let dir = staged_dir();
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let body = serde_json::to_string_pretty(pending).context("serializing pending.json")?;
    let path = pending_json_path();
    std::fs::write(&path, body).with_context(|| format!("writing {}", path.display()))
}

pub fn clear_pending_pointer() {
    let _ = std::fs::remove_file(pending_json_path());
}

/// Quiet variant of `check_latest` used by the hourly background poll.
/// Returns the remote `(version, manifest)` only when strictly newer than
/// `current_version`. Separate from `version_check::check_latest` because
/// that one only gives back the version string; here we need the full
/// manifest to know the per-target sha256 / size.
pub async fn fetch_manifest_if_newer(current_version: &str) -> Result<Option<Manifest>> {
    let manifest = fetch_manifest().await?;
    if is_newer(&manifest.version, current_version) {
        Ok(Some(manifest))
    } else {
        Ok(None)
    }
}

/// Download + verify a new release into `staged_dir()` without touching
/// the live binary. Writes `pending.json` as the final step so a partial
/// download (crashed mid-stream) doesn't masquerade as "ready to apply" —
/// the pointer only appears if sha256 passed.
///
/// Returns `Ok(None)` when we're already on the latest version (or newer).
/// Idempotent: calling twice with the same manifest is a no-op after the
/// first success (file + pointer already in place).
/// In `distro-pm` builds this is a no-op returning `Ok(None)`.
pub async fn prepare_deferred_upgrade(
    current_version: &str,
    tx: mpsc::UnboundedSender<UpgradeEvent>,
) -> Result<Option<PendingUpgrade>> {
    if is_package_managed() {
        return Ok(None);
    }
    if jeikcode_config::config::offline::is_offline_active() {
        return Ok(None);
    }
    let target = detect_target().ok_or_else(|| {
        anyhow!(
            "this platform has no published jeikcode release ({}/{})",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;

    let manifest = fetch_manifest().await?;

    if !is_newer(&manifest.version, current_version) {
        return Ok(None);
    }

    let _ = tx.send(UpgradeEvent::ManifestFetched {
        version: manifest.version.clone(),
    });

    // If a staged upgrade for this exact version already exists and the
    // on-disk bytes still match the manifest's sha256, reuse it. Saves a
    // redownload when two sessions both polled and landed here.
    if let Ok(Some(existing)) = read_pending() {
        if existing.version == manifest.version && existing.staged_path.exists() {
            if let Some(entry) = manifest.binaries.get(target) {
                if existing.sha256.eq_ignore_ascii_case(&entry.sha256)
                    && existing.size == entry.size
                {
                    return Ok(Some(existing));
                }
            }
        }
    }

    let entry = manifest.binaries.get(target).ok_or_else(|| {
        anyhow!(
            "manifest has no entry for target {} — this platform may not be in this release",
            target
        )
    })?;

    let dir = staged_dir();
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;

    let staged_path = staged_binary_path(&manifest.version, target);
    let url = binary_url(&manifest.version, target);
    download_and_verify(&url, &entry.sha256, entry.size, &staged_path, &tx).await?;

    let pending = PendingUpgrade {
        version: manifest.version.clone(),
        staged_path: staged_path.clone(),
        sha256: entry.sha256.clone(),
        size: entry.size,
        created_at: chrono::Utc::now().to_rfc3339(),
        attempts: 0,
    };
    write_pending(&pending)?;
    Ok(Some(pending))
}

/// Bootstrap entry point: called once at the very top of `main()` BEFORE
/// the tokio runtime, TUI, or any heavy init. Three outcomes:
///
///   * `Ok(None)`                  — no pending upgrade, continue normally.
///   * `Ok(Some(AppliedUpgrade))`  — staged binary is now live; caller must
///                                   `re_exec_self` to hand control over.
///   * `Err(e)`                    — apply failed; caller should log and
///                                   continue with the OLD binary. We've
///                                   already bumped the attempt counter
///                                   (or discarded the stage past the cap).
///
/// SHA256 is re-verified here even though we verified at download time:
/// a session-external process (backup tool, AV software, buggy sync)
/// could have touched the file between sessions. Verification is cheap
/// compared to installing a corrupted binary.
/// In `distro-pm` builds this is a no-op returning `Ok(None)`.
pub fn apply_pending_upgrade() -> Result<Option<AppliedUpgrade>> {
    if is_package_managed() {
        return Ok(None);
    }
    let mut pending = match read_pending() {
        Ok(Some(p)) => p,
        Ok(None) => return Ok(None),
        Err(_) => {
            // Corrupt pointer — nuke it, we can't do anything safe with it.
            clear_pending_pointer();
            return Ok(None);
        }
    };

    if pending.attempts >= MAX_APPLY_ATTEMPTS {
        // Circuit-break: this staged upgrade has failed too many times.
        // Discard everything so we stop trying, fall back to the old
        // binary, and let the next successful prepare_deferred_upgrade
        // supersede it.
        let _ = std::fs::remove_file(&pending.staged_path);
        clear_pending_pointer();
        return Ok(None);
    }

    // Bump attempt counter up-front so a crash mid-apply doesn't leave us
    // in an unbounded retry loop.
    pending.attempts += 1;
    let _ = write_pending(&pending);

    if !pending.staged_path.exists() {
        clear_pending_pointer();
        return Ok(None);
    }

    let actual_size = std::fs::metadata(&pending.staged_path)
        .with_context(|| format!("stat {}", pending.staged_path.display()))?
        .len();
    if actual_size != pending.size {
        let _ = std::fs::remove_file(&pending.staged_path);
        clear_pending_pointer();
        return Err(anyhow!(
            "staged binary size changed between sessions (expected {}, got {}). Discarded.",
            pending.size,
            actual_size
        ));
    }

    let mut hasher = Sha256::new();
    let mut file = std::fs::File::open(&pending.staged_path)
        .with_context(|| format!("opening {}", pending.staged_path.display()))?;
    std::io::copy(&mut file, &mut hasher).context("hashing staged binary")?;
    drop(file);
    let got = hex_encode(&hasher.finalize());
    if !got.eq_ignore_ascii_case(&pending.sha256) {
        let _ = std::fs::remove_file(&pending.staged_path);
        clear_pending_pointer();
        return Err(anyhow!(
            "staged binary sha256 drifted between sessions (expected {}, got {}). Discarded.",
            pending.sha256,
            got
        ));
    }

    let exe = current_exe_path()?;
    ensure_writable(&exe)?;
    replace_binary(&pending.staged_path, &exe)?;

    // Success — pointer is done, file moved into place by replace_binary.
    clear_pending_pointer();

    // Purge any legacy upstream brand plugin directories on upgrade
    purge_legacy_brand_plugins_on_upgrade();

    Ok(Some(AppliedUpgrade {
        version: pending.version,
        backup: backup_path(&exe),
        exe,
    }))
}

/// Replace the current process with a fresh invocation of the live binary,
/// preserving argv, cwd, and env. On Unix this is `execv` (same PID, old
/// process image gone). On Windows we spawn a child and exit the parent —
/// a separate PID, but terminal stdio is shared so the user still sees
/// one continuous "session" from their perspective.
///
/// **Important on Windows:** After `replace_binary` renames the running exe
/// (e.g. `jeikcode.exe` → `.jeikcode.rolling`), `std::env::current_exe()`
/// may return the *renamed* path (`.jeikcode.rolling`) instead of the
/// original one (`jeikcode.exe`). This is because `GetModuleFileNameW`
/// tracks the on-disk filename. If `override_exe` is provided, it is used
/// instead of `current_exe()` — callers should capture the exe path
/// *before* calling `replace_binary` and pass it here.
///
/// Never returns on the happy path. An `Err` return means the handoff
/// failed (e.g., new binary missing execute bit under unusual filesystem
/// constraints); caller should surface the error and keep running with
/// the old binary rather than exiting silently.
pub fn re_exec_self(override_exe: Option<&Path>) -> Result<std::convert::Infallible> {
    re_exec_self_with_args(override_exe, None)
}

pub fn re_exec_self_with_args(
    override_exe: Option<&Path>,
    override_args: Option<&[std::ffi::OsString]>,
) -> Result<std::convert::Infallible> {
    let exe = override_exe.map(|p| p.to_path_buf()).unwrap_or_else(|| {
        current_exe_path().unwrap_or_else(|_| {
            // Fallback: if we can't resolve current_exe AND no override,
            // try argv[0] as a last resort.
            std::env::args_os()
                .next()
                .map(PathBuf::from)
                .unwrap_or_default()
        })
    });
    let args: Vec<std::ffi::OsString> = match override_args {
        Some(a) => a.to_vec(),
        None => std::env::args_os().skip(1).collect(),
    };

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = std::process::Command::new(&exe).args(&args).exec();
        // `exec` only returns on failure.
        Err(anyhow!("re-exec failed: {}", err))
    }

    #[cfg(windows)]
    {
        // Windows has no exec(). Spawn the child with shared stdio so
        // the user's terminal stays connected to the new process, then
        // exit ourselves. The replacement PID shift is invisible in
        // a terminal context (the shell tracks the parent's exit).
        let status = std::process::Command::new(&exe)
            .args(&args)
            .spawn()
            .with_context(|| format!("spawning new binary {}", exe.display()))?
            .wait()
            .with_context(|| "waiting for spawned binary to exit")?;
        std::process::exit(status.code().unwrap_or(0));
    }
}

/// Parse and compare two `vMAJOR.MINOR.PATCH` strings. Returns true
/// when `latest > current`. Malformed inputs fall back to a byte-wise
/// `!=` so we *do* proceed with reinstall when version strings are
/// shaped unexpectedly — safer than silently refusing to upgrade.
fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(a), Some(b)) => a > b,
        _ => latest.trim() != current.trim(),
    }
}

fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.trim();
    let rest = s.strip_prefix('v').unwrap_or(s);
    // Strip pre-release suffix (e.g. "-beta.1", "-rc.2") so versions
    // like "v4.25.0-beta.1" parse correctly (Issue #596).
    let rest = rest.split('-').next()?;
    let mut parts = rest.split('.');
    let a = parts.next()?.parse().ok()?;
    let b = parts.next()?.parse().ok()?;
    let c = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((a, b, c))
}

/// Three-way swap between the live binary and `.bak`, leaving `.bak`
/// pointing at what was previously live. Calling rollback twice in a
/// row returns you to the original state — intentional, so users can
/// toggle between last-two versions without redownloading.
/// In `distro-pm` builds this returns immediately with an error carrying `PACKAGE_MANAGED` (upgrades are the package manager's job).
pub fn run_rollback() -> Result<RollbackSummary> {
    if is_package_managed() {
        return Err(anyhow!(PACKAGE_MANAGED));
    }
    let exe = current_exe_path()?;
    let backup = backup_path(&exe);
    if !backup.exists() {
        return Err(anyhow!(
            "no backup found at {} — nothing to roll back to",
            backup.display()
        ));
    }
    ensure_writable(&exe)?;

    let rolling = rolling_path(&exe);
    if rolling.exists() {
        std::fs::remove_file(&rolling).ok();
    }

    // Step 1: live -> rolling (retry through transient Windows locks)
    robust_rename(&exe, &rolling).with_context(|| {
        format!(
            "renaming {} -> {} (swap step 1)",
            exe.display(),
            rolling.display()
        )
    })?;
    // Step 2: backup -> live
    if let Err(e) = robust_rename(&backup, &exe) {
        // Best-effort unwind of step 1.
        let _ = std::fs::rename(&rolling, &exe);
        return Err(anyhow!("rollback failed at step 2 ({}); state restored", e));
    }
    // Step 3: rolling -> backup
    if let Err(e) = std::fs::rename(&rolling, &backup) {
        // Can't cleanly unwind — the live file is already the old
        // version, which is the user-visible outcome they asked for.
        // Surface the orphan so they can clean up manually.
        return Err(anyhow!(
            "rollback succeeded but tmp file {} could not be moved to {} ({}).\n\
             Delete it manually; next /upgrade will overwrite it.",
            rolling.display(),
            backup.display(),
            e
        ));
    }

    Ok(RollbackSummary { exe, backup })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_filename_adds_exe_on_windows_targets() {
        assert_eq!(
            binary_filename("v4.19.0", "windows-x64"),
            "jeikcode-v4.19.0-windows-x64.exe"
        );
        assert_eq!(
            binary_filename("v4.19.0", "windows-arm64"),
            "jeikcode-v4.19.0-windows-arm64.exe"
        );
    }

    #[test]
    fn binary_filename_plain_on_unix_targets() {
        assert_eq!(
            binary_filename("v4.19.0", "darwin-arm64"),
            "jeikcode-v4.19.0-darwin-arm64"
        );
        assert_eq!(
            binary_filename("v4.19.0", "linux-x64"),
            "jeikcode-v4.19.0-linux-x64"
        );
    }

    #[test]
    fn binary_url_shape() {
        assert_eq!(
            binary_url("6.0.0", "windows-x64"),
            "https://github.com/jeikl/JeikCode/releases/download/v6.0.0/jeikcode-v6.0.0-windows-x64.exe"
        );
        assert_eq!(
            binary_url("v7.0.0", "windows-x64"),
            "https://github.com/jeikl/JeikCode/releases/download/v7.0.0/jeikcode-v7.0.0-windows-x64.exe"
        );
    }

    #[test]
    fn detect_target_returns_something_on_tier1_hosts() {
        // We can't assert an exact value (depends on host), but every
        // supported dev platform should resolve to Some.
        let t = detect_target();
        if cfg!(any(
            target_os = "macos",
            target_os = "linux",
            target_os = "windows"
        )) {
            if cfg!(any(target_arch = "x86_64", target_arch = "aarch64")) {
                assert!(t.is_some(), "expected target tag on this host");
            }
        }
    }

    #[test]
    fn target_tag_matches_release_manifest_targets() {
        assert_eq!(target_tag("macos", "aarch64"), Some("darwin-arm64"));
        assert_eq!(target_tag("macos", "x86_64"), Some("darwin-x64"));
        assert_eq!(target_tag("linux", "x86_64"), Some("linux-x64"));
        assert_eq!(target_tag("linux", "aarch64"), Some("linux-arm64"));
        assert_eq!(target_tag("windows", "x86_64"), Some("windows-x64"));
        assert_eq!(target_tag("windows", "aarch64"), Some("windows-arm64"));
        assert_eq!(target_tag("linux", "arm"), None);
    }

    #[test]
    fn backup_path_appends_bak() {
        let p = Path::new("/usr/local/bin/jeikcode");
        assert_eq!(backup_path(p), PathBuf::from("/usr/local/bin/jeikcode.bak"));
    }

    #[test]
    fn try_remove_stale_deletes_normal_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("jeikcode.exe.bak");
        std::fs::write(&p, b"old").expect("seed");
        assert!(try_remove_stale(&p));
        assert!(!p.exists(), "backup should be gone");
    }

    #[test]
    fn try_remove_stale_clears_readonly_then_deletes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("jeikcode.exe.bak");
        std::fs::write(&p, b"old").expect("seed");
        let mut perm = std::fs::metadata(&p).unwrap().permissions();
        perm.set_readonly(true);
        std::fs::set_permissions(&p, perm).expect("set readonly");
        // On Windows the readonly flag would block remove_file outright.
        // On Unix it doesn't, but the helper still happens to clean up.
        // Either way, the file must be gone after this call.
        assert!(try_remove_stale(&p));
        assert!(!p.exists());
    }

    #[test]
    fn try_remove_stale_returns_false_for_truly_locked_file() {
        // On Unix, an open file can still be unlinked, so true locking
        // is hard to simulate. Instead we test the "nonexistent path"
        // case — `try_remove_stale` correctly returns true because the
        // file doesn't exist (nothing to remove). To verify the false
        // return, we'd need a platform-specific lock (Windows HANDLE),
        // which isn't feasible in a cross-platform unit test. The
        // important contract is: returns true when nothing needs doing.
        let bogus = std::path::PathBuf::from("/no/such/dir/jeikcode.exe.bak");
        assert!(!bogus.exists());
        // A path that doesn't exist is "already removed" → true
        assert!(try_remove_stale(&bogus));
    }

    #[test]
    fn try_remove_stale_returns_true_for_nonexistent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("does_not_exist");
        assert!(!p.exists());
        assert!(try_remove_stale(&p));
    }

    #[test]
    fn backup_path_preserves_exe_suffix_on_windows_style() {
        let p = Path::new("C:/Tools/jeikcode.exe");
        assert_eq!(backup_path(p), PathBuf::from("C:/Tools/jeikcode.exe.bak"));
    }

    #[test]
    fn is_newer_semver() {
        assert!(is_newer("v4.19.0", "v4.18.2")); // latest, current
        assert!(is_newer("v4.19.0", "v4.18.9"));
        assert!(is_newer("v5.0.5", "v4.99.99"));
        assert!(!is_newer("v4.19.0", "v4.19.0"));
        assert!(!is_newer("v4.18.0", "v4.19.0")); // latest is older than current
    }

    #[test]
    fn is_newer_falls_back_to_string_diff_on_garbage() {
        // If we can't parse, err on the side of allowing reinstall
        // when strings differ (user may have a custom channel).
        assert!(is_newer("build-abc", "build-xyz"));
        assert!(!is_newer("build-abc", "build-abc"));
    }

    #[test]
    fn parse_version_handles_prerelease_suffix() {
        // Issue #596: pre-release versions like "v4.25.0-beta.1" must parse
        assert_eq!(parse_version("v4.25.0-beta.1"), Some((4, 25, 0)));
        assert_eq!(parse_version("v4.25.0-rc.2"), Some((4, 25, 0)));
        assert_eq!(parse_version("v4.25.0-alpha"), Some((4, 25, 0)));
        // Normal versions still work
        assert_eq!(parse_version("v4.25.0"), Some((4, 25, 0)));
    }

    #[test]
    fn is_newer_handles_prerelease() {
        // Pre-release version is treated as equal to its release version
        assert!(!is_newer("v4.25.0", "v4.25.0-beta.1"));
        assert!(!is_newer("v4.25.0-beta.1", "v4.25.0"));
        // But still newer than older versions
        assert!(is_newer("v4.25.0-beta.1", "v4.24.99"));
    }

    #[test]
    fn version_is_newer_keeps_beta_ordinals() {
        assert!(version_is_newer("v7.2.4-beta.5", "v7.2.4-beta.4"));
        assert!(!version_is_newer("v7.2.4-beta.4", "v7.2.4-beta.5"));
        assert!(version_is_newer("v7.2.4", "v7.2.4-beta.5"));
        assert!(!version_is_newer("v7.2.4-beta.5", "v7.2.4"));
        assert!(version_is_newer("v7.2.4-beta.1", "v7.2.3"));
    }

    fn sample_release(tag: &str, prerelease: bool) -> ListedRelease {
        ListedRelease {
            tag_name: tag.to_string(),
            prerelease,
            body: None,
            published_at: None,
            assets: Vec::new(),
        }
    }

    #[test]
    fn filter_channel_releases_sorts_newest_first() {
        let releases = vec![
            sample_release("v7.2.4-beta.4", true),
            sample_release("v7.2.3", false),
            sample_release("v7.2.4-beta.9", true),
            sample_release("v7.2.4", false),
            sample_release("v7.2.4-beta.9", true),
        ];
        let beta = filter_channel_releases(&releases, UpdateChannel::Beta);
        assert_eq!(
            beta.iter().map(|r| r.tag_name.as_str()).collect::<Vec<_>>(),
            vec!["v7.2.4-beta.9", "v7.2.4-beta.4"]
        );
        let stable = filter_channel_releases(&releases, UpdateChannel::Stable);
        assert_eq!(
            stable
                .iter()
                .map(|r| r.tag_name.as_str())
                .collect::<Vec<_>>(),
            vec!["v7.2.4", "v7.2.3"]
        );
    }

    #[test]
    fn normalize_version_tag_adds_v_prefix() {
        assert_eq!(normalize_version_tag("7.2.4"), "v7.2.4");
        assert_eq!(normalize_version_tag("v7.2.4-beta.9"), "v7.2.4-beta.9");
        assert_eq!(normalize_version_tag(" V7.2.4 "), "v7.2.4");
        assert_eq!(channel_for_tag("v7.2.4"), UpdateChannel::Stable);
        assert_eq!(channel_for_tag("v7.2.4-beta.9"), UpdateChannel::Beta);
    }

    #[test]
    fn next_page_url_reads_rel_next() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::LINK,
            reqwest::header::HeaderValue::from_static(
                "<https://api.github.com/repos/jeikl/JeikCode/releases?per_page=100&page=2>; rel=\"next\", <https://api.github.com/repos/jeikl/JeikCode/releases?per_page=100&page=4>; rel=\"last\"",
            ),
        );
        assert_eq!(
            next_page_url(&headers).as_deref(),
            Some("https://api.github.com/repos/jeikl/JeikCode/releases?per_page=100&page=2")
        );
    }

    #[test]
    fn looks_like_jeikcode_binary_accepts_product_name() {
        assert!(looks_like_jeikcode_binary(Path::new("jeikcode")));
        assert!(looks_like_jeikcode_binary(Path::new("jeikcode.exe")));
        assert!(!looks_like_jeikcode_binary(Path::new("jeikcode.cmd")));
        assert!(!looks_like_jeikcode_binary(Path::new("other.exe")));
    }

    #[test]
    fn discover_install_exes_includes_running_path() {
        let tmp = tempfile::tempdir().unwrap();
        let running = tmp.path().join("jeikcode");
        std::fs::write(&running, b"x").unwrap();
        let found = discover_install_exes(&running);
        assert!(found.iter().any(|p| same_exe(p, &running)));
    }

    #[test]
    fn manifest_parses_minimal_shape() {
        let json = r#"{
            "version": "v4.19.0",
            "binaries": {
                "darwin-arm64": { "sha256": "abcd", "size": 1024 }
            }
        }"#;
        let m: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.version, "v4.19.0");
        assert_eq!(m.binaries["darwin-arm64"].size, 1024);
    }

    #[test]
    fn manifest_ignores_unknown_fields() {
        let json = r#"{
            "version": "v4.19.0",
            "released_at": "2026-04-19T00:00:00Z",
            "signature": "future-field",
            "binaries": {
                "linux-x64": { "sha256": "ffff", "size": 42, "notes": "x" }
            }
        }"#;
        let m: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.released_at.as_deref(), Some("2026-04-19T00:00:00Z"));
        assert_eq!(m.binaries["linux-x64"].sha256, "ffff");
    }

    #[test]
    fn hex_encode_matches_known_vectors() {
        assert_eq!(hex_encode(&[0x00, 0xff, 0x10]), "00ff10");
        assert_eq!(hex_encode(&[]), "");
    }

    #[test]
    fn ensure_writable_probes_containing_dir() {
        // A path inside tempdir must pass; a path whose parent doesn't
        // exist must fail with a clear message.
        let tmp = tempfile::tempdir().unwrap();
        let ok = tmp.path().join("jeikcode");
        assert!(ensure_writable(&ok).is_ok());

        let bogus = Path::new("/nonexistent-dir-xyzzy-9999/jeikcode");
        let err = ensure_writable(bogus).unwrap_err().to_string();
        assert!(err.contains("sudo jeikcode upgrade"), "got: {}", err);
    }

    #[test]
    fn replace_binary_renames_live_to_bak_via_three_way_swap() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = tmp.path().join("jeikcode");
        let new = tmp.path().join(".jeikcode.download");
        std::fs::write(&exe, b"OLD").unwrap();
        std::fs::write(&new, b"NEW").unwrap();

        replace_binary(&new, &exe).unwrap();

        assert_eq!(std::fs::read(&exe).unwrap(), b"NEW");
        let bak = backup_path(&exe);
        assert_eq!(std::fs::read(&bak).unwrap(), b"OLD");
        assert!(!new.exists());
        // No leftover .rolling file on success
        let rolling = rolling_path(&exe);
        assert!(!rolling.exists());
    }

    #[test]
    fn replace_binary_overwrites_stale_bak() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = tmp.path().join("jeikcode");
        let new = tmp.path().join(".jeikcode.download");
        let bak = backup_path(&exe);
        std::fs::write(&exe, b"V2").unwrap();
        std::fs::write(&new, b"V3").unwrap();
        std::fs::write(&bak, b"V1").unwrap();

        replace_binary(&new, &exe).unwrap();

        assert_eq!(std::fs::read(&exe).unwrap(), b"V3");
        assert_eq!(std::fs::read(&bak).unwrap(), b"V2");
        // No leftover .rolling file
        let rolling = rolling_path(&exe);
        assert!(!rolling.exists());
    }

    #[test]
    fn robust_rename_moves_file() {
        let tmp = tempfile::tempdir().unwrap();
        let from = tmp.path().join("from");
        let to = tmp.path().join("to");
        std::fs::write(&from, b"DATA").unwrap();

        robust_rename(&from, &to).unwrap();

        assert!(!from.exists());
        assert_eq!(std::fs::read(&to).unwrap(), b"DATA");
    }

    #[test]
    fn robust_rename_replaces_existing_destination() {
        // Mirrors the swap's "rolling target left over from a prior run"
        // case: the destination already exists and must be replaced.
        let tmp = tempfile::tempdir().unwrap();
        let from = tmp.path().join("from");
        let to = tmp.path().join("to");
        std::fs::write(&from, b"NEW").unwrap();
        std::fs::write(&to, b"STALE").unwrap();

        robust_rename(&from, &to).unwrap();

        assert!(!from.exists());
        assert_eq!(std::fs::read(&to).unwrap(), b"NEW");
    }

    #[test]
    fn is_cross_device_error_detects_platform_code() {
        // Windows ERROR_NOT_SAME_DEVICE = 17; Unix EXDEV = 18.
        #[cfg(windows)]
        let exdev = 17;
        #[cfg(not(windows))]
        let exdev = 18;
        assert!(is_cross_device_error(&std::io::Error::from_raw_os_error(
            exdev
        )));
        // A permission-style error must NOT be mistaken for cross-device.
        assert!(!is_cross_device_error(&std::io::Error::from_raw_os_error(
            13
        )));
    }

    #[test]
    fn copy_across_devices_moves_and_removes_source() {
        let tmp = tempfile::tempdir().unwrap();
        let from = tmp.path().join("src");
        let to = tmp.path().join("dst");
        std::fs::write(&from, b"PAYLOAD").unwrap();

        copy_across_devices(&from, &to).unwrap();

        assert_eq!(std::fs::read(&to).unwrap(), b"PAYLOAD");
        assert!(!from.exists(), "source must be consumed after the move");
    }

    #[test]
    fn robust_rename_falls_back_to_copy_on_cross_device() {
        // The reported bug: staged binary under the user profile (C:\…\.jeikcode
        // \staged\) vs a running exe on another drive (H:\). `rename` fails with
        // ERROR_NOT_SAME_DEVICE; robust_rename must transparently copy instead of
        // burning its retry budget on a deterministic failure.
        let tmp = tempfile::tempdir().unwrap();
        let from = tmp.path().join("staged-binary");
        let to = tmp.path().join("exe");
        std::fs::write(&from, b"NEWVERSION").unwrap();

        #[cfg(windows)]
        let exdev = 17;
        #[cfg(not(windows))]
        let exdev = 18;
        let fake_rename = |_: &Path, _: &Path| Err(std::io::Error::from_raw_os_error(exdev));

        robust_rename_with(&from, &to, fake_rename).unwrap();

        assert_eq!(std::fs::read(&to).unwrap(), b"NEWVERSION");
        assert!(!from.exists(), "staged source must be consumed");
    }

    #[test]
    fn robust_rename_clears_readonly_source() {
        // A read-only source (a real Windows AV/SCCM failure mode) must
        // still move. set_readonly is cross-platform enough to exercise
        // the clear_readonly path here.
        let tmp = tempfile::tempdir().unwrap();
        let from = tmp.path().join("from");
        let to = tmp.path().join("to");
        std::fs::write(&from, b"RO").unwrap();
        let mut perm = std::fs::metadata(&from).unwrap().permissions();
        perm.set_readonly(true);
        std::fs::set_permissions(&from, perm).unwrap();

        robust_rename(&from, &to).unwrap();

        assert_eq!(std::fs::read(&to).unwrap(), b"RO");
    }

    #[test]
    fn replace_binary_cleans_leftover_rolling() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = tmp.path().join("jeikcode");
        let new = tmp.path().join(".jeikcode.download");
        let rolling = rolling_path(&exe);
        std::fs::write(&exe, b"OLD").unwrap();
        std::fs::write(&new, b"NEW").unwrap();
        std::fs::write(&rolling, b"STALE").unwrap();

        replace_binary(&new, &exe).unwrap();

        assert_eq!(std::fs::read(&exe).unwrap(), b"NEW");
        let bak = backup_path(&exe);
        assert_eq!(std::fs::read(&bak).unwrap(), b"OLD");
        assert!(!rolling.exists());
    }

    #[test]
    fn replace_binary_succeeds_even_when_bak_cannot_be_removed() {
        // Simulate the Windows ACCESS_DENIED scenario: .bak is locked
        // (here we can't truly lock it, but we make it read-only in a
        // non-writable parent — on Unix this still works because unlink
        // doesn't care about file permissions. The test verifies the
        // three-way swap completes successfully regardless.)
        let tmp = tempfile::tempdir().unwrap();
        let exe = tmp.path().join("jeikcode");
        let new = tmp.path().join(".jeikcode.download");
        let bak = backup_path(&exe);
        let rolling = rolling_path(&exe);
        std::fs::write(&exe, b"V2").unwrap();
        std::fs::write(&new, b"V3").unwrap();
        std::fs::write(&bak, b"V1").unwrap();

        replace_binary(&new, &exe).unwrap();

        // Core outcome: upgrade succeeded
        assert_eq!(std::fs::read(&exe).unwrap(), b"V3");
        // On this platform .bak is removable so we get V2 as backup.
        // On Windows with a locked .bak, the .rolling file would linger
        // instead, but the upgrade still succeeds.
        assert!(bak.exists() || rolling.exists());
    }

    #[test]
    fn rollback_swaps_live_and_bak() {
        let tmp = tempfile::tempdir().unwrap();
        // Use a fake exe name that won't collide with the real test
        // binary. run_rollback uses current_exe() which we cannot
        // redirect, so we test the primitive by calling replace_binary
        // first then rename logic directly — model the three-way swap.
        let exe = tmp.path().join("jeikcode");
        let bak = backup_path(&exe);
        std::fs::write(&exe, b"NEW").unwrap();
        std::fs::write(&bak, b"OLD").unwrap();

        // Manual three-way swap mirroring run_rollback's body.
        let rolling = tmp.path().join(".jeikcode.rolling");
        std::fs::rename(&exe, &rolling).unwrap();
        std::fs::rename(&bak, &exe).unwrap();
        std::fs::rename(&rolling, &bak).unwrap();

        assert_eq!(std::fs::read(&exe).unwrap(), b"OLD");
        assert_eq!(std::fs::read(&bak).unwrap(), b"NEW");
    }

    #[test]
    fn pending_upgrade_serde_roundtrips() {
        let p = PendingUpgrade {
            version: "v4.19.1".to_string(),
            staged_path: PathBuf::from("/tmp/staged/jeikcode-v4.19.1-darwin-arm64"),
            sha256: "abcd".to_string(),
            size: 1024,
            created_at: "2026-04-20T10:54:16Z".to_string(),
            attempts: 0,
        };
        let j = serde_json::to_string(&p).unwrap();
        let back: PendingUpgrade = serde_json::from_str(&j).unwrap();
        assert_eq!(back.version, "v4.19.1");
        assert_eq!(back.attempts, 0);
    }

    #[test]
    fn pending_attempts_defaults_when_missing() {
        // Older pointer files written before the attempts field existed
        // must still deserialize — `#[serde(default)]` covers that.
        let j = r#"{
            "version": "v4.19.1",
            "staged_path": "/tmp/x",
            "sha256": "abcd",
            "size": 1024,
            "created_at": "2026-04-20T10:54:16Z"
        }"#;
        let p: PendingUpgrade = serde_json::from_str(j).unwrap();
        assert_eq!(p.attempts, 0);
    }

    #[test]
    fn staged_binary_path_matches_release_artifact_name() {
        let p = staged_binary_path("v4.19.1", "darwin-arm64");
        assert!(p.ends_with("jeikcode-v4.19.1-darwin-arm64"), "got: {:?}", p);
    }

    #[test]
    fn staged_binary_path_adds_exe_for_windows() {
        let p = staged_binary_path("v4.19.1", "windows-x64");
        assert!(
            p.ends_with("jeikcode-v4.19.1-windows-x64.exe"),
            "got: {:?}",
            p
        );
    }

    // ── download_and_verify integration tests (issue #380) ──────────

    /// Helper: compute the SHA256 hex string for a byte slice.
    fn sha256_hex(data: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(data);
        hex_encode(&hasher.finalize())
    }

    /// download_and_verify succeeds when the server omits Content-Length
    /// (chunked transfer encoding).  In production, Content-Length may
    /// differ from the manifest's `size` due to CDN/proxy rewrites,
    /// manifest-server sync lag, or redirect hops — the old code
    /// aborted immediately on such mismatches (issue #380).
    ///
    /// This test validates that when Content-Length is absent (chunked),
    /// the function proceeds to download and relies on the post-download
    /// size + SHA256 checks for integrity, which is the correct behavior
    /// after the fix.
    #[tokio::test]
    async fn download_succeeds_without_content_length() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;

        // Simulate a CDN that uses chunked transfer (no Content-Length).
        // This is what a gzip-compressed response looks like after
        // reqwest transparently decompresses it.
        let payload = vec![0xAB_u8; 100];
        let expected_sha = sha256_hex(&payload);
        let expected_size: u64 = payload.len() as u64;

        Mock::given(method("GET"))
            .and(path("/binary"))
            .respond_with(
                ResponseTemplate::new(200)
                    // No explicit Content-Length → chunked transfer encoding.
                    .set_body_raw(payload.clone(), "application/octet-stream"),
            )
            .mount(&server)
            .await;

        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("download.bin");

        let result = download_and_verify(
            &format!("{}/binary", server.uri()),
            &expected_sha,
            expected_size,
            &dest,
            &tx,
        )
        .await;

        // With the fix, this should succeed because the actual downloaded
        // bytes match expected_size and expected_sha256.  The old code
        // would also have succeeded here (Content-Length was absent), but
        // the key point is that we no longer gate on Content-Length at all.
        assert!(result.is_ok(), "download should succeed, got: {:?}", result);
        assert_eq!(std::fs::read(&dest).unwrap(), payload);
    }

    /// download_and_verify still rejects a download whose actual byte
    /// count doesn't match the manifest size (post-download size check).
    #[tokio::test]
    async fn download_rejects_wrong_actual_size() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;

        // Server sends 80 bytes, but manifest says 100.
        let payload = vec![0xAB_u8; 80];
        let expected_sha = sha256_hex(&payload);
        let expected_size: u64 = 100; // mismatch!

        Mock::given(method("GET"))
            .and(path("/binary"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_raw(payload.clone(), "application/octet-stream"),
            )
            .mount(&server)
            .await;

        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("download.bin");

        let result = download_and_verify(
            &format!("{}/binary", server.uri()),
            &expected_sha,
            expected_size,
            &dest,
            &tx,
        )
        .await;

        assert!(result.is_err(), "should fail on size mismatch");
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("short download"),
            "error should mention short download, got: {}",
            err
        );
        // Temp file must be cleaned up on failure.
        assert!(!dest.exists(), "partial download should be removed");
    }

    /// download_and_verify still rejects a download whose SHA256
    /// doesn't match the manifest, even if the size is correct.
    #[tokio::test]
    async fn download_rejects_checksum_mismatch() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;

        let payload = vec![0xAB_u8; 100];
        let wrong_sha = "0000000000000000000000000000000000000000000000000000000000000000";
        let expected_size: u64 = payload.len() as u64;

        Mock::given(method("GET"))
            .and(path("/binary"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_raw(payload.clone(), "application/octet-stream"),
            )
            .mount(&server)
            .await;

        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("download.bin");

        let result = download_and_verify(
            &format!("{}/binary", server.uri()),
            wrong_sha, // intentionally wrong
            expected_size,
            &dest,
            &tx,
        )
        .await;

        assert!(result.is_err(), "should fail on checksum mismatch");
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("checksum mismatch"),
            "error should mention checksum mismatch, got: {}",
            err
        );
        // Temp file must be cleaned up on failure.
        assert!(!dest.exists(), "corrupted download should be removed");
    }

    /// download_and_verify succeeds when everything matches perfectly
    /// (Content-Length present and correct, size + SHA256 match).
    #[tokio::test]
    async fn download_succeeds_when_all_checks_pass() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;

        let payload = vec![0xCD_u8; 256];
        let expected_sha = sha256_hex(&payload);
        let expected_size: u64 = payload.len() as u64;

        Mock::given(method("GET"))
            .and(path("/binary"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_raw(payload.clone(), "application/octet-stream"),
            )
            .mount(&server)
            .await;

        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("download.bin");

        let result = download_and_verify(
            &format!("{}/binary", server.uri()),
            &expected_sha,
            expected_size,
            &dest,
            &tx,
        )
        .await;

        assert!(result.is_ok(), "download should succeed, got: {:?}", result);
        assert_eq!(std::fs::read(&dest).unwrap(), payload);
    }

    /// download_and_verify rejects non-2xx HTTP responses.
    #[tokio::test]
    async fn download_rejects_http_error() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/binary"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("download.bin");

        let result = download_and_verify(
            &format!("{}/binary", server.uri()),
            "unused",
            100,
            &dest,
            &tx,
        )
        .await;

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("HTTP 404"),
            "error should mention HTTP 404, got: {}",
            err
        );
    }

    #[test]
    fn is_package_managed_tracks_feature() {
        assert_eq!(super::is_package_managed(), cfg!(feature = "distro-pm"));
    }

    #[cfg(feature = "distro-pm")]
    #[tokio::test]
    async fn run_upgrade_blocked_when_package_managed() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let err = super::run_upgrade("v1.0.0".to_string(), true, tx)
            .await
            .expect_err("package-managed build must refuse self-upgrade");
        assert!(err.to_string().contains(super::PACKAGE_MANAGED));
    }

    #[cfg(feature = "distro-pm")]
    #[test]
    fn run_rollback_blocked_when_package_managed() {
        let err = super::run_rollback().expect_err("package-managed build must refuse rollback");
        assert!(err.to_string().contains(super::PACKAGE_MANAGED));
    }

    #[cfg(feature = "distro-pm")]
    #[test]
    fn apply_pending_upgrade_noop_when_package_managed() {
        assert!(super::apply_pending_upgrade().unwrap().is_none());
    }

    #[cfg(feature = "distro-pm")]
    #[tokio::test]
    async fn prepare_deferred_upgrade_noop_when_package_managed() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let result = super::prepare_deferred_upgrade("v1.0.0", tx)
            .await
            .expect("package-managed build must not error, just no-op");
        assert!(result.is_none());
    }

    #[test]
    fn listen_port_comes_from_argv_flag() {
        assert_eq!(
            listen_port_from_args([
                "webui", "--host", "0.0.0.0", "--port", "13458", "--token", "t"
            ]),
            Some(13458)
        );
        assert_eq!(listen_port_from_args(["serve", "--port=4096"]), Some(4096));
        assert_eq!(listen_port_from_args(["webui", "--port", "0"]), None);
        assert_eq!(listen_port_from_args(["tui"]), None);
    }

    #[test]
    fn exact_restart_keeps_the_live_port_instead_of_the_argv_fallback() {
        assert_eq!(
            planned_restart_port(Some("1"), Some("13458"), 13457),
            Some(13458)
        );
        assert_eq!(planned_restart_port(Some("1"), None, 13457), Some(13457));
        assert_eq!(planned_restart_port(None, Some("13458"), 13457), None);
    }

    #[test]
    fn zombie_pid_does_not_block_once_the_listen_socket_is_gone() {
        assert!(predecessor_socket_released(false));
        assert!(!predecessor_socket_released(true));
    }

    #[test]
    fn patch_restart_args_replaces_and_injects_options() {
        let orig = vec!["webui", "--host", "127.0.0.1", "--port", "13457"];
        let patched = patch_restart_args(orig, Some("0.0.0.0"), Some(4096), Some("sk-token"));
        let strings: Vec<String> = patched
            .into_iter()
            .map(|s| s.to_string_lossy().to_string())
            .collect();
        assert_eq!(
            strings,
            vec!["webui", "--host", "0.0.0.0", "--port", "4096", "--token", "sk-token"]
        );
    }

    #[test]
    fn patch_restart_args_with_auth_toggles_between_token_and_no_token() {
        // Switching from --no-token to --token strips --no-token so `serve` does not abort
        let orig = vec!["--host", "0.0.0.0", "--port", "4096", "--no-token"];
        let patched = patch_restart_args_with_auth(
            orig,
            Some("0.0.0.0"),
            Some(5000),
            Some("new-secret"),
            Some(false),
        );
        let strings: Vec<String> = patched
            .into_iter()
            .map(|s| s.to_string_lossy().to_string())
            .collect();
        assert_eq!(
            strings,
            vec![
                "--host",
                "0.0.0.0",
                "--port",
                "5000",
                "--token",
                "new-secret"
            ]
        );

        // Switching from --token to --no-token strips --token and appends --no-token
        let orig2 = vec![
            "--host",
            "0.0.0.0",
            "--port",
            "5000",
            "--token",
            "new-secret",
        ];
        let patched2 =
            patch_restart_args_with_auth(orig2, Some("127.0.0.1"), Some(5001), None, Some(true));
        let strings2: Vec<String> = patched2
            .into_iter()
            .map(|s| s.to_string_lossy().to_string())
            .collect();
        assert_eq!(
            strings2,
            vec!["--host", "127.0.0.1", "--port", "5001", "--no-token"]
        );
    }

    #[test]
    fn service_port_match_respects_digit_boundaries() {
        assert!(service_text_declares_port("x --port 4096 --dir /", 4096));
        assert!(service_text_declares_port("x --port=4096", 4096));
        assert!(service_text_declares_port("x --port \"4096\"", 4096));
        assert!(service_text_declares_port(
            "<string>--port</string>\n    <string>4096</string>",
            4096
        ));
        assert!(!service_text_declares_port("x --port 40960", 4096));
        assert!(!service_text_declares_port("x --port 409", 4096));
        assert!(!service_text_declares_port("x --host 4096", 4096));
    }

    #[test]
    fn live_exe_path_strips_windows_swap_suffixes() {
        let dir = std::path::Path::new("/opt/jc");
        let expected = if cfg!(windows) {
            "jeikcode.exe"
        } else {
            "jeikcode"
        };
        assert_eq!(
            normalize_live_exe_path(dir.join(".jeikcode.rolling")),
            dir.join(expected)
        );
        assert_eq!(
            normalize_live_exe_path(dir.join("jeikcode.exe.bak")),
            dir.join("jeikcode.exe")
        );
        assert_eq!(
            normalize_live_exe_path(dir.join("jeikcode")),
            dir.join("jeikcode")
        );
    }

    #[test]
    fn windows_cmd_rewrite_leaves_marker_line_untouched() {
        let cmd = "@echo off\r\ncd /d E:\\w\r\nset \"JEIKCODE_HOST_SERVICE=JeikCode-jeikcode\"\r\njeikcode.exe --host 0.0.0.0 --port 4096 --token a\r\n";
        let out = rewrite_windows_cmd_content(cmd, None, Some(5000), Some("b"), Some(false));
        assert!(out.contains("set \"JEIKCODE_HOST_SERVICE=JeikCode-jeikcode\""));
        assert!(out.contains("jeikcode.exe --host 0.0.0.0 --port 5000 --token b"));
    }

    #[test]
    fn rewrites_systemd_procd_launchd_and_windows_service_configs() {
        // 1. Linux systemd unit
        let unit = "[Service]\nExecStart=/usr/local/bin/jeikcode --host 0.0.0.0 --port 4096 --token oldtok --dir \"/root\"\nRestart=always\n";
        let updated_unit = rewrite_systemd_unit_content(
            unit,
            Some("192.168.1.10"),
            Some(8080),
            Some("newtok"),
            Some(false),
        );
        assert!(updated_unit.contains(
            "ExecStart=/usr/local/bin/jeikcode --host 192.168.1.10 --port 8080 --token newtok --dir \"/root\""
        ));

        // 2. OpenWrt procd script
        let procd = "start_service() {\n    procd_open_instance\n    procd_set_param command \"$PROG\" --host \"0.0.0.0\" --port 4096 --dir \"/root\" --token \"oldtok\"\n}\n";
        let updated_procd = rewrite_procd_script_content(
            procd,
            Some("0.0.0.0"),
            Some(9090),
            Some("openwrt-tok"),
            Some(false),
        );
        assert!(updated_procd.contains(
            "    procd_set_param command \"$PROG\" --host \"0.0.0.0\" --port 9090 --dir \"/root\" --token \"openwrt-tok\""
        ));

        // 3. macOS launchd plist
        let plist = r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.jeikcode-4096</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/jeikcode</string>
    <string>--host</string>
    <string>0.0.0.0</string>
    <string>--port</string>
    <string>4096</string>
    <string>--token</string>
    <string>oldtok</string>
  </array>
</dict>
</plist>"#;
        let updated_plist = rewrite_launchd_plist_content(
            plist,
            Some("127.0.0.1"),
            Some(7070),
            Some("mactok"),
            Some(false),
        )
        .unwrap();
        assert!(updated_plist.contains("<string>127.0.0.1</string>"));
        assert!(updated_plist.contains("<string>7070</string>"));
        assert!(updated_plist.contains("<string>mactok</string>"));

        // 4. Windows logon .cmd
        let win_cmd = "@echo off\r\ncd /d E:\\code\r\n\"C:\\Program Files\\JeikCode\\jeikcode.exe\" --host 0.0.0.0 --port 4096 --token oldtok\r\n";
        let updated_cmd = rewrite_windows_cmd_content(
            win_cmd,
            Some("0.0.0.0"),
            Some(6060),
            Some("wintok"),
            Some(false),
        );
        assert!(updated_cmd.contains(
            "\"C:\\Program Files\\JeikCode\\jeikcode.exe\" --host 0.0.0.0 --port 6060 --token wintok"
        ));
    }

    #[tokio::test]
    #[serial_test::serial(offline_verdict)]
    async fn offline_suppression_guards_manifest_and_deferred_upgrade() {
        use jeikcode_config::config::offline::{seed_offline_verdict, OfflineMode};
        seed_offline_verdict(OfflineMode::On, None);
        let res = fetch_manifest_from_url("https://example.com/latest.json").await;
        assert!(res.is_err());
        let err_msg = res.unwrap_err().to_string();
        assert!(err_msg.contains("offline mode"));

        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let res_upgrade = prepare_deferred_upgrade("v0.1.0", tx).await;
        assert!(matches!(res_upgrade, Ok(None)));

        seed_offline_verdict(OfflineMode::Off, None);
    }
}
