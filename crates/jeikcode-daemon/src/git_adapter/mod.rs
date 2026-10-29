//! Multi-platform Git adapter architecture (GitHub, GitLab, Gitee, Gitea, Custom Git).
//!
//! Provides normalized abstractions for events, project bindings, security verification,
//! and platform-agnostic API operations.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub mod gitee;
pub mod github;
pub mod github_app;
pub mod gitlab;
pub mod polling;

/// 平台渠道枚举
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitPlatformKind {
    Github,
    Gitlab,
    Gitee,
    Gitea,
    CustomGit,
    #[serde(untagged)]
    Other(String),
}

impl GitPlatformKind {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Github => "github",
            Self::Gitlab => "gitlab",
            Self::Gitee => "gitee",
            Self::Gitea => "gitea",
            Self::CustomGit => "custom_git",
            Self::Other(s) => s.as_str(),
        }
    }
}

/// 同步监听模式：Webhook 回调 vs 主动轮询
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum GitSyncMode {
    #[default]
    Webhook,
    Polling,
}

/// 归一化事件类型
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitEventKind {
    PullRequestOpened,
    PullRequestSynchronize,
    IssueCommentCreated,
    Push,
    Ping,
    Unknown(String),
}

/// 统一的用户元数据
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GitUserMeta {
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default = "default_user_type")]
    pub user_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_association: Option<String>,
}

fn default_user_type() -> String {
    "User".to_string()
}

/// 归一化的平台事件模型（全量保留原始负载，并结构化提炼核心要素）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedGitEvent {
    pub platform: String,
    pub event_kind: GitEventKind,
    pub repo_full_name: String,
    pub is_pull_request: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue_or_pr_number: Option<u64>,
    pub sender: GitUserMeta,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_author: Option<GitUserMeta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_branch: Option<String>,
    /// PR 或 Issue 的 Web 访问链接（可从 Payload 提取或根据仓库/编号推导）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html_url: Option<String>,
    /// 完整保留的原始 JSON Payload，支持随时提取任意未知字段
    pub raw_payload: serde_json::Value,
}

impl NormalizedGitEvent {
    /// 解析或智能推导 PR/Issue 的完整 Web 访问 URL，避免 Agent 猜测
    pub fn resolve_html_url(&self) -> String {
        if let Some(ref url) = self.html_url {
            if !url.trim().is_empty() {
                return url.clone();
            }
        }
        let number = self.issue_or_pr_number.unwrap_or(1);
        let repo = &self.repo_full_name;
        match self.platform.as_str() {
            "gitlab" => {
                let sub = if self.is_pull_request {
                    "merge_requests"
                } else {
                    "issues"
                };
                format!("https://gitlab.com/{repo}/-/{sub}/{number}")
            }
            "gitee" => {
                let sub = if self.is_pull_request {
                    "pulls"
                } else {
                    "issues"
                };
                format!("https://gitee.com/{repo}/{sub}/{number}")
            }
            "gitea" => {
                let sub = if self.is_pull_request {
                    "pulls"
                } else {
                    "issues"
                };
                format!("https://gitea.com/{repo}/{sub}/{number}")
            }
            _ => {
                // 默认 GitHub 格式
                let sub = if self.is_pull_request {
                    "pull"
                } else {
                    "issues"
                };
                format!("https://github.com/{repo}/{sub}/{number}")
            }
        }
    }
}

/// 订阅事件开关集合
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribedEvents {
    #[serde(default = "default_true", alias = "pull_request")]
    pub pull_request: bool,
    #[serde(default = "default_true", alias = "issue_comment")]
    pub issue_comment: bool,
    #[serde(default)]
    pub push: bool,
}

impl Default for SubscribedEvents {
    fn default() -> Self {
        Self {
            pull_request: true,
            issue_comment: true,
            push: false,
        }
    }
}

fn default_true() -> bool {
    true
}

/// Webhook 专用配置
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookConfig {
    #[serde(default, alias = "payload_url")]
    pub payload_url: String,
    #[serde(default)]
    pub secret: String,
}

/// 轮询专用配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PollingConfig {
    #[serde(default = "default_interval", alias = "interval_seconds")]
    pub interval_seconds: u32,
    #[serde(default = "default_true", alias = "only_active_pr")]
    pub only_active_pr: bool,
}

