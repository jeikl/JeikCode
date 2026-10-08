//! `SensitivePathGate` — require approval before a normally-Safe READ tool touches a
//! sensitive path (SSH keys, cloud creds, `.env`, …).
//!
//! Kernel approval is risk-based: `read_file` / `grep` / `glob` / `list_dir` are `Safe`, so
//! they NEVER prompt — meaning an agent can silently read `~/.ssh/id_rsa` or `.env` and the
//! contents ride a tool result straight to the LLM provider (secret exfiltration). This
//! gate preserves the existing per-path protection in a native middleware:
//! it acts ONLY on tools that would otherwise bypass approval (`Safe`) AND whose args name
//! a sensitive path, then runs the SAME approval round-trip as [`ApprovalMiddleware`]
//! (allow-once / allow-always / deny). `Risky` tools already go through approval, so this
//! never double-prompts; `-y` / auto-approve drivers answer it like any approval.
//!
//! [`ApprovalMiddleware`]: super::approval::ApprovalMiddleware

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};

use async_trait::async_trait;
use jeikcode_kernel::middleware::{BeforeOutcome, ToolMiddleware};
use jeikcode_kernel::request::RequestCtx;
use jeikcode_kernel::tool::{RiskLevel, Tool, ToolCall};

use super::approval::{
    ApprovalRequest, InMemoryPermissionStore, PermissionDecision, PermissionStore, APPROVAL_KIND,
};

/// Path fragments that mark a credential store. Matched case-insensitively as substrings of
/// the raw (JSON) tool arguments — the path rides there for every read tool. Deliberately
/// PATH-shaped (not bare words like "secret") so an ordinary `grep "secret"` over source
/// does not prompt. A false positive costs ONE approval prompt on an otherwise-Safe read,
/// so the list errs toward catching real secrets. `.env` is handled specially below.
const SENSITIVE_MARKERS: &[&str] = &[
    "/.ssh",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "id_dsa",
    "/.aws",
    "/.gnupg",
    "/.kube",
    "/.config/gcloud",
    ".netrc",
    ".git-credentials",
    "/.jeikcode/auth.toml",
    "/.jeikcode/auth/",
    "/.docker/config",
    ".npmrc",
    ".pypirc",
    ".pem",
    ".p12",
    ".pfx",
    ".keystore",
    "/secrets/",
    "/.terraform.d",
];

/// Placeholder-template `.env` variants committed to version control — they hold only
/// dummy values, so reading them is not a secret-exfiltration risk and must not prompt.
/// Matched as the keyword immediately after `.env.` (e.g. `.env.example`, `.env.sample`).
const ENV_TEMPLATE_SUFFIXES: &[&str] = &["example", "sample", "template", "dist", "defaults"];

/// True if the raw args reference a sensitive path. `.env` is matched only as a FILENAME
/// (`.env"`, `.env'`, `.env.local…`) so `"environment"` / `.environment/` do not false-trip.
/// Placeholder templates (`.env.example`, `.env.sample`, …) are excluded — they are
/// committed to VCS and hold no real secrets, so prompting on them is pure friction.
pub fn references_sensitive_path(args: &str) -> bool {
    let a = args.to_ascii_lowercase();
    // Bare `.env` filename (quoted in the JSON args).
    if a.contains(".env\"") || a.contains(".env'") {
        return true;
    }
    // `.env.<suffix>` is sensitive (`.env.local`, `.env.production`, …) UNLESS every
    // such occurrence is a known non-secret template.
    if env_dot_reference_is_sensitive(&a) {
        return true;
    }
    if matches_a_marker(&a) {
        return true;
    }
    // Raw JSON doubles Windows path separators. Decode string values, normalize their
    // separators, then apply the same path-shaped markers to the actual argument bytes.
    // This avoids maintaining a fragile second marker list for JSON escaping.
    serde_json::from_str::<serde_json::Value>(args)
        .ok()
        .is_some_and(|value| decoded_json_references_sensitive_path(&value))
}

