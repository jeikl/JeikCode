//! `read_file` — read a file (or list a directory) with line numbers and optional
//! slicing. Non-destructive ⇒ always `Safe`. Neutral core ported from the production
//! reader, minus the coding enrichments (semantic skeleton, read_cache, file_store).

use super::{err, looks_binary, not_found_hint, ok, ok_with_images, resolve_path};
use crate::tool_feedback::{format_path_not_found, parse_tool_args};
use async_trait::async_trait;
use base64::Engine;
use jeikcode_kernel::message::ImageContent;
use jeikcode_kernel::tool::{Tool, ToolContext, ToolResult};
use serde::Deserialize;
use serde_json::json;

/// Hard safety ceiling for the current in-memory decoder. Default pagination
/// controls model-visible output, but decoding still needs the complete file for
/// UTF-8/GB18030 detection and codeintel. Refuse pathological inputs uniformly,
/// including callers that supplied an offset/limit.
const MAX_IN_MEMORY_BYTES: u64 = 64 * 1024 * 1024;
/// Default page size when the caller omits `limit`. Midway between Grok (1000)
/// and OpenCode (2000). Remainder is always recoverable via `offset` + omit
/// `limit` (same continuation contract as Grok); do not dump the rest into this page.
const DEFAULT_READ_LIMIT: usize = 1500;
/// Keep one page (body plus continuation) under this budget.
/// OpenCode caps at 50 KiB; Grok rejects ranges above ~25k tokens (~80 KiB of
/// numbered source). Midpoint 65 KiB. A footer always tells the model how to
/// read the rest.
const MAX_READ_OUTPUT_BYTES: usize = 65 * 1024;
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