impl Default for PollingConfig {
    fn default() -> Self {
        Self {
            interval_seconds: 60,
            only_active_pr: true,
        }
    }
}

fn default_interval() -> u32 {
    60
}

/// 项目绑定的 Git 平台适配器配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAdapterConfig {
    #[serde(default, alias = "project_hash")]
    pub project_hash: String,
    /// 是否开启此项目的自动化代码审查与联动（默认关闭）
    #[serde(default)]
    pub enabled: bool,
    /// 记录项目被移除前最后一次手动勾选的启用状态，供下次重新添加回列表时自动恢复
    #[serde(default, alias = "last_enabled_state")]
    pub last_enabled_state: bool,
    #[serde(default)]
    pub channel: String,
    #[serde(default, alias = "sync_mode")]
    pub sync_mode: GitSyncMode,
    #[serde(default, alias = "repo_identifier", alias = "repoFullName")]
    pub repo_identifier: String,
    #[serde(default, alias = "access_token", alias = "githubPat")]
    pub access_token: String,
    #[serde(default, alias = "custom_api_base")]
    pub custom_api_base: String,
    #[serde(default)]
    pub webhook: WebhookConfig,
    #[serde(default)]
    pub polling: PollingConfig,
    #[serde(default)]
    pub events: SubscribedEvents,
    #[serde(default = "default_keyword", alias = "trigger_keyword")]
    pub trigger_keyword: String,
    #[serde(default = "default_true", alias = "auto_review_new_pr")]
    pub auto_review_new_pr: bool,
    #[serde(default = "default_true", alias = "update_existing_comment")]
    pub update_existing_comment: bool,
    #[serde(default, alias = "review_prompt_template")]
    pub review_prompt_template: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "review_model"
    )]
    pub review_model: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "github_app_id"
    )]
    pub github_app_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "github_app_private_key"
    )]
    pub github_app_private_key: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "github_app_private_key_path"
    )]
    pub github_app_private_key_path: Option<String>,
    /// 记录当前 GitHub App 令牌的过期时间戳（UNIX 秒），持久化到磁盘，跨重启自动避开重复换发
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "token_expires_at"
    )]
    pub token_expires_at: Option<u64>,
}

impl GitAdapterConfig {
    /// 检查当前配置是否为合法的 GitHub App 模式。
    /// 目前仅 GitHub App 模式允许启用自动化审查，PAT 模式已被强制永久禁用。
    pub fn is_github_app_mode(&self) -> bool {
        if self.channel.to_lowercase().trim() != "github" {
            return false;
        }
        let has_app_id = self
            .github_app_id
            .as_deref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        let has_key = self
            .github_app_private_key
            .as_deref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
            || self
                .github_app_private_key_path
                .as_deref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
        has_app_id && has_key
    }

    /// 规范化与安全约束：如果启用了但不是 GitHub App 模式（即使用了 PAT 模式），强制禁用
    pub fn sanitize_security_constraints(&mut self) {
        if self.enabled && !self.is_github_app_mode() {
            tracing::warn!(
                "[git_adapter] Project `{}` attempted to enable automation in PAT mode (channel: `{}`). Forcibly disabling per security policy.",
                self.project_hash,
                self.channel
            );
            self.enabled = false;
            self.last_enabled_state = false;
        }
    }
}

fn default_keyword() -> String {
    "@bot".to_string()
}

/// 解析配置的唤醒词列表（支持中英文逗号、中英文竖线（全半角）及换行符分隔，任选其一均可触发）
pub fn extract_trigger_keywords(raw: &str) -> Vec<&str> {
    raw.split([',', '，', '|', '｜', '\n', '\r'])
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect()
}

/// 检查评论内容是否命中了配置的任意一个唤醒词
pub fn comment_matches_trigger_keywords(body: &str, raw_keywords: &str) -> bool {
    let keywords = extract_trigger_keywords(raw_keywords);
    if keywords.is_empty() {
        return true;
    }

    let body_lower = body.to_lowercase();
    keywords
        .into_iter()
        .any(|kw| body.contains(kw) || body_lower.contains(&kw.to_lowercase()))
}

/// 统一 Git 平台适配器 Trait（多平台扩展规范）
#[async_trait::async_trait]
pub trait GitPlatformAdapter: Send + Sync {
    /// 平台唯一标识符
    fn platform_id(&self) -> &'static str;

