//! POST `/fs/upload` — persist WebUI attachments under `{cwd}/.jeikcode_store`.
//!
//! Images stay on the chat `images` field (base64). Non-image files are written
//! here and referenced in the user message as absolute paths. If the project
//! already has a `.gitignore`, `.jeikcode_store/` is appended so uploads stay
//! out of VCS; `read`/`grep`/`glob`/`list_directory` still see the directory.

use crate::{json_error, AppState, normalize_dir_arg};
use atomcode_capabilities::tools::USER_UPLOAD_STORE_DIR;
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Json},
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const GITIGNORE_BLOCK: &str =
    "\n# JeikCode user uploads (not project source)\n.jeikcode_store/\n";
const MAX_FILES: usize = 20;
const MAX_FILE_BYTES: usize = 20 * 1024 * 1024;
const MAX_NAME_CHARS: usize = 180;
/// JSON+base64 inflates ~33%; 20MB payload plus wrapping needs headroom.
pub const UPLOAD_BODY_LIMIT_BYTES: usize = 48 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct FsUploadRequest {
    pub working_dir: String,
    pub files: Vec<FsUploadItem>,
}

#[derive(Debug, Deserialize)]
pub struct FsUploadItem {
    pub filename: String,
    pub data: String,
}

#[derive(Debug, Serialize)]
pub struct FsUploadResponse {
    pub paths: Vec<String>,
}

pub async fn fs_upload(
    State(_state): State<AppState>,
    Json(req): Json<FsUploadRequest>,
) -> impl IntoResponse {
    match save_uploads(&req) {
        Ok(paths) => Json(FsUploadResponse { paths }).into_response(),
        Err(e) => json_error(e.status, e.message).into_response(),
    }
}

#[derive(Debug)]
struct UploadError {
    status: StatusCode,
    message: String,
}

fn upload_err(status: StatusCode, message: impl Into<String>) -> UploadError {
    UploadError {
        status,
        message: message.into(),
    }
}

fn save_uploads(req: &FsUploadRequest) -> Result<Vec<String>, UploadError> {
    if req.working_dir.trim().is_empty() {
        return Err(upload_err(
            StatusCode::BAD_REQUEST,
            "working_dir is required",
        ));
    }
    if req.files.is_empty() {
        return Err(upload_err(StatusCode::BAD_REQUEST, "files is empty"));
    }
    if req.files.len() > MAX_FILES {
        return Err(upload_err(
            StatusCode::BAD_REQUEST,
            format!("too many files (max {MAX_FILES})"),
        ));
    }

    let cwd = normalize_dir_arg(&req.working_dir);
    if !cwd.is_dir() {
        return Err(upload_err(
            StatusCode::BAD_REQUEST,
            format!("working_dir is not a directory: {}", cwd.display()),
        ));
    }

    let store = cwd.join(USER_UPLOAD_STORE_DIR);
    std::fs::create_dir_all(&store).map_err(|e| {
        upload_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to create {USER_UPLOAD_STORE_DIR}: {e}"),
        )
    })?;
    ensure_gitignore_store_entry(&cwd).map_err(|e| {
        upload_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to update .gitignore: {e}"),
        )
    })?;

    let mut paths = Vec::with_capacity(req.files.len());
    for item in &req.files {
        let bytes = decode_base64(&item.data)?;
        if bytes.len() > MAX_FILE_BYTES {
            return Err(upload_err(
                StatusCode::PAYLOAD_TOO_LARGE,
                format!(
                    "file '{}' exceeds {} MB",
                    item.filename,
                    MAX_FILE_BYTES / (1024 * 1024)
                ),
            ));
        }
        let name = sanitize_upload_filename(&item.filename);
        let dest = unique_dest_path(&store, &name);
        std::fs::write(&dest, &bytes).map_err(|e| {
            upload_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to write {}: {e}", dest.display()),
            )
        })?;
        let canon = dest.canonicalize().unwrap_or(dest);
        let canon = atomcode_capabilities::pathnorm::strip_verbatim_path(&canon);
        paths.push(atomcode_capabilities::pathnorm::to_display(&canon));
    }
    Ok(paths)
}

fn decode_base64(data: &str) -> Result<Vec<u8>, UploadError> {
    let payload = strip_data_url(data.trim());
    base64::engine::general_purpose::STANDARD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(payload))
        .map_err(|_| upload_err(StatusCode::BAD_REQUEST, "invalid base64 file data"))
}

fn strip_data_url(data: &str) -> &str {
    if let Some(idx) = data.find(',') {
        if data[..idx].contains("base64") {
            return &data[idx + 1..];
        }
    }
    data
}

