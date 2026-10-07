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
/// No-op for every path without it (including all POSIX paths).
pub fn strip_verbatim(path: &str) -> Cow<'_, str> {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        Cow::Owned(format!(r"\\{rest}"))
    } else if let Some(rest) = path.strip_prefix("//?/UNC/") {
        Cow::Owned(format!("//{rest}"))
    } else if let Some(rest) = path.strip_prefix("//?/") {
        Cow::Borrowed(rest)
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        Cow::Borrowed(rest)
    } else {
        Cow::Borrowed(path)
    }
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

/// Native identity for CodeIntel file keys, including Windows short-name aliases.
pub(crate) fn codeintel_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        // Mở rộng alias 8.3 ở cả walker và editor; file đã xóa vẫn dùng identity của thư mục cha.
        let plain = PathBuf::from(strip_verbatim(&path.to_string_lossy()).replace('/', "\\"));
        let mut ancestor = plain.as_path();
        let mut suffix = Vec::new();
        loop {
            if let Ok(mut resolved) = canonicalize(ancestor) {
                for name in suffix.iter().rev() {
                    resolved.push(name);
                }
                return resolved;
            }
            let Some(name) = ancestor.file_name() else {
                break;
            };
            suffix.push(name.to_os_string());
            let Some(parent) = ancestor.parent() else {
                break;
            };
            ancestor = parent;
        }
        let mut s = plain.to_string_lossy().into_owned();
        if s.as_bytes().get(1) == Some(&b':') && s.as_bytes()[0].is_ascii_alphabetic() {
            s.replace_range(..1, &s[..1].to_ascii_uppercase());
        }
        PathBuf::from(s)
    }
    #[cfg(not(windows))]
    {
        // Không canonicalize trên Unix: giữ nguyên case, symlink và ký tự backslash hợp lệ.
        path.to_path_buf()
    }
}

