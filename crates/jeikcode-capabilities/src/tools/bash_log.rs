use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tokio::fs::{File, OpenOptions};
use tokio::io::AsyncWriteExt;

pub const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024; // 10 MB 单文件上限
pub const MAX_LOG_LINES: usize = 2000; // 最多保留 2000 行
pub const MAX_GLOBAL_LOG_FILES: usize = 50; // 全局最多 50 个日志文件

/// Log file prefix and suffix pattern for background task logs.
pub const LOG_PREFIX: &str = "jeikcode-back-";
pub const LOG_SUFFIX: &str = ".log";

/// Generate a standardized log file path for a session and PID.
pub fn format_log_filename(session_id: &str, pid: u32) -> String {
    let sanitized_session = sanitize_session_component(session_id);
    format!("{LOG_PREFIX}{sanitized_session}-{pid}{LOG_SUFFIX}")
}

/// Sanitize session id for use in filenames.
pub fn sanitize_session_component(session_id: &str) -> String {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        return "default".to_string();
    }
    trimmed
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Managed background log writer with 10MB/2000-line rolling window and global LRU enforcement.
pub struct BackgroundLogWriter {
    path: PathBuf,
    file: Option<File>,
    written_bytes: u64,
}

impl BackgroundLogWriter {
    /// Initialize a new log writer for the given session and PID.
    pub async fn create(session_id: &str, pid: u32, initial_output: &str) -> std::io::Result<Self> {
        let temp_dir = std::env::temp_dir();
        // 1. Enforce global LRU pool quota (max 50 files) before creating a new one
        enforce_global_lru_pool(&temp_dir, MAX_GLOBAL_LOG_FILES).await;

        let filename = format_log_filename(session_id, pid);
        let path = temp_dir.join(filename);

        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path)
            .await?;

        let mut written_bytes = 0;
        if !initial_output.is_empty() {
            file.write_all(initial_output.as_bytes()).await?;
            file.flush().await?;
            written_bytes = initial_output.len() as u64;
        }