    /// 校验 Webhook 请求签名
    fn verify_signature(&self, secret: &str, headers: &HeaderMap, body_bytes: &[u8]) -> bool;

    /// 解析原始请求为标准化事件
    fn parse_event(
        &self,
        headers: &HeaderMap,
        payload: serde_json::Value,
    ) -> Result<Option<NormalizedGitEvent>, String>;

    /// 在 PR/Issue 下发表一条新评论，返回创建的评论 ID
    async fn post_comment(
        &self,
        token: &str,
        api_base: Option<&str>,
        repo: &str,
        number: u64,
        body: &str,
    ) -> Result<u64, String>;

    /// 覆盖更新一条已有评论（看板模式）
    async fn update_comment(
        &self,
        token: &str,
        api_base: Option<&str>,
        repo: &str,
        comment_id: u64,
        target_number: Option<u64>,
        body: &str,
    ) -> Result<(), String>;

    /// 查找 Bot 之前在该 PR 下发表过的主评论 ID（用于看板更新判定）
    async fn find_bot_primary_comment(
        &self,
        token: &str,
        api_base: Option<&str>,
        repo: &str,
        number: u64,
    ) -> Result<Option<u64>, String>;

    /// 校验 Token 与远程仓库连通性及权限
    async fn test_connection(
        &self,
        token: &str,
        api_base: Option<&str>,
        repo: &str,
    ) -> Result<String, String>;

    /// 查询活跃的 Pull Request / Merge Request 列表，支持携带 If-None-Match 条件标头（轮询模式规范方法）。
    /// 所有平台适配器均需实现此方法。若平台不支持 ETag 或未返回 ETag，直接返回 `etag: None, not_modified: false` 即可。
    async fn fetch_active_pull_requests_with_etag(
        &self,
        token: &str,
        api_base: Option<&str>,
        repo: &str,
        etag: Option<&str>,
    ) -> Result<PollPullRequestsOutput, String>;

    /// 查询活跃的 Pull Request / Merge Request 列表（向后兼容/测试调用便捷方法）。
    /// 默认实现自动委托至规范方法 `fetch_active_pull_requests_with_etag(token, api_base, repo, None)` 并提取事件列表。
    async fn fetch_active_pull_requests(
        &self,
        token: &str,
        api_base: Option<&str>,
        repo: &str,
    ) -> Result<Vec<NormalizedGitEvent>, String> {
        Ok(self
            .fetch_active_pull_requests_with_etag(token, api_base, repo, None)
            .await?
            .events)
    }
}

/// 轮询拉取活跃 PR/MR 输出结构体，携带 ETag 与 304 缓存状态
#[derive(Debug, Clone, Default)]
pub struct PollPullRequestsOutput {
    /// 标准化 PR 事件列表（若 304 Not Modified 则为空列表）
    pub events: Vec<NormalizedGitEvent>,
    /// 平台响应返回的最新 ETag 标头
    pub etag: Option<String>,
    /// 是否命中 HTTP 304 Not Modified 缓存（零配额消耗）
    pub not_modified: bool,
}

/// 根据平台渠道标识获取对应平台适配器驱动
pub fn get_platform_adapter(channel: &str) -> Arc<dyn GitPlatformAdapter> {
    match channel.to_lowercase().trim() {
        "gitlab" => Arc::new(gitlab::GitLabAdapter::new()),
        "gitee" => Arc::new(gitee::GiteeAdapter::new()),
        _ => Arc::new(github::GitHubAdapter::new()),
    }
}

/// 标准 RFC 2104 HMAC-SHA256 计算实现（纯 sha2 依赖，零外部新增 crate）
pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut k_block = [0u8; 64];
    if key.len() > 64 {
        let hash = Sha256::digest(key);
        k_block[..32].copy_from_slice(&hash);
    } else {
        k_block[..key.len()].copy_from_slice(key);
    }

    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= k_block[i];
        opad[i] ^= k_block[i];
    }

    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(data);
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_hash);
    outer.finalize().into()
}

/// 十六进制字节编码
pub fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", b);
    }
    s
}

/// 恒定时间比较两个字节串（防时序侧信道攻击）
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut res = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        res |= x ^ y;
    }
    res == 0
}

