//! Non-blocking rolling file logging shared across daemon, desktop WebUI fast launch, and CLI.
//!
//! Uses a bounded memory ring queue paired with a dedicated OS writer thread so
//! `tracing` events emitted on Tokio network/agent worker threads never contend on
//! synchronous file locks or disk stalls.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, Once};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use jeikcode_config::Config;
use tracing_subscriber::fmt::MakeWriter;

/// Default log filter keeping `info` for workspace crates while muting noisy transport crates.
pub const DEFAULT_LOG_DIRECTIVES: &str =
    "info,hyper=warn,hyper_util=warn,h2=warn,rustls=warn,reqwest=warn,tower=warn,mio=warn";

/// Roll size cap for each process log file (`.old` single-generation rotation).
const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;

/// Maximum buffered log lines kept in RAM before non-blocking drop triggers.
const LOG_QUEUE_CAP: usize = 4096;

/// Above this queue depth, low-priority `DEBUG`/`TRACE` records are shed early.
const LOG_SOFT_DROP_HIGH_WATER: usize = 3072;

/// Maximum lines drained per OS writer wakeup to keep mutex hold times tiny and batch syscalls.
const WRITER_BATCH_SIZE: usize = 256;

static LOG_INIT: Once = Once::new();

pub fn process_log_path(config_dir: &Path, filename: &str) -> PathBuf {
    config_dir.join("logs").join(filename)
}

fn rotate_log_if_large(path: &Path, rotate_bytes: u64) {
    if std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) > rotate_bytes {
        let mut old = path.as_os_str().to_owned();
        old.push(".old");
        let _ = std::fs::rename(path, PathBuf::from(old));
    }
}

struct SharedLogQueue {
    state: Mutex<LogQueueState>,
    wake: Condvar,
    depth: AtomicUsize,
    dropped_total: AtomicU64,
}

struct LogQueueState {
    lines: VecDeque<Vec<u8>>,
    closed: bool,
}

impl SharedLogQueue {
    fn new() -> Self {
        Self {
            state: Mutex::new(LogQueueState {
                lines: VecDeque::with_capacity(256),
                closed: false,
            }),
            wake: Condvar::new(),
            depth: AtomicUsize::new(0),
            dropped_total: AtomicU64::new(0),
        }
    }

