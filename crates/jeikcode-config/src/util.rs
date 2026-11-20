//! Small self-contained helpers config needs, vendored from `jeikcode-core` so this
//! crate stays a leaf (no core dependency). Behavior-identical copies:
//!   - [`real_home_dir`] mirrors `jeikcode_core::tool::real_home_dir` (sudo-aware).

use std::path::{Path, PathBuf};

/// Stable bucket key shared by session storage and project-scoped trust data.
/// The `PathBuf` hash is part of the existing on-disk format and must not be
/// replaced with a plain string hash.
pub fn stable_project_hash(path: &Path) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    // The same project can arrive as `E:\\code\\x`, `E:/code/x`, or
    // `\\\\?\\E:\\code\\x` (std::fs::canonicalize on Windows). The verbatim
    // prefix is an IO namespace marker, not project identity; strip it before
    // hashing or every window creates a second empty project bucket.
    let raw = path.to_string_lossy();
    let raw = raw
        .strip_prefix(r"\\?\")
        .or_else(|| raw.strip_prefix("//?/"))
        .unwrap_or(&raw);
    let mut normalized = raw.replace('\\', "/");
    if normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    #[cfg(windows)]
    let normalized = normalized.to_lowercase();

    let mut hasher = DefaultHasher::new();
    PathBuf::from(normalized).hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Resolve the invoking user's real home dir, sudo-aware: under `sudo`, `$HOME`
/// points at root, so consult `SUDO_USER` via `getpwnam` first (avoids creating a
/// root-owned `~/.jeikcode`). Falls back to `dirs::home_dir()`.
pub fn real_home_dir() -> Option<PathBuf> {
    if let Ok(sudo_user) = std::env::var("SUDO_USER") {
        if let Some(home) = get_user_home(&sudo_user) {
            return Some(home);
        }
    }
    dirs::home_dir()
}

/// Look up a user's home dir via `getpwnam_r` (Unix). Returns `None` on non-Unix.
#[cfg(unix)]
fn get_user_home(username: &str) -> Option<PathBuf> {
    use std::ffi::CString;
    use std::ptr;

    let username_c = CString::new(username).ok()?;
    // SAFETY: getpwnam_r is the thread-safe passwd lookup; `result` is checked
    // non-null before `pwd.pw_dir` is read, and the buffer outlives the call.
    unsafe {
        let mut pwd: libc::passwd = std::mem::zeroed();
        let mut buf = vec![0u8; 4096];
        let mut result: *mut libc::passwd = ptr::null_mut();

        let ret = libc::getpwnam_r(
            username_c.as_ptr(),
            &mut pwd,
            buf.as_mut_ptr() as *mut libc::c_char,
            buf.len(),
            &mut result,
        );

        if ret == 0 && !result.is_null() {
            let home = std::ffi::CStr::from_ptr(pwd.pw_dir)
                .to_string_lossy()
                .into_owned();
            return Some(PathBuf::from(home));
        }
    }
    None
}

#[cfg(not(unix))]
fn get_user_home(_username: &str) -> Option<PathBuf> {
    None
}

/// Heuristic: does this model name look vision-capable? Verbatim copy of
/// `jeikcode_capabilities::provider::model_suggests_vision`. Fallback only —
/// preferred path is explicit `supports_vision` on the model/provider config;
/// openai/claude/anthropic default to false when unset (opt-in; see
/// [`crate::config::provider::resolve_supports_vision`]). MUST stay in sync
/// with the capabilities copy.
pub fn model_name_suggests_vision(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("vision")
        || n.contains("-vl")
        || n.contains("vl-")
        || n.contains("ocr")
        || n.contains("-4v")
        || n.contains("-4.1v")
        || n.starts_with("gpt-4o")
        || n.starts_with("claude-3")
        || n.starts_with("claude-4")
        || n.starts_with("claude-5")
        || n.starts_with("claude-6")
        || n.starts_with("claude-7")
        || n.starts_with("claude-sonnet")
        || n.starts_with("claude-opus")
        || n.starts_with("claude-haiku")
        || n.starts_with("gemini")
        || n.starts_with("pixtral")
        || n.contains("llava")
        || n.contains("qvq")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn stable_project_hash_keeps_existing_disk_key() {
        // This fixture literal is part of the on-disk key contract: intentionally
        // renaming it MUST update the golden in the same commit. The previous
        // atomcode -> jeikcode rename left the golden stale and was initially
        // misread as a Rust 1.93 hash change.
        assert_eq!(
            stable_project_hash(Path::new("/tmp/stable-project-hash-fixture")),
            "6d9c2b29f6bff579"
        );
    }

    #[test]
    fn verbatim_prefix_does_not_change_project_hash() {
        assert_eq!(
            stable_project_hash(Path::new(r"\\?\E:\code\jeikcode")),
            stable_project_hash(Path::new(r"E:\code\jeikcode"))
        );
        assert_eq!(
            stable_project_hash(Path::new("//?/E:/code/jeikcode")),
            stable_project_hash(Path::new("E:/code/jeikcode"))
        );
    }
}
