//! `read_file` — read a file (or list a directory) with line numbers and optional
//! slicing. Non-destructive ⇒ always `Safe`. Neutral core ported from the production
//! reader, minus the coding enrichments (semantic skeleton, read_cache, file_store).

use super::{err, looks_binary, not_found_hint, ok, ok_with_images, resolve_path};
use crate::tool_feedback::{format_path_not_found, parse_tool_args};
use async_trait::async_trait;
use base64::Engine;
use jeikcode_kernel::message::ImageContent;
use jeikcode_kernel::tool::{Tool, ToolContext, ToolResult};
use serde::{Deserialize, Serialize};
use serde_json::json;

/// Hard safety ceiling for the current in-memory decoder. Default pagination
/// controls model-visible output, but decoding still needs the complete file for
/// UTF-8/GB18030 detection and codeintel. Refuse pathological inputs uniformly,
/// including callers that supplied an offset/limit.
const MAX_IN_MEMORY_BYTES: u64 = 64 * 1024 * 1024;
/// Default page size when the caller omits `limit`. Midway between Grok (1000)
/// and OpenCode (2000). Remainder is always recoverable via `offset` + omit
/// `limit` (same continuation contract as Grok); do not dump the rest into this page.
pub const READ_LIMIT_DEFAULT: usize = 1500;
/// Default context lines above each key_string match.
pub const READ_UPWARD_DEFAULT: usize = 25;
/// Default context lines below each key_string match.
pub const READ_DOWNWARD_DEFAULT: usize = 75;
/// Hard byte budget for read output (65 KiB = 65536 bytes).
pub const READ_BYTE_BUDGET: usize = 65536;

pub const DEFAULT_READ_LIMIT: usize = READ_LIMIT_DEFAULT;
pub const MAX_READ_OUTPUT_BYTES: usize = READ_BYTE_BUDGET;

/// Per-line display cap (very long minified lines are truncated with a marker).
const MAX_LINE_LEN: usize = 2000;

/// `vision` = the active model can SEE images. When true, reading an image file
/// returns the picture itself (base64) for the model instead of the "binary,
/// cannot display" text dead-end. The capability is decided at the coding layer
/// and passed in as a plain flag — this crate stays model-agnostic (and core-free).
/// Default `false` (text-only).
#[derive(Default)]
pub struct ReadFileTool {
    vision: bool,
}

impl ReadFileTool {
    pub fn new(vision: bool) -> Self {
        Self { vision }
    }
}

/// Range pagination metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RangeMeta {
    pub total_lines: usize,
    pub total_bytes: u64,
    pub start_line: usize,
    pub end_line: usize,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<usize>,
}

impl RangeMeta {
    pub fn build_footer(&self, path: &str) -> String {
        let total_lines = self.total_lines;
        let total_bytes = self.total_bytes;
        let start = self.start_line;
        let end = self.end_line;

        if !self.truncated {
            if start <= 1 && end >= total_lines {
                // 3D: 完整文件一次读完
                format!(
                    "File: {path}\n\
                     Total Lines: {total_lines} | Total Bytes: {total_bytes}\n\
                     Showing lines {start}-{end} | Complete file.\n"
                )
            } else {
                // 3C: 读到末尾
                format!(
                    "File: {path}\n\
                     Total Lines: {total_lines} | Total Bytes: {total_bytes}\n\
                     Showing lines {start}-{end} | End of file.\n"
                )
            }
        } else {
            // 3A / 3B: 未读完 / 字节截断
            let next_offset = self.next_offset.unwrap_or(end + 1);
            format!(
                "File: {path}\n\
                 Total Lines: {total_lines} | Total Bytes: {total_bytes}\n\
                 Showing lines {start}-{end} | Remaining: {next_offset}-{total_lines}\n\
                 To continue: call `read` with offset={next_offset}.\n\
                 Reading several hundred lines, or the whole file, in one call is safe and expected.\n"
            )
        }
    }
}

/// KeyString search window metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyStringMeta {
    pub total_lines: usize,
    pub total_bytes: u64,
    pub key_string: String,
    pub total_matches: usize,
    pub shown_matches: usize,
    pub upward: usize,
    pub downward: usize,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_offset: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_limit: Option<usize>,
}

impl KeyStringMeta {
    pub fn build_footer(&self, path: &str) -> String {
        let total_lines = self.total_lines;
        let total_bytes = self.total_bytes;
        let key_string = &self.key_string;

        if !self.truncated {
            if self.total_matches == 0 {
                // 4D: 无匹配
                format!(
                    "File: {path}\n\
                     Total Lines: {total_lines} | Total Bytes: {total_bytes}\n\
                     No match for \"{key_string}\" (case-insensitive).\n\
                     Try a shorter or different snippet, or use `grep` to locate the symbol first.\n"
                )
            } else {
                // 4A: 有匹配，全部展示
                format!(
                    "File: {path}\n\
                     Total Lines: {total_lines} | Total Bytes: {total_bytes}\n\
                     Matched {} occurrence(s) of \"{key_string}\" (case-insensitive).\n\
                     Window: {} lines above / {} lines below each match.\n",
                    self.total_matches, self.upward, self.downward,
                )
            }
        } else if self.truncated_by.as_deref() == Some("bytes") {
            // 4C: 窗口被 65 KiB 截断（引导回分页模式）
            let match_num = self.shown_matches.max(1);
            let offset = self.fallback_offset.unwrap_or(1);
            let limit = self.fallback_limit.unwrap_or(READ_LIMIT_DEFAULT);
            format!(
                "File: {path}\n\
                 Total Lines: {total_lines} | Total Bytes: {total_bytes}\n\
                 Matched {} occurrence(s) of \"{key_string}\" (case-insensitive).\n\
                 Window truncated at byte budget; showing partial context around match {match_num}.\n\
                 To get full context: use `read` with offset={offset} and limit={limit}.\n",
                self.total_matches,
            )
        } else {
            // 4B: 被 max_matches 截断
            format!(
                "File: {path}\n\
                 Total Lines: {total_lines} | Total Bytes: {total_bytes}\n\
                 Matched {} occurrence(s) of \"{key_string}\" (case-insensitive).\n\
                 Showing first {} matches.\n\
                 Window: {} lines above / {} lines below each match.\n\
                 To see more: increase `max_matches`, or narrow `key_string` to a more specific snippet.\n",
                self.total_matches,
                self.shown_matches,
                self.upward,
                self.downward,
            )
        }
    }
}

/// Tagged metadata container for ReadResponse.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode")]
pub enum ReadMeta {
    #[serde(rename = "range")]
    Range(RangeMeta),
    #[serde(rename = "key_string")]
    KeyString(KeyStringMeta),
}

/// Unified response envelope returned by ReadFileTool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadResponse {
    pub path: String,
    pub mode: String,
    pub content: String,
    pub footer: String,
    pub meta: ReadMeta,
}

impl ReadResponse {
    pub fn new(path: String, content: String, footer: String, meta: ReadMeta) -> Self {
        let mode = match &meta {
            ReadMeta::Range(_) => "range".to_string(),
            ReadMeta::KeyString(_) => "key_string".to_string(),
        };
        Self {
            path,
            mode,
            content,
            footer,
            meta,
        }
    }
}

pub fn continuation_footer(
    path: &str,
    total_bytes: u64,
    start: usize,
    end: usize,
    total: usize,
) -> String {
    let meta = RangeMeta {
        total_lines: total,
        total_bytes,
        start_line: start,
        end_line: end,
        truncated: end < total,
        truncated_by: if end < total {
            Some("lines".to_string())
        } else {
            None
        },
        next_offset: if end < total { Some(end + 1) } else { None },
    };
    meta.build_footer(path)
}

/// Cap on an image read back to a vision model: base64 inflates ~33% and every image
/// costs ~1600 tokens, so refuse an oversized one (it would blow the result-size cap /
/// context) and fall back to the binary-text hint. Generous enough for book covers,
/// screenshots, diagrams (the real use cases).
const MAX_IMAGE_BYTES: u64 = 4 * 1024 * 1024;

/// MIME type for an image file by extension, or `None` if not a recognized raster image.
/// Gates which binaries `read_file` hands to a vision model — only true images, never a
/// PDF / archive / executable (those keep the text recovery hint). The set matches what
/// the providers actually accept AND the user-paste path (png/jpg/jpeg/gif/webp); BMP is
/// deliberately EXCLUDED — neither the OpenAI nor Anthropic vision wire format accepts it,
/// so handing one over would be a hard gateway rejection, strictly worse than the
/// binary-text dead-end it would replace.
fn image_media_type(path: &std::path::Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    })
}

#[derive(Deserialize)]
struct Args {
    #[serde(alias = "file_path")]
    path: String,
    #[serde(default, deserialize_with = "lenient_isize")]
    offset: Option<isize>,
    #[serde(default, deserialize_with = "lenient_usize")]
    limit: Option<usize>,
    /// Keyword or code snippet to focus on (case-insensitive, centers window around match).
    #[serde(
        default,
        alias = "KeyString",
        alias = "keystring",
        alias = "focus",
        alias = "anchor"
    )]
    key_string: Option<String>,
    /// Number of context lines above the matched anchor (default 25). Only provide when key_string is specified.
    #[serde(default, deserialize_with = "lenient_usize")]
    upward: Option<usize>,
    /// Number of context lines below the matched anchor (default 75). Only provide when key_string is specified.
    #[serde(default, deserialize_with = "lenient_usize")]
    downward: Option<usize>,
    /// Maximum number of matches to display when key_string multiple matches exist.
    #[serde(
        default,
        alias = "match_count",
        alias = "max_results",
        deserialize_with = "lenient_usize"
    )]
    max_matches: Option<usize>,
}

/// Deserialize an isize that weak models may send as a float, string, or negative integer.
/// Negative values represent tail-read offset (e.g. -30 for last 30 lines).
pub(crate) fn lenient_isize<'de, D>(d: D) -> Result<Option<isize>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Num {
        I(i64),
        F(f64),
        S(String),
    }
    Ok(match Option::<Num>::deserialize(d)? {
        None => None,
        Some(Num::I(n)) => Some(
            isize::try_from(n)
                .map_err(|_| serde::de::Error::custom("value exceeds isize range"))?,
        ),
        Some(Num::F(f)) => {
            if !f.is_finite() || f.fract() != 0.0 {
                return Err(serde::de::Error::custom("invalid float for offset"));
            }
            Some(f as isize)
        }
        Some(Num::S(s)) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else if let Ok(n) = t.parse::<isize>() {
                Some(n)
            } else if let Ok(f) = t.parse::<f64>() {
                if !f.is_finite() || f.fract() != 0.0 {
                    return Err(serde::de::Error::custom("invalid float for offset"));
                }
                Some(f as isize)
            } else {
                return Err(serde::de::Error::custom("cannot parse offset"));
            }
        }
    })
}

