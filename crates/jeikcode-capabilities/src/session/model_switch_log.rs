//! Model-switch observability sidecar: `<session>.model-switches.jsonl`.
//!
//! One line per queued/applied runtime model switch. Display-only: the marker
//! is joined onto the next assistant message id by the session-detail API and
//! never enters the kernel conversation or the provider request.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};

use serde::{Deserialize, Serialize};

use super::manager::{SessionManager, SessionResult, SessionStoreError};

pub const MODEL_SWITCH_VERSION: u32 = 1;
pub const MAX_MODEL_SWITCH_READ_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelSwitchRecord {
    #[serde(default)]
    pub v: u32,
    pub provider: String,
    pub model: String,
    /// `queued` | `applied`
    pub status: String,
    /// Epoch ms the user requested the switch.
    pub requested_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_at: Option<u64>,
    /// Assistant message (kernel round) whose first part carries the marker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    /// `applied_at - requested_at`, for ops latency analysis.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_ms: Option<u64>,
}

impl SessionManager {
    pub fn model_switch_path(&self, id: &str) -> SessionResult<std::path::PathBuf> {
        self.path_for(id, "model-switches.jsonl")
    }

    pub fn append_model_switch(&self, id: &str, record: &ModelSwitchRecord) -> SessionResult<()> {
        let path = self.model_switch_path(id)?;
        let mut line = serde_json::to_vec(record).map_err(|error| SessionStoreError::Corrupt {
            kind: "model switch record",
            message: error.to_string(),
        })?;
        line.push(b'\n');
        self.append_jsonl_line_at(id, &path, "model switch log", &line)
    }

    /// All records, oldest first, tail-bounded. Malformed lines are skipped:
    /// this is auxiliary observability and must never break session loading.
    pub fn read_model_switches(&self, id: &str) -> SessionResult<Vec<ModelSwitchRecord>> {
        let path = self.model_switch_path(id)?;
        let mut file = match std::fs::File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(source) => return Err(SessionStoreError::Io { path, source }),
        };
        let len = file
            .metadata()
            .map_err(|source| SessionStoreError::Io {
                path: path.clone(),
                source,
            })?
            .len();
        let start = len.saturating_sub(MAX_MODEL_SWITCH_READ_BYTES);
        if start > 0 {
            file.seek(SeekFrom::Start(start))
                .map_err(|source| SessionStoreError::Io {
                    path: path.clone(),
                    source,
                })?;
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|source| SessionStoreError::Io { path, source })?;
        let text = String::from_utf8_lossy(&bytes);
        let mut out = Vec::new();
        for (index, line) in text.lines().enumerate() {
            if index == 0 && start > 0 && !line.trim_start().starts_with('{') {
                continue;
            }
            if let Ok(record) = serde_json::from_str::<ModelSwitchRecord>(line) {
                out.push(record);
            }
        }
        Ok(out)
    }

    /// `message_id -> model` for applied switches (last switch wins). Used by
    /// session-detail cold-start annotation.
    pub fn applied_model_switches(&self, id: &str) -> HashMap<String, String> {
        let mut out = HashMap::new();
        for record in self.read_model_switches(id).unwrap_or_default() {
            if record.status != "applied" {
                continue;
            }
            if let Some(message_id) = record.message_id.filter(|id| !id.is_empty()) {
                out.insert(message_id, record.model);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applied_records_join_by_message_and_queued_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::with_root(dir.path());
        mgr.append_model_switch(
            "s1",
            &ModelSwitchRecord {
                v: MODEL_SWITCH_VERSION,
                provider: "a".into(),
                model: "model-a".into(),
                status: "queued".into(),
                requested_at: 10,
                applied_at: None,
                message_id: None,
                wait_ms: None,
            },
        )
        .unwrap();
        mgr.append_model_switch(
            "s1",
            &ModelSwitchRecord {
                v: MODEL_SWITCH_VERSION,
                provider: "b".into(),
                model: "model-b".into(),
                status: "applied".into(),
                requested_at: 10,
                applied_at: Some(25),
                message_id: Some("m-1".into()),
                wait_ms: Some(15),
            },
        )
        .unwrap();

        let map = mgr.applied_model_switches("s1");
        assert_eq!(map.get("m-1").map(String::as_str), Some("model-b"));
        assert_eq!(mgr.read_model_switches("s1").unwrap().len(), 2);
    }
}