// ============================================================================
// 项目绑定配置本地存储 (`~/.jeikcode/git-bindings.json`)
// ============================================================================

fn bindings_file_path() -> PathBuf {
    let root = jeikcode_capabilities::session::SessionManager::sessions_root();
    root.parent()
        .map(|dir| dir.join("git-bindings.json"))
        .unwrap_or_else(|| PathBuf::from("git-bindings.json"))
}

static BINDINGS_CACHE: OnceLock<Mutex<HashMap<String, GitAdapterConfig>>> = OnceLock::new();

fn get_cache() -> &'static Mutex<HashMap<String, GitAdapterConfig>> {
    BINDINGS_CACHE.get_or_init(|| {
        let map = load_from_disk();
        Mutex::new(map)
    })
}

fn load_from_disk() -> HashMap<String, GitAdapterConfig> {
    let path = bindings_file_path();
    let Ok(bytes) = std::fs::read(&path) else {
        return HashMap::new();
    };
    let mut map: HashMap<String, GitAdapterConfig> =
        serde_json::from_slice(&bytes).unwrap_or_default();
    let mut modified = false;
    for cfg in map.values_mut() {
        if cfg.enabled && !cfg.is_github_app_mode() {
            tracing::warn!(
                "[git_adapter] Forcibly disabling project `{}` which was previously enabled with PAT mode",
                cfg.project_hash
            );
            cfg.enabled = false;
            cfg.last_enabled_state = false;
            modified = true;
        }
    }
    if modified {
        save_to_disk(&map);
    }
    map
}

fn save_to_disk(map: &HashMap<String, GitAdapterConfig>) {
    let path = bindings_file_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(map) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

/// 获取指定项目的 Git 绑定配置
pub fn get_binding_by_project(project_hash: &str) -> Option<GitAdapterConfig> {
    let lock = get_cache().lock().ok()?;
    lock.get(project_hash).cloned()
}

/// 根据仓库全名（例如 "owner/repo"）查找关联的项目绑定配置
pub fn find_binding_by_repo(repo_full_name: &str) -> Option<GitAdapterConfig> {
    let lock = get_cache().lock().ok()?;
    let normalized = repo_full_name.trim().to_lowercase();
    for config in lock.values() {
        if config.repo_identifier.trim().to_lowercase() == normalized {
            return Some(config.clone());
        }
    }
    None
}

/// 保存或更新项目绑定配置
pub fn save_binding(mut config: GitAdapterConfig) {
    if config.project_hash.is_empty() {
        return;
    }
    // 强制执行安全策略：PAT 模式一律强制禁用
    config.sanitize_security_constraints();
    if let Ok(mut lock) = get_cache().lock() {
        lock.insert(config.project_hash.clone(), config);
        save_to_disk(&lock);
    }
}

/// 当项目从侧边栏列表中移除时调用：自动将启用状态设为 false，但记住 last_enabled_state
pub fn disable_binding_for_project(project_hash: &str) {
    if let Ok(mut lock) = get_cache().lock() {
        if let Some(cfg) = lock.get_mut(project_hash) {
            if cfg.enabled {
                cfg.last_enabled_state = true;
                cfg.enabled = false;
                save_to_disk(&lock);
            }
        }
    }
}

/// 当项目重新添加回侧边栏时调用：自动恢复项目上次自动关闭前的最后一次勾选状态
pub fn restore_binding_for_project(project_hash: &str) {
    if let Ok(mut lock) = get_cache().lock() {
        if let Some(cfg) = lock.get_mut(project_hash) {
            // 仅在合法 GitHub App 模式下才允许恢复启用
            if cfg.last_enabled_state && !cfg.enabled && cfg.is_github_app_mode() {
                cfg.enabled = true;
                save_to_disk(&lock);
            }
        }
    }
}

/// 获取所有已配置的项目 Git 绑定
pub fn get_all_bindings() -> Vec<GitAdapterConfig> {
    let Ok(lock) = get_cache().lock() else {
        return Vec::new();
    };
    lock.values().cloned().collect()
}

/// 检查系统中是否存在任何处于开启状态且配置为合法 GitHub App 模式的项目
pub fn is_any_git_automation_active() -> bool {
    let Ok(lock) = get_cache().lock() else {
        return false;
    };
    lock.values().any(|c| c.enabled && c.is_github_app_mode())
}

/// 解析 GitHub App 私钥内容：优先使用内联私钥，其次退回从私钥文件路径读取。
fn resolve_github_app_pem(config: &GitAdapterConfig) -> Option<String> {
    if let Some(content) = config
        .github_app_private_key
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        return Some(content.to_string());
    }
    config
        .github_app_private_key_path
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .and_then(|path| std::fs::read_to_string(path.trim()).ok())
}

