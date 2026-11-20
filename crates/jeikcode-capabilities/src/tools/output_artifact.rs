//! Content-addressed storage for full tool outputs — large blobs indexed by
//! sha256 hash, one directory per session. Conversation carries only previews;
//! full outputs live on disk, deduplicated by content.

use crate::tools::artifact_watchdog::{ArtifactWatchdog, GLOBAL_MAX_CAPACITY};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;

/// 16 lowercase hex chars of sha256 — deterministic content id (dedup + cache-safe).
pub fn artifact_id(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(16);
    for b in &digest[..8] {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn is_valid_id(id: &str) -> bool {
    id.len() == 16
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Content-addressed store for full tool outputs, one directory per session.
pub struct ArtifactStore {
    dir: PathBuf,
    watchdog: Option<Arc<ArtifactWatchdog>>,
}

impl ArtifactStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            watchdog: Some(ArtifactWatchdog::global()),
        }
    }

    pub fn new_standalone(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            watchdog: None,
        }
    }

    pub fn with_watchdog(dir: impl Into<PathBuf>, watchdog: Arc<ArtifactWatchdog>) -> Self {
        Self {
            dir: dir.into(),
            watchdog: Some(watchdog),
        }
    }

    pub fn put(&self, bytes: &[u8]) -> std::io::Result<String> {
        let id = artifact_id(bytes);
        let path = self.dir.join(&id);
        if !path.exists() {
            std::fs::create_dir_all(&self.dir)?;
            let stored = encode_for_storage(bytes);
            // Write to a temp sibling then rename → readers never see a partial file.
            let tmp = self.dir.join(format!("{id}.tmp"));
            std::fs::write(&tmp, stored.as_ref())?;
            std::fs::rename(&tmp, &path)?;
            if let Some(wd) = &self.watchdog {
                // Capacity is disk capacity: count the compressed bytes actually stored.
                wd.record_addition(stored.len() as u64);
            }
        }
        Ok(id)
    }

    /// Protect an artifact from ROUTINE watchdog eviction (compaction archives).
    ///
    /// The marker is a zero-byte `<id>.pin` sibling. The global watchdog skips pinned
    /// artifacts in its periodic 30% cycle and only considers them last when the hard
    /// 7 GiB ceiling forces an emergency eviction. Idempotent.
    pub fn pin(&self, id: &str) -> std::io::Result<()> {
        if !is_valid_id(id) {
            return Ok(());
        }
        std::fs::create_dir_all(&self.dir)?;
        std::fs::write(self.dir.join(format!("{id}.pin")), b"")
    }

    pub fn get(&self, id: &str, offset: usize, limit: usize) -> std::io::Result<Option<Vec<u8>>> {
        if !is_valid_id(id) {
            return Ok(None);
        }
        let path = self.dir.join(id);
        let mut bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        // Large UTF-8 artifacts use a private header + gzip payload. The header
        // (not the gzip magic alone) is what makes detection unambiguous: a
        // binary artifact may legitimately start with `1f 8b`, but it cannot
        // start with the full JEIKCODE marker by accident in practice.
        if bytes.len() >= ARTIFACT_GZIP_HEADER_LEN && bytes.starts_with(ARTIFACT_GZIP_MAGIC) {
            let expected = u64::from_le_bytes(
                bytes[ARTIFACT_GZIP_MAGIC.len()..ARTIFACT_GZIP_HEADER_LEN]
                    .try_into()
                    .expect("fixed 8-byte length"),
            ) as usize;
            let mut decoded = Vec::new();
            GzDecoder::new(&bytes[ARTIFACT_GZIP_HEADER_LEN..]).read_to_end(&mut decoded)?;
            if decoded.len() != expected {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "artifact gzip length mismatch",
                ));
            }
            bytes = decoded;
        }
        // Touch mtime on access so this artifact is marked recently used (true cross-platform LRU).
        touch_mtime(&path);

        let start = offset.min(bytes.len());
        let end = start.saturating_add(limit).min(bytes.len());
        Ok(Some(bytes[start..end].to_vec()))
    }

    /// Logical byte length of the stored artifact (the original bytes, before
    /// any on-disk gzip compression). `Ok(None)` for a missing file or an id
    /// that isn't `[0-9a-f]{16}`.
    pub fn size(&self, id: &str) -> std::io::Result<Option<u64>> {
        if !is_valid_id(id) {
            return Ok(None);
        }
        let path = self.dir.join(id);
        let metadata = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        if metadata.len() < ARTIFACT_GZIP_HEADER_LEN as u64 {
            return Ok(Some(metadata.len()));
        }
        let mut header = [0u8; ARTIFACT_GZIP_HEADER_LEN];
        let mut file = std::fs::File::open(&path)?;
        if file.read_exact(&mut header).is_err() || !header.starts_with(ARTIFACT_GZIP_MAGIC) {
            return Ok(Some(metadata.len()));
        }
        Ok(Some(u64::from_le_bytes(
            header[ARTIFACT_GZIP_MAGIC.len()..ARTIFACT_GZIP_HEADER_LEN]
                .try_into()
                .expect("fixed 8-byte length"),
        )))
    }
}