/// [`SENSITIVE_MARKERS`] plus the resolved config dir's credential paths.
fn matches_a_marker(lowercased: &str) -> bool {
    SENSITIVE_MARKERS.iter().any(|m| lowercased.contains(m))
        || configured_credential_markers()
            .iter()
            .any(|m| lowercased.contains(m.as_str()))
}

/// The credential paths under the CONFIGURED config dir, as lowercased
/// `/`-separated substrings.
///
/// [`SENSITIVE_MARKERS`] hardcodes the `/.jeikcode/…` spelling, which covers the
/// default location under any home (and the `~/.jeikcode/…` form a model is
/// likely to write). It matches nothing once `$JEIKCODE_HOME` points elsewhere,
/// so the credentials of exactly the users who moved their config tree would
/// ride out through a `Safe` read without a prompt. These markers close that.
///
/// Resolved once: `$JEIKCODE_HOME` is read at process start and every other
/// consumer of it caches the same way.
fn configured_credential_markers() -> &'static [String] {
    static MARKERS: OnceLock<Vec<String>> = OnceLock::new();
    MARKERS.get_or_init(|| credential_markers_for(&crate::paths::config_dir()))
}

/// Pure core of [`configured_credential_markers`] — takes the dir so the marker
/// shape can be asserted without mutating the process-global `$JEIKCODE_HOME`.
fn credential_markers_for(config_dir: &Path) -> Vec<String> {
    let dir = config_dir
        .to_string_lossy()
        .to_ascii_lowercase()
        .replace('\\', "/");
    let dir = dir.trim_end_matches('/');
    if dir.is_empty() {
        return Vec::new();
    }
    vec![format!("{dir}/auth.toml"), format!("{dir}/auth/")]
}

fn decoded_json_references_sensitive_path(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(value) => {
            let normalized = value.to_ascii_lowercase().replace('\\', "/");
            matches_a_marker(&normalized)
        }
        serde_json::Value::Array(values) => {
            values.iter().any(decoded_json_references_sensitive_path)
        }
        serde_json::Value::Object(values) => {
            values.values().any(decoded_json_references_sensitive_path)
        }
        _ => false,
    }
}

/// Scan every `.env.<suffix>` occurrence in the lowercased args; return true if any suffix
/// is NOT a recognized template keyword (i.e. a real secret variant like `local`/`production`).
fn env_dot_reference_is_sensitive(a: &str) -> bool {
    let mut rest = a;
    while let Some(pos) = rest.find(".env.") {
        let after = &rest[pos + ".env.".len()..];
        // Leading alphanumeric run is the variant keyword (stops at quote, dot, slash, …).
        let suffix: String = after
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect();
        if !ENV_TEMPLATE_SUFFIXES.contains(&suffix.as_str()) {
            return true;
        }
        rest = after;
    }
    false
}

/// The user's real home directory. Used to anchor `~/.ssh` / `~/.aws` / `~/.gnupg`
/// so a project-local `./.ssh/` (benign) is not treated like the real keys. Thin
/// alias over the crate-shared [`crate::pathutil::home_dir`] (single source of the
/// `HOME`/`USERPROFILE` logic).
fn home_dir() -> Option<PathBuf> {
    crate::pathutil::home_dir()
}

/// True iff `path` is the jeikcode credential store under `config_dir`.
///
/// Anchored on the resolved config dir rather than a literal `~/.jeikcode`: with
/// `$JEIKCODE_HOME` set, the old form guarded a path that does not exist while
/// the real `auth.toml` stayed unguarded. Pure (dir passed in) so the rule is
/// testable without mutating the process-global env.
///
/// `starts_with` is component-wise, so the second arm covers the `auth/`
/// DIRECTORY and not the `auth.toml` file — hence the explicit first arm.
fn is_credential_path(path: &Path, config_dir: &Path) -> bool {
    path == config_dir.join("auth.toml") || path.starts_with(config_dir.join("auth"))
}

