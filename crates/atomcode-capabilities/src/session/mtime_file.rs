//! mtime (+ length) file cache for per-turn hot-reload.
//!
//! Callers still `stat` on every turn. Unchanged files reuse the last body
//! (zero `read_to_string`). A newer mtime, a different length, or a missing
//! file invalidates the entry so AGENTS.md / user-wrap.md keep live reload.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileStamp {
    exists: bool,
    mtime: Option<SystemTime>,
    len: u64,
}

#[derive(Clone, Debug)]
struct CachedBody {
    stamp: FileStamp,
    /// `None` = missing, unreadable, or empty after trim.
    body: Option<String>,
}

fn cache() -> &'static Mutex<HashMap<PathBuf, CachedBody>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedBody>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn stamp(path: &Path) -> FileStamp {
    match std::fs::metadata(path) {
        Ok(md) if md.is_file() => FileStamp {
            exists: true,
            mtime: md.modified().ok(),
            len: md.len(),
        },
        _ => FileStamp {
            exists: false,
            mtime: None,
            len: 0,
        },
    }
}

/// Trimmed UTF-8 body of `path`, cached while mtime and length stay the same
/// *and* the stamp is older than the filesystem timestamp granularity.
/// A same-second same-length edit (common on Windows) still re-reads.
pub fn read_trimmed_cached(path: &Path) -> Option<String> {
    let st = stamp(path);
    if !st.exists {
        let mut cache = cache().lock().unwrap_or_else(|error| error.into_inner());
        cache.remove(path);
        return None;
    }
    if stamp_is_stable(st) {
        let cache = cache().lock().unwrap_or_else(|error| error.into_inner());
        if let Some(hit) = cache.get(path) {
            if hit.stamp == st {
                return hit.body.clone();
            }
        }
    }
    let body = std::fs::read_to_string(path).ok().and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    let mut cache = cache().lock().unwrap_or_else(|error| error.into_inner());
    cache.insert(
        path.to_path_buf(),
        CachedBody {
            stamp: st,
            body: body.clone(),
        },
    );
    body
}

fn stamp_is_stable(st: FileStamp) -> bool {
    const GRANULARITY: std::time::Duration = std::time::Duration::from_millis(1500);
    match st.mtime {
        Some(mtime) => mtime.elapsed().map(|age| age >= GRANULARITY).unwrap_or(false),
        None => false,
    }
}

#[cfg(test)]
pub(crate) fn clear_cache_for_tests() {
    cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clear();
}
