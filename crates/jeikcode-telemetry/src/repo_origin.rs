//! Helpers for constructing telemetry envelope context at process start:
//! detect the repository host from `git remote origin`.
//!
//! Lives here (not in a driver) because the [`RepoOrigin`]/[`RepoHost`] it produces
//! are telemetry envelope types; the CLI and daemon both call [`detect_repo_origin`]
//! at startup. Ported out of `jeikcode-core` (v1 engine) as part of retiring it.

use crate::{RepoHost, RepoOrigin};
use std::path::Path;
use std::process::Command;

/// Suppress the Windows console-window flash for a short-lived child process.
/// `detect_repo_origin` runs from the console-less daemon on every `/chat` turn,
/// so a bare `git` spawn would pop and flicker a window. Uses only safe std
/// (`CREATE_NO_WINDOW` creation flag) so it holds under this crate's
/// `#![forbid(unsafe_code)]`. No-op off Windows.
#[cfg(target_os = "windows")]
fn suppress_console_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn suppress_console_window(_cmd: &mut Command) {}

pub fn detect_repo_origin(cwd: &Path) -> RepoOrigin {
    let mut cmd = Command::new("git");
    cmd.args(["-C"])
        .arg(cwd)
        .args(["remote", "get-url", "origin"]);
    suppress_console_window(&mut cmd);
    let output = cmd.output();
    match output {
        Ok(o) if o.status.success() => {
            let url = String::from_utf8_lossy(&o.stdout).trim().to_string();
            RepoOrigin {
                host: classify_host(&url),
                has_git: true,
            }
        }
        Ok(_) => RepoOrigin {
            host: RepoHost::None,
            has_git: has_git_dir(cwd),
        },
        Err(_) => RepoOrigin {
            host: RepoHost::None,
            has_git: has_git_dir(cwd),
        },
    }
}

fn classify_host(url: &str) -> RepoHost {
    let remote = url.trim();
    if remote.is_empty() {
        return RepoHost::None;
    }
    // Phân tích authority để không nhận nhầm tên miền trong đường dẫn hoặc userinfo.
    let parsed = if remote.contains("://") {
        reqwest::Url::parse(remote).ok()
    } else {
        // Remote SCP có dạng [user@]host:path; đường dẫn cục bộ không có host.
        remote.split_once(':').and_then(|(authority, _)| {
            if authority.contains(['/', '\\']) {
                return None;
            }
            reqwest::Url::parse(&format!("ssh://{authority}/")).ok()
        })
    };
    match parsed.as_ref().and_then(|url| url.host_str()) {
        Some("gitcode.com") => RepoHost::Gitcode,
        Some("atomgit.com") => RepoHost::Atomgit,
        Some("github.com") => RepoHost::Github,
        Some("gitlab.com") => RepoHost::Gitlab,
        _ => RepoHost::Other,
    }
}

fn has_git_dir(cwd: &Path) -> bool {
    cwd.join(".git").exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_hosts() {
        assert!(matches!(
            classify_host("git@gitcode.com:foo/bar.git"),
            RepoHost::Gitcode
        ));
        assert!(matches!(
            classify_host("https://atomgit.com/x/y"),
            RepoHost::Atomgit
        ));
        assert!(matches!(
            classify_host("https://github.com/x/y"),
            RepoHost::Github
        ));
        assert!(matches!(
            classify_host("ssh://git@gitlab.com/x"),
            RepoHost::Gitlab
        ));
        assert!(matches!(
            classify_host("https://other.net/x"),
            RepoHost::Other
        ));
        assert!(matches!(classify_host(""), RepoHost::None));
        assert!(matches!(
            classify_host("git@github.com:org/repo.git"),
            RepoHost::Github
        ));
        assert!(matches!(
            classify_host("https://gitlab.com/org/repo.git"),
            RepoHost::Gitlab
        ));
        assert!(matches!(
            classify_host("git@gitlab.com:org/repo.git"),
            RepoHost::Gitlab
        ));
        assert!(matches!(
            classify_host("ssh://git@github.com:2222/org/repo.git"),
            RepoHost::Github
        ));
        assert!(matches!(
            classify_host("https://GITHUB.COM/org/repo.git"),
            RepoHost::Github
        ));
    }

    #[test]
    fn rejects_spoofed_hosts() {
        for remote in [
            "https://other.net/github.com/org/repo",
            "https://other.net/gitlab.com/org/repo",
            "https://github.com@other.net/org/repo",
            "https://gitcode.com@other.net/org/repo",
            "https://atomgit.com@other.net/org/repo",
            "https://github.com.evil.test/org/repo",
            "https://gitlab.com.evil.test/org/repo",
            "https://gitlab.com@other.net/org/repo",
            "git@other.net:github.com/org/repo.git",
            "./github.com:org/repo.git",
        ] {
            assert!(matches!(classify_host(remote), RepoHost::Other), "{remote}");
        }
    }
}
