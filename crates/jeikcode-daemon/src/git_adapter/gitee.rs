//! Gitee platform adapter driver.
//!
//! Implements Gitee webhook verification (X-Gitee-Token), normalized event parsing,
//! and Gitee REST API v5 integration (Pull Requests, Comments, Active PR polling).

use axum::http::HeaderMap;
use serde_json::Value;

use super::{constant_time_eq, GitEventKind, GitPlatformAdapter, GitUserMeta, NormalizedGitEvent};

#[derive(Debug, Default, Clone)]
pub struct GiteeAdapter;

impl GiteeAdapter {
    pub fn new() -> Self {
        Self
    }
}

const DEFAULT_GITEE_API_BASE: &str = "https://gitee.com/api/v5";

/// 将形如 "owner/repo" 解析为 (owner, repo)
fn split_repo_owner(repo: &str) -> (&str, &str) {
    let trimmed = repo.trim().trim_matches('/');
    if let Some((owner, r)) = trimmed.split_once('/') {
        (owner.trim(), r.trim())
    } else {
        (trimmed, "")
    }
}

#[async_trait::async_trait]
impl GitPlatformAdapter for GiteeAdapter {
    fn platform_id(&self) -> &'static str {
        "gitee"
    }

    fn verify_signature(&self, secret: &str, headers: &HeaderMap, _body_bytes: &[u8]) -> bool {
        let secret = secret.trim();
        if secret.is_empty() {
            // 未配置 secret 时默认放行
            return true;
        }

        let Some(token_header) = headers.get("x-gitee-token") else {
            return false;
        };

        let Ok(token_str) = token_header.to_str() else {
            return false;
        };

        constant_time_eq(token_str.trim().as_bytes(), secret.as_bytes())
    }

    fn parse_event(
        &self,
        headers: &HeaderMap,
        payload: Value,
    ) -> Result<Option<NormalizedGitEvent>, String> {
        let event_type_header = headers
            .get("x-gitee-event")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .trim();

        let repo_full_name = payload["repository"]["full_name"]
            .as_str()
            .or_else(|| payload["repository"]["path_with_namespace"].as_str())
            .unwrap_or("")
            .to_string();

        let sender_obj = &payload["sender"];
        let sender = GitUserMeta {
            username: sender_obj["login"]
                .as_str()
                .or_else(|| payload["user"]["login"].as_str())
                .unwrap_or("unknown")
                .to_string(),
            display_name: sender_obj["name"]
                .as_str()
                .or_else(|| payload["user"]["name"].as_str())
                .map(|s| s.to_string()),
            email: sender_obj["email"]
                .as_str()
                .or_else(|| payload["user"]["email"].as_str())
                .map(|s| s.to_string()),
            user_type: "User".to_string(),
            avatar_url: sender_obj["avatar_url"]
                .as_str()
                .or_else(|| payload["user"]["avatar_url"].as_str())
                .map(|s| s.to_string()),
            author_association: None,
        };

        // 1. 处理评论 Note 事件（优先处理，避免包含 pull_request 对象的评论事件误判为 PR 开关事件）
        if event_type_header == "Note Hook" || payload.get("comment").is_some() {
            let is_pr = payload.get("pull_request").is_some()
                || payload["noteable_type"].as_str() == Some("PullRequest");

            let (pr_or_issue_num, title) = if is_pr {
                let pr = &payload["pull_request"];
                (
                    pr["number"].as_u64(),
                    pr["title"].as_str().map(|s| s.to_string()),
                )
            } else {
                let issue = &payload["issue"];
                (
                    issue["number"].as_u64(),
                    issue["title"].as_str().map(|s| s.to_string()),
                )
            };

            let comment_obj = &payload["comment"];
            let comment_id = comment_obj["id"].as_u64();
            let body_text = comment_obj["body"].as_str().map(|s| s.to_string());
            let html_url = comment_obj["html_url"].as_str().map(|s| s.to_string());

            return Ok(Some(NormalizedGitEvent {
                platform: "gitee".to_string(),
                event_kind: GitEventKind::IssueCommentCreated,
                repo_full_name,
                is_pull_request: is_pr,
                issue_or_pr_number: pr_or_issue_num,
                sender,
                commit_author: None,
                title,
                body_text,
                comment_id,
                head_sha: None,
                base_branch: None,
                head_branch: None,
                html_url,
                raw_payload: payload,
            }));
        }

        // 2. 处理 Pull Request / Merge Request 事件
        if event_type_header == "Pull Request Hook"
            || event_type_header == "Merge Request Hook"
            || payload.get("pull_request").is_some()
        {
            let pr = &payload["pull_request"];
            let number = pr["number"].as_u64().or_else(|| payload["number"].as_u64());
            let title = pr["title"].as_str().map(|s| s.to_string());
            let body_text = pr["body"].as_str().map(|s| s.to_string());
            let head_sha = pr["head"]["sha"].as_str().map(|s| s.to_string());
            let base_branch = pr["base"]["ref"].as_str().map(|s| s.to_string());
            let head_branch = pr["head"]["ref"].as_str().map(|s| s.to_string());
            let html_url = pr["html_url"].as_str().map(|s| s.to_string());

            let action = payload["action"].as_str().unwrap_or("open");
            let event_kind = match action {
                "open" | "reopen" => GitEventKind::PullRequestOpened,
                "update" | "synchronize" => GitEventKind::PullRequestSynchronize,
                other => GitEventKind::Unknown(other.to_string()),
            };

            return Ok(Some(NormalizedGitEvent {
                platform: "gitee".to_string(),
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
            }));
        }

        // 处理 Push 事件
        if event_type_header == "Push Hook" {
            let head_sha = payload["after"].as_str().map(|s| s.to_string());
            let ref_branch = payload["ref"].as_str().map(|s| s.to_string());
            return Ok(Some(NormalizedGitEvent {
                platform: "gitee".to_string(),
                event_kind: GitEventKind::Push,
                repo_full_name,
                is_pull_request: false,
                issue_or_pr_number: None,
                sender,
                commit_author: None,
                title: None,
                body_text: None,
                comment_id: None,
                head_sha,
                base_branch: ref_branch.clone(),
                head_branch: ref_branch,
                html_url: None,
                raw_payload: payload,
            }));
        }

        Ok(Some(NormalizedGitEvent {
            platform: "gitee".to_string(),
            event_kind: GitEventKind::Unknown(event_type_header.to_string()),
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
        }))
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
            .unwrap_or(DEFAULT_GITEE_API_BASE)
            .trim_end_matches('/');
        let (owner, r) = split_repo_owner(repo);

        let client = reqwest::Client::new();
        // 动态路由：优先尝试 Pull Request 评论端点 (/repos/{owner}/{repo}/pulls/{number}/comments)
        let pr_url = format!("{base}/repos/{owner}/{r}/pulls/{number}/comments");
        if let Ok(resp) = client
            .post(&pr_url)
            .header("Authorization", format!("token {}", token.trim()))
            .header("User-Agent", "JeikCode-Bot/1.0")
            .json(&serde_json::json!({
                "body": body,
            }))
            .send()
            .await
        {
            if resp.status().is_success() {
                let created_json: Value = resp
                    .json()
                    .await
                    .map_err(|e| format!("Failed to parse Gitee comment response: {e}"))?;

                let id = created_json["id"]
                    .as_u64()
                    .ok_or_else(|| "Gitee comment response missing 'id'".to_string())?;

                return Ok(id);
            } else if resp.status() != reqwest::StatusCode::NOT_FOUND {
                let status = resp.status();
                let err_text = resp.text().await.unwrap_or_default();
                return Err(format!("Gitee post comment failed ({status}): {err_text}"));
            }
        }

        // 备用路由：尝试 Issue 评论端点 (/repos/{owner}/{repo}/issues/{number}/comments)
        let issue_url = format!("{base}/repos/{owner}/{r}/issues/{number}/comments");
        let resp = client
            .post(&issue_url)
            .header("Authorization", format!("token {}", token.trim()))
            .header("User-Agent", "JeikCode-Bot/1.0")
            .json(&serde_json::json!({
                "body": body,
            }))
            .send()
            .await
            .map_err(|e| format!("Failed to send comment request to Gitee: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let err_text = resp.text().await.unwrap_or_default();
            return Err(format!("Gitee post comment failed ({status}): {err_text}"));
        }

        let created_json: Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse Gitee comment response: {e}"))?;

        let id = created_json["id"]
            .as_u64()
            .ok_or_else(|| "Gitee comment response missing 'id'".to_string())?;

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
            .unwrap_or(DEFAULT_GITEE_API_BASE)
            .trim_end_matches('/');
        let (owner, r) = split_repo_owner(repo);

        let client = reqwest::Client::new();
        // 动态路由：优先尝试 PR 评论更新端点 (/pulls/comments/:id)
        let pr_url = format!("{base}/repos/{owner}/{r}/pulls/comments/{comment_id}");
        if let Ok(resp) = client
            .patch(&pr_url)
            .header("Authorization", format!("token {}", token.trim()))
            .header("User-Agent", "JeikCode-Bot/1.0")
            .json(&serde_json::json!({
                "body": body,
            }))
            .send()
            .await
        {
            if resp.status().is_success() {
                return Ok(());
            }
        }

        // 备用路由：尝试 Issue 评论更新端点 (/issues/comments/:id)
        let issue_url = format!("{base}/repos/{owner}/{r}/issues/comments/{comment_id}");
        let resp = client
            .patch(&issue_url)
            .header("Authorization", format!("token {}", token.trim()))
            .header("User-Agent", "JeikCode-Bot/1.0")
            .json(&serde_json::json!({
                "body": body,
            }))
            .send()
            .await
            .map_err(|e| format!("Failed to send comment update to Gitee: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let err_text = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Gitee update comment failed ({status}): {err_text}"
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
            .unwrap_or(DEFAULT_GITEE_API_BASE)
            .trim_end_matches('/');
        let (owner, r) = split_repo_owner(repo);
        let url = format!("{base}/repos/{owner}/{r}/pulls/{number}/comments?per_page=100&page=1");

        let client = reqwest::Client::new();
        let pr_url =
            format!("{base}/repos/{owner}/{r}/pulls/{number}/comments?per_page=100&page=1");

        let resp = match client
            .get(&pr_url)
            .header("Authorization", format!("token {}", token.trim()))
            .header("User-Agent", "JeikCode-Bot/1.0")
            .send()
            .await
        {
            Ok(res) if res.status().is_success() => res,
            _ => {
                let issue_url = format!(
                    "{base}/repos/{owner}/{r}/issues/{number}/comments?per_page=100&page=1"
                );
                client
                    .get(&issue_url)
                    .header("Authorization", format!("token {}", token.trim()))
                    .header("User-Agent", "JeikCode-Bot/1.0")
                    .send()
                    .await
                    .map_err(|e| format!("Failed to fetch comments from Gitee: {e}"))?
            }
        };

        if !resp.status().is_success() {
            return Ok(None);
        }

        let comments: Vec<Value> = resp.json().await.unwrap_or_default();
        for comment in comments {
            let body = comment["body"].as_str().unwrap_or("");
            if body.contains("Co-Authored-By: JeikCode")
                || body.contains("JeikCode Reviewer")
                || body.contains("Generated with [JeikCode]")
            {
                if let Some(id) = comment["id"].as_u64() {
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
            .unwrap_or(DEFAULT_GITEE_API_BASE)
            .trim_end_matches('/');
        let (owner, r) = split_repo_owner(repo);
        let url = format!("{base}/repos/{owner}/{r}");

        let client = reqwest::Client::new();
        let resp = client
            .get(&url)
            .header("Authorization", format!("token {}", token.trim()))
            .header("User-Agent", "JeikCode-Bot/1.0")
            .send()
            .await
            .map_err(|e| format!("Failed to connect to Gitee API: {e}"))?;

        let status = resp.status();
        if status.is_success() {
            let json: Value = resp.json().await.unwrap_or_default();
            let full_name = json["full_name"].as_str().unwrap_or(repo);
            let desc = json["description"].as_str().unwrap_or("(No description)");
            let is_private = json["private"].as_bool().unwrap_or(false);
            let visibility = if is_private { "private" } else { "public" };
            Ok(format!(
                "Connected to Gitee repository `{full_name}` [visibility: {visibility}]: {desc}"
            ))
        } else if status == axum::http::StatusCode::UNAUTHORIZED {
            Err(
                "Gitee token is invalid or lacks necessary scopes (`projects`, `pull_requests`)"
                    .to_string(),
            )
        } else if status == axum::http::StatusCode::NOT_FOUND {
            Err(format!(
                "Gitee repository `{repo}` not found (check repository path and permissions)"
            ))
        } else {
            let err_text = resp.text().await.unwrap_or_default();
            Err(format!(
                "Gitee connection test failed ({status}): {err_text}"
            ))
        }
    }

    async fn fetch_active_pull_requests(
        &self,
        token: &str,
        api_base: Option<&str>,
        repo: &str,
    ) -> Result<Vec<NormalizedGitEvent>, String> {
        let base = api_base
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_GITEE_API_BASE)
            .trim_end_matches('/');
        let (owner, r) = split_repo_owner(repo);
        let url = format!(
            "{base}/repos/{owner}/{r}/pulls?state=open&sort=updated&direction=desc&per_page=50"
        );

        let client = reqwest::Client::new();
        let resp = client
            .get(&url)
            .header("Authorization", format!("token {}", token.trim()))
            .header("User-Agent", "JeikCode-Bot/1.0")
            .send()
            .await
            .map_err(|e| format!("Failed to fetch open PRs from Gitee: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let err_text = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Gitee fetch open PRs failed ({status}): {err_text}"
            ));
        }

        let prs: Vec<Value> = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse Gitee PR list response: {e}"))?;

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
                user_type: "User".to_string(),
                avatar_url: user_obj["avatar_url"].as_str().map(|s| s.to_string()),
                author_association: None,
            };

            events.push(NormalizedGitEvent {
                platform: "gitee".to_string(),
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

        Ok(events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn test_gitee_verify_signature() {
        let adapter = GiteeAdapter::new();
        let secret = "gitee_secret_token_456";

        // 1. Valid token matches secret
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-gitee-token",
            HeaderValue::from_static("gitee_secret_token_456"),
        );
        assert!(adapter.verify_signature(secret, &headers, b"{}"));

        // 2. Token with whitespace
        let mut headers_ws = HeaderMap::new();
        headers_ws.insert(
            "x-gitee-token",
            HeaderValue::from_static("  gitee_secret_token_456  "),
        );
        assert!(adapter.verify_signature(secret, &headers_ws, b"{}"));

        // 3. Mismatched token fails
        let mut headers_invalid = HeaderMap::new();
        headers_invalid.insert("x-gitee-token", HeaderValue::from_static("wrong_token"));
        assert!(!adapter.verify_signature(secret, &headers_invalid, b"{}"));

        // 4. Missing header fails when secret non-empty
        assert!(!adapter.verify_signature(secret, &HeaderMap::new(), b"{}"));

        // 5. Empty secret allows all
        assert!(adapter.verify_signature("", &HeaderMap::new(), b"{}"));
    }

    #[test]
    fn test_gitee_split_repo_owner() {
        assert_eq!(split_repo_owner("myorg/myrepo"), ("myorg", "myrepo"));
        assert_eq!(
            split_repo_owner("/leading/trailing/"),
            ("leading", "trailing")
        );
        assert_eq!(split_repo_owner("single"), ("single", ""));
    }

    #[test]
    fn test_gitee_parse_pull_request_event() {
        let adapter = GiteeAdapter::new();
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-gitee-event",
            HeaderValue::from_static("Pull Request Hook"),
        );

        let payload = serde_json::json!({
            "action": "open",
            "number": 88,
            "repository": {
                "full_name": "gitee-org/awesome-project"
            },
            "sender": {
                "login": "charlie",
                "name": "Charlie Zhang",
                "email": "charlie@gitee.com"
            },
            "pull_request": {
                "number": 88,
                "title": "fix: resolve deadlock in connection pool",
                "body": "Fixes deadlock condition when acquiring client",
                "html_url": "https://gitee.com/gitee-org/awesome-project/pulls/88",
                "head": {
                    "sha": "9a8b7c6d5e4f",
                    "ref": "fix/deadlock"
                },
                "base": {
                    "ref": "master"
                }
            }
        });

        let event = adapter.parse_event(&headers, payload).unwrap().unwrap();
        assert_eq!(event.platform, "gitee");
        assert_eq!(event.event_kind, GitEventKind::PullRequestOpened);
        assert_eq!(event.repo_full_name, "gitee-org/awesome-project");
        assert_eq!(event.issue_or_pr_number, Some(88));
        assert_eq!(
            event.title.as_deref(),
            Some("fix: resolve deadlock in connection pool")
        );
        assert_eq!(
            event.body_text.as_deref(),
            Some("Fixes deadlock condition when acquiring client")
        );
        assert_eq!(event.head_sha.as_deref(), Some("9a8b7c6d5e4f"));
        assert_eq!(event.base_branch.as_deref(), Some("master"));
        assert_eq!(event.head_branch.as_deref(), Some("fix/deadlock"));
        assert_eq!(event.sender.username, "charlie");
    }

    #[test]
    fn test_gitee_parse_note_event_on_pull_request() {
        let adapter = GiteeAdapter::new();
        let mut headers = HeaderMap::new();
        headers.insert("x-gitee-event", HeaderValue::from_static("Note Hook"));

        let payload = serde_json::json!({
            "noteable_type": "PullRequest",
            "repository": {
                "full_name": "gitee-org/awesome-project"
            },
            "sender": {
                "login": "dave"
            },
            "pull_request": {
                "number": 88,
                "title": "fix: resolve deadlock in connection pool"
            },
            "comment": {
                "id": 556677,
                "body": "@bot can we check benchmark performance?",
                "html_url": "https://gitee.com/gitee-org/awesome-project/pulls/88#note_556677"
            }
        });

        let event = adapter.parse_event(&headers, payload).unwrap().unwrap();
        assert_eq!(event.platform, "gitee");
        assert_eq!(event.event_kind, GitEventKind::IssueCommentCreated);
        assert!(event.is_pull_request);
        assert_eq!(event.issue_or_pr_number, Some(88));
        assert_eq!(event.comment_id, Some(556677));
        assert_eq!(
            event.body_text.as_deref(),
            Some("@bot can we check benchmark performance?")
        );
        assert_eq!(event.sender.username, "dave");
    }
}
