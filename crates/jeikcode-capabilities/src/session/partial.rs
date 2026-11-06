//! Per-token-interruption recovery sidecar.
//!
//! `SnapshotHook` checkpoints the whole conversation at round/tool boundaries.
//! A hard process kill *inside* a provider stream would otherwise lose that
//! round's partial text/reasoning. This sidecar keeps only the currently
//! streaming assistant content, rewritten at a small throttle (the daemon
//! decides the cadence), so a restart can overlay it as an interrupted assistant
//! message before the next user turn.
//!
//! It is deliberately NOT a second session model: no tool calls, no snapshot,
//! no display rows. Once the canonical snapshot commits, it is cleared.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PartialToolCall {
    #[serde(default)]
    pub index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub arguments: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PartialStream {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub part_id: Option<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub reasoning: String,
    /// Tool calls observed before the crash. Arguments may be incomplete; the
    /// resume overlay pairs them with a synthetic interrupted tool result so the
    /// provider context stays valid.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<PartialToolCall>,
    #[serde(default)]
    pub updated_at: u64,
}

pub fn global_root() -> PathBuf {
    crate::paths::config_dir().join("session-partials")
}

fn path_for(root: &Path, session_id: &str) -> PathBuf {
    root.join(format!("{session_id}.partial.json"))
}

pub fn save(root: &Path, partial: &PartialStream) -> std::io::Result<()> {
    if partial.text.is_empty() && partial.reasoning.is_empty() && partial.tool_calls.is_empty() {
        return Ok(());
    }
    std::fs::create_dir_all(root)?;
    let path = path_for(root, &partial.session_id);
    let bytes = serde_json::to_vec(partial).map_err(std::io::Error::other)?;
    // Atomic replace: a crash must leave either the previous checkpoint or the
    // new one, never a half-written JSON document.
    let tmp = path.with_extension("json.tmp");
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_data()?;
    }
    let _ = std::fs::remove_file(&path);
    std::fs::rename(&tmp, &path)
}

pub fn save_global(partial: &PartialStream) -> std::io::Result<()> {
    save(&global_root(), partial)
}

pub fn load(root: &Path, session_id: &str) -> Option<PartialStream> {
    let bytes = std::fs::read(path_for(root, session_id)).ok()?;
    serde_json::from_slice::<PartialStream>(&bytes).ok()
}

pub fn load_global(session_id: &str) -> Option<PartialStream> {
    load(&global_root(), session_id)
}

pub fn clear(root: &Path, session_id: &str) {
    let path = path_for(root, session_id);
    let _ = std::fs::remove_file(path.with_extension("json.tmp"));
    let _ = std::fs::remove_file(path);
}

pub fn clear_global(session_id: &str) {
    clear(&global_root(), session_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_load_clear_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let partial = PartialStream {
            session_id: "s1".into(),
            message_id: Some("m-1".into()),
            part_id: Some("m-1:1:text".into()),
            text: "partial answer".into(),
            reasoning: "thinking".into(),
            tool_calls: vec![PartialToolCall {
                index: 0,
                id: Some("call-1".into()),
                name: Some("bash".into()),
                arguments: "{\"cmd\":\"ls\"}".into(),
            }],
            updated_at: 7,
        };
        save(dir.path(), &partial).unwrap();
        assert_eq!(load(dir.path(), "s1").unwrap(), partial);
        clear(dir.path(), "s1");
        assert!(load(dir.path(), "s1").is_none());
    }

    #[test]
    fn empty_partial_is_not_written() {
        let dir = tempfile::tempdir().unwrap();
        save(
            dir.path(),
            &PartialStream {
                session_id: "s1".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(load(dir.path(), "s1").is_none());
    }
}
