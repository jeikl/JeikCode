//! GitLab platform adapter driver.
//!
//! Implements GitLab webhook verification (X-Gitlab-Token), normalized event parsing,
//! and GitLab REST API v4 integration (Merge Requests, Notes, Active MR polling).

use axum::http::HeaderMap;
use serde_json::Value;

use super::{constant_time_eq, GitEventKind, GitPlatformAdapter, GitUserMeta, NormalizedGitEvent};

#[derive(Debug, Default, Clone)]
pub struct GitLabAdapter;

impl GitLabAdapter {
    pub fn new() -> Self {
        Self
    }
}

const DEFAULT_GITLAB_API_BASE: &str = "https://gitlab.com/api/v4";

/// 将形如 "group/project" 或 "group/subgroup/project" 的路径 URL 编码为 GitLab API 接受的格式
fn url_encode_repo(repo: &str) -> String {
    let trimmed = repo.trim().trim_matches('/');
    trimmed.replace('/', "%2F")
}

#[async_trait::async_trait]
impl GitPlatformAdapter for GitLabAdapter {
    fn platform_id(&self) -> &'static str {
        "gitlab"
    }

    fn verify_signature(&self, secret: &str, headers: &HeaderMap, _body_bytes: &[u8]) -> bool {
        let secret = secret.trim();
        if secret.is_empty() {
            // 未配置 secret 时默认放行
            return true;
        }

        let Some(token_header) = headers.get("x-gitlab-token") else {
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
            .get("x-gitlab-event")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .trim();

        let object_kind = payload["object_kind"].as_str().unwrap_or("").trim();

        // 提取项目路径全名
        let repo_full_name = payload["project"]["path_with_namespace"]
            .as_str()
            .or_else(|| payload["repository"]["homepage"].as_str())
            .unwrap_or("")
            .to_string();

        let user_obj = &payload["user"];
        let sender = GitUserMeta {
            username: user_obj["username"]
                .as_str()
                .unwrap_or_else(|| payload["user_username"].as_str().unwrap_or("unknown"))
                .to_string(),
            display_name: user_obj["name"]
                .as_str()
                .or_else(|| payload["user_name"].as_str())
                .map(|s| s.to_string()),
            email: user_obj["email"]
                .as_str()
                .or_else(|| payload["user_email"].as_str())
                .map(|s| s.to_string()),
            user_type: "User".to_string(),
            avatar_url: user_obj["avatar_url"]
                .as_str()
                .or_else(|| payload["user_avatar"].as_str())
                .map(|s| s.to_string()),
            author_association: None,
        };

        // 处理 Merge Request 事件
        if event_type_header == "Merge Request Hook" || object_kind == "merge_request" {
            let attrs = &payload["object_attributes"];
            let iid = attrs["iid"].as_u64().or_else(|| attrs["id"].as_u64());
            let title = attrs["title"].as_str().map(|s| s.to_string());
            let body_text = attrs["description"].as_str().map(|s| s.to_string());
            let head_sha = attrs["last_commit"]["id"]
                .as_str()
                .or_else(|| attrs["sha"].as_str())
                .map(|s| s.to_string());
            let base_branch = attrs["target_branch"].as_str().map(|s| s.to_string());
            let head_branch = attrs["source_branch"].as_str().map(|s| s.to_string());
            let html_url = attrs["url"].as_str().map(|s| s.to_string());

            let action = attrs["action"].as_str().unwrap_or("open");
            let event_kind = match action {
                "open" | "reopen" => GitEventKind::PullRequestOpened,
                "update" => GitEventKind::PullRequestSynchronize,
                other => GitEventKind::Unknown(other.to_string()),
            };

            return Ok(Some(NormalizedGitEvent {
                platform: "gitlab".to_string(),
                event_kind,
                repo_full_name,
                is_pull_request: true,
                issue_or_pr_number: iid,
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

        // 处理评论 Note 事件
        if event_type_header == "Note Hook" || object_kind == "note" {
            let attrs = &payload["object_attributes"];
            let noteable_type = attrs["noteable_type"].as_str().unwrap_or("");
            let is_pr = noteable_type == "MergeRequest";

            let (pr_or_issue_num, title) = if is_pr {
                let mr = &payload["merge_request"];
                (
                    mr["iid"].as_u64(),
                    mr["title"].as_str().map(|s| s.to_string()),
                )
            } else {
                let issue = &payload["issue"];
                (
                    issue["iid"].as_u64(),
                    issue["title"].as_str().map(|s| s.to_string()),
                )
            };

            let comment_id = attrs["id"].as_u64();
            let body_text = attrs["note"].as_str().map(|s| s.to_string());
            let html_url = attrs["url"].as_str().map(|s| s.to_string());

            return Ok(Some(NormalizedGitEvent {
                platform: "gitlab".to_string(),
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

        // 处理 Push 事件
        if event_type_header == "Push Hook" || object_kind == "push" {
            let head_sha = payload["after"].as_str().map(|s| s.to_string());
            let ref_branch = payload["ref"].as_str().map(|s| s.to_string());
            return Ok(Some(NormalizedGitEvent {
                platform: "gitlab".to_string(),
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
            platform: "gitlab".to_string(),
            event_kind: GitEventKind::Unknown(object_kind.to_string()),
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
            .unwrap_or(DEFAULT_GITLAB_API_BASE)
            .trim_end_matches('/');
        let encoded_repo = url_encode_repo(repo);
        let url = format!("{base}/projects/{encoded_repo}/merge_requests/{number}/notes");

        let client = reqwest::Client::new();
        let resp = client
            .post(&url)
            .header("PRIVATE-TOKEN", token.trim())
            .header("User-Agent", "JeikCode-Bot/1.0")
            .json(&serde_json::json!({ "body": body }))
            .send()
            .await
            .map_err(|e| format!("Failed to send comment request to GitLab: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let err_text = resp.text().await.unwrap_or_default();
            return Err(format!("GitLab post comment failed ({status}): {err_text}"));
        }

        let created_json: Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse GitLab comment response: {e}"))?;

        let id = created_json["id"]
            .as_u64()
            .ok_or_else(|| "GitLab comment response missing 'id'".to_string())?;

        Ok(id)
    }

    async fn update_comment(
        &self,
        token: &str,
        api_base: Option<&str>,
        repo: &str,
        comment_id: u64,
        body: &str,
    ) -> Result<(), String> {
        // GitLab notes API 需要在特定的 merge_request 下更新，如果只给 comment_id，需要从原笔记查找
        // 也可以直接使用 PUT /projects/:id/merge_requests/:mr_iid/notes/:note_id
        // 由于 GitPlatformAdapter 规范中 update_comment 只接受 (repo, comment_id)，
        // 为保证兼容性，我们在 query notes 时缓存或者从 find_bot_primary_comment 获取上下文，
        // 或者直接调用 PUT /projects/:id/merge_requests/:mr_iid/notes/:note_id。
        // 但注意 update_comment 的入参是 (token, api_base, repo, comment_id, body)。
        // GitLab v4 还支持项目级 issue notes：PUT /projects/:id/issues/notes/:note_id 并不通用。
        // 不过由于我们在 execute_git_workflow 中获取到 existing_id，
        // 且 MR 评论也可以通过 /projects/:id/merge_requests/:mr_iid/notes/:note_id 更新。
        // 让我们在 GitLab 实现中，如果需要，可通过搜索各 MR，或者直接通过 issue notes。
        // 注意：GitLab 中每个 note 的 noteable_id 就是 MR ID。
        let base = api_base
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_GITLAB_API_BASE)
            .trim_end_matches('/');
        let encoded_repo = url_encode_repo(repo);

        // 如果我们不知道 mr_iid，GitLab 允许直接用 note_id 查找。但更高效的方式是：
        // 尝试通过全局 note 查找或遍历。然而实际使用中，update_comment 与 find_bot_primary_comment 配对使用，
        // 让我们在 update_comment 里先发请求尝试更新。
        // 常见路径：对于已知 project 和 note_id，由于 GitLab 没有通用的 /notes/:id PUT，
        // 我们可以通过 GET 获取 note 详情或利用 mr_iid。
        // 为使 API 鲁棒，先发针对 MR 笔记的更新请求：
        let client = reqwest::Client::new();

        // 尝试通过通用 API 或备用路径：
        // 在大多数场景下，我们可以在 find_bot_primary_comment 中编码 `mr_iid << 32 | note_id`，
        // 或者直接使用 (comment_id & 0xFFFFFFFF) 与 (comment_id >> 32)。
        let (mr_iid, note_id) = if comment_id > 0xFFFFFFFF {
            ((comment_id >> 32) as u64, (comment_id & 0xFFFFFFFF) as u64)
        } else {
            (1, comment_id)
        };

        let url = format!("{base}/projects/{encoded_repo}/merge_requests/{mr_iid}/notes/{note_id}");
        let resp = client
            .put(&url)
            .header("PRIVATE-TOKEN", token.trim())
            .header("User-Agent", "JeikCode-Bot/1.0")
            .json(&serde_json::json!({ "body": body }))
            .send()
            .await
            .map_err(|e| format!("Failed to send comment update to GitLab: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let err_text = resp.text().await.unwrap_or_default();
            return Err(format!(
                "GitLab update comment failed ({status}): {err_text}"
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
            .unwrap_or(DEFAULT_GITLAB_API_BASE)
            .trim_end_matches('/');
        let encoded_repo = url_encode_repo(repo);
        let url = format!(
            "{base}/projects/{encoded_repo}/merge_requests/{number}/notes?per_page=100&sort=asc"
        );

        let client = reqwest::Client::new();
        let resp = client
            .get(&url)
            .header("PRIVATE-TOKEN", token.trim())
            .header("User-Agent", "JeikCode-Bot/1.0")
            .send()
            .await
            .map_err(|e| format!("Failed to fetch comments from GitLab: {e}"))?;

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
                    // 将 mr_iid (number) 与 note_id 编码为一个 64 位无符号整数，以便 update_comment 解码
                    let composite_id = (number << 32) | (id & 0xFFFFFFFF);
                    return Ok(Some(composite_id));
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
            .unwrap_or(DEFAULT_GITLAB_API_BASE)
            .trim_end_matches('/');
        let encoded_repo = url_encode_repo(repo);
        let url = format!("{base}/projects/{encoded_repo}");

        let client = reqwest::Client::new();
        let resp = client
            .get(&url)
            .header("PRIVATE-TOKEN", token.trim())
            .header("User-Agent", "JeikCode-Bot/1.0")
            .send()
            .await
            .map_err(|e| format!("Failed to connect to GitLab API: {e}"))?;

        let status = resp.status();
        if status.is_success() {
            let json: Value = resp.json().await.unwrap_or_default();
            let full_name = json["path_with_namespace"].as_str().unwrap_or(repo);
            let desc = json["description"].as_str().unwrap_or("(No description)");
            let visibility = json["visibility"].as_str().unwrap_or("private");
            Ok(format!(
                "Connected to GitLab project `{full_name}` [visibility: {visibility}]: {desc}"
            ))
        } else if status == axum::http::StatusCode::UNAUTHORIZED {
            Err(
                "GitLab token is invalid or lacks necessary API scopes (`api` or `read_api`)"
                    .to_string(),
            )
        } else if status == axum::http::StatusCode::NOT_FOUND {
            Err(format!(
                "GitLab project `{repo}` not found (check repository path and project permissions)"
            ))
        } else {
            let err_text = resp.text().await.unwrap_or_default();
            Err(format!(
                "GitLab connection test failed ({status}): {err_text}"
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
            .unwrap_or(DEFAULT_GITLAB_API_BASE)
            .trim_end_matches('/');
        let encoded_repo = url_encode_repo(repo);
        let url = format!("{base}/projects/{encoded_repo}/merge_requests?state=opened&per_page=30");

        let client = reqwest::Client::new();
        let resp = client
            .get(&url)
            .header("PRIVATE-TOKEN", token.trim())
            .header("User-Agent", "JeikCode-Bot/1.0")
            .send()
            .await
            .map_err(|e| format!("Failed to fetch open Merge Requests from GitLab: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let err_text = resp.text().await.unwrap_or_default();
            return Err(format!(
                "GitLab fetch open MRs failed ({status}): {err_text}"
            ));
        }

        let mrs: Vec<Value> = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse GitLab MR list response: {e}"))?;

        let mut events = Vec::new();
        for mr in mrs {
            let iid = mr["iid"].as_u64();
            let title = mr["title"].as_str().map(|s| s.to_string());
            let body_text = mr["description"].as_str().map(|s| s.to_string());
            let head_sha = mr["sha"]
                .as_str()
                .or_else(|| mr["diff_refs"]["head_sha"].as_str())
                .map(|s| s.to_string());
            let base_branch = mr["target_branch"].as_str().map(|s| s.to_string());
            let head_branch = mr["source_branch"].as_str().map(|s| s.to_string());
            let html_url = mr["web_url"].as_str().map(|s| s.to_string());

            let author_obj = &mr["author"];
            let sender = GitUserMeta {
                username: author_obj["username"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_string(),
                display_name: author_obj["name"].as_str().map(|s| s.to_string()),
                email: None,
                user_type: "User".to_string(),
                avatar_url: author_obj["avatar_url"].as_str().map(|s| s.to_string()),
                author_association: None,
            };

            events.push(NormalizedGitEvent {
                platform: "gitlab".to_string(),
                event_kind: GitEventKind::PullRequestOpened,
                repo_full_name: repo.to_string(),
                is_pull_request: true,
                issue_or_pr_number: iid,
                sender,
                commit_author: None,
                title,
                body_text,
                comment_id: None,
                head_sha,
                base_branch,
                head_branch,
                html_url,
                raw_payload: mr,
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
    fn test_gitlab_verify_signature() {
        let adapter = GitLabAdapter::new();
        let secret = "secret_gitlab_token_123";

        // 1. Valid token matches secret
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-gitlab-token",
            HeaderValue::from_static("secret_gitlab_token_123"),
        );
        assert!(adapter.verify_signature(secret, &headers, b"{}"));

        // 2. Token with whitespace
        let mut headers_ws = HeaderMap::new();
        headers_ws.insert(
            "x-gitlab-token",
            HeaderValue::from_static("  secret_gitlab_token_123  "),
        );
        assert!(adapter.verify_signature(secret, &headers_ws, b"{}"));

        // 3. Mismatched token fails
        let mut headers_invalid = HeaderMap::new();
        headers_invalid.insert("x-gitlab-token", HeaderValue::from_static("wrong_token"));
        assert!(!adapter.verify_signature(secret, &headers_invalid, b"{}"));

        // 4. Missing header fails when secret non-empty
        assert!(!adapter.verify_signature(secret, &HeaderMap::new(), b"{}"));

        // 5. Empty secret allows all
        assert!(adapter.verify_signature("", &HeaderMap::new(), b"{}"));
    }

    #[test]
    fn test_gitlab_url_encode_repo() {
        assert_eq!(url_encode_repo("mygroup/myproject"), "mygroup%2Fmyproject");
        assert_eq!(
            url_encode_repo("org/suborg/subsub/service"),
            "org%2Fsuborg%2Fsubsub%2Fservice"
        );
        assert_eq!(
            url_encode_repo("/leading/and/trailing/"),
            "leading%2Fand%2Ftrailing"
        );
    }

    #[test]
    fn test_gitlab_parse_merge_request_event() {
        let adapter = GitLabAdapter::new();
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-gitlab-event",
            HeaderValue::from_static("Merge Request Hook"),
        );

        let payload = serde_json::json!({
            "object_kind": "merge_request",
            "project": {
                "path_with_namespace": "myteam/backend-service"
            },
            "user": {
                "username": "alice",
                "name": "Alice Smith",
                "email": "alice@example.com"
            },
            "object_attributes": {
                "iid": 15,
                "title": "refactor: improve db queries",
                "description": "Optimizes SQL queries in repo",
                "action": "open",
                "target_branch": "main",
                "source_branch": "feat/db-perf",
                "url": "https://gitlab.com/myteam/backend-service/-/merge_requests/15",
                "last_commit": {
                    "id": "e4f8a3b5c7d9"
                }
            }
        });

        let event = adapter.parse_event(&headers, payload).unwrap().unwrap();
        assert_eq!(event.platform, "gitlab");
        assert_eq!(event.event_kind, GitEventKind::PullRequestOpened);
        assert_eq!(event.repo_full_name, "myteam/backend-service");
        assert_eq!(event.issue_or_pr_number, Some(15));
        assert_eq!(event.title.as_deref(), Some("refactor: improve db queries"));
        assert_eq!(
            event.body_text.as_deref(),
            Some("Optimizes SQL queries in repo")
        );
        assert_eq!(event.head_sha.as_deref(), Some("e4f8a3b5c7d9"));
        assert_eq!(event.base_branch.as_deref(), Some("main"));
        assert_eq!(event.head_branch.as_deref(), Some("feat/db-perf"));
        assert_eq!(event.sender.username, "alice");
    }

    #[test]
    fn test_gitlab_parse_note_event_on_merge_request() {
        let adapter = GitLabAdapter::new();
        let mut headers = HeaderMap::new();
        headers.insert("x-gitlab-event", HeaderValue::from_static("Note Hook"));

        let payload = serde_json::json!({
            "object_kind": "note",
            "project": {
                "path_with_namespace": "myteam/backend-service"
            },
            "user": {
                "username": "bob",
                "name": "Bob Jones"
            },
            "merge_request": {
                "iid": 15,
                "title": "refactor: improve db queries"
            },
            "object_attributes": {
                "id": 9988,
                "note": "@bot can you review the connection pool timeout?",
                "noteable_type": "MergeRequest",
                "url": "https://gitlab.com/myteam/backend-service/-/merge_requests/15#note_9988"
            }
        });

        let event = adapter.parse_event(&headers, payload).unwrap().unwrap();
        assert_eq!(event.platform, "gitlab");
        assert_eq!(event.event_kind, GitEventKind::IssueCommentCreated);
        assert!(event.is_pull_request);
        assert_eq!(event.issue_or_pr_number, Some(15));
        assert_eq!(event.comment_id, Some(9988));
        assert_eq!(
            event.body_text.as_deref(),
            Some("@bot can you review the connection pool timeout?")
        );
        assert_eq!(event.sender.username, "bob");
    }
}