fn continuation_footer(start: usize, end: usize, total: usize) -> String {
    let next_offset = end + 1;
    format!(
        "\n[Showing lines {start}-{end} of {total}. \
         Avoid reading large files end-to-end; prefer targeted slices around symbols found via `grep`. (Next offset: {next_offset})]"
    )
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
        "Read file content, view and inspect images, or list directory contents."
    }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to read: reads text content for files, lists structure for directories, or inspects visual content for images."
                },
                "offset": {
                    "type": "integer",
                    "default": 1,
                    "description": "The line number to start reading from (1-based). Only provide if the file is too large to read at once. Supports negative integers to read tail lines."
                },
                "key_string": {
                    "type": "string",
                    "description": "Key string or multi-line snippet to search and center window around (case-insensitive)."
                },
                "upward": {
                    "type": "integer",
                    "default": 25,
                    "description": "Anchor mode: context lines above the match (default 25). Only provide when key_string is specified."
                },
                "downward": {
                    "type": "integer",
                    "default": 75,
                    "description": "Anchor mode: context lines below the match (default 75). Only provide when key_string is specified."
                },
                "max_matches": {
                    "type": "integer",
                    "description": "Maximum number of matches to display when key_string multiple matches exist."
                },
                "limit": {
                    "type": "integer",
                    "default": 1500,
                    "minimum": 1,
                    "description": "The number of lines to read. Only provide if the file is too large to read at once. Not used when key_string is provided."
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
                        let size_str = if let Ok(m) = e.metadata().await {
                            let bytes = m.len();
                            if bytes < 1024 {
                                format!("{bytes} B")
                            } else if bytes < 1024 * 1024 {
                                format!("{:.1} KB", bytes as f64 / 1024.0)
                            } else {
                                format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
                            }
                        } else {
                            String::new()
                        };
                        if size_str.is_empty() {
                            name.clone()
                        } else {
                            format!("{name}  ({size_str})")
                        }
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
            let count = match (a.limit, a.downward) {
                (Some(l), Some(d)) => l.min(d),
                (Some(l), None) => l,
                (None, Some(d)) => d,
                (None, None) => DEFAULT_READ_LIMIT,
            };
            let end_idx = start_idx.saturating_add(count).min(total);

            let display_path = crate::pathnorm::to_display(&path);
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
        if let Some(ref target) = a.key_string {
            let is_backward = a.offset.is_some_and(|o| o < 0);
            let search_start_line = if is_backward {
                let neg = a.offset.unwrap().unsigned_abs();
                if neg == 0 || neg >= total {
                    total.saturating_sub(1)
                } else {
                    total.saturating_sub(neg)
                }
            } else {
                match a.offset {
                    Some(p) if p > 0 => (p as usize).saturating_sub(1),
                    _ => 0,
                }
            };

            let (matched_indices, snippet_lines, clean_needle) =
                find_key_string_matches_robust(&text, target, is_backward, search_start_line);

            if matched_indices.is_empty() {
                let note = format!(
                    "[Note: key_string {:?} not found (direction: {}). Showing regular window from line {}:]\n",
                    target,
                    if is_backward { "backward" } else { "forward" },
                    search_start_line + 1
                );
                let s_idx = search_start_line.min(total);
                let e_idx = s_idx
                    .saturating_add(a.limit.unwrap_or(DEFAULT_READ_LIMIT))
                    .min(total);
                let mut out = note;
                for (i, &line) in file_lines[s_idx..e_idx].iter().enumerate() {
                    let n = s_idx + i + 1;
                    out.push_str(&format!("{n}→{line}\n"));
                }
                crate::tools::write_state::record_read(&path);
                return ok(out);
            }

            let up = a.upward.unwrap_or(25);
            let down = a.downward.unwrap_or(75);
            let limit_count = a.max_matches.unwrap_or(matched_indices.len());
            let chosen = &matched_indices[..matched_indices.len().min(limit_count)];

            let mut out = String::new();
            if matched_indices.len() == 1 {
                let found = matched_indices[0];
                out.push_str(&format!("[KeyString matched at line {}]\n", found + 1));
                let s_idx = found.saturating_sub(up);
                let e_idx = (found + snippet_lines + down).min(total);
                for line_idx in s_idx..e_idx {
                    let line = file_lines[line_idx];
                    let n = line_idx + 1;
                    if line.chars().count() > MAX_LINE_LEN {
                        let head: String = line.chars().take(MAX_LINE_LEN).collect();
                        out.push_str(&format!(
                            "{n}→{head}... (line truncated to {MAX_LINE_LEN} chars)\n"
                        ));
                    } else {
                        out.push_str(&format!("{n}→{line}\n"));
                    }
                }
            } else {
                out.push_str(&format!(
                    "[Found {} matches for key_string {:?} (direction: {}, showing {}):]\n",
                    matched_indices.len(),
                    clean_needle,
                    if is_backward { "backward" } else { "forward" },
                    chosen.len()
                ));
                for (match_idx, &found) in chosen.iter().enumerate() {
                    out.push_str(&format!(
                        "\n--- [Match {}] at line {} ---\n",
                        match_idx + 1,
                        found + 1
                    ));
                    let s_idx = found.saturating_sub(up);
                    let e_idx = (found + snippet_lines + down).min(total);
                    for line_idx in s_idx..e_idx {
                        let line = file_lines[line_idx];
                        let n = line_idx + 1;
                        let mark = if line_idx >= found && line_idx < found + snippet_lines {
                            ">>>"
                        } else {
                            "   "
                        };
                        if line.chars().count() > MAX_LINE_LEN {
                            let head: String = line.chars().take(MAX_LINE_LEN).collect();
                            out.push_str(&format!(
                                "{mark}{n}→{head}... (line truncated to {MAX_LINE_LEN} chars)\n"
                            ));
                        } else {
                            out.push_str(&format!("{mark}{n}→{line}\n"));
                        }
                        if out.len() > MAX_READ_OUTPUT_BYTES {
                            out.push_str(&format!(
                                "\n... [Output budget reached; remaining {} matches omitted]",
                                chosen.len().saturating_sub(match_idx + 1)
                            ));
                            break;
                        }
                    }
                    if out.len() > MAX_READ_OUTPUT_BYTES {
                        break;
                    }
                }
            }
            crate::tools::write_state::record_read(&path);
            return ok(out);
        }

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
            let count = match (a.limit, a.downward) {
                (Some(l), Some(d)) => l.min(d),
                (Some(l), None) => l,
                (None, Some(d)) => d,
                (None, None) => DEFAULT_READ_LIMIT,
            };
            (s, s_idx, count)
        };

        if start_idx >= total && total > 0 {
            return ok(format!(
                "[no lines in requested range (start={start}, total={total})]"
            ));
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
            let footer_len = if candidate_end < total {
                continuation_footer(start, candidate_end, total).len()
            } else if start > 1 {
                format!("\n[Showing lines {start}-{candidate_end} of {total} (End of file)]").len()
            } else {
                0
            };
            if !skill_md
                && !out.is_empty()
                && out
                    .len()
                    .saturating_add(rendered.len())
                    .saturating_add(footer_len)
                    > MAX_READ_OUTPUT_BYTES
            {
                break;
            }
            out.push_str(&rendered);
            end_idx = candidate_end;
        }
        if end_idx < total {
            out.push_str(&continuation_footer(start, end_idx, total));
        } else if start > 1 {
            out.push_str(&format!(
                "\n[Showing lines {start}-{end_idx} of {total} (End of file)]"
            ));
        }
        crate::tools::write_state::record_read(&path);
        ok(out)
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
            r.content.contains("Showing lines 2-3 of 5"),
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
            r.content.contains("Showing lines 1-1500 of 3505.")
                && r.content.contains("(Next offset: 1501)")
                && !r.content.contains("remaining")
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
        let footer = continuation_footer(1, 10, 100);
        assert!(!footer.contains("read_file("), "{footer}");
        assert!(!footer.contains("remaining"), "{footer}");
        assert!(!footer.contains("capped"), "{footer}");
        assert!(footer.contains("Showing lines 1-10 of 100"), "{footer}");
        assert!(footer.contains("(Next offset: 11)"), "{footer}");
        assert!(
            footer.contains("Avoid reading large files end-to-end"),
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
        assert!(r.content.contains("5→content_5"), "{}", r.content);
        assert!(r.content.contains("\ncontent_6\n"), "{}", r.content);
        assert!(!r.content.contains("6→"), "{}", r.content);
        assert!(r.content.contains("10→content_10"), "{}", r.content);
        assert!(r.content.contains("\ncontent_15\n"), "{}", r.content);
        assert!(!r.content.contains("15→"), "{}", r.content);
        assert!(r.content.contains("20→content_20"), "{}", r.content);
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
            r.content.contains("Showing lines 1-1500 of 1800.")
                && r.content.contains("(Next offset: 1501)")
                && !r.content.contains("remaining"),
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
                .contains("[Showing lines 1501-1800 of 1800 (End of file)]"),
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

        // 仅传 offset + downward，没有传 limit：必须准确截断为 downward 行，不能跑满 1500
        let r = ReadFileTool::default()
            .execute(
                r#"{"path":"sample.txt","offset":10,"downward":5}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("10→line_10"), "{}", r.content);
        assert!(r.content.contains("14→line_14"), "{}", r.content);
        assert!(!r.content.contains("line_15"), "{}", r.content);
        assert!(
            r.content.contains("Showing lines 10-14 of 200"),
            "{}",
            r.content
        );

        // limit 和 downward 同时传入相同值（模型防御性双传场景）
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