pub(crate) fn codeintel_component_eq(a: &std::ffi::OsStr, b: &std::ffi::OsStr) -> bool {
    #[cfg(windows)]
    {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

/// Relative path using native components, never byte offsets into folded strings.
pub(crate) fn codeintel_relative(path: &Path, root: &Path) -> Option<PathBuf> {
    let path = codeintel_path(path);
    let root = codeintel_path(root);
    let mut components = path.components();
    for expected in root.components() {
        let actual = components.next()?;
        if !codeintel_component_eq(actual.as_os_str(), expected.as_os_str()) {
            return None;
        }
    }
    Some(components.as_path().to_path_buf())
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
    fn codeintel_unc_prefix_preserves_share_root() {
        assert_eq!(
            strip_verbatim(r"\\?\UNC\server\share\src"),
            r"\\server\share\src"
        );
        assert_eq!(
            strip_verbatim("//?/UNC/server/share/src"),
            "//server/share/src"
        );
        assert_eq!(strip_verbatim("//?/C:/src"), "C:/src");
        // Textual coverage only: these assertions never access an SMB share.
        for (verbatim, plain) in [
            (r"\\?\UNC\server\share", r"\\server\share"),
            (r"\\?\UNC\server\share\", r"\\server\share\"),
            (
                r"\\?\UNC\server\share\目录\MiXeD.rs",
                r"\\server\share\目录\MiXeD.rs",
            ),
            ("//?/UNC/server/share", "//server/share"),
            ("//?/UNC/server/share/", "//server/share/"),
            (
                "//?/UNC/server/share/目录/MiXeD.rs",
                "//server/share/目录/MiXeD.rs",
            ),
        ] {
            assert_eq!(strip_verbatim(verbatim), plain);
            assert_eq!(strip_verbatim(plain), plain);
            assert_eq!(
                strip_verbatim_path(Path::new(verbatim)),
                PathBuf::from(plain)
            );
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn codeintel_unix_identity_preserves_case_and_backslashes() {
        // Chỉ dùng path tổng hợp: Unicode và backslash là tên file hợp lệ trên Unix.
        let native = Path::new(r"/repo/目录\MiXeD.rs");
        assert_eq!(codeintel_path(native), native);
        assert_eq!(
            codeintel_relative(native, Path::new("/repo")),
            Some(PathBuf::from(r"目录\MiXeD.rs"))
        );
        let prefix_like = Path::new(r"\\?\目录\MiXeD.rs");
        assert_eq!(codeintel_path(prefix_like), prefix_like);
        assert_ne!(
            codeintel_path(Path::new("/repo/A")),
            codeintel_path(Path::new("/repo/a"))
        );
        assert_eq!(
            codeintel_path(Path::new(r"/repo/a\b")),
            Path::new(r"/repo/a\b")
        );
        assert!(codeintel_relative(Path::new("/repo-other/a"), Path::new("/repo")).is_none());
        assert!(codeintel_relative(Path::new("/Repo/a"), Path::new("/repo")).is_none());
        assert_eq!(
            codeintel_relative(Path::new(r"/repo/a\b"), Path::new("/repo")),
            Some(PathBuf::from(r"a\b"))
        );
    }

    #[cfg(windows)]
    #[test]
    fn codeintel_windows_existing_and_deleted_alias_identity() {
        let root = std::env::temp_dir().join(format!("codeintel-pathnorm-{}", std::process::id()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        let file = root.join("src").join("MiXeD.rs");
        std::fs::write(&file, "fn example() {}\n").unwrap();
        let canonical_file = canonicalize(&file).unwrap();
        let canonical_root = canonicalize(&root).unwrap();
        let alternate = PathBuf::from(
            file.to_string_lossy()
                .replace('\\', "/")
                .to_ascii_lowercase(),
        );
        assert_eq!(codeintel_path(&file), codeintel_path(&canonical_file));
        assert_eq!(codeintel_path(&alternate), codeintel_path(&canonical_file));
        assert_eq!(
            codeintel_relative(&file, &canonical_root),
            Some(PathBuf::from(r"src\MiXeD.rs"))
        );
        assert!(codeintel_relative(&file, &root.with_extension("other")).is_none());
        let verbatim = PathBuf::from(format!(r"\\?\{}", canonical_file.display()));
        assert_eq!(codeintel_path(&verbatim), codeintel_path(&file));
        std::fs::remove_file(&file).unwrap();
        assert_eq!(codeintel_path(&file), codeintel_path(&canonical_file));
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Manual prerequisite: an existing writable UNC directory, not a mapped drive.
    /// This is identity coverage; graph/SQLite alias coverage uses native fixtures.
    #[cfg(windows)]
    #[test]
    #[ignore = "requires user-supplied writable JEIKCODE_TEST_UNC_ROOT SMB directory"]
    fn codeintel_windows_real_unc_alias_identity() {
        let supplied = std::env::var_os("JEIKCODE_TEST_UNC_ROOT")
            .expect("set JEIKCODE_TEST_UNC_ROOT to an existing writable UNC directory");
        let root = PathBuf::from(supplied);
        assert!(
            matches!(root.components().next(), Some(std::path::Component::Prefix(p))
                if matches!(p.kind(), std::path::Prefix::UNC(_, _) | std::path::Prefix::VerbatimUNC(_, _))),
            "JEIKCODE_TEST_UNC_ROOT must be a UNC path, not a local or mapped drive"
        );
        assert!(root.is_dir(), "JEIKCODE_TEST_UNC_ROOT must already exist");
        // Never create/delete the supplied root; TempDir owns only this unique child.
        let fixture = tempfile::Builder::new()
            .prefix("jeikcode-unc-MiXeD-")
            .tempdir_in(&root)
            .expect("JEIKCODE_TEST_UNC_ROOT must be writable");
        let native_root = canonicalize(fixture.path()).unwrap();
        let file = native_root.join("MiXeD.rs");
        std::fs::write(&file, "fn example() {}\n").unwrap();
        let plain = codeintel_path(&file);
        let verbatim = std::fs::canonicalize(&file).unwrap();
        assert!(verbatim.to_string_lossy().starts_with(r"\\?\UNC\"));
        assert_eq!(codeintel_path(&verbatim), plain);
        let case_root = PathBuf::from(native_root.to_string_lossy().to_ascii_lowercase());
        assert_eq!(codeintel_path(&case_root), native_root);
        assert_eq!(
            codeintel_relative(&verbatim, &case_root),
            Some(PathBuf::from("MiXeD.rs"))
        );
        let verbatim_root = std::fs::canonicalize(&native_root).unwrap();
        assert_eq!(
            codeintel_relative(&file, &verbatim_root),
            Some(PathBuf::from("MiXeD.rs"))
        );
        std::fs::write(&verbatim, "fn updated() {}\n").unwrap();
        assert_eq!(codeintel_path(&verbatim), plain);
        std::fs::remove_file(&verbatim).unwrap();
        assert_eq!(codeintel_path(&verbatim), plain);
        assert_eq!(
            codeintel_relative(&verbatim, &case_root),
            Some(PathBuf::from("MiXeD.rs"))
        );
    }

    #[test]
    fn strip_verbatim_disk_and_unc_and_noop() {
        assert_eq!(strip_verbatim(r"\\?\C:\Users\x"), r"C:\Users\x");
        assert_eq!(
            strip_verbatim(r"\\?\UNC\server\share\x"),
            r"\\server\share\x"
        );
        assert_eq!(strip_verbatim("/home/u/x"), "/home/u/x"); // POSIX untouched
        assert_eq!(strip_verbatim(r"C:\already\plain"), r"C:\already\plain");
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
}
