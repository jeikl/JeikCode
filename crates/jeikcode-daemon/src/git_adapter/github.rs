//! GitHub platform adapter driver.
//!
//! Implements HMAC-SHA256 webhook verification, normalized payload parsing,
//! and comments API read/write operations.

use axum::http::HeaderMap;
use serde_json::Value;

use super::{
    constant_time_eq, hmac_sha256, to_hex, GitEventKind, GitPlatformAdapter, GitUserMeta,
    NormalizedGitEvent, PollPullRequestsOutput,
};

#[derive(Debug, Default, Clone)]
pub struct GitHubAdapter;

impl GitHubAdapter {
    pub fn new() -> Self {
        Self
    }
}

const DEFAULT_GITHUB_API_BASE: &str = "https://api.github.com";

#[async_trait::async_trait]
impl GitPlatformAdapter for GitHubAdapter {
    fn platform_id(&self) -> &'static str {
        "github"
    }

    fn verify_signature(&self, secret: &str, headers: &HeaderMap, body_bytes: &[u8]) -> bool {
        let secret = secret.trim();
        if secret.is_empty() {
            // 未配置 secret 时放行
            return true;
        }

        let Some(sig_header) = headers.get("x-hub-signature-256") else {
            return false;
        };

        let Ok(sig_str) = sig_header.to_str() else {
            return false;
        };

        let sig_str = sig_str.trim();
        let expected_prefix = "sha256=";
        if !sig_str.to_ascii_lowercase().starts_with(expected_prefix) {
            return false;
        }

        let remote_hex = sig_str[expected_prefix.len()..].trim().to_ascii_lowercase();
        let calculated_bytes = hmac_sha256(secret.as_bytes(), body_bytes);
        let calculated_hex = to_hex(&calculated_bytes);

        constant_time_eq(remote_hex.as_bytes(), calculated_hex.as_bytes())
    }

    fn parse_event(
        &self,
        headers: &HeaderMap,
        payload: Value,
    ) -> Result<Option<NormalizedGitEvent>, String> {
        let event_type_header = headers
            .get("x-github-event")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .trim();

        if event_type_header.is_empty() {
            return Err("Missing X-GitHub-Event header".to_string());
        }

        let repo_full_name = payload["repository"]["full_name"]
            .as_str()
            .unwrap_or("")
            .to_string();

        let sender_obj = &payload["sender"];
        let sender_association = sender_obj["author_association"]
            .as_str()
            .map(|s| s.to_string());
        let sender = GitUserMeta {
            username: sender_obj["login"]
                .as_str()
                .unwrap_or("unknown")
                .to_string(),
            display_name: sender_obj["name"].as_str().map(|s| s.to_string()),
            email: sender_obj["email"].as_str().map(|s| s.to_string()),
            user_type: sender_obj["type"].as_str().unwrap_or("User").to_string(),
            avatar_url: sender_obj["avatar_url"].as_str().map(|s| s.to_string()),
            author_association: sender_association,
        };

        match event_type_header {
            "ping" => Ok(Some(NormalizedGitEvent {
                platform: "github".to_string(),
                event_kind: GitEventKind::Ping,
                repo_full_name,
                is_pull_request: false,
                issue_or_pr_number: None,
                sender,
                commit_author: None,
                title: None,
                body_text: None,
                comment_id: None,
                head_sha: None,
                base_branch: None,
                head_branch: None,
                html_url: payload["repository"]["html_url"]
                    .as_str()
                    .map(|s| s.to_string()),
                raw_payload: payload,
            })),

            "pull_request" => {
                let action = payload["action"].as_str().unwrap_or("");
                let pr = &payload["pull_request"];
                let number = payload["number"].as_u64().or_else(|| pr["number"].as_u64());

                let event_kind = match action {
                    "opened" | "reopened" => GitEventKind::PullRequestOpened,
                    "synchronize" => GitEventKind::PullRequestSynchronize,
                    other => GitEventKind::Unknown(format!("pr_{other}")),
                };

                let head_sha = pr["head"]["sha"].as_str().map(|s| s.to_string());
                let head_branch = pr["head"]["ref"].as_str().map(|s| s.to_string());
                let base_branch = pr["base"]["ref"].as_str().map(|s| s.to_string());
                let title = pr["title"].as_str().map(|s| s.to_string());
                let body_text = pr["body"].as_str().map(|s| s.to_string());
                let html_url = pr["html_url"].as_str().map(|s| s.to_string());

                Ok(Some(NormalizedGitEvent {
                    platform: "github".to_string(),
                    event_kind,
                    repo_full_name,
                    is_pull_request: true,
                    issue_or_pr_number: number,
                    sender,
                    commit_author: None,
                    title,
                    body_text,
                    comment_id: None,
                    head_sha,
                    base_branch,
                    head_branch,
                    html_url,
                    raw_payload: payload,
                }))
            }

            "issue_comment" => {
                let action = payload["action"].as_str().unwrap_or("");
                if action != "created" {
                    return Ok(None);
                }

                let issue = &payload["issue"];
                let comment = &payload["comment"];
                let number = issue["number"].as_u64();
                let is_pull_request = issue.get("pull_request").is_some();
                let comment_id = comment["id"].as_u64();
                let body_text = comment["body"].as_str().map(|s| s.to_string());
                let title = issue["title"].as_str().map(|s| s.to_string());

                let author_association = comment["author_association"]
                    .as_str()
                    .or_else(|| issue["author_association"].as_str())
                    .map(|s| s.to_string());

                let comment_sender = GitUserMeta {
                    username: comment["user"]["login"]
                        .as_str()
                        .unwrap_or("unknown")
                        .to_string(),
                    display_name: comment["user"]["name"].as_str().map(|s| s.to_string()),
                    email: comment["user"]["email"].as_str().map(|s| s.to_string()),
                    user_type: comment["user"]["type"]
                        .as_str()
                        .unwrap_or("User")
                        .to_string(),
                    avatar_url: comment["user"]["avatar_url"]
                        .as_str()
                        .map(|s| s.to_string()),
                    author_association,
                };

                let html_url = comment["html_url"]
                    .as_str()
                    .or_else(|| issue["html_url"].as_str())
                    .map(|s| s.to_string());

                Ok(Some(NormalizedGitEvent {
                    platform: "github".to_string(),
                    event_kind: GitEventKind::IssueCommentCreated,
                    repo_full_name,
                    is_pull_request,
                    issue_or_pr_number: number,
                    sender: comment_sender,
                    commit_author: None,
                    title,
                    body_text,
                    comment_id,
                    head_sha: None,
                    base_branch: None,
                    head_branch: None,
                    html_url,
                    raw_payload: payload,
                }))
            }

            "push" => {
                let head_sha = payload["after"].as_str().map(|s| s.to_string());
                let ref_str = payload["ref"].as_str().unwrap_or("");
                let branch = ref_str.strip_prefix("refs/heads/").unwrap_or(ref_str);

                let pusher_name = payload["pusher"]["name"].as_str().unwrap_or("");
                let pusher_email = payload["pusher"]["email"].as_str().map(|s| s.to_string());

                let pusher = GitUserMeta {
                    username: pusher_name.to_string(),
                    display_name: None,
                    email: pusher_email,
                    user_type: "User".to_string(),
                    avatar_url: None,
                    author_association: Some("COLLABORATOR".to_string()),
                };

                Ok(Some(NormalizedGitEvent {
                    platform: "github".to_string(),
                    event_kind: GitEventKind::Push,
                    repo_full_name,
                    is_pull_request: false,
                    issue_or_pr_number: None,
                    sender: pusher,
                    commit_author: None,
                    title: None,
                    body_text: None,
                    comment_id: None,
                    head_sha,
                    base_branch: Some(branch.to_string()),
                    head_branch: None,
                    html_url: payload["compare"].as_str().map(|s| s.to_string()),
                    raw_payload: payload,
                }))
            }

            other => Ok(Some(NormalizedGitEvent {
                platform: "github".to_string(),
                event_kind: GitEventKind::Unknown(other.to_string()),
                repo_full_name,
                is_pull_request: false,
                issue_or_pr_number: None,
                sender,
                commit_author: None,
                title: None,
                body_text: None,
                comment_id: None,
                head_sha: None,
                base_branch: None,
                head_branch: None,
                html_url: None,
                raw_payload: payload,
            })),
        }
    }

    async fn post_comment(
        &self,
        token: &str,
        api_base: Option<&str>,
        repo: &str,
        number: u64,
        body: &str,
    ) -> Result<u64, String> {
        let base = api_base
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_GITHUB_API_BASE)
            .trim_end_matches('/');
        let repo = repo.trim().trim_start_matches('/');
        let url = format!("{base}/repos/{repo}/issues/{number}/comments");

        let client = crate::git_adapter::shared_http_client();
        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token.trim()))
            .header("User-Agent", "JeikCode-Bot/1.0")
            .header("Accept", "application/vnd.github+json")
            .json(&serde_json::json!({ "body": body }))
            .send()
            .await
            .map_err(|e| format!("Failed to send comment request to GitHub: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let err_text = resp.text().await.unwrap_or_default();
            return Err(format!("GitHub post comment failed ({status}): {err_text}"));
        }

        let created_json: Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse GitHub comment response: {e}"))?;

        let id = created_json["id"]
            .as_u64()
            .ok_or_else(|| "GitHub comment response missing 'id'".to_string())?;

        Ok(id)
    }

    async fn update_comment(
        &self,
        token: &str,
        api_base: Option<&str>,
        repo: &str,
        comment_id: u64,
        _target_number: Option<u64>,
        body: &str,
    ) -> Result<(), String> {
        let base = api_base
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_GITHUB_API_BASE)
            .trim_end_matches('/');
        let repo = repo.trim().trim_start_matches('/');
        let url = format!("{base}/repos/{repo}/issues/comments/{comment_id}");

        let client = crate::git_adapter::shared_http_client();
        let resp = client
            .patch(&url)
            .header("Authorization", format!("Bearer {}", token.trim()))
            .header("User-Agent", "JeikCode-Bot/1.0")
            .header("Accept", "application/vnd.github+json")
            .json(&serde_json::json!({ "body": body }))
            .send()
            .await
            .map_err(|e| format!("Failed to send comment update to GitHub: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let err_text = resp.text().await.unwrap_or_default();
            return Err(format!(
                "GitHub update comment failed ({status}): {err_text}"
            ));
        }

        Ok(())
    }

    async fn find_bot_primary_comment(
        &self,
        token: &str,
        api_base: Option<&str>,
        repo: &str,
        number: u64,
    ) -> Result<Option<u64>, String> {
        let base = api_base
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_GITHUB_API_BASE)
            .trim_end_matches('/');
        let repo = repo.trim().trim_start_matches('/');
        let url = format!("{base}/repos/{repo}/issues/{number}/comments?per_page=100");

        let client = crate::git_adapter::shared_http_client();
        let resp = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token.trim()))
            .header("User-Agent", "JeikCode-Bot/1.0")
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| format!("Failed to list GitHub comments: {e}"))?;

        if !resp.status().is_success() {
            return Ok(None);
        }

        let comments: Value = resp.json().await.unwrap_or(Value::Null);
        let Some(list) = comments.as_array() else {
            return Ok(None);
        };

        // 从后往前查找 Bot 发表的最新评论（标识包含 JeikCode 或 user_type 为 Bot）
        for item in list.iter().rev() {
            let is_bot = item["user"]["type"].as_str() == Some("Bot")
                || item["user"]["login"]
                    .as_str()
                    .map(|u| u.ends_with("[bot]"))
                    .unwrap_or(false);
            let body = item["body"].as_str().unwrap_or("");
            if (is_bot || body.contains("JeikCode")) && !body.is_empty() {
                if let Some(id) = item["id"].as_u64() {
                    return Ok(Some(id));
                }
            }
        }

        Ok(None)
    }

    async fn test_connection(
        &self,
        token: &str,
        api_base: Option<&str>,
        repo: &str,
    ) -> Result<String, String> {
        let base = api_base
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_GITHUB_API_BASE)
            .trim_end_matches('/');
        let repo = repo.trim().trim_start_matches('/');
        if repo.is_empty() {
            return Err("Missing repository identifier (e.g. owner/repo)".to_string());
        }
        let url = format!("{base}/repos/{repo}");

        let client = crate::git_adapter::shared_http_client();
        let mut req = client
            .get(&url)
            .header("User-Agent", "JeikCode-Bot/1.0")
            .header("Accept", "application/vnd.github+json");

        let token = token.trim();
        if !token.is_empty() {
            req = req.header("Authorization", format!("Bearer {token}"));
        }

        let resp = req
            .send()
            .await
            .map_err(|e| format!("Failed to connect to GitHub API: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let err_text = resp.text().await.unwrap_or_default();
            return Err(format!("GitHub API returned {status}: {err_text}"));
        }

        let repo_json: Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse GitHub repository response: {e}"))?;

        let full_name = repo_json["full_name"].as_str().unwrap_or(repo).to_string();
        let desc = repo_json["description"].as_str().unwrap_or("");
        let msg = if desc.is_empty() {
            format!("Verified access to {full_name}")
        } else {
            format!("Verified access to {full_name} ({desc})")
        };
        Ok(msg)
    }

    async fn fetch_active_pull_requests_with_etag(
        &self,
        token: &str,
        api_base: Option<&str>,
        repo: &str,
        etag: Option<&str>,
    ) -> Result<PollPullRequestsOutput, String> {
        let base = api_base
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_GITHUB_API_BASE)
            .trim_end_matches('/');
        let repo = repo.trim().trim_start_matches('/');
        let url =
            format!("{base}/repos/{repo}/pulls?state=open&sort=updated&direction=desc&per_page=50");

        let client = crate::git_adapter::shared_http_client();
        let mut req = client.get(&url).header("User-Agent", "JeikCode-Bot/1.0");
        if !token.trim().is_empty() {
            req = req.header("Authorization", format!("Bearer {}", token.trim()));
        }
        if let Some(tag) = etag {
            let tag = tag.trim();
            if !tag.is_empty() {
                req = req.header("If-None-Match", tag);
            }
        }

        let resp = req
            .send()
            .await
            .map_err(|e| format!("Failed to fetch open PRs from GitHub: {e}"))?;

        let status = resp.status();
        if status == reqwest::StatusCode::NOT_MODIFIED {
            let response_etag = resp
                .headers()
                .get("etag")
                .and_then(|val| val.to_str().ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            return Ok(PollPullRequestsOutput {
                events: vec![],
                etag: response_etag.or_else(|| etag.map(|s| s.to_string())),
                not_modified: true,
            });
        }

        if !status.is_success() {
            let retry_after = crate::git_adapter::parse_retry_after_header(resp.headers());
            let err_text = resp.text().await.unwrap_or_default();
            let retry_suffix = retry_after
                .map(|secs| format!(" (retry-after: {secs}s)"))
                .unwrap_or_default();
            return Err(format!(
                "GitHub fetch open PRs failed ({status}){retry_suffix}: {err_text}"
            ));
        }

        let new_etag = resp
            .headers()
            .get("etag")
            .and_then(|val| val.to_str().ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let prs: Vec<Value> = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse GitHub PR list response: {e}"))?;

        let mut events = Vec::new();
        for pr in prs {
            let number = pr["number"].as_u64();
            let title = pr["title"].as_str().map(|s| s.to_string());
            let body_text = pr["body"].as_str().map(|s| s.to_string());
            let head_sha = pr["head"]["sha"].as_str().map(|s| s.to_string());
            let base_branch = pr["base"]["ref"].as_str().map(|s| s.to_string());
            let head_branch = pr["head"]["ref"].as_str().map(|s| s.to_string());
            let html_url = pr["html_url"].as_str().map(|s| s.to_string());

            let user_obj = &pr["user"];
            let sender = GitUserMeta {
                username: user_obj["login"].as_str().unwrap_or("unknown").to_string(),
                display_name: user_obj["name"].as_str().map(|s| s.to_string()),
                email: user_obj["email"].as_str().map(|s| s.to_string()),
                user_type: user_obj["type"].as_str().unwrap_or("User").to_string(),
                avatar_url: user_obj["avatar_url"].as_str().map(|s| s.to_string()),
                author_association: pr["author_association"].as_str().map(|s| s.to_string()),
            };

            events.push(NormalizedGitEvent {
                platform: "github".to_string(),
                event_kind: GitEventKind::PullRequestOpened,
                repo_full_name: repo.to_string(),
                is_pull_request: true,
                issue_or_pr_number: number,
                sender,
                commit_author: None,
                title,
                body_text,
                comment_id: None,
                head_sha,
                base_branch,
                head_branch,
                html_url,
                raw_payload: pr,
            });
        }

        Ok(PollPullRequestsOutput {
            events,
            etag: new_etag,
            not_modified: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn test_github_verify_signature_case_insensitivity_and_whitespace() {
        let adapter = GitHubAdapter::new();
        let secret = "test_webhook_secret";
        let body = b"{\"action\":\"opened\"}";

        let calculated_bytes = hmac_sha256(secret.as_bytes(), body);
        let hex_str = to_hex(&calculated_bytes);

        // 1. Standard lowercase
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-hub-signature-256",
            HeaderValue::from_str(&format!("sha256:{hex_str}"))
                .unwrap_or(HeaderValue::from_static("")),
        );
        // Prefix is sha256=, not sha256:
        headers.insert(
            "x-hub-signature-256",
            HeaderValue::from_str(&format!("sha256={hex_str}")).unwrap(),
        );
        assert!(adapter.verify_signature(secret, &headers, body));

        // 2. Uppercase prefix SHA256= and uppercase hex
        let mut headers_upper = HeaderMap::new();
        headers_upper.insert(
            "x-hub-signature-256",
            HeaderValue::from_str(&format!("SHA256={}", hex_str.to_ascii_uppercase())).unwrap(),
        );
        assert!(adapter.verify_signature(secret, &headers_upper, body));

        // 3. Header with surrounding whitespace
        let mut headers_ws = HeaderMap::new();
        headers_ws.insert(
            "x-hub-signature-256",
            HeaderValue::from_str(&format!("  sha256={}  ", hex_str)).unwrap(),
        );
        assert!(adapter.verify_signature(secret, &headers_ws, body));

        // 4. Invalid secret fails
        assert!(!adapter.verify_signature("wrong_secret", &headers, body));

        // 5. Empty secret bypasses
        assert!(adapter.verify_signature("", &HeaderMap::new(), body));
    }

    #[test]
    fn test_github_parse_ping_and_pull_request_events() {
        let adapter = GitHubAdapter::new();

        // Ping event
        let mut ping_headers = HeaderMap::new();
        ping_headers.insert("x-github-event", HeaderValue::from_static("ping"));
        let ping_payload = serde_json::json!({
            "repository": {
                "full_name": "jeikl/JeikCode",
                "html_url": "https://github.com/jeikl/JeikCode"
            },
            "sender": {
                "login": "octocat",
                "type": "User"
            }
        });
        let parsed_ping = adapter
            .parse_event(&ping_headers, ping_payload)
            .unwrap()
            .unwrap();
        assert_eq!(parsed_ping.event_kind, GitEventKind::Ping);
        assert_eq!(parsed_ping.repo_full_name, "jeikl/JeikCode");
        assert_eq!(parsed_ping.sender.username, "octocat");

        // Pull request event
        let mut pr_headers = HeaderMap::new();
        pr_headers.insert("x-github-event", HeaderValue::from_static("pull_request"));
        let pr_payload = serde_json::json!({
            "action": "opened",
            "number": 42,
            "repository": {
                "full_name": "jeikl/JeikCode"
            },
            "pull_request": {
                "number": 42,
                "title": "feat: add feature",
                "body": "PR description",
                "html_url": "https://github.com/jeikl/JeikCode/pull/42",
                "head": {
                    "sha": "abcdef123456",
                    "ref": "feat/my-branch"
                },
                "base": {
                    "ref": "beta"
                }
            },
            "sender": {
                "login": "contributor",
                "type": "User",
                "author_association": "CONTRIBUTOR"
            }
        });
        let parsed_pr = adapter
            .parse_event(&pr_headers, pr_payload)
            .unwrap()
            .unwrap();
        assert_eq!(parsed_pr.event_kind, GitEventKind::PullRequestOpened);
        assert_eq!(parsed_pr.issue_or_pr_number, Some(42));
        assert_eq!(parsed_pr.head_sha.as_deref(), Some("abcdef123456"));
        assert_eq!(parsed_pr.head_branch.as_deref(), Some("feat/my-branch"));
        assert_eq!(parsed_pr.base_branch.as_deref(), Some("beta"));
        assert_eq!(parsed_pr.sender.username, "contributor");
    }

    #[tokio::test]
    async fn test_github_fetch_active_pull_requests_etag_header_and_304() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock github server");
        let addr = listener.local_addr().expect("mock addr");
        let api_base = format!("http://127.0.0.1:{}", addr.port());

        let server_task = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.expect("accept");
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).await.expect("read");
                let req_text = String::from_utf8_lossy(&buf[..n]);

                if req_text.contains("if-none-match: W/\"etag-42\"")
                    || req_text.contains("If-None-Match: W/\"etag-42\"")
                {
                    let resp = "HTTP/1.1 304 Not Modified\r\nETag: W/\"etag-42\"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
                    stream.write_all(resp.as_bytes()).await.expect("write 304");
                } else {
                    let body = serde_json::json!([{
                        "number": 42,
                        "title": "PR 42",
                        "body": "PR description",
                        "html_url": "https://github.com/owner/repo/pull/42",
                        "head": {
                            "sha": "sha-42",
                            "ref": "feature-42"
                        },
                        "base": {
                            "ref": "beta"
                        },
                        "user": {
                            "login": "tester",
                            "type": "User"
                        }
                    }])
                    .to_string();
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nETag: W/\"etag-42\"\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    stream.write_all(resp.as_bytes()).await.expect("write 200");
                }
            }
        });

        let adapter = GitHubAdapter::new();

        // 1. First poll: no etag provided -> 200 OK with ETag
        let out1 = adapter
            .fetch_active_pull_requests_with_etag("test-token", Some(&api_base), "owner/repo", None)
            .await
            .expect("fetch 200");
        assert!(!out1.not_modified);
        assert_eq!(out1.etag.as_deref(), Some("W/\"etag-42\""));
        assert_eq!(out1.events.len(), 1);
        assert_eq!(out1.events[0].issue_or_pr_number, Some(42));
        assert_eq!(out1.events[0].head_sha.as_deref(), Some("sha-42"));

        // 2. Second poll: cached etag provided -> 304 Not Modified
        let out2 = adapter
            .fetch_active_pull_requests_with_etag(
                "test-token",
                Some(&api_base),
                "owner/repo",
                out1.etag.as_deref(),
            )
            .await
            .expect("fetch 304");
        assert!(out2.not_modified);
        assert_eq!(out2.etag.as_deref(), Some("W/\"etag-42\""));
        assert!(out2.events.is_empty());

        let _ = server_task.await;
    }
}