/// Text artifacts at or above 64 KiB are gzip-compressed on disk. The artifact
/// id still hashes the original bytes, so ids and dedup stay stable; `get`
/// transparently restores the original bytes. Binary data is never compressed.
const ARTIFACT_GZIP_THRESHOLD: usize = 64 * 1024;
const ARTIFACT_GZIP_MAGIC: &[u8] = b"JEIKCODE-GZIP-V1\0";
const ARTIFACT_GZIP_HEADER_LEN: usize = ARTIFACT_GZIP_MAGIC.len() + 8;

fn encode_for_storage(bytes: &[u8]) -> std::borrow::Cow<'_, [u8]> {
    if bytes.len() < ARTIFACT_GZIP_THRESHOLD || std::str::from_utf8(bytes).is_err() {
        return std::borrow::Cow::Borrowed(bytes);
    }
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    if encoder.write_all(bytes).is_err() {
        return std::borrow::Cow::Borrowed(bytes);
    }
    let Ok(compressed) = encoder.finish() else {
        return std::borrow::Cow::Borrowed(bytes);
    };
    if compressed.len() + ARTIFACT_GZIP_HEADER_LEN >= bytes.len() {
        return std::borrow::Cow::Borrowed(bytes);
    }
    let mut stored = Vec::with_capacity(ARTIFACT_GZIP_HEADER_LEN + compressed.len());
    stored.extend_from_slice(ARTIFACT_GZIP_MAGIC);
    stored.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
    stored.extend_from_slice(&compressed);
    std::borrow::Cow::Owned(stored)
}

/// Touch mtime to current timestamp on access (best effort, zero fail impact).
fn touch_mtime(path: &std::path::Path) {
    if let Ok(file) = std::fs::File::options().write(true).open(path) {
        let times = std::fs::FileTimes::new().set_modified(std::time::SystemTime::now());
        let _ = file.set_times(times);
    }
}

/// Default compression threshold: results larger than this (bytes) are replaced
/// by a head/tail preview plus an artifact-backed retrieval handle. This const
/// is only the FALLBACK when no config value is present — the shipped config
/// default is 64 KiB (`[tools.tool_output] max_bytes`). `read_file` self-caps at
/// 65 KiB and opts out via `never_truncate_result()`, so a default page is not
/// folded into fetch_output. Configurable per instance via
/// [`ArtifactMiddleware::with_threshold_bytes`]; `0` disables compression.
pub const THRESHOLD_BYTES: usize = 32 * 1024;
/// Fallback for the terminal (shell) early line: console streams are the
/// noisiest class, so they compress sooner. The shipped config default is
/// `[tools.tool_output] terminal_max_bytes` (24 KiB); the effective line is
/// `min(max_bytes, terminal_max_bytes)` so lowering either tightens the class.
pub const TERMINAL_THRESHOLD_BYTES: usize = 24 * 1024;
/// Threshold for external MCP tools — provides dedicated guardrails to protect context windows.
pub const MCP_THRESHOLD_BYTES: usize = 32 * 1024;
/// Uniform preview kept from each end of a compressed result (bytes).
const PREVIEW_HEAD_BYTES: usize = 1500;
const PREVIEW_TAIL_BYTES: usize = 2200;
/// Stable marker substring embedded in a conversation-visible result when the complete
/// tool output was replaced by an artifact-backed preview.
pub const ARTIFACT_TRUNCATION_MARKER_PREFIX: &str = "section of output folded";

/// Detect if a tool result indicates a command failure / error state (exit code != 0).
fn is_failure_outcome(result: &jeikcode_kernel::tool::ToolResult) -> bool {
    if result.is_error {
        return true;
    }
    if let Some(pos) = result.content.rfind("[exit code ") {
        let after = &result.content[pos + 11..];
        if let Some(end) = after.find(']') {
            let code_str = after[..end].trim();
            if let Ok(code) = code_str.parse::<i32>() {
                return code != 0;
            }
        }
    }
    false
}

