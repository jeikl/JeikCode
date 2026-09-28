//! Git repository inspection and branch management API for WebUI.
//!
//! Provides endpoints to:
//! - List local and remote branches + detect active branch (`GET /git/branches`)
//! - Query commit history graph with DAG parents and ref badges (`GET /git/graph`)
//! - Switch / checkout branches safely (`POST /git/checkout`)

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::{json_error, normalize_dir_arg, AppState};

/// Query parameters for Git endpoints.
#[derive(Debug, Deserialize)]
pub struct GitQuery {
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct GitBranchesResponse {
    pub is_repo: bool,
    pub repo_root: Option<String>,
    pub current: Option<String>,
    pub local: Vec<String>,
    pub remote: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct GitCommitItem {
    pub hash: String,
    pub short_hash: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
    pub message: String,
    pub refs: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct GitGraphResponse {
    pub is_repo: bool,
    pub current_branch: Option<String>,
    pub commits: Vec<GitCommitItem>,
}

#[derive(Debug, Deserialize)]
pub struct GitCheckoutReq {
    pub branch: String,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GitCheckoutResp {
    pub success: bool,
    pub branch: String,
    pub message: String,
}

/// Helper to create a git Command with creation flags to avoid console popup on Windows.
fn git_cmd(working_dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(working_dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Resolve the target directory from the optional cwd parameter.
fn resolve_target_dir(cwd: Option<&str>) -> PathBuf {
    let dir = match cwd {
        Some(path_str) if !path_str.trim().is_empty() => {
            let expanded = normalize_dir_arg(path_str);
            expanded.canonicalize().unwrap_or(expanded)
        }
        _ => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    };
    jeikcode_capabilities::pathnorm::strip_verbatim_path(&dir)
}

/// Check if the target directory is inside a Git working tree.
fn is_git_repo(dir: &Path) -> bool {
    let output = git_cmd(dir)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output();
    match output {
        Ok(out) => out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == "true",
        Err(_) => false,
    }
}

/// GET /git/branches
pub async fn get_git_branches(
    State(_state): State<AppState>,
    Query(q): Query<GitQuery>,
) -> impl IntoResponse {
    let dir = resolve_target_dir(q.cwd.as_deref());
    if !is_git_repo(&dir) {
        return Json(GitBranchesResponse {
            is_repo: false,
            repo_root: None,
            current: None,
            local: Vec::new(),
            remote: Vec::new(),
        })
        .into_response();
    }

    // Get repo root
    let repo_root = git_cmd(&dir)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        });

    // List branches
    let branch_output = git_cmd(&dir)
        .args([
            "branch",
            "-a",
            "--format=%(HEAD)|%(refname)|%(refname:short)",
        ])
        .output();

    let mut current_branch = None;
    let mut local_branches = Vec::new();
    let mut remote_branches = Vec::new();

    if let Ok(out) = branch_output {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let parts: Vec<&str> = trimmed.split('|').collect();
                if parts.len() < 3 {
                    continue;
                }
                let is_head = parts[0].trim() == "*";
                let full_ref = parts[1].trim();
                let short_ref = parts[2].trim();

                // Skip symbolic HEADs like origin/HEAD
                if full_ref.ends_with("/HEAD") || short_ref.ends_with("/HEAD") {
                    continue;
                }

                if full_ref.starts_with("refs/heads/") {
                    let name = short_ref.to_string();
                    if is_head {
                        current_branch = Some(name.clone());
                    }
                    if !local_branches.contains(&name) {
                        local_branches.push(name);
                    }
                } else if full_ref.starts_with("refs/remotes/") {
                    let name = short_ref.to_string();
                    if !remote_branches.contains(&name) {
                        remote_branches.push(name);
                    }
                }
            }
        }
    }

    // If detached HEAD, get short sha
    if current_branch.is_none() {
        if let Ok(out) = git_cmd(&dir).args(["rev-parse", "--short", "HEAD"]).output() {
            if out.status.success() {
                let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !sha.is_empty() {
                    current_branch = Some(format!("(HEAD detached at {sha})"));
                }
            }
        }
    }

    Json(GitBranchesResponse {
        is_repo: true,
        repo_root,
        current: current_branch,
        local: local_branches,
        remote: remote_branches,
    })
    .into_response()
}

/// GET /git/graph
pub async fn get_git_graph(
    State(_state): State<AppState>,
    Query(q): Query<GitQuery>,
) -> impl IntoResponse {
    let dir = resolve_target_dir(q.cwd.as_deref());
    if !is_git_repo(&dir) {
        return Json(GitGraphResponse {
            is_repo: false,
            current_branch: None,
            commits: Vec::new(),
        })
        .into_response();
    }

    // Get current branch
    let current_branch = git_cmd(&dir)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                let name = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if name == "HEAD" {
                    None
                } else {
                    Some(name)
                }
            } else {
                None
            }
        });

    let limit = q.limit.unwrap_or(60).clamp(1, 300);
    let mut args = vec![
        "-n".to_string(),
        limit.to_string(),
        "--date=iso-strict".to_string(),
        "--pretty=format:__COMMIT_START__%n%H%n%h%n%P%n%an%n%ae%n%at%n%s%n%D".to_string(),
    ];

    if let Some(ref branch) = q.branch {
        let trimmed = branch.trim();
        if trimmed == "all" || trimmed.is_empty() {
            args.insert(0, "--all".to_string());
        } else {
            args.insert(0, trimmed.to_string());
        }
    } else {
        // Default to all branches to show complete DAG graph
        args.insert(0, "--all".to_string());
    }

    let output = git_cmd(&dir).arg("log").args(&args).output();

    let mut commits = Vec::new();

    if let Ok(out) = output {
        if out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let chunks = stdout.split("__COMMIT_START__\n");
            for chunk in chunks {
                let lines: Vec<&str> = chunk
                    .lines()
                    .map(|l| l.trim_end_matches('\r'))
                    .filter(|l| !l.is_empty())
                    .collect();
                if lines.len() < 7 {
                    continue;
                }
                let hash = lines[0].trim().to_string();
                let short_hash = lines[1].trim().to_string();
                let parents: Vec<String> = lines[2]
                    .split_whitespace()
                    .map(|s| s.to_string())
                    .collect();
                let author_name = lines[3].trim().to_string();
                let author_email = lines[4].trim().to_string();
                let timestamp = lines[5].trim().parse::<i64>().unwrap_or(0);
                let message = lines[6].trim().to_string();

                let refs: Vec<String> = if lines.len() >= 8 && !lines[7].trim().is_empty() {
                    lines[7]
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                } else {
                    Vec::new()
                };

                commits.push(GitCommitItem {
                    hash,
                    short_hash,
                    parents,
                    author_name,
                    author_email,
                    timestamp,
                    message,
                    refs,
                });
            }
        }
    }

    Json(GitGraphResponse {
        is_repo: true,
        current_branch,
        commits,
    })
    .into_response()
}