/// Keep a single path segment. Drop separators, reserved Windows chars, and
/// control bytes so the write stays inside `.jeikcode_store`.
pub fn sanitize_upload_filename(raw: &str) -> String {
    let base = Path::new(raw)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(raw)
        .trim();
    let mut out = String::new();
    for ch in base.chars() {
        if out.chars().count() >= MAX_NAME_CHARS {
            break;
        }
        if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let trimmed = out.trim_matches('.').trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "upload.bin".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn unique_dest_path(dir: &Path, filename: &str) -> PathBuf {
    let dest = dir.join(filename);
    if !dest.exists() {
        return dest;
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("upload");
    let ext = path.extension().and_then(|s| s.to_str());
    for i in 1..10_000 {
        let candidate = match ext {
            Some(ext) => dir.join(format!("{stem}_{i}.{ext}")),
            None => dir.join(format!("{stem}_{i}")),
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}_{}", uuid::Uuid::new_v4()))
}

/// If `{cwd}/.gitignore` already exists, append `.jeikcode_store/` once.
/// Missing `.gitignore` is left alone — we do not create a new ignore file.
pub fn ensure_gitignore_store_entry(cwd: &Path) -> std::io::Result<()> {
    let path = cwd.join(".gitignore");
    if !path.is_file() {
        return Ok(());
    }
    let existing = std::fs::read_to_string(&path)?;
    if gitignore_has_store_entry(&existing) {
        return Ok(());
    }
    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(GITIGNORE_BLOCK.trim_start());
    std::fs::write(path, next)
}

fn gitignore_has_store_entry(content: &str) -> bool {
    content.lines().any(|l| {
        let l = l.trim();
        l == ".jeikcode_store"
            || l == ".jeikcode_store/"
            || l == "**/.jeikcode_store"
            || l == "**/.jeikcode_store/"
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn sanitize_strips_path_and_reserved_chars() {
        assert_eq!(sanitize_upload_filename(r"..\secret.txt"), "secret.txt");
        assert_eq!(sanitize_upload_filename("a/b/c.pdf"), "c.pdf");
        assert_eq!(sanitize_upload_filename("foo:bar*.txt"), "foo_bar_.txt");
        assert_eq!(sanitize_upload_filename("..."), "upload.bin");
        assert_eq!(sanitize_upload_filename(""), "upload.bin");
    }

    #[test]
    fn unique_path_adds_numeric_suffix() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), b"1").unwrap();
        let second = unique_dest_path(d.path(), "a.txt");
        assert_eq!(second.file_name().unwrap(), "a_1.txt");
        std::fs::write(&second, b"2").unwrap();
        let third = unique_dest_path(d.path(), "a.txt");
        assert_eq!(third.file_name().unwrap(), "a_2.txt");
    }

    #[test]
    fn gitignore_appended_only_when_file_exists() {
        let d = tempfile::tempdir().unwrap();
        ensure_gitignore_store_entry(d.path()).unwrap();
        assert!(!d.path().join(".gitignore").exists());

        std::fs::write(d.path().join(".gitignore"), "node_modules/\n").unwrap();
        ensure_gitignore_store_entry(d.path()).unwrap();
        let once = std::fs::read_to_string(d.path().join(".gitignore")).unwrap();
        assert!(once.contains(".jeikcode_store/"));
        ensure_gitignore_store_entry(d.path()).unwrap();
        let twice = std::fs::read_to_string(d.path().join(".gitignore")).unwrap();
        assert_eq!(
            twice.matches(".jeikcode_store/").count(),
            1,
            "append must be idempotent: {twice}"
        );
    }

    #[test]
    fn save_uploads_writes_store_and_returns_absolute_paths() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(".gitignore"), "target/\n").unwrap();
        let req = FsUploadRequest {
            working_dir: d.path().to_string_lossy().into_owned(),
            files: vec![
                FsUploadItem {
                    filename: "notes.md".into(),
                    data: b64(b"# hello"),
                },
                FsUploadItem {
                    filename: "notes.md".into(),
                    data: b64(b"# second"),
                },
            ],
        };
        let paths = save_uploads(&req).unwrap();
        assert_eq!(paths.len(), 2);
        assert!(paths[0].contains(".jeikcode_store"));
        assert!(paths[0].ends_with("notes.md") || paths[0].contains("notes.md"));
        assert!(paths[1].contains("notes_1.md"), "{}", paths[1]);
        let gi = std::fs::read_to_string(d.path().join(".gitignore")).unwrap();
        assert!(gi.contains(".jeikcode_store/"));
        let body = std::fs::read_to_string(d.path().join(".jeikcode_store/notes.md")).unwrap();
        assert_eq!(body, "# hello");
    }

    #[test]
    fn save_uploads_skips_gitignore_when_missing() {
        let d = tempfile::tempdir().unwrap();
        let req = FsUploadRequest {
            working_dir: d.path().to_string_lossy().into_owned(),
            files: vec![FsUploadItem {
                filename: "a.txt".into(),
                data: b64(b"x"),
            }],
        };
        save_uploads(&req).unwrap();
        assert!(!d.path().join(".gitignore").exists());
        assert!(d.path().join(".jeikcode_store/a.txt").is_file());
    }

    #[test]
    fn save_uploads_rejects_empty_cwd() {
        let req = FsUploadRequest {
            working_dir: "  ".into(),
            files: vec![FsUploadItem {
                filename: "a.txt".into(),
                data: b64(b"x"),
            }],
        };
        assert!(save_uploads(&req).is_err());
    }
}