/// Deserialize a usize that weak models may send as a float or a string (`50`, `"50"`,
/// `50.0`, `"50.0"`) instead of an integer. Absent / null / empty → `None`.
/// Shared with `grep` (max_results/context) — keep this the single source.
pub(crate) fn lenient_usize<'de, D>(d: D) -> Result<Option<usize>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Num {
        U(u64),
        F(f64),
        S(String),
    }
    // Be lenient about the representation, not the value: weak models commonly
    // emit `50.0`/`"50.0"` for an integer field, but a true fraction has no
    // unambiguous offset/limit meaning. Reject invalid and out-of-range values
    // instead of letting Rust's float cast silently truncate or saturate them.
    fn checked(f: f64) -> Result<usize, &'static str> {
        // Near the IEEE-754 safe-integer edge, the serde_json + untagged path
        // can already map adjacent decimal spellings to the same f64. Keep a
        // conservative guard below that edge; callers can still send an exact
        // JSON integer or integer string, both handled without f64.
        const FLOAT_INTEGER_EXACT_LIMIT: f64 = 4_503_599_627_370_496.0; // 2^52
        if !f.is_finite() || f < 0.0 {
            return Err("negative or non-finite value not allowed");
        }
        if f.fract() != 0.0 {
            return Err("fractional value not allowed");
        }
        if f >= FLOAT_INTEGER_EXACT_LIMIT {
            return Err("floating-point integer exceeds exact range");
        }
        let n = f as u128;
        usize::try_from(n).map_err(|_| "value exceeds usize range")
    }
    Ok(match Option::<Num>::deserialize(d)? {
        None => None,
        Some(Num::U(n)) => Some(
            usize::try_from(n)
                .map_err(|_| serde::de::Error::custom("value exceeds usize range"))?,
        ),
        Some(Num::F(f)) => Some(checked(f).map_err(serde::de::Error::custom)?),
        Some(Num::S(s)) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else if let Ok(n) = t.parse::<usize>() {
                Some(n)
            } else {
                let f = t.parse::<f64>().map_err(serde::de::Error::custom)?;
                Some(checked(f).map_err(serde::de::Error::custom)?)
            }
        }
    })
}

