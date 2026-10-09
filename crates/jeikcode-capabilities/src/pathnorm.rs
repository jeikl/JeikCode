//! ONE home for Windows path normalization in the v2 (L1) stack.
//!
//! Two-form model:
//!   * INTERNAL identity  → native, canonicalized, WITHOUT the `\\?\` verbatim
//!     prefix. Produced by [`canonicalize`] / [`strip_verbatim`]. Use these
//!     instead of raw `std::fs::canonicalize`, whose Windows result carries a
//!     `\\?\` prefix that leaks into working_dir / session hashes / model context
//!     if not stripped (jeikcode's recurring pain — Node gets this free, Rust
//!     doesn't).
//!   * BOUNDARY / display → forward slashes. Produced by [`to_display`]. Use it
//!     for every path that crosses into an LLM tool result, the env block, or the
//!     UI: a raw backslash path breaks when the model pastes it into `bash`
//!     (Git Bash eats `\U`/`\s`/`\t` as escapes) and reads as noise to the model.
//!
//! L1 is `#![deny]`-decoupled from `jeikcode-core`, so this is a local copy of the
//! same logic that lives in `jeikcode_core::tool::strip_verbatim_prefix` — the
//! established "capabilities keeps its own copies" pattern (see `pathutil`,
//! `process_utils`, `proxy`).

use std::borrow::Cow;
use std::path::{Path, PathBuf};

/// Strip the Windows verbatim prefix (`\\?\`) / verbatim-UNC prefix (`\\?\UNC\`).
///
/// Also accepts the slash-folded spellings a web file browser produces when it
/// turns `\` into `/` (`//?/C:/...`, `//?/UNC/...`) or drops one slash
/// (`/?/C:/...`). A POSIX path is left untouched — `/?/` is stripped only when
/// a drive letter follows, so a Unix directory that really is named `?` stays.
pub fn strip_verbatim(path: &str) -> Cow<'_, str> {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return Cow::Owned(format!(r"\\{rest}"));
    }
    if let Some(rest) = strip_unc_slash_prefix(path, "//?/UNC/") {
        return Cow::Owned(format!("//{rest}"));
    }
    if let Some(rest) = strip_unc_slash_prefix(path, "/?/UNC/") {
        return Cow::Owned(format!("//{rest}"));
    }
    if let Some(rest) = path.strip_prefix(r"\??\UNC\") {
        return Cow::Owned(format!(r"\\{rest}"));
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return Cow::Borrowed(rest);
    }
    if let Some(rest) = path.strip_prefix(r"\??\") {
        return Cow::Borrowed(rest);
    }
    if let Some(rest) = path.strip_prefix("//?/") {
        if looks_like_win_drive(rest) {
            return Cow::Borrowed(rest);
        }
    }
    if let Some(rest) = path.strip_prefix("/?/") {
        if looks_like_win_drive(rest) {
            return Cow::Borrowed(rest);
        }
    }
    Cow::Borrowed(path)
}

fn strip_unc_slash_prefix<'a>(path: &'a str, prefix: &str) -> Option<&'a str> {
    let head = path.get(..prefix.len())?;
    if head.eq_ignore_ascii_case(prefix) {
        path.get(prefix.len()..)
    } else {
        None
    }
}

fn looks_like_win_drive(rest: &str) -> bool {
    let mut chars = rest.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() {
        return false;
    }
    let Some(second) = chars.next() else {
        return false;
    };
    second == ':' || second == '\u{FF1A}'
}

/// [`strip_verbatim`] for `Path` callers; allocates a fresh `PathBuf`.
pub fn strip_verbatim_path(path: &Path) -> PathBuf {
    PathBuf::from(strip_verbatim(&path.to_string_lossy()).as_ref())
}

/// A platform-aware key for de-duplicating paths that refer to the same
/// directory but differ only in case. Case-insensitive filesystems (Windows,
/// macOS default) fold case; case-sensitive ones (Linux) keep the path verbatim,
/// so `C:\Users` and `C:\users` collapse to one entry on Windows/macOS but
/// distinct paths stay distinct on Linux.
///
/// This is a COMPARISON key only, never persisted — folding on macOS here does
/// NOT touch the session-bucket hash (`session::hash_path`, which stays as-is to
/// avoid orphaning existing sessions).
///
/// Mirrors `session::hash_path`'s string normalization (strip `\\?\`, unify
/// separators, drop a trailing slash) so different spellings of one directory —
/// `C:\Users`, `C:/Users`, `\\?\C:\Users\` — share a key, then case-folds on
/// case-insensitive filesystems. `to_lowercase` (not ASCII) matches `hash_path`.
pub fn path_case_key(path: &Path) -> String {
    let s = strip_verbatim(&path.to_string_lossy()).into_owned();
    let mut s = s.replace('\\', "/");
    if s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        s.to_lowercase()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        s
    }
}