/// True iff a RESOLVED (absolute, cwd-joined) `path` is sensitive — a system-protected
/// location, a credential dir under the real home, or a secret file by name/extension. This is
/// the PATH-aware companion to [`references_sensitive_path`] (which substring-matches raw JSON
/// args): it correctly catches a RELATIVE `.ssh/authorized_keys` or a Windows `…\.ssh\…` once
/// resolved, which the substring form misses. Faithful port of the legacy (v1) `is_sensitive_path`
/// so write approval inherits the same protected set.
pub fn path_is_sensitive(path: &Path) -> bool {
    // System paths that must never be silently mutated/read. IMPORTANT: do NOT list
    // bare `/root` (or `/var/root`) as a prefix — Docker/CI often run as root with the
    // workspace under `/root/source/...`, and treating the whole tree as sensitive made
    // every in-workspace write_file hit "sensitive path denied" with no usable approval
    // UI. Root's credentials are still covered by SECRET_HOME_DIRS under home_dir()
    // (when HOME=/root → /root/.ssh etc.) and by the exact `/root` equality check below.
    #[cfg(not(target_os = "windows"))]
    const SYSTEM_PROTECTED_PREFIXES: &[&str] = &[
        "/System",
        "/bin",
        "/sbin",
        "/usr",
        "/var",
        "/private/etc",
        "/private/var",
        "/etc",
    ];
    #[cfg(target_os = "windows")]
    const SYSTEM_PROTECTED_PREFIXES: &[&str] = &[
        r"C:\Windows",
        r"C:\Program Files",
        r"C:\Program Files (x86)",
        r"C:\ProgramData",
        r"C:\PerfLogs",
    ];
    #[cfg(not(target_os = "windows"))]
    const SYSTEM_PROTECTED_EXCEPTIONS: &[&str] = &[
        "/usr/local",
        "/private/usr/local",
        "/Applications",
        "/Library",
        "/var/folders",
        "/private/var/folders",
        "/var/tmp",
        "/private/var/tmp",
        // Scratch under /var/root is rare; real secrets still hit SECRET_HOME_DIRS.
        "/var/root/tmp",
        "/private/var/root/tmp",
    ];
    #[cfg(target_os = "windows")]
    const SYSTEM_PROTECTED_EXCEPTIONS: &[&str] = &[];
    const SECRET_HOME_DIRS: &[&str] = &[".ssh", ".aws", ".gnupg"];
    const SECRET_FILE_NAMES: &[&str] = &[
        ".bashrc",
        ".bash_profile",
        ".zshrc",
        ".zprofile",
        ".zshenv",
        ".npmrc",
        ".pypirc",
        ".env",
        ".env.local",
        "credentials",
        "id_rsa",
        "id_dsa",
        "id_ecdsa",
        "id_ed25519",
    ];
    const SECRET_EXTS: &[&str] = &["pem", "key", "p12", "pfx", "der", "crt", "cer"];

    // Exact root-home directory itself (not its project subtrees) stays protected so a
    // model cannot rewrite /root or /var/root as a file target.
    #[cfg(not(target_os = "windows"))]
    {
        if path == Path::new("/root")
            || path == Path::new("/var/root")
            || path == Path::new("/private/var/root")
        {
            return true;
        }
    }

    let has_protected_prefix = SYSTEM_PROTECTED_PREFIXES
        .iter()
        .any(|p| path == Path::new(p) || path.starts_with(p));
    let has_exception_prefix = SYSTEM_PROTECTED_EXCEPTIONS
        .iter()
        .any(|p| path == Path::new(p) || path.starts_with(p));
    if has_protected_prefix && !has_exception_prefix {
        return true;
    }

    if is_credential_path(path, &crate::paths::config_dir()) {
        return true;
    }

    if let Some(home) = home_dir() {
        for dir in SECRET_HOME_DIRS {
            if path.starts_with(home.join(dir)) {
                return true;
            }
        }
        for file in SECRET_FILE_NAMES {
            if path == home.join(file) {
                return true;
            }
        }
    }

    // Also treat classic root credential dirs as sensitive even when HOME is not /root
    // (e.g. process running as non-root but path points at /root/.ssh).
    #[cfg(not(target_os = "windows"))]
    {
        for root_home in ["/root", "/var/root", "/private/var/root"] {
            for dir in SECRET_HOME_DIRS {
                if path.starts_with(Path::new(root_home).join(dir)) {
                    return true;
                }
            }
            for file in SECRET_FILE_NAMES {
                if path == Path::new(root_home).join(file) {
                    return true;
                }
            }
        }
    }

    if path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|name| SECRET_FILE_NAMES.contains(&name))
    {
        return true;
    }
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| SECRET_EXTS.iter().any(|c| ext.eq_ignore_ascii_case(c)))
}

