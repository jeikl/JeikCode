//! Zero-config rolling file logging shared across daemon, desktop WebUI fast launch, and CLI.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, Once};

use jeikcode_config::Config;

/// Default log filter keeping `info` for workspace crates while muting noisy transport crates.
const DEFAULT_LOG_DIRECTIVES: &str =
    "info,hyper=warn,hyper_util=warn,h2=warn,rustls=warn,reqwest=warn,tower=warn,mio=warn";

/// Roll size cap for each process log file (`.old` single-generation rotation).
const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;

static LOG_INIT: Once = Once::new();

pub fn process_log_path(config_dir: &Path, filename: &str) -> PathBuf {
    config_dir.join("logs").join(filename)
}

fn rotate_log_if_large(path: &Path) {
    if std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) > LOG_ROTATE_BYTES {
        let mut old = path.as_os_str().to_owned();
        old.push(".old");
        let _ = std::fs::rename(path, PathBuf::from(old));
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
        if let Some(parent) = path.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                return;
            }
        }
        rotate_log_if_large(&path);
        let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        else {
            return;
        };
        let epoch_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(
            file,
            "--- {banner_tag} session start (unix={epoch_secs}) ---"
        );

        let filter = std::env::var("RUST_LOG")
            .ok()
            .and_then(|v| tracing_subscriber::EnvFilter::try_new(v).ok())
            .unwrap_or_else(|| tracing_subscriber::EnvFilter::new(DEFAULT_LOG_DIRECTIVES));

        let _ = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_env_filter(filter)
            .with_writer(Mutex::new(file))
            .try_init();
    });
}