    /// Enqueue one formatted log record without ever blocking on disk I/O.
    fn try_push(&self, line: Vec<u8>, is_low_priority: bool) -> bool {
        if line.is_empty() {
            return true;
        }
        let approx_depth = self.depth.load(Ordering::Relaxed);
        if is_low_priority && approx_depth >= LOG_SOFT_DROP_HIGH_WATER {
            self.dropped_total.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if guard.closed || guard.lines.len() >= LOG_QUEUE_CAP {
            self.dropped_total.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        if is_low_priority && guard.lines.len() >= LOG_SOFT_DROP_HIGH_WATER {
            self.dropped_total.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        let was_empty = guard.lines.is_empty();
        guard.lines.push_back(line);
        self.depth.store(guard.lines.len(), Ordering::Relaxed);
        if was_empty {
            self.wake.notify_one();
        }
        true
    }
}

/// Non-blocking `tracing_subscriber` writer backed by a bounded queue + dedicated OS thread.
#[derive(Clone)]
struct NonBlockingLogWriter {
    queue: Arc<SharedLogQueue>,
}

impl NonBlockingLogWriter {
    fn spawn(path: PathBuf, banner_line: Option<String>, rotate_bytes: u64) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        rotate_log_if_large(&path, rotate_bytes);
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        if let Some(banner) = banner_line {
            let _ = writeln!(file, "{banner}");
        }
        let initial_bytes = file.metadata().map(|m| m.len()).unwrap_or(0);

        let queue = Arc::new(SharedLogQueue::new());
        let worker_queue = Arc::clone(&queue);
        let _ = std::thread::Builder::new()
            .name("jeikcode-log-writer".into())
            .spawn(move || writer_loop(path, file, initial_bytes, rotate_bytes, worker_queue))?;

        Ok(Self { queue })
    }
}

fn reopen_rotated_file(path: &Path) -> Option<File> {
    let mut old = path.as_os_str().to_owned();
    old.push(".old");
    let _ = std::fs::rename(path, PathBuf::from(old));
    OpenOptions::new().create(true).append(true).open(path).ok()
}

fn writer_loop(
    path: PathBuf,
    mut file: File,
    mut written_bytes: u64,
    rotate_bytes: u64,
    queue: Arc<SharedLogQueue>,
) {
    let mut batch: Vec<Vec<u8>> = Vec::with_capacity(WRITER_BATCH_SIZE);
    let mut last_reported_dropped = 0u64;
    loop {
        {
            let mut guard = queue.state.lock().unwrap_or_else(|e| e.into_inner());
            while guard.lines.is_empty() && !guard.closed {
                guard = match queue.wake.wait_timeout(guard, Duration::from_secs(2)) {
                    Ok((g, _)) => g,
                    Err(poisoned) => poisoned.into_inner().0,
                };
            }
            for _ in 0..WRITER_BATCH_SIZE {
                if let Some(line) = guard.lines.pop_front() {
                    batch.push(line);
                } else {
                    break;
                }
            }
            queue.depth.store(guard.lines.len(), Ordering::Relaxed);
            if batch.is_empty() && guard.closed {
                break;
            }
        }

        if batch.is_empty() {
            continue;
        }

        for line in batch.drain(..) {
            written_bytes = written_bytes.saturating_add(line.len() as u64);
            let _ = file.write_all(&line);
        }

        let current_dropped = queue.dropped_total.load(Ordering::Relaxed);
        if current_dropped > last_reported_dropped {
            let delta = current_dropped - last_reported_dropped;
            last_reported_dropped = current_dropped;
            let notice = format!(
                "[jeikcode::logging] shed {delta} log lines due to bounded ring backpressure\n"
            );
            written_bytes = written_bytes.saturating_add(notice.len() as u64);
            let _ = file.write_all(notice.as_bytes());
        }

        let _ = file.flush();

        if written_bytes > rotate_bytes {
            drop(file);
            if let Some(reopened) = reopen_rotated_file(&path) {
                file = reopened;
                written_bytes = 0;
            } else {
                return;
            }
        }
    }
    let _ = file.flush();
}

enum LogLineWriter {
    Active {
        buf: Vec<u8>,
        queue: Arc<SharedLogQueue>,
        is_low_priority: bool,
    },
    Noop,
}

impl Write for LogLineWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        match self {
            Self::Active { buf, .. } => {
                buf.extend_from_slice(data);
                Ok(data.len())
            }
            Self::Noop => Ok(data.len()),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for LogLineWriter {
    fn drop(&mut self) {
        if let Self::Active {
            buf,
            queue,
            is_low_priority,
        } = self
        {
            if !buf.is_empty() {
                let owned = std::mem::take(buf);
                queue.try_push(owned, *is_low_priority);
            }
        }
    }
}

impl<'a> MakeWriter<'a> for NonBlockingLogWriter {
    type Writer = LogLineWriter;

    fn make_writer(&'a self) -> Self::Writer {
        LogLineWriter::Active {
            buf: Vec::with_capacity(256),
            queue: Arc::clone(&self.queue),
            is_low_priority: false,
        }
    }

    fn make_writer_for(&'a self, meta: &tracing::Metadata<'_>) -> Self::Writer {
        let is_low_priority = *meta.level() > tracing::Level::INFO;
        if is_low_priority && self.queue.depth.load(Ordering::Relaxed) >= LOG_SOFT_DROP_HIGH_WATER {
            self.queue.dropped_total.fetch_add(1, Ordering::Relaxed);
            return LogLineWriter::Noop;
        }
        LogLineWriter::Active {
            buf: Vec::with_capacity(256),
            queue: Arc::clone(&self.queue),
            is_low_priority,
        }
    }
}

/// Initialize global non-ANSI rolling file `tracing` subscriber once per process (fail-open).
///
/// Respects optional `RUST_LOG` override; otherwise defaults to [`DEFAULT_LOG_DIRECTIVES`].
/// If another subscriber was already initialized earlier in this process, `try_init` is a
/// harmless no-op so mixed CLI + embedded daemon launches never collide.
pub fn init_process_file_logging(filename: &str, banner_tag: &str) {
    LOG_INIT.call_once(|| {
        if tracing::dispatcher::has_been_set() {
            return;
        }
        let path = process_log_path(&Config::config_dir(), filename);
        let epoch_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let banner = format!("--- {banner_tag} session start (unix={epoch_secs}) ---");
        let Ok(writer) = NonBlockingLogWriter::spawn(path, Some(banner), LOG_ROTATE_BYTES) else {
            return;
        };

        let filter = std::env::var("RUST_LOG")
            .ok()
            .and_then(|v| tracing_subscriber::EnvFilter::try_new(v).ok())
            .unwrap_or_else(|| tracing_subscriber::EnvFilter::new(DEFAULT_LOG_DIRECTIVES));

        let _ = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_env_filter(filter)
            .with_writer(writer)
            .try_init();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_blocking_log_writer_flushes_and_rotates_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.log");
        let writer = NonBlockingLogWriter::spawn(path.clone(), Some("banner".into()), 256)
            .expect("spawn log writer");

        for i in 0..20 {
            let mut w = writer.make_writer();
            writeln!(w, "line-{i:02}-payload-0123456789abcdef0123456789abcdef").unwrap();
        }

        // Wait briefly for the dedicated OS writer thread to drain & rotate.
        let mut old_path = path.as_os_str().to_owned();
        old_path.push(".old");
        let old_path = PathBuf::from(old_path);
        for _ in 0..40 {
            if old_path.exists() && path.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(15));
        }

        assert!(path.exists(), "active log file should exist");
        assert!(old_path.exists(), "runtime log rotation should create .old");
    }

    #[test]
    fn shared_queue_sheds_low_priority_and_full_lines_without_blocking() {
        let q = SharedLogQueue::new();
        for i in 0..LOG_SOFT_DROP_HIGH_WATER {
            assert!(q.try_push(format!("info-{i}\n").into_bytes(), false));
        }
        // Low-priority debug/trace lines drop immediately above high-water mark.
        assert!(!q.try_push(b"debug-line\n".to_vec(), true));
        // High-priority info/warn/error still fit up to LOG_QUEUE_CAP.
        for i in LOG_SOFT_DROP_HIGH_WATER..LOG_QUEUE_CAP {
            assert!(q.try_push(format!("warn-{i}\n").into_bytes(), false));
        }
        // Once full, even high-priority pushes return false immediately instead of blocking.
        assert!(!q.try_push(b"overflow-line\n".to_vec(), false));
        assert!(q.dropped_total.load(Ordering::Relaxed) >= 2);
    }
}
