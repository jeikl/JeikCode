//! Per-tool execution metrics sidecar: `<session>.toolmetrics.jsonl`.
//!
//! Observability-only. These records NEVER enter the kernel conversation or the
//! provider request, so prompt context / prefix caching stay byte-identical.
//! The daemon appends one record when a tool starts and another when its
//! execution settles; the UI uses them to paint a live cost stopwatch anchored
//! on the server clock and a frozen `switch` latency, and to rehydrate the same
//! values after a refresh, a cold start, or from another WebUI instance.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};

use serde::{Deserialize, Serialize};

use super::manager::{SessionManager, SessionResult, SessionStoreError};

/// Additive record schema version (same forward-compat seam as the transcript).
pub const TOOL_METRIC_VERSION: u32 = 1;

/// Only the tail is needed: a lookup map is "last record per call wins", and a
/// long-lived session's oldest tool calls are no longer rendered.
pub const MAX_TOOL_METRIC_READ_BYTES: u64 = 8 * 1024 * 1024;

/// Lifecycle state of one tool call, mirrored to the UI timing badge.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolMetricStatus {
    Running,
    Done,
    Error,
    Incomplete,
}

impl Default for ToolMetricStatus {
    fn default() -> Self {
        Self::Running
    }
}

impl ToolMetricStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Done => "done",
            Self::Error => "error",
            Self::Incomplete => "incomplete",
        }
    }
}

/// One append-only metric line. The LAST record for a `call_id` is authoritative.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolMetricRecord {
    /// Record schema version; older lines deserialize as 0.
    #[serde(default)]
    pub v: u32,
    /// Kernel tool-call id (joins the display transcript / history tool row).
    pub call_id: String,
    pub name: String,
    /// Epoch milliseconds (server clock) when execution started.
    pub started_at: u64,
    /// Epoch milliseconds when execution returned; absent while running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    /// Execution wall-clock measured by the daemon (authoritative on freeze).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Gap from the previous turn activity (model delta / previous tool
    /// completion) to this tool's start. Frozen once execution starts.
    #[serde(default)]
    pub switch_ms: u64,
    #[serde(default)]
    pub status: ToolMetricStatus,
}

impl ToolMetricRecord {
    pub fn running(
        call_id: impl Into<String>,
        name: impl Into<String>,
        started_at: u64,
        switch_ms: u64,
    ) -> Self {
        Self {
            v: TOOL_METRIC_VERSION,
            call_id: call_id.into(),
            name: name.into(),
            started_at,
            finished_at: None,
            duration_ms: None,
            switch_ms,
            status: ToolMetricStatus::Running,
        }
    }

    pub fn finished(
        mut self,
        status: ToolMetricStatus,
        finished_at: u64,
        duration_ms: u64,
    ) -> Self {
        self.status = status;
        self.finished_at = Some(finished_at);
        self.duration_ms = Some(duration_ms);
        self
    }
}

impl SessionManager {
    /// `<id>.toolmetrics.jsonl` inside the session's project bucket.
    pub fn tool_metrics_path(&self, id: &str) -> SessionResult<std::path::PathBuf> {
        self.path_for(id, "toolmetrics.jsonl")
    }

    /// Append one metric line. Best-effort auxiliary data: callers must treat a
    /// failure as an observability warning, never as a turn failure.
    pub fn append_tool_metric(&self, id: &str, record: &ToolMetricRecord) -> SessionResult<()> {
        let path = self.tool_metrics_path(id)?;
        let mut line = serde_json::to_vec(record).map_err(|error| SessionStoreError::Corrupt {
            kind: "tool metric record",
            message: error.to_string(),
        })?;
        line.push(b'\n');
        self.append_jsonl_line_at(id, &path, "tool metrics", &line)
    }

    /// Read the tail of the metrics log and return the LAST record per call id.
    /// Malformed/partial lines are skipped: this is auxiliary observability data
    /// and must never break session loading.
    pub fn read_tool_metrics(&self, id: &str) -> SessionResult<HashMap<String, ToolMetricRecord>> {
        let path = self.tool_metrics_path(id)?;
        let mut file = match std::fs::File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
            Err(source) => return Err(SessionStoreError::Io { path, source }),
        };
        let len = file
            .metadata()
            .map_err(|source| SessionStoreError::Io {
                path: path.clone(),
                source,
            })?
            .len();
        let start = len.saturating_sub(MAX_TOOL_METRIC_READ_BYTES);
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
        let mut out: HashMap<String, ToolMetricRecord> = HashMap::new();
        for (index, line) in text.lines().enumerate() {
            // A tail read can begin mid-line; drop that first partial fragment.
            if index == 0 && start > 0 && !line.trim_start().starts_with('{') {
                continue;
            }
            let Ok(record) = serde_json::from_str::<ToolMetricRecord>(line) else {
                continue;
            };
            if record.call_id.is_empty() {
                continue;
            }
            out.insert(record.call_id.clone(), record);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_record_per_call_wins_and_missing_log_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::with_root(dir.path());
        assert!(mgr.read_tool_metrics("s1").unwrap().is_empty());

        let started = ToolMetricRecord::running("call-1", "run_command", 1_000, 250);
        mgr.append_tool_metric("s1", &started).unwrap();
        let mid = mgr.read_tool_metrics("s1").unwrap();
        assert_eq!(mid["call-1"].status, ToolMetricStatus::Running);
        assert_eq!(mid["call-1"].switch_ms, 250);

        let done = started.clone().finished(ToolMetricStatus::Done, 1_750, 750);
        mgr.append_tool_metric("s1", &done).unwrap();
        let final_state = mgr.read_tool_metrics("s1").unwrap();
        assert_eq!(final_state["call-1"].status, ToolMetricStatus::Done);
        assert_eq!(final_state["call-1"].duration_ms, Some(750));
        assert_eq!(final_state["call-1"].finished_at, Some(1_750));
    }

    #[test]
    fn malformed_lines_are_skipped_without_failing_the_read() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::with_root(dir.path());
        let path = mgr.tool_metrics_path("s1").unwrap();
        std::fs::write(
            &path,
            "not json\n{\"call_id\":\"c1\",\"name\":\"bash\",\"started_at\":5}\n",
        )
        .unwrap();
        let map = mgr.read_tool_metrics("s1").unwrap();
        assert_eq!(map.len(), 1);
        assert_eq!(map["c1"].started_at, 5);
        // Missing v/status deserialize to the additive defaults.
        assert_eq!(map["c1"].v, 0);
        assert_eq!(map["c1"].status, ToolMetricStatus::Running);
    }
}