/// Resolve one of the built-in local read tools to the filesystem root it will touch.
/// External/MCP tools intentionally return `None`: their path semantics belong to the
/// provider, while the raw marker guard above still protects explicit credential strings.
fn local_read_target(tool: &str, args: &str, cwd: &Path) -> Option<PathBuf> {
    let value: serde_json::Value = serde_json::from_str(args).ok()?;
    let string = |key: &str| value.get(key).and_then(serde_json::Value::as_str);
    match tool {
        "read" | "read_file" => string("path")
            .or_else(|| string("file_path"))
            .map(|raw| super::resolve_path(raw, cwd)),
        "list_directory" => {
            let raw = string("target_directory")
                .or_else(|| string("path"))
                .unwrap_or(".");
            Some(super::resolve_path(raw, cwd))
        }
        "grep" => {
            let raw = string("path").unwrap_or(".");
            Some(super::resolve_path(raw, cwd))
        }
        "glob" => {
            let pattern = string("pattern")?;
            if let Some((base, _)) = super::glob::split_absolute_base(pattern) {
                Some(base)
            } else {
                let raw = string("path").unwrap_or(".");
                Some(super::resolve_path(raw, cwd))
            }
        }
        _ => None,
    }
}

/// Canonicalize as much of `path` as exists, then re-attach any missing suffix.
/// This resolves symlink/junction parents for not-yet-created write targets such as
/// `workspace/link/new.txt` where `link` points into `~/.ssh`.
pub(crate) fn has_unresolved_parent_traversal(path: &Path) -> bool {
    crate::pathnorm::canonicalize(path).is_err()
        && path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
}

pub(crate) fn resolved_filesystem_path(path: &Path) -> PathBuf {
    if let Ok(canon) = crate::pathnorm::canonicalize(path) {
        return canon;
    }

    // A missing prefix followed by `..` cannot be reduced safely without first
    // creating that prefix: lexical normalization would be wrong across symlinks,
    // while deepest-existing-ancestor fallback can incorrectly classify an escape
    // as inside the workspace. Keep the unresolved spelling so callers can fail
    // closed instead of manufacturing a misleading canonical identity.
    if has_unresolved_parent_traversal(path) {
        return path.to_path_buf();
    }

    let mut ancestor = path.parent();
    while let Some(existing) = ancestor {
        if let Ok(canon) = crate::pathnorm::canonicalize(existing) {
            if let Ok(suffix) = path.strip_prefix(existing) {
                return canon.join(suffix);
            }
            return canon;
        }
        ancestor = existing.parent();
    }
    path.to_path_buf()
}

/// Classify the actual filesystem target, not just the model-supplied spelling.
/// `path_is_sensitive` carries the legacy path policy; feeding the resolved identity
/// through `references_sensitive_path` keeps the wider marker set (.kube, gcloud,
/// docker config, `.env.*`, etc.) after a benign symlink name has been resolved.
pub(crate) fn resolved_target_sensitivity(raw: &str, cwd: &Path) -> (bool, PathBuf) {
    let resolved = super::resolve_path(raw, cwd);
    if has_unresolved_parent_traversal(&resolved) {
        return (true, resolved);
    }
    let identity = resolved_filesystem_path(&resolved);
    let marker_args = serde_json::json!({
        "file_path": crate::pathnorm::to_display(&identity),
    })
    .to_string();
    (
        path_is_sensitive(&identity) || references_sensitive_path(&marker_args),
        identity,
    )
}

