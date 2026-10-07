//! Sidebar project visibility shared by every web client and desktop instance.
//!
//! Hiding a project only takes it off the list. Session files stay on disk.
//! A directory the catalog does not know yet (no session written) is pinned so
//! the row still appears. A hidden project whose agent is still in a turn is
//! put back on the next read, so every observer sees it without a local-only
//! `localStorage` flag.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Mutex;

use axum::extract::Json;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde::{Deserialize, Serialize};

use crate::{hash_path, json_error, normalize_dir_arg, normalize_working_dir_case};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PinnedProject {
    pub hash: String,
    pub name: String,
    pub working_dir: String,
    #[serde(default)]
    pub session_count: usize,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub last_updated: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SidebarFile {
    #[serde(default)]
    hidden: BTreeSet<String>,
    #[serde(default)]
    pinned: Vec<PinnedProject>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct SidebarView {
    pub hidden: Vec<String>,
    pub pinned: Vec<PinnedProject>,
}

fn state_path() -> PathBuf {
    let root = jeikcode_capabilities::session::SessionManager::sessions_root();
    root.parent()
        .map(|dir| dir.join("sidebar-projects.json"))
        .unwrap_or_else(|| PathBuf::from("sidebar-projects.json"))
}

fn load() -> SidebarFile {
    let path = state_path();
    let Ok(bytes) = std::fs::read(&path) else {
        return SidebarFile::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn save(state: &SidebarFile) {
    let path = state_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let Ok(body) = serde_json::to_vec_pretty(state) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, body).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|err| err.into_inner())
}

fn with_state<T>(mutate: impl FnOnce(&mut SidebarFile) -> T) -> T {
    let _guard = lock();
    let mut state = load();
    let out = mutate(&mut state);
    save(&state);
    out
}

fn view_of(state: &SidebarFile) -> SidebarView {
    SidebarView {
        hidden: state.hidden.iter().cloned().collect(),
        pinned: state.pinned.clone(),
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Canonical directory identity used for both the pin and the session bucket.
pub fn prepare_project_dir(raw: &str) -> Result<PathBuf, String> {
    let expanded = normalize_dir_arg(raw.trim());
    let canon = jeikcode_capabilities::pathnorm::canonicalize(&expanded)
        .unwrap_or_else(|_| jeikcode_capabilities::pathnorm::strip_verbatim_path(&expanded));
    let canon = normalize_working_dir_case(canon);
    if !canon.is_dir() {
        return Err(format!("not a directory: {}", canon.display()));
    }
    Ok(canon)
}

fn pin_dir(state: &mut SidebarFile, dir: &std::path::Path) -> PinnedProject {
    let hash = hash_path(dir);
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| dir.to_string_lossy().into_owned());
    let now = now_secs();
    state.hidden.remove(&hash);
    if let Some(existing) = state.pinned.iter_mut().find(|p| p.hash == hash) {
        existing.working_dir = dir.to_string_lossy().into_owned();
        existing.name = name;
        existing.last_updated = now;
        return existing.clone();
    }
    let pinned = PinnedProject {
        hash,
        name,
        working_dir: dir.to_string_lossy().into_owned(),
        session_count: 0,
        created_at: now,
        last_updated: now,
    };
    state.pinned.push(pinned.clone());
    pinned
}

/// Drop hidden flags for projects whose agent is still in a turn.
fn reveal_live_locked(state: &mut SidebarFile) -> bool {
    if state.hidden.is_empty() {
        return false;
    }
    let mut live_hashes = BTreeSet::new();
    for entry in
        jeikcode_coding::session_runtime_registry::SessionRuntimeRegistry::global().list_all()
    {
        if entry.activity.is_live_turn() {
            live_hashes.insert(hash_path(&entry.working_dir));
        }
    }
    if crate::native_live::live_running_session_id().is_some() {
        if let Ok(binding) = crate::native_live::binding() {
            live_hashes.insert(hash_path(&binding.working_dir));
        }
    }
    let before = state.hidden.len();
    state.hidden.retain(|hash| !live_hashes.contains(hash));
    state.hidden.len() != before
}

pub fn snapshot() -> SidebarView {
    let _guard = lock();
    let mut state = load();
    if reveal_live_locked(&mut state) {
        save(&state);
    }
    view_of(&state)
}

pub fn hide_hash(hash: &str) -> SidebarView {
    let hash = hash.trim().to_string();
    with_state(|state| {
        if !hash.is_empty() {
            state.hidden.insert(hash);
        }
        view_of(state)
    })
}

pub fn reveal_hash(hash: &str) -> SidebarView {
    let hash = hash.trim().to_string();
    with_state(|state| {
        if !hash.is_empty() {
            state.hidden.remove(&hash);
        }
        view_of(state)
    })
}

pub fn show_path(raw: &str) -> Result<PinnedProject, String> {
    let dir = prepare_project_dir(raw)?;
    Ok(with_state(|state| pin_dir(state, &dir)))
}

pub async fn get_sidebar_projects() -> impl IntoResponse {
    let view = tokio::task::spawn_blocking(snapshot)
        .await
        .unwrap_or_default();
    Json(view)
}

#[derive(Deserialize)]
pub struct HideBody {
    pub hash: String,
}

pub async fn hide_sidebar_project(Json(body): Json<HideBody>) -> impl IntoResponse {
    let view = tokio::task::spawn_blocking(move || hide_hash(&body.hash))
        .await
        .unwrap_or_default();
    Json(view)
}

#[derive(Deserialize)]
pub struct ShowBody {
    pub path: String,
}

pub async fn show_sidebar_project(Json(body): Json<ShowBody>) -> impl IntoResponse {
    match tokio::task::spawn_blocking(move || show_path(&body.path)).await {
        Ok(Ok(pinned)) => Json(pinned).into_response(),
        Ok(Err(message)) => json_error(StatusCode::BAD_REQUEST, message).into_response(),
        Err(_) => {
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "sidebar show failed").into_response()
        }
    }
}

#[derive(Deserialize)]
pub struct RevealBody {
    pub hash: String,
}

pub async fn reveal_sidebar_project(Json(body): Json<RevealBody>) -> impl IntoResponse {
    let view = tokio::task::spawn_blocking(move || reveal_hash(&body.hash))
        .await
        .unwrap_or_default();
    Json(view)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hide_and_reveal_round_trip() {
        let hash = format!("sidebar-test-{}", std::process::id());
        let hidden = hide_hash(&hash);
        assert!(hidden.hidden.iter().any(|h| h == &hash));
        let shown = reveal_hash(&hash);
        assert!(shown.hidden.iter().all(|h| h != &hash));
    }

    #[test]
    fn show_path_unhides_and_strips_verbatim_prefix() {
        let dir = std::env::temp_dir();
        let pinned = show_path(dir.to_string_lossy().as_ref()).expect("temp dir");
        assert!(!pinned.hash.is_empty());
        assert!(!pinned.working_dir.contains(r"\\?\"));
        assert!(!pinned.working_dir.contains("//?/"));
        assert!(!pinned.working_dir.contains("/?/"));
        hide_hash(&pinned.hash);
        #[cfg(windows)]
        {
            let raw = format!(r"\\?\{}", dir.display());
            let again = show_path(&raw).expect("verbatim temp dir");
            assert_eq!(again.hash, pinned.hash);
        }
        #[cfg(not(windows))]
        {
            let again = show_path(dir.to_string_lossy().as_ref()).expect("temp dir");
            assert_eq!(again.hash, pinned.hash);
        }
        let view = snapshot();
        assert!(view.hidden.iter().all(|h| h != &pinned.hash));
    }
}
