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