fn local_read_target_sensitivity(tool: &str, args: &str, cwd: &Path) -> Option<(bool, PathBuf)> {
    let target = local_read_target(tool, args, cwd)?;
    let identity = resolved_filesystem_path(&target);
    let marker_args = serde_json::json!({
        "file_path": crate::pathnorm::to_display(&identity),
    })
    .to_string();
    Some((
        path_is_sensitive(&identity) || references_sensitive_path(&marker_args),
        identity,
    ))
}

/// Require approval before an otherwise-`Safe` tool reads a sensitive path.
pub struct SensitivePathGate {
    store: Arc<dyn PermissionStore>,
    cwd: Arc<RwLock<PathBuf>>,
    kind: String,
}

impl SensitivePathGate {
    pub fn new(cwd: Arc<RwLock<PathBuf>>) -> Self {
        Self {
            store: Arc::new(InMemoryPermissionStore::new()),
            cwd,
            kind: APPROVAL_KIND.to_string(),
        }
    }

    pub fn pinned(root: PathBuf) -> Self {
        Self::new(Arc::new(RwLock::new(root)))
    }

    /// Use a caller-supplied (e.g. shared / persisted) grant store.
    pub fn with_store(cwd: Arc<RwLock<PathBuf>>, store: Arc<dyn PermissionStore>) -> Self {
        Self {
            store,
            cwd,
            kind: APPROVAL_KIND.to_string(),
        }
    }
}

