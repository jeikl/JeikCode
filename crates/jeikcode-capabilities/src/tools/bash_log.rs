use std::io::{Error, ErrorKind, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Mutex;

pub const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_LOG_LINES: usize = 2000;
pub const MAX_GLOBAL_LOG_FILES: usize = 50;

#[derive(Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    volume: u64,
    index: u64,
}

impl FileIdentity {
    #[cfg(unix)]
    fn from_file(file: &std::fs::File) -> std::io::Result<Self> {
        Ok(Self::from_metadata(&file.metadata()?))
    }

    #[cfg(unix)]
    fn from_metadata(metadata: &std::fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        Self {
            volume: metadata.dev(),
            index: metadata.ino(),
        }
    }

    #[cfg(windows)]
    fn from_file(file: &std::fs::File) -> std::io::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
        // SAFETY: the borrowed File owns a live handle, and the API initializes
        // the output structure on success before it is read.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
            return Err(Error::last_os_error());
        }
        let info = unsafe { info.assume_init() };
        Ok(Self {
            volume: u64::from(info.dwVolumeSerialNumber),
            index: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        })
    }

    fn matches_path(&self, path: &Path, metadata: &std::fs::Metadata) -> std::io::Result<bool> {
        #[cfg(unix)]
        {
            let _ = path;
            Ok(*self == Self::from_metadata(metadata))
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
            let _ = metadata;
            let file = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(path)?;
            Ok(*self == Self::from_file(&file)?)
        }
    }
}

fn retain_identity_handle(file: &std::fs::File, path: &Path) -> std::io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        let _ = path;
        file.try_clone()
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            DELETE, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        };
        let handle = std::fs::OpenOptions::new()
            .read(true)
            .access_mode(DELETE | FILE_READ_ATTRIBUTES)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        if FileIdentity::from_file(&handle)? != FileIdentity::from_file(file)? {
            return Err(Error::new(
                ErrorKind::InvalidData,
                "background log was replaced during creation",
            ));
        }
        Ok(handle)
    }
}

// Keep the directory without a recursive destructor: a replaced file or user
// content must never be removed when the host exits. Unix access is owner-only.
static LOG_DIRECTORY: LazyLock<std::io::Result<PathBuf>> = LazyLock::new(|| {
    let directory = tempfile::Builder::new().prefix("jeikcode-bg-").tempdir()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(directory.keep())
});

struct OwnedLog {
    path: PathBuf,
    identity: FileIdentity,
    // Pin the original object until record release so inode/file-index reuse
    // cannot make an unrelated replacement look like the original log.
    identity_handle: std::fs::File,
    session_owner: Option<Arc<str>>,
    active: bool,
}

// Only exact files successfully created here enter this directory. Filenames
// are never used to infer ownership or discover files left by other processes.
static LOGS: LazyLock<Mutex<Vec<OwnedLog>>> = LazyLock::new(|| Mutex::new(Vec::new()));

/// Persistent background output with exclusive files and bounded rolling logs.
pub struct BackgroundLogWriter {
    path: PathBuf,
    file: File,
    written_bytes: u64,
}

