use anyhow::Result;
use axum::{
    extract::Query,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tokio::io::AsyncWriteExt;

use crate::AppState;
use jeikcode_coding::config_sync::{
    apply_selected_diffs, get_last_seen_version, scan_jeikcode_config_diffs, set_last_seen_version,
    ConfigDiffItem,
};
use jeikcode_config::config::Config;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UpdateCheckResponse {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub is_desktop: bool,
    pub release_notes: Option<String>,
    pub download_url: Option<String>,
    pub released_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UpdateStatus {
    /// "idle" | "downloading" | "ready" | "installing" | "done" | "error"
    pub status: String,
    pub progress: u32,
    pub bytes: u64,
    pub total: u64,
    pub error: Option<String>,
}

static CURRENT_UPDATE_STATUS: Mutex<Option<UpdateStatus>> = Mutex::new(None);
static IS_UPDATING: AtomicBool = AtomicBool::new(false);

fn get_update_status() -> UpdateStatus {
    CURRENT_UPDATE_STATUS
        .lock()
        .unwrap()
        .clone()
        .unwrap_or(UpdateStatus {
            status: "idle".to_string(),
            progress: 0,
            bytes: 0,
            total: 0,
            error: None,
        })
}

fn set_update_status(status: UpdateStatus) {
    *CURRENT_UPDATE_STATUS.lock().unwrap() = Some(status);
}

/// 比较版本号：latest 是否高于 current
pub fn is_newer_version(latest: &str, current: &str) -> bool {
    let clean_l = latest.trim().trim_start_matches('v').trim_start_matches('V');
    let clean_c = current.trim().trim_start_matches('v').trim_start_matches('V');

    let parse_nums = |s: &str| -> Vec<u64> {
        let main_part = s.split('-').next().unwrap_or(s);
        main_part
            .split('.')
            .map(|seg| seg.parse::<u64>().unwrap_or(0))
            .collect()
    };

    let l_nums = parse_nums(clean_l);
    let c_nums = parse_nums(clean_c);

    let max_len = l_nums.len().max(c_nums.len());
    for i in 0..max_len {
        let l_val = l_nums.get(i).copied().unwrap_or(0);
        let c_val = c_nums.get(i).copied().unwrap_or(0);
        if l_val > c_val {
            return true;
        } else if l_val < c_val {
            return false;
        }
    }

    false
}

/// 探测当前是否在桌面端环境
pub fn is_desktop_environment() -> bool {
    std::env::var("JEIKCODE_DESKTOP").is_ok()
}

/// 解析桌面安装包候选下载地址
async fn resolve_desktop_installer_url(version: &str) -> Option<String> {
    let tag = if version.starts_with('v') || version.starts_with('V') {
        version.to_string()
    } else {
        format!("v{version}")
    };
    let clean_ver = tag.trim_start_matches('v').trim_start_matches('V');

    // 优先尝试通过 GitHub API 查找 release assets 列表中的安装包
    let api_url = format!("https://api.github.com/repos/jeikl/JeikCode/releases/tags/{tag}");
    let client = reqwest::Client::builder()
        .user_agent(concat!("jeikcode/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()?;

    if let Ok(resp) = client.get(&api_url).send().await {
        if resp.status().is_success() {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(assets) = json.get("assets").and_then(|a| a.as_array()) {
                    #[cfg(target_os = "windows")]
                    let predicate = |name: &str| -> bool {
                        let lower = name.to_lowercase();
                        lower.ends_with(".exe") && (lower.contains("setup") || lower.contains("desktop"))
                    };
                    #[cfg(target_os = "macos")]
                    let predicate = |name: &str| -> bool {
                        name.to_lowercase().ends_with(".dmg")
                    };
                    #[cfg(target_os = "linux")]
                    let predicate = |name: &str| -> bool {
                        let lower = name.to_lowercase();
                        lower.ends_with(".appimage") || lower.ends_with(".deb")
                    };
                    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
                    let predicate = |_: &str| false;

                    for asset in assets {
                        if let (Some(name), Some(url)) = (
                            asset.get("name").and_then(|n| n.as_str()),
                            asset.get("browser_download_url").and_then(|u| u.as_str()),
                        ) {
                            if predicate(name) {
                                return Some(url.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    // 后备方案：使用标准发布产物命名约定
    #[cfg(target_os = "windows")]
    {
        Some(format!(
            "https://github.com/jeikl/JeikCode/releases/download/{tag}/JeikCode.Desktop_{clean_ver}_x64-setup.exe"
        ))
    }
    #[cfg(target_os = "macos")]
    {
        Some(format!(
            "https://github.com/jeikl/JeikCode/releases/download/{tag}/JeikCode.Desktop_{clean_ver}_aarch64.dmg"
        ))
    }
    #[cfg(target_os = "linux")]
    {
        Some(format!(
            "https://github.com/jeikl/JeikCode/releases/download/{tag}/JeikCode.Desktop_{clean_ver}_amd64.AppImage"
        ))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

/// GET /api/update/check
pub async fn check_update() -> impl IntoResponse {
    let current_version = format!("v{}", env!("CARGO_PKG_VERSION"));
    let is_desktop = is_desktop_environment();

    let manifest = match jeikcode_updater::fetch_manifest().await {
        Ok(m) => m,
        Err(_e) => {
            return Json(UpdateCheckResponse {
                current_version,
                latest_version: String::new(),
                has_update: false,
                is_desktop,
                release_notes: None,
                download_url: None,
                released_at: None,
            });
        }
    };

    let latest_version = manifest.version.clone();
    let has_update = is_newer_version(&latest_version, &current_version);

    let mut download_url = None;
    if has_update {
        if is_desktop {
            download_url = resolve_desktop_installer_url(&latest_version).await;
        } else if let Some(target) = jeikcode_updater::detect_target() {
            download_url = Some(jeikcode_updater::binary_url(&latest_version, target));
        }
    }

    Json(UpdateCheckResponse {
        current_version,
        latest_version,
        has_update,
        is_desktop,
        release_notes: None,
        download_url,
        released_at: manifest.released_at,
    })
}

/// GET /api/update/status
pub async fn get_status() -> impl IntoResponse {
    Json(get_update_status())
}

/// POST /api/update/execute
pub async fn execute_update() -> impl IntoResponse {
    if IS_UPDATING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Json(serde_json::json!({
            "success": false,
            "message": "更新任务正在执行中，请勿重复发起"
        }));
    }

    let is_desktop = is_desktop_environment();

    tokio::spawn(async move {
        set_update_status(UpdateStatus {
            status: "downloading".to_string(),
            progress: 0,
            bytes: 0,
            total: 0,
            error: None,
        });

        if is_desktop {
            // 桌面端流程：下载 Setup 安装包并执行重启安装
            if let Err(e) = run_desktop_update().await {
                set_update_status(UpdateStatus {
                    status: "error".to_string(),
                    progress: 0,
                    bytes: 0,
                    total: 0,
                    error: Some(format!("下载或启动桌面安装包失败: {e}")),
                });
                IS_UPDATING.store(false, Ordering::SeqCst);
            }
        } else {
            // 纯 WebUI / CLI 模式：就地更新二进制
            if let Err(e) = run_cli_update().await {
                set_update_status(UpdateStatus {
                    status: "error".to_string(),
                    progress: 0,
                    bytes: 0,
                    total: 0,
                    error: Some(format!("更新二进制失败: {e}")),
                });
                IS_UPDATING.store(false, Ordering::SeqCst);
            }
        }
    });

    Json(serde_json::json!({
        "success": true,
        "message": "已开始更新流程"
    }))
}

async fn run_desktop_update() -> Result<()> {
    let manifest = jeikcode_updater::fetch_manifest().await?;
    let download_url = resolve_desktop_installer_url(&manifest.version)
        .await
        .ok_or_else(|| anyhow::anyhow!("未找到匹配当前系统的桌面安装包"))?;

    let client = reqwest::Client::builder()
        .user_agent(concat!("jeikcode/", env!("CARGO_PKG_VERSION")))
        .build()?;

    let response = client.get(&download_url).send().await?;
    if !response.status().is_success() {
        anyhow::bail!("下载安装包失败，HTTP 状态码: {}", response.status());
    }

    let total_bytes = response.content_length().unwrap_or(0);
    let temp_dir = std::env::temp_dir();

    #[cfg(target_os = "windows")]
    let installer_filename = format!("JeikCode-Desktop-Setup-{}.exe", manifest.version);
    #[cfg(target_os = "macos")]
    let installer_filename = format!("JeikCode-Desktop-{}.dmg", manifest.version);
    #[cfg(target_os = "linux")]
    let installer_filename = format!("JeikCode-Desktop-{}.AppImage", manifest.version);
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let installer_filename = format!("JeikCode-Desktop-{}", manifest.version);

    let installer_path = temp_dir.join(installer_filename);

    let mut file = tokio::fs::File::create(&installer_path).await?;
    let mut downloaded_bytes: u64 = 0;
    let mut stream = response.bytes_stream();

    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res?;
        file.write_all(&chunk).await?;
        downloaded_bytes += chunk.len() as u64;

        let pct = if total_bytes > 0 {
            ((downloaded_bytes * 100) / total_bytes) as u32
        } else {
            0
        };

        set_update_status(UpdateStatus {
            status: "downloading".to_string(),
            progress: pct.min(100),
            bytes: downloaded_bytes,
            total: total_bytes,
            error: None,
        });
    }

    file.flush().await?;
    drop(file);

    set_update_status(UpdateStatus {
        status: "ready".to_string(),
        progress: 100,
        bytes: downloaded_bytes,
        total: total_bytes,
        error: None,
    });

    // 触发安装包重新安装并退出当前进程
    trigger_installer_and_exit(installer_path).await?;

    Ok(())
}

async fn trigger_installer_and_exit(installer_path: PathBuf) -> Result<()> {
    set_update_status(UpdateStatus {
        status: "installing".to_string(),
        progress: 100,
        bytes: 0,
        total: 0,
        error: None,
    });

    #[cfg(target_os = "windows")]
    {
        // 1. 启动下载好的 setup.exe 安装包
        let _ = std::process::Command::new(&installer_path).spawn();

        // 2. 终止桌面端前端进程 JeikCode Desktop.exe，防止覆盖安装时被文件锁定
        let _ = std::process::Command::new("taskkill")
            .args(&["/F", "/IM", "JeikCode Desktop.exe"])
            .spawn();

        // 3. 延时片刻退出当前后台子进程
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        std::process::exit(0);
    }

    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg(&installer_path)
            .spawn();
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        std::process::exit(0);
    }

    #[cfg(target_os = "linux")]
    {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&installer_path, std::fs::Permissions::from_mode(0o755));
        }
        let _ = std::process::Command::new(&installer_path).spawn();
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        std::process::exit(0);
    }

    #[allow(unreachable_code)]
    Ok(())
}

async fn run_cli_update() -> Result<()> {
    let current_version = format!("v{}", env!("CARGO_PKG_VERSION"));
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<jeikcode_updater::UpgradeEvent>();

    let driver = tokio::spawn(jeikcode_updater::run_upgrade(current_version, false, tx));

    while let Some(ev) = rx.recv().await {
        match ev {
            jeikcode_updater::UpgradeEvent::Downloading { bytes, total } => {
                let pct = if total > 0 {
                    ((bytes * 100) / total) as u32
                } else {
                    0
                };
                set_update_status(UpdateStatus {
                    status: "downloading".to_string(),
                    progress: pct.min(100),
                    bytes,
                    total,
                    error: None,
                });
            }
            jeikcode_updater::UpgradeEvent::Verifying | jeikcode_updater::UpgradeEvent::Replacing => {
                set_update_status(UpdateStatus {
                    status: "installing".to_string(),
                    progress: 99,
                    bytes: 0,
                    total: 0,
                    error: None,
                });
            }
            jeikcode_updater::UpgradeEvent::Done { .. } => {
                set_update_status(UpdateStatus {
                    status: "done".to_string(),
                    progress: 100,
                    bytes: 0,
                    total: 0,
                    error: None,
                });
            }
            jeikcode_updater::UpgradeEvent::Failed(err) => {
                set_update_status(UpdateStatus {
                    status: "error".to_string(),
                    progress: 0,
                    bytes: 0,
                    total: 0,
                    error: Some(err),
                });
            }
            _ => {}
        }
    }

    let _ = driver.await;
    IS_UPDATING.store(false, Ordering::SeqCst);
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// 配置更新多选覆盖 API
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct UpgradeDiffsQuery {
    pub first_launch: Option<bool>,
    pub force: Option<bool>,
}

#[derive(Serialize)]
pub struct UpgradeDiffsResponse {
    pub should_prompt: bool,
    pub current_version: String,
    pub last_seen_version: Option<String>,
    pub diffs: Vec<ConfigDiffItem>,
}

/// GET /api/config/upgrade-diffs
pub async fn get_upgrade_diffs(Query(query): Query<UpgradeDiffsQuery>) -> impl IntoResponse {
    let home = Config::config_dir();
    let current_ver = format!("v{}", env!("CARGO_PKG_VERSION"));
    let last_seen = get_last_seen_version(&home);

    let diffs = scan_jeikcode_config_diffs(&home);

    if diffs.is_empty() {
        // 无差异，自动对齐版本标记
        let _ = set_last_seen_version(&home, &current_ver);
        return Json(UpgradeDiffsResponse {
            should_prompt: false,
            current_version: current_ver,
            last_seen_version: last_seen,
            diffs: Vec::new(),
        });
    }

    let should_prompt = if query.force.unwrap_or(false) {
        true
    } else if query.first_launch.unwrap_or(false) {
        last_seen.as_deref() != Some(&current_ver)
    } else {
        true
    };

    Json(UpgradeDiffsResponse {
        should_prompt,
        current_version: current_ver,
        last_seen_version: last_seen,
        diffs,
    })
}

#[derive(Debug, Deserialize)]
pub struct ApplyDiffsRequest {
    pub selected_paths: Vec<String>,
}

/// POST /api/config/apply-diffs
pub async fn apply_diffs(Json(req): Json<ApplyDiffsRequest>) -> impl IntoResponse {
    let home = Config::config_dir();
    let current_ver = format!("v{}", env!("CARGO_PKG_VERSION"));

    let diffs = scan_jeikcode_config_diffs(&home);
    let selected_items: Vec<ConfigDiffItem> = diffs
        .into_iter()
        .map(|mut it| {
            it.selected = req.selected_paths.contains(&it.relative_path);
            it
        })
        .collect();

    let applied_count = apply_selected_diffs(selected_items);
    let _ = set_last_seen_version(&home, &current_ver);

    Json(serde_json::json!({
        "success": true,
        "applied_count": applied_count,
    }))
}

/// POST /api/config/dismiss-diffs
pub async fn dismiss_diffs() -> impl IntoResponse {
    let home = Config::config_dir();
    let current_ver = format!("v{}", env!("CARGO_PKG_VERSION"));
    let _ = set_last_seen_version(&home, &current_ver);

    Json(serde_json::json!({
        "success": true
    }))
}

/// 注册更新与配置同步路由
pub fn register_update_routes(router: Router<AppState>) -> Router<AppState> {
    router
        .route("/api/update/check", get(check_update))
        .route("/api/update/status", get(get_status))
        .route("/api/update/execute", post(execute_update))
        .route("/api/config/upgrade-diffs", get(get_upgrade_diffs))
        .route("/api/config/apply-diffs", post(apply_diffs))
        .route("/api/config/dismiss-diffs", post(dismiss_diffs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_newer_version() {
        assert!(is_newer_version("v7.1.30", "v7.1.7"));
        assert!(is_newer_version("7.2.0", "7.1.99"));
        assert!(is_newer_version("v8.0.0", "v7.9.9"));
        assert!(!is_newer_version("v7.1.7", "v7.1.7"));
        assert!(!is_newer_version("v7.1.6", "v7.1.7"));
        assert!(!is_newer_version("7.1.7", "v7.1.7"));
        assert!(is_newer_version("7.1.7-beta.2", "7.1.6"));
    }
}