/// POST /git/checkout
pub async fn git_checkout(
    State(_state): State<AppState>,
    Json(req): Json<GitCheckoutReq>,
) -> impl IntoResponse {
    let branch = req.branch.trim();
    if branch.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "Branch name cannot be empty").into_response();
    }

    // Safety checks against branch names with shell injections or flags
    if branch.starts_with('-') || branch.contains(' ') || branch.contains(';') || branch.contains('&') || branch.contains('|') {
        return json_error(StatusCode::BAD_REQUEST, "Invalid branch name").into_response();
    }

    let dir = resolve_target_dir(req.cwd.as_deref());
    if !is_git_repo(&dir) {
        return json_error(StatusCode::BAD_REQUEST, "Target directory is not a Git repository").into_response();
    }

    // If branch is remote like origin/feature-a, strip remote prefix if checking out new local branch or let git track
    let mut target_branch = branch.to_string();
    if let Some(stripped) = branch.strip_prefix("origin/") {
        target_branch = stripped.to_string();
    }

    let output = git_cmd(&dir).args(["checkout", &target_branch]).output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let combined = if stdout.is_empty() { stderr } else { stdout };

            if out.status.success() {
                Json(GitCheckoutResp {
                    success: true,
                    branch: target_branch,
                    message: combined.trim().to_string(),
                })
                .into_response()
            } else {
                json_error(StatusCode::BAD_REQUEST, combined.trim().to_string()).into_response()
            }
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to execute git checkout: {e}")).into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct GitCommitDetailQuery {
    pub hash: String,
    pub cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GitFileDiffQuery {
    pub hash: String,
    pub path: String,
    pub cwd: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct GitCommitFile {
    pub path: String,
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Serialize)]
pub struct GitCommitDetailResp {
    pub hash: String,
    pub files: Vec<GitCommitFile>,
}