/// Largest char-boundary index ≤ n.
fn head_boundary(s: &str, n: usize) -> usize {
    let mut i = n.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Smallest char-boundary index ≥ (len - n).
fn tail_start(s: &str, n: usize) -> usize {
    let mut i = s.len().saturating_sub(n);
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

pub struct ArtifactMiddleware {
    store: Arc<ArtifactStore>,
    /// Compression threshold for THIS instance. `0` disables compression.
    threshold_bytes: usize,
    /// Earlier line for terminal (shell) tools — their effective line is
    /// `min(threshold_bytes, this)`. `0` drops the terminal early line
    /// (terminal tools then follow `threshold_bytes`). Wired from
    /// `[tools.tool_output] terminal_max_bytes`; defaults to
    /// [`TERMINAL_THRESHOLD_BYTES`].
    terminal_threshold_bytes: usize,
    /// Threshold for MCP tool outputs. Defaults to [`MCP_THRESHOLD_BYTES`].
    mcp_threshold_bytes: usize,
    /// Tool names whose output must reach the model verbatim (never
    /// compressed), configured via `[tools.tool_output] no_fold_tools`.
    /// Batch-friendly: every listed tool name opts out of compression, on top
    /// of the intrinsic `Tool::never_truncate_result()` contract.
    no_fold_tools: std::collections::HashSet<String>,
}

impl ArtifactMiddleware {
    pub fn new(store: Arc<ArtifactStore>) -> Self {
        Self {
            store,
            threshold_bytes: THRESHOLD_BYTES,
            terminal_threshold_bytes: TERMINAL_THRESHOLD_BYTES,
            mcp_threshold_bytes: MCP_THRESHOLD_BYTES,
            no_fold_tools: std::collections::HashSet::new(),
        }
    }

    /// Override the compression threshold for this instance (bytes). `0`
    /// disables compression — every result passes through verbatim.
    pub fn with_threshold_bytes(mut self, bytes: usize) -> Self {
        self.threshold_bytes = bytes;
        self
    }

    /// Override the terminal early line for this instance (bytes). `0` drops
    /// the early line — terminal tools then follow the general threshold.
    pub fn with_terminal_threshold_bytes(mut self, bytes: usize) -> Self {
        self.terminal_threshold_bytes = bytes;
        self
    }

    /// Override the MCP tool threshold for this instance (bytes). `0` drops
    /// the early line — MCP tools then follow the general threshold.
    pub fn with_mcp_threshold_bytes(mut self, bytes: usize) -> Self {
        self.mcp_threshold_bytes = bytes;
        self
    }

    /// Batch-register tool names that are exempt from folding (config-driven
    /// whitelist). Empty/duplicate names are ignored.
    pub fn with_no_fold_tools<I: IntoIterator<Item = String>>(mut self, names: I) -> Self {
        self.no_fold_tools = names
            .into_iter()
            .filter(|n| !n.trim().is_empty())
            .map(|n| n.trim().to_string())
            .collect();
        self
    }
}

#[async_trait::async_trait]
impl jeikcode_kernel::middleware::ToolMiddleware for ArtifactMiddleware {
    async fn after(
        &self,
        result: &mut jeikcode_kernel::tool::ToolResult,
        tool: Option<&dyn jeikcode_kernel::tool::Tool>,
    ) -> jeikcode_kernel::middleware::AfterOutcome {
        let total = result.content.len();
        // Exempt from compression entirely:
        // 1. the tool declares its result must reach the model verbatim
        //    (intrinsic contract, e.g. code_explore / read_file), OR
        // 2. the tool is in the config-driven whitelist (`no_fold_tools`), OR
        // 3. threshold_bytes == 0 (compression disabled for this instance).
        let in_whitelist = tool.is_some_and(|t| self.no_fold_tools.contains(t.name()));
        if tool.is_some_and(|t| t.never_truncate_result())
            || in_whitelist
            || self.threshold_bytes == 0
        {
            crate::call_signals::record_result_size(&result.call_id, total, false);
            return jeikcode_kernel::middleware::AfterOutcome::Proceed;
        }

        // Effective line: terminal (shell) tools compress at their earlier
        // configured line, but never ABOVE the general one — lowering
        // `[tools.tool_output] max_bytes` tightens every class. `0` on the
        // terminal line drops the early cut entirely. Alias-compatible: the
        // model may call `bash`, the registry resolves `run_command`; both
        // classify as terminal (`is_shell_tool_name`).
        let threshold = match tool.map(|t| t.name()) {
            Some(name) if crate::is_shell_tool_name(name) && self.terminal_threshold_bytes > 0 => {
                self.threshold_bytes.min(self.terminal_threshold_bytes)
            }
            Some(name) if name.starts_with("mcp__") && self.mcp_threshold_bytes > 0 => {
                self.threshold_bytes.min(self.mcp_threshold_bytes)
            }
            _ => self.threshold_bytes,
        };

        let is_failure = is_failure_outcome(result);

        // Pre-spill original content to the artifact store so the marker can
        // reference the exact artifact ID and guarantee 100% lossless recall.
        let artifact_id = if total > 1024 && (total as u64) <= GLOBAL_MAX_CAPACITY {
            self.store.put(result.content.as_bytes()).ok()
        } else {
            None
        };

        // 1. Semantic streamlining: fold giant assertion diffs & compile warnings.
        let streamlined = super::output_sanitizer::streamline_tool_output(
            &result.content,
            is_failure,
            artifact_id.as_deref(),
        );

        let streamlined_shrank = streamlined.len() < result.content.len();
        if streamlined_shrank {
            result.content = streamlined;
        }

        let new_total = result.content.len();
        if new_total <= threshold {
            crate::call_signals::record_result_size(&result.call_id, total, streamlined_shrank);
            return jeikcode_kernel::middleware::AfterOutcome::Proceed;
        }

        // Unified preview: first 1500 + last 2200 bytes with the retrieval
        // handle. ONE shape for every class (terminal or not, success or
        // failure) — callers only vary the threshold.
        let head_end = head_boundary(&result.content, PREVIEW_HEAD_BYTES);
        let tail_begin = tail_start(&result.content, PREVIEW_TAIL_BYTES);
        let head = &result.content[..head_end];
        let tail = &result.content[tail_begin..];

        let elided_content = if tail_begin >= head_end {
            &result.content[head_end..tail_begin]
        } else {
            ""
        };
        let elided_lines = elided_content.lines().count();

        if (new_total as u64) > GLOBAL_MAX_CAPACITY {
            // Runaway process exceeding entire 7GB global ceiling: inline-truncate only.
            let position_desc = if !head.is_empty() && !tail.is_empty() {
                format!("Middle section of output folded ({elided_lines} lines elided)")
            } else {
                format!("Subsequent section of output folded ({elided_lines} lines truncated)")
            };
            let marker = format!(
                "\n\n[{position_desc}. Full output unavailable (exceeds {GLOBAL_MAX_CAPACITY}-byte artifact ceiling).]\n\n"
            );
            result.content = format!("{head}{marker}{tail}");
            crate::call_signals::record_result_size(&result.call_id, total, true);
            return jeikcode_kernel::middleware::AfterOutcome::Proceed;
        }

        let marker = match artifact_id.or_else(|| self.store.put(result.content.as_bytes()).ok()) {
            Some(id) => {
                let position_desc = if !head.is_empty() && !tail.is_empty() {
                    format!("Middle section of output folded ({elided_lines} lines elided)")
                } else {
                    format!("Subsequent section of output folded ({elided_lines} lines truncated)")
                };
                format!(
                    "\n\n[{position_desc}, saved as artifact {id}. \
If current information is insufficient to resolve the issue, \
call `read(path=\"artifact://{id}\", keyword=\"<keyword>\")` or `read(path=\"artifact://{id}\", offset=1, limit=200)` to inspect more. \
Prefer keyword match over sequential reading to quickly retrieve target details.]\n\n"
                )
            }
            None => {
                let position_desc = if !head.is_empty() && !tail.is_empty() {
                    format!("Middle section of output folded ({elided_lines} lines elided)")
                } else {
                    format!("Subsequent section of output folded ({elided_lines} lines truncated)")
                };
                format!("\n\n[{position_desc}. Full output unavailable (could not be saved).]\n\n")
            }
        };
        result.content = format!("{head}{marker}{tail}");
        crate::call_signals::record_result_size(&result.call_id, total, true);
        jeikcode_kernel::middleware::AfterOutcome::Proceed
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn id_is_16_hex_and_deterministic() {
        let a = super::artifact_id(b"hello world");
        let b = super::artifact_id(b"hello world");
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
        assert!(a
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, super::artifact_id(b"hello worlD"));
    }

    #[test]
    fn put_get_roundtrip_and_dedup() {
        let dir = tempfile::tempdir().unwrap();
        let store = super::ArtifactStore::new(dir.path());
        let id = store.put(b"0123456789abcdef").unwrap();
        // dedup: same bytes → same id, one file
        assert_eq!(store.put(b"0123456789abcdef").unwrap(), id);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        // slice
        assert_eq!(store.get(&id, 2, 4).unwrap().unwrap(), b"2345");
        // offset past end → empty
        assert_eq!(store.get(&id, 100, 4).unwrap().unwrap(), b"");
        // limit past end → clamped
        assert_eq!(store.get(&id, 14, 999).unwrap().unwrap(), b"ef");
    }

    #[test]
    fn large_text_artifact_is_gzip_compressed_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = super::ArtifactStore::new_standalone(dir.path());
        let original = "hello world\n".repeat(20_000);
        let id = store.put(original.as_bytes()).unwrap();

        let raw = std::fs::read(dir.path().join(&id)).unwrap();
        assert!(
            raw.starts_with(super::ARTIFACT_GZIP_MAGIC),
            "large UTF-8 text must be gzip-compressed on disk"
        );
        assert!(
            raw.len() < original.len(),
            "compression must reduce disk size"
        );

        assert_eq!(
            store.get(&id, 0, usize::MAX).unwrap().unwrap(),
            original.as_bytes()
        );
        assert_eq!(
            store.get(&id, 10, 5).unwrap().unwrap(),
            original.as_bytes()[10..15].to_vec()
        );
        assert_eq!(store.size(&id).unwrap().unwrap(), original.len() as u64);
    }

    #[test]
    fn small_text_and_binary_artifacts_are_stored_raw() {
        let dir = tempfile::tempdir().unwrap();
        let store = super::ArtifactStore::new_standalone(dir.path());

        let small = b"small text".to_vec();
        let small_id = store.put(&small).unwrap();
        assert!(!std::fs::read(dir.path().join(&small_id))
            .unwrap()
            .starts_with(super::ARTIFACT_GZIP_MAGIC));
        assert_eq!(store.get(&small_id, 0, usize::MAX).unwrap().unwrap(), small);

        let binary = vec![0xFFu8; 128 * 1024];
        let binary_id = store.put(&binary).unwrap();
        assert!(!std::fs::read(dir.path().join(&binary_id))
            .unwrap()
            .starts_with(super::ARTIFACT_GZIP_MAGIC));
        assert_eq!(
            store.get(&binary_id, 0, usize::MAX).unwrap().unwrap(),
            binary
        );
    }

    #[test]
    fn size_is_metadata_len_and_none_for_missing_or_bad_id() {
        let dir = tempfile::tempdir().unwrap();
        let store = super::ArtifactStore::new(dir.path());
        let id = store.put(&b"z".repeat(1234)).unwrap();
        assert_eq!(store.size(&id).unwrap(), Some(1234));
        assert_eq!(store.size("0123456789abcdef").unwrap(), None); // absent
        assert_eq!(store.size("../etc/passwd").unwrap(), None); // traversal → rejected
    }

    #[test]
    fn get_missing_or_bad_id_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let store = super::ArtifactStore::new(dir.path());
        assert!(store.get("0123456789abcdef", 0, 10).unwrap().is_none()); // absent
        assert!(store.get("../etc/passwd", 0, 10).unwrap().is_none()); // traversal → rejected
        assert!(store.get("XYZ", 0, 10).unwrap().is_none()); // non-hex → rejected
    }

    #[tokio::test]
    async fn under_threshold_untouched() {
        use jeikcode_kernel::middleware::{AfterOutcome, ToolMiddleware};
        use jeikcode_kernel::tool::ToolResult;
        let dir = tempfile::tempdir().unwrap();
        let mw = super::ArtifactMiddleware::new(std::sync::Arc::new(super::ArtifactStore::new(
            dir.path(),
        )));
        let mut r = ToolResult {
            call_id: "c".into(),
            content: "small".into(),
            is_error: false,
            images: vec![],
        };
        assert!(matches!(
            mw.after(&mut r, None).await,
            AfterOutcome::Proceed
        ));
        assert_eq!(r.content, "small");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0); // nothing stored
    }

    #[tokio::test]
    async fn over_threshold_stores_and_rewrites_deterministically() {
        use jeikcode_kernel::middleware::ToolMiddleware;
        use jeikcode_kernel::tool::ToolResult;
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(super::ArtifactStore::new(dir.path()));
        let mw = super::ArtifactMiddleware::new(store.clone());
        let big = "x".repeat(super::THRESHOLD_BYTES * 2);
        let mk = || ToolResult {
            call_id: "c".into(),
            content: big.clone(),
            is_error: false,
            images: vec![],
        };

        let mut r1 = mk();
        mw.after(&mut r1, None).await;
        // rewritten: smaller, has head+tail+marker, names artifact and read
        assert!(r1.content.len() < big.len());
        assert!(r1.content.contains("read(path=\"artifact://"));
        let id = super::artifact_id(big.as_bytes());
        assert!(r1.content.contains(&id));
        // artifact holds the FULL original
        assert_eq!(
            store.get(&id, 0, big.len()).unwrap().unwrap(),
            big.as_bytes()
        );

        // determinism: same output → byte-identical rewritten content
        let mut r2 = mk();
        mw.after(&mut r2, None).await;
        assert_eq!(r1.content, r2.content);
        assert!(!r1.is_error);
    }

    #[tokio::test]
    async fn five_mb_output_is_saved_as_artifact_losslessly() {
        use jeikcode_kernel::middleware::ToolMiddleware;
        use jeikcode_kernel::tool::ToolResult;
        let dir = tempfile::tempdir().unwrap();
        let mw = super::ArtifactMiddleware::new(std::sync::Arc::new(super::ArtifactStore::new(
            dir.path(),
        )));
        // 5 MiB output was previously rejected by the 4 MiB ceiling. Now it is preserved losslessly!
        let huge = "y".repeat(5 * 1024 * 1024);
        let mut r = ToolResult {
            call_id: "c".into(),
            content: huge,
            is_error: false,
            images: vec![],
        };
        mw.after(&mut r, None).await;
        assert!(r.content.contains("saved as artifact"));
        assert!(!r.content.contains("Full output unavailable"));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    /// A tool that declares `never_truncate_result() == true` (like code_explore).
    struct NeverTruncateProbe;

    #[async_trait::async_trait]
    impl jeikcode_kernel::tool::Tool for NeverTruncateProbe {
        fn name(&self) -> &str {
            "never_truncate_probe"
        }
        fn description(&self) -> &str {
            "probe that opts out of result truncation"
        }
        fn parameters_schema(&self) -> serde_json::Value {
            serde_json::json!({"type": "object"})
        }
        fn never_truncate_result(&self) -> bool {
            true
        }
        async fn execute(
            &self,
            _args: &str,
            _ctx: &jeikcode_kernel::tool::ToolContext,
        ) -> jeikcode_kernel::tool::ToolResult {
            jeikcode_kernel::tool::ToolResult {
                call_id: String::new(),
                content: String::new(),
                is_error: false,
                images: vec![],
            }
        }
    }

    #[tokio::test]
    async fn never_truncate_tool_output_skips_the_fold() {
        use jeikcode_kernel::middleware::ToolMiddleware;
        use jeikcode_kernel::tool::ToolResult;
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(super::ArtifactStore::new(dir.path()));
        let mw = super::ArtifactMiddleware::new(store.clone());
        let big = "T".repeat(super::THRESHOLD_BYTES + 1); // well over the default threshold
        let mut r = ToolResult {
            call_id: "c".into(),
            content: big.clone(),
            is_error: false,
            images: vec![],
        };
        let probe = NeverTruncateProbe;
        mw.after(&mut r, Some(&probe)).await;
        // Verbatim: no head/tail fold, no marker, no artifact stored.
        assert_eq!(r.content, big);
        assert!(!r.content.contains("output truncated"));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn custom_threshold_folds_sooner() {
        use jeikcode_kernel::middleware::ToolMiddleware;
        use jeikcode_kernel::tool::ToolResult;
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(super::ArtifactStore::new(dir.path()));
        // A small instance threshold: 20 KiB now folds even though it is well
        // under the 64 KiB default.
        let mw = super::ArtifactMiddleware::new(store.clone()).with_threshold_bytes(1024);
        let mid = "m".repeat(20 * 1024);
        let mut r = ToolResult {
            call_id: "c".into(),
            content: mid.clone(),
            is_error: false,
            images: vec![],
        };
        mw.after(&mut r, None).await;
        assert!(
            r.content.len() < mid.len(),
            "must fold under a lowered threshold"
        );
        assert!(
            r.content.contains("read(path=\"artifact://"),
            "must carry the read hint"
        );
        // The default instance leaves the same 20 KiB untouched.
        let mw2 = super::ArtifactMiddleware::new(store.clone());
        let mut r2 = ToolResult {
            call_id: "c".into(),
            content: mid.clone(),
            is_error: false,
            images: vec![],
        };
        mw2.after(&mut r2, None).await;
        assert_eq!(
            r2.content, mid,
            "default 64 KiB threshold must pass 20 KiB verbatim"
        );
    }

    #[tokio::test]
    async fn zero_threshold_disables_folding() {
        use jeikcode_kernel::middleware::ToolMiddleware;
        use jeikcode_kernel::tool::ToolResult;
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(super::ArtifactStore::new(dir.path()));
        let mw = super::ArtifactMiddleware::new(store.clone()).with_threshold_bytes(0);
        let huge = "z".repeat(2 * 1024 * 1024); // far over any default
        let mut r = ToolResult {
            call_id: "c".into(),
            content: huge.clone(),
            is_error: false,
            images: vec![],
        };
        mw.after(&mut r, None).await;
        // Verbatim: no fold, no inline ceiling truncation, no artifact.
        assert_eq!(r.content, huge);
        assert!(!r.content.contains("output truncated"));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    /// A named tool with NO intrinsic opt-out — drives the terminal-class
    /// threshold split through the alias-compatible name check.
    struct NamedProbe(&'static str);

    #[async_trait::async_trait]
    impl jeikcode_kernel::tool::Tool for NamedProbe {
        fn name(&self) -> &str {
            self.0
        }
        fn description(&self) -> &str {
            "probe that carries only a name"
        }
        fn parameters_schema(&self) -> serde_json::Value {
            serde_json::json!({"type": "object"})
        }
        async fn execute(
            &self,
            _args: &str,
            _ctx: &jeikcode_kernel::tool::ToolContext,
        ) -> jeikcode_kernel::tool::ToolResult {
            jeikcode_kernel::tool::ToolResult {
                call_id: String::new(),
                content: String::new(),
                is_error: false,
                images: vec![],
            }
        }
    }

    /// Terminal tools (both `run_command` and its `bash` alias) compress at
    /// `min(configured, 24 KiB)` — 30 KiB folds even with 64 KiB configured,
    /// and the emitted handle resolves to the full text in the store.
    #[tokio::test]
    async fn terminal_tool_compresses_at_the_24k_line() {
        use jeikcode_kernel::middleware::ToolMiddleware;
        use jeikcode_kernel::tool::ToolResult;
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(super::ArtifactStore::new(dir.path()));
        let mw = super::ArtifactMiddleware::new(store.clone()).with_threshold_bytes(64 * 1024);
        let mid = "m".repeat(30 * 1024);
        for probe in [NamedProbe("run_command"), NamedProbe("bash")] {
            let mut r = ToolResult {
                call_id: "c".into(),
                content: mid.clone(),
                is_error: false,
                images: vec![],
            };
            mw.after(&mut r, Some(&probe)).await;
            assert!(
                r.content.contains("section of output folded"),
                "{} must compress above the 24 KiB terminal line",
                probe.0
            );
            assert!(
                r.content.contains("read(path=\"artifact://"),
                "must carry the handle"
            );
            // The handle resolves: the full text is in the artifact store.
            let id = super::artifact_id(mid.as_bytes());
            assert!(r.content.contains(&id));
            assert_eq!(
                store.get(&id, 0, mid.len()).unwrap().unwrap(),
                mid.as_bytes()
            );
        }
    }

    /// Non-terminal tools keep the configured line: 30 KiB sits under 64 KiB.
    #[tokio::test]
    async fn non_terminal_tool_keeps_the_configured_line() {
        use jeikcode_kernel::middleware::ToolMiddleware;
        use jeikcode_kernel::tool::ToolResult;
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(super::ArtifactStore::new(dir.path()));
        let mw = super::ArtifactMiddleware::new(store).with_threshold_bytes(64 * 1024);
        let mid = "m".repeat(30 * 1024);
        let mut r = ToolResult {
            call_id: "c".into(),
            content: mid.clone(),
            is_error: false,
            images: vec![],
        };
        mw.after(&mut r, Some(&NamedProbe("grep"))).await;
        assert_eq!(
            r.content, mid,
            "non-terminal 30 KiB sits under the 64 KiB line"
        );
    }

    /// A terminal result under its 24 KiB line is untouched.
    #[tokio::test]
    async fn terminal_result_under_the_24k_line_is_untouched() {
        use jeikcode_kernel::middleware::ToolMiddleware;
        use jeikcode_kernel::tool::ToolResult;
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(super::ArtifactStore::new(dir.path()));
        let mw = super::ArtifactMiddleware::new(store).with_threshold_bytes(64 * 1024);
        let small = "s".repeat(20 * 1024);
        let mut r = ToolResult {
            call_id: "c".into(),
            content: small.clone(),
            is_error: false,
            images: vec![],
        };
        mw.after(&mut r, Some(&NamedProbe("bash"))).await;
        assert_eq!(r.content, small, "20 KiB is under the 24 KiB terminal line");
    }

    /// A user who lowers `max_bytes` below the terminal cap tightens terminal
    /// tools too: `min(8 KiB, 24 KiB)` folds a 10 KiB console stream.
    #[tokio::test]
    async fn configured_threshold_below_the_terminal_cap_wins() {
        use jeikcode_kernel::middleware::ToolMiddleware;
        use jeikcode_kernel::tool::ToolResult;
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(super::ArtifactStore::new(dir.path()));
        let mw = super::ArtifactMiddleware::new(store).with_threshold_bytes(8 * 1024);
        let mid = "t".repeat(10 * 1024);
        let mut r = ToolResult {
            call_id: "c".into(),
            content: mid.clone(),
            is_error: false,
            images: vec![],
        };
        mw.after(&mut r, Some(&NamedProbe("run_command"))).await;
        assert!(
            r.content.len() < mid.len(),
            "the configured 8 KiB line must beat the 24 KiB terminal cap"
        );
    }

    /// The terminal early line is itself configurable (both directions):
    /// raising it lets more console output through; `0` drops the early cut.
    #[tokio::test]
    async fn terminal_line_follows_its_own_configuration() {
        use jeikcode_kernel::middleware::ToolMiddleware;
        use jeikcode_kernel::tool::ToolResult;
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(super::ArtifactStore::new(dir.path()));
        let mid = "m".repeat(30 * 1024);

        // Raised to 48 KiB: 30 KiB now passes untouched.
        let mw = super::ArtifactMiddleware::new(store.clone())
            .with_threshold_bytes(64 * 1024)
            .with_terminal_threshold_bytes(48 * 1024);
        let mut r = ToolResult {
            call_id: "c".into(),
            content: mid.clone(),
            is_error: false,
            images: vec![],
        };
        mw.after(&mut r, Some(&NamedProbe("bash"))).await;
        assert_eq!(
            r.content, mid,
            "30 KiB sits under the raised 48 KiB terminal line"
        );

        // 0 drops the early line: terminal follows the 64 KiB general line.
        let mw = super::ArtifactMiddleware::new(store)
            .with_threshold_bytes(64 * 1024)
            .with_terminal_threshold_bytes(0);
        let mut r = ToolResult {
            call_id: "c".into(),
            content: mid.clone(),
            is_error: false,
            images: vec![],
        };
        mw.after(&mut r, Some(&NamedProbe("run_command"))).await;
        assert_eq!(
            r.content, mid,
            "terminal line 0 → terminal follows the general line"
        );
    }

    #[tokio::test]
    async fn mcp_tools_are_truncated_with_artifact_id_at_mcp_threshold() {
        use jeikcode_kernel::middleware::ToolMiddleware;
        use jeikcode_kernel::tool::ToolResult;
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(super::ArtifactStore::new(dir.path()));
        let big = "x".repeat(35 * 1024); // 35 KB exceeds 32 KB threshold

        let mw = super::ArtifactMiddleware::new(store.clone())
            .with_threshold_bytes(64 * 1024)
            .with_mcp_threshold_bytes(32 * 1024);

        let mut r = ToolResult {
            call_id: "mcp-call".into(),
            content: big.clone(),
            is_error: false,
            images: vec![],
        };

        mw.after(&mut r, Some(&NamedProbe("mcp__brave_search__web_search")))
            .await;

        assert!(
            r.content.contains(super::ARTIFACT_TRUNCATION_MARKER_PREFIX),
            "MCP tool output exceeding 32 KB must generate standard artifact truncation marker"
        );
        assert!(
            r.content.contains("read(path=\"artifact://"),
            "MCP truncation must instruct LLM to use read with the generated artifact ID"
        );
    }

    #[test]
    fn get_touches_and_updates_mtime_for_true_lru() {
        let dir = tempfile::tempdir().unwrap();
        let store = super::ArtifactStore::new_standalone(dir.path());
        let id = store.put(b"hello lru").unwrap();
        let path = dir.path().join(&id);

        let past = std::time::SystemTime::now() - std::time::Duration::from_secs(300);
        let file = std::fs::File::options().write(true).open(&path).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(past))
            .unwrap();
        let old_mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert!(old_mtime <= past + std::time::Duration::from_secs(1));

        // Call get - should update mtime to recent
        let retrieved = store.get(&id, 0, 100).unwrap().unwrap();
        assert_eq!(retrieved, b"hello lru");

        let new_mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert!(new_mtime > old_mtime);
        assert!(new_mtime >= std::time::SystemTime::now() - std::time::Duration::from_secs(5));
    }
}
