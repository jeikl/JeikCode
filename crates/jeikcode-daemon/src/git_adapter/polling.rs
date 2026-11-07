//! Background Git Platform Polling Engine.
//!
//! Provides proactive monitoring and automated PR reviews for local and enterprise
//! environments behind firewalls/NAT where incoming Webhooks cannot reach the daemon.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::{
    ensure_fresh_github_app_token, get_all_bindings, get_platform_adapter, GitSyncMode,
    NormalizedGitEvent,
};
use crate::api_git_webhook::execute_git_workflow;
use crate::AppState;

/// 最大并发自动审查任务数，防止海啸审查耗尽守护进程与模型资源
const MAX_CONCURRENT_REVIEWS: usize = 2;

static REVIEW_SEMAPHORE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();

fn get_review_semaphore() -> &'static Arc<tokio::sync::Semaphore> {
    REVIEW_SEMAPHORE.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_REVIEWS)))
}

/// 内存心跳时间戳缓存 (repo -> timestamp)，避免每轮心跳轮询高频写盘磨损 I/O
static LAST_POLLED_CACHE: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

fn get_last_polled_cache() -> &'static Mutex<HashMap<String, u64>> {
    LAST_POLLED_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 单个仓库的轮询同步状态
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RepoPollState {
    /// 上次轮询时间戳 (Unix 时间戳，秒)
    #[serde(default)]
    pub last_polled_at: u64,
    /// 是否已完成初次基线快照初始化（未初始化时仅记录现有 PR，不触发审查，避免海啸审查）
    #[serde(default)]
    pub initialized: bool,
    /// HTTP ETag 缓存标识，用于携带 If-None-Match 触发 HTTP 304 零配额消耗
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "last_etag",
        alias = "lastEtag"
    )]
    pub etag: Option<String>,
    /// 已审查或已知 PR 及其最后处理的 Head Commit SHA 映射 (pr_number -> head_sha)
    #[serde(default)]
    pub pr_head_shas: HashMap<u64, String>,
}

/// 全局轮询状态存储模型 (`~/.jeikcode/git-poll-state.json`)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GitPollStateStore {
    #[serde(default)]
    pub repos: HashMap<String, RepoPollState>,
}

fn poll_state_file_path() -> PathBuf {
    let root = jeikcode_capabilities::session::SessionManager::sessions_root();
    root.parent()
        .map(|dir| dir.join("git-poll-state.json"))
        .unwrap_or_else(|| PathBuf::from("git-poll-state.json"))
}

static POLL_STATE_CACHE: OnceLock<Mutex<GitPollStateStore>> = OnceLock::new();

fn get_state_cache() -> &'static Mutex<GitPollStateStore> {
    POLL_STATE_CACHE.get_or_init(|| {
        let store = load_poll_state_from_disk();
        Mutex::new(store)
    })
}