#[derive(Debug, Serialize)]
pub struct GitFileDiffResp {
    pub hash: String,
    pub path: String,
    pub diff: String,
}

/// GET /git/commit-detail
pub async fn get_git_commit_detail(
    State(_state): State<AppState>,
    Query(q): Query<GitCommitDetailQuery>,
) -> impl IntoResponse {
    let hash = q.hash.trim();
    if hash.is_empty() || hash.starts_with('-') || hash.contains(' ') {
        return json_error(StatusCode::BAD_REQUEST, "Invalid commit hash").into_response();
    }

    let dir = resolve_target_dir(q.cwd.as_deref());
    if !is_git_repo(&dir) {
        return json_error(StatusCode::BAD_REQUEST, "Target directory is not a Git repository").into_response();
    }

    // 1. Get name-status
    let status_out = git_cmd(&dir)
        .args(["diff-tree", "--no-commit-id", "--name-status", "-r", hash])
        .output();

    // 2. Get numstat
    let numstat_out = git_cmd(&dir)
        .args(["show", "--numstat", "--format=", hash])
        .output();

    let mut numstat_map: std::collections::HashMap<String, (usize, usize)> = std::collections::HashMap::new();
    if let Ok(ref out) = numstat_out {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let parts: Vec<&str> = line.split('\t').collect();
                if parts.len() >= 3 {
                    let adds = parts[0].parse::<usize>().unwrap_or(0);
                    let dels = parts[1].parse::<usize>().unwrap_or(0);
                    let file_path = parts[2].trim().to_string();
                    numstat_map.insert(file_path, (adds, dels));
                }
            }
        }
    }

    let mut files = Vec::new();
    if let Ok(out) = status_out {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let parts: Vec<&str> = trimmed.split('\t').collect();
                if parts.len() >= 2 {
                    let status_char = parts[0].chars().next().unwrap_or('M').to_string();
                    let file_path = parts[1].trim().to_string();
                    let (adds, dels) = numstat_map.get(&file_path).copied().unwrap_or((0, 0));
                    files.push(GitCommitFile {
                        path: file_path,
                        status: status_char,
                        additions: adds,
                        deletions: dels,
                    });
                }
            }
        }
    }

    Json(GitCommitDetailResp {
        hash: hash.to_string(),
        files,
    })
    .into_response()
}