#[async_trait]
impl Tool for ReadFileTool {
    fn name(&self) -> &str {
        "read"
    }
    fn aliases(&self) -> &'static [&'static str] {
        &["read_file"]
    }
    fn description(&self) -> &str {
        "Read file content generously (reading several hundred lines or the whole file in one call is safe and expected), view images, or list directories."
    }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the file or directory to inspect."
                },
                "offset": {
                    "type": "integer",
                    "description": "1-based starting line. Supports negative values to read from tail (e.g. -200). Use with `limit` to page large files. Ignored when key_string is provided."
                },
                "limit": {
                    "type": "integer",
                    "description": "Number of lines to read from `offset` (defaults to 1500). Reading several hundred lines or the whole file in one call is safe and expected. Ignored when key_string is provided."
                },
                "key_string": {
                    "type": "string",
                    "description": "Optional snippet to center the reading window around (case-insensitive). When provided, `offset` and `limit` are ignored; use `upward`, `downward`, and `max_matches` instead."
                },
                "upward": {
                    "type": "integer",
                    "description": "Context lines above each key_string match (default 25). Used only when key_string is specified; ignored otherwise."
                },
                "downward": {
                    "type": "integer",
                    "description": "Context lines below each key_string match (default 75). Used only when key_string is specified; ignored otherwise."
                },
                "max_matches": {
                    "type": "integer",
                    "description": "Maximum matches to show for key_string. Used only when key_string is specified; ignored otherwise. If omitted, all matches are shown."
                }
            },
            "required": ["path"]
        })
    }
    /// No side effects — a pure read. Makes it `parallel_safe` (concurrent
    /// execution) and allowed in plan mode.
    fn read_only_hint(&self) -> bool {
        true
    }
    /// Self-capped to `MAX_READ_OUTPUT_BYTES` (65 KiB). Skipping the generic 64 KiB artifact
    /// fold / kernel cap is what makes one numbered page reach the model; remainder
    /// is recovered with `offset` (Grok-style), not `fetch_output`.
    fn never_truncate_result(&self) -> bool {
        true
    }
    // read is non-destructive → risk() defaults to Safe.
    async fn execute(&self, args: &str, ctx: &ToolContext) -> ToolResult {
        let a: Args = match parse_tool_args("read", args, r#"{"path":"<path>"}"#)
            .or_else(|_| parse_tool_args("read_file", args, r#"{"path":"<path>"}"#))
        {
            Ok(a) => a,
            Err(e) => return e.into_tool_result(),
        };
        if a.limit == Some(0) {
            return err("read: `limit` must be at least 1.");
        }
        let path = resolve_path(&a.path, &ctx.working_dir);
        let display_path = crate::pathnorm::to_display(&path);

        let meta = match tokio::fs::metadata(&path).await {
            Ok(m) => m,
            Err(_) => {
                let hint = not_found_hint(&path, &ctx.working_dir).await;
                return err(format!(
                    "{}{hint}",
                    format_path_not_found("read", &a.path, &path, &ctx.working_dir)
                ));
            }
        };

        if meta.is_dir() {
            // When reading a directory with NO pagination/slicing arguments,
            // prefer rendering a clean 2-level architectural overview from CodeIndex.
            let _has_explicit_pagination = a.offset.is_some()
                || a.limit.is_some()
                || a.key_string.is_some()
                || a.downward.is_some()
                || a.upward.is_some();

            #[cfg(feature = "codeintel")]
            if !_has_explicit_pagination {
                let index = crate::codeintel::shared_code_index();
                if let Some(tree) = crate::codeintel::repo_map::render_two_level_tree_from_index(
                    &index,
                    &path,
                    &ctx.working_dir,
                ) {
                    crate::tools::write_state::record_read(&path);
                    return ok(tree);
                }
            }

            struct DirItem {
                is_dir: bool,
                name: String,
                name_lower: String,
                rendered: String,
            }
            let mut items = Vec::new();
            if let Ok(mut rd) = tokio::fs::read_dir(&path).await {
                while let Ok(Some(e)) = rd.next_entry().await {
                    let is_dir = e.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
                    let name = e.file_name().to_string_lossy().to_string();
                    let rendered = if is_dir {
                        format!("{name}/")
                    } else {
                        name.clone()
                    };
                    items.push(DirItem {
                        is_dir,
                        name_lower: name.to_lowercase(),
                        name,
                        rendered,
                    });
                }
            }

            // Directories first (OpenCode / Grok-build pattern), then case-insensitive by name
            items.sort_by(|a, b| {
                (!a.is_dir)
                    .cmp(&(!b.is_dir))
                    .then_with(|| a.name_lower.cmp(&b.name_lower))
                    .then_with(|| a.name.cmp(&b.name))
            });

            let total = items.len();
            let start_idx = match a.offset {
                Some(neg) if neg < 0 => total.saturating_sub(neg.unsigned_abs()),
                Some(pos) => (pos.max(1) as usize).saturating_sub(1),
                None => 0,
            };
            let count = a.limit.unwrap_or(READ_LIMIT_DEFAULT);
            let end_idx = start_idx.saturating_add(count).min(total);
            let mut out = if total == 0 {
                format!("[Directory: {display_path} (empty)]\n")
            } else if start_idx == 0 && end_idx == total {
                format!("[Directory: {display_path} ({total} entries)]\n")
            } else {
                format!(
                    "[Directory: {display_path} (showing entries {}-{} of {total})]\n",
                    start_idx + 1,
                    end_idx
                )
            };

            for item in &items[start_idx..end_idx] {
                if out
                    .len()
                    .saturating_add(item.rendered.len())
                    .saturating_add(1)
                    > MAX_READ_OUTPUT_BYTES
                {
                    out.push_str("\n... [Output budget reached; remaining entries omitted]");
                    break;
                }
                out.push_str(&item.rendered);
                out.push('\n');
            }

            if end_idx < total {
                let next = end_idx + 1;
                out.push_str(&format!(
                    "\n[Showing entries {}-{} of {total}. (Next offset: {next})]",
                    start_idx + 1,
                    end_idx
                ));
            } else if start_idx > 0 {
                out.push_str(&format!(
                    "\n[Showing entries {}-{} of {total} (End of directory)]",
                    start_idx + 1,
                    end_idx
                ));
            }

            crate::tools::write_state::record_read(&path);
            return ok(out.trim_end().to_string());
        }

        if meta.len() > MAX_IN_MEMORY_BYTES {
            return err(format!(
                "File too large for read_file's in-memory decoder: {} bytes ({:.1} MB; \
                 limit is {:.0} MB). Use grep/code_explore to locate relevant content, or \
                 bash (sed -n / rg) to read a bounded range.",
                meta.len(),
                meta.len() as f64 / 1_048_576.0,
                MAX_IN_MEMORY_BYTES as f64 / 1_048_576.0,
            ));
        }

        let bytes = match tokio::fs::read(&path).await {
            Ok(b) => b,
            Err(e) => {
                return err(format!(
                    "read_file: failed to read {}: {e}",
                    crate::pathnorm::to_display(&path)
                ))
            }
        };
        if looks_binary(&bytes) {
            // VISION path: an image file read by a model that can SEE → hand back the
            // picture itself (base64) so it reaches the model on a follow-up user
            // message, instead of the "cannot display" text dead-end. Gated on
            // `self.vision` (model capability) AND a recognized image type AND a sane
            // size; anything else keeps the existing binary-text + recovery hint.
            if self.vision && meta.len() <= MAX_IMAGE_BYTES {
                if let Some(media_type) = image_media_type(&path) {
                    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    return ok_with_images(
                        format!(
                            "[Image output: {} ({} bytes) — attached below for the vision model]",
                            a.path,
                            bytes.len()
                        ),
                        vec![ImageContent {
                            media_type: media_type.to_string(),
                            data,
                        }],
                    );
                }
            }
            return ok(format!(
                "Binary file ({} bytes), cannot display as text.{}",
                bytes.len(),
                binary_recovery_hint(&path, &a.path),
            ));
        }

        // Decode: prefer UTF-8; fall back to GB18030 (GBK/GB2312 superset) for text-ish
        // extensions. Chinese Windows editors write .txt/.md/.csv as GBK, which a lossy
        // UTF-8 decode would mangle into replacement chars (mojibake). If neither decodes,
        // treat it as binary and hand back a recovery hint.
        let text: std::borrow::Cow<str> = match std::str::from_utf8(&bytes) {
            Ok(s) => std::borrow::Cow::Borrowed(s),
            Err(_) => match crate::tools::encoding::decode_non_utf8_text(&path, &bytes) {
                Some(s) => std::borrow::Cow::Owned(s),
                None => {
                    return ok(format!(
                        "Binary file ({} bytes), cannot display as text.{}",
                        bytes.len(),
                        binary_recovery_hint(&path, &a.path),
                    ))
                }
            },
        };
        // Count and page with iterators instead of collecting `Vec<&str>`: a file
        // containing millions of tiny lines would otherwise spend far more memory
        // on line pointers than on the bounded source bytes themselves.
        let file_lines: Vec<&str> = text.lines().collect();
        let total = file_lines.len();

        // ─────────────────────────────────────────────────────────────────────────────
        // Window slicing: Anchor Search (key_string) vs Direct Offset (positive / tail)
        // ─────────────────────────────────────────────────────────────────────────────
        const JSON_RESERVE_BYTES: usize = 2048;

        if let Some(ref target) = a.key_string {
            let up = a.upward.unwrap_or(READ_UPWARD_DEFAULT);
            let down = a.downward.unwrap_or(READ_DOWNWARD_DEFAULT);

            // Silent absorption: offset and limit are ignored in key_string mode
            let (matched_indices, snippet_lines, clean_needle) =
                find_key_string_matches_robust(&text, target, false, 0);

            if matched_indices.is_empty() {
                // 4D: 无匹配
                let km = KeyStringMeta {
                    total_lines: total,
                    total_bytes: meta.len(),
                    key_string: target.clone(),
                    total_matches: 0,
                    shown_matches: 0,
                    upward: up,
                    downward: down,
                    truncated: false,
                    truncated_by: None,
                    fallback_offset: None,
                    fallback_limit: None,
                };
                let footer = km.build_footer(&display_path);
                let response = ReadResponse::new(
                    a.path.clone(),
                    String::new(),
                    footer,
                    ReadMeta::KeyString(km),
                );
                crate::tools::write_state::record_read(&path);
                return ok(serde_json::to_string_pretty(&response).unwrap_or_default());
            }

            let total_matches = matched_indices.len();
            let limit_count = a.max_matches.unwrap_or(total_matches);
            let chosen = &matched_indices[..total_matches.min(limit_count)];

            let mut out = String::new();
            let mut truncated_by_bytes = false;
            let mut truncated_match_num = 1;
            let mut fb_offset = None;
            let mut fb_limit = None;

            if total_matches == 1 {
                let found = matched_indices[0];
                let s_idx = found.saturating_sub(up);
                let e_idx = (found + snippet_lines + down).min(total);
                let cur_offset = s_idx + 1;
                let cur_limit = e_idx.saturating_sub(s_idx);

                out.push_str(&format!("[KeyString matched at line {}]\n", found + 1));
                for line_idx in s_idx..e_idx {
                    let line = file_lines[line_idx];
                    let n = line_idx + 1;
                    let rendered = if line.chars().count() > MAX_LINE_LEN {
                        let head: String = line.chars().take(MAX_LINE_LEN).collect();
                        format!("{n}→{head}... (line truncated to {MAX_LINE_LEN} chars)\n")
                    } else {
                        format!("{n}→{line}\n")
                    };
                    if out
                        .len()
                        .saturating_add(rendered.len())
                        .saturating_add(JSON_RESERVE_BYTES)
                        > READ_BYTE_BUDGET
                    {
                        truncated_by_bytes = true;
                        fb_offset = Some(cur_offset);
                        fb_limit = Some(cur_limit);
                        break;
                    }
                    out.push_str(&rendered);
                }
            } else {
                out.push_str(&format!(
                    "[Found {} matches for key_string {:?} (showing {}):]\n",
                    total_matches,
                    clean_needle,
                    chosen.len()
                ));
                for (match_idx, &found) in chosen.iter().enumerate() {
                    let match_header = format!(
                        "\n--- [Match {}] at line {} ---\n",
                        match_idx + 1,
                        found + 1
                    );
                    let s_idx = found.saturating_sub(up);
                    let e_idx = (found + snippet_lines + down).min(total);
                    let cur_offset = s_idx + 1;
                    let cur_limit = e_idx.saturating_sub(s_idx);

                    if out
                        .len()
                        .saturating_add(match_header.len())
                        .saturating_add(JSON_RESERVE_BYTES)
                        > READ_BYTE_BUDGET
                    {
                        truncated_by_bytes = true;
                        truncated_match_num = match_idx + 1;
                        fb_offset = Some(cur_offset);
                        fb_limit = Some(cur_limit);
                        break;
                    }
                    out.push_str(&match_header);

                    let mut match_truncated = false;
                    for line_idx in s_idx..e_idx {
                        let line = file_lines[line_idx];
                        let n = line_idx + 1;
                        let mark = if line_idx >= found && line_idx < found + snippet_lines {
                            ">>>"
                        } else {
                            "   "
                        };
                        let rendered = if line.chars().count() > MAX_LINE_LEN {
                            let head: String = line.chars().take(MAX_LINE_LEN).collect();
                            format!(
                                "{mark}{n}→{head}... (line truncated to {MAX_LINE_LEN} chars)\n"
                            )
                        } else {
                            format!("{mark}{n}→{line}\n")
                        };
                        if out
                            .len()
                            .saturating_add(rendered.len())
                            .saturating_add(JSON_RESERVE_BYTES)
                            > READ_BYTE_BUDGET
                        {
                            truncated_by_bytes = true;
                            truncated_match_num = match_idx + 1;
                            fb_offset = Some(cur_offset);
                            fb_limit = Some(cur_limit);
                            match_truncated = true;
                            break;
                        }
                        out.push_str(&rendered);
                    }
                    if match_truncated {
                        break;
                    }
                }
            }

            let (truncated, truncated_by, fallback_offset, fallback_limit) = if truncated_by_bytes {
                (true, Some("bytes".to_string()), fb_offset, fb_limit)
            } else if total_matches > chosen.len() {
                (true, Some("max_matches".to_string()), None, None)
            } else {
                (false, None, None, None)
            };

            let km = KeyStringMeta {
                total_lines: total,
                total_bytes: meta.len(),
                key_string: target.clone(),
                total_matches,
                shown_matches: if truncated_by_bytes {
                    truncated_match_num
                } else {
                    chosen.len()
                },
                upward: up,
                downward: down,
                truncated,
                truncated_by,
                fallback_offset,
                fallback_limit,
            };
            let footer = km.build_footer(&display_path);
            let response = ReadResponse::new(a.path.clone(), out, footer, ReadMeta::KeyString(km));
            crate::tools::write_state::record_read(&path);
            return ok(serde_json::to_string_pretty(&response).unwrap_or_default());
        }

        // ─────────────────────────────────────────────────────────────────────────────
        // Range Mode (Direct Offset / Tail / Slicing)
        // ─────────────────────────────────────────────────────────────────────────────
        // Silent absorption: upward, downward, max_matches are ignored in range mode
        let (start, start_idx, page_limit) = {
            let (s, s_idx) = match a.offset {
                Some(neg) if neg < 0 => {
                    let n = neg.unsigned_abs();
                    let start = total.saturating_sub(n);
                    (start + 1, start)
                }
                Some(pos) => {
                    let p = pos.max(1) as usize;
                    (p, p - 1)
                }
                None => (1, 0),
            };
            let count = a.limit.unwrap_or(READ_LIMIT_DEFAULT);
            (s, s_idx, count)
        };

        if start_idx >= total && total > 0 {
            let rm = RangeMeta {
                total_lines: total,
                total_bytes: meta.len(),
                start_line: start,
                end_line: total,
                truncated: false,
                truncated_by: None,
                next_offset: None,
            };
            let footer = rm.build_footer(&display_path);
            let response = ReadResponse::new(
                a.path.clone(),
                format!("[no lines in requested range (start={start}, total={total})]\n"),
                footer,
                ReadMeta::Range(rm),
            );
            crate::tools::write_state::record_read(&path);
            return ok(serde_json::to_string_pretty(&response).unwrap_or_default());
        }
        let skill_md = path.file_name().is_some_and(|n| n == "SKILL.md");
        let effective_limit = if skill_md {
            a.limit.unwrap_or(usize::MAX)
        } else {
            page_limit
        };
        let requested_end_idx = start_idx.saturating_add(effective_limit).min(total);

        let mut out = String::new();
        let mut end_idx = start_idx;
        // Small pages (explicit small `limit`, or a short file) number every line so
        // the model can cite exact ranges. Large pages keep sparse anchors to save tokens.
        const DENSE_LINE_NUMBER_CAP: usize = 200;
        let page_lines = requested_end_idx.saturating_sub(start_idx);
        let dense_numbers = page_lines <= DENSE_LINE_NUMBER_CAP;
        let mut truncated_by_bytes = false;

        for (i, line) in text
            .lines()
            .skip(start_idx)
            .take(requested_end_idx - start_idx)
            .enumerate()
        {
            let n = start + i;
            let is_anchor = dense_numbers || i == 0 || n % 10 == 0;
            let rendered = if line.chars().count() > MAX_LINE_LEN {
                let head: String = line.chars().take(MAX_LINE_LEN).collect();
                if is_anchor {
                    format!("{n}→{head}... (line truncated to {MAX_LINE_LEN} chars)\n")
                } else {
                    format!("{head}... (line truncated to {MAX_LINE_LEN} chars)\n")
                }
            } else if is_anchor {
                format!("{n}→{line}\n")
            } else {
                format!("{line}\n")
            };
            let candidate_end = start_idx + i + 1;
            if !skill_md
                && !out.is_empty()
                && out
                    .len()
                    .saturating_add(rendered.len())
                    .saturating_add(JSON_RESERVE_BYTES)
                    > READ_BYTE_BUDGET
            {
                truncated_by_bytes = true;
                break;
            }
            out.push_str(&rendered);
            end_idx = candidate_end;
        }

        let (truncated, truncated_by, next_offset) = if truncated_by_bytes {
            (true, Some("bytes".to_string()), Some(end_idx + 1))
        } else if end_idx < total {
            (true, Some("lines".to_string()), Some(end_idx + 1))
        } else {
            (false, None, None)
        };

        let rm = RangeMeta {
            total_lines: total,
            total_bytes: meta.len(),
            start_line: if total == 0 { 0 } else { start },
            end_line: if total == 0 { 0 } else { end_idx },
            truncated,
            truncated_by,
            next_offset,
        };
        let footer = rm.build_footer(&display_path);
        let response = ReadResponse::new(a.path.clone(), out, footer, ReadMeta::Range(rm));

        crate::tools::write_state::record_read(&path);
        ok(serde_json::to_string_pretty(&response).unwrap_or_default())
    }
}

/// Build a recovery hint for a file that couldn't be decoded as text. Lets the model
/// pivot to an external converter (pandoc / pdftotext / unzip for .docx) on the first
/// failure instead of cycling through offset/limit values for 30 turns.
fn binary_recovery_hint(path: &std::path::Path, full_path_str: &str) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let q = shell_quote(full_path_str);
    match ext.as_str() {
        "doc" => format!(
            "\n\n[Recovery] This is a legacy Word (.doc) binary. Run one of:\n\
             - bash: `antiword {q}`\n\
             - bash: `pandoc {q} -t plain`\n\
             - bash: `catdoc {q}`"
        ),
        "docx" => format!(
            "\n\n[Recovery] This is a modern Word (.docx) — a zip containing XML. Run:\n\
             - bash: `unzip -p {q} word/document.xml | sed 's/<[^>]*>//g'`\n\
             - or: `pandoc {q} -t plain`"
        ),
        "xls" => format!(
            "\n\n[Recovery] Legacy Excel (.xls). Run:\n\
             - bash: `libreoffice --headless --convert-to csv --outdir /tmp {q} && cat /tmp/*.csv`"
        ),
        "xlsx" => format!(
            "\n\n[Recovery] Modern Excel (.xlsx). Run:\n\
             - bash: `libreoffice --headless --convert-to csv --outdir /tmp {q} && cat /tmp/*.csv`\n\
             - or: `unzip -p {q} xl/sharedStrings.xml` (raw string table)"
        ),
        "ppt" | "pptx" => format!(
            "\n\n[Recovery] PowerPoint. Run:\n\
             - bash: `pandoc {q} -t plain`"
        ),
        "pdf" => format!(
            "\n\n[Recovery] PDF. Run:\n\
             - bash: `pdftotext {q} -` (poppler)\n\
             - or: `mutool draw -F txt {q}`"
        ),
        "rtf" => format!(
            "\n\n[Recovery] RTF. Run:\n\
             - bash: `pandoc {q} -t plain`\n\
             - or: `unrtf --text {q}`"
        ),
        _ => "\n\n[Hint] The file is not UTF-8 and not a recognised text extension. \
             If it's text in another encoding, ask the user; if it's a packaged format \
             (archive, installer, media), there is no point reading it as text."
            .to_string(),
    }
}

/// Minimal shell-quoter for embedding a path in a bash command suggestion.
/// POSIX single-quoted form: wraps in `'`, escapes any existing `'` as `'\''`.
fn shell_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str(r"'\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Multi-line, cross-platform robust matching for `key_string`:
/// - Strips Markdown code block fences (```), invisible BOM/zero-width chars, and line prefix arrows (e.g. 12→).
/// - Normalizes line endings (\r\n -> \n) to eliminate Windows/Unix discrepancies.
/// - Resolves escape discrepancies: handles literal `\n`, `\t`, and escaped quotes.
/// - Performs 4-tier cascade matching: exact substring, unescaped, case-insensitive, and line-trimmed whitespace tolerant.
/// - Returns (sorted_matching_line_indices, snippet_line_span, cleaned_target).
fn find_key_string_matches_robust(
    content: &str,
    raw_target: &str,
    is_backward: bool,
    search_start_line: usize,
) -> (Vec<usize>, usize, String) {
    let clean_target = sanitize_target_snippet(raw_target);
    if clean_target.trim().is_empty() {
        return (Vec::new(), 1, clean_target);
    }

    let norm_content = normalize_content_text(content);
    let norm_target = clean_target.replace("\r\n", "\n").replace('\r', "\n");
    let unescaped_target = unescape_literal_escapes(&norm_target);
    let snippet_lines = norm_target
        .lines()
        .count()
        .max(unescaped_target.lines().count())
        .max(1);

    let mut matches = Vec::new();

    // Tier 1: Literal multi-line substring containment
    let mut pos = 0;
    while let Some(rel) = norm_content[pos..].find(&norm_target) {
        let abs_pos = pos + rel;
        let line_idx = norm_content[..abs_pos]
            .bytes()
            .filter(|&b| b == b'\n')
            .count();
        matches.push(line_idx);
        pos = abs_pos + norm_target.len().max(1);
    }

    // Tier 2: Unescaped literal string containment (recovers model's literal `\n` or `\t` into real linebreaks)
    if matches.is_empty() && unescaped_target != norm_target {
        let mut pos = 0;
        while let Some(rel) = norm_content[pos..].find(&unescaped_target) {
            let abs_pos = pos + rel;
            let line_idx = norm_content[..abs_pos]
                .bytes()
                .filter(|&b| b == b'\n')
                .count();
            matches.push(line_idx);
            pos = abs_pos + unescaped_target.len().max(1);
        }
    }

    // Tier 3: Case-insensitive multi-line containment
    if matches.is_empty() {
        let lower_content = norm_content.to_ascii_lowercase();
        let lower_target = norm_target.to_ascii_lowercase();
        let mut pos = 0;
        while let Some(rel) = lower_content[pos..].find(&lower_target) {
            let abs_pos = pos + rel;
            let line_idx = norm_content[..abs_pos]
                .bytes()
                .filter(|&b| b == b'\n')
                .count();
            matches.push(line_idx);
            pos = abs_pos + lower_target.len().max(1);
        }

        if matches.is_empty() && unescaped_target != norm_target {
            let lower_unescaped = unescaped_target.to_ascii_lowercase();
            let mut pos = 0;
            while let Some(rel) = lower_content[pos..].find(&lower_unescaped) {
                let abs_pos = pos + rel;
                let line_idx = norm_content[..abs_pos]
                    .bytes()
                    .filter(|&b| b == b'\n')
                    .count();
                matches.push(line_idx);
                pos = abs_pos + lower_unescaped.len().max(1);
            }
        }
    }

    // Tier 4: Line-trimmed whitespace tolerance (handles indentation/tab/trailing space/quote diffs)
    if matches.is_empty() {
        let effective_target = if unescaped_target.lines().count() > norm_target.lines().count() {
            &unescaped_target
        } else {
            &norm_target
        };
        let target_lines: Vec<String> = effective_target
            .lines()
            .map(|l| normalize_quotes_and_trim(l))
            .filter(|l| !l.is_empty())
            .collect();
        if !target_lines.is_empty() {
            let content_lines: Vec<String> = norm_content
                .lines()
                .map(|l| normalize_quotes_and_trim(l))
                .collect();
            let span = target_lines.len();
            for i in 0..content_lines.len() {
                if i + span <= content_lines.len() {
                    let mut matched = true;
                    for (j, t_line) in target_lines.iter().enumerate() {
                        let c_line = &content_lines[i + j];
                        if !c_line.contains(t_line)
                            && !c_line
                                .to_ascii_lowercase()
                                .contains(&t_line.to_ascii_lowercase())
                        {
                            matched = false;
                            break;
                        }
                    }
                    if matched {
                        matches.push(i);
                    }
                }
            }
        }
    }

    matches.dedup();

    let sorted_matches: Vec<usize> = if is_backward {
        matches
            .into_iter()
            .filter(|&idx| idx <= search_start_line)
            .rev()
            .collect()
    } else {
        matches
            .into_iter()
            .filter(|&idx| idx >= search_start_line)
            .collect()
    };

    (sorted_matches, snippet_lines, clean_target)
}

/// Strip UTF-8 BOM and zero-width spaces, normalize CRLF/CR to LF.
fn normalize_content_text(content: &str) -> String {
    content
        .replace('\u{feff}', "")
        .replace('\u{200b}', "")
        .replace('\u{200c}', "")
        .replace('\u{200d}', "")
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}

/// Unescape escaped newline/tab characters commonly emitted by LLMs in tool call JSON strings.
fn unescape_literal_escapes(s: &str) -> String {
    if !s.contains('\\') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.peek() {
                Some('n') => {
                    chars.next();
                    out.push('\n');
                }
                Some('r') => {
                    chars.next();
                    out.push('\r');
                }
                Some('t') => {
                    chars.next();
                    out.push('\t');
                }
                Some('"') => {
                    chars.next();
                    out.push('"');
                }
                Some('\'') => {
                    chars.next();
                    out.push('\'');
                }
                Some('\\') => {
                    chars.next();
                    out.push('\\');
                }
                _ => {
                    out.push(c);
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Normalize smart/curly quotes to ASCII straight quotes and trim boundary whitespace.
fn normalize_quotes_and_trim(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '“' | '”' | '″' => '"',
            '‘' | '’' | '′' => '\'',
            _ => c,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

fn sanitize_target_snippet(s: &str) -> String {
    let trimmed = s
        .replace('\u{feff}', "")
        .replace('\u{200b}', "")
        .replace('\u{200c}', "")
        .replace('\u{200d}', "");
    let mut trimmed = trimmed.trim();
    if trimmed.starts_with("```") {
        if let Some(pos) = trimmed.find('\n') {
            trimmed = trimmed[pos + 1..].trim();
        }
        if let Some(pos) = trimmed.rfind("```") {
            trimmed = trimmed[..pos].trim();
        }
    }
    let lines: Vec<&str> = trimmed
        .lines()
        .map(|line| {
            if let Some(arrow_pos) = line.find('→') {
                let prefix = &line[..arrow_pos];
                if prefix.trim().chars().all(|c| c.is_ascii_digit()) {
                    return &line[arrow_pos + '→'.len_utf8()..];
                }
            }
            line
        })
        .collect();
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use jeikcode_kernel::tool::ToolContext;
    use tokio_util::sync::CancellationToken;

    fn ctx(dir: &std::path::Path) -> ToolContext {
        ToolContext {
            working_dir: dir.to_path_buf(),
            cancel: CancellationToken::new(),
            progress: jeikcode_kernel::tool::ProgressSink::noop(),
            requester: None,
        }
    }

    #[test]
    fn lenient_usize_rejects_out_of_domain_values() {
        // Leniency covers integer representations only. It must not guess a
        // fractional value, accept a non-finite value, or saturate overflow.
        for bad in [
            r#"{"file_path":"x","limit":-5.0}"#,  // negative float
            r#"{"file_path":"x","limit":-5}"#,    // bare negative int
            r#"{"file_path":"x","limit":"-5"}"#,  // negative as string
            r#"{"file_path":"x","limit":"NaN"}"#, // NaN as string
            r#"{"file_path":"x","limit":"Infinity"}"#,
            r#"{"file_path":"x","offset":3.9}"#, // offset non-integer float
            r#"{"file_path":"x","limit":"3.9"}"#,
            r#"{"file_path":"x","limit":"340282366920938463463374607431768211455"}"#,
        ] {
            assert!(
                serde_json::from_str::<Args>(bad).is_err(),
                "should reject out-of-domain numeric: {bad}"
            );
        }
        let args: Args =
            serde_json::from_str(r#"{"file_path":"x","offset":2.0,"limit":"3.0"}"#).unwrap();
        assert_eq!(args.offset, Some(2));
        assert_eq!(args.limit, Some(3));
    }

    #[test]
    fn lenient_usize_checks_platform_range_without_saturation() {
        let max = usize::MAX.to_string();
        let args: Args =
            serde_json::from_str(&format!(r#"{{"file_path":"x","limit":"{max}"}}"#)).unwrap();
        assert_eq!(args.limit, Some(usize::MAX));

        let overflow = (usize::MAX as u128 + 1).to_string();
        for input in [
            format!(r#"{{"file_path":"x","limit":{overflow}}}"#),
            format!(r#"{{"file_path":"x","limit":"{overflow}"}}"#),
        ] {
            assert!(
                serde_json::from_str::<Args>(&input).is_err(),
                "must reject a value above this platform's usize range: {input}"
            );
        }
    }

    #[test]
    fn lenient_isize_accepts_negative_offset() {
        let args: Args = serde_json::from_str(r#"{"file_path":"x","offset":-30}"#).unwrap();
        assert_eq!(args.offset, Some(-30));
        let args_str: Args = serde_json::from_str(r#"{"file_path":"x","offset":"-50"}"#).unwrap();
        assert_eq!(args_str.offset, Some(-50));
    }

    #[test]
    fn lenient_usize_rejects_ambiguous_f64_integers() {
        // The first value is exact, but must be rejected conservatively because
        // the second distinct decimal input decodes to the same f64 value.
        for input in [
            r#"{"file_path":"x","limit":4503599627370496.0}"#,
            r#"{"file_path":"x","limit":9007199254740992.0}"#,
            r#"{"file_path":"x","limit":9007199254740993.0}"#,
            r#"{"file_path":"x","limit":"9007199254740993.0"}"#,
        ] {
            assert!(
                serde_json::from_str::<Args>(input).is_err(),
                "ambiguous f64 integer must be rejected: {input}"
            );
        }

        let args: Args =
            serde_json::from_str(r#"{"file_path":"x","limit":4503599627370495.0}"#).unwrap();
        assert_eq!(args.limit, Some(4_503_599_627_370_495));
    }

    #[tokio::test]
    async fn reads_with_line_numbers() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "first\nsecond\nthird\n").unwrap();
        let r = ReadFileTool::default()
            .execute(r#"{"file_path":"a.txt"}"#, &ctx(d.path()))
            .await;
        assert!(!r.is_error);
        assert!(r.content.contains("1→first"), "{}", r.content);
        assert!(r.content.contains("2→second"), "{}", r.content);
        assert!(r.content.contains("3→third"), "{}", r.content);
    }

    #[tokio::test]
    async fn reads_gitignored_upload_store_file() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(".gitignore"), ".jeikcode_store/\n").unwrap();
        std::fs::create_dir_all(d.path().join(".jeikcode_store")).unwrap();
        std::fs::write(d.path().join(".jeikcode_store/notes.md"), "uploaded\n").unwrap();
        let r = ReadFileTool::default()
            .execute(
                r#"{"file_path":".jeikcode_store/notes.md"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("uploaded"), "{}", r.content);
    }

    #[tokio::test]
    async fn image_file_returns_base64_for_vision_model() {
        // A vision-capable model must SEE the image: read_file base64-encodes the
        // bytes into the result's `images` instead of the "Binary file" text dead-end.
        let d = tempfile::tempdir().unwrap();
        // Minimal JPEG-ish blob (SOI marker + a NUL so `looks_binary` flags it).
        let bytes: &[u8] = &[
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0x00,
        ];
        std::fs::write(d.path().join("cover.jpg"), bytes).unwrap();
        let r = ReadFileTool::new(true)
            .execute(r#"{"file_path":"cover.jpg"}"#, &ctx(d.path()))
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(r.images.len(), 1, "vision model must receive the image");
        assert_eq!(r.images[0].media_type, "image/jpeg");
        assert_eq!(
            r.images[0].data,
            base64::engine::general_purpose::STANDARD.encode(bytes),
            "image bytes must be base64-encoded losslessly"
        );
        assert!(!r.content.starts_with("Binary file"), "{}", r.content);
        assert!(r.content.contains("cover.jpg"), "{}", r.content);
    }

    #[tokio::test]
    async fn image_file_stays_binary_text_for_text_only_model() {
        // A text-only model would reject a base64 image / waste tokens → keep the
        // existing "Binary file" text and attach NO image.
        let d = tempfile::tempdir().unwrap();
        let bytes: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        std::fs::write(d.path().join("cover.jpg"), bytes).unwrap();
        let r = ReadFileTool::new(false)
            .execute(r#"{"file_path":"cover.jpg"}"#, &ctx(d.path()))
            .await;
        assert!(!r.is_error);
        assert!(
            r.images.is_empty(),
            "text-only model must NOT receive an image"
        );
        assert!(r.content.starts_with("Binary file"), "{}", r.content);
    }

    #[tokio::test]
    async fn non_image_binary_stays_text_even_for_vision_model() {
        // A vision model reading a NON-image binary (e.g. a PDF) still gets the text
        // dead-end + recovery hint — only true images become `images`.
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("report.pdf"), b"%PDF-1.4\0\0\0binary blob").unwrap();
        let r = ReadFileTool::new(true)
            .execute(r#"{"file_path":"report.pdf"}"#, &ctx(d.path()))
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(
            r.images.is_empty(),
            "non-image binary must not be sent as an image"
        );
        assert!(r.content.starts_with("Binary file"), "{}", r.content);
    }

    #[tokio::test]
    async fn offset_and_limit_slice() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "l1\nl2\nl3\nl4\nl5\n").unwrap();
        let r = ReadFileTool::default()
            .execute(
                r#"{"file_path":"a.txt","offset":2,"limit":2}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(r.content.contains("2→l2"), "{}", r.content);
        assert!(r.content.contains("3→l3"), "{}", r.content);
        assert!(!r.content.contains("→l1"), "{}", r.content);
        assert!(!r.content.contains("→l4"), "{}", r.content);
        assert!(
            r.content.contains("Showing lines 2-3 | Remaining: 4-5"),
            "{}",
            r.content
        );
        assert!(!r.content.contains("read_file("), "{}", r.content);
    }

    #[tokio::test]
    async fn omitted_limit_uses_a_bounded_page_with_an_actionable_continuation() {
        let d = tempfile::tempdir().unwrap();
        let text = (1..=3505)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(d.path().join("notes.txt"), text).unwrap();

        let r = ReadFileTool::default()
            .execute(r#"{"file_path":"notes.txt"}"#, &ctx(d.path()))
            .await;

        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("1500→line 1500"), "{}", r.content);
        assert!(!r.content.contains("line 1501"), "{}", r.content);
        assert!(
            r.content
                .contains("Showing lines 1-1500 | Remaining: 1501-3505")
                && r.content.contains("offset=1501")
                && !r.content.contains("read_file("),
            "{}",
            r.content
        );

        let page2 = ReadFileTool::default()
            .execute(
                r#"{"file_path":"notes.txt","offset":1501,"limit":100}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!page2.is_error, "{}", page2.content);
        assert!(
            page2.content.contains("1501→line 1501"),
            "{}",
            page2.content
        );
        assert!(!page2.content.contains("read_file("), "{}", page2.content);
    }

    #[tokio::test]
    async fn read_page_stays_below_the_generic_artifact_threshold() {
        let d = tempfile::tempdir().unwrap();
        let text = (1..=400)
            .map(|n| format!("line {n} {}", "x".repeat(800)))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(d.path().join("wide.txt"), text).unwrap();

        let r = ReadFileTool::default()
            .execute(r#"{"file_path":"wide.txt"}"#, &ctx(d.path()))
            .await;

        assert!(!r.is_error, "{}", r.content);
        assert!(
            r.content.len() <= MAX_READ_OUTPUT_BYTES,
            "read_file must emit within budget: {} bytes",
            r.content.len()
        );
        assert!(!r.content.contains("read_file("), "{}", r.content);
    }

    #[tokio::test]
    async fn files_above_the_legacy_five_mib_cutoff_use_default_pagination() {
        let d = tempfile::tempdir().unwrap();
        let line = format!("{}\n", "x".repeat(1023));
        std::fs::write(d.path().join("large.txt"), line.repeat(5 * 1024 + 1)).unwrap();

        let r = ReadFileTool::default()
            .execute(r#"{"file_path":"large.txt"}"#, &ctx(d.path()))
            .await;

        assert!(!r.is_error, "{}", r.content);
        assert!(!r.content.contains("read_file("), "{}", r.content);
        assert!(
            r.content.len() <= MAX_READ_OUTPUT_BYTES,
            "{} bytes",
            r.content.len()
        );
    }

    #[test]
    fn continuation_footer_does_not_contain_callable_json() {
        let footer = continuation_footer("test.rs", 12345, 1, 10, 100);
        assert!(!footer.contains("read_file("), "{footer}");
        assert!(!footer.contains("capped"), "{footer}");
        assert!(footer.contains("File: test.rs"), "{footer}");
        assert!(
            footer.contains("Total Lines: 100 | Total Bytes: 12345"),
            "{footer}"
        );
        assert!(
            footer.contains("Showing lines 1-10 | Remaining: 11-100"),
            "{footer}"
        );
        assert!(
            footer.contains("To continue: call `read` with offset=11"),
            "{footer}"
        );
        assert!(
            footer.contains("Reading several hundred lines, or the whole file, in one call is safe and expected."),
            "{footer}"
        );
        assert!(
            !footer.contains("To read the whole file: call `read` with offset=1, limit=1500."),
            "{footer}"
        );
    }

    #[tokio::test]
    async fn hard_in_memory_ceiling_applies_even_to_explicit_slices() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("huge.txt");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_IN_MEMORY_BYTES + 1).unwrap();

        let r = ReadFileTool::default()
            .execute(
                r#"{"file_path":"huge.txt","offset":1,"limit":1}"#,
                &ctx(d.path()),
            )
            .await;

        assert!(r.is_error);
        assert!(r.content.contains("in-memory decoder"), "{}", r.content);
    }

    #[tokio::test]
    async fn explicit_limit_can_read_beyond_the_default_line_page() {
        let d = tempfile::tempdir().unwrap();
        let text = (1..=350)
            .map(|n| format!("l{n}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(d.path().join("short-lines.txt"), text).unwrap();

        let r = ReadFileTool::default()
            .execute(
                r#"{"file_path":"short-lines.txt","offset":1,"limit":350}"#,
                &ctx(d.path()),
            )
            .await;

        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("350→l350"), "{}", r.content);
        assert!(!r.content.contains("Continue reading"), "{}", r.content);
    }

    #[tokio::test]
    async fn zero_limit_is_rejected() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("notes.txt"), "hello").unwrap();

        let r = ReadFileTool::default()
            .execute(r#"{"file_path":"notes.txt","limit":0}"#, &ctx(d.path()))
            .await;

        assert!(r.is_error);
        assert!(r.content.contains("must be at least 1"), "{}", r.content);
    }

    #[tokio::test]
    async fn binary_file_is_reported() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("b.bin"), [0u8, 1, 2, 3, 0, 255]).unwrap();
        let r = ReadFileTool::default()
            .execute(r#"{"file_path":"b.bin"}"#, &ctx(d.path()))
            .await;
        assert!(!r.is_error);
        assert!(r.content.starts_with("Binary file"), "{}", r.content);
    }

    #[tokio::test]
    async fn decodes_gbk_text_file() {
        // Chinese Windows editors write .txt/.md as GBK/GB18030, not UTF-8.
        // from_utf8_lossy would mangle these into replacement chars (mojibake);
        // a GB18030 fallback must recover the original text.
        let d = tempfile::tempdir().unwrap();
        let (gbk, _, had_err) = encoding_rs::GB18030.encode("你好，世界");
        assert!(!had_err);
        std::fs::write(d.path().join("notes.txt"), &gbk).unwrap();
        let r = ReadFileTool::default()
            .execute(r#"{"file_path":"notes.txt"}"#, &ctx(d.path()))
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(
            r.content.contains("你好，世界"),
            "GBK should decode, got: {}",
            r.content
        );
    }

    #[tokio::test]
    async fn binary_file_includes_recovery_hint() {
        // A binary with a recognised document extension should pivot the model to an
        // external converter on the first failure, not leave it cycling offset/limit.
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("report.pdf"), b"%PDF-1.4\0\0\0binary blob").unwrap();
        let r = ReadFileTool::default()
            .execute(r#"{"file_path":"report.pdf"}"#, &ctx(d.path()))
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.starts_with("Binary file"), "{}", r.content);
        assert!(
            r.content.contains("pdftotext"),
            "pdf recovery hint, got: {}",
            r.content
        );
    }

    #[tokio::test]
    async fn directory_lists_contents() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("x.txt"), "hi").unwrap();
        std::fs::create_dir(d.path().join("sub")).unwrap();
        let r = ReadFileTool::default()
            .execute(r#"{"file_path":"."}"#, &ctx(d.path()))
            .await;
        assert!(r.content.contains("[Directory:"), "{}", r.content);
        assert!(r.content.contains("sub/"), "{}", r.content);
        assert!(r.content.contains("x.txt"), "{}", r.content);
    }

    #[tokio::test]
    async fn directory_lists_directories_first_and_supports_pagination() {
        let d = tempfile::tempdir().unwrap();
        // 创建文件 a_file.txt, m_file.txt 和目录 z_dir, b_dir
        std::fs::write(d.path().join("a_file.txt"), "hello").unwrap();
        std::fs::write(d.path().join("m_file.txt"), "world").unwrap();
        std::fs::create_dir(d.path().join("z_dir")).unwrap();
        std::fs::create_dir(d.path().join("b_dir")).unwrap();

        // 默认全量读：验证目录排在文件前面 (b_dir/ -> z_dir/ -> a_file.txt -> m_file.txt)
        let r_all = ReadFileTool::default()
            .execute(r#"{"file_path":"."}"#, &ctx(d.path()))
            .await;
        assert!(!r_all.is_error, "{}", r_all.content);
        let b_pos = r_all.content.find("b_dir/").unwrap();
        let z_pos = r_all.content.find("z_dir/").unwrap();
        let a_pos = r_all.content.find("a_file.txt").unwrap();
        let m_pos = r_all.content.find("m_file.txt").unwrap();
        assert!(b_pos < z_pos, "directories must be sorted alphabetically");
        assert!(z_pos < a_pos, "directories must appear before files");
        assert!(a_pos < m_pos, "files must be sorted alphabetically");

        // 分页第一页：limit = 2
        let r_p1 = ReadFileTool::default()
            .execute(r#"{"file_path":".","limit":2}"#, &ctx(d.path()))
            .await;
        assert!(!r_p1.is_error, "{}", r_p1.content);
        assert!(r_p1.content.contains("b_dir/"), "{}", r_p1.content);
        assert!(r_p1.content.contains("z_dir/"), "{}", r_p1.content);
        assert!(!r_p1.content.contains("a_file.txt"), "{}", r_p1.content);
        assert!(
            r_p1.content.contains("(Next offset: 3)"),
            "{}",
            r_p1.content
        );

        // 分页第二页：offset = 3, limit = 2
        let r_p2 = ReadFileTool::default()
            .execute(r#"{"file_path":".","offset":3,"limit":2}"#, &ctx(d.path()))
            .await;
        assert!(!r_p2.is_error, "{}", r_p2.content);
        assert!(r_p2.content.contains("a_file.txt"), "{}", r_p2.content);
        assert!(r_p2.content.contains("m_file.txt"), "{}", r_p2.content);
        assert!(
            r_p2.content.contains("(End of directory)"),
            "{}",
            r_p2.content
        );
    }

    #[tokio::test]
    async fn missing_file_errors() {
        let d = tempfile::tempdir().unwrap();
        let r = ReadFileTool::default()
            .execute(r#"{"file_path":"nope.txt"}"#, &ctx(d.path()))
            .await;
        assert!(r.is_error);
        assert!(r.content.contains("path does not exist"), "{}", r.content);
    }

    /// Local Grok-style not-found feedback (not the official "Nearest existing
    /// directory" hint): the model still gets the resolved path and a cwd note.
    #[tokio::test]
    async fn missing_file_error_carries_the_nearest_existing_ancestor() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join("app")).unwrap();
        std::fs::write(d.path().join("app/build.gradle"), "").unwrap();
        let r = ReadFileTool::default()
            .execute(
                r#"{"file_path":"app/src/main/AndroidManifest.xml"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(r.is_error, "{}", r.content);
        assert!(r.content.contains("path does not exist"), "{}", r.content);
        assert!(r.content.contains("AndroidManifest.xml"), "{}", r.content);
    }

    #[tokio::test]
    async fn lenient_offset_limit_accepts_float_strings() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "l1\nl2\nl3\nl4\n").unwrap();
        // Weak models send "2.0" / "2.0" instead of integers.
        let r = ReadFileTool::default()
            .execute(
                r#"{"file_path":"a.txt","offset":"2.0","limit":"2.0"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("2→l2"), "{}", r.content);
        assert!(r.content.contains("3→l3"), "{}", r.content);
        assert!(!r.content.contains("→l4"), "{}", r.content);
    }

    #[cfg(feature = "codeintel")]
    #[tokio::test]
    async fn large_code_file_returns_the_body_not_a_skeleton() {
        // Plan A: an unsliced read of a ~1400-line source file must dump the body
        // in one page, not replace it with a symbol outline that forces offset/limit.
        let d = tempfile::tempdir().unwrap();
        let mut src = String::from("fn alpha() {\n");
        for _ in 0..1400 {
            src.push_str("    let _ = 1;\n");
        }
        src.push_str("}\nfn beta() {}\n");
        std::fs::write(d.path().join("big.rs"), &src).unwrap();
        let r = ReadFileTool::default()
            .execute(r#"{"file_path":"big.rs"}"#, &ctx(d.path()))
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(
            !r.content.contains("File skeleton"),
            "unsliced read must not hijack into a skeleton: {}",
            r.content
        );
        assert!(
            r.content.contains("alpha") && r.content.contains("beta"),
            "{}",
            r.content
        );
        assert!(
            r.content.contains("let _ = 1;"),
            "body must be present: {}",
            r.content
        );
    }

    #[tokio::test]
    async fn offset_limit_still_selects_a_window() {
        let d = tempfile::tempdir().unwrap();
        let mut src = String::from("fn f() {}\n");
        for i in 0..1600 {
            src.push_str(&format!("// line {i}\n"));
        }
        std::fs::write(d.path().join("big.rs"), &src).unwrap();
        let r = ReadFileTool::default()
            .execute(
                r#"{"file_path":"big.rs","offset":1,"limit":3}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(r.content.contains("1→fn f"), "{}", r.content);
        assert!(!r.content.contains("line 5"), "{}", r.content);
    }

    #[tokio::test]
    async fn file_under_the_default_page_returns_in_full() {
        let d = tempfile::tempdir().unwrap();
        let mut src = String::new();
        for i in 0..800 {
            src.push_str(&format!("line {i}\n"));
        }
        std::fs::write(d.path().join("big.txt"), &src).unwrap();
        let r = ReadFileTool::default()
            .execute(r#"{"file_path":"big.txt"}"#, &ctx(d.path()))
            .await;
        assert!(r.content.contains("line 0"), "{}", r.content);
        assert!(r.content.contains("line 799"), "{}", r.content);
        assert!(
            !r.content.contains("read_file("),
            "an 800-line file must not paginate under a 1500-line default: {}",
            r.content
        );
    }

    #[tokio::test]
    async fn long_line_is_truncated() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("long.txt"), "x".repeat(5000)).unwrap();
        let r = ReadFileTool::default()
            .execute(r#"{"file_path":"long.txt"}"#, &ctx(d.path()))
            .await;
        assert!(
            r.content.contains("line truncated to 2000 chars"),
            "{}",
            r.content
        );
    }

    #[tokio::test]
    async fn small_pages_number_every_line() {
        let d = tempfile::tempdir().unwrap();
        let text = (1..=25)
            .map(|n| format!("content_{n}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(d.path().join("anchors.txt"), text).unwrap();

        let r = ReadFileTool::default()
            .execute(
                r#"{"file_path":"anchors.txt","offset":5,"limit":16}"#,
                &ctx(d.path()),
            )
            .await;

        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("5→content_5"), "{}", r.content);
        assert!(r.content.contains("6→content_6"), "{}", r.content);
        assert!(r.content.contains("15→content_15"), "{}", r.content);
        assert!(r.content.contains("20→content_20"), "{}", r.content);
    }

    #[tokio::test]
    async fn sparse_line_anchors_emit_on_large_pages() {
        let d = tempfile::tempdir().unwrap();
        let text = (1..=250)
            .map(|n| format!("content_{n}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(d.path().join("anchors.txt"), text).unwrap();

        let r = ReadFileTool::default()
            .execute(
                r#"{"file_path":"anchors.txt","offset":5,"limit":220}"#,
                &ctx(d.path()),
            )
            .await;

        assert!(!r.is_error, "{}", r.content);
        let resp: ReadResponse = serde_json::from_str(&r.content).unwrap();
        assert!(resp.content.contains("5→content_5"), "{}", resp.content);
        assert!(resp.content.contains("\ncontent_6\n"), "{}", resp.content);
        assert!(!resp.content.contains("6→"), "{}", resp.content);
        assert!(resp.content.contains("10→content_10"), "{}", resp.content);
        assert!(resp.content.contains("\ncontent_15\n"), "{}", resp.content);
        assert!(!resp.content.contains("15→"), "{}", resp.content);
        assert!(resp.content.contains("20→content_20"), "{}", resp.content);
    }

    #[tokio::test]
    async fn large_file_paginates_without_continuation_json() {
        let d = tempfile::tempdir().unwrap();
        let text = (1..=1800)
            .map(|n| format!("line_{n}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(d.path().join("giant.txt"), text).unwrap();

        let r = ReadFileTool::default()
            .execute(r#"{"file_path":"giant.txt"}"#, &ctx(d.path()))
            .await;

        assert!(!r.is_error, "{}", r.content);
        assert!(
            r.content
                .contains("Showing lines 1-1500 | Remaining: 1501-1800")
                && r.content.contains("offset=1501"),
            "{}",
            r.content
        );
        assert!(!r.content.contains("read_file("), "{}", r.content);
        assert!(r.content.contains("1→line_1"), "{}", r.content);
        assert!(r.content.contains("1500→line_1500"), "{}", r.content);
        assert!(!r.content.contains("line_1501"), "{}", r.content);

        // Read second page to EOF
        let r2 = ReadFileTool::default()
            .execute(
                r#"{"file_path":"giant.txt","offset":1501,"limit":500}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r2.is_error, "{}", r2.content);
        assert!(
            r2.content
                .contains("Showing lines 1501-1800 | End of file."),
            "{}",
            r2.content
        );
    }

    #[tokio::test]
    async fn downward_absorbed_in_slice_mode() {
        let d = tempfile::tempdir().unwrap();
        let text = (1..=200)
            .map(|n| format!("line_{n}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(d.path().join("sample.txt"), text).unwrap();

        // 仅传 offset + downward，没有传 limit：downward 被静默吸收，limit 回退为默认 1500（读完剩余 10-200 行）
        let r = ReadFileTool::default()
            .execute(
                r#"{"path":"sample.txt","offset":10,"downward":5}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("10→line_10"), "{}", r.content);
        assert!(r.content.contains("200→line_200"), "{}", r.content);
        assert!(
            r.content.contains("Showing lines 10-200 | End of file."),
            "{}",
            r.content
        );

        // limit 和 downward 同时传入：使用 limit，downward 被静默吸收
        let r2 = ReadFileTool::default()
            .execute(
                r#"{"path":"sample.txt","offset":10,"limit":5,"downward":5}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r2.is_error, "{}", r2.content);
        assert!(r2.content.contains("10→line_10"), "{}", r2.content);
        assert!(r2.content.contains("14→line_14"), "{}", r2.content);
        assert!(!r2.content.contains("line_15"), "{}", r2.content);
    }

    #[tokio::test]
    async fn anchor_mode_with_key_string_works() {
        let d = tempfile::tempdir().unwrap();
        let text = (1..=200)
            .map(|n| {
                if n == 50 {
                    "fn target_symbol() {".to_string()
                } else {
                    format!("line_{n}")
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(d.path().join("code.rs"), text).unwrap();

        let r = ReadFileTool::default()
            .execute(
                r#"{"path":"code.rs","key_string":"target_symbol","upward":3,"downward":3}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(
            r.content.contains("[KeyString matched at line 50]"),
            "{}",
            r.content
        );
        assert!(r.content.contains("47→line_47"), "{}", r.content);
        assert!(
            r.content.contains("50→fn target_symbol() {"),
            "{}",
            r.content
        );
        assert!(r.content.contains("53→line_53"), "{}", r.content);
        assert!(!r.content.contains("line_46"), "{}", r.content);
        assert!(!r.content.contains("line_54"), "{}", r.content);
    }

    #[test]
    fn ci_check_keywords_and_constants_integrity() {
        assert_eq!(READ_LIMIT_DEFAULT, 1500);
        assert_eq!(READ_UPWARD_DEFAULT, 25);
        assert_eq!(READ_DOWNWARD_DEFAULT, 75);
        assert_eq!(READ_BYTE_BUDGET, 65536);

        let tool = ReadFileTool::default();
        let schema = tool.parameters_schema();
        let schema_str = serde_json::to_string(&schema).unwrap();

        let keywords = [
            "1500",
            "25",
            "75",
            "safe and expected",
            "Ignored when key_string",
        ];
        for kw in keywords {
            assert!(
                schema_str.contains(kw),
                "schema must contain keyword '{kw}': {schema_str}"
            );
        }

        // Schema properties must not contain any "default" keys (defaults live at execution layer)
        if let Some(props) = schema.get("properties").and_then(|p| p.as_object()) {
            for (field, val) in props {
                assert!(
                    val.get("default").is_none(),
                    "property '{field}' in parameters_schema must NOT have a default field"
                );
            }
        }

        // Verify cross-crate prompt files consistency when available
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let rules_path = manifest_dir.join("../jeikcode-coding/assets/prompts/rules.yaml");
        if rules_path.exists() {
            let rules_content = std::fs::read_to_string(&rules_path).unwrap();
            assert!(
                rules_content.contains("safe and expected"),
                "rules.yaml must contain 'safe and expected'"
            );
            assert!(
                rules_content.contains("several hundred lines, or the whole file"),
                "rules.yaml must contain 'several hundred lines, or the whole file'"
            );
        }

        let root_docs_path =
            manifest_dir.join("../jeikcode-coding/assets/prompts/root_docs_内置工具.yaml");
        if root_docs_path.exists() {
            let root_docs_content = std::fs::read_to_string(&root_docs_path).unwrap();
            assert!(
                root_docs_content.contains("1500"),
                "root_docs must contain 1500"
            );
            assert!(
                root_docs_content.contains("25"),
                "root_docs must contain 25"
            );
            assert!(
                root_docs_content.contains("75"),
                "root_docs must contain 75"
            );
            assert!(
                root_docs_content.contains("safe and expected"),
                "root_docs must contain 'safe and expected'"
            );
            assert!(
                root_docs_content.contains("path:"),
                "root_docs read_file parameter must be 'path:'"
            );
        }

        let first_turn_path = manifest_dir.join("../jeikcode-coding/src/code_tools_first.rs");
        if first_turn_path.exists() {
            let first_turn_content = std::fs::read_to_string(&first_turn_path).unwrap();
            assert!(
                first_turn_content.contains("Explore the codebase generously before answering"),
                "code_tools_first.rs must contain generous exploration"
            );
            assert!(
                !first_turn_content.contains("Prioritize `code_explore` and `repo_map`"),
                "code_tools_first.rs must NOT contain obsolete prompt 'Prioritize `code_explore` and `repo_map`'"
            );
        }
    }

    #[tokio::test]
    async fn range_mode_3a_3b_3c_3d_lifecycle() {
        let d = tempfile::tempdir().unwrap();

        // 3D: 完整文件一次读完 (< 1500 行，无截断)
        std::fs::write(d.path().join("tiny.rs"), "fn tiny() {}\n").unwrap();
        let r3d = ReadFileTool::default()
            .execute(r#"{"path":"tiny.rs"}"#, &ctx(d.path()))
            .await;
        assert!(!r3d.is_error, "{}", r3d.content);
        let resp3d: ReadResponse = serde_json::from_str(&r3d.content).unwrap();
        assert_eq!(resp3d.mode, "range");
        if let ReadMeta::Range(meta) = resp3d.meta {
            assert_eq!(meta.start_line, 1);
            assert_eq!(meta.end_line, 1);
            assert_eq!(meta.truncated, false);
            assert_eq!(meta.truncated_by, None);
            assert_eq!(meta.next_offset, None);
        } else {
            panic!("expected RangeMeta");
        }
        assert!(resp3d.footer.contains("Showing lines 1-1 | Complete file."));
        assert!(!resp3d.footer.contains("safe and expected"));

        // 3A: 未读完（显式 limit 导致行数截断）
        let text20 = (1..=20)
            .map(|i| format!("line_{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(d.path().join("lines20.txt"), text20).unwrap();
        let r3a = ReadFileTool::default()
            .execute(
                r#"{"path":"lines20.txt","offset":1,"limit":5}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r3a.is_error, "{}", r3a.content);
        let resp3a: ReadResponse = serde_json::from_str(&r3a.content).unwrap();
        if let ReadMeta::Range(meta) = resp3a.meta {
            assert_eq!(meta.start_line, 1);
            assert_eq!(meta.end_line, 5);
            assert_eq!(meta.truncated, true);
            assert_eq!(meta.truncated_by, Some("lines".to_string()));
            assert_eq!(meta.next_offset, Some(6));
        } else {
            panic!("expected RangeMeta");
        }
        assert!(resp3a
            .footer
            .contains("Showing lines 1-5 | Remaining: 6-20"));
        assert!(resp3a
            .footer
            .contains("To continue: call `read` with offset=6."));
        assert!(resp3a.footer.contains("safe and expected"));

        // 3C: 读到末尾 (start > 1 且 end == total)
        let r3c = ReadFileTool::default()
            .execute(
                r#"{"path":"lines20.txt","offset":15,"limit":10}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r3c.is_error, "{}", r3c.content);
        let resp3c: ReadResponse = serde_json::from_str(&r3c.content).unwrap();
        if let ReadMeta::Range(meta) = resp3c.meta {
            assert_eq!(meta.start_line, 15);
            assert_eq!(meta.end_line, 20);
            assert_eq!(meta.truncated, false);
            assert_eq!(meta.truncated_by, None);
            assert_eq!(meta.next_offset, None);
        } else {
            panic!("expected RangeMeta");
        }
        assert!(resp3c.footer.contains("Showing lines 15-20 | End of file."));
        assert!(!resp3c.footer.contains("safe and expected"));

        // 3B: 字节截断 (超预算)
        let wide_text = (1..=200)
            .map(|i| format!("line_{i}_{}", "x".repeat(800)))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(d.path().join("wide_file.txt"), wide_text).unwrap();
        let r3b = ReadFileTool::default()
            .execute(r#"{"path":"wide_file.txt"}"#, &ctx(d.path()))
            .await;
        assert!(!r3b.is_error, "{}", r3b.content);
        let resp3b: ReadResponse = serde_json::from_str(&r3b.content).unwrap();
        if let ReadMeta::Range(meta) = resp3b.meta {
            assert_eq!(meta.truncated, true);
            assert_eq!(meta.truncated_by, Some("bytes".to_string()));
            assert!(meta.end_line < 200);
            assert_eq!(meta.next_offset, Some(meta.end_line + 1));
        } else {
            panic!("expected RangeMeta");
        }
        assert!(resp3b
            .footer
            .contains("To continue: call `read` with offset="));
    }

    #[tokio::test]
    async fn key_string_mode_4a_4b_4c_4d_lifecycle() {
        let d = tempfile::tempdir().unwrap();

        // 4D: 无匹配 (content 为空，给出提示)
        std::fs::write(d.path().join("foo.rs"), "fn bar() {}\nfn baz() {}\n").unwrap();
        let r4d = ReadFileTool::default()
            .execute(
                r#"{"path":"foo.rs","key_string":"non_existent"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r4d.is_error, "{}", r4d.content);
        let resp4d: ReadResponse = serde_json::from_str(&r4d.content).unwrap();
        assert_eq!(resp4d.mode, "key_string");
        assert_eq!(resp4d.content, "");
        if let ReadMeta::KeyString(meta) = resp4d.meta {
            assert_eq!(meta.total_matches, 0);
            assert_eq!(meta.shown_matches, 0);
            assert_eq!(meta.truncated, false);
            assert_eq!(meta.truncated_by, None);
        } else {
            panic!("expected KeyStringMeta");
        }
        assert!(resp4d
            .footer
            .contains("No match for \"non_existent\" (case-insensitive)."));
        assert!(resp4d.footer.contains("use `grep` to locate the symbol"));

        // 4A: 全部展示 (1 或多匹配，未超 max_matches / budget)
        let r4a = ReadFileTool::default()
            .execute(r#"{"path":"foo.rs","key_string":"bar"}"#, &ctx(d.path()))
            .await;
        assert!(!r4a.is_error, "{}", r4a.content);
        let resp4a: ReadResponse = serde_json::from_str(&r4a.content).unwrap();
        if let ReadMeta::KeyString(meta) = resp4a.meta {
            assert_eq!(meta.total_matches, 1);
            assert_eq!(meta.shown_matches, 1);
            assert_eq!(meta.truncated, false);
            assert_eq!(meta.truncated_by, None);
        } else {
            panic!("expected KeyStringMeta");
        }
        assert!(resp4a
            .footer
            .contains("Matched 1 occurrence(s) of \"bar\" (case-insensitive)."));
        assert!(resp4a
            .footer
            .contains("Window: 25 lines above / 75 lines below each match."));

        // 4B: 被 max_matches 截断
        let multi = (1..=10)
            .map(|i| format!("fn item_{i}() {{}}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(d.path().join("multi.rs"), multi).unwrap();
        let r4b = ReadFileTool::default()
            .execute(
                r#"{"path":"multi.rs","key_string":"fn item","max_matches":2}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r4b.is_error, "{}", r4b.content);
        let resp4b: ReadResponse = serde_json::from_str(&r4b.content).unwrap();
        if let ReadMeta::KeyString(meta) = resp4b.meta {
            assert_eq!(meta.total_matches, 10);
            assert_eq!(meta.shown_matches, 2);
            assert_eq!(meta.truncated, true);
            assert_eq!(meta.truncated_by, Some("max_matches".to_string()));
        } else {
            panic!("expected KeyStringMeta");
        }
        assert!(resp4b
            .footer
            .contains("Matched 10 occurrence(s) of \"fn item\" (case-insensitive)."));
        assert!(resp4b.footer.contains("Showing first 2 matches."));
        assert!(resp4b
            .footer
            .contains("To see more: increase `max_matches`"));

        // 4C: 窗口被 65 KiB 截断，引导回分页模式 (fallback_offset & fallback_limit)
        let wide_matches = (1..=100)
            .map(|_i| format!("fn wide_match() {{ /* {} */ }}", "w".repeat(1200)))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(d.path().join("wide_code.rs"), wide_matches).unwrap();
        let r4c = ReadFileTool::default()
            .execute(
                r#"{"path":"wide_code.rs","key_string":"wide_match","upward":50,"downward":50}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r4c.is_error, "{}", r4c.content);
        let resp4c: ReadResponse = serde_json::from_str(&r4c.content).unwrap();
        if let ReadMeta::KeyString(ref meta) = resp4c.meta {
            assert_eq!(meta.truncated, true);
            assert_eq!(meta.truncated_by, Some("bytes".to_string()));
            assert!(meta.fallback_offset.is_some());
            assert!(meta.fallback_limit.is_some());
        } else {
            panic!("expected KeyStringMeta");
        }
        let (fb_offset, fb_limit) = if let ReadMeta::KeyString(ref meta) = resp4c.meta {
            (meta.fallback_offset.unwrap(), meta.fallback_limit.unwrap())
        } else {
            (1, 100)
        };
        assert!(fb_offset >= 1, "fallback_offset must be clamped >= 1");

        // 验证 4C 闭环：按 4C footer 提示执行下一跳调用，顺利切入 range 模式并线性推进
        let r4c_step2 = ReadFileTool::default()
            .execute(
                &format!(r#"{{"path":"wide_code.rs","offset":{fb_offset},"limit":{fb_limit}}}"#),
                &ctx(d.path()),
            )
            .await;
        assert!(!r4c_step2.is_error, "{}", r4c_step2.content);
        let resp4c_step2: ReadResponse = serde_json::from_str(&r4c_step2.content).unwrap();
        assert_eq!(resp4c_step2.mode, "range");
        if let ReadMeta::Range(range_meta) = resp4c_step2.meta {
            assert_eq!(range_meta.start_line, fb_offset);
            // 无论这一页全部读完还是字节截断，Range 模式都能线性推进且不形成 4C 死循环
            if range_meta.truncated {
                assert!(range_meta.next_offset.is_some());
                assert!(range_meta.next_offset.unwrap() > fb_offset);
            }
        } else {
            panic!("expected RangeMeta for fallback execution");
        }
        assert!(resp4c
            .footer
            .contains("Window truncated at byte budget; showing partial context"));
        assert!(resp4c
            .footer
            .contains("To get full context: use `read` with offset="));
    }

    #[tokio::test]
    async fn silent_absorption_between_modes() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("file.rs"), "fn hello() {}\nfn world() {}\n").unwrap();

        // 分页模式：传入 upward, downward, max_matches，全部被静默吸收，依然是 range 模式
        let r_range = ReadFileTool::default()
            .execute(
                r#"{"path":"file.rs","upward":10,"downward":20,"max_matches":5}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r_range.is_error, "{}", r_range.content);
        let resp_range: ReadResponse = serde_json::from_str(&r_range.content).unwrap();
        assert_eq!(resp_range.mode, "range");

        // key_string 模式：传入 offset, limit，全部被静默吸收，依然是 key_string 模式
        let r_key = ReadFileTool::default()
            .execute(
                r#"{"path":"file.rs","key_string":"hello","offset":5,"limit":1}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r_key.is_error, "{}", r_key.content);
        let resp_key: ReadResponse = serde_json::from_str(&r_key.content).unwrap();
        assert_eq!(resp_key.mode, "key_string");
        assert!(resp_key.content.contains("fn hello"));
    }

    #[test]
    fn read_file_is_parallel_safe() {
        let t = ReadFileTool::new(false); // vision flag irrelevant here
        assert!(t.read_only_hint(), "read_file has no side effects");
        assert!(t.parallel_safe("{}"), "read_file may run concurrently");
        assert!(
            t.never_truncate_result(),
            "read_file pages must not be folded by the 64 KiB artifact cap"
        );
    }
}