#[async_trait]
impl ToolMiddleware for SensitivePathGate {
    async fn before(
        &self,
        call: &mut ToolCall,
        tool: &Arc<dyn Tool>,
        rt: &RequestCtx,
    ) -> BeforeOutcome {
        // Only tools that would otherwise SKIP approval need this — a Risky tool already
        // round-trips through ApprovalMiddleware, so gating it here would double-prompt.
        if tool.risk(&call.arguments) != RiskLevel::Safe {
            return BeforeOutcome::Proceed;
        }
        let raw_sensitive = references_sensitive_path(&call.arguments);
        let local_tool = matches!(
            tool.name(),
            "read_file" | "list_directory" | "grep" | "glob"
        );

        let mut sensitive = raw_sensitive;
        let mut canonical_identity = None::<String>;
        let mut rememberable = true;

        if local_tool {
            let cwd = match self.cwd.read().ok().map(|g| g.clone()) {
                Some(cwd) => cwd,
                None => {
                    // A poisoned cwd lock means a local Safe read cannot be resolved.
                    // Fail closed through the normal sensitive-read prompt and never cache it.
                    sensitive = true;
                    rememberable = false;
                    PathBuf::new()
                }
            };

            if !cwd.as_os_str().is_empty() {
                let tool_name = tool.name().to_string();
                let args = call.arguments.clone();
                let cwd_for_check = cwd.clone();
                let classified = super::run_bounded(super::gate_fs_timeout(), None, move || {
                    local_read_target_sensitivity(&tool_name, &args, &cwd_for_check)
                })
                .await;

                match classified {
                    Some((is_sensitive, identity)) => {
                        sensitive |= is_sensitive;
                        canonical_identity = Some(crate::pathnorm::path_case_key(&identity));
                    }
                    None => {
                        // `None` can mean malformed args (the tool will reject them) or an FS
                        // classification timeout. Only a well-formed built-in target is security
                        // relevant; distinguish it without touching the filesystem again.
                        if local_read_target(tool.name(), &call.arguments, &cwd).is_some() {
                            sensitive = true;
                            rememberable = false;
                        }
                    }
                }
            }
        }

        if !sensitive {
            return BeforeOutcome::Proceed;
        }
        // Distinct key namespace so a "sensitive-read always" grant never silently widens
        // an ordinary approval grant (and vice versa).
        let key = match canonical_identity {
            Some(identity) => format!("sensitive::{}::{}::{}", call.name, identity, call.arguments),
            None => format!("sensitive::{}::{}", call.name, call.arguments),
        };
        if rememberable && self.store.is_granted(&key) {
            return BeforeOutcome::Proceed;
        }
        let payload = serde_json::to_value(ApprovalRequest {
            call_id: call.id.clone(),
            tool: tool.name().to_string(),
            args: call.arguments.clone(),
        })
        .unwrap_or(serde_json::Value::Null);
        match PermissionDecision::from_value(&rt.request(&self.kind, payload).await) {
            PermissionDecision::AllowOnce => BeforeOutcome::Proceed,
            PermissionDecision::AllowAlways => {
                if rememberable {
                    self.store.grant(&key);
                }
                BeforeOutcome::Proceed
            }
            PermissionDecision::Deny => BeforeOutcome::deny(format!(
                "reading a sensitive path was denied by the user: {}。用户显式拒绝了该操作，请停下来询问用户意图 (The user explicitly denied this operation. Please stop and ask the user for their intent).",
                tool.name()
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::mpsc::unbounded_channel;

    #[test]
    fn detects_credential_paths_not_ordinary_content() {
        // Credential stores → flagged.
        assert!(references_sensitive_path(
            r#"{"file_path":"/home/u/.ssh/id_rsa"}"#
        ));
        assert!(
            references_sensitive_path(r#"{"file_path":"/home/u/.ssh"}"#),
            "the .ssh dir too"
        );
        assert!(references_sensitive_path(r#"{"file_path":"/proj/.env"}"#));
        assert!(references_sensitive_path(
            r#"{"file_path":"/proj/.env.local"}"#
        ));
        assert!(
            references_sensitive_path(r#"{"file_path":"/proj/.env.production"}"#),
            "real secret variant"
        );
        assert!(references_sensitive_path(
            r#"{"file_path":"/home/u/.jeikcode/auth.toml"}"#
        ));
        assert!(references_sensitive_path(
            r#"{"command":"cat ~/.jeikcode/auth.toml"}"#
        ));
        assert!(references_sensitive_path(
            r#"{"file_path":"C:\\Users\\u\\.jeikcode\\auth.toml"}"#
        ));
        // Placeholder templates (committed to VCS, no real secrets) → NOT flagged.
        assert!(
            !references_sensitive_path(r#"{"file_path":"/proj/.env.example"}"#),
            ".env.example is a template"
        );
        assert!(!references_sensitive_path(
            r#"{"file_path":"/proj/.env.sample"}"#
        ));
        assert!(!references_sensitive_path(
            r#"{"file_path":"/proj/.env.template"}"#
        ));
        assert!(!references_sensitive_path(
            r#"{"file_path":"/proj/.env.dist"}"#
        ));
        assert!(references_sensitive_path(
            r#"{"path":"/home/u/.aws/credentials"}"#
        ));
        assert!(references_sensitive_path(
            r#"{"file_path":"/etc/ssl/server.pem"}"#
        ));
        assert!(
            references_sensitive_path(r#"{"file_path":"C:\\Users\\u\\.ssh\\id_ed25519"}"#),
            "windows key"
        );
        // Ordinary reads / searches → NOT flagged.
        assert!(!references_sensitive_path(r#"{"file_path":"src/main.rs"}"#));
        assert!(
            !references_sensitive_path(r#"{"pattern":"secret","path":"src/"}"#),
            "grep word 'secret'"
        );
        assert!(
            !references_sensitive_path(r#"{"path":"/proj/.environment/cfg"}"#),
            "no .env false-trip"
        );
    }

    fn silent_rt() -> RequestCtx {
        // No driver drains the request → a bounded round-trip times out → Null → Deny.
        let (tx, _rx) = unbounded_channel();
        RequestCtx::new(tx, Some(Duration::from_millis(20)))
    }

    #[tokio::test]
    async fn safe_ordinary_read_passes_without_round_trip() {
        let gate = SensitivePathGate::pinned(std::env::temp_dir());
        let tool: Arc<dyn Tool> = Arc::new(crate::tools::read::ReadFileTool::default());
        let mut call = ToolCall {
            id: "1".into(),
            name: "read_file".into(),
            arguments: r#"{"file_path":"src/main.rs"}"#.into(),
        };
        // Ordinary path → Proceed WITHOUT awaiting the (silent) driver.
        assert!(!gate.before(&mut call, &tool, &silent_rt()).await.is_deny());
    }

    #[tokio::test]
    async fn risky_tool_defers_to_approval_middleware() {
        // A Risky tool is ApprovalMiddleware's job; this gate must skip it (no double-prompt)
        // even if its args look sensitive.
        let gate = SensitivePathGate::pinned(std::env::temp_dir());
        let tool: Arc<dyn Tool> = Arc::new(crate::tools::write::WriteFileTool);
        let mut call = ToolCall {
            id: "1".into(),
            name: "write_file".into(),
            arguments: r#"{"file_path":"/home/u/.ssh/authorized_keys","content":"x"}"#.into(),
        };
        assert!(!gate.before(&mut call, &tool, &silent_rt()).await.is_deny());
    }

    #[tokio::test]
    async fn sensitive_read_fails_closed_when_driver_silent() {
        let gate = SensitivePathGate::pinned(std::env::temp_dir());
        let tool: Arc<dyn Tool> = Arc::new(crate::tools::read::ReadFileTool::default());
        let mut call = ToolCall {
            id: "1".into(),
            name: "read_file".into(),
            arguments: r#"{"file_path":"/home/u/.ssh/id_rsa"}"#.into(),
        };
        let res = gate.before(&mut call, &tool, &silent_rt()).await;
        assert!(
            res.is_deny(),
            "a sensitive read with no approval must fail closed"
        );
        assert!(res.deny_reason().unwrap().contains("sensitive path"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sensitive_read_through_benign_symlink_still_prompts() {
        use std::os::unix::fs::symlink;

        let ws = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("id_rsa");
        std::fs::write(&secret, "PRIVATE").unwrap();
        symlink(&secret, ws.path().join("notes.txt")).unwrap();

        let gate = SensitivePathGate::pinned(ws.path().to_path_buf());
        let tool: Arc<dyn Tool> = Arc::new(crate::tools::read::ReadFileTool::default());
        let mut call = ToolCall {
            id: "1".into(),
            name: "read_file".into(),
            arguments: r#"{"file_path":"notes.txt"}"#.into(),
        };

        let res = gate.before(&mut call, &tool, &silent_rt()).await;
        assert!(
            res.is_deny(),
            "a benign symlink name must not bypass sensitive-read approval"
        );
    }

    #[test]
    fn extracts_only_builtin_local_read_targets() {
        let cwd = Path::new("workspace");
        assert_eq!(
            local_read_target("read_file", r#"{"file_path":"src/main.rs"}"#, cwd),
            Some(cwd.join("src/main.rs"))
        );
        assert_eq!(
            local_read_target("list_directory", r#"{"path":"src"}"#, cwd),
            Some(cwd.join("src"))
        );
        assert_eq!(
            local_read_target("grep", r#"{"pattern":"needle"}"#, cwd),
            Some(cwd.to_path_buf())
        );
        assert_eq!(
            local_read_target("glob", r#"{"pattern":"*.rs","path":"src"}"#, cwd),
            Some(cwd.join("src"))
        );
        assert_eq!(
            local_read_target("repo_map", r#"{"path":"src"}"#, cwd),
            None,
            "scope is intentionally limited to built-in local file tools"
        );
    }

    /// The credential guard follows `$JEIKCODE_HOME`. Driven through the pure
    /// cores so no test has to mutate the process-global env (libtest runs these
    /// in parallel threads, and the crate's `#[ctor]` already owns that var).
    #[test]
    fn the_credential_guard_follows_a_relocated_config_dir() {
        let moved = Path::new("/opt/ac");
        assert!(is_credential_path(Path::new("/opt/ac/auth.toml"), moved));
        assert!(is_credential_path(
            Path::new("/opt/ac/auth/token.json"),
            moved
        ));
        // The default location is NOT special-cased: with the tree moved, that
        // path is an ordinary file. `SENSITIVE_MARKERS` still covers the raw-arg
        // spelling — see `the_default_credential_markers_survive_relocation`.
        assert!(!is_credential_path(
            Path::new("/home/u/.jeikcode/auth.toml"),
            moved
        ));
        // Prefix-of-a-name must not count: `auth.toml.bak` is a different file,
        // and `authors/` is not the credential dir.
        assert!(!is_credential_path(Path::new("/opt/ac/authors"), moved));

        let default = Path::new("/home/u/.jeikcode");
        assert!(is_credential_path(
            Path::new("/home/u/.jeikcode/auth.toml"),
            default
        ));
    }

    #[test]
    fn markers_are_derived_from_the_configured_dir() {
        assert_eq!(
            credential_markers_for(Path::new("/opt/AC")),
            vec!["/opt/ac/auth.toml".to_string(), "/opt/ac/auth/".to_string()],
            "lowercased so it matches the lowercased args"
        );
        // Windows dirs reach the matcher `/`-normalized, like every other marker.
        assert_eq!(
            credential_markers_for(Path::new(r"C:\ac")),
            vec!["c:/ac/auth.toml".to_string(), "c:/ac/auth/".to_string()]
        );
        // A trailing separator must not double up.
        assert_eq!(
            credential_markers_for(Path::new("/opt/ac/")),
            vec!["/opt/ac/auth.toml".to_string(), "/opt/ac/auth/".to_string()]
        );
        assert!(credential_markers_for(Path::new("")).is_empty());
    }

    /// End-to-end through the read gate's own entry point. The `#[ctor]` points
    /// `$JEIKCODE_HOME` at a temp dir for the whole test binary, so this path is
    /// NOT under `~/.jeikcode` and `SENSITIVE_MARKERS` cannot match it — only the
    /// configured markers can. That is exactly the case that used to slip through.
    #[test]
    fn a_relocated_credential_path_is_flagged_in_raw_args() {
        let dir = crate::paths::config_dir();
        assert!(
            !dir.to_string_lossy().contains(".jeikcode"),
            "precondition: the harness must have moved the config dir off the \
             default, else the const markers would carry this test — got {}",
            dir.display()
        );

        let auth = dir.join("auth.toml");
        let args = serde_json::json!({ "file_path": auth.to_string_lossy() }).to_string();
        assert!(
            references_sensitive_path(&args),
            "credentials at the configured location must gate a Safe read: {args}"
        );

        let token = dir.join("auth").join("token.json");
        let args = serde_json::json!({ "command": format!("cat {}", token.display()) }).to_string();
        assert!(references_sensitive_path(&args), "{args}");

        // Same tree, ordinary file → still no prompt. Pins that the new markers
        // are path-shaped and did not widen into "anything under the config dir".
        let ordinary = dir.join("config.toml");
        let args = serde_json::json!({ "file_path": ordinary.to_string_lossy() }).to_string();
        assert!(!references_sensitive_path(&args), "{args}");
    }

    /// Relocating the tree must not stop flagging the default spelling: a model
    /// writes `~/.jeikcode/auth.toml` from habit, and that string is still worth
    /// a prompt whatever `$JEIKCODE_HOME` says.
    #[test]
    fn the_default_credential_markers_survive_relocation() {
        assert!(references_sensitive_path(
            r#"{"file_path":"/home/u/.jeikcode/auth.toml"}"#
        ));
        assert!(references_sensitive_path(
            r#"{"command":"cat ~/.jeikcode/auth/token.json"}"#
        ));
    }
}