impl BackgroundLogWriter {
    pub async fn create(
        session_owner: Option<Arc<str>>,
        pid: u32,
        initial_output: &str,
    ) -> std::io::Result<Self> {
        if session_owner.as_deref() == Some("") {
            return Err(Error::new(ErrorKind::InvalidInput, "empty bash log owner"));
        }
        let directory = LOG_DIRECTORY
            .as_ref()
            .map_err(|error| Error::new(error.kind(), error.to_string()))?;
        let log = tempfile::Builder::new()
            .prefix(&format!("jeikcode-bg-{pid}-"))
            .suffix(".log")
            .tempfile_in(directory)?;
        let identity = FileIdentity::from_file(log.as_file())?;
        let identity_handle = retain_identity_handle(log.as_file(), log.path())?;
        let (file, path) = log.into_parts();
        let mut writer = Self {
            path: path.to_path_buf(),
            file: File::from_std(file),
            written_bytes: 0,
        };
        // On failure, the file closes before TempPath removes the exact file.
        writer.append(initial_output).await?;
        let path = match path.keep() {
            Ok(path) => path,
            Err(error) => {
                drop(writer);
                return Err(error.error);
            }
        };
        let mut logs = LOGS.lock().await;
        logs.push(OwnedLog {
            path,
            identity,
            identity_handle,
            session_owner,
            active: true,
        });
        enforce_log_quota(&mut logs, MAX_GLOBAL_LOG_FILES).await;
        Ok(writer)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn path_display(&self) -> String {
        self.path.to_string_lossy().replace('\\', "/")
    }

    pub async fn append(&mut self, chunk: &str) -> std::io::Result<()> {
        if chunk.is_empty() {
            return Ok(());
        }
        self.file.write_all(chunk.as_bytes()).await?;
        self.file.flush().await?;
        self.written_bytes += chunk.len() as u64;
        if self.written_bytes > MAX_LOG_BYTES {
            self.perform_rolling_truncation().await?;
        }
        Ok(())
    }

    /// Keep startup context and recent output without reopening a path that
    /// could have been replaced. IO failures propagate; writes never become no-ops.
    pub async fn perform_rolling_truncation(&mut self) -> std::io::Result<()> {
        self.file.flush().await?;
        self.file.seek(SeekFrom::Start(0)).await?;
        let mut content = String::new();
        if let Err(error) = self.file.read_to_string(&mut content).await {
            self.file.seek(SeekFrom::End(0)).await?;
            return Err(error);
        }
        let lines: Vec<&str> = content.lines().collect();
        let mut truncated = if lines.len() > MAX_LOG_LINES {
            let head_count = 50;
            let tail_count = MAX_LOG_LINES - head_count - 1;
            let mut output = lines[..head_count].join("\n");
            output.push_str("\n... [middle lines truncated by jeikcode log rolling] ...\n");
            output.push_str(&lines[lines.len() - tail_count..].join("\n"));
            output.push('\n');
            output
        } else {
            content
        };
        if truncated.len() as u64 > MAX_LOG_BYTES {
            // A single very long line must also respect the byte cap. Retain
            // the newest valid UTF-8 suffix rather than splitting a character.
            let mut start = truncated.len() - MAX_LOG_BYTES as usize;
            while !truncated.is_char_boundary(start) {
                start += 1;
            }
            truncated.drain(..start);
        }
        self.file.seek(SeekFrom::Start(0)).await?;
        self.file.write_all(truncated.as_bytes()).await?;
        self.file.set_len(truncated.len() as u64).await?;
        self.file.flush().await?;
        self.written_bytes = truncated.len() as u64;
        Ok(())
    }

    /// Close before publishing completion. Session cleanup and quota eviction
    /// can only remove completed records, including on Windows.
    pub async fn finish(mut self, retain_for_diagnostics: bool) {
        if let Err(error) = self.file.flush().await {
            tracing::warn!(path = %self.path.display(), %error, "failed to flush background log");
        }
        drop(self.file);
        let mut logs = LOGS.lock().await;
        if let Some(index) = logs.iter().position(|log| log.path == self.path) {
            logs[index].active = false;
            if !retain_for_diagnostics {
                let _ = remove_log(&mut logs, index).await;
            }
        }
        enforce_log_quota(&mut logs, MAX_GLOBAL_LOG_FILES).await;
    }
}

async fn remove_log(logs: &mut Vec<OwnedLog>, index: usize) -> std::io::Result<bool> {
    // Unix has no atomic compare-and-unlink API. No await separates these
    // operations, and mode0700 excludes other users, but same-UID code still
    // shares ambient filesystem authority and can race pathname mutation.
    let result = remove_owned_file(&logs[index]);
    match result {
        Ok(removed) => {
            logs.remove(index);
            Ok(removed)
        }
        Err(error) => {
            tracing::warn!(path = %logs[index].path.display(), %error, "failed to remove owned background log");
            Err(error)
        }
    }
}

fn remove_owned_file(log: &OwnedLog) -> std::io::Result<bool> {
    let metadata = match std::fs::symlink_metadata(&log.path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if !metadata.file_type().is_file() {
        return Ok(false);
    }
    match log.identity.matches_path(&log.path, &metadata) {
        Ok(true) => {}
        Ok(false) => return Ok(false),
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    }
    #[cfg(unix)]
    {
        // Keep the identity handle alive through unlink, preventing inode reuse.
        let _identity_guard = &log.identity_handle;
        match std::fs::remove_file(&log.path) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
        };
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        // SAFETY: this pinned handle owns DELETE access to the original file;
        // the correctly sized disposition structure lives through the call.
        let result = unsafe {
            SetFileInformationByHandle(
                log.identity_handle.as_raw_handle(),
                FileDispositionInfo,
                (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        };
        if result == 0 {
            Err(Error::last_os_error())
        } else {
            // Dropping the record closes its pinned handle and commits deletion.
            // A pathname replacement is never used as the deletion target.
            Ok(true)
        }
    }
}

/// The oldest completed records are evictable, never an active writer or a
/// prefix-matching legacy/user file. Active tasks may temporarily exceed quota.
async fn enforce_log_quota(logs: &mut Vec<OwnedLog>, max_allowed: usize) {
    let mut index = 0;
    while logs.len() > max_allowed && index < logs.len() {
        if logs[index].active || remove_log(logs, index).await.is_err() {
            index += 1;
        }
    }
}

/// Called after the owning session's background drivers have closed their logs.
/// Also removes retained logs of tasks that completed before session deletion.
pub async fn cleanup_session_logs(session_id: &str) -> usize {
    let mut logs = LOGS.lock().await;
    let mut removed = 0;
    let mut index = 0;
    while index < logs.len() {
        if logs[index].active || logs[index].session_owner.as_deref() != Some(session_id) {
            index += 1;
        } else {
            match remove_log(&mut logs, index).await {
                Ok(did_remove) => removed += usize::from(did_remove),
                Err(_) => index += 1,
            }
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned_log(path: &Path, active: bool) -> OwnedLog {
        let file = std::fs::File::open(path).unwrap();
        OwnedLog {
            path: path.to_path_buf(),
            identity: FileIdentity::from_file(&file).unwrap(),
            identity_handle: retain_identity_handle(&file, path).unwrap(),
            session_owner: None,
            active,
        }
    }

    fn replace_with_symlink(target: &Path, path: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, path).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(target, path)
            .expect("Windows symlink regression requires Developer Mode or symlink privilege");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn session_background_cleanup_filesystem_identity_keeps_unlinked_inode_pinned() {
        use std::os::unix::fs::MetadataExt;
        let workspace = tempfile::tempdir().unwrap();
        let owner: Arc<str> = Arc::from(format!("identity-{}", workspace.path().display()));
        let writer = BackgroundLogWriter::create(Some(owner.clone()), 900, "original")
            .await
            .unwrap();
        let path = writer.path().to_path_buf();
        writer.finish(true).await;
        std::fs::remove_file(&path).unwrap();
        {
            let logs = LOGS.lock().await;
            let original = logs.iter().find(|log| log.path == path).unwrap();
            assert_eq!(original.identity_handle.metadata().unwrap().nlink(), 0);
            assert!(
                FileIdentity::from_file(&original.identity_handle).unwrap() == original.identity
            );
        }
        std::fs::write(&path, b"replacement after unlink").unwrap();
        assert_eq!(cleanup_session_logs(&owner).await, 0);
        assert_eq!(std::fs::read(&path).unwrap(), b"replacement after unlink");
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn session_background_cleanup_filesystem_identity_preserves_replacement_regular_file() {
        let workspace = tempfile::tempdir().unwrap();
        let owner: Arc<str> = Arc::from(format!("identity-{}", workspace.path().display()));
        let writer = BackgroundLogWriter::create(Some(owner.clone()), 901, "original")
            .await
            .unwrap();
        let path = writer.path().to_path_buf();
        writer.finish(true).await;
        let moved = workspace.path().join("original.log");
        std::fs::rename(&path, &moved).unwrap();
        std::fs::write(&path, b"replacement user content").unwrap();
        assert_eq!(cleanup_session_logs(&owner).await, 0);
        assert_eq!(std::fs::read(&path).unwrap(), b"replacement user content");
        assert_eq!(std::fs::read(&moved).unwrap(), b"original");
        assert!(!LOGS.lock().await.iter().any(|log| log.path == path));
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn session_background_cleanup_filesystem_identity_preserves_replacement_symlink() {
        let workspace = tempfile::tempdir().unwrap();
        let owner: Arc<str> = Arc::from(format!("identity-{}", workspace.path().display()));
        let writer = BackgroundLogWriter::create(Some(owner.clone()), 902, "original")
            .await
            .unwrap();
        let path = writer.path().to_path_buf();
        writer.finish(true).await;
        std::fs::rename(&path, workspace.path().join("original.log")).unwrap();
        let target = workspace.path().join("user.log");
        std::fs::write(&target, b"symlink target user content").unwrap();
        replace_with_symlink(&target, &path);
        assert_eq!(cleanup_session_logs(&owner).await, 0);
        assert!(std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"symlink target user content"
        );
        assert!(!LOGS.lock().await.iter().any(|log| log.path == path));
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn session_background_cleanup_filesystem_identity_quota_relinquishes_replacements() {
        let workspace = tempfile::tempdir().unwrap();
        let regular = workspace.path().join("regular.log");
        let link = workspace.path().join("link.log");
        std::fs::write(&regular, b"original regular").unwrap();
        std::fs::write(&link, b"original link").unwrap();
        let mut logs = vec![owned_log(&regular, false), owned_log(&link, false)];
        std::fs::rename(&regular, workspace.path().join("old-regular.log")).unwrap();
        std::fs::rename(&link, workspace.path().join("old-link.log")).unwrap();
        std::fs::write(&regular, b"replacement user content").unwrap();
        let target = workspace.path().join("user.log");
        std::fs::write(&target, b"symlink target user content").unwrap();
        replace_with_symlink(&target, &link);
        enforce_log_quota(&mut logs, 0).await;
        assert!(logs.is_empty(), "stale records must be relinquished");
        assert_eq!(
            std::fs::read(&regular).unwrap(),
            b"replacement user content"
        );
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"symlink target user content"
        );
    }

    #[tokio::test]
    async fn session_background_cleanup_persistent_logs_use_exact_unsanitized_owners() {
        use super::super::bash_runtime::kill_by_session_id;

        let workspace = tempfile::tempdir().unwrap();
        let nonce = workspace.path().file_name().unwrap().to_string_lossy();
        let first_owner: Arc<str> = Arc::from(format!("log-owner/{nonce}"));
        let second_owner: Arc<str> = Arc::from(format!("log-owner_{nonce}"));
        let first = BackgroundLogWriter::create(Some(first_owner.clone()), 777, "first\n")
            .await
            .unwrap();
        let second = BackgroundLogWriter::create(Some(second_owner.clone()), 777, "second\n")
            .await
            .unwrap();
        let host = BackgroundLogWriter::create(None, 777, "host\n")
            .await
            .unwrap();
        let first_path = first.path().to_path_buf();
        let second_path = second.path().to_path_buf();
        let host_path = host.path().to_path_buf();
        let legacy = tempfile::Builder::new()
            .prefix(&format!("jeikcode-back-log-owner_{nonce}-777-"))
            .suffix(".log")
            .tempfile()
            .unwrap();
        std::fs::write(legacy.path(), b"user legacy log").unwrap();
        assert_ne!(first_path, second_path);
        first.finish(true).await;
        second.finish(true).await;
        host.finish(true).await;
        assert!(first_path.is_file(), "completed log must remain readable");
        assert_eq!(kill_by_session_id(&first_owner).await, 0);
        assert!(!first_path.exists());
        assert_eq!(tokio::fs::read(&second_path).await.unwrap(), b"second\n");
        assert_eq!(tokio::fs::read(&host_path).await.unwrap(), b"host\n");
        assert_eq!(std::fs::read(legacy.path()).unwrap(), b"user legacy log");
        assert_eq!(cleanup_session_logs(&second_owner).await, 1);
        tokio::fs::remove_file(host_path).await.unwrap();
    }

    #[tokio::test]
    async fn test_log_quota_preserves_active_and_untracked_files() {
        let dir = tempfile::tempdir().unwrap();
        let active = dir.path().join("active.log");
        let oldest = dir.path().join("oldest.log");
        let newest = dir.path().join("newest.log");
        let user = dir.path().join("jeikcode-back-user-123.log");
        for path in [&active, &oldest, &newest, &user] {
            tokio::fs::write(path, b"data").await.unwrap();
        }
        let mut logs = vec![
            owned_log(&active, true),
            owned_log(&oldest, false),
            owned_log(&newest, false),
        ];
        enforce_log_quota(&mut logs, 2).await;
        assert!(active.exists());
        assert!(!oldest.exists());
        assert!(newest.exists());
        assert!(user.exists());
        enforce_log_quota(&mut logs, 0).await;
        assert_eq!(logs.len(), 1);
        assert!(active.exists());
        assert!(user.exists());
    }

    #[tokio::test]
    async fn test_rolling_log_keeps_startup_and_tail_within_limits() {
        let content: String = (0..2500).map(|i| format!("line-{i}\n")).collect();
        let mut writer = BackgroundLogWriter::create(None, 888, &content)
            .await
            .unwrap();
        let path = writer.path().to_path_buf();
        writer.perform_rolling_truncation().await.unwrap();
        let output = tokio::fs::read_to_string(&path).await.unwrap();
        assert!(output.starts_with("line-0\n"));
        assert!(output.ends_with("line-2499\n"));
        assert_eq!(output.lines().count(), MAX_LOG_LINES);
        writer.append("last\n").await.unwrap();
        assert!(tokio::fs::read_to_string(&path)
            .await
            .unwrap()
            .ends_with("last\n"));
        writer.finish(false).await;
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn test_rolling_log_caps_long_utf8_lines_and_reports_io_failure() {
        let content = "界".repeat(MAX_LOG_BYTES as usize / 3 + 1);
        let mut writer = BackgroundLogWriter::create(None, 889, &content)
            .await
            .unwrap();
        let output = tokio::fs::read_to_string(writer.path()).await.unwrap();
        assert!(output.len() as u64 <= MAX_LOG_BYTES);
        assert!(output.ends_with('界'));
        // Keep the ownership record intact while using a read-only handle to
        // exercise a real write failure; an append must never report success.
        let read_only = File::open(writer.path()).await.unwrap();
        let writable = std::mem::replace(&mut writer.file, read_only);
        drop(writable);
        assert!(writer.append("cannot write").await.is_err());
        writer.finish(false).await;
    }
}