/// `std::fs::canonicalize` with the Windows `\\?\` verbatim prefix stripped, so the
/// result is a stable NATIVE path safe to store, hash, compare, or hand to another
/// tool. The single source of path identity — prefer this over raw `canonicalize`
/// so the prefix can never leak again.
pub fn canonicalize(path: &Path) -> std::io::Result<PathBuf> {
    std::fs::canonicalize(path).map(|p| strip_verbatim_path(&p))
}

/// Format a path for the LLM / UI / permission BOUNDARY.
///
/// On Windows, convert `\` → `/` (and strip any `\\?\`): the result works
/// uniformly for `read_file`, Python, and Git Bash, whereas a raw backslash path
/// breaks bash invocation. The conversion is LOSSLESS — on Windows `\` is always a
/// path separator and is illegal inside a filename. On Unix, `\` is a legal
/// filename character (not a separator), so the path is returned untouched.
pub fn to_display(path: &Path) -> String {
    let stripped = strip_verbatim(&path.to_string_lossy()).into_owned();
    if cfg!(windows) {
        stripped.replace('\\', "/")
    } else {
        stripped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_verbatim_disk_and_unc_and_noop() {
        assert_eq!(strip_verbatim(r"\\?\C:\Users\x"), r"C:\Users\x");
        assert_eq!(
            strip_verbatim(r"\\?\UNC\server\share\x"),
            r"\\server\share\x"
        );
        assert_eq!(strip_verbatim("/home/u/x"), "/home/u/x"); // POSIX untouched
        assert_eq!(strip_verbatim(r"C:\already\plain"), r"C:\already\plain");
        // Slash-folded extended paths from a web file browser.
        assert_eq!(strip_verbatim("//?/E:/code/Jeikcode"), "E:/code/Jeikcode");
        assert_eq!(strip_verbatim("/?/E:/code/Jeikcode"), "E:/code/Jeikcode");
        assert_eq!(strip_verbatim("//?/UNC/server/share/x"), "//server/share/x");
        assert_eq!(strip_verbatim("/?/UNC/server/share/x"), "//server/share/x");
        // A real POSIX directory named "?" must survive.
        assert_eq!(strip_verbatim("/?/not-a-drive"), "/?/not-a-drive");
    }

    #[test]
    fn to_display_normalizes_only_on_windows() {
        // The transform is platform-branched, so assert per-target to stay green
        // on the CI host (macOS) while still pinning the Windows behavior.
        let p = Path::new(r"C:\Users\x\wiki");
        if cfg!(windows) {
            assert_eq!(to_display(p), "C:/Users/x/wiki");
        }
        // Verbatim prefix is always stripped, regardless of platform branch.
        assert!(!to_display(Path::new(r"\\?\C:\a\b")).contains(r"\\?\"));
        // POSIX path is untouched on Unix.
        #[cfg(not(windows))]
        assert_eq!(to_display(Path::new("/home/u/x")), "/home/u/x");
    }

    #[test]
    fn to_display_strips_verbatim_prefix() {
        // On any platform, the `\\?\` string form must be gone from the output.
        let out = to_display(Path::new(r"\\?\C:\repo\src\main.rs"));
        assert!(
            !out.starts_with(r"\\?\"),
            "verbatim prefix must be stripped: {out}"
        );
    }

    #[test]
    fn strip_verbatim_preserves_multibyte_and_chinese_paths_without_panic() {
        // Non-ASCII characters whose byte positions align across prefix lengths
        // must never trigger boundary-slicing panics.
        assert_eq!(strip_verbatim(r"\\?\D:\桌面\项目"), r"D:\桌面\项目");
        assert_eq!(strip_verbatim(r"//?/D:\桌面\项目"), r"D:\桌面\项目");
        assert_eq!(strip_verbatim(r"/?/D:\桌面\项目"), r"D:\桌面\项目");
        assert_eq!(strip_verbatim(r"\??\D:\桌面\项目"), r"D:\桌面\项目");
        assert_eq!(strip_verbatim(r"//?/D：\桌面\项目"), r"D：\桌面\项目");
        assert_eq!(
            strip_verbatim(r"//?/UNC/服务器\共享\测试"),
            r"//服务器\共享\测试"
        );
        assert_eq!(
            strip_verbatim(r"/?/unc/服务器\共享\测试"),
            r"//服务器\共享\测试"
        );
        assert_eq!(
            strip_verbatim(r"\??\UNC\服务器\共享\测试"),
            r"\\服务器\共享\测试"
        );
        assert_eq!(strip_verbatim(r"D:\桌面\项目"), r"D:\桌面\项目");
        assert_eq!(strip_verbatim(r"//?/笔"), r"//?/笔");
        assert_eq!(
            strip_verbatim(r"//?/日本語フォルダ/プロジェクト"),
            r"//?/日本語フォルダ/プロジェクト"
        );
        assert_eq!(
            strip_verbatim(r"//?/C:/日本語フォルダ"),
            r"C:/日本語フォルダ"
        );
        assert_eq!(strip_verbatim(r"//?/D:\مجلد\مشروع"), r"D:\مجلد\مشروع");
    }
}