/// 确保 GitHub App 安装令牌新鲜有效，返回可直接用于 API 调用的令牌。
///
/// - 非 `github` 渠道、缺少 App 凭据、或已持有 5 分钟内不过期的令牌时，原样返回现有令牌；
/// - 令牌缺失或临近过期时，使用 App 凭据换取新令牌，并同步持久化到绑定存储，
///   供后续轮询 / Webhook 请求及进程重启后直接复用。
///
/// 纯轮询（NAT / 无 Webhook 穿透）场景下安装令牌约 1 小时过期，若无人主动换发，
/// 长跑守护进程会在过期后持续 401 直至重启。该函数保证后台轮询始终携带有效令牌。
pub async fn ensure_fresh_github_app_token(config: &GitAdapterConfig) -> String {
    let existing = config.access_token.trim().to_string();

    // 仅 GitHub 渠道支持 App 安装令牌轮换
    if config.channel.to_lowercase().trim() != "github" {
        return existing;
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // 令牌距过期仍超过 5 分钟，直接复用（纯内存判断，零网络 / 磁盘开销）
    if !existing.is_empty() && config.token_expires_at.is_some_and(|exp| now + 300 < exp) {
        return existing;
    }

    let Some(app_id) = config
        .github_app_id
        .as_deref()
        .and_then(|s| s.trim().parse::<u64>().ok())
    else {
        return existing;
    };
    let Some(pem) = resolve_github_app_pem(config) else {
        return existing;
    };

    match github_app::fetch_installation_token(app_id, &pem, &config.repo_identifier).await {
        Ok((fresh_token, _)) => {
            // 同步持久化新令牌与过期时间，避免每个请求重复换签
            if let Some(mut binding) = get_binding_by_project(&config.project_hash) {
                binding.access_token = fresh_token.clone();
                binding.token_expires_at = Some(now + 3300);
                binding.github_app_id = Some(app_id.to_string());
                if let Some(path) = config
                    .github_app_private_key_path
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                {
                    binding.github_app_private_key_path = Some(path.to_string());
                }
                save_binding(binding);
            }
            fresh_token
        }
        Err(e) => {
            tracing::warn!(
                "[git_adapter] GitHub App installation token refresh failed for `{}`: {e}",
                config.project_hash
            );
            existing
        }
    }
}

static SHARED_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// 获取 Git 适配器共享的 HTTP 连接池客户端（15s 超时，TLS 连接复用）
pub fn shared_http_client() -> &'static reqwest::Client {
    SHARED_HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .pool_idle_timeout(std::time::Duration::from_secs(90))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// 解析 HTTP 响应头中的 Retry-After（支持 delta-seconds 纯整数秒与 RFC 7231 HTTP-date 绝对时间戳）
pub fn parse_retry_after_header(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let val = headers.get("retry-after")?.to_str().ok()?.trim();
    if let Ok(secs) = val.parse::<u64>() {
        return Some(secs);
    }
    if let Ok(system_time) = httpdate::parse_http_date(val) {
        let now = std::time::SystemTime::now();
        if let Ok(duration) = system_time.duration_since(now) {
            return Some(duration.as_secs());
        } else {
            return Some(0);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rfc4231_hmac_sha256_vector() {
        // RFC 4231 Test Case 2: key = "Jefe", data = "what do ya want for nothing?"
        let key = b"Jefe";
        let data = b"what do ya want for nothing?";
        let hmac = hmac_sha256(key, data);
        let hex_str = to_hex(&hmac);
        assert_eq!(
            hex_str,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn test_constant_time_eq_semantics() {
        assert!(constant_time_eq(b"hello", b"hello"));
        assert!(!constant_time_eq(b"hello", b"hellp"));
        assert!(!constant_time_eq(b"hello", b"hello world"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn test_normalized_event_resolve_html_url() {
        let mut event = NormalizedGitEvent {
            platform: "github".to_string(),
            event_kind: GitEventKind::PullRequestOpened,
            repo_full_name: "jeikl/JeikCode".to_string(),
            is_pull_request: true,
            issue_or_pr_number: Some(42),
            sender: GitUserMeta::default(),
            commit_author: None,
            title: Some("Fix".to_string()),
            body_text: None,
            comment_id: None,
            head_sha: None,
            base_branch: None,
            head_branch: None,
            html_url: None,
            raw_payload: serde_json::Value::Null,
        };

        // GitHub derivation
        assert_eq!(
            event.resolve_html_url(),
            "https://github.com/jeikl/JeikCode/pull/42"
        );

        // GitLab derivation
        event.platform = "gitlab".to_string();
        assert_eq!(
            event.resolve_html_url(),
            "https://gitlab.com/jeikl/JeikCode/-/merge_requests/42"
        );

        // Gitee derivation
        event.platform = "gitee".to_string();
        assert_eq!(
            event.resolve_html_url(),
            "https://gitee.com/jeikl/JeikCode/pulls/42"
        );

        // Gitea derivation
        event.platform = "gitea".to_string();
        assert_eq!(
            event.resolve_html_url(),
            "https://gitea.com/jeikl/JeikCode/pulls/42"
        );

        // Explicit URL wins
        event.html_url = Some("https://custom.git.org/pr/99".to_string());
        assert_eq!(event.resolve_html_url(), "https://custom.git.org/pr/99");
    }

    #[test]
    fn test_get_platform_adapter_fallback() {
        let gh = get_platform_adapter("github");
        assert_eq!(gh.platform_id(), "github");

        let gl = get_platform_adapter("gitlab");
        assert_eq!(gl.platform_id(), "gitlab");

        let gt = get_platform_adapter("gitee");
        assert_eq!(gt.platform_id(), "gitee");

        let default_adapter = get_platform_adapter("custom");
        assert_eq!(default_adapter.platform_id(), "github");
    }

    #[test]
    fn test_extract_and_match_trigger_keywords() {
        // 单个关键词
        assert!(comment_matches_trigger_keywords(
            "hello @bot please review",
            "@bot"
        ));
        assert!(comment_matches_trigger_keywords(
            "hello @BOT please review",
            "@bot"
        ));
        assert!(!comment_matches_trigger_keywords("hello world", "@bot"));

        // 多唤醒词：英文逗号、中文逗号、半角竖线、全角竖线
        let config = "@bot, /review，审查|请协助｜audit";
        let keywords = extract_trigger_keywords(config);
        assert_eq!(keywords, vec!["@bot", "/review", "审查", "请协助", "audit"]);

        // 任选其一触发
        assert!(comment_matches_trigger_keywords("请帮我 @bot 看下", config));
        assert!(comment_matches_trigger_keywords(
            "/review this PR please",
            config
        ));
        assert!(comment_matches_trigger_keywords(
            "麻烦审查一下这个代码",
            config
        ));
        assert!(comment_matches_trigger_keywords("请协助排查问题", config));
        assert!(comment_matches_trigger_keywords("Ready for AUDIT", config));
        assert!(!comment_matches_trigger_keywords(
            "这是一条无关评论",
            config
        ));

        // 空白或未配置默认放行
        assert!(comment_matches_trigger_keywords("any comment", ""));
        assert!(comment_matches_trigger_keywords(
            "any comment",
            "   ,  ， | ｜ "
        ));
    }

    struct MockCanonicalAdapter;

    #[async_trait::async_trait]
    impl GitPlatformAdapter for MockCanonicalAdapter {
        fn platform_id(&self) -> &'static str {
            "canonical_mock"
        }
        fn verify_signature(
            &self,
            _secret: &str,
            _headers: &HeaderMap,
            _body_bytes: &[u8],
        ) -> bool {
            true
        }
        fn parse_event(
            &self,
            _headers: &HeaderMap,
            _payload: serde_json::Value,
        ) -> Result<Option<NormalizedGitEvent>, String> {
            Ok(None)
        }
        async fn post_comment(
            &self,
            _token: &str,
            _api_base: Option<&str>,
            _repo: &str,
            _number: u64,
            _body: &str,
        ) -> Result<u64, String> {
            Ok(1)
        }
        async fn update_comment(
            &self,
            _token: &str,
            _api_base: Option<&str>,
            _repo: &str,
            _comment_id: u64,
            _target_number: Option<u64>,
            _body: &str,
        ) -> Result<(), String> {
            Ok(())
        }
        async fn find_bot_primary_comment(
            &self,
            _token: &str,
            _api_base: Option<&str>,
            _repo: &str,
            _number: u64,
        ) -> Result<Option<u64>, String> {
            Ok(None)
        }
        async fn test_connection(
            &self,
            _token: &str,
            _api_base: Option<&str>,
            _repo: &str,
        ) -> Result<String, String> {
            Ok("ok".to_string())
        }
        async fn fetch_active_pull_requests_with_etag(
            &self,
            _token: &str,
            _api_base: Option<&str>,
            _repo: &str,
            _etag: Option<&str>,
        ) -> Result<PollPullRequestsOutput, String> {
            Ok(PollPullRequestsOutput {
                events: vec![NormalizedGitEvent {
                    platform: "canonical_mock".to_string(),
                    event_kind: GitEventKind::PullRequestOpened,
                    repo_full_name: "test/canonical".to_string(),
                    is_pull_request: true,
                    issue_or_pr_number: Some(123),
                    sender: GitUserMeta::default(),
                    commit_author: None,
                    title: Some("Canonical PR".to_string()),
                    body_text: None,
                    comment_id: None,
                    head_sha: Some("sha-canonical".to_string()),
                    base_branch: None,
                    head_branch: None,
                    html_url: None,
                    raw_payload: serde_json::Value::Null,
                }],
                etag: Some("mock-etag-123".to_string()),
                not_modified: false,
            })
        }
    }

    #[tokio::test]
    async fn test_fetch_active_pull_requests_delegates_to_with_etag() {
        let adapter = MockCanonicalAdapter;
        let events = adapter
            .fetch_active_pull_requests("token", None, "test/canonical")
            .await
            .expect("fetch success");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].issue_or_pr_number, Some(123));
        assert_eq!(events[0].head_sha.as_deref(), Some("sha-canonical"));
    }

    #[tokio::test]
    async fn test_ensure_fresh_github_app_token_short_circuits_without_network() {
        // 非 github 渠道：原样返回现有令牌
        let mut cfg: GitAdapterConfig =
            serde_json::from_str(r#"{"channel":"gitlab","accessToken":"pat-token"}"#).unwrap();
        assert_eq!(ensure_fresh_github_app_token(&cfg).await, "pat-token");

        // github 渠道但令牌仍在有效期：原样返回，不发起网络请求
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        cfg.channel = "github".to_string();
        cfg.access_token = "gh-token".to_string();
        cfg.token_expires_at = Some(now + 3600);
        assert_eq!(ensure_fresh_github_app_token(&cfg).await, "gh-token");

        // github 渠道 + 令牌缺失且无 App 凭据：退化为现有（空）令牌，不 panic/不阻塞
        cfg.access_token = "".to_string();
        cfg.token_expires_at = Some(0);
        assert_eq!(ensure_fresh_github_app_token(&cfg).await, "");
    }

    #[test]
    fn test_parse_retry_after_header_delta_seconds_and_http_date() {
        use reqwest::header::{HeaderMap, HeaderValue};

        // 1. Delta-seconds
        let mut headers = HeaderMap::new();
        headers.insert("retry-after", HeaderValue::from_static("180"));
        assert_eq!(parse_retry_after_header(&headers), Some(180));

        // 2. Future RFC 7231 HTTP-date
        let future = std::time::SystemTime::now() + std::time::Duration::from_secs(60);
        let date_str = httpdate::fmt_http_date(future);
        let mut headers_date = HeaderMap::new();
        headers_date.insert(
            "retry-after",
            HeaderValue::from_str(&date_str).expect("valid header"),
        );
        let secs = parse_retry_after_header(&headers_date).expect("parsed date");
        assert!((55..=65).contains(&secs), "secs was {secs}");

        // 3. Past HTTP-date -> returns 0
        let past = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        let past_date_str = httpdate::fmt_http_date(past);
        let mut headers_past = HeaderMap::new();
        headers_past.insert(
            "retry-after",
            HeaderValue::from_str(&past_date_str).expect("valid header"),
        );
        assert_eq!(parse_retry_after_header(&headers_past), Some(0));
    }
}