        Ok(Self {
            path,
            file: Some(file),
            written_bytes,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn path_display(&self) -> String {
        self.path.to_string_lossy().replace('\\', "/")
    }

    /// Append a chunk of stdout/stderr data to the log file.
    pub async fn append(&mut self, chunk: &str) -> std::io::Result<()> {
        if chunk.is_empty() {
            return Ok(());
        }

        if let Some(ref mut file) = self.file {
            file.write_all(chunk.as_bytes()).await?;
            file.flush().await?;
            self.written_bytes += chunk.len() as u64;
        }

        // Check if rolling truncation is needed (exceeds 10MB)
        if self.written_bytes > MAX_LOG_BYTES {
            self.perform_rolling_truncation().await?;
        }

        Ok(())
    }

    /// Truncate file when exceeding size limit, keeping head context and the latest 2000 lines.
    pub async fn perform_rolling_truncation(&mut self) -> std::io::Result<()> {
        // Temporarily close handle to rewrite the file safely
        self.file = None;

        if let Ok(content) = tokio::fs::read_to_string(&self.path).await {
            let lines: Vec<&str> = content.lines().collect();
            if lines.len() > MAX_LOG_LINES {
                // Keep the first 50 lines (header/startup) and the latest 1950 lines
                let head_count = 50.min(lines.len());
                let tail_count = MAX_LOG_LINES.saturating_sub(head_count);

                let head = &lines[..head_count];
                let tail = &lines[lines.len().saturating_sub(tail_count)..];

                let mut truncated = String::with_capacity(head_count * 80 + tail_count * 80 + 100);
                for l in head {
                    truncated.push_str(l);
                    truncated.push('\n');
                }
                truncated
                    .push_str("\n... [middle lines truncated by jeikcode log rolling] ...\n\n");
                for l in tail {
                    truncated.push_str(l);
                    truncated.push('\n');
                }

                tokio::fs::write(&self.path, truncated.as_bytes()).await?;
                self.written_bytes = truncated.len() as u64;
            }
        }

        // Reopen in append mode
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .await
            .ok();

        Ok(())
    }
}

/// Enforce global log quota across the temp directory by evicting oldest files (LRU by mtime).
pub async fn enforce_global_lru_pool(dir: &Path, max_allowed: usize) {
    let mut entries = Vec::new();

    let mut read_dir = match tokio::fs::read_dir(dir).await {
        Ok(rd) => rd,
        Err(_) => return,
    };

    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let file_name = entry.file_name();
        let name_str = file_name.to_string_lossy();
        if name_str.starts_with(LOG_PREFIX) && name_str.ends_with(LOG_SUFFIX) {
            if let Ok(meta) = entry.metadata().await {
                if meta.is_file() {
                    let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                    entries.push((entry.path(), mtime));
                }
            }
        }
    }

    if entries.len() > max_allowed {
        // Sort oldest first
        entries.sort_by_key(|(_, mtime)| *mtime);
        let evict_count = entries.len() - max_allowed;
        for (path, _) in entries.into_iter().take(evict_count) {
            let _ = tokio::fs::remove_file(path).await;
        }
    }
}

/// Delete all log files belonging to a specific session_id.
pub async fn cleanup_session_logs(session_id: &str) -> usize {
    let temp_dir = std::env::temp_dir();
    let sanitized = sanitize_session_component(session_id);
    let session_prefix = format!("{LOG_PREFIX}{sanitized}-");

    let mut removed = 0;
    let mut read_dir = match tokio::fs::read_dir(&temp_dir).await {
        Ok(rd) => rd,
        Err(_) => return 0,
    };

    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let file_name = entry.file_name();
        let name_str = file_name.to_string_lossy();
        if name_str.starts_with(&session_prefix) && name_str.ends_with(LOG_SUFFIX) {
            if tokio::fs::remove_file(entry.path()).await.is_ok() {
                removed += 1;
            }
        }
    }

    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_log_filename_formatting_and_sanitization() {
        assert_eq!(
            format_log_filename("sess-123", 456),
            "jeikcode-back-sess-123-456.log"
        );
        assert_eq!(
            format_log_filename("  ", 456),
            "jeikcode-back-default-456.log"
        );
        assert_eq!(
            format_log_filename("sess/abc:1", 789),
            "jeikcode-back-sess_abc_1-789.log"
        );
    }

    #[tokio::test]
    async fn test_lru_cleanup_evicts_oldest_files() {
        let dir = tempfile::tempdir().unwrap();
        let dir_path = dir.path();

        // Create 3 files
        for i in 1..=3 {
            let p = dir_path.join(format!("{LOG_PREFIX}test-{i}{LOG_SUFFIX}"));
            tokio::fs::write(&p, b"data").await.unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }

        // Limit to 2 files -> oldest (1) must be deleted
        enforce_global_lru_pool(dir_path, 2).await;

        assert!(!dir_path
            .join(format!("{LOG_PREFIX}test-1{LOG_SUFFIX}"))
            .exists());
        assert!(dir_path
            .join(format!("{LOG_PREFIX}test-2{LOG_SUFFIX}"))
            .exists());
        assert!(dir_path
            .join(format!("{LOG_PREFIX}test-3{LOG_SUFFIX}"))
            .exists());
    }

    #[tokio::test]
    async fn test_cleanup_session_logs_matches_session_id() {
        let temp = std::env::temp_dir();
        let s1_file = temp.join(format!("{LOG_PREFIX}unit-sess-a-991{LOG_SUFFIX}"));
        let s2_file = temp.join(format!("{LOG_PREFIX}unit-sess-b-992{LOG_SUFFIX}"));

        tokio::fs::write(&s1_file, b"s1").await.unwrap();
        tokio::fs::write(&s2_file, b"s2").await.unwrap();

        let count = cleanup_session_logs("unit-sess-a").await;
        assert!(count >= 1);
        assert!(!s1_file.exists());
        assert!(s2_file.exists());

        let _ = tokio::fs::remove_file(s2_file).await;
    }
}