/// GET /git/file-diff
pub async fn get_git_file_diff(
    State(_state): State<AppState>,
    Query(q): Query<GitFileDiffQuery>,
) -> impl IntoResponse {
    let hash = q.hash.trim();
    let file_path = q.path.trim();

    if hash.is_empty() || hash.starts_with('-') || hash.contains(' ') {
        return json_error(StatusCode::BAD_REQUEST, "Invalid commit hash").into_response();
    }
    if file_path.is_empty() || file_path.starts_with('-') {
        return json_error(StatusCode::BAD_REQUEST, "Invalid file path").into_response();
    }

    let dir = resolve_target_dir(q.cwd.as_deref());
    if !is_git_repo(&dir) {
        return json_error(StatusCode::BAD_REQUEST, "Target directory is not a Git repository").into_response();
    }

    let output = git_cmd(&dir)
        .args(["show", "--format=", hash, "--", file_path])
        .output();

    match output {
        Ok(out) => {
            let diff = String::from_utf8_lossy(&out.stdout).to_string();
            Json(GitFileDiffResp {
                hash: hash.to_string(),
                path: file_path.to_string(),
                diff,
            })
            .into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get diff: {e}")).into_response(),
    }
}

// ============================================================================
// Source Control: Status, Stage, Commit, Push, Pull, Discard
// ============================================================================

#[derive(Debug, Serialize, Clone)]
pub struct GitStatusItem {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

#[derive(Debug, Serialize)]
pub struct GitStatusResponse {
    pub is_repo: bool,
    pub current_branch: Option<String>,
    pub tracking_branch: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub staged: Vec<GitStatusItem>,
    pub unstaged: Vec<GitStatusItem>,
    pub untracked: Vec<GitStatusItem>,
}

#[derive(Debug, Deserialize)]
pub struct GitStageReq {
    pub path: Option<String>,
    #[serde(default)]
    pub all: bool,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GitUnstageReq {
    pub path: Option<String>,
    #[serde(default)]
    pub all: bool,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GitDiscardReq {
    pub path: String,
    #[serde(default)]
    pub is_untracked: bool,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GitCommitReq {
    pub message: String,
    #[serde(default)]
    pub amend: bool,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GitPushReq {
    pub branch: Option<String>,
    pub remote: Option<String>,
    #[serde(default)]
    pub set_upstream: bool,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GitPullReq {
    pub remote: Option<String>,
    pub branch: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GitWorkingDiffQuery {
    pub path: String,
    pub staged: Option<bool>,
    pub cwd: Option<String>,
}

/// GET /git/status
pub async fn get_git_status(
    State(_state): State<AppState>,
    Query(q): Query<GitQuery>,
) -> impl IntoResponse {
    let dir = resolve_target_dir(q.cwd.as_deref());
    if !is_git_repo(&dir) {
        return Json(GitStatusResponse {
            is_repo: false,
            current_branch: None,
            tracking_branch: None,
            ahead: 0,
            behind: 0,
            staged: Vec::new(),
            unstaged: Vec::new(),
            untracked: Vec::new(),
        })
        .into_response();
    }

    let output = git_cmd(&dir)
        .args(["status", "--porcelain=v1", "-u", "--branch"])
        .output();

    let mut current_branch = None;
    let mut tracking_branch = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();

    if let Ok(out) = output {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let trimmed = line.trim_end_matches('\r');
                if trimmed.starts_with("##") {
                    // Branch info line: ## main...origin/main [ahead 1, behind 2]
                    let header = trimmed.trim_start_matches('#').trim();
                    let (branch_part, track_info) = if let Some(bracket_idx) = header.find('[') {
                        (header[..bracket_idx].trim(), Some(&header[bracket_idx..]))
                    } else {
                        (header, None)
                    };

                    if let Some(dots_idx) = branch_part.find("...") {
                        current_branch = Some(branch_part[..dots_idx].trim().to_string());
                        tracking_branch = Some(branch_part[dots_idx + 3..].trim().to_string());
                    } else {
                        current_branch = Some(branch_part.to_string());
                    }

                    if let Some(info) = track_info {
                        if let Some(idx) = info.find("ahead ") {
                            let rest = &info[idx + 6..];
                            let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                            ahead = num.parse().unwrap_or(0);
                        }
                        if let Some(idx) = info.find("behind ") {
                            let rest = &info[idx + 7..];
                            let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                            behind = num.parse().unwrap_or(0);
                        }
                    }
                    continue;
                }

                if trimmed.len() < 4 {
                    continue;
                }

                let x = trimmed.as_bytes()[0] as char;
                let y = trimmed.as_bytes()[1] as char;
                let file_path = trimmed[3..].trim().to_string();

                if x == '?' && y == '?' {
                    untracked.push(GitStatusItem {
                        path: file_path,
                        status: "?".to_string(),
                        staged: false,
                    });
                } else {
                    if x != ' ' {
                        staged.push(GitStatusItem {
                            path: file_path.clone(),
                            status: x.to_string(),
                            staged: true,
                        });
                    }
                    if y != ' ' {
                        unstaged.push(GitStatusItem {
                            path: file_path,
                            status: y.to_string(),
                            staged: false,
                        });
                    }
                }
            }
        }
    }

    Json(GitStatusResponse {
        is_repo: true,
        current_branch,
        tracking_branch,
        ahead,
        behind,
        staged,
        unstaged,
        untracked,
    })
    .into_response()
}

/// POST /git/stage
pub async fn git_stage(
    State(_state): State<AppState>,
    Json(req): Json<GitStageReq>,
) -> impl IntoResponse {
    let dir = resolve_target_dir(req.cwd.as_deref());
    if !is_git_repo(&dir) {
        return json_error(StatusCode::BAD_REQUEST, "Target directory is not a Git repository").into_response();
    }

    let output = if req.all {
        git_cmd(&dir).args(["add", "-A"]).output()
    } else if let Some(ref path) = req.path {
        git_cmd(&dir).args(["add", "--", path]).output()
    } else {
        return json_error(StatusCode::BAD_REQUEST, "Must specify path or all=true").into_response();
    };

    match output {
        Ok(out) if out.status.success() => Json(serde_json::json!({ "success": true })).into_response(),
        Ok(out) => json_error(StatusCode::BAD_REQUEST, String::from_utf8_lossy(&out.stderr).to_string()).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to stage: {e}")).into_response(),
    }
}

/// POST /git/unstage
pub async fn git_unstage(
    State(_state): State<AppState>,
    Json(req): Json<GitUnstageReq>,
) -> impl IntoResponse {
    let dir = resolve_target_dir(req.cwd.as_deref());
    if !is_git_repo(&dir) {
        return json_error(StatusCode::BAD_REQUEST, "Target directory is not a Git repository").into_response();
    }

    let output = if req.all {
        git_cmd(&dir).args(["restore", "--staged", "."]).output()
    } else if let Some(ref path) = req.path {
        git_cmd(&dir).args(["restore", "--staged", "--", path]).output()
    } else {
        return json_error(StatusCode::BAD_REQUEST, "Must specify path or all=true").into_response();
    };

    match output {
        Ok(out) if out.status.success() => Json(serde_json::json!({ "success": true })).into_response(),
        Ok(out) => json_error(StatusCode::BAD_REQUEST, String::from_utf8_lossy(&out.stderr).to_string()).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to unstage: {e}")).into_response(),
    }
}

/// POST /git/discard
pub async fn git_discard(
    State(_state): State<AppState>,
    Json(req): Json<GitDiscardReq>,
) -> impl IntoResponse {
    let dir = resolve_target_dir(req.cwd.as_deref());
    if !is_git_repo(&dir) {
        return json_error(StatusCode::BAD_REQUEST, "Target directory is not a Git repository").into_response();
    }

    let file_path = req.path.trim();
    if file_path.is_empty() || file_path.starts_with('-') {
        return json_error(StatusCode::BAD_REQUEST, "Invalid file path").into_response();
    }

    if req.is_untracked {
        let full_path = dir.join(file_path);
        let res = if full_path.is_dir() {
            std::fs::remove_dir_all(&full_path)
        } else {
            std::fs::remove_file(&full_path)
        };
        match res {
            Ok(()) => Json(serde_json::json!({ "success": true })).into_response(),
            Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to delete file: {e}")).into_response(),
        }
    } else {
        let output = git_cmd(&dir).args(["restore", "--", file_path]).output();
        match output {
            Ok(out) if out.status.success() => Json(serde_json::json!({ "success": true })).into_response(),
            Ok(out) => json_error(StatusCode::BAD_REQUEST, String::from_utf8_lossy(&out.stderr).to_string()).into_response(),
            Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to discard changes: {e}")).into_response(),
        }
    }
}

/// POST /git/commit
pub async fn git_commit(
    State(_state): State<AppState>,
    Json(req): Json<GitCommitReq>,
) -> impl IntoResponse {
    let dir = resolve_target_dir(req.cwd.as_deref());
    if !is_git_repo(&dir) {
        return json_error(StatusCode::BAD_REQUEST, "Target directory is not a Git repository").into_response();
    }

    let message = req.message.trim();
    if message.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "Commit message cannot be empty").into_response();
    }

    let mut args = vec!["commit".to_string()];
    if req.amend {
        args.push("--amend".to_string());
    }
    args.push("-m".to_string());
    args.push(message.to_string());

    let output = git_cmd(&dir).args(&args).output();

    match output {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            Json(serde_json::json!({
                "success": true,
                "message": stdout.trim().to_string(),
            }))
            .into_response()
        }
        Ok(out) => json_error(StatusCode::BAD_REQUEST, String::from_utf8_lossy(&out.stderr).to_string()).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to commit: {e}")).into_response(),
    }
}

/// POST /git/push
pub async fn git_push(
    State(_state): State<AppState>,
    Json(req): Json<GitPushReq>,
) -> impl IntoResponse {
    let dir = resolve_target_dir(req.cwd.as_deref());
    if !is_git_repo(&dir) {
        return json_error(StatusCode::BAD_REQUEST, "Target directory is not a Git repository").into_response();
    }

    let mut args = vec!["push".to_string()];
    if req.set_upstream {
        args.push("-u".to_string());
        args.push(req.remote.clone().unwrap_or_else(|| "origin".to_string()));
        args.push(req.branch.clone().unwrap_or_else(|| "HEAD".to_string()));
    } else {
        if let Some(r) = req.remote {
            args.push(r);
            if let Some(b) = req.branch {
                args.push(b);
            }
        }
    }

    let output = git_cmd(&dir).args(&args).output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let combined = if stdout.is_empty() { stderr } else { stdout };

            if out.status.success() {
                Json(serde_json::json!({
                    "success": true,
                    "message": combined.trim().to_string(),
                }))
                .into_response()
            } else {
                json_error(StatusCode::BAD_REQUEST, combined.trim().to_string()).into_response()
            }
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to push: {e}")).into_response(),
    }
}

/// POST /git/pull
pub async fn git_pull(
    State(_state): State<AppState>,
    Json(req): Json<GitPullReq>,
) -> impl IntoResponse {
    let dir = resolve_target_dir(req.cwd.as_deref());
    if !is_git_repo(&dir) {
        return json_error(StatusCode::BAD_REQUEST, "Target directory is not a Git repository").into_response();
    }

    let mut args = vec!["pull".to_string()];
    if let Some(r) = req.remote {
        args.push(r);
        if let Some(b) = req.branch {
            args.push(b);
        }
    }

    let output = git_cmd(&dir).args(&args).output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let combined = if stdout.is_empty() { stderr } else { stdout };

            if out.status.success() {
                Json(serde_json::json!({
                    "success": true,
                    "message": combined.trim().to_string(),
                }))
                .into_response()
            } else {
                json_error(StatusCode::BAD_REQUEST, combined.trim().to_string()).into_response()
            }
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to pull: {e}")).into_response(),
    }
}

/// GET /git/working-diff
pub async fn get_git_working_diff(
    State(_state): State<AppState>,
    Query(q): Query<GitWorkingDiffQuery>,
) -> impl IntoResponse {
    let dir = resolve_target_dir(q.cwd.as_deref());
    if !is_git_repo(&dir) {
        return json_error(StatusCode::BAD_REQUEST, "Target directory is not a Git repository").into_response();
    }

    let file_path = q.path.trim();
    if file_path.is_empty() || file_path.starts_with('-') {
        return json_error(StatusCode::BAD_REQUEST, "Invalid file path").into_response();
    }

    let output = if q.staged == Some(true) {
        git_cmd(&dir)
            .args(["diff", "--cached", "--", file_path])
            .output()
    } else {
        // Try git diff first
        let diff_out = git_cmd(&dir)
            .args(["diff", "--", file_path])
            .output();

        if let Ok(ref out) = diff_out {
            if out.status.success() && !out.stdout.is_empty() {
                diff_out
            } else {
                // If diff is empty, file might be untracked! Try diff against /dev/null
                git_cmd(&dir)
                    .args(["diff", "--no-index", "/dev/null", file_path])
                    .output()
            }
        } else {
            diff_out
        }
    };

    match output {
        Ok(out) => {
            let diff = String::from_utf8_lossy(&out.stdout).to_string();
            Json(GitFileDiffResp {
                hash: "working-tree".to_string(),
                path: file_path.to_string(),
                diff,
            })
            .into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get working diff: {e}")).into_response(),
    }
}


