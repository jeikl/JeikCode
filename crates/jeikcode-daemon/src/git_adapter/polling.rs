//! Background Git Platform Polling Engine.
//!
//! Provides proactive monitoring and automated PR reviews for local and enterprise
//! environments behind firewalls/NAT where incoming Webhooks cannot reach the daemon.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::{get_all_bindings, get_platform_adapter, GitSyncMode};
use crate::api_git_webhook::execute_git_workflow;
use crate::AppState;

/// 单个仓库的轮询同步状态
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RepoPollState {
    /// 上次轮询时间戳 (Unix 时间戳，秒)
    #[serde(default)]
    pub last_polled_at: u64,
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
    save_poll_state_to_disk(&lock);
    true
}

/// 标记仓库轮询时间
pub fn mark_repo_polled(repo: &str) {
    let normalized_repo = repo.trim().to_lowercase();
    if let Ok(mut lock) = get_state_cache().lock() {
        let repo_state = lock
            .repos
            .entry(normalized_repo)
            .or_insert_with(RepoPollState::default);
        repo_state.last_polled_at = current_epoch_secs();
        save_poll_state_to_disk(&lock);
    }
}

/// 获取指定仓库上次轮询时间
pub fn get_repo_last_polled(repo: &str) -> u64 {
    let normalized_repo = repo.trim().to_lowercase();
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
    let bindings = get_all_bindings();
    let now = current_epoch_secs();

    for config in bindings {
        // 仅处理配置为主动轮询模式的绑定
        if config.sync_mode != GitSyncMode::Polling {
            continue;
        }

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

        tracing::debug!(
            "[git_polling] Polling open PRs for `{repo}` on platform `{}`",
            adapter.platform_id()
        );

        match adapter
            .fetch_active_pull_requests(&config.access_token, custom_api_base, repo)
            .await
        {
            Ok(events) => {
                for event in events {
                    let Some(pr_number) = event.issue_or_pr_number else {
                        continue;
                    };
                    let Some(ref head_sha) = event.head_sha else {
                        continue;
                    };

                    // 检查新 PR 自动审查开关
                    if !config.auto_review_new_pr {
                        // 记录已知 head_sha，避免后续开关打开时重复触发过往历史
                        check_and_update_pr_sha(repo, pr_number, head_sha);
                        continue;
                    }

                    // 去重判定：仅在检测到全新 PR 或 head commit sha 变动时触发审查
                    let is_new_or_updated = check_and_update_pr_sha(repo, pr_number, head_sha);
                    if is_new_or_updated {
                        tracing::info!(
                            "[git_polling] Detected new/updated PR #{pr_number} in `{repo}` (SHA: {head_sha}). Dispatching review workflow."
                        );
                        let state_clone = state.clone();
                        let adapter_clone = adapter.clone();
                        let config_clone = config.clone();
                        tokio::spawn(async move {
                            if let Err(e) = execute_git_workflow(
                                state_clone,
                                adapter_clone,
                                config_clone,
                                event,
                            )
                            .await
                            {
                                tracing::error!(
                                    "[git_polling] Automated review execution failed: {e}"
                                );
                            }
                        });
                    }
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
            poll_cycle_tick(&state).await;
            tokio::time::sleep(tokio::time::Duration::from_secs(15)).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
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
}
