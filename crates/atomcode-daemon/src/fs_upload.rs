//! POST `/fs/upload` — persist WebUI attachments under `{cwd}/.jeikcode_store`.
//!
//! Images stay on the chat `images` field (base64). Non-image files are streamed
//! to disk and referenced in the user message as absolute paths. `.jeikcode_store/`
//! is added to `.gitignore` when that file exists, or created when the cwd is a
//! git repo; `read`/`grep`/`glob`/`list_directory` still see the directory.
//!
//! The WebUI only calls this when the user **sends** — drag/paste keep a local
//! `File` handle so the user can remove attachments before anything hits disk.

use crate::{json_error, AppState, normalize_dir_arg};
use atomcode_capabilities::tools::USER_UPLOAD_STORE_DIR;
use axum::{
    extract::{Multipart, State},
    http::StatusCode,
    response::{IntoResponse, Json},
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

const GITIGNORE_BLOCK: &str =
    "\n# JeikCode user uploads (not project source)\n.jeikcode_store/\n";
const MAX_NAME_CHARS: usize = 180;

#[derive(Debug, Serialize)]
pub struct FsUploadResponse {
    pub paths: Vec<String>,
}

pub async fn fs_upload(
    State(_state): State<AppState>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let mut store: Option<PathBuf> = None;
    let mut paths: Vec<String> = Vec::new();
    loop {
        let mut field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(e) => {
                return json_error(StatusCode::BAD_REQUEST, format!("invalid multipart: {e}"))
                    .into_response();
            }
        };
        let name = field.name().unwrap_or("").to_string();
        if name == "working_dir" {
            let working_dir = match field.text().await {
                Ok(text) => text,
                Err(e) => {
                    return json_error(
                        StatusCode::BAD_REQUEST,
                        format!("invalid working_dir: {e}"),
                    )
                    .into_response();
                }
            };
            match prepare_store(&working_dir) {
                Ok(dir) => store = Some(dir),
                Err(e) => return json_error(e.status, e.message).into_response(),
            }
        } else if name == "files" || name == "file" {
            let Some(store_dir) = store.as_ref() else {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "working_dir must be sent before files",
                )
                .into_response();
            };
            let filename = field.file_name().unwrap_or("upload.bin").to_string();
            match stream_field_to_store(store_dir, &filename, &mut field).await {
                Ok(path) => paths.push(path),
                Err(e) => return json_error(e.status, e.message).into_response(),
            }
        }
    }
    if paths.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "files is empty").into_response();
    }
    Json(FsUploadResponse { paths }).into_response()
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

fn prepare_store(working_dir: &str) -> Result<PathBuf, UploadError> {
    if working_dir.trim().is_empty() {
        return Err(upload_err(
            StatusCode::BAD_REQUEST,
            "working_dir is required",
        ));
    }
    let cwd = normalize_dir_arg(working_dir);
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
    Ok(store)
}

fn display_store_path(dest: PathBuf) -> String {
    let canon = dest.canonicalize().unwrap_or(dest);
    let canon = atomcode_capabilities::pathnorm::strip_verbatim_path(&canon);
    atomcode_capabilities::pathnorm::to_display(&canon)
}

async fn stream_field_to_store(
    store: &Path,
    filename: &str,
    field: &mut axum::extract::multipart::Field<'_>,
) -> Result<String, UploadError> {
    let name = sanitize_upload_filename(filename);
    let dest = unique_dest_path(store, &name);
    let mut out = tokio::fs::File::create(&dest).await.map_err(|e| {
        upload_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to create {}: {e}", dest.display()),
        )
    })?;
    loop {
        match field.chunk().await {
            Ok(Some(chunk)) => {
                if let Err(e) = out.write_all(&chunk).await {
                    drop(out);
                    let _ = tokio::fs::remove_file(&dest).await;
                    return Err(upload_err(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("failed to write {}: {e}", dest.display()),
                    ));
                }
            }
            Ok(None) => break,
            Err(e) => {
                drop(out);
                let _ = tokio::fs::remove_file(&dest).await;
                return Err(upload_err(
                    StatusCode::BAD_REQUEST,
                    format!("failed to read file '{filename}': {e}"),
                ));
            }
        }
    }
    if let Err(e) = out.flush().await {
        drop(out);
        let _ = tokio::fs::remove_file(&dest).await;
        return Err(upload_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to flush {}: {e}", dest.display()),
        ));
    }
    drop(out);
    Ok(display_store_path(dest))
}

fn save_uploads(working_dir: &str, files: Vec<(String, Vec<u8>)>) -> Result<Vec<String>, UploadError> {
    if files.is_empty() {
        return Err(upload_err(StatusCode::BAD_REQUEST, "files is empty"));
    }
    let store = prepare_store(working_dir)?;
    let mut paths = Vec::with_capacity(files.len());
    for (filename, bytes) in files {
        let name = sanitize_upload_filename(&filename);
        let dest = unique_dest_path(&store, &name);
        std::fs::write(&dest, &bytes).map_err(|e| {
            upload_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to write {}: {e}", dest.display()),
            )
        })?;
        paths.push(display_store_path(dest));
    }
    Ok(paths)
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

/// Keep `.jeikcode_store/` out of git:
/// - existing `.gitignore` → append the entry once
/// - git repo with no `.gitignore` → create one so `git status` stays clean
/// - not a git repo → leave the tree alone
pub fn ensure_gitignore_store_entry(cwd: &Path) -> std::io::Result<()> {
    let path = cwd.join(".gitignore");
    if path.is_file() {
        let existing = std::fs::read_to_string(&path)?;
        if gitignore_has_store_entry(&existing) {
            return Ok(());
        }
        let mut next = existing;
        if !next.is_empty() && !next.ends_with('\n') {
            next.push('\n');
        }
        next.push_str(GITIGNORE_BLOCK.trim_start());
        return std::fs::write(path, next);
    }
    if cwd.join(".git").exists() {
        std::fs::write(path, GITIGNORE_BLOCK.trim_start())?;
    }
    Ok(())
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
    fn gitignore_created_for_git_repo_without_ignore_file() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join(".git")).unwrap();
        ensure_gitignore_store_entry(d.path()).unwrap();
        let gi = std::fs::read_to_string(d.path().join(".gitignore")).unwrap();
        assert!(gi.contains(".jeikcode_store/"));
    }

    #[test]
    fn save_uploads_writes_store_and_returns_absolute_paths() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(".gitignore"), "target/\n").unwrap();
        let cwd = d.path().to_string_lossy().into_owned();
        let paths = save_uploads(
            &cwd,
            vec![
                ("notes.md".into(), b"# hello".to_vec()),
                ("notes.md".into(), b"# second".to_vec()),
            ],
        )
        .unwrap();
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
        let cwd = d.path().to_string_lossy().into_owned();
        save_uploads(&cwd, vec![("a.txt".into(), b"x".to_vec())]).unwrap();
        assert!(!d.path().join(".gitignore").exists());
        assert!(d.path().join(".jeikcode_store/a.txt").is_file());
    }

    #[test]
    fn save_uploads_creates_gitignore_in_git_repo() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join(".git")).unwrap();
        let cwd = d.path().to_string_lossy().into_owned();
        save_uploads(&cwd, vec![("a.txt".into(), b"x".to_vec())]).unwrap();
        let gi = std::fs::read_to_string(d.path().join(".gitignore")).unwrap();
        assert!(gi.contains(".jeikcode_store/"));
    }

    #[test]
    fn save_uploads_rejects_empty_cwd() {
        assert!(save_uploads("  ", vec![("a.txt".into(), b"x".to_vec())]).is_err());
    }
}