fn load_poll_state_from_disk() -> GitPollStateStore {
    let path = poll_state_file_path();
    let Ok(bytes) = std::fs::read(&path) else {
        return GitPollStateStore::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn save_poll_state_to_disk(store: &GitPollStateStore) {
    let path = poll_state_file_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(store) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

/// 当前系统时间戳 (秒)
fn current_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 判定仓库是否已完成基线初始化
pub fn is_repo_initialized(repo: &str) -> bool {
    let normalized_repo = repo.trim().to_lowercase();
    let Ok(lock) = get_state_cache().lock() else {
        return false;
    };
    lock.repos
        .get(&normalized_repo)
        .map(|r| r.initialized)
        .unwrap_or(false)
}

/// 获取指定仓库当前缓存的 ETag
pub fn get_repo_etag(repo: &str) -> Option<String> {
    let normalized_repo = repo.trim().to_lowercase();
    let Ok(lock) = get_state_cache().lock() else {
        return None;
    };
    lock.repos
        .get(&normalized_repo)
        .and_then(|r| r.etag.clone())
}

/// 更新仓库 ETag 缓存（仅在 ETag 实际发生变动时持久化落盘）
pub fn update_repo_etag(repo: &str, new_etag: Option<String>) -> bool {
    let normalized_repo = repo.trim().to_lowercase();
    let normalized_etag = new_etag
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let Ok(mut lock) = get_state_cache().lock() else {
        return false;
    };
    let repo_state = lock
        .repos
        .entry(normalized_repo)
        .or_insert_with(RepoPollState::default);

    if repo_state.etag == normalized_etag {
        return false;
    }

    repo_state.etag = normalized_etag;
    save_poll_state_to_disk(&lock);
    true
}

/// 初次同步时对现有存量 PR 进行基线录入（纯登记 head_sha，不设置 ETag，严禁触发审查与发送 ACK）
pub fn seed_repo_baseline(repo: &str, events: &[NormalizedGitEvent]) {
    seed_repo_baseline_with_etag(repo, events, None);
}

/// 初次同步时对现有存量 PR 及 ETag 进行基线录入（纯登记 head_sha 与 etag，严禁触发审查）
pub fn seed_repo_baseline_with_etag(
    repo: &str,
    events: &[NormalizedGitEvent],
    etag: Option<String>,
) {
    let normalized_repo = repo.trim().to_lowercase();
    let Ok(mut lock) = get_state_cache().lock() else {
        return;
    };
    let repo_state = lock
        .repos
        .entry(normalized_repo)
        .or_insert_with(RepoPollState::default);

    for ev in events {
        if let (Some(num), Some(ref sha)) = (ev.issue_or_pr_number, &ev.head_sha) {
            let s = sha.trim();
            if !s.is_empty() {
                repo_state.pr_head_shas.insert(num, s.to_string());
            }
        }
    }
    let normalized_etag = etag.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    repo_state.etag = normalized_etag;
    repo_state.initialized = true;
    save_poll_state_to_disk(&lock);
}

/// 原子更新仓库中活跃 PR 的 Head SHA 及 ETag（单次加锁 + 单次写盘），返回需要触发审查的事件列表。
/// 若接收到无 ETag 的 200 响应，显式清除先前的 ETag 缓存，防止跨端点绑定残留。
pub fn record_poll_results_atomic(
    repo: &str,
    events: &[NormalizedGitEvent],
    new_etag: Option<String>,
    auto_review_new_pr: bool,
) -> Vec<NormalizedGitEvent> {
    let normalized_repo = repo.trim().to_lowercase();
    let normalized_etag = new_etag
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let Ok(mut lock) = get_state_cache().lock() else {
        return Vec::new();
    };

    let repo_state = lock
        .repos
        .entry(normalized_repo)
        .or_insert_with(RepoPollState::default);

    let mut state_changed = false;

    // 1. 同步更新 ETag（若 200 响应未提供 ETag，显式清空旧 ETag 缓存）
    if repo_state.etag != normalized_etag {
        repo_state.etag = normalized_etag;
        state_changed = true;
    }

    // 2. 遍历 events，检查全新 PR 或 SHA 变动
    let mut events_to_review = Vec::new();

    for event in events {
        let (Some(pr_number), Some(ref head_sha)) = (event.issue_or_pr_number, &event.head_sha)
        else {
            continue;
        };
        let head_sha = head_sha.trim();
        if head_sha.is_empty() {
            continue;
        }

        let is_new_or_updated = match repo_state.pr_head_shas.get(&pr_number) {
            Some(existing) => existing != head_sha,
            None => true,
        };

        if is_new_or_updated {
            repo_state
                .pr_head_shas
                .insert(pr_number, head_sha.to_string());
            state_changed = true;

            if auto_review_new_pr {
                events_to_review.push(event.clone());
            }
        }
    }

    if !repo_state.initialized {
        repo_state.initialized = true;
        state_changed = true;
    }

    // 3. 仅在状态确实发生改变时执行单次落盘
    if state_changed {
        save_poll_state_to_disk(&lock);
    }

    events_to_review
}

/// 判定并记录 PR 是否有新提交变更（若检测到新 PR 或 SHA 变更则返回 true，并原子更新缓存）
pub fn check_and_update_pr_sha(repo: &str, pr_number: u64, head_sha: &str) -> bool {
    let normalized_repo = repo.trim().to_lowercase();
    let head_sha = head_sha.trim();
    if head_sha.is_empty() {
        return false;
    }

    let Ok(mut lock) = get_state_cache().lock() else {
        return false;
    };

    let repo_state = lock
        .repos
        .entry(normalized_repo)
        .or_insert_with(RepoPollState::default);

    if let Some(existing_sha) = repo_state.pr_head_shas.get(&pr_number) {
        if existing_sha == head_sha {
            // SHA 未发生任何改变，去重跳过
            return false;
        }
    }

    // 发现全新 PR 或新提交 Push 到该 PR
    repo_state
        .pr_head_shas
        .insert(pr_number, head_sha.to_string());
    repo_state.initialized = true;
    save_poll_state_to_disk(&lock);
    true
}

/// 标记仓库轮询时间（保存在内存中，避免高频写盘）
pub fn mark_repo_polled(repo: &str) {
    let normalized_repo = repo.trim().to_lowercase();
    if let Ok(mut lock) = get_last_polled_cache().lock() {
        lock.insert(normalized_repo, current_epoch_secs());
    }
}

/// 获取指定仓库上次轮询时间
pub fn get_repo_last_polled(repo: &str) -> u64 {
    let normalized_repo = repo.trim().to_lowercase();
    if let Ok(lock) = get_last_polled_cache().lock() {
        if let Some(&ts) = lock.get(&normalized_repo) {
            return ts;
        }
    }
    let Ok(lock) = get_state_cache().lock() else {
        return 0;
    };
    lock.repos
        .get(&normalized_repo)
        .map(|r| r.last_polled_at)
        .unwrap_or(0)
}

/// 单次轮询工作周期
pub async fn poll_cycle_tick(state: &AppState) {
    if jeikcode_config::config::offline::is_offline_active() {
        return;
    }
    let bindings = get_all_bindings();
    let now = current_epoch_secs();

    for mut config in bindings {
        // 仅处理配置为主动轮询模式且已启用的绑定，且必须为合法的 GitHub App 模式
        if !config.enabled
            || config.sync_mode != GitSyncMode::Polling
            || !config.is_github_app_mode()
        {
            continue;
        }

        // 确保 GitHub App 安装令牌新鲜有效：纯轮询（NAT / 无 Webhook 穿透）场景下安装令牌约 1 小时过期，
        // 若不主动换发，长跑守护进程会在过期后持续 401 直至重启。令牌仍在有效期时该调用为纯内存判断。
        config.access_token = ensure_fresh_github_app_token(&config).await;

        let repo = config.repo_identifier.trim();
        if repo.is_empty() {
            continue;
        }

        // 检查轮询间隔 (默认 60 秒，最小防抖 10 秒)
        let interval = (config.polling.interval_seconds as u64).max(10);
        let last_polled = get_repo_last_polled(repo);
        if now.saturating_sub(last_polled) < interval {
            continue;
        }

        // 标记本次开始轮询时间
        mark_repo_polled(repo);

        let adapter = get_platform_adapter(&config.channel);
        let custom_api_base = if config.custom_api_base.trim().is_empty() {
            None
        } else {
            Some(config.custom_api_base.as_str())
        };

        let cached_etag = get_repo_etag(repo);

        tracing::debug!(
            "[git_polling] Polling open PRs for `{repo}` on platform `{}` (ETag: {:?})",
            adapter.platform_id(),
            cached_etag
        );

        match adapter
            .fetch_active_pull_requests_with_etag(
                &config.access_token,
                custom_api_base,
                repo,
                cached_etag.as_deref(),
            )
            .await
        {
            Ok(output) => {
                if output.not_modified {
                    if !is_repo_initialized(repo) {
                        tracing::warn!(
                            "[git_polling] Uninitialized repository `{repo}` received unexpected 304 Not Modified; skipping baseline seed and clearing ETag."
                        );
                        update_repo_etag(repo, None);
                        continue;
                    }

                    // 若平台在 304 响应中提供了刷新/轮换的 ETag，确保同步更新持久化
                    if let Some(ref new_etag) = output.etag {
                        update_repo_etag(repo, Some(new_etag.clone()));
                    }
                    tracing::debug!(
                        "[git_polling] Repository `{repo}` returned HTTP 304 Not Modified. Zero quota deduction, preserving existing state."
                    );
                    continue;
                }

                let events = output.events;

                // 基线初始化检查：若该仓库首次接入轮询，仅对存量 PR 录入基线快照，严禁触发海啸审查
                if !is_repo_initialized(repo) {
                    let total = events.len();
                    seed_repo_baseline_with_etag(repo, &events, output.etag);
                    tracing::info!(
                        "[git_polling] Initialized baseline for `{repo}` with {total} existing open PR(s). No reviews triggered during initial sync."
                    );
                    continue;
                }

                // 仓库已初始化：原子更新 PR Head SHAs 与 ETag，单次加锁并持久化落盘
                let events_to_review = record_poll_results_atomic(
                    repo,
                    &events,
                    output.etag,
                    config.auto_review_new_pr,
                );

                for event in events_to_review {
                    let Some(pr_number) = event.issue_or_pr_number else {
                        continue;
                    };
                    let Some(ref head_sha) = event.head_sha else {
                        continue;
                    };

                    tracing::info!(
                        "[git_polling] Detected new/updated PR #{pr_number} in `{repo}` (SHA: {head_sha}). Dispatching review workflow."
                    );
                    let state_clone = state.clone();
                    let adapter_clone = adapter.clone();
                    let config_clone = config.clone();
                    let sem = get_review_semaphore().clone();
                    tokio::spawn(async move {
                        let _permit = sem.acquire_owned().await.expect("semaphore open");
                        if let Err(e) =
                            execute_git_workflow(state_clone, adapter_clone, config_clone, event)
                                .await
                        {
                            tracing::error!("[git_polling] Automated review execution failed: {e}");
                        }
                    });
                }
            }
            Err(e) => {
                tracing::warn!("[git_polling] Failed to fetch open PRs for `{repo}`: {e}");
            }
        }
    }
}

/// 启动全局后台 Git 轮询引擎守护任务
pub fn start_git_polling_engine(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        tracing::info!(
            "[git_polling] Background Git PR Polling Engine started (interval tick: 15s)"
        );
        // 初始启动等待 5 秒，让 HTTP 监听就绪
        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;

        loop {
            if !jeikcode_config::config::offline::is_offline_active() {
                poll_cycle_tick(&state).await;
            }
            tokio::time::sleep(tokio::time::Duration::from_secs(15)).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_adapter::{GitEventKind, GitUserMeta};

    #[test]
    #[serial_test::serial]
    fn test_poll_state_deduplication_logic() {
        let test_repo = "test-owner/test-repo-poll";
        let pr_num = 101;
        let sha1 = "1111111111111111111111111111111111111111";
        let sha2 = "2222222222222222222222222222222222222222";

        // 1. 首次发现 PR 101 -> 返回 true
        assert!(check_and_update_pr_sha(test_repo, pr_num, sha1));

        // 2. 相同 SHA 再次轮询 -> 返回 false (防重复审查去重)
        assert!(!check_and_update_pr_sha(test_repo, pr_num, sha1));

        // 3. 开发者 push 了新 commit (SHA 变动) -> 返回 true (触发增量审查)
        assert!(check_and_update_pr_sha(test_repo, pr_num, sha2));

        // 4. 新 SHA 再次轮询 -> 返回 false
        assert!(!check_and_update_pr_sha(test_repo, pr_num, sha2));

        // 5. 空 SHA 过滤 -> 返回 false
        assert!(!check_and_update_pr_sha(test_repo, pr_num, "   "));
    }

    #[test]
    #[serial_test::serial]
    fn test_baseline_seeding_prevents_thundering_herd() {
        let test_repo = "test-owner/test-baseline-repo";
        assert!(!is_repo_initialized(test_repo));

        // 构造存量已有的 2 个 open PR
        let events = vec![
            NormalizedGitEvent {
                platform: "github".to_string(),
                event_kind: GitEventKind::PullRequestOpened,
                repo_full_name: test_repo.to_string(),
                is_pull_request: true,
                issue_or_pr_number: Some(10),
                sender: GitUserMeta::default(),
                commit_author: None,
                title: Some("PR 10".into()),
                body_text: None,
                comment_id: None,
                head_sha: Some("sha-10-initial".into()),
                base_branch: None,
                head_branch: None,
                html_url: None,
                raw_payload: serde_json::Value::Null,
            },
            NormalizedGitEvent {
                platform: "github".to_string(),
                event_kind: GitEventKind::PullRequestOpened,
                repo_full_name: test_repo.to_string(),
                is_pull_request: true,
                issue_or_pr_number: Some(20),
                sender: GitUserMeta::default(),
                commit_author: None,
                title: Some("PR 20".into()),
                body_text: None,
                comment_id: None,
                head_sha: Some("sha-20-initial".into()),
                base_branch: None,
                head_branch: None,
                html_url: None,
                raw_payload: serde_json::Value::Null,
            },
        ];

        // 首次录入基线
        seed_repo_baseline(test_repo, &events);
        assert!(is_repo_initialized(test_repo));

        // 检查存量 PR 已记录，相同 SHA 轮询不会判定为 new/updated (避免海啸审查)
        assert!(!check_and_update_pr_sha(test_repo, 10, "sha-10-initial"));
        assert!(!check_and_update_pr_sha(test_repo, 20, "sha-20-initial"));

        // 后续周期中，存量 PR 产生新 commit -> 判定为更新
        assert!(check_and_update_pr_sha(test_repo, 10, "sha-10-updated"));

        // 全新 PR 30 -> 判定为新 PR
        assert!(check_and_update_pr_sha(test_repo, 30, "sha-30-new"));
    }

    #[test]
    #[serial_test::serial]
    fn test_in_memory_heartbeat_updates() {
        let test_repo = "test-owner/test-heartbeat-repo";
        mark_repo_polled(test_repo);
        let ts = get_repo_last_polled(test_repo);
        assert!(ts > 0);
    }

    #[tokio::test]
    #[serial_test::serial(offline_verdict)]
    async fn test_poll_cycle_tick_offline_exits_immediately() {
        use jeikcode_config::config::offline::{seed_offline_verdict, OfflineMode};
        let repo = "test-owner/test-offline-repo";
        let mut binding: crate::git_adapter::GitAdapterConfig =
            serde_json::from_str(r#"{"channel":"github","enabled":true,"syncMode":"polling"}"#)
                .unwrap();
        binding.project_hash = "offline-test-project".to_string();
        binding.repo_identifier = repo.to_string();
        binding.polling.interval_seconds = 10;
        crate::git_adapter::save_binding(binding);

        seed_offline_verdict(OfflineMode::On, None);
        let home = crate::tests::ScopedChatHome::new();
        let state = crate::tests::chat_test_state(&home);
        poll_cycle_tick(&state).await;

        assert_eq!(get_repo_last_polled(repo), 0);

        crate::git_adapter::disable_binding_for_project("offline-test-project");
        seed_offline_verdict(OfflineMode::Off, None);
    }

    #[test]
    #[serial_test::serial]
    fn test_repo_poll_state_etag_serialization_and_aliases() {
        let repo = "test-owner/test-etag-serialization";

        // 1. Deserialization with "etag"
        let json1 = r#"{"last_polled_at":12345,"initialized":true,"etag":"tag-v1"}"#;
        let state1: RepoPollState = serde_json::from_str(json1).unwrap();
        assert_eq!(state1.etag.as_deref(), Some("tag-v1"));

        // 2. Deserialization with alias "last_etag"
        let json2 = r#"{"last_polled_at":12345,"initialized":true,"last_etag":"tag-v2"}"#;
        let state2: RepoPollState = serde_json::from_str(json2).unwrap();
        assert_eq!(state2.etag.as_deref(), Some("tag-v2"));

        // 3. Deserialization with alias "lastEtag"
        let json3 = r#"{"last_polled_at":12345,"initialized":true,"lastEtag":"tag-v3"}"#;
        let state3: RepoPollState = serde_json::from_str(json3).unwrap();
        assert_eq!(state3.etag.as_deref(), Some("tag-v3"));

        // 4. Update and query helper
        assert_eq!(get_repo_etag(repo), None);
        assert!(update_repo_etag(repo, Some("tag-v1".to_string())));
        assert_eq!(get_repo_etag(repo).as_deref(), Some("tag-v1"));

        // Same ETag update should return false (no unnecessary disk write)
        assert!(!update_repo_etag(repo, Some("tag-v1".to_string())));

        // Changing ETag should return true
        assert!(update_repo_etag(repo, Some("tag-v2".to_string())));
        assert_eq!(get_repo_etag(repo).as_deref(), Some("tag-v2"));

        // Whitespace/empty ETag should normalize to None
        assert!(update_repo_etag(repo, Some("   ".to_string())));
        assert_eq!(get_repo_etag(repo), None);
        assert!(!update_repo_etag(repo, None));
    }

    #[test]
    #[serial_test::serial]
    fn test_baseline_seeding_stores_initial_etag() {
        let test_repo = "test-owner/test-baseline-etag-repo";
        assert!(!is_repo_initialized(test_repo));

        let events = vec![NormalizedGitEvent {
            platform: "github".to_string(),
            event_kind: GitEventKind::PullRequestOpened,
            repo_full_name: test_repo.to_string(),
            is_pull_request: true,
            issue_or_pr_number: Some(99),
            sender: GitUserMeta::default(),
            commit_author: None,
            title: Some("PR 99".into()),
            body_text: None,
            comment_id: None,
            head_sha: Some("sha-99-init".into()),
            base_branch: None,
            head_branch: None,
            html_url: None,
            raw_payload: serde_json::Value::Null,
        }];

        seed_repo_baseline_with_etag(test_repo, &events, Some("init-etag-99".to_string()));
        assert!(is_repo_initialized(test_repo));
        assert_eq!(get_repo_etag(test_repo).as_deref(), Some("init-etag-99"));
        assert!(!check_and_update_pr_sha(test_repo, 99, "sha-99-init"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn test_poll_cycle_tick_304_cache_hit_preserves_state() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock server");
        let addr = listener.local_addr().expect("mock addr");
        let api_base = format!("http://127.0.0.1:{}", addr.port());

        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();

        // Mock server returns:
        // Cycle 1: HTTP 304 on uninitialized repo -> should clear ETag and skip baseline seeding
        // Cycle 2: HTTP 304 with existing ETag -> preserves state
        // Cycle 3: HTTP 304 with rotated ETag -> updates cached ETag
        let server_task = tokio::spawn(async move {
            let mut cycle = 0;
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    res = listener.accept() => {
                        let Ok((mut stream, _)) = res else { break; };
                        let mut buf = [0u8; 4096];
                        let _ = stream.read(&mut buf).await;
                        cycle += 1;
                        let resp = if cycle == 1 {
                            "HTTP/1.1 304 Not Modified\r\nContent-Length: 0\r\n\r\n".to_string()
                        } else if cycle == 2 {
                            "HTTP/1.1 304 Not Modified\r\nETag: W/\"304-tag\"\r\nContent-Length: 0\r\n\r\n".to_string()
                        } else {
                            "HTTP/1.1 304 Not Modified\r\nETag: W/\"rotated-etag-v2\"\r\nContent-Length: 0\r\n\r\n".to_string()
                        };
                        let _ = stream.write_all(resp.as_bytes()).await;
                    }
                }
            }
        });

        let repo = "test-owner/test-304-repo";
        let project = "test-304-project";

        // Give uninitialized repo an unexpected lingering ETag
        update_repo_etag(repo, Some("unexpected-etag".to_string()));
        assert!(!is_repo_initialized(repo));

        let mut binding: crate::git_adapter::GitAdapterConfig =
            serde_json::from_str(r#"{"channel":"github","enabled":true,"syncMode":"polling"}"#)
                .unwrap();
        binding.project_hash = project.to_string();
        binding.repo_identifier = repo.to_string();
        binding.custom_api_base = api_base;
        binding.polling.interval_seconds = 10;
        // GitHub App mode parameters to satisfy is_github_app_mode()
        binding.github_app_id = Some("12345".to_string());
        binding.github_app_private_key = Some("test-key".to_string());
        crate::git_adapter::save_binding(binding);

        let home = crate::tests::ScopedChatHome::new();
        let state = crate::tests::chat_test_state(&home);

        // 1. First tick on uninitialized repo: receives 304 -> skips baseline seed and clears lingering ETag
        poll_cycle_tick(&state).await;
        assert!(!is_repo_initialized(repo));
        assert_eq!(get_repo_etag(repo), None);

        // 2. Clear last polled timestamp and pre-seed baseline
        if let Ok(mut lock) = get_last_polled_cache().lock() {
            lock.remove(&repo.to_lowercase());
        }
        update_repo_etag(repo, Some("W/\"304-tag\"".to_string()));
        check_and_update_pr_sha(repo, 1, "sha-existing-1");
        assert!(is_repo_initialized(repo));

        // 3. Second tick: Returns 304 with same ETag -> Preserves state, no review triggered
        poll_cycle_tick(&state).await;
        assert_eq!(get_repo_etag(repo).as_deref(), Some("W/\"304-tag\""));
        assert!(!check_and_update_pr_sha(repo, 1, "sha-existing-1"));
        assert!(get_repo_last_polled(repo) > 0);

        // 4. Clear last polled timestamp to allow third tick immediately
        if let Ok(mut lock) = get_last_polled_cache().lock() {
            lock.remove(&repo.to_lowercase());
        }

        // Third tick: Platform returns 304 with rotated ETag -> updates cached ETag
        poll_cycle_tick(&state).await;
        assert_eq!(
            get_repo_etag(repo).as_deref(),
            Some("W/\"rotated-etag-v2\"")
        );
        assert!(!check_and_update_pr_sha(repo, 1, "sha-existing-1"));

        crate::git_adapter::disable_binding_for_project(project);
        let _ = shutdown_tx.send(());
        let _ = server_task.await;
    }

    #[test]
    #[serial_test::serial]
    fn test_record_poll_results_atomic_persists_etag_and_shas_together() {
        let repo = "test-owner/test-atomic-persistence";
        assert_eq!(get_repo_etag(repo), None);

        let event1 = NormalizedGitEvent {
            platform: "github".to_string(),
            event_kind: GitEventKind::PullRequestOpened,
            repo_full_name: repo.to_string(),
            is_pull_request: true,
            issue_or_pr_number: Some(101),
            sender: GitUserMeta::default(),
            commit_author: None,
            title: Some("PR 101".into()),
            body_text: None,
            comment_id: None,
            head_sha: Some("sha-101-v1".into()),
            base_branch: None,
            head_branch: None,
            html_url: None,
            raw_payload: serde_json::Value::Null,
        };
        let event2 = NormalizedGitEvent {
            platform: "github".to_string(),
            event_kind: GitEventKind::PullRequestOpened,
            repo_full_name: repo.to_string(),
            is_pull_request: true,
            issue_or_pr_number: Some(102),
            sender: GitUserMeta::default(),
            commit_author: None,
            title: Some("PR 102".into()),
            body_text: None,
            comment_id: None,
            head_sha: Some("sha-102-v1".into()),
            base_branch: None,
            head_branch: None,
            html_url: None,
            raw_payload: serde_json::Value::Null,
        };

        // 1. Initial atomic recording with auto_review_new_pr = true
        let to_review = record_poll_results_atomic(
            repo,
            &[event1.clone(), event2.clone()],
            Some("etag-v1".to_string()),
            true,
        );
        assert_eq!(to_review.len(), 2);
        assert_eq!(get_repo_etag(repo).as_deref(), Some("etag-v1"));
        assert!(is_repo_initialized(repo));

        // SHA deduplication: both SHAs are now recorded
        assert!(!check_and_update_pr_sha(repo, 101, "sha-101-v1"));
        assert!(!check_and_update_pr_sha(repo, 102, "sha-102-v1"));

        // 2. Subsequent poll with no new PRs and same ETag returns 0 to_review
        let to_review_repeat = record_poll_results_atomic(
            repo,
            &[event1.clone(), event2.clone()],
            Some("etag-v1".to_string()),
            true,
        );
        assert_eq!(to_review_repeat.len(), 0);
        assert_eq!(get_repo_etag(repo).as_deref(), Some("etag-v1"));

        // 3. New commit on PR 101 with auto_review_new_pr = false
        let mut event1_updated = event1.clone();
        event1_updated.head_sha = Some("sha-101-v2".into());
        let to_review_disabled = record_poll_results_atomic(
            repo,
            &[event1_updated.clone()],
            Some("etag-v2".to_string()),
            false,
        );
        // Returns 0 events to review because review is disabled, but updates head_sha
        assert_eq!(to_review_disabled.len(), 0);
        assert_eq!(get_repo_etag(repo).as_deref(), Some("etag-v2"));
        assert!(!check_and_update_pr_sha(repo, 101, "sha-101-v2"));
    }

    #[test]
    #[serial_test::serial]
    fn test_record_poll_results_atomic_clears_etag_on_200_without_etag() {
        let repo = "test-owner/test-clear-etag-repo";

        // Seed with initial ETag
        update_repo_etag(repo, Some("lingering-etag".to_string()));
        assert_eq!(get_repo_etag(repo).as_deref(), Some("lingering-etag"));

        // 200 response with None ETag explicitly clears the cached ETag
        let _ = record_poll_results_atomic(repo, &[], None, true);
        assert_eq!(get_repo_etag(repo), None);

        // Also verify whitespace-only ETag clears it
        update_repo_etag(repo, Some("lingering-etag-2".to_string()));
        let _ = record_poll_results_atomic(repo, &[], Some("   ".to_string()), true);
        assert_eq!(get_repo_etag(repo), None);
    }
}
