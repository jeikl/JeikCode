//! `edit` — replace an exact, UNIQUE text fragment in a file (or all of them
//! with `replace_all`). Mutates the filesystem ⇒ always `Risky`.
//!
//! Public schema matches mainstream agent editors: `old_string` / `new_string`,
//! optional same-file `edits` array, optional `replace_all`. Line numbers are
//! hints. Weak-model quirks (stringified arrays, stale line numbers, CRLF /
//! indent / blank-line drift) are repaired internally and are not advertised.
//!
//! # Match pipeline (heal vs diagnose vs rebase)
//!
//! 1. **Exact** byte/EOL match (O(file + needle)).
//! 2. **Heal** cascade (shared [`NormalizedFile`]: trim / token / comment / block-anchor /
//!    boundary). Sliding windows compare precomputed slices — never allocate a window
//!    `Vec` per line, never run character Levenshtein on a whole hunk.
//! 3. **Diagnose** (user-facing miss only, once): rolling token-bag + tiny-hunk line
//!    similarity, then one bounded `similar` TextDiff. History rebase probing uses
//!    [`apply_hunk_direct`] and stops after (2).

pub(crate) use super::coerce_eol;
use super::{err, ok, resolve_path};
use crate::tool_feedback::{format_path_not_found, parse_tool_args};
use async_trait::async_trait;
use jeikcode_kernel::tool::{RiskLevel, Tool, ToolContext, ToolResult};
use serde::Deserialize;
use serde_json::json;

pub struct EditFileTool;

#[derive(Deserialize)]
struct Args {
    #[serde(alias = "file_path", alias = "target_file", alias = "filePath")]
    path: String,
    #[serde(
        default,
        alias = "old_str",
        alias = "oldText",
        alias = "search",
        deserialize_with = "deserialize_lenient_string"
    )]
    old_string: String,
    #[serde(
        default,
        alias = "new_str",
        alias = "newText",
        alias = "replace",
        deserialize_with = "deserialize_lenient_string"
    )]
    new_string: String,
    #[serde(default)]
    replace_all: bool,
    #[serde(default, deserialize_with = "deserialize_edits")]
    edits: Vec<EditHunk>,
}

#[derive(Deserialize, Clone, Default)]
pub(crate) struct EditHunk {
    #[serde(default, alias = "old_str", alias = "oldText", alias = "search")]
    pub(crate) old_string: String,
    #[serde(default, alias = "new_str", alias = "newText", alias = "replace")]
    pub(crate) new_string: String,
    #[serde(default)]
    pub(crate) replace_all: bool,
    /// 1-based match index when `old_string` is not unique. 0 means unset.
    #[serde(default)]
    pub(crate) occurrence: u32,
    /// 1-based index from the user's original input order.
    #[serde(skip)]
    pub(crate) original_index: usize,
}

#[async_trait]
impl Tool for EditFileTool {
    fn name(&self) -> &str {
        "edit"
    }
    fn aliases(&self) -> &'static [&'static str] {
        &["edit_file"]
    }
    fn description(&self) -> &str {
        "Modify file content via exact string replacement."
    }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Path of the file to edit (relative or absolute)." },
                "edits": {
                    "type": "array",
                    "description": "Series of replacement edits to apply in sequence.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "old_string": { "type": "string", "description": "Exact text to find and replace." },
                            "new_string": { "type": "string", "description": "Replacement text." },
                            "replace_all": { "type": "boolean", "description": "Replace all occurrences (default false)." },
                            "occurrence": { "type": "integer", "minimum": 1, "description": "1-based match index when old_string appears multiple times (ignored when replace_all is true)." }
                        },
                        "required": ["old_string", "new_string"]
                    }
                }
            },
            "required": ["path", "edits"]
        })
    }
    fn risk(&self, _args: &str) -> RiskLevel {
        RiskLevel::Risky // mutates an existing file
    }
    fn always_grant_scope(&self, _args: &str) -> String {
        // Tool-wide: "总是 / Always" approves every edit this session (v1 parity),
        // not just this one exact file/old/new triple.
        String::new()
    }
    fn coalesce_group_key(&self, args: &str) -> Option<String> {
        crate::tools::repair::edit_file_coalesce_key(args)
    }
    fn merge_coalesced_args(&self, args_list: &[&str]) -> Option<String> {
        crate::tools::repair::merge_edit_file_args(args_list)
    }
    async fn execute(&self, args: &str, ctx: &ToolContext) -> ToolResult {
        // 调用方是否真的传了非空 `edits[]`（而非便捷形）。必须在归一化前判定：
        // 归一化会把顶层 old/new 对合成进 edits[]，之后无法再区分两者。
        let caller_passed_edits = serde_json::from_str::<serde_json::Value>(args)
            .ok()
            .and_then(|value| value.get("edits").cloned())
            .is_some_and(|edits| edits.as_array().is_some_and(|list| !list.is_empty()));
        // 定位式报错要在**原始 args** 上做：`deserialize_edits` 会把“只有 new_string”的
        // hunk 静默丢掉，解析后就无法再点名是哪一条缺字段了。
        let raw_edits_missing_old_string = serde_json::from_str::<serde_json::Value>(args)
            .ok()
            .and_then(|value| value.get("edits").cloned())
            .and_then(|edits| edits.as_array().cloned())
            .and_then(|list| {
                let missing: Vec<usize> = list
                    .iter()
                    .enumerate()
                    .filter(|(_, hunk)| {
                        hunk.is_object()
                            && ["old_string", "old_str", "oldText", "search"]
                                .iter()
                                .all(|key| {
                                    hunk.get(key)
                                        .and_then(|value| value.as_str())
                                        .map(str::trim)
                                        .unwrap_or("")
                                        .is_empty()
                                })
                    })
                    .map(|(index, _)| index)
                    .collect();
                (!missing.is_empty()).then_some((missing, list.len()))
            });
        // 混合情形（部分 hunk 缺 `old_string`）→ 在入参校验之前就点名第几条，
        // 否则会被笼统的 "each hunk needs old_string and new_string" 抢先拒掉。
        // 全缺则保留既有笼统提示（不改变旧行为）。
        if let Some((missing, total)) = raw_edits_missing_old_string.clone() {
            if missing.len() < total {
                return err(format!(
                    "edit: edits[{}] is missing `old_string` (the exact text to find). \
                     Provide it or drop that hunk — the file was NOT modified.",
                    missing[0]
                ));
            }
        }
        let args = crate::tools::repair::normalize_edit_file_args(args);
        let a: Args = match parse_tool_args(
            "edit",
            &args,
            r#"{"path":"<path>","edits":[{"old_string":"<exact>","new_string":"<replacement>"}]}"#,
        )
        .or_else(|_| {
            parse_tool_args(
                "edit_file",
                &args,
                r#"{"path":"<path>","edits":[{"old_string":"<exact>","new_string":"<replacement>"}]}"#,
            )
        }) {
            Ok(a) => a,
            Err(e) => return e.into_tool_result(),
        };
        // 顶层 `replace_all` 只属于“便捷形”（无 edits[]，顶层 old/new 对）。
        // 一旦调用方用了 `edits[]`，顶层开关会静默失效（仅 hunk 级生效），
        // 造成“我以为全局全替换、实际只替换第一处”——宁可响亮报错也不静默降级。
        if caller_passed_edits && a.replace_all {
            return err(
                "edit: `replace_all` is per-hunk — move it inside `edits[]` \
                 (e.g. edits:[{\"old_string\":…,\"new_string\":…,\"replace_all\":true}]). \
                 The top-level `replace_all` only applies to the single-hunk convenience form \
                 (old_string/new_string without `edits`). The file was NOT modified."
                    .to_string(),
            );
        }
        // 混合情形（部分 hunk 缺 `old_string`）已在入参校验前拦截；这里只保留全缺时的笼统提示。
        if let Some((missing, total)) = raw_edits_missing_old_string {
            if missing.len() == total && total > 1 {
                return err(format!(
                    "edit: edits[{}] is missing `old_string` (the exact text to find). \
                     Provide it or drop that hunk — the file was NOT modified.",
                    missing[0]
                ));
            }
        }
        let hunks: Vec<EditHunk> = if !a.edits.is_empty() {
            a.edits
        } else if !a.old_string.is_empty() || !a.new_string.is_empty() {
            vec![EditHunk {
                old_string: a.old_string,
                new_string: a.new_string,
                replace_all: a.replace_all,
                occurrence: 0,
                original_index: 1,
            }]
        } else {
            Vec::new()
        };
        if hunks.is_empty()
            || hunks
                .iter()
                .all(|h| h.old_string.is_empty() && h.new_string.is_empty())
        {
            return err(
                "edit: provide a non-empty `edits` array with `old_string` and `new_string`."
                    .to_string(),
            );
        }
        // 定位式报错：直接点名第几条 hunk 缺哪个字段（`edits[N]`），让模型一次重试命中，
        // 而不是回看整段 payload 猜是哪一条（否则只能拿到 "not found" 这类误导性错误）。
        // 到此处已排除“全部 hunk 都空”的情形。
        for (index, hunk) in hunks.iter().enumerate() {
            if hunk.old_string.is_empty() {
                return err(format!(
                    "edit: edits[{index}] is missing `old_string` (the exact text to find). \
                     Provide it or drop that hunk — the file was NOT modified."
                ));
            }
        }
        let path = resolve_path(&a.path, &ctx.working_dir);
        let raw = match tokio::fs::read(&path).await {
            Ok(b) => b,
            Err(e) => {
                if e.kind() == std::io::ErrorKind::NotFound {
                    return err(format_path_not_found(
                        "edit",
                        &a.path,
                        &path,
                        &ctx.working_dir,
                    ));
                }
                return err(format!(
                    "edit: cannot read {}: {e}",
                    crate::pathnorm::to_display(&path)
                ));
            }
        };
        // Decode to UTF-8 for matching, remembering the on-disk encoding so the edit is
        // written back in the SAME encoding. A GBK/GB18030 file (Chinese Windows) is
        // edited in place; an ambiguous non-UTF-8 file is refused, not corrupted.
        let decoded = match crate::tools::encoding::decode_for_edit(&path, &raw) {
            Some(d) => d,
            None => {
                return err(format!(
                    "edit: cannot read {} as UTF-8 or a supported legacy text encoding \
                     (GBK/GB18030). Convert it to UTF-8 first. The file was NOT modified.",
                    crate::pathnorm::to_display(&path)
                ))
            }
        };
        let content = decoded.text;
        let file_encoding = decoded.encoding;

        // CPU-bound heal / diagnose / 3-way rebase MUST NOT run on the async worker:
        // the old Levenshtein diagnostic pinned the runtime for minutes, so Esc/Ctrl-C
        // (ctx.cancel) could not be polled — a user-visible deadlock. spawn_blocking
        // plus cooperative cancel checks keep the event loop live.
        let cancel = ctx.cancel.clone();
        let path_cpu = path.clone();
        let original = content.clone();
        let applied = match tokio::task::spawn_blocking(move || {
            apply_hunks_cpu(&path_cpu, content, hunks, &cancel)
        })
        .await
        {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => return err(e),
            Err(e) => {
                return err(format!("edit: apply task failed: {e}"));
            }
        };
        let HunkApplyResult {
            buf,
            total,
            kinds,
            auto_healed_old_strings,
            skipped,
        } = applied;
        if total == 0 && buf == original {
            let skip_note = if skipped.is_empty() {
                String::new()
            } else {
                format!(" skipped hunks: {}.", skipped.join(", "))
            };
            return ok(format!(
                "edit: no replacements applied; the file was not modified.{skip_note}"
            ));
        }
        if let Err(msg) = write_encoded(&path, &buf, file_encoding).await {
            return err(msg);
        }
        // Record the newly edited version into VersionRing
        crate::tools::edit_history::record_version(&path, &buf);
        crate::tools::write_state::record_edit(&path);
        #[cfg(feature = "codeintel")]
        crate::codeintel::notify_code_index_file_changed(&path, Some(&buf));
        let diff = build_compact_diff(&original, &buf, Some(&path));
        let kind_note = if kinds.len() == 1 {
            if kinds[0] == "exact" {
                String::new()
            } else {
                format!(" ({})", kinds[0])
            }
        } else {
            format!(" ({} hunks: {})", kinds.len(), kinds.join(", "))
        };

        let mut out = String::new();

        if !auto_healed_old_strings.is_empty() {
            let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
            let latest_str = auto_healed_old_strings.join("\n---\n");
            out.push_str(&format!(
                "⚠️ **[Auto-heal Note]**: A conflict in old_string was safely resolved and applied. If future edits touch this section, use the latest content below:\n```{ext}\n{latest_str}\n```\n\nEdit applied successfully!\n\n"
            ));
        }

        if !skipped.is_empty() {
            out.push_str("skipped hunks: ");
            out.push_str(&skipped.join(", "));
            out.push('\n');
        }
        out.push_str(&format!(
            "The file {} has been updated successfully ({total} replacement{}{kind_note}). Edited successfully.",
            crate::pathnorm::to_display(&path),
            if total == 1 { "" } else { "s" },
        ));
        if !diff.is_empty() {
            out.push('\n');
            out.push_str(&diff);
        }
        return ok(out);
    }
}

struct HunkApplyResult {
    buf: String,
    total: usize,
    kinds: Vec<&'static str>,
    auto_healed_old_strings: Vec<String>,
    skipped: Vec<String>,
}

/// Sync heal / diagnose / rebase. Runs on `spawn_blocking` so it cannot pin the
/// async worker. Polls `cancel` between hunks and between history snapshots.
fn apply_hunks_cpu(
    path: &std::path::Path,
    content: String,
    hunks: Vec<EditHunk>,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<HunkApplyResult, String> {
    if cancel.is_cancelled() {
        return Err("edit: cancelled.".into());
    }
    crate::tools::edit_history::record_version(path, &content);
    let mut hunks = hunks;
    for (idx, h) in hunks.iter_mut().enumerate() {
        if h.original_index == 0 {
            h.original_index = idx + 1;
        }
    }

    // 强化 3：在多 hunk 情形下，利用已有明确锚定点的行号区间对多匹配的 hunk 做拓扑消歧
    disambiguate_hunks_topologically(&content, &mut hunks);

    let hunks = if hunks.len() > 1 {
        sort_hunks_topologically(&content, &hunks)
    } else {
        hunks
    };

    // 强化 1：预检校验 / 试运行流水线。如果发现错误，收集全部失败 hunk 的精准诊断，聚合输出
    let mut test_buf = content.clone();
    let mut preflight_total = 0usize;
    let mut preflight_kinds: Vec<&'static str> = Vec::new();
    let mut preflight_healed: Vec<String> = Vec::new();
    let mut preflight_skipped: Vec<String> = Vec::new();
    let mut failed_hunks: Vec<(usize, String)> = Vec::new();

    let orig_lines: Vec<&str> = content.lines().collect();

    #[derive(Debug, Clone)]
    struct AppliedHunkInfo {
        original_index: usize,
        old_start_line: usize,
        old_end_line: usize,
        new_string: String,
    }
    let mut applied_records: Vec<AppliedHunkInfo> = Vec::new();

    for (i, h) in hunks.iter().enumerate() {
        if cancel.is_cancelled() {
            return Err("edit: cancelled.".into());
        }
        if !h.old_string.is_empty() && h.old_string == h.new_string {
            preflight_skipped.push(format!("{} (identical old/new)", i + 1));
            preflight_kinds.push("skipped-identical");
            continue;
        }
        match apply_hunk(
            Some(path),
            &test_buf,
            &h.old_string,
            &h.new_string,
            h.replace_all,
            h.occurrence,
        ) {
            Ok((next, n, kind, actual_matched)) => {
                let (s, e) = locate_hunk_lines(&orig_lines, &h.old_string).unwrap_or((0, 0));
                applied_records.push(AppliedHunkInfo {
                    original_index: h.original_index,
                    old_start_line: s + 1,
                    old_end_line: e,
                    new_string: h.new_string.clone(),
                });
                test_buf = next;
                preflight_total += n;
                preflight_kinds.push(kind);
                if let Some(actual) = actual_matched {
                    preflight_healed.push(actual);
                }
            }
            Err(e) => {
                if let Some(rebased) = crate::tools::edit_history::try_history_rebase_cancel(
                    path,
                    &test_buf,
                    &h.old_string,
                    &h.new_string,
                    h.replace_all,
                    Some(cancel),
                ) {
                    let (s, e) = locate_hunk_lines(&orig_lines, &h.old_string).unwrap_or((0, 0));
                    applied_records.push(AppliedHunkInfo {
                        original_index: h.original_index,
                        old_start_line: s + 1,
                        old_end_line: e,
                        new_string: h.new_string.clone(),
                    });
                    test_buf = rebased.merged_content;
                    preflight_total += 1;
                    preflight_kinds.push("historical 3-way rebase");
                    if !rebased.actual_old_string.is_empty() {
                        preflight_healed.push(rebased.actual_old_string);
                    }
                } else if cancel.is_cancelled() {
                    return Err("edit: cancelled.".into());
                } else {
                    let hunk_idx = if h.original_index > 0 {
                        h.original_index
                    } else {
                        i + 1
                    };
                    failed_hunks.push((hunk_idx, e));
                }
            }
        }
    }

    if !failed_hunks.is_empty() {
        // 级联冲突识别（只有在各种拓扑排序和全部编辑试运行完毕后的最终状态才进行因果推导）：
        let mut cascade_causes: std::collections::HashSet<usize> = std::collections::HashSet::new();
        let mut cascade_victims: std::collections::HashMap<usize, usize> =
            std::collections::HashMap::new();

        for (victim_orig_idx, e) in failed_hunks.iter_mut() {
            if let Some(victim_hunk) = hunks.iter().find(|h| h.original_index == *victim_orig_idx) {
                if let Some((target_s, target_e)) =
                    locate_hunk_lines(&orig_lines, &victim_hunk.old_string)
                {
                    let target_start = target_s + 1;
                    let target_end = target_e;

                    if let Some(cause) = applied_records.iter().find(|app| {
                        let max_start = app.old_start_line.max(target_start);
                        let min_end = app.old_end_line.min(target_end);
                        max_start <= min_end && app.old_end_line > 0 && target_end > 0
                    }) {
                        let inter_start = cause.old_start_line.max(target_start);
                        let inter_end = cause.old_end_line.min(target_end);
                        cascade_causes.insert(cause.original_index);
                        cascade_victims.insert(*victim_orig_idx, cause.original_index);

                        *e = format_cascade_conflict_diagnostic(
                            cause.original_index,
                            *victim_orig_idx,
                            (cause.old_start_line, cause.old_end_line),
                            (target_start, target_end),
                            (inter_start, inter_end),
                            &cause.new_string,
                            &victim_hunk.old_string,
                            &test_buf,
                            Some(path),
                        );
                    }
                }
            }
        }

        if failed_hunks.len() == 1 {
            let (hunk_idx, e) = &failed_hunks[0];
            let prior_success_count = hunks
                .iter()
                .position(|h| h.original_index == *hunk_idx)
                .unwrap_or(0);
            let prior_note = if prior_success_count > 0 {
                format!(
                    " (Note: previous {} hunk(s) applied cleanly in temporary buffer, but all changes were discarded)",
                    prior_success_count
                )
            } else {
                String::new()
            };
            return Err(format!(
                "edit: hunk {}/{} failed. The file was NOT modified.{prior_note} {e}",
                hunk_idx,
                hunks.len()
            ));
        } else {
            let mut report = format!(
                "edit: {} of {} hunks failed verification. The file was NOT modified.\n(All changes were safely discarded; no partial dirty writes occurred)\n\n\
                 {}\
                 📋 Hunk Verification Summary:\n",
                failed_hunks.len(),
                hunks.len(),
                EDIT_DIFF_PROTOCOL_LEGEND
            );

            for (i, h) in hunks.iter().enumerate() {
                let original_idx = if h.original_index > 0 {
                    h.original_index
                } else {
                    i + 1
                };
                let json_idx = original_idx.saturating_sub(1);
                if let Some((fail_num, _)) = failed_hunks
                    .iter()
                    .enumerate()
                    .find(|(_, (idx, _))| *idx == original_idx)
                {
                    if let Some(cause_id) = cascade_victims.get(&original_idx) {
                        report.push_str(&format!(
                            "  [✗] Hunk {}/{} (edits[{}]) : CASCADE BLOCKED by Hunk {} (see Failure {} below)\n",
                            original_idx,
                            hunks.len(),
                            json_idx,
                            cause_id,
                            fail_num + 1
                        ));
                    } else {
                        report.push_str(&format!(
                            "  [✗] Hunk {}/{} (edits[{}]) : failed verification (see Failure {} below)\n",
                            original_idx,
                            hunks.len(),
                            json_idx,
                            fail_num + 1
                        ));
                    }
                } else if cascade_causes.contains(&original_idx) {
                    report.push_str(&format!(
                        "  [✔] Hunk {}/{} (edits[{}]) : verified in memory (⚠️ CAUSE OF DOWNSTREAM CASCADE CONFLICTS)\n",
                        original_idx,
                        hunks.len(),
                        json_idx
                    ));
                } else {
                    report.push_str(&format!(
                        "  [✔] Hunk {}/{} (edits[{}]) : verified cleanly in memory\n",
                        original_idx,
                        hunks.len(),
                        json_idx
                    ));
                }
            }

            report.push_str(
                "\n========================================================================",
            );

            for (fail_num, (hunk_idx, e)) in failed_hunks.iter().enumerate() {
                // 已经在外层顶部统一渲染过协议说明，因此子错误块中如果包含重复说明则直接剔除，避免机械重复
                let sanitized_e = e.trim().replace(EDIT_DIFF_PROTOCOL_LEGEND.trim(), "");
                report.push_str(&format!(
                    "\n--- [Failure {}] Hunk {}/{} (edits[{}]) ---\n{}\n",
                    fail_num + 1,
                    hunk_idx,
                    hunks.len(),
                    hunk_idx.saturating_sub(1),
                    sanitized_e.trim()
                ));
            }

            report.push_str(
                "\n========================================================================\n",
            );
            if !cascade_victims.is_empty() {
                report.push_str("(Hint: cascading conflicts detected — merge overlapping sequential edits into ONE unified hunk instead of modifying overlapping lines sequentially)\n");
            } else {
                report.push_str("(Hint: fix only the failed hunks noted above; keep cleanly applied hunks intact; surrounding context lines without '-' or '+' are for reference only)\n");
            }

            return Err(report);
        }
    }

    Ok(HunkApplyResult {
        buf: test_buf,
        total: preflight_total,
        kinds: preflight_kinds,
        auto_healed_old_strings: preflight_healed,
        skipped: preflight_skipped,
    })
}

fn deserialize_lenient_string<'de, D>(d: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(d)?;
    match value {
        None | Some(serde_json::Value::Null) => Ok(String::new()),
        Some(serde_json::Value::String(s)) => Ok(s),
        // Sibling hunk objects / numbers must not fail the whole parse after a
        // partial shape-normalize miss; hunks are recovered from `edits`.
        Some(_) => Ok(String::new()),
    }
}

/// Hidden compatibility: the public schema types `edits` as a JSON array, but
/// some providers/models emit a stringified array (`"[{...}]"`). Decode one
/// layer; if that fails, run `repair_json` (raw newlines inside snippets) and
/// try again. A single object is wrapped as a one-element array. Dual types are
/// never advertised in the schema.
fn deserialize_edits<'de, D>(d: D) -> Result<Vec<EditHunk>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(d)?;
    match value {
        None | Some(serde_json::Value::Null) => Ok(Vec::new()),
        Some(v) => {
            crate::tools::repair::validate_complete_edits(&v).map_err(serde::de::Error::custom)?;
            parse_edits_value(v).map_err(serde::de::Error::custom)
        }
    }
}

fn parse_edits_value(value: serde_json::Value) -> Result<Vec<EditHunk>, String> {
    match value {
        serde_json::Value::Array(_) => {
            serde_json::from_value(value).map_err(|e| format!("edits array items: {e}"))
        }
        serde_json::Value::Object(map) => {
            if map.contains_key("old_string")
                || map.contains_key("new_string")
                || map.contains_key("old_str")
                || map.contains_key("search")
            {
                let hunk: EditHunk = serde_json::from_value(serde_json::Value::Object(map))
                    .map_err(|e| format!("edits object: {e}"))?;
                return Ok(vec![hunk]);
            }
            let mut keys: Vec<_> = map.keys().cloned().collect();
            keys.sort();
            let mut hunks = Vec::new();
            for k in keys {
                match parse_edits_value(map[&k].clone()) {
                    Ok(mut got) => hunks.append(&mut got),
                    Err(e) => return Err(e),
                }
            }
            if hunks.is_empty() {
                Err("edits object had no {old_string,new_string} hunks".into())
            } else {
                Ok(hunks)
            }
        }
        serde_json::Value::String(s) => parse_edits_string(&s),
        other => Err(format!(
            "edits must be a JSON array of {{old_string,new_string}} objects (got {other})"
        )),
    }
}

fn unwrap_stringified_json_layers(s: &str) -> String {
    let mut cur = s.trim().to_string();
    for _ in 0..3 {
        let t = cur.trim();
        if t.len() < 2 || !t.starts_with('"') {
            break;
        }
        let Ok(inner) = serde_json::from_str::<String>(t) else {
            break;
        };
        let inner_trim = inner.trim_start();
        if inner == cur
            || !(inner_trim.starts_with('[')
                || inner_trim.starts_with('{')
                || inner_trim.starts_with('"'))
        {
            break;
        }
        cur = inner;
    }
    cur
}

fn parse_edits_string(s: &str) -> Result<Vec<EditHunk>, String> {
    let t = unwrap_stringified_json_layers(s);
    let t = t.trim();
    if t.is_empty() {
        return Ok(Vec::new());
    }
    let parsed = crate::tools::repair::parse_complete_edits_string(t);
    match parsed {
        Ok(v) if v.is_array() || v.is_object() => {
            if let Some(inner) = v.get("edits") {
                return parse_edits_value(inner.clone());
            }
            parse_edits_value(v)
        }
        Ok(_) => Err("stringified edits decoded but was not a JSON array or object".into()),
        Err(e) => Err(format!(
            "edits was a string (expected a JSON array). Could not decode: {e}"
        )),
    }
}

fn apply_hunk(
    path: Option<&std::path::Path>,
    content: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
    occurrence: u32,
) -> Result<(String, usize, &'static str, Option<String>), String> {
    // User-facing path: heal, then diagnose at most once on the current file.
    apply_hunk_with(
        path,
        content,
        old_string,
        new_string,
        replace_all,
        occurrence,
        true,
    )
}

/// History-rebase probing path. Runs the same healing cascade as [`apply_hunk`]
/// but NEVER builds a closest-match diagnostic. Diagnosing on every historical
/// snapshot is what turned a missed 200-line hunk into a multi-minute hang.
pub(crate) fn apply_hunk_direct(
    content: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> Result<(String, usize, &'static str, Option<String>), String> {
    apply_hunk_with(None, content, old_string, new_string, replace_all, 0, false)
}

fn apply_hunk_with(
    path: Option<&std::path::Path>,
    content: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
    occurrence: u32,
    diagnose: bool,
) -> Result<(String, usize, &'static str, Option<String>), String> {
    if !old_string.is_empty() {
        return apply_text_hunk(
            path,
            content,
            old_string,
            new_string,
            replace_all,
            occurrence,
            diagnose,
        );
    }
    Err("edit: provide a non-empty `old_string` in each edit hunk.".into())
}

/// 强化 3：在多 hunk 批量编辑中，当某 hunk 出现多个完全相同的匹配点且 caller 未指定 occurrence 时，
/// 结合前后其它已有明确锚定点的 hunk 所在行号区间，进行拓扑消歧。
fn disambiguate_hunks_topologically(content: &str, hunks: &mut [EditHunk]) {
    if hunks.len() <= 1 {
        return;
    }

    let content_lines: Vec<&str> = content.lines().collect();

    // 1. 查找每个 hunk 的所有精确匹配行号范围 (start_line, end_line)
    let mut match_spans: Vec<Vec<(usize, usize)>> = Vec::with_capacity(hunks.len());
    for h in hunks.iter() {
        if h.old_string.is_empty() {
            match_spans.push(Vec::new());
            continue;
        }
        let old_lines: Vec<&str> = h.old_string.lines().collect();
        let n = old_lines.len();
        if n > content_lines.len() {
            match_spans.push(Vec::new());
            continue;
        }
        let mut spans = Vec::new();
        for i in 0..=content_lines.len() - n {
            if content_lines[i..i + n] == old_lines[..] {
                spans.push((i, i + n));
            }
        }
        match_spans.push(spans);
    }

    let n = hunks.len();
    let mut anchor_starts: Vec<Option<usize>> = vec![None; n];
    for i in 0..n {
        if match_spans[i].len() == 1 {
            anchor_starts[i] = Some(match_spans[i][0].0);
        } else if hunks[i].occurrence >= 1 && (hunks[i].occurrence as usize) <= match_spans[i].len()
        {
            anchor_starts[i] = Some(match_spans[i][hunks[i].occurrence as usize - 1].0);
        }
    }

    // 2. 尝试为具有多处匹配且 occurrence == 0 的 hunk 做拓扑定界消歧
    for i in 0..n {
        if hunks[i].occurrence != 0 || match_spans[i].len() <= 1 {
            continue;
        }

        // 在 caller 原始顺序中，寻找前置最近锚定行，和后置最近锚定行
        let prev_anchor = (0..i).rev().find_map(|k| anchor_starts[k]);
        let next_anchor = ((i + 1)..n).find_map(|k| anchor_starts[k]);

        let candidates_in_window: Vec<usize> = match_spans[i]
            .iter()
            .enumerate()
            .filter(|(_, &(start, _))| {
                if let Some(prev) = prev_anchor {
                    if start < prev {
                        return false;
                    }
                }
                if let Some(next) = next_anchor {
                    if start > next {
                        return false;
                    }
                }
                true
            })
            .map(|(idx, _)| idx + 1)
            .collect();

        // 场景 A: 该拓扑行号区间内，恰好只有 1 个候选匹配项！
        if candidates_in_window.len() == 1 {
            let occ = candidates_in_window[0];
            hunks[i].occurrence = occ as u32;
            anchor_starts[i] = Some(match_spans[i][occ - 1].0);
            continue;
        }

        // 场景 B: 连续相同 old_string 的多 hunk 序列与区间内的多个候选点 1 对 1 单调对齐
        let mut group_indices = vec![i];
        let mut k = i + 1;
        while k < n && hunks[k].old_string == hunks[i].old_string && hunks[k].occurrence == 0 {
            group_indices.push(k);
            k += 1;
        }
        if group_indices.len() > 1 && group_indices.len() == candidates_in_window.len() {
            for (g_idx, &h_idx) in group_indices.iter().enumerate() {
                let occ = candidates_in_window[g_idx];
                hunks[h_idx].occurrence = occ as u32;
                anchor_starts[h_idx] = Some(match_spans[h_idx][occ - 1].0);
            }
        }
    }
}

/// Topologically sorts multiple edit hunks within a file:
/// 1. Finds the read span [read_start, read_end] and write span [write_start, write_end]
///    for each hunk in `content`.
/// 2. If Hunk A's read span overlaps Hunk B's write span (and A doesn't write those lines),
///    Hunk A must execute before Hunk B (WAR: Write-After-Read).
/// 3. For disjoint/independent hunks, orders bottom-up (higher line numbers first)
///    so modifications deeper in the file do not perturb line offsets for earlier hunks.
fn sort_hunks_topologically(content: &str, hunks: &[EditHunk]) -> Vec<EditHunk> {
    if hunks.len() <= 1 {
        return hunks.to_vec();
    }

    struct HunkSpan {
        read_start: usize,
        read_end: usize,
        write_start: usize,
        write_end: usize,
        located: bool,
    }

    let content_lines: Vec<&str> = content.lines().collect();

    let mut spans = Vec::with_capacity(hunks.len());
    for h in hunks {
        if h.old_string.is_empty() {
            spans.push(HunkSpan {
                read_start: 0,
                read_end: 0,
                write_start: 0,
                write_end: 0,
                located: false,
            });
            continue;
        }

        let loc = locate_hunk_lines(&content_lines, &h.old_string);
        let (read_start, read_end) = match loc {
            Some((s, e)) => (s, e),
            None => {
                spans.push(HunkSpan {
                    read_start: 0,
                    read_end: 0,
                    write_start: 0,
                    write_end: 0,
                    located: false,
                });
                continue;
            }
        };

        // Determine write span within [read_start, read_end]
        let old_lines: Vec<&str> = h.old_string.lines().collect();
        let new_lines: Vec<&str> = h.new_string.lines().collect();
        let mut prefix_len = 0;
        while prefix_len < old_lines.len()
            && prefix_len < new_lines.len()
            && old_lines[prefix_len] == new_lines[prefix_len]
        {
            prefix_len += 1;
        }

        let mut suffix_len = 0;
        while suffix_len < (old_lines.len() - prefix_len)
            && suffix_len < (new_lines.len() - prefix_len)
            && old_lines[old_lines.len() - 1 - suffix_len]
                == new_lines[new_lines.len() - 1 - suffix_len]
        {
            suffix_len += 1;
        }

        let write_start = read_start + prefix_len;
        let write_end = if read_end >= suffix_len {
            read_end - suffix_len
        } else {
            read_start
        };
        let write_end = write_end.max(write_start);

        spans.push(HunkSpan {
            read_start,
            read_end,
            write_start,
            write_end,
            located: true,
        });
    }

    let n = hunks.len();
    let mut adj = vec![Vec::new(); n];
    let mut in_degree = vec![0usize; n];

    for i in 0..n {
        for j in 0..n {
            if i == j {
                continue;
            }
            if !spans[i].located || !spans[j].located {
                continue;
            }

            // WAR condition: Hunk i reads lines that Hunk j writes.
            // If i reads what j writes (and i does not write those lines), i must precede j.
            let i_reads_what_j_writes = spans[i].read_start < spans[j].write_end
                && spans[j].write_start < spans[i].read_end;
            let write_overlap = spans[i].write_start < spans[j].write_end
                && spans[j].write_start < spans[i].write_end;

            if i_reads_what_j_writes && !write_overlap {
                adj[i].push(j);
                in_degree[j] += 1;
            }
        }
    }

    // Topological sort with tie-breaking:
    // When multiple hunks have in_degree == 0, pick the one with HIGHER read_start (bottom-up).
    let mut result_indices = Vec::with_capacity(n);
    let mut available: Vec<usize> = (0..n).filter(|&i| in_degree[i] == 0).collect();

    while !available.is_empty() {
        available.sort_by(|&a, &b| {
            spans[b]
                .read_start
                .cmp(&spans[a].read_start)
                .then_with(|| a.cmp(&b))
        });

        let u = available.remove(0);
        result_indices.push(u);

        for &v in &adj[u] {
            in_degree[v] = in_degree[v].saturating_sub(1);
            if in_degree[v] == 0 {
                available.push(v);
            }
        }
    }

    if result_indices.len() < n {
        for i in 0..n {
            if !result_indices.contains(&i) {
                result_indices.push(i);
            }
        }
    }

    result_indices
        .into_iter()
        .map(|idx| hunks[idx].clone())
        .collect()
}

fn locate_hunk_lines(content_lines: &[&str], old_string: &str) -> Option<(usize, usize)> {
    let old_lines: Vec<&str> = old_string.lines().collect();
    if old_lines.is_empty() {
        return None;
    }
    let n = old_lines.len();
    if n > content_lines.len() {
        return None;
    }

    // 1. Exact lines match (slice compare, no per-window allocation).
    let mut matches = Vec::new();
    for i in 0..=content_lines.len() - n {
        if content_lines[i..i + n] == old_lines[..] {
            matches.push((i, i + n));
            if matches.len() > 1 {
                break;
            }
        }
    }
    if matches.len() == 1 {
        return Some(matches[0]);
    }

    // 2. Line-trimmed match. Precompute once; compare slices.
    let old_trimmed: Vec<&str> = old_lines.iter().map(|l| l.trim()).collect();
    let content_trimmed: Vec<&str> = content_lines.iter().map(|l| l.trim()).collect();
    let mut trimmed_matches = Vec::new();
    for i in 0..=content_trimmed.len() - n {
        if content_trimmed[i..i + n] == old_trimmed[..] {
            trimmed_matches.push((i, i + n));
            if trimmed_matches.len() > 1 {
                return None;
            }
        }
    }
    if trimmed_matches.len() == 1 {
        Some(trimmed_matches[0])
    } else {
        None
    }
}

/// If a model accidentally copies lines from `read` with the `LINE_NUMBER→` prefix,
/// this helper strips that prefix so the target snippet can match cleanly.
fn strip_line_prefix_hints(text: &str) -> Option<String> {
    let mut stripped = String::with_capacity(text.len());
    let mut had_prefix = false;
    for (i, line) in text.lines().enumerate() {
        if i > 0 {
            stripped.push('\n');
        }
        let trimmed = line.trim_start();
        if let Some(pos) = trimmed.find('→') {
            let prefix = trimmed[..pos].trim_start();
            if !prefix.is_empty() && prefix.chars().all(|c| c.is_ascii_digit()) {
                stripped.push_str(&trimmed[pos + '→'.len_utf8()..]);
                had_prefix = true;
                continue;
            }
        }
        stripped.push_str(line);
    }
    if had_prefix {
        if text.ends_with('\n') {
            stripped.push('\n');
        }
        Some(stripped)
    } else {
        None
    }
}

fn apply_text_hunk(
    path: Option<&std::path::Path>,
    content: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
    occurrence: u32,
    diagnose: bool,
) -> Result<(String, usize, &'static str, Option<String>), String> {
    if old_string == new_string {
        return Err("old_string and new_string are identical — nothing to change.".into());
    }

    let literal = content.matches(old_string).count();
    let (old_match, new_match, count) = if literal > 0 {
        (old_string.to_string(), new_string.to_string(), literal)
    } else {
        let file_eol = if content.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let old_c = coerce_eol(old_string, file_eol);
        let c = content.matches(&old_c).count();
        (old_c, coerce_eol(new_string, file_eol), c)
    };

    if count == 0 {
        if let Some(clean_old) = strip_line_prefix_hints(old_string) {
            let clean_new =
                strip_line_prefix_hints(new_string).unwrap_or_else(|| new_string.to_string());
            // Nested heal only — never diagnose here. A prefix-stripped miss would
            // otherwise run the closest-match scan twice (inner + outer).
            if let Ok(res) = apply_text_hunk(
                path,
                content,
                &clean_old,
                &clean_new,
                replace_all,
                occurrence,
                false,
            ) {
                let actual = res.3.unwrap_or(clean_old);
                return Ok((res.0, res.1, "stripped-arrow prefix match", Some(actual)));
            }
        }
        // One normalized view shared by every healer. Building this per matcher
        // used to re-tokenize the whole file 5× on every miss (and × history depth
        // on rebase probing).
        let file = NormalizedFile::new(content);
        if let Some((fuzzy_result, fuzzy_count, actual)) =
            try_fuzzy_replace(&file, old_string, new_string, replace_all)
        {
            if fuzzy_result != content {
                return Ok((
                    fuzzy_result,
                    fuzzy_count,
                    "line-trimmed whitespace match",
                    Some(actual),
                ));
            }
        }
        if let Some((token_result, token_count, actual)) =
            try_token_normalized_replace(&file, old_string, new_string, replace_all)
        {
            if token_result != content {
                return Ok((
                    token_result,
                    token_count,
                    "token-normalized match",
                    Some(actual),
                ));
            }
        }
        if let Some((comment_result, comment_count, actual)) =
            try_comment_style_replace(&file, old_string, new_string, replace_all)
        {
            if comment_result != content {
                return Ok((
                    comment_result,
                    comment_count,
                    "comment-style match",
                    Some(actual),
                ));
            }
        }
        if let Some((anchor_result, _, actual)) =
            try_block_anchor_replace(&file, old_string, new_string)
        {
            if anchor_result != content {
                return Ok((anchor_result, 1, "anchored block match", Some(actual)));
            }
        }
        if let Some((bound_result, _, actual)) =
            try_trimmed_boundary_replace(&file, old_string, new_string)
        {
            if bound_result != content {
                return Ok((bound_result, 1, "trimmed boundary match", Some(actual)));
            }
        }
        if diagnose {
            let hint = find_closest_match_snippet(path, &file, old_string).unwrap_or_default();
            return Err(format!("old_string not found in file.\n{hint}"));
        }
        return Err("old_string not found in file.".into());
    }
    if count > 1 && !replace_all {
        if occurrence >= 1 {
            if occurrence as usize > count {
                return Err(format!(
                    "occurrence {occurrence} is out of range (must be between 1 and {count}).\n{}",
                    format_match_sites(content, &old_match)
                ));
            }
            let updated = replace_nth(content, &old_match, &new_match, occurrence as usize);
            return Ok((updated, 1, "exact-occurrence", None));
        }
        return Err(format!(
            "old_string appears {count} times — it must be unique. Add surrounding context, set replace_all=true, or set occurrence to a 1-based index (1 to {count}).\n\n\
            👉 Resolution options (choose ONE):\n  \
            1. Add surrounding context lines to your old_string to make it unique (see surrounding lines below);\n  \
            2. Set \"occurrence\": 1 to {count} in this edit hunk to target a specific occurrence;\n  \
            3. Set \"replace_all\": true in this edit hunk to replace all {count} occurrences at once.\n\n\
            {}\n\
            (Hint: to make your old_string unique, include distinct lines above or below your target)",
            format_match_sites(content, &old_match)
        ));
    }
    if old_match == new_match {
        return Err(
            "old_string and new_string are identical after line-ending normalization.".into(),
        );
    }
    let updated = if replace_all {
        content.replace(&old_match, &new_match)
    } else {
        content.replacen(&old_match, &new_match, 1)
    };
    let replaced = if replace_all { count } else { 1 };
    Ok((updated, replaced, "exact", None))
}

fn replace_nth(content: &str, old: &str, new: &str, n: usize) -> String {
    let mut from = 0usize;
    let mut seen = 0usize;
    while let Some(rel) = content[from..].find(old) {
        seen += 1;
        let at = from + rel;
        if seen == n {
            let mut out = String::with_capacity(content.len() - old.len() + new.len());
            out.push_str(&content[..at]);
            out.push_str(new);
            out.push_str(&content[at + old.len()..]);
            return out;
        }
        from = at + old.len().max(1);
    }
    content.to_string()
}

fn format_match_sites(content: &str, needle: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let mut out = String::from("Matches:\n```````diff");
    let mut from = 0usize;
    let mut idx = 0usize;
    const MATCH_CONTEXT_RADIUS: usize = 6;
    while let Some(rel) = content[from..].find(needle) {
        idx += 1;
        let at = from + rel;
        let line_no = content[..at].bytes().filter(|&b| b == b'\n').count() + 1;
        let span = needle.lines().count().max(1);
        let start = line_no
            .saturating_sub(1)
            .saturating_sub(MATCH_CONTEXT_RADIUS);
        let end = (line_no - 1 + span + MATCH_CONTEXT_RADIUS).min(lines.len());
        out.push_str(&format!("\n\n--- [{idx}] line {line_no} ---"));
        for (i, line) in lines[start..end].iter().enumerate() {
            let n = start + i + 1;
            let mark = if n >= line_no && n < line_no + span {
                ">>>"
            } else {
                "   "
            };
            out.push_str(&format!("\n  {mark} {n:>4}| {line}"));
        }
        from = at + needle.len().max(1);
        if idx >= 8 {
            let rest = content[from..].matches(needle).count();
            if rest > 0 {
                out.push_str(&format!("\n  ... and {rest} more"));
            }
            break;
        }
    }
    out.push_str("\n```````");
    out
}

/// Write edited text back to `path` in its original on-disk `encoding`. Refuses (Err
/// with a user-facing message) rather than write replacement bytes if the text cannot
/// be represented — so a failed re-encode leaves the file untouched, never corrupted.
async fn write_encoded(
    path: &std::path::Path,
    text: &str,
    encoding: crate::tools::encoding::FileEncoding,
) -> Result<(), String> {
    let bytes = crate::tools::encoding::encode(text, encoding).ok_or_else(|| {
        format!(
            "edit: cannot re-encode the edit to {}'s original encoding; the file was \
             NOT modified. Convert it to UTF-8 first.",
            crate::pathnorm::to_display(path)
        )
    })?;
    tokio::fs::write(path, bytes).await.map_err(|e| {
        format!(
            "edit: failed to write {}: {e}",
            crate::pathnorm::to_display(path)
        )
    })
}

/// A compact GIT UNIFIED DIFF (`@@` hunks, 3 lines of context) between the OLD
/// and NEW whole-file contents, capped so a large edit can't flood the model
/// context / transcript. The TUI re-parses this into a line-numbered, color-
/// coded diff block; the model reads it as a normal unified diff.
pub(crate) fn build_compact_diff(
    old_file: &str,
    new_file: &str,
    path: Option<&std::path::Path>,
) -> String {
    const MAX_DIFF_LINES: usize = 60;
    let mut config = similar::TextDiff::configure();
    config.timeout(std::time::Duration::from_millis(200));
    let diff = config.diff_lines(old_file, new_file);
    let mut unified = diff.unified_diff();
    unified.context_radius(3);
    if let Some(p) = path {
        let display = crate::pathnorm::to_display(p);
        unified.header(&format!("a/{display}"), &format!("b/{display}"));
    }
    let full = unified.to_string();
    let full = full.trim_end();
    let lines: Vec<&str> = full.lines().collect();
    if lines.len() <= MAX_DIFF_LINES {
        return full.to_string();
    }
    let mut out = lines[..MAX_DIFF_LINES].join("\n");
    out.push_str(&format!(
        "\n… ({} more diff lines)",
        lines.len() - MAX_DIFF_LINES
    ));
    out
}

/// Number of leading whitespace **characters** in `s`. Counts Unicode
/// whitespace consistently with `chars().take(n)` — both operate on
/// characters, not bytes. This is the correct unit for indent arithmetic:
/// `" ".repeat(n)` and `chars().take(n)` both count characters.
fn leading_ws_chars(s: &str) -> usize {
    s.chars().take_while(|c| c.is_whitespace()).count()
}

/// Re-anchor `new_lines` to the file's REAL indentation at `original_line`: the first
/// non-empty new line is the anchor, and each line's SIGNED indent offset from it is
/// re-applied on top of the matched file line's actual leading whitespace (tabs
/// preserved, multi-byte whitespace counted by CHARACTER). Shared by both fuzzy tiers
/// ([`try_fuzzy_replace`] and [`try_block_anchor_replace`]).
fn reanchored_replacement(new_lines: &[&str], original_line: &str) -> Vec<String> {
    // Anchor indent = the first non-empty line of new_string. Using the first non-empty
    // line (NOT the min indent) avoids the indent-drift an outdented closing `}` causes.
    let new_base_indent = new_lines
        .iter()
        .find(|l| !l.trim().is_empty())
        .map(|l| leading_ws_chars(l))
        .unwrap_or(0);
    let file_indent = leading_ws_chars(original_line);
    let file_indent_str: String = original_line.chars().take(file_indent).collect();
    new_lines
        .iter()
        .map(|l| {
            if l.trim().is_empty() {
                String::new()
            } else {
                let line_indent = leading_ws_chars(l);
                let signed_relative = line_indent as isize - new_base_indent as isize;
                let total_indent = if signed_relative >= 0 {
                    // Same/deeper than anchor: keep the file's indent prefix (preserves the
                    // tab/space mix) and extend with plain spaces.
                    format!(
                        "{}{}",
                        file_indent_str,
                        " ".repeat(signed_relative as usize)
                    )
                } else {
                    // Outdented from anchor: drop chars from the tail of the file's indent.
                    let drop = (-signed_relative) as usize;
                    let keep = file_indent.saturating_sub(drop);
                    file_indent_str.chars().take(keep).collect()
                };
                format!("{}{}", total_indent, l.trim())
            }
        })
        .collect()
}

/// Precomputed line views shared by every healer and the (optional) diagnostic.
/// Tokenizing a 3k-line file once is cheap; doing it inside every sliding window is not.
struct NormalizedFile<'a> {
    lines: Vec<&'a str>,
    trimmed: Vec<&'a str>,
    tokens: Vec<String>,
    has_crlf: bool,
    trailing_newline: bool,
}

impl<'a> NormalizedFile<'a> {
    fn new(raw: &'a str) -> Self {
        let lines: Vec<&str> = raw.lines().collect();
        let trimmed: Vec<&str> = lines.iter().map(|l| l.trim()).collect();
        let tokens: Vec<String> = lines.iter().map(|l| clean_token_normalize(l)).collect();
        Self {
            has_crlf: raw.contains("\r\n"),
            trailing_newline: raw.ends_with('\n'),
            lines,
            trimmed,
            tokens,
        }
    }
}

fn join_normalized(file: &NormalizedFile<'_>, result_lines: Vec<String>) -> String {
    let mut result = result_lines.join("\n");
    if file.trailing_newline && !result.ends_with('\n') {
        result.push('\n');
    }
    if file.has_crlf {
        result = coerce_eol(&result, "\r\n");
    }
    result
}

fn splice_normalized_windows(
    file: &NormalizedFile<'_>,
    matches: &[(usize, usize)],
    replace_all: bool,
    new_string: &str,
) -> (String, usize, String) {
    let to_replace = if replace_all { matches } else { &matches[..1] };
    let actual = file.lines[to_replace[0].0..to_replace[0].1].join("\n");
    let new_lines: Vec<&str> = new_string.lines().collect();
    let mut result_lines: Vec<String> = file.lines.iter().map(|l| (*l).to_string()).collect();
    for &(start, end) in to_replace.iter().rev() {
        let replacement = reanchored_replacement(&new_lines, file.lines[start]);
        result_lines.splice(start..end, replacement);
    }
    let count = if replace_all { matches.len() } else { 1 };
    (join_normalized(file, result_lines), count, actual)
}

fn find_exact_windows(hay: &[&str], needle: &[&str]) -> Vec<(usize, usize)> {
    if needle.is_empty() || needle.len() > hay.len() {
        return Vec::new();
    }
    let n = needle.len();
    let mut matches = Vec::new();
    let mut i = 0;
    while i + n <= hay.len() {
        if hay[i..i + n] == needle[..] {
            matches.push((i, i + n));
            i += n;
        } else {
            i += 1;
        }
    }
    matches
}

/// Whitespace-normalized fuzzy replace (faithful port of the v1 editor's
/// `try_fuzzy_replace`). Matches `old_string` against `content` line-by-line with each
/// line `.trim()`-ed, so a model that reproduced indentation with the wrong whitespace
/// (spaces vs the file's tabs, or a slightly-off indent) still matches. The replacement
/// is re-anchored to the file's REAL indentation: the first non-empty line of
/// `new_string` is the anchor, and each line's signed offset from it is re-applied on
/// top of the matched file line's actual leading whitespace (tabs preserved).
///
/// Returns `None` (caller falls back to the normal "not found" error) when: the old
/// string is empty, its trimmed content totals < 10 chars (too short to match safely),
/// no window matches, or `!replace_all` but more than one window matches (ambiguous).
fn try_fuzzy_replace(
    file: &NormalizedFile<'_>,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> Option<(String, usize, String)> {
    let old_normalized: Vec<&str> = old_string.lines().map(|l| l.trim()).collect();
    let old_trimmed_core: Vec<&str> = {
        let start = old_normalized
            .iter()
            .position(|l| !l.is_empty())
            .unwrap_or(0);
        let end = old_normalized
            .iter()
            .rposition(|l| !l.is_empty())
            .map(|p| p + 1)
            .unwrap_or(0);
        if start < end {
            old_normalized[start..end].to_vec()
        } else {
            old_normalized.clone()
        }
    };
    if old_trimmed_core.is_empty() || old_trimmed_core.iter().all(|l| l.is_empty()) {
        return None;
    }

    let total_non_ws: usize = old_trimmed_core.iter().map(|l| l.len()).sum();
    if total_non_ws < 4 {
        return None;
    }

    let mut matches = find_exact_windows(&file.trimmed, &old_normalized);
    if matches.is_empty() && old_trimmed_core.len() != old_normalized.len() {
        matches = find_exact_windows(&file.trimmed, &old_trimmed_core);
    }
    if matches.is_empty() {
        return None;
    }
    if !replace_all && matches.len() > 1 {
        return None;
    }
    Some(splice_normalized_windows(
        file,
        &matches,
        replace_all,
        new_string,
    ))
}

/// BLOCK-ANCHOR fuzzy replace — the tier below [`try_fuzzy_replace`]. When the model
/// reproduced a multi-line block but got an INTERIOR line slightly wrong (a typo, a
/// reordered token, a comment tweak), the whitespace-normalized tier — which requires
/// EVERY trimmed line to match — fails, and a weak model then resorts to a shell script.
/// This tier anchors on the FIRST and LAST trimmed lines and tolerates interior drift,
/// replacing the whole window (re-anchored to the file's real indent via
/// [`reanchored_replacement`]).
///
/// Conservative guards so it can't clobber the wrong block: needs ≥ 3 lines; both
/// anchors non-empty and ≥ 3 trimmed chars (so a bare `{`/`}` can't anchor); the window
/// length equals the old block's; ALL BUT AT MOST ONE line still matches trimmed (so a
/// window that merely shares its first/last line with an unrelated region is rejected —
/// a plain "≥ half" rule would degenerate to "anchors only" for n ≤ 4); and the anchored
/// window must be UNIQUE (no `replace_all` at this tier — guessing which of several to
/// rewrite is unsafe). Returns `None` on any miss so the caller falls back to not-found.
fn try_block_anchor_replace(
    file: &NormalizedFile<'_>,
    old_string: &str,
    new_string: &str,
) -> Option<(String, usize, String)> {
    let raw_old_lines: Vec<&str> = old_string.lines().collect();
    let start_pos = raw_old_lines
        .iter()
        .position(|l| !l.trim().is_empty())
        .unwrap_or(0);
    let end_pos = raw_old_lines
        .iter()
        .rposition(|l| !l.trim().is_empty())
        .map(|p| p + 1)
        .unwrap_or(0);
    let old_lines: Vec<&str> = if start_pos < end_pos {
        raw_old_lines[start_pos..end_pos].to_vec()
    } else {
        raw_old_lines.clone()
    };

    let n = old_lines.len();
    if n < 3 {
        return None;
    }
    let old_tokens: Vec<String> = old_lines.iter().map(|l| clean_token_normalize(l)).collect();
    let first_norm = &old_tokens[0];
    let last_norm = &old_tokens[n - 1];
    if first_norm.chars().count() < 2 || last_norm.chars().count() < 2 {
        return None;
    }
    if n > file.tokens.len() {
        return None;
    }

    // First+last gates. A common pair (`</div>` … `}`) on a 3k-line React file
    // would otherwise score hundreds of 200-line windows with per-line Levenshtein.
    // Unique-match is required anyway, so a flood of candidates cannot succeed.
    const MAX_ANCHOR_CANDIDATES: usize = 48;
    let mut candidates = Vec::new();
    let last = file.tokens.len() - n;
    for i in 0..=last {
        if file.tokens[i] == *first_norm && file.tokens[i + n - 1] == *last_norm {
            candidates.push(i);
            if candidates.len() > MAX_ANCHOR_CANDIDATES {
                return None;
            }
        }
    }
    if candidates.is_empty() {
        return None;
    }

    let threshold = if n <= 4 {
        n.saturating_sub(1)
    } else {
        (n as f32 * 0.65).ceil() as usize
    };
    let mut matches: Vec<usize> = Vec::new();
    for i in candidates {
        let matched = (0..n)
            .filter(|&k| {
                let a = &file.tokens[i + k];
                let b = &old_tokens[k];
                if a == b {
                    return true;
                }
                // Bound DP: a minified / data-URL line must not run L² on 10k chars.
                if a.len() > 256 || b.len() > 256 {
                    return false;
                }
                strsim::normalized_levenshtein(a, b) >= 0.75
            })
            .count();
        if matched >= threshold {
            matches.push(i);
            if matches.len() > 1 {
                return None;
            }
        }
    }
    if matches.len() != 1 {
        return None;
    }

    let start = matches[0];
    Some(splice_normalized_windows(
        file,
        &[(start, start + n)],
        false,
        new_string,
    ))
}

/// Filter invisible Unicode characters, normalize smart quotes/punctuation, and collapse whitespace.
fn clean_token_normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_was_ws = false;
    for c in s.chars() {
        if matches!(
            c,
            '\u{feff}' | '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{2060}' | '\u{fe0f}'
        ) {
            continue;
        }
        let norm_char = match c {
            '\u{00a0}' | '\u{2002}' | '\u{2003}' | '\u{2009}' | '\t' => ' ',
            '“' | '”' | '″' => '"',
            '‘' | '’' | '′' => '\'',
            '（' => '(',
            '）' => ')',
            '【' => '[',
            '】' => ']',
            '：' => ':',
            '；' => ';',
            '，' => ',',
            other => other,
        };
        if norm_char.is_whitespace() {
            if !last_was_ws {
                out.push(' ');
                last_was_ws = true;
            }
        } else {
            out.push(norm_char);
            last_was_ws = false;
        }
    }
    out.trim().to_string()
}

/// Token & inline-whitespace normalized fallback: matches line-by-line after collapsing internal spaces,
/// stripping zero-width characters, and normalizing unicode quotes/punctuation.
fn try_token_normalized_replace(
    file: &NormalizedFile<'_>,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> Option<(String, usize, String)> {
    let old_normalized: Vec<String> = old_string
        .lines()
        .map(clean_token_normalize)
        .filter(|l| !l.is_empty())
        .collect();
    if old_normalized.is_empty() {
        return None;
    }

    let total_chars: usize = old_normalized.iter().map(|l| l.len()).sum();
    if total_chars < 4 {
        return None;
    }

    let n = old_normalized.len();
    if n > file.tokens.len() {
        return None;
    }

    let mut matches: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i + n <= file.tokens.len() {
        if file.tokens[i..i + n] == old_normalized[..] {
            matches.push((i, i + n));
            i += n;
        } else {
            i += 1;
        }
    }

    if matches.is_empty() {
        return None;
    }
    if !replace_all && matches.len() > 1 {
        return None;
    }
    Some(splice_normalized_windows(
        file,
        &matches,
        replace_all,
        new_string,
    ))
}

/// Boundary trimmed context match: when LLM emitted extra leading or trailing context lines.
fn try_trimmed_boundary_replace(
    file: &NormalizedFile<'_>,
    old_string: &str,
    new_string: &str,
) -> Option<(String, usize, String)> {
    let old_lines: Vec<&str> = old_string.lines().collect();
    let new_lines: Vec<&str> = new_string.lines().collect();
    if old_lines.len() < 3 || new_lines.len() < 3 {
        return None;
    }
    // Case 1: Drop first line from old_string and new_string if they match
    if clean_token_normalize(old_lines[0]) == clean_token_normalize(new_lines[0]) {
        let sub_old = old_lines[1..].join("\n");
        let sub_new = new_lines[1..].join("\n");
        if let Some(res) = try_fuzzy_replace(file, &sub_old, &sub_new, false) {
            return Some(res);
        }
        if let Some(res) = try_token_normalized_replace(file, &sub_old, &sub_new, false) {
            return Some(res);
        }
    }
    // Case 2: Drop last line from old_string and new_string if they match
    if let (Some(last_o), Some(last_n)) = (old_lines.last(), new_lines.last()) {
        if clean_token_normalize(last_o) == clean_token_normalize(last_n) {
            let sub_old = old_lines[..old_lines.len() - 1].join("\n");
            let sub_new = new_lines[..new_lines.len() - 1].join("\n");
            if let Some(res) = try_fuzzy_replace(file, &sub_old, &sub_new, false) {
                return Some(res);
            }
            if let Some(res) = try_token_normalized_replace(file, &sub_old, &sub_new, false) {
                return Some(res);
            }
        }
    }
    None
}

/// Collapse `/** foo */` and `/**\n * foo\n */` (and `// foo`) into one comparable token
/// so a model that re-wrapped a javadoc still matches the on-disk form.
fn collapse_comment_style_lines(lines: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    let mut javadoc: Vec<String> = Vec::new();
    let mut in_javadoc = false;
    for raw in lines {
        let t = raw.trim();
        if t.starts_with("/**") && t.ends_with("*/") {
            let inner = t.trim_start_matches("/**").trim_end_matches("*/").trim();
            out.push(clean_token_normalize(&format!("/** {inner} */")));
            continue;
        }
        if t.starts_with("/**") {
            in_javadoc = true;
            javadoc.clear();
            let inner = t.trim_start_matches("/**").trim();
            if !inner.is_empty() {
                javadoc.push(inner.to_string());
            }
            continue;
        }
        if in_javadoc {
            if t.ends_with("*/") {
                let inner = t
                    .trim_end_matches("*/")
                    .trim()
                    .trim_start_matches('*')
                    .trim();
                if !inner.is_empty() {
                    javadoc.push(inner.to_string());
                }
                in_javadoc = false;
                out.push(clean_token_normalize(&format!(
                    "/** {} */",
                    javadoc.join(" ")
                )));
            } else {
                let inner = t.trim_start_matches('*').trim();
                if !inner.is_empty() {
                    javadoc.push(inner.to_string());
                }
            }
            continue;
        }
        if t.starts_with("//") {
            out.push(clean_token_normalize(&format!(
                "/** {} */",
                t.trim_start_matches('/').trim()
            )));
            continue;
        }
        let n = clean_token_normalize(raw);
        if !n.is_empty() {
            out.push(n);
        }
    }
    out
}

/// Map each collapsed token back to a half-open line range in `lines`.
fn collapse_comment_style_spans(lines: &[&str]) -> Vec<(String, usize, usize)> {
    let mut out = Vec::new();
    let mut javadoc: Vec<String> = Vec::new();
    let mut in_javadoc = false;
    let mut javadoc_start = 0usize;
    for (i, raw) in lines.iter().enumerate() {
        let t = raw.trim();
        if t.starts_with("/**") && t.ends_with("*/") {
            let inner = t.trim_start_matches("/**").trim_end_matches("*/").trim();
            out.push((clean_token_normalize(&format!("/** {inner} */")), i, i + 1));
            continue;
        }
        if t.starts_with("/**") {
            in_javadoc = true;
            javadoc.clear();
            javadoc_start = i;
            let inner = t.trim_start_matches("/**").trim();
            if !inner.is_empty() {
                javadoc.push(inner.to_string());
            }
            continue;
        }
        if in_javadoc {
            if t.ends_with("*/") {
                let inner = t
                    .trim_end_matches("*/")
                    .trim()
                    .trim_start_matches('*')
                    .trim();
                if !inner.is_empty() {
                    javadoc.push(inner.to_string());
                }
                in_javadoc = false;
                out.push((
                    clean_token_normalize(&format!("/** {} */", javadoc.join(" "))),
                    javadoc_start,
                    i + 1,
                ));
            } else {
                let inner = t.trim_start_matches('*').trim();
                if !inner.is_empty() {
                    javadoc.push(inner.to_string());
                }
            }
            continue;
        }
        if t.starts_with("//") {
            out.push((
                clean_token_normalize(&format!("/** {} */", t.trim_start_matches('/').trim())),
                i,
                i + 1,
            ));
            continue;
        }
        let n = clean_token_normalize(raw);
        if !n.is_empty() {
            out.push((n, i, i + 1));
        }
    }
    out
}

/// Match `old_string` after collapsing javadoc wrapping. Does **not** drop
/// annotations or unrelated identifiers — a model that tried to replace
/// `createTime` with a different field must still fail.
fn try_comment_style_replace(
    file: &NormalizedFile<'_>,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> Option<(String, usize, String)> {
    let old_lines: Vec<&str> = old_string.lines().collect();
    let old_collapsed = collapse_comment_style_lines(&old_lines);
    if old_collapsed.len() < 2 {
        return None;
    }
    let total: usize = old_collapsed.iter().map(|s| s.len()).sum();
    if total < 8 {
        return None;
    }

    let content_spans = collapse_comment_style_spans(&file.lines);
    if content_spans.len() < old_collapsed.len() {
        return None;
    }

    let n = old_collapsed.len();
    let mut matches: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i + n <= content_spans.len() {
        let same = content_spans[i..i + n]
            .iter()
            .map(|(s, _, _)| s.as_str())
            .eq(old_collapsed.iter().map(|s| s.as_str()));
        if same {
            let start_line = content_spans[i].1;
            let end_line = content_spans[i + n - 1].2;
            matches.push((start_line, end_line));
            i += n;
        } else {
            i += 1;
        }
    }
    if matches.is_empty() || (!replace_all && matches.len() > 1) {
        return None;
    }
    Some(splice_normalized_windows(
        file,
        &matches,
        replace_all,
        new_string,
    ))
}

const MISMATCH_GREP_HINT: &str = "[Content Mismatch]: Target old_string could not be located in the file. Please use grep to locate the target symbol or read a narrow window with `read`.";

/// Line-level similarity with a hard cap so a minified / data-URL line cannot
/// run character Levenshtein on tens of thousands of chars.
fn line_similarity(a: &str, b: &str) -> f32 {
    if a == b {
        return 1.0;
    }
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a.len() > 256 || b.len() > 256 {
        return 0.0;
    }
    strsim::normalized_levenshtein(a, b) as f32
}

/// Rolling multiset intersection of `old_tokens` against every window of
/// `window_lines` file tokens. O(file lines) — no character DP.
fn best_window_by_token_bag(
    file: &NormalizedFile<'_>,
    old_tokens: &[String],
    window_lines: usize,
) -> (usize, usize, f32) {
    use std::collections::HashMap;
    let m = file.tokens.len();
    if m == 0 || old_tokens.is_empty() {
        return (0, 0, 0.0);
    }
    let w = window_lines.max(1).min(m);
    let need = old_tokens.len() as f32;

    let mut old_freq: HashMap<&str, i32> = HashMap::new();
    for t in old_tokens {
        *old_freq.entry(t.as_str()).or_insert(0) += 1;
    }

    let mut win_freq: HashMap<&str, i32> = HashMap::new();
    let mut hits: i32 = 0;
    for tok in file.tokens.iter().take(w) {
        let t = tok.as_str();
        if t.is_empty() {
            continue;
        }
        let c = win_freq.entry(t).or_insert(0);
        *c += 1;
        if *c <= old_freq.get(t).copied().unwrap_or(0) {
            hits += 1;
        }
    }
    let boundary_score = |start_idx: usize| -> i32 {
        let mut b = 0;
        if let Some(first) = old_tokens.first() {
            if file.tokens.get(start_idx).map(|s| s.as_str()) == Some(first.as_str()) {
                b += 2;
            }
        }
        if let Some(last) = old_tokens.last() {
            if file.tokens.get(start_idx + w - 1).map(|s| s.as_str()) == Some(last.as_str()) {
                b += 1;
            }
        }
        b
    };

    let mut best_hits = hits;
    let mut best_i = 0usize;
    let mut best_boundary = boundary_score(0);

    for start in 1..=m.saturating_sub(w) {
        let drop = file.tokens[start - 1].as_str();
        if !drop.is_empty() {
            if let Some(c) = win_freq.get_mut(drop) {
                if *c <= old_freq.get(drop).copied().unwrap_or(0) {
                    hits -= 1;
                }
                *c -= 1;
            }
        }
        let add = file.tokens[start + w - 1].as_str();
        if !add.is_empty() {
            let c = win_freq.entry(add).or_insert(0);
            *c += 1;
            if *c <= old_freq.get(add).copied().unwrap_or(0) {
                hits += 1;
            }
        }
        let cur_b = boundary_score(start);
        if hits > best_hits || (hits == best_hits && cur_b > best_boundary) {
            best_hits = hits;
            best_i = start;
            best_boundary = cur_b;
        }
    }

    let end = (best_i + w).min(m);
    let score = if need > 0.0 {
        best_hits.max(0) as f32 / need
    } else {
        0.0
    };
    (best_i, end, score)
}

/// Tiny-hunk fallback: mean per-line similarity. n is capped by the caller (≤ 8).
fn best_window_by_line_similarity(
    file: &NormalizedFile<'_>,
    old_tokens: &[String],
) -> (usize, usize, f32) {
    let n = old_tokens.len().max(1);
    let m = file.tokens.len();
    if m == 0 {
        return (0, 0, 0.0);
    }
    let mut best = 0.0f32;
    let mut best_i = 0usize;
    for i in 0..m {
        let end = (i + n).min(m);
        let span = end - i;
        if span == 0 {
            continue;
        }
        let mut sum = 0.0f32;
        for k in 0..span {
            let a = old_tokens.get(k).map(|s| s.as_str()).unwrap_or("");
            let b = file.tokens[i + k].as_str();
            sum += line_similarity(a, b);
        }
        let sim = sum / n as f32;
        if sim > best {
            best = sim;
            best_i = i;
            if best >= 0.999 {
                break;
            }
        }
    }
    (best_i, (best_i + n).min(m), best)
}

const EDIT_DIFF_PROTOCOL_LEGEND: &str = "\
Below is the discrepancy between your old_string and the actual file content:\n\
Lines with '-' come from your old_string; the number is the physical file line it conflicts with (-- = no corresponding file line at this position).\n\
Lines with '+' are actual file content; the number is the physical file line.\n\
Lines without '-' or '+' are surrounding file context for reference only.\n\n";

const MISMATCH_ACTION_HINT: &str =
    "👉 Conflict found — adjust your old_string to match the actual file content above.";

fn format_cascade_conflict_diagnostic(
    cause_orig_idx: usize,
    victim_orig_idx: usize,
    cause_span: (usize, usize),
    victim_span: (usize, usize),
    inter_span: (usize, usize),
    cause_new_string: &str,
    victim_old_string: &str,
    test_buf: &str,
    path: Option<&std::path::Path>,
) -> String {
    let cause_json = cause_orig_idx.saturating_sub(1);
    let victim_json = victim_orig_idx.saturating_sub(1);

    let test_buf_norm = NormalizedFile::new(test_buf);
    let diff_block = find_closest_match_snippet(path, &test_buf_norm, victim_old_string)
        .unwrap_or_else(|| {
            format!(
                "```````diff\n- {}\n+ {}\n```````",
                victim_old_string.trim(),
                cause_new_string.trim()
            )
        });

    format!(
        "⚠️ Cascading Overlap Conflict (Hunk {cause_orig_idx} ➔ Hunk {victim_orig_idx}):\n\
         Hunk {victim_orig_idx} (edits[{victim_json}]) targets code in lines {}-{} that was just modified or removed by Hunk {cause_orig_idx} (edits[{cause_json}]).\n\
         Although Hunk {victim_orig_idx}'s old_string exists in the original file, it no longer matches the post-Hunk-{cause_orig_idx} buffer!\n\n\
         📍 Overlap Site:\n  \
         • Hunk {cause_orig_idx} (edits[{cause_json}]) targeted span  : lines {}-{} (based on original file)\n  \
         • Hunk {victim_orig_idx} (edits[{victim_json}]) targeted span: lines {}-{} (based on original file)\n  \
         • Intersection lines            : lines {}-{}\n\n\
         {}\n",
        victim_span.0, victim_span.1,
        cause_span.0, cause_span.1,
        victim_span.0, victim_span.1,
        inter_span.0, inter_span.1,
        diff_block.trim()
    )
}

/// Most similar real file line inside the hunk. Pairing by index alone loses
/// reordered/shifted lines; `预设` should point at `预估`, not at whichever
/// unrelated line happens to occupy the same slot.
fn closest_file_line(
    expect: &str,
    file_lines: &[&str],
    search_start: usize,
    search_end: usize,
) -> Option<(usize, f32)> {
    let mut best: Option<(usize, f32)> = None;
    for idx in search_start..search_end.min(file_lines.len()) {
        let candidate = file_lines[idx];
        let sim = line_similarity(expect, candidate);
        if best.map_or(true, |(_, score)| sim > score) {
            best = Some((idx, sim));
        }
    }
    best.filter(|(_, sim)| *sim >= 0.60)
}

/// Render one hunk. `-`/`+` numbers are physical file lines: paired Replace
/// lines share the number, and old lines with no counterpart use `--`.
fn render_hunk(
    ops: &[similar::DiffOp],
    old_lines: &[&str],
    file_lines: &[&str],
    win_start: usize,
    win_end: usize,
    hunk_start: usize,
    hunk_end: usize,
    first_equal: Option<usize>,
    last_equal: Option<usize>,
) -> Vec<String> {
    const MAX_HUNK_LINES: usize = 60;

    let file_no = |new_index: usize| win_start + new_index + 1;
    let search_start = hunk_start.saturating_sub(win_start + 1);
    let search_end = hunk_end.saturating_sub(win_start);
    let mut out = Vec::new();
    let mut omitted = 0usize;
    let mut push = |line: String| {
        if out.len() < MAX_HUNK_LINES {
            out.push(line);
        } else {
            omitted += 1;
        }
    };

    for (op_idx, op) in ops.iter().enumerate() {
        match *op {
            similar::DiffOp::Equal { new_index, len, .. } => {
                for k in 0..len {
                    let no = file_no(new_index + k);
                    if no >= hunk_start && no <= hunk_end {
                        push(format!("  {:>4} | {}", no, file_lines[new_index + k]));
                    }
                }
            }
            similar::DiffOp::Delete {
                old_index,
                old_len,
                new_index,
                ..
            } => {
                let at = (win_start + new_index + 1).min(win_end);
                if at < hunk_start || at > hunk_end {
                    continue;
                }
                for k in 0..old_len {
                    push(format!("-   -- | {}", old_lines[old_index + k]));
                }
            }
            similar::DiffOp::Insert {
                new_index, new_len, ..
            } => {
                let span_start = file_no(new_index);
                let span_end = file_no(new_index + new_len.saturating_sub(1));
                if span_end < hunk_start || span_start > hunk_end {
                    continue;
                }
                let boundary = match (first_equal, last_equal) {
                    (Some(f), Some(l)) => op_idx < f || op_idx > l,
                    _ => false,
                };
                for k in 0..new_len {
                    let no = file_no(new_index + k);
                    if no < hunk_start || no > hunk_end {
                        continue;
                    }
                    if boundary {
                        push(format!("  {:>4} | {}", no, file_lines[new_index + k]));
                    } else {
                        push(format!("+ {:>4} | {}", no, file_lines[new_index + k]));
                    }
                }
            }
            similar::DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                let span_start = file_no(new_index);
                let span_end = file_no(new_index + new_len.saturating_sub(1));
                if span_end < hunk_start || span_start > hunk_end {
                    continue;
                }
                for k in 0..old_len {
                    let expect = old_lines[old_index + k];
                    // Default to the positional pair; only jump to a different
                    // real file line when it is clearly more similar (e.g.
                    // '预设' matches '预估' better than its slot's neighbour).
                    let paired = if k < new_len {
                        Some((
                            file_no(new_index + k),
                            line_similarity(expect, file_lines[new_index + k]),
                        ))
                    } else {
                        None
                    };
                    let best = closest_file_line(expect, file_lines, search_start, search_end);
                    let num = match (paired, best) {
                        (Some((_, paired_sim)), Some((idx, best_sim)))
                            if best_sim > paired_sim + 0.15 =>
                        {
                            Some(win_start + idx + 1)
                        }
                        (Some((paired_no, _)), _) => Some(paired_no),
                        (None, Some((idx, _))) => Some(win_start + idx + 1),
                        (None, None) => None,
                    }
                    .map(|n| format!("{:>4}", n))
                    .unwrap_or_else(|| "  --".to_string());
                    push(format!("- {} | {}", num, expect));
                }
                for k in 0..new_len {
                    push(format!(
                        "+ {:>4} | {}",
                        file_no(new_index + k),
                        file_lines[new_index + k]
                    ));
                }
            }
        }
    }
    if omitted > 0 {
        out.push(format!("  ... ({} more line(s) omitted)", omitted));
    }
    out
}

fn build_structured_mismatch_diff(
    path: Option<&std::path::Path>,
    file: &NormalizedFile<'_>,
    old_string: &str,
    start: usize,
    end: usize,
    score: f32,
) -> String {
    use similar::{DiffOp, TextDiff};

    const CONTEXT: usize = 3;
    const HUNK_GAP: usize = CONTEXT * 2;

    let target_display = path
        .map(|p| crate::pathnorm::to_display(p))
        .map(|s| format!(" in {s}"))
        .unwrap_or_default();

    let old_lines: Vec<&str> = old_string.lines().collect();
    if old_lines.is_empty() {
        return MISMATCH_GREP_HINT.to_string();
    }

    // Widen the window: a real conflict may sit outside the token-bag pick
    // (old_string can stitch together lines from different regions). Use
    // terminator-free slices for the diff — `diff_lines(old_string, join(...))`
    // used to invent a Replace on the last line when old_string ended with '\n'.
    let win_start = start.saturating_sub(CONTEXT);
    let win_end = end.saturating_add(CONTEXT).min(file.lines.len());
    if win_start >= win_end {
        return MISMATCH_GREP_HINT.to_string();
    }
    let file_lines: Vec<&str> = file.lines[win_start..win_end].to_vec();

    let mut config = TextDiff::configure();
    config.timeout(std::time::Duration::from_millis(200));
    let diff = config.diff_slices(&old_lines, &file_lines);
    let ops = diff.ops();
    let first_equal = ops.iter().position(|op| matches!(op, DiffOp::Equal { .. }));
    let last_equal = ops
        .iter()
        .rposition(|op| matches!(op, DiffOp::Equal { .. }));
    let file_no = |new_index: usize| win_start + new_index + 1;
    let insertion_no = |new_index: usize| (win_start + new_index + 1).min(win_end);

    // Collect real (internal) changes. Leading/trailing Inserts are just the
    // window boundary around old_string, not omissions, so they do not create
    // their own hunk.
    let mut changes: Vec<(usize, usize)> = Vec::new();
    for (op_idx, op) in ops.iter().enumerate() {
        match *op {
            DiffOp::Equal { .. } => {}
            DiffOp::Delete { new_index, .. } => {
                let at = insertion_no(new_index);
                changes.push((at, at));
            }
            DiffOp::Insert {
                new_index, new_len, ..
            } => {
                let boundary = match (first_equal, last_equal) {
                    (Some(f), Some(l)) => op_idx < f || op_idx > l,
                    _ => false,
                };
                if !boundary {
                    changes.push((
                        file_no(new_index),
                        file_no(new_index + new_len.saturating_sub(1)),
                    ));
                }
            }
            DiffOp::Replace {
                new_index, new_len, ..
            } => {
                changes.push((
                    file_no(new_index),
                    file_no(new_index + new_len.saturating_sub(1)),
                ));
            }
        }
    }
    if changes.is_empty() {
        // No internal change (all matches are Equal and only boundary inserts
        // exist): fall back to every non-Equal op so the caller still sees the
        // block. Low-similarity cases are refused before reaching here.
        for op in ops {
            match *op {
                DiffOp::Equal { .. } => {}
                DiffOp::Delete { new_index, .. } => {
                    let at = insertion_no(new_index);
                    changes.push((at, at));
                }
                DiffOp::Insert {
                    new_index, new_len, ..
                } => {
                    changes.push((
                        file_no(new_index),
                        file_no(new_index + new_len.saturating_sub(1)),
                    ));
                }
                DiffOp::Replace {
                    new_index, new_len, ..
                } => {
                    changes.push((
                        file_no(new_index),
                        file_no(new_index + new_len.saturating_sub(1)),
                    ));
                }
            }
        }
    }

    // Merge changes whose untouched gap is <= 2*CONTEXT; farther clusters get
    // their own action hint + diff block.
    let mut hunks: Vec<Vec<(usize, usize)>> = Vec::new();
    for change in changes {
        let merge = hunks
            .last()
            .and_then(|hunk| hunk.last())
            .is_some_and(|last| change.0 <= last.1.saturating_add(HUNK_GAP + 1));
        if merge {
            hunks.last_mut().unwrap().push(change);
        } else {
            hunks.push(vec![change]);
        }
    }

    let mut out = String::new();
    out.push_str(&format!(
        "[Content Mismatch]: Closest matching block found around lines {}-{}{target_display} (similarity {:.0}%):\n\n",
        win_start + 1,
        win_end,
        score * 100.0,
    ));
    out.push_str(EDIT_DIFF_PROTOCOL_LEGEND);

    for hunk in &hunks {
        let first = hunk.first().unwrap().0;
        let last = hunk.last().unwrap().1;
        let hunk_start = first.saturating_sub(CONTEXT).max(win_start + 1);
        let hunk_end = last.saturating_add(CONTEXT).min(win_end);

        out.push_str(MISMATCH_ACTION_HINT);
        out.push_str("\n\n");

        let lines = render_hunk(
            ops,
            &old_lines,
            &file_lines,
            win_start,
            win_end,
            hunk_start,
            hunk_end,
            first_equal,
            last_equal,
        );
        out.push_str("```````diff\n");
        out.push_str(&lines.join("\n"));
        out.push_str("\n```````\n\n");
    }

    out.push_str("(Hint: surrounding context lines without '-' or '+' are for location reference only; do not blindly re-read the whole file)");

    out
}

/// Diagnostic-only closest-region locator. Never used by the healing cascade or
/// 3-way history rebase.
///
/// Previous implementation slid a character-level Levenshtein across every file
/// line (`O(file_lines × |old| × |window|)`). A 280-line hunk against a 3.5k-line
/// file is ~5×10^11 DP cells. This version:
/// 1. scores every window with a rolling token-bag (O(file lines));
/// 2. refines only tiny hunks (≤ 8 non-empty lines) with per-line similarity;
/// 3. emits one bounded `similar` TextDiff of the winning window.
fn find_closest_match_snippet(
    path: Option<&std::path::Path>,
    file: &NormalizedFile<'_>,
    old_string: &str,
) -> Option<String> {
    let old_lines: Vec<&str> = old_string.lines().collect();
    let old_tokens: Vec<String> = old_lines
        .iter()
        .map(|l| clean_token_normalize(l))
        .filter(|l| !l.is_empty())
        .collect();
    if old_tokens.is_empty() {
        return Some(MISMATCH_GREP_HINT.to_string());
    }

    let window_n = old_lines.len().max(1);
    let (mut start, mut end, mut score) = best_window_by_token_bag(file, &old_tokens, window_n);

    const SMALL_HUNK_LINES: usize = 8;
    if old_tokens.len() <= SMALL_HUNK_LINES {
        let refined = best_window_by_line_similarity(file, &old_tokens);
        if refined.2 > score {
            start = refined.0;
            end = refined.1;
            score = refined.2;
        }
    }

    // ── 建议 1 与建议 2 强化：当相似度 < 50% 时 ──
    if score < 0.50 || end <= start {
        // 场景 1：跨文件嗅探是否“走错门”（在最近编辑的其它文件中是否 100% 精确存在）
        if let Some(target_path) = path {
            if let Some(recent_file) = crate::tools::edit_history::find_exact_match_in_recent_files(
                target_path,
                old_string,
            ) {
                let current_display = crate::pathnorm::to_display(target_path);
                let recent_display = crate::pathnorm::to_display(&recent_file);
                return Some(format!(
                    "Warning: old_string was NOT found in {current_display}, but an EXACT match was found in {recent_display}!\nDid you specify the wrong file path? (Target best match in {current_display} was only {:.1}%)",
                    score * 100.0
                ));
            }
        }

        // 场景 3：完全不存在且其他文件也没有，给出干净利落的未找到提示，不再输出误导性 Diff
        let target_display = path
            .map(|p| crate::pathnorm::to_display(p))
            .unwrap_or_else(|| "target file".to_string());
        return Some(format!(
            "old_string not found in {target_display}.\nBest match similarity was only {:.1}% (around lines {}-{}).\nThe target code block does not exist in this file. Please search or inspect the file before modifying.",
            score * 100.0,
            start + 1,
            end
        ));
    }

    // 场景 2：代码确实在当前文件，但手抖漏写、多写或错位（相似度 >= 50%）
    // 采用三段式带行号纯净上下文 + 行内微观差异标示：
    // 上下各保留最多 3 行不带 +/- 的纯净上下文行，中间核心区间精确 Diff，杜绝无关行滥加 '+' 造成视觉噪音。
    Some(build_structured_mismatch_diff(
        path, file, old_string, start, end, score,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn raw_edit_adapter_rejects_truncated_envelopes_without_writing() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.rs"), "a\nb\n").unwrap();
        for raw in [
            r#"{"path":"a.rs","edits":[{"old_string":"a","new_string":"changed"},{"old_string":"b","new_string":"cut"#,
            r#"{"path":"a.rs","edits":[{"old_string":"a","new_string":"changed"},{"old_string":"b","new_string":"cut"}"#,
            r#"{"path":"a.rs","edits":[{"old_string":"a","new_string":"changed"}]"#,
            r#"{"path":"a.rs","edits":"[{\"old_string\":\"a\",\"new_string\":\"changed\"}]","hunk":{"old_string":"b","new_string":"cut"#,
            r#"[{"old_string":"a","new_string":"changed"},{"old_string":"b","new_string":"cut"#,
            r#"{'path':'a.rs','edits':[{'old_string':'a','new_string':'changed'},{'old_string':'b','new_string':'cut"#,
        ] {
            for name in ["edit", "edit_file"] {
                let repaired = crate::tools::repair::repair_tool_args(name, raw);
                assert_eq!(repaired, raw, "{name}: {raw}");
                assert!(serde_json::from_str::<Args>(&repaired).is_err());
                let result = EditFileTool.execute(&repaired, &ctx(d.path())).await;
                assert!(result.is_error, "{}", result.content);
                assert_eq!(
                    std::fs::read_to_string(d.path().join("a.rs")).unwrap(),
                    "a\nb\n"
                );
            }
        }
    }

    #[test]
    fn raw_edit_adapter_preserves_complete_malformed_hunks() {
        let raw =
            r#"{'path':'a.rs','edits':[{'old_string':'a','new_string':'can\'t // literal',},],}"#;
        let repaired = crate::tools::repair::repair_tool_args("edit", raw);
        let args: Args = serde_json::from_str(&repaired).unwrap();
        assert_eq!(args.edits.len(), 1);
        assert_eq!(args.edits[0].new_string, "can't // literal");
    }
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

    #[tokio::test]
    async fn gbk_file_edits_in_place_and_stays_gbk() {
        // A GBK/GB18030-encoded file (common on Chinese Windows) must be editable
        // directly — matched in UTF-8 space, then written back in its ORIGINAL encoding,
        // never silently converted to UTF-8.
        let d = tempfile::tempdir().unwrap();
        let (gbk, _, had_err) = encoding_rs::GB18030.encode("第一行\n第二行\n第三行\n");
        assert!(!had_err);
        std::fs::write(d.path().join("notes.txt"), &gbk[..]).unwrap();

        let r = EditFileTool
            .execute(
                r#"{"file_path":"notes.txt","old_string":"第二行","new_string":"改过的第二行"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);

        let on_disk = std::fs::read(d.path().join("notes.txt")).unwrap();
        // Still GBK: the Chinese bytes are not valid UTF-8, and decode as GB18030.
        assert!(
            std::str::from_utf8(&on_disk).is_err(),
            "file must stay GBK, not be converted to UTF-8"
        );
        let (decoded, _, had_err) = encoding_rs::GB18030.decode(&on_disk);
        assert!(!had_err);
        assert_eq!(decoded, "第一行\n改过的第二行\n第三行\n");
    }

    #[tokio::test]
    async fn ambiguous_non_utf8_file_is_refused_and_left_untouched() {
        // A non-UTF-8 file that does not losslessly round-trip as GB18030 (here a stray
        // 0x80 byte) must be refused rather than corrupted — the file stays byte-identical.
        let d = tempfile::tempdir().unwrap();
        let mut bytes = b"plain text\n".to_vec();
        bytes.push(0x80);
        bytes.extend_from_slice(b"\n");
        std::fs::write(d.path().join("weird.txt"), &bytes).unwrap();

        let r = EditFileTool
            .execute(
                r#"{"file_path":"weird.txt","old_string":"plain","new_string":"changed"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(r.is_error, "{}", r.content);
        assert!(r.content.contains("UTF-8"), "{}", r.content);
        assert_eq!(
            std::fs::read(d.path().join("weird.txt")).unwrap(),
            bytes,
            "refused edit must leave the file byte-identical"
        );
    }

    #[tokio::test]
    async fn unique_replace_succeeds() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.rs"), "fn main() {\n    let x = 1;\n}\n").unwrap();
        let r = EditFileTool
            .execute(
                r#"{"file_path":"a.rs","old_string":"let x = 1;","new_string":"let x = 2;"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("-    let x = 1;"), "{}", r.content);
        assert!(r.content.contains("+    let x = 2;"), "{}", r.content);
        let on_disk = std::fs::read_to_string(d.path().join("a.rs")).unwrap();
        assert!(on_disk.contains("let x = 2;"), "{on_disk}");
    }

    #[tokio::test]
    async fn edits_array_applies_two_hunks_transactionally() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join("a.rs"),
            "fn a() { 1 }\nfn b() { 2 }\nfn c() { 3 }\n",
        )
        .unwrap();
        let ok = EditFileTool
            .execute(
                r#"{"file_path":"a.rs","edits":[{"old_string":"fn a() { 1 }","new_string":"fn a() { 10 }"},{"old_string":"fn c() { 3 }","new_string":"fn c() { 30 }"}]}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!ok.is_error, "{}", ok.content);
        let on_disk = std::fs::read_to_string(d.path().join("a.rs")).unwrap();
        assert_eq!(on_disk, "fn a() { 10 }\nfn b() { 2 }\nfn c() { 30 }\n");

        let fail = EditFileTool
            .execute(
                r#"{"file_path":"a.rs","edits":[{"old_string":"fn a() { 10 }","new_string":"fn a() { 11 }"},{"old_string":"missing","new_string":"x"}]}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(fail.is_error, "{}", fail.content);
        assert!(fail.content.contains("hunk 2/2"), "{}", fail.content);
        let still = std::fs::read_to_string(d.path().join("a.rs")).unwrap();
        assert_eq!(still, "fn a() { 10 }\nfn b() { 2 }\nfn c() { 30 }\n");
    }

    #[tokio::test]
    async fn javadoc_wrapping_matches_single_line_comment() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join("Coupon.java"),
            "public class Coupon {\n    /** 创建时间 */\n    private LocalDateTime createTime;\n}\n",
        )
        .unwrap();
        let args = serde_json::json!({
            "file_path": "Coupon.java",
            "old_string": "    /**\n     * 创建时间\n     */\n    private LocalDateTime createTime;",
            "new_string": "    /**\n     * 创建时间\n     */\n    private LocalDateTime createTime;\n\n    /** 过期提前预警天数 */\n    private Integer expireWarningDays;"
        });
        let r = EditFileTool
            .execute(&args.to_string(), &ctx(d.path()))
            .await;
        assert!(!r.is_error, "javadoc wrap must match: {}", r.content);
        let on_disk = std::fs::read_to_string(d.path().join("Coupon.java")).unwrap();
        assert!(on_disk.contains("expireWarningDays"), "{on_disk}");
        assert!(
            on_disk.contains("createTime"),
            "must keep existing field: {on_disk}"
        );
    }

    #[tokio::test]
    async fn hallucinated_annotation_does_not_clobber_other_field() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join("Coupon.java"),
            "public class Coupon {\n    /** 创建时间 */\n    private LocalDateTime createTime;\n\n    /** 过期提前预警天数 (默认3天) */\n    private Integer expireWarningDays;\n}\n",
        )
        .unwrap();
        let args = serde_json::json!({
            "file_path": "Coupon.java",
            "old_string": "    /**\n     * 创建时间\n     */\n    @TableField(\"create_time\")\n    private LocalDateTime createTime;\n}",
            "new_string": "    /**\n     * 过期提前预警天数 (默认为3天)\n     */\n    @TableField(\"expire_warning_days\")\n    private Integer expireWarningDays;\n}"
        });
        let r = EditFileTool
            .execute(&args.to_string(), &ctx(d.path()))
            .await;
        assert!(
            r.is_error,
            "must refuse a structurally different old_string: {}",
            r.content
        );
        assert!(r.content.contains("not found"), "{}", r.content);
        let on_disk = std::fs::read_to_string(d.path().join("Coupon.java")).unwrap();
        assert!(
            on_disk.contains("createTime"),
            "createTime must survive: {on_disk}"
        );
        assert!(
            on_disk.matches("expireWarningDays").count() == 1,
            "must not duplicate expireWarningDays: {on_disk}"
        );
    }

    #[test]
    fn compact_diff_is_unified_with_line_numbers() {
        // Whole-file old vs new; a real diff must produce a `@@` hunk header whose
        // new-side start reflects the changed line's position in the file.
        let old = "fn main() {\n    let x = 1;\n}\n";
        let new = "fn main() {\n    let x = 2;\n}\n";
        let diff = build_compact_diff(old, new, None);
        assert!(
            diff.contains("@@"),
            "must be a unified diff with a hunk header: {diff}"
        );
        assert!(
            diff.contains("-    let x = 1;"),
            "removed line present: {diff}"
        );
        assert!(
            diff.contains("+    let x = 2;"),
            "added line present: {diff}"
        );
        // The change is on file line 2, which falls within lines 1-3 shown in the hunk header.
        assert!(
            diff.contains("@@ -1,3 +1,3 @@"),
            "hunk header shows lines 1-3: {diff}"
        );
    }

    #[test]
    fn compact_diff_caps_huge_diffs() {
        let old = String::new();
        let new: String = (0..200).map(|i| format!("line {i}\n")).collect();
        let diff = build_compact_diff(&old, &new, None);
        assert!(
            diff.lines().count() <= 61,
            "capped: {} lines",
            diff.lines().count()
        );
        assert!(
            diff.contains("more diff lines"),
            "shows a truncation note: {diff}"
        );
    }

    #[tokio::test]
    async fn ambiguous_match_refuses() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "dup\ndup\n").unwrap();
        let r = EditFileTool
            .execute(
                r#"{"file_path":"a.txt","old_string":"dup","new_string":"x"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(r.is_error, "{}", r.content);
        assert!(r.content.contains("appears 2 times"), "{}", r.content);
        assert!(r.content.contains("Matches:"), "{}", r.content);
        assert!(r.content.contains("[1] line"), "{}", r.content);
        assert!(r.content.contains("occurrence"), "{}", r.content);
        // file unchanged
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.txt")).unwrap(),
            "dup\ndup\n"
        );
    }

    #[tokio::test]
    async fn identical_hunk_is_skipped_without_failing_the_batch() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.rs"), "fn a() { 1 }\nfn b() { 2 }\n").unwrap();
        let args = serde_json::json!({
            "file_path": "a.rs",
            "edits": [
                {"old_string": "fn a() { 1 }", "new_string": "fn a() { 1 }"},
                {"old_string": "fn b() { 2 }", "new_string": "fn b() { 20 }"}
            ]
        });
        let r = EditFileTool
            .execute(&args.to_string(), &ctx(d.path()))
            .await;
        assert!(
            !r.is_error,
            "identical hunk must skip, not fail: {}",
            r.content
        );
        assert!(r.content.contains("skipped hunks"), "{}", r.content);
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.rs")).unwrap(),
            "fn a() { 1 }\nfn b() { 20 }\n"
        );
    }

    #[tokio::test]
    async fn all_identical_hunks_leave_file_untouched() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.rs"), "fn a() { 1 }\n").unwrap();
        let args = serde_json::json!({
            "file_path": "a.rs",
            "edits": [
                {"old_string": "fn a() { 1 }", "new_string": "fn a() { 1 }"}
            ]
        });
        let r = EditFileTool
            .execute(&args.to_string(), &ctx(d.path()))
            .await;
        assert!(
            !r.is_error,
            "noop batch should not be an error: {}",
            r.content
        );
        assert!(r.content.contains("not modified"), "{}", r.content);
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.rs")).unwrap(),
            "fn a() { 1 }\n"
        );
    }

    #[tokio::test]
    async fn occurrence_selects_the_nth_match() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.rs"), "dup\nkeep\ndup\n").unwrap();
        let args = serde_json::json!({
            "file_path": "a.rs",
            "edits": [
                {"old_string": "dup", "new_string": "second", "occurrence": 2}
            ]
        });
        let r = EditFileTool
            .execute(&args.to_string(), &ctx(d.path()))
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.rs")).unwrap(),
            "dup\nkeep\nsecond\n"
        );
    }

    #[tokio::test]
    async fn replace_all_handles_duplicates() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "dup\ndup\ndup\n").unwrap();
        let r = EditFileTool
            .execute(
                r#"{"file_path":"a.txt","old_string":"dup","new_string":"x","replace_all":true}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("3 replacements"), "{}", r.content);
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.txt")).unwrap(),
            "x\nx\nx\n"
        );
    }

    /// 顶层 `replace_all` 只能用于便捷形；与 `edits[]` 混用必须响亮报错，
    /// 而不是静默按 hunk 级 false 处理（那会把“全替换”变成只替换第一处）。
    #[tokio::test]
    async fn top_level_replace_all_with_edits_array_is_rejected() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "dup\ndup\n").unwrap();
        let args = serde_json::json!({
            "file_path": "a.txt",
            "replace_all": true,
            "edits": [{"old_string": "dup", "new_string": "x"}]
        });
        let r = EditFileTool
            .execute(&args.to_string(), &ctx(d.path()))
            .await;
        assert!(r.is_error, "{}", r.content);
        assert!(r.content.contains("per-hunk"), "{}", r.content);
        // 拒绝必须发生在写盘之前。
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.txt")).unwrap(),
            "dup\ndup\n"
        );
    }

    /// 支持的写法：`replace_all` 放进 hunk。
    #[tokio::test]
    async fn hunk_level_replace_all_still_works() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "dup\ndup\n").unwrap();
        let args = serde_json::json!({
            "file_path": "a.txt",
            "edits": [{"old_string": "dup", "new_string": "x", "replace_all": true}]
        });
        let r = EditFileTool
            .execute(&args.to_string(), &ctx(d.path()))
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.txt")).unwrap(),
            "x\nx\n"
        );
    }

    /// 便捷形（无 edits[]）的顶层 `replace_all` 照旧生效：零行为回归。
    #[tokio::test]
    async fn convenience_form_keeps_top_level_replace_all() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "dup\ndup\n").unwrap();
        let args = serde_json::json!({
            "path": "a.txt",
            "old_string": "dup",
            "new_string": "x",
            "replace_all": true
        });
        let r = EditFileTool
            .execute(&args.to_string(), &ctx(d.path()))
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.txt")).unwrap(),
            "x\nx\n"
        );
    }

    /// `replace_all` 优先于 `occurrence`（已文档化在 schema 描述里）：同时给出时忽略定位。
    #[tokio::test]
    async fn replace_all_takes_precedence_over_occurrence() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "dup\ndup\ndup\n").unwrap();
        let args = serde_json::json!({
            "file_path": "a.txt",
            "edits": [{"old_string": "dup", "new_string": "x", "replace_all": true, "occurrence": 2}]
        });
        let r = EditFileTool
            .execute(&args.to_string(), &ctx(d.path()))
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.txt")).unwrap(),
            "x\nx\nx\n"
        );
    }

    /// 缺字段时报错必须点名 `edits[N]`（模型一次重试命中）；
    /// 且校验必须发生在写盘之前（不能写一半）。
    #[tokio::test]
    async fn missing_old_string_names_the_hunk_index() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "hello\n").unwrap();
        let args = serde_json::json!({
            "file_path": "a.txt",
            "edits": [
                {"old_string": "hello", "new_string": "world"},
                {"new_string": "新增"}
            ]
        });
        let r = EditFileTool
            .execute(&args.to_string(), &ctx(d.path()))
            .await;
        assert!(r.is_error, "{}", r.content);
        assert!(r.content.contains("edits[1]"), "{}", r.content);
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.txt")).unwrap(),
            "hello\n"
        );
    }

    #[tokio::test]
    async fn missing_string_errors_and_keeps_file() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "hello\n").unwrap();
        let r = EditFileTool
            .execute(
                r#"{"file_path":"a.txt","old_string":"absent","new_string":"x"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(r.is_error, "{}", r.content);
        assert!(r.content.contains("not found"), "{}", r.content);
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.txt")).unwrap(),
            "hello\n"
        );
    }

    #[tokio::test]
    async fn edit_is_risky() {
        assert_eq!(EditFileTool.risk("{}"), RiskLevel::Risky);
    }

    // A CRLF (Windows) file edited with a multi-line `old_string` whose line break is
    // `\n` — which is exactly what read shows the model, because read does
    // `text.lines()` and strips the `\r`. The edit must still succeed, and the file must
    // stay CRLF (no mixed line endings introduced).
    #[tokio::test]
    async fn crlf_file_matches_lf_oldstring_and_preserves_crlf() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join("router.js"),
            "  path: '/help',\r\n  next: 1,\r\n",
        )
        .unwrap();
        let r = EditFileTool
            .execute(
                r#"{"file_path":"router.js","old_string":"  path: '/help',\n  next: 1,","new_string":"  path: '/proxyCase',\n  next: 1,"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            !r.is_error,
            "CRLF file must match an LF old_string: {}",
            r.content
        );
        let on_disk = std::fs::read_to_string(d.path().join("router.js")).unwrap();
        assert_eq!(
            on_disk, "  path: '/proxyCase',\r\n  next: 1,\r\n",
            "must stay CRLF: {on_disk:?}"
        );
    }

    // A literal match must write new_string VERBATIM — never coerce its line endings.
    // Here a mostly-LF file has one stray CRLF line; editing an LF region must NOT force
    // the replacement to CRLF (that would inject mixed endings, the opposite of intent).
    #[tokio::test]
    async fn literal_match_writes_new_verbatim_no_crlf_injection() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("m.txt"), "head\r\nalpha\nbeta\n").unwrap();
        let r = EditFileTool
            .execute(
                r#"{"file_path":"m.txt","old_string":"alpha\nbeta","new_string":"alpha\nBETA"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        // The edited LF region stays LF; the unrelated CRLF line is untouched.
        assert_eq!(
            std::fs::read_to_string(d.path().join("m.txt")).unwrap(),
            "head\r\nalpha\nBETA\n"
        );
    }

    // old_string and new_string that differ ONLY by line-ending form collapse to the
    // same bytes after normalization → a no-op; it must be refused, not reported as a
    // successful edit.
    #[tokio::test]
    async fn eol_only_difference_is_rejected_as_noop() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("c.txt"), "a\r\nb\r\n").unwrap();
        let r = EditFileTool
            .execute(
                r#"{"file_path":"c.txt","old_string":"a\nb","new_string":"a\r\nb"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(r.is_error, "a no-op edit must be refused: {}", r.content);
        assert_eq!(
            std::fs::read_to_string(d.path().join("c.txt")).unwrap(),
            "a\r\nb\r\n",
            "unchanged"
        );
    }

    #[tokio::test]
    async fn empty_old_string_is_rejected() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "abc").unwrap();
        let r = EditFileTool
            .execute(
                r#"{"file_path":"a.txt","old_string":"","new_string":"X","replace_all":true}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            r.is_error,
            "empty old_string must be refused (would insert everywhere): {}",
            r.content
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.txt")).unwrap(),
            "abc",
            "unchanged"
        );
    }

    #[tokio::test]
    async fn lf_file_is_unaffected_by_eol_tolerance() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.rs"), "let x = 1;\nlet y = 2;\n").unwrap();
        let r = EditFileTool
            .execute(
                r#"{"file_path":"a.rs","old_string":"let x = 1;\nlet y = 2;","new_string":"let x = 9;\nlet y = 2;"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.rs")).unwrap(),
            "let x = 9;\nlet y = 2;\n"
        );
    }

    // The reported "改不动只能写脚本" case: the file is TAB-indented but the model
    // reproduced the body with SPACE indentation (read faithfully passes the tabs;
    // the model dropped them). Exact + EOL match both fail. The whitespace-normalized
    // fuzzy fallback must match line-by-line ignoring leading whitespace, and write back
    // using the file's REAL indentation (tabs preserved).
    #[tokio::test]
    async fn fuzzy_matches_tab_vs_space_indentation_and_preserves_tabs() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join("f.rs"),
            "fn f() {\n\tlet x = 1;\n\tlet y = 2;\n}\n",
        )
        .unwrap();
        let r = EditFileTool
            .execute(
                r#"{"file_path":"f.rs","old_string":"    let x = 1;\n    let y = 2;","new_string":"    let x = 9;\n    let y = 2;"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            !r.is_error,
            "fuzzy whitespace match must succeed: {}",
            r.content
        );
        assert!(
            r.content.contains("line-trimmed") || r.content.contains("whitespace"),
            "should report a whitespace match: {}",
            r.content
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("f.rs")).unwrap(),
            "fn f() {\n\tlet x = 9;\n\tlet y = 2;\n}\n",
            "the file's tab indentation must be preserved"
        );
    }

    // A fuzzy edit on a CRLF file must NOT rewrite the whole file to LF: `lines()`
    // strips every `\r`, so without restoring the file's EOL the entire file (incl.
    // untouched lines) would be silently downgraded to LF — a whole-file corruption.
    #[tokio::test]
    async fn fuzzy_match_preserves_crlf_line_endings() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join("f.rs"),
            "fn f() {\r\n\tlet x = 1;\r\n\tlet y = 2;\r\n}\r\n",
        )
        .unwrap();
        // Model copied LF text (read strips \r) with SPACE indentation.
        let r = EditFileTool
            .execute(
                r#"{"file_path":"f.rs","old_string":"    let x = 1;\n    let y = 2;","new_string":"    let x = 9;\n    let y = 2;"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(
            std::fs::read_to_string(d.path().join("f.rs")).unwrap(),
            "fn f() {\r\n\tlet x = 9;\r\n\tlet y = 2;\r\n}\r\n",
            "CRLF must be preserved across the WHOLE file, not just the edited region"
        );
    }

    // Safety guard: a tiny fragment must NOT fuzzy-match (too ambiguous to be safe).
    #[tokio::test]
    async fn fuzzy_does_not_fire_for_short_fragments() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "\tx\n").unwrap();
        let r = EditFileTool
            .execute(
                r#"{"file_path":"a.txt","old_string":"  x","new_string":"  y"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            r.is_error,
            "a short fragment must not fuzzy-match: {}",
            r.content
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.txt")).unwrap(),
            "\tx\n",
            "unchanged"
        );
    }

    // Regression: indent arithmetic must count *characters*, not bytes. When the file
    // is indented with a multi-byte whitespace char (here U+3000 IDEOGRAPHIC SPACE,
    // 3 bytes / 1 char), the old byte-based `file_indent` fed into `chars().take(n)`
    // grabbed content chars into the indent prefix, producing corruption like
    // "\u{3000}x x = 99". The fix (leading_ws_chars) keeps exactly the whitespace.
    // BLOCK-ANCHOR tier: the model reproduced a multi-line block but got ONE interior
    // line slightly wrong (`let b = 20;` vs the file's `let b = 2;`) AND used spaces where
    // the file uses tabs. Exact + whitespace-normalized fuzzy both fail (fuzzy needs EVERY
    // trimmed line to match). Block-anchor matches on the first/last trimmed lines, replaces
    // the real window, and re-anchors to the file's tabs — so the model doesn't reach for sed.
    #[tokio::test]
    async fn block_anchor_matches_interior_drift_and_preserves_tabs() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join("f.rs"),
            "fn f() {\n\tlet a = 1;\n\tlet b = 2;\n\tlet c = 3;\n}\n",
        )
        .unwrap();
        let r = EditFileTool
            .execute(
                r#"{"file_path":"f.rs","old_string":"    let a = 1;\n    let b = 20;\n    let c = 3;","new_string":"    let a = 1;\n    let b = 99;\n    let c = 3;"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "block-anchor must succeed: {}", r.content);
        assert!(
            r.content.contains("anchored block"),
            "should report an anchored match: {}",
            r.content
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("f.rs")).unwrap(),
            "fn f() {\n\tlet a = 1;\n\tlet b = 99;\n\tlet c = 3;\n}\n",
            "the intended edit applies with the file's tab indentation preserved"
        );
    }

    // Guard: a block that merely SHARES its first/last line with an unrelated region (all
    // interior lines differ) must be REJECTED (< half match), not clobbered.
    #[tokio::test]
    async fn block_anchor_rejects_low_similarity_block() {
        let d = tempfile::tempdir().unwrap();
        let original = "start marker\nreal one\nreal two\nreal three\nend marker\n";
        std::fs::write(d.path().join("a.txt"), original).unwrap();
        let r = EditFileTool
            .execute(
                // first/last match, but all 3 interior lines are wrong → 2/5 < half → reject.
                r#"{"file_path":"a.txt","old_string":"start marker\nWRONG a\nWRONG b\nWRONG c\nend marker","new_string":"start marker\nX\nend marker"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            r.is_error,
            "a low-similarity block must be refused: {}",
            r.content
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.txt")).unwrap(),
            original,
            "file must be unchanged"
        );
    }

    // Guard: at-most-ONE drifted line. A 4-line block whose BOTH interior lines differ
    // (only the anchors match) must be REJECTED — a plain "≥ half" rule would have passed
    // this (2/4), clobbering an unrelated region that happens to share first/last lines.
    #[tokio::test]
    async fn block_anchor_rejects_two_drifted_interior_lines() {
        let d = tempfile::tempdir().unwrap();
        let original = "region top\n\treal one\n\treal two\nregion bottom\n";
        std::fs::write(d.path().join("a.txt"), original).unwrap();
        let r = EditFileTool
            .execute(
                // first/last match; BOTH interior lines wrong → matched 2/4 → reject.
                r#"{"file_path":"a.txt","old_string":"region top\nWRONG one\nWRONG two\nregion bottom","new_string":"region top\nX\nregion bottom"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            r.is_error,
            "two drifted interior lines must be refused: {}",
            r.content
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.txt")).unwrap(),
            original
        );
    }

    // Coverage: the OUTDENTED-line re-anchor path (`signed_relative < 0`) — a new line less
    // indented than the block's anchor (e.g. a top-level call after an indented statement).
    // The file uses tabs; the fuzzy tier matches and re-anchors, dropping indent for the
    // outdented line.
    #[tokio::test]
    async fn reanchor_handles_outdented_new_line() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join("f.rs"),
            "fn f() {\n\tlet a = 1;\n\tlet b = 2;\n}\n",
        )
        .unwrap();
        let r = EditFileTool
            .execute(
                // Model copied with spaces; new_string's 2nd line is OUTDENTED to column 0.
                r#"{"file_path":"f.rs","old_string":"    let a = 1;\n    let b = 2;","new_string":"    let a = 1;\ndone();"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            !r.is_error,
            "outdented re-anchor must succeed: {}",
            r.content
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("f.rs")).unwrap(),
            "fn f() {\n\tlet a = 1;\ndone();\n}\n",
            "the kept line stays tab-indented; the outdented line drops to column 0"
        );
    }

    // Guard: two windows share the same first/last anchors → ambiguous → refuse.
    #[tokio::test]
    async fn block_anchor_rejects_ambiguous_windows() {
        let d = tempfile::tempdir().unwrap();
        let original =
            "open block\n  middle here\nclose block\n\nopen block\n  other mid\nclose block\n";
        std::fs::write(d.path().join("a.txt"), original).unwrap();
        let r = EditFileTool
            .execute(
                r#"{"file_path":"a.txt","old_string":"open block\n  drifted\nclose block","new_string":"open block\n  changed\nclose block"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            r.is_error,
            "ambiguous anchored windows must be refused: {}",
            r.content
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.txt")).unwrap(),
            original
        );
    }

    // Guard: bare-brace anchors (`{` / `}`, < 3 trimmed chars) can't anchor a block.
    #[tokio::test]
    async fn block_anchor_ignores_short_anchors() {
        let d = tempfile::tempdir().unwrap();
        let original = "if x {\n\tfoo();\n}\n";
        std::fs::write(d.path().join("a.rs"), original).unwrap();
        let r = EditFileTool
            .execute(
                r#"{"file_path":"a.rs","old_string":"{\n    bar();\n}","new_string":"{\n    baz();\n}"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            r.is_error,
            "short brace anchors must not fire: {}",
            r.content
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.rs")).unwrap(),
            original
        );
    }

    #[tokio::test]
    async fn fuzzy_preserves_multibyte_whitespace_indentation() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join("f.py"),
            "def f():\n\u{3000}x = 1\n\u{3000}y = 2\n",
        )
        .unwrap();
        // Model reproduced the body with plain-space indentation → exact match fails,
        // fuzzy path fires.
        let r = EditFileTool
            .execute(
                r#"{"file_path":"f.py","old_string":"    x = 1\n    y = 2","new_string":"    x = 99\n    y = 2"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "fuzzy match must succeed: {}", r.content);
        assert_eq!(
            std::fs::read_to_string(d.path().join("f.py")).unwrap(),
            "def f():\n\u{3000}x = 99\n\u{3000}y = 2\n",
            "the file's multi-byte whitespace indent must be preserved with no content leaking into it"
        );
    }

    #[tokio::test]
    async fn token_normalized_matches_invisible_unicode_and_inline_whitespace() {
        let d = tempfile::tempdir().unwrap();
        let content = "fn calculate_total(price: f64, tax_rate: f64) -> f64 {\n    let subtotal = price * (1.0 + tax_rate);\n    subtotal.round()\n}\n";
        std::fs::write(d.path().join("calc.rs"), content).unwrap();

        // Model emits with double spaces, NBSP, zero-width space, and smart quotes
        let old_str = "let  subtotal\u{200b} =\u{00a0}price * (1.0 + tax_rate);";
        let new_str = "let subtotal = price * (1.0 + tax_rate) + 5.0;";

        let r = EditFileTool
            .execute(
                &format!(
                    r#"{{"file_path":"calc.rs","old_string":{},"new_string":{}}}"#,
                    serde_json::to_string(old_str).unwrap(),
                    serde_json::to_string(new_str).unwrap()
                ),
                &ctx(d.path()),
            )
            .await;
        assert!(
            !r.is_error,
            "token normalized match must succeed: {}",
            r.content
        );
        assert!(r.content.contains("token-normalized match"));
        let updated = std::fs::read_to_string(d.path().join("calc.rs")).unwrap();
        assert!(updated.contains("let subtotal = price * (1.0 + tax_rate) + 5.0;"));
    }

    #[tokio::test]
    async fn boundary_trimmed_matches_when_llm_emits_extra_context_line() {
        let d = tempfile::tempdir().unwrap();
        let content = "fn main() {\n    let a = 10;\n    let b = 20;\n    let sum = a + b;\n    println!(\"{}\", sum);\n}\n";
        std::fs::write(d.path().join("main.rs"), content).unwrap();

        // Model copied leading context line "fn main() {" and modified sum line
        let old_str = "fn main() {\n    let a = 10;\n    let b = 20;\n    let sum = a + b;";
        let new_str = "fn main() {\n    let a = 10;\n    let b = 20;\n    let sum = a * b;";

        let r = EditFileTool
            .execute(
                &format!(
                    r#"{{"file_path":"main.rs","old_string":{},"new_string":{}}}"#,
                    serde_json::to_string(old_str).unwrap(),
                    serde_json::to_string(new_str).unwrap()
                ),
                &ctx(d.path()),
            )
            .await;
        assert!(
            !r.is_error,
            "boundary trimmed match must succeed: {}",
            r.content
        );
        let updated = std::fs::read_to_string(d.path().join("main.rs")).unwrap();
        assert!(updated.contains("let sum = a * b;"));
    }

    #[tokio::test]
    async fn not_found_returns_closest_match_snippet() {
        let d = tempfile::tempdir().unwrap();
        let content = "pub fn perform_action() {\n    let mut state = get_state();\n    state.validate_and_commit();\n}\n";
        std::fs::write(d.path().join("act.rs"), content).unwrap();

        let r = EditFileTool
            .execute(
                r#"{"file_path":"act.rs","old_string":"let state = get_state();\nstate.validate_and_rollback();","new_string":"let state = get_state();"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(r.is_error);
        assert!(
            r.content.contains("Closest matching block"),
            "{}",
            r.content
        );
        assert!(r.content.contains("```diff"), "{}", r.content);
        assert!(r.content.contains("👉 Conflict found"), "{}", r.content);
        assert!(
            r.content.contains("adjust your old_string"),
            "{}",
            r.content
        );
    }

    #[tokio::test]
    async fn test_stripped_arrow_prefix_succeeds() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("code.rs"), "fn foo() {\n    bar();\n}\n").unwrap();
        // Model accidentally copied read output prefix "1→" and "2→"
        let args = serde_json::json!({
            "file_path": "code.rs",
            "edits": [
                {
                    "old_string": "1→fn foo() {\n2→    bar();",
                    "new_string": "fn foo() {\n    baz();"
                }
            ]
        });
        let r = EditFileTool
            .execute(&args.to_string(), &ctx(d.path()))
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(
            std::fs::read_to_string(d.path().join("code.rs")).unwrap(),
            "fn foo() {\n    baz();\n}\n"
        );
    }

    #[test]
    fn schema_advertises_edits_as_array_only() {
        let schema = EditFileTool.parameters_schema();
        let edits = &schema["properties"]["edits"];
        assert_eq!(
            edits["type"], "array",
            "schema must not advertise string|array: {edits}"
        );
        assert!(edits.get("oneOf").is_none());
        assert!(edits.get("anyOf").is_none());
    }

    #[tokio::test]
    async fn stringified_edits_array_is_accepted() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.rs"), "fn a() { 1 }\nfn b() { 2 }\n").unwrap();
        let inner = r#"[{"old_string":"fn a() { 1 }","new_string":"fn a() { 10 }"}]"#;
        let args = serde_json::json!({
            "file_path": "a.rs",
            "edits": inner
        })
        .to_string();
        let r = EditFileTool.execute(&args, &ctx(d.path())).await;
        assert!(
            !r.is_error,
            "stringified edits must be accepted internally: {}",
            r.content
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.rs")).unwrap(),
            "fn a() { 10 }\nfn b() { 2 }\n"
        );
    }

    #[tokio::test]
    async fn stringified_edits_with_raw_newlines_is_repaired() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.rs"), "let x = 1;\nlet y = 2;\n").unwrap();
        // Outer JSON is valid; the edits *string* contains a real newline inside the
        // inner JSON snippet — the common provider/model double-encoding miss.
        let inner = "[{ \"old_string\": \"let x = 1;\nlet y = 2;\", \"new_string\": \"let x = 9;\nlet y = 2;\" }]";
        let args = serde_json::json!({
            "file_path": "a.rs",
            "edits": inner
        })
        .to_string();
        let r = EditFileTool.execute(&args, &ctx(d.path())).await;
        assert!(
            !r.is_error,
            "repair_json must salvage inner newlines: {}",
            r.content
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.rs")).unwrap(),
            "let x = 9;\nlet y = 2;\n"
        );
    }

    #[tokio::test]
    async fn stringified_edits_missing_closers_is_rejected() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.rs"), "fn a() { 1 }\n").unwrap();
        let inner = r#"[{"old_string":"fn a() { 1 }","new_string":"fn a() { 10 }""#;
        let args = serde_json::json!({
            "file_path": "a.rs",
            "edits": inner
        })
        .to_string();
        let r = EditFileTool.execute(&args, &ctx(d.path())).await;
        assert!(
            r.is_error,
            "truncated containers must not apply: {}",
            r.content
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.rs")).unwrap(),
            "fn a() { 1 }\n"
        );
    }

    #[tokio::test]
    async fn stringified_edits_truncated_new_string_is_rejected() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.rs"), "fn a() { 1 }\n").unwrap();
        let inner = r#"[{"old_string":"fn a() { 1 }","new_string":"fn a() { 10"#;
        let args = serde_json::json!({
            "file_path": "a.rs",
            "edits": inner
        })
        .to_string();
        let r = EditFileTool.execute(&args, &ctx(d.path())).await;
        assert!(
            r.is_error,
            "truncated new_string must not write: {}",
            r.content
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.rs")).unwrap(),
            "fn a() { 1 }\n",
            "file must stay untouched"
        );
    }

    #[test]
    fn deserialize_edits_rejects_incomplete_lists_and_nested_siblings() {
        for edits in [
            serde_json::json!(
                r#"[{"old_string":"a","new_string":"b"},{"old_string":"c","new_string":"cut"#
            ),
            serde_json::json!(r#"[{"old_string":"a","new_string":"b"}"#),
            serde_json::json!({
                "a": {"old_string":"a", "new_string":"b"},
                "b": r#"[{"old_string":"c","new_string":"cut"#
            }),
            serde_json::json!([
                {"old_string":"a", "new_string":"b"},
                {"old_string":"c"}
            ]),
        ] {
            let args = serde_json::json!({"path":"a.rs", "edits":edits});
            assert!(serde_json::from_value::<Args>(args).is_err());
        }
    }

    #[tokio::test]
    async fn stringified_edits_complete_prefix_plus_cut_hunk_rejects_entire_request() {
        let d = tempfile::tempdir().unwrap();
        let original = "fn a() { 1 }
fn b() { 2 }
";
        std::fs::write(d.path().join("a.rs"), original).unwrap();
        for tail in [
            r#"{"old_string":"fn b() { 2 }","new_string":"fn b() { 20"#,
            r#"{"old_string":"fn b() { 2 }""#,
        ] {
            let inner = format!(
                r#"[{{"old_string":"fn a() {{ 1 }}","new_string":"fn a() {{ 10 }}"}},{}"#,
                tail
            );
            let args = serde_json::json!({"file_path":"a.rs", "edits":inner}).to_string();
            let r = EditFileTool.execute(&args, &ctx(d.path())).await;
            assert!(r.is_error, "partial request must fail: {}", r.content);
            assert_eq!(
                std::fs::read_to_string(d.path().join("a.rs")).unwrap(),
                original
            );
        }
    }

    #[tokio::test]
    async fn repaired_original_cut_edits_and_depth_budget_leave_file_unchanged() {
        let d = tempfile::tempdir().unwrap();
        let original = "a\nb\n";
        std::fs::write(d.path().join("a.rs"), original).unwrap();
        let cut_a = r#"[{"old_string":"a","new_string":"changed"}"#;
        let cut_b =
            r#"[{"old_string":"a","new_string":"changed"},{"old_string":"b","new_string":"cut"#;
        let mut nested = serde_json::json!({"old_string":"a", "new_string":"changed"});
        for _ in 0..40 {
            nested = serde_json::json!({"edits":nested});
        }
        for edits in [
            serde_json::json!(cut_a),
            serde_json::json!(cut_b),
            nested,
            serde_json::json!([{"old_string":"a", "new_string":"changed"}, {"old_string":"b"}]),
        ] {
            for sibling in [false, true] {
                let mut value = serde_json::json!({"file_path":"a.rs", "edits":edits});
                if sibling {
                    value["hunk"] = serde_json::json!({"old_string":"a", "new_string":"changed"});
                }
                let args = value.to_string();
                let repaired = crate::tools::repair::repair_tool_args("edit", &args);
                assert_eq!(
                    repaired, args,
                    "original incomplete edits must not be repaired"
                );
                let r = EditFileTool.execute(&repaired, &ctx(d.path())).await;
                assert!(r.is_error, "{}", r.content);
                assert_eq!(
                    std::fs::read_to_string(d.path().join("a.rs")).unwrap(),
                    original
                );
            }
        }
    }

    #[tokio::test]
    async fn stringified_edits_wrapped_as_full_args_object_is_unwrapped() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.rs"), "fn a() { 1 }\n").unwrap();
        let inner = serde_json::json!({
            "file_path": "ignored.rs",
            "edits": [{"old_string":"fn a() { 1 }","new_string":"fn a() { 10 }"}]
        })
        .to_string();
        let args = serde_json::json!({
            "file_path": "a.rs",
            "edits": inner
        })
        .to_string();
        let r = EditFileTool.execute(&args, &ctx(d.path())).await;
        assert!(
            !r.is_error,
            "nested args object must unwrap edits: {}",
            r.content
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.rs")).unwrap(),
            "fn a() { 10 }\n"
        );
    }

    #[tokio::test]
    async fn hybrid_truncated_edits_string_plus_sibling_hunk_object_is_rejected() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join("mod.rs"),
            "            \"todowrite\",\n            \"read\",\n",
        )
        .unwrap();
        let args = serde_json::json!({
            "file_path": "mod.rs",
            "edits": r#"[{"old_string":"            \"todowrite\","#,
            "new_string": {
                "old_string": "            \"todowrite\",",
                "new_string": "            \"todo_write\",",
                "replace_all": true
            }
        })
        .to_string();
        let r = EditFileTool.execute(&args, &ctx(d.path())).await;
        assert!(
            r.is_error,
            "cut edits must reject sibling recovery: {}",
            r.content
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("mod.rs")).unwrap(),
            "            \"todowrite\",\n            \"read\",\n"
        );
    }

    #[tokio::test]
    async fn multi_hunk_sequential_edits_succeed() {
        let d = tempfile::tempdir().unwrap();
        let original = [
            "# header",
            "keep",
            "# block-a",
            "a1",
            "a2",
            "# block-b",
            "  jeikcode:",
            "    protocol: openai_chat",
            "# footer",
            "",
        ]
        .join("\n");
        std::fs::write(d.path().join("config.yaml"), original).unwrap();

        let hunk1_new = "# block-a\na1\na2\na3\na4\na5\n";
        let args = serde_json::json!({
            "file_path": "config.yaml",
            "edits": [
                {
                    "old_string": "# block-a\na1\na2",
                    "new_string": hunk1_new.trim_end()
                },
                {
                    "old_string": "  jeikcode:\n    protocol: openai_chat",
                    "new_string": "  jeikcode:\n    protocol: openai_chat\n    # extra"
                }
            ]
        });
        let r = EditFileTool
            .execute(&args.to_string(), &ctx(d.path()))
            .await;
        assert!(!r.is_error, "{}", r.content);
        let on_disk = std::fs::read_to_string(d.path().join("config.yaml")).unwrap();
        assert!(
            on_disk.contains("a5\n# block-b\n  jeikcode:"),
            "second hunk must apply cleanly:\n{on_disk}"
        );
        assert!(on_disk.contains("    # extra"), "{on_disk}");
        assert!(on_disk.contains("# footer"), "{on_disk}");
    }

    #[tokio::test]
    async fn auto_healed_edit_emits_directive_notice_and_succeeds() {
        let d = tempfile::tempdir().unwrap();
        let content = "fn example() {\n\tlet value = 123;\n\tlet next = value + 1;\n}\n";
        std::fs::write(d.path().join("example.rs"), content).unwrap();

        // Model provided space indentation instead of tab -> triggers fuzzy line-trimmed match
        let old_str = "    let value = 123;\n    let next = value + 1;";
        let new_str = "    let value = 456;\n    let next = value + 1;";

        let args = serde_json::json!({
            "file_path": "example.rs",
            "old_string": old_str,
            "new_string": new_str
        });

        let r = EditFileTool
            .execute(&args.to_string(), &ctx(d.path()))
            .await;
        assert!(!r.is_error, "auto-heal must succeed: {}", r.content);
        assert!(
            r.content.contains("⚠️ **[Auto-heal Note]**:"),
            "should contain the warning header: {}",
            r.content
        );
        assert!(
            r.content
                .contains("A conflict in old_string was safely resolved and applied."),
            "should contain exact notice: {}",
            r.content
        );
        assert!(
            r.content.contains("use the latest content below:"),
            "should contain latest actual old_string section: {}",
            r.content
        );
        assert!(
            r.content.contains("Edit applied successfully!"),
            "should contain success summary: {}",
            r.content
        );
        assert!(
            r.content.contains("let value = 123;"),
            "should display actual old_string in snippet: {}",
            r.content
        );

        let on_disk = std::fs::read_to_string(d.path().join("example.rs")).unwrap();
        assert_eq!(
            on_disk,
            "fn example() {\n\tlet value = 456;\n\tlet next = value + 1;\n}\n"
        );
    }

    #[tokio::test]
    async fn exact_match_does_not_emit_directive_notice() {
        let d = tempfile::tempdir().unwrap();
        let content = "fn hello() {\n    println!(\"world\");\n}\n";
        std::fs::write(d.path().join("hello.rs"), content).unwrap();

        let args = serde_json::json!({
            "file_path": "hello.rs",
            "old_string": "    println!(\"world\");",
            "new_string": "    println!(\"jeikcode\");"
        });

        let r = EditFileTool
            .execute(&args.to_string(), &ctx(d.path()))
            .await;
        assert!(!r.is_error, "exact match must succeed: {}", r.content);
        assert!(
            !r.content.contains("Auto-heal Note"),
            "exact match should NOT emit auto-heal notice: {}",
            r.content
        );
        assert!(r.content.contains("Edited"));
        let on_disk = std::fs::read_to_string(d.path().join("hello.rs")).unwrap();
        assert_eq!(on_disk, "fn hello() {\n    println!(\"jeikcode\");\n}\n");
    }

    #[tokio::test]
    async fn test_topological_reordering_resolves_war_dependency() {
        let d = tempfile::tempdir().unwrap();
        let initial = [
            "fn process() {",
            "    let step1 = 10;",
            "    let step2 = 20;",
            "    let step3 = 30;",
            "    println!(\"{}\", step1 + step2 + step3);",
            "}",
            "",
        ]
        .join("\n");
        std::fs::write(d.path().join("proc.rs"), &initial).unwrap();

        // Hunk A modifies step3 (reads step2 as context)
        let hunk_a = serde_json::json!({
            "old_string": "    let step2 = 20;\n    let step3 = 30;",
            "new_string": "    let step2 = 20;\n    let step3 = 999;"
        });
        // Hunk B modifies step2
        let hunk_b = serde_json::json!({
            "old_string": "    let step1 = 10;\n    let step2 = 20;",
            "new_string": "    let step1 = 10;\n    let step2 = 222;"
        });

        // Pass in the order [Hunk B, Hunk A] which would fail without topological sorting
        // because B modifies step2, breaking A's read context.
        let args = serde_json::json!({
            "file_path": "proc.rs",
            "edits": [hunk_b, hunk_a]
        });

        let r = EditFileTool
            .execute(&args.to_string(), &ctx(d.path()))
            .await;
        assert!(
            !r.is_error,
            "topological reordering must order WAR dependencies correctly: {}",
            r.content
        );

        let on_disk = std::fs::read_to_string(d.path().join("proc.rs")).unwrap();
        assert!(on_disk.contains("let step2 = 222;"), "{}", on_disk);
        assert!(on_disk.contains("let step3 = 999;"), "{}", on_disk);
    }

    #[tokio::test]
    async fn test_version_ring_cross_turn_3way_rebase() {
        let d = tempfile::tempdir().unwrap();
        let file_path = d.path().join("calc.rs");
        let initial = [
            "fn alpha() { 1 }",
            "fn beta() { 2 }",
            "fn gamma() { 3 }",
            "",
        ]
        .join("\n");
        std::fs::write(&file_path, &initial).unwrap();

        // Turn 1: Modify alpha
        let args1 = serde_json::json!({
            "file_path": "calc.rs",
            "old_string": "fn alpha() { 1 }",
            "new_string": "fn alpha() { 100 }"
        });
        let r1 = EditFileTool
            .execute(&args1.to_string(), &ctx(d.path()))
            .await;
        assert!(!r1.is_error, "{}", r1.content);

        // Turn 2: Modify beta
        let args2 = serde_json::json!({
            "file_path": "calc.rs",
            "old_string": "fn beta() { 2 }",
            "new_string": "fn beta() { 200 }"
        });
        let r2 = EditFileTool
            .execute(&args2.to_string(), &ctx(d.path()))
            .await;
        assert!(!r2.is_error, "{}", r2.content);

        // Turn 3: Model has attention time-travel and emits edit based on Turn 0 (before beta was modified):
        // old_string includes the old `beta` as context
        let args3 = serde_json::json!({
            "file_path": "calc.rs",
            "old_string": "fn beta() { 2 }\nfn gamma() { 3 }",
            "new_string": "fn beta() { 2 }\nfn gamma() { 999 }"
        });
        let r3 = EditFileTool
            .execute(&args3.to_string(), &ctx(d.path()))
            .await;
        assert!(
            !r3.is_error,
            "historical 3-way rebase must recover and succeed: {}",
            r3.content
        );
        assert!(
            r3.content.contains("⚠️ **[Auto-heal Note]**:"),
            "should emit auto-heal notice: {}",
            r3.content
        );

        let final_disk = std::fs::read_to_string(&file_path).unwrap();
        assert!(final_disk.contains("fn alpha() { 100 }"), "{}", final_disk);
        assert!(final_disk.contains("fn beta() { 200 }"), "{}", final_disk);
        assert!(final_disk.contains("fn gamma() { 999 }"), "{}", final_disk);
    }

    // =========================================================================
    // Comprehensive Agent Scenario Suite (AAA / BBB / CCC / DDD)
    // =========================================================================

    #[tokio::test]
    async fn test_scenario_1_independent_hunks_bottom_up() {
        // Scenario 1: Single turn with multiple edits. Top edit inserts multiple lines,
        // while bottom edit modifies a later line. Topological sorting applies the bottom
        // hunk first, ensuring that expanding lines in the top hunk does NOT alter the line
        // offsets or match positions of the bottom hunk.
        let d = tempfile::tempdir().unwrap();
        let initial = ["AAA_top = 1", "AAA_middle = 2", "AAA_bottom = 3", ""].join("\n");
        std::fs::write(d.path().join("scenario1.txt"), &initial).unwrap();

        let top_expansion = [
            "AAA_top = 1",
            "BBB_top_extra_1 = 11",
            "BBB_top_extra_2 = 12",
            "BBB_top_extra_3 = 13",
        ]
        .join("\n");

        let args = serde_json::json!({
            "file_path": "scenario1.txt",
            "edits": [
                {
                    "old_string": "AAA_top = 1",
                    "new_string": top_expansion
                },
                {
                    "old_string": "AAA_bottom = 3",
                    "new_string": "BBB_bottom = 300"
                }
            ]
        });

        let r = EditFileTool
            .execute(&args.to_string(), &ctx(d.path()))
            .await;
        assert!(!r.is_error, "independent hunks must succeed: {}", r.content);

        let on_disk = std::fs::read_to_string(d.path().join("scenario1.txt")).unwrap();
        assert!(on_disk.contains("BBB_top_extra_3 = 13"), "{}", on_disk);
        assert!(on_disk.contains("AAA_middle = 2"), "{}", on_disk);
        assert!(on_disk.contains("BBB_bottom = 300"), "{}", on_disk);
    }

    #[tokio::test]
    async fn test_scenario_2_war_dependency_topological_sort() {
        // Scenario 2: Single turn where Hunk B writes line 1, and Hunk A reads line 1 as context
        // to uniquely modify line 2. Regardless of input array order, Hunk A must run before Hunk B.
        let d = tempfile::tempdir().unwrap();
        let initial = ["AAA_line1 = \"first\";", "AAA_line2 = \"second\";", ""].join("\n");
        std::fs::write(d.path().join("scenario2.txt"), &initial).unwrap();

        let hunk_write_line1 = serde_json::json!({
            "old_string": "AAA_line1 = \"first\";",
            "new_string": "BBB_line1 = \"first_modified\";"
        });

        let hunk_read1_write2 = serde_json::json!({
            "old_string": "AAA_line1 = \"first\";\nAAA_line2 = \"second\";",
            "new_string": "AAA_line1 = \"first\";\nBBB_line2 = \"second_modified\";"
        });

        // Pass [hunk_write_line1, hunk_read1_write2]: naive execution would overwrite line 1 first,
        // causing hunk_read1_write2 to fail matching.
        let args = serde_json::json!({
            "file_path": "scenario2.txt",
            "edits": [hunk_write_line1, hunk_read1_write2]
        });

        let r = EditFileTool
            .execute(&args.to_string(), &ctx(d.path()))
            .await;
        assert!(
            !r.is_error,
            "WAR dependency must be correctly reordered: {}",
            r.content
        );

        let on_disk = std::fs::read_to_string(d.path().join("scenario2.txt")).unwrap();
        assert!(
            on_disk.contains("BBB_line1 = \"first_modified\";"),
            "{}",
            on_disk
        );
        assert!(
            on_disk.contains("BBB_line2 = \"second_modified\";"),
            "{}",
            on_disk
        );
    }

    #[tokio::test]
    async fn test_topological_sort_failure_reports_original_input_hunk_index() {
        // Disjoint edits on lines 1, 2, 3 would be topologically executed bottom-up (3, then 2, then 1).
        // If the first edit in the input array (line 1) fails, the error must report hunk 1/3, NOT hunk 3/3.
        let d = tempfile::tempdir().unwrap();
        let initial = ["AAA_1 = 1", "AAA_2 = 2", "AAA_3 = 3", ""].join("\n");
        std::fs::write(d.path().join("hunk_index.txt"), &initial).unwrap();

        let args = serde_json::json!({
            "file_path": "hunk_index.txt",
            "edits": [
                {
                    "old_string": "AAA_TYPO = 1",
                    "new_string": "BBB_1 = 10"
                },
                {
                    "old_string": "AAA_2 = 2",
                    "new_string": "BBB_2 = 20"
                },
                {
                    "old_string": "AAA_3 = 3",
                    "new_string": "BBB_3 = 30"
                }
            ]
        });

        let r = EditFileTool
            .execute(&args.to_string(), &ctx(d.path()))
            .await;
        assert!(r.is_error, "edit must fail when old_string is missing");
        assert!(
            r.content.contains("hunk 1/3 failed"),
            "failure must report original input index 1/3, but got:\n{}",
            r.content
        );
    }

    #[tokio::test]
    async fn test_scenario_3_multiturn_context_time_travel_clean_rebase() {
        // Scenario 3: Turn 1 modifies AAA_port -> BBB_port.
        // In Turn 2, the model (with stale attention/context) sends an edit based on Turn 0 (AAA_port),
        // but its edit targets AAA_timeout -> CCC_timeout.
        // 3-Way Auto-Rebase detects non-overlapping changes, cleanly merges, and emits warning with latest old_str.
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("scenario3.txt");
        let v0 = [
            "AAA_port = 8080",
            "AAA_host = \"127.0.0.1\"",
            "AAA_timeout = 30",
            "",
        ]
        .join("\n");
        std::fs::write(&path, &v0).unwrap();

        // Turn 1
        let args1 = serde_json::json!({
            "file_path": "scenario3.txt",
            "old_string": "AAA_port = 8080",
            "new_string": "BBB_port = 9000"
        });
        let r1 = EditFileTool
            .execute(&args1.to_string(), &ctx(d.path()))
            .await;
        assert!(!r1.is_error, "{}", r1.content);

        // Turn 2 (Stale context from V0)
        let args2 = serde_json::json!({
            "file_path": "scenario3.txt",
            "old_string": "AAA_port = 8080\nAAA_host = \"127.0.0.1\"\nAAA_timeout = 30",
            "new_string": "AAA_port = 8080\nAAA_host = \"127.0.0.1\"\nCCC_timeout = 60"
        });
        let r2 = EditFileTool
            .execute(&args2.to_string(), &ctx(d.path()))
            .await;
        assert!(
            !r2.is_error,
            "stale context rebase must succeed: {}",
            r2.content
        );
        assert!(
            r2.content.contains("⚠️ **[Auto-heal Note]**:"),
            "should emit auto-heal notice: {}",
            r2.content
        );

        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(
            on_disk.contains("BBB_port = 9000"),
            "disk must retain Turn 1 edit: {}",
            on_disk
        );
        assert!(
            on_disk.contains("CCC_timeout = 60"),
            "disk must apply Turn 2 edit: {}",
            on_disk
        );
    }

    #[tokio::test]
    async fn test_scenario_4_edit_previously_modified_site_deletion_and_addition() {
        // Scenario 4: Editing at previously modified locations.
        // Turn 1: AAA_item -> BBB_item
        // Turn 2: Append CCC_addition right after BBB_item
        // Turn 3: Delete BBB_item entirely (new_string: "")
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("scenario4.txt");
        let v0 = "AAA_item = \"original\";\n";
        std::fs::write(&path, v0).unwrap();

        // Turn 1: Replace AAA with BBB
        let args1 = serde_json::json!({
            "file_path": "scenario4.txt",
            "old_string": "AAA_item = \"original\";",
            "new_string": "BBB_item = \"modified\";"
        });
        let r1 = EditFileTool
            .execute(&args1.to_string(), &ctx(d.path()))
            .await;
        assert!(!r1.is_error, "{}", r1.content);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "BBB_item = \"modified\";\n"
        );

        // Turn 2: Addition at previous site (append CCC)
        let args2 = serde_json::json!({
            "file_path": "scenario4.txt",
            "old_string": "BBB_item = \"modified\";",
            "new_string": "BBB_item = \"modified\";\nCCC_addition = \"appended\";"
        });
        let r2 = EditFileTool
            .execute(&args2.to_string(), &ctx(d.path()))
            .await;
        assert!(!r2.is_error, "{}", r2.content);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "BBB_item = \"modified\";\nCCC_addition = \"appended\";\n"
        );

        // Turn 3: Deletion at previous site (delete BBB, leaving CCC)
        let args3 = serde_json::json!({
            "file_path": "scenario4.txt",
            "old_string": "BBB_item = \"modified\";\n",
            "new_string": ""
        });
        let r3 = EditFileTool
            .execute(&args3.to_string(), &ctx(d.path()))
            .await;
        assert!(!r3.is_error, "{}", r3.content);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "CCC_addition = \"appended\";\n"
        );
    }

    #[tokio::test]
    async fn test_scenario_5_continuous_revision_chain() {
        // Scenario 5: Multi-turn sequential revision chain:
        // V0 (AAA) -> V1 (BBB) -> V2 (CCC) -> V3 (DDD) -> V4 (EEE)
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("scenario5.txt");
        std::fs::write(&path, "AAA_step = 0;\n").unwrap();

        let steps = [
            ("AAA_step = 0;", "BBB_step = 1;"),
            ("BBB_step = 1;", "CCC_step = 2;"),
            ("CCC_step = 2;", "DDD_step = 3;"),
            ("DDD_step = 3;", "EEE_step = 4;"),
        ];

        for (old_s, new_s) in steps {
            let args = serde_json::json!({
                "file_path": "scenario5.txt",
                "old_string": old_s,
                "new_string": new_s
            });
            let r = EditFileTool
                .execute(&args.to_string(), &ctx(d.path()))
                .await;
            assert!(
                !r.is_error,
                "step {} -> {} failed: {}",
                old_s, new_s, r.content
            );
        }

        let final_content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(final_content, "EEE_step = 4;\n");
    }

    #[tokio::test]
    async fn test_scenario_6_multiturn_true_write_conflict_rejected() {
        // Scenario 6: True write-write semantic conflict across turns.
        // Turn 1: AAA_val = 10 -> BBB_val = 20
        // Turn 2: Agent tries to apply AAA_val = 10 -> CCC_val = 30 from stale V0 view.
        // Both modified the EXACT same line. 3-way rebase detects overlapping edit and MUST reject,
        // not silently overwrite Turn 1's work.
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("scenario6.txt");
        std::fs::write(&path, "AAA_val = 10;\n").unwrap();

        // Turn 1
        let args1 = serde_json::json!({
            "file_path": "scenario6.txt",
            "old_string": "AAA_val = 10;",
            "new_string": "BBB_val = 20;"
        });
        let r1 = EditFileTool
            .execute(&args1.to_string(), &ctx(d.path()))
            .await;
        assert!(!r1.is_error, "{}", r1.content);

        // Turn 2: Conflicting modification on same line
        let args2 = serde_json::json!({
            "file_path": "scenario6.txt",
            "old_string": "AAA_val = 10;",
            "new_string": "CCC_val = 30;"
        });
        let r2 = EditFileTool
            .execute(&args2.to_string(), &ctx(d.path()))
            .await;
        assert!(
            r2.is_error,
            "conflicting edit on same line must be rejected"
        );
        assert!(
            r2.content.contains("not found")
                || r2.content.contains("diff")
                || r2.content.contains("Closest"),
            "should report failure and diff context: {}",
            r2.content
        );

        // Disk must preserve Turn 1's value intact!
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            on_disk, "BBB_val = 20;\n",
            "Turn 1 content must not be overwritten or corrupted"
        );
    }

    #[tokio::test]
    async fn large_drifted_hunk_diagnoses_in_bounded_time() {
        // Regression for the O(file_lines × |old| × |window|) Levenshtein diagnostic.
        // A ~220-line drifted hunk against a ~3.2k-line file must fail fast AND still
        // point at the planted region.
        let d = tempfile::tempdir().unwrap();
        let mut lines: Vec<String> = (0..3200)
            .map(|i| format!("    const filler_{i} = {i};"))
            .collect();
        let plant_at = 1800usize;
        let mut planted = vec!["    function RouterPanel() {".to_string()];
        for i in 0..218 {
            planted.push(format!("        <div className=\"row-{i}\">item-{i}</div>"));
        }
        planted.push("    }".to_string());
        for (k, line) in planted.iter().enumerate() {
            lines[plant_at + k] = line.clone();
        }
        let content = lines.join("\n") + "\n";
        std::fs::write(d.path().join("ApiProxy.tsx"), &content).unwrap();

        let mut old_lines = vec!["    function GhostPanel() {".to_string()];
        for i in 0..218 {
            if i == 49 {
                old_lines.push(format!(
                    "        <div className=\"row-{i}\">item-{i}-WRONG</div>"
                ));
            } else {
                old_lines.push(format!("        <div className=\"row-{i}\">item-{i}</div>"));
            }
        }
        old_lines.push("    } // end GhostPanel".to_string());
        let old_str = old_lines.join("\n");
        let new_str = "    function GhostPanel() {\n        return null;\n    }";

        let t0 = std::time::Instant::now();
        let r = EditFileTool
            .execute(
                &serde_json::json!({
                    "file_path": "ApiProxy.tsx",
                    "old_string": old_str,
                    "new_string": new_str
                })
                .to_string(),
                &ctx(d.path()),
            )
            .await;
        let elapsed = t0.elapsed();
        assert!(r.is_error, "expected a miss, got success: {}", r.content);
        assert!(
            elapsed < std::time::Duration::from_millis(1500),
            "closest-match diagnostic hung: {elapsed:?}"
        );
        assert!(
            r.content.contains("Closest matching block"),
            "should still localize the planted region: {}",
            r.content
        );
        assert!(
            r.content.contains("RouterPanel"),
            "diagnostic should point at the planted block: {}",
            r.content
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("ApiProxy.tsx")).unwrap(),
            content,
            "miss must not mutate the file"
        );
    }

    #[tokio::test]
    async fn pre_cancelled_token_aborts_without_writing() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.rs"), "fn a() { 1 }\n").unwrap();
        let ctx = ctx(d.path());
        ctx.cancel.cancel();
        let r = EditFileTool
            .execute(
                r#"{"file_path":"a.rs","old_string":"fn a() { 1 }","new_string":"fn a() { 2 }"}"#,
                &ctx,
            )
            .await;
        assert!(r.is_error, "cancelled edit must error: {}", r.content);
        assert!(
            r.content.contains("cancel"),
            "should mention cancellation: {}",
            r.content
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.rs")).unwrap(),
            "fn a() { 1 }\n",
            "cancelled edit must not write"
        );
    }

    #[test]
    fn format_match_sites_expands_six_lines_of_context() {
        let mut lines = Vec::new();
        for i in 1..=30 {
            if i == 10 || i == 25 {
                lines.push("    let item = duplicate();".to_string());
            } else {
                lines.push(format!("    line_{i}();"));
            }
        }
        let content = lines.join("\n");
        let result = format_match_sites(&content, "    let item = duplicate();");
        // 对于第 10 行的命中，向上 6 行（第 4 行）和向下 6 行（第 16 行）必须全部被外扩展示
        assert!(
            result.contains("line_4();"),
            "expected line 4 in upper context: {result}"
        );
        assert!(
            result.contains("line_16();"),
            "expected line 16 in lower context: {result}"
        );
        assert!(
            result.contains(">>>   10|"),
            "expected line 10 to be marked: {result}"
        );
        assert!(
            result.contains(">>>   25|"),
            "expected line 25 to be marked: {result}"
        );
    }

    #[tokio::test]
    async fn multi_hunk_failure_notes_cleanly_applied_earlier_hunks() {
        let d = tempfile::tempdir().unwrap();
        let file_path = d.path().join("code.rs");
        std::fs::write(&file_path, "fn first() { 1 }\nfn second() { 2 }\n").unwrap();

        let r = EditFileTool
            .execute(
                &serde_json::json!({
                    "file_path": "code.rs",
                    "edits": [
                        { "old_string": "fn first() { 1 }", "new_string": "fn first() { 10 }" },
                        { "old_string": "fn non_existent()", "new_string": "fn replaced()" }
                    ]
                })
                .to_string(),
                &ctx(d.path()),
            )
            .await;

        assert!(r.is_error);
        assert!(
            r.content.contains("hunk 2/2 failed"),
            "content: {}",
            r.content
        );
        assert!(
            r.content
                .contains("previous 1 hunk(s) applied cleanly in temporary buffer"),
            "should notify agent that prior hunks succeeded: {}",
            r.content
        );
        // 确认即使前置 hunk 在内存 buffer 成功应用，整批失败依然保证磁盘原封不动
        assert_eq!(
            std::fs::read_to_string(&file_path).unwrap(),
            "fn first() { 1 }\nfn second() { 2 }\n"
        );
    }

    #[test]
    fn low_similarity_candidate_hint_surfaces_clean_message_without_misleading_diff() {
        let content = (1..=20)
            .map(|i| format!("fn function_{i}() {{ println!(\"step {i}\"); }}"))
            .collect::<Vec<_>>()
            .join("\n");
        let file = NormalizedFile::new(&content);
        // 提供一个部分词袋重叠、相似度低于 0.50 的字符串
        let old_str = "fn unmapped_helper() { println!(\"totally_different\"); extra_call(); }";
        let hint = find_closest_match_snippet(None, &file, old_str).unwrap();
        assert!(
            hint.contains("old_string not found in target file")
                && hint.contains("The target code block does not exist in this file"),
            "hint: {hint}"
        );
    }

    #[test]
    fn test_scenario_1_cross_file_wrong_path_warning() {
        let temp = tempfile::tempdir().unwrap();
        let file_a = temp.path().join("GitPanel.tsx");
        let file_b = temp.path().join("Chat.tsx");

        let git_panel_code = "export function GitPanel() {\n  // 彻底移除盲目轮询，仅在窗口切回时刷新\n  useEffect(() => {\n    gitStore.scheduleRefresh();\n  }, []);\n  return <div>Git</div>;\n}\n";
        let chat_code = "export function Chat() {\n  const [state, setState] = useState(null);\n  return <div>Chat</div>;\n}\n";

        std::fs::write(&file_a, git_panel_code).unwrap();
        std::fs::write(&file_b, chat_code).unwrap();

        // 记录 GitPanel.tsx 为最近成功修改过的文件
        crate::tools::edit_history::record_version(&file_a, git_panel_code);

        let file_b_norm = NormalizedFile::new(chat_code);
        let old_str_from_a = "  // 彻底移除盲目轮询，仅在窗口切回时刷新\n  useEffect(() => {\n    gitStore.scheduleRefresh();\n  }, []);";

        // 在 Chat.tsx 中寻找 GitPanel.tsx 的专属代码块
        let hint = find_closest_match_snippet(Some(&file_b), &file_b_norm, old_str_from_a).unwrap();

        assert!(
            hint.contains("Warning: old_string was NOT found in")
                && hint.contains("but an EXACT match was found in")
                && hint.contains("Did you specify the wrong file path?"),
            "Expected cross-file wrong path warning, got: {hint}"
        );
    }

    #[test]
    fn test_scenario_2_high_similarity_shows_expanded_diff() {
        let content = "function demo() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n  return a + b + c + d;\n}\n";
        let file_norm = NormalizedFile::new(content);

        // 相似度 >= 50%：只手抖漏写了一行
        let old_str_high_sim =
            "function demo() {\n  const a = 1;\n  const c = 3;\n  return a + b + c + d;\n}";
        let hint = find_closest_match_snippet(None, &file_norm, old_str_high_sim).unwrap();

        assert!(
            hint.contains("[Content Mismatch]: Closest matching block found around lines")
                && hint.contains("```diff")
                && hint.contains("(Hint: surrounding context lines without '-' or '+' are for location reference only; do not blindly re-read the whole file)"),
            "Expected expanded Unified Diff, got: {hint}"
        );
    }

    #[test]
    fn test_structured_mismatch_diff_with_line_numbers() {
        let content =
            "line 1\nline 2\n```bash [Linux]\ncurl install.sh | bash\n```\nline 7\nline 8\n";
        let file_norm = NormalizedFile::new(content);

        // 模型在末尾多传了 "}],path:"
        let old_str_with_trailing = "```bash [Linux]\ncurl install.sh | bash\n```}],path:";
        let path = std::path::Path::new("scripts/test.md");
        let hint =
            find_closest_match_snippet(Some(path), &file_norm, old_str_with_trailing).unwrap();

        assert!(hint.contains("in scripts/test.md"));
        assert!(hint.contains("👉 Conflict found — adjust your old_string"));
        assert!(hint.contains(
            "Below is the discrepancy between your old_string and the actual file content:"
        ));
        assert!(hint.contains("Lines with '-' come from your old_string"));
        assert!(hint.contains("2 | line 2")); // 上下文行不带任何 - 或 +
        assert!(hint.contains("-    5 | ```}],path:"));
        assert!(hint.contains("+    5 | ```"));
        assert!(hint.contains("6 | line 7")); // 下文上下文行不带任何 - 或 +
    }

    #[test]
    fn test_scenario_3_low_similarity_clean_refusal() {
        let content = "function demo() {\n  const a = 1;\n  return a;\n}\n";
        let file_norm = NormalizedFile::new(content);

        // 相似度极低且其他文件无匹配
        let totally_unrelated =
            "struct SpaceRocketTrajectory {\n  velocity: f64,\n  orbit: f64,\n}";
        let hint = find_closest_match_snippet(None, &file_norm, totally_unrelated).unwrap();

        assert!(
            hint.contains("old_string not found in target file")
                && hint.contains("The target code block does not exist in this file")
                && !hint.contains("```diff"),
            "Expected clean refusal without misleading diff, got: {hint}"
        );
    }

    #[tokio::test]
    async fn test_multi_hunk_aggregated_error_reporting() {
        let d = tempfile::tempdir().unwrap();
        let file_path = d.path().join("code.rs");
        std::fs::write(&file_path, "fn a() { 1 }\nfn b() { 2 }\nfn c() { 3 }\n").unwrap();

        let r = EditFileTool
            .execute(
                &serde_json::json!({
                    "file_path": "code.rs",
                    "edits": [
                        { "old_string": "fn missing_1()", "new_string": "fn rep1()" },
                        { "old_string": "fn b() { 2 }", "new_string": "fn b() { 20 }" },
                        { "old_string": "fn missing_2()", "new_string": "fn rep2()" }
                    ]
                })
                .to_string(),
                &ctx(d.path()),
            )
            .await;

        assert!(r.is_error);
        assert!(
            r.content.contains("2 of 3 hunks failed verification"),
            "content: {}",
            r.content
        );
        assert!(
            r.content.contains("[Failure 1] Hunk 1/3"),
            "content: {}",
            r.content
        );
        assert!(
            r.content.contains("[Failure 2] Hunk 3/3"),
            "content: {}",
            r.content
        );
    }

    #[test]
    fn test_missing_lines_discrepancy_pinpointed() {
        let content = "function demo() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  return a + b + c;\n}\n";
        let file_norm = NormalizedFile::new(content);

        // 漏掉了 const b = 2;
        let old_str_missing_b =
            "function demo() {\n  const a = 1;\n  const c = 3;\n  return a + b + c;\n}";
        let hint = find_closest_match_snippet(None, &file_norm, old_str_missing_b).unwrap();

        assert!(hint.contains("👉 Conflict found"), "hint: {hint}");
        assert!(hint.contains("const b = 2;"), "hint: {hint}");
        assert!(
            hint.contains("```diff"),
            "hint should still retain expanded diff: {hint}"
        );
    }

    fn marked_lines(hint: &str, marker: char) -> Vec<(usize, String)> {
        hint.lines()
            .filter_map(|line| {
                let rest = line.strip_prefix(marker)?.strip_prefix(' ')?;
                let (no, text) = rest.split_once(" | ")?;
                Some((no.trim().parse().ok()?, text.to_string()))
            })
            .collect()
    }

    /// Both '-' and '+' numbers are physical file lines; '--' marks an old line
    /// with no counterpart (skipped by the parser). Neither side may repeat or
    /// regress, and the same visible line must never be marked as both removed
    /// and added (the old trailing-newline artifact).
    fn assert_diff_invariants(hint: &str) {
        let minus = marked_lines(hint, '-');
        let plus = marked_lines(hint, '+');
        for (name, lines) in [("-", &minus), ("+", &plus)] {
            let mut prev = 0;
            for (no, _) in lines {
                assert!(
                    *no > prev,
                    "{name} line numbers must be unique and ascending: {no}\n{hint}"
                );
                prev = *no;
            }
        }
        let minus_texts: std::collections::HashSet<&str> =
            minus.iter().map(|(_, text)| text.as_str()).collect();
        for (_, text) in &plus {
            assert!(
                !minus_texts.contains(text.as_str()),
                "the same line must never be marked as both '-' and '+': {text:?}\n{hint}"
            );
        }
    }

    #[test]
    fn multi_line_replace_keeps_block_together_and_never_reports_missing_lines() {
        let content = "function demo() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n  return a + b + c + d;\n}\n";
        let file_norm = NormalizedFile::new(content);
        // Two consecutive wrong lines + a trailing newline (the old phantom-
        // Replace trigger). The whole 2->2 block must stay one unit.
        let old = "function demo() {\n  const a = 1;\n  const wrongB = 20;\n  const wrongC = 30;\n  const d = 4;\n  return a + b + c + d;\n}\n";
        let hint = find_closest_match_snippet(None, &file_norm, old).unwrap();

        assert_diff_invariants(&hint);
        assert!(
            !hint.contains("<no corresponding line at this position>"),
            "a line that exists in the file must never be reported as missing: {hint}"
        );
        assert!(hint.contains("-    3 |   const wrongB = 20;"), "{hint}");
        assert!(hint.contains("-    4 |   const wrongC = 30;"), "{hint}");
        assert!(hint.contains("+    3 |   const b = 2;"), "{hint}");
        assert!(hint.contains("+    4 |   const c = 3;"), "{hint}");
        assert!(hint.contains("👉 Conflict found"), "{hint}");
    }

    #[test]
    fn multi_region_old_string_reports_real_conflicts_without_false_absence() {
        let content = "const k0 = 0;\n  'tokens.estBadge': '预估',\n  'tokens.estimatedCache': '预估缓存',\n  'tokens.hitBadge': '命中',\n  'tokens.inputLabel': '輸入',\n  'tokens.inputTooltip': '輸入 (history): {n}',\n  'tokens.loopHitLabel': '累計缓存',\n  'tokens.loopSavingsLabel': '累計节省',\n  'tokens.onlineCacheHit': '缓存',\nconst k9 = 9;\n";
        let file_norm = NormalizedFile::new(content);
        // 复现真实故障：把文件中相隔几行的 key 拼成一个 old_string。
        let old = "  'tokens.hitBadge': '命中',\n  'tokens.estBadge': '预设',\n  'tokens.loopHitLabel': '累計缓存',\n  'tokens.loopSavingsLabel': '累計节省',\n";
        let hint = find_closest_match_snippet(None, &file_norm, old).unwrap();

        assert_diff_invariants(&hint);
        assert!(
            !hint.contains("<no corresponding line at this position>"),
            "hitBadge/estBadge exist in the file; absence must not be fabricated: {hint}"
        );
        // Both conflict regions must be visible, not just the first one.
        assert!(hint.contains("estimatedCache"), "{hint}");
        assert!(hint.contains("inputLabel"), "{hint}");
        assert!(hint.contains("预设"), "{hint}");
        assert!(hint.contains("预估"), "{hint}");
        // The old line points at the real file line it conflicts with, not at
        // its own index inside old_string.
        assert!(hint.contains("👉 Conflict found"), "{hint}");
        assert!(
            hint.contains("-    2 |   'tokens.estBadge': '预设',"),
            "{hint}"
        );
    }

    #[test]
    fn long_multi_region_fixture_reports_every_conflict() {
        let mut lines = vec!["// long generated fixture".to_string()];
        for i in 0..40 {
            lines.push(format!("const filler_a{i} = {i};"));
        }
        lines.push("function alphaBlock() {".into());
        lines.push("  const alpha = 1;".into());
        lines.push("  const beta = 2;".into());
        lines.push("  const gamma = 3;".into());
        lines.push("  return alpha + beta + gamma;".into());
        lines.push("}".into());
        for i in 0..40 {
            lines.push(format!("const filler_b{i} = {i};"));
        }
        lines.push("function omegaBlock() {".into());
        lines.push("  const omega = 10;".into());
        lines.push("  const sigma = 20;".into());
        lines.push("  return omega + sigma;".into());
        lines.push("}".into());
        let content = lines.join("\n") + "\n";
        let file_norm = NormalizedFile::new(&content);

        let mut old_lines = vec!["function alphaBlock() {".to_string()];
        old_lines.push("  const alpha = 1;".into());
        old_lines.push("  const betaWrong = 2;".into());
        old_lines.push("  const gammaWrong = 3;".into());
        old_lines.push("  return alpha + beta + gamma;".into());
        old_lines.push("}".into());
        for i in 0..40 {
            old_lines.push(format!("const filler_b{i} = {i};"));
        }
        old_lines.push("function omegaBlock() {".into());
        old_lines.push("  const omega = 10;".into());
        old_lines.push("  const sigmaWrong = 20;".into());
        old_lines.push("  return omega + sigma;".into());
        old_lines.push("}".into());
        let old = old_lines.join("\n") + "\n";

        let hint = find_closest_match_snippet(None, &file_norm, &old).unwrap();
        assert_diff_invariants(&hint);
        assert!(
            !hint.contains("<no corresponding line at this position>"),
            "both wrong clusters exist in the file; no absence may be fabricated: {hint}"
        );
        // Each conflict cluster gets its own action hint + diff block.
        assert_eq!(hint.matches("👉 Conflict found").count(), 2, "{hint}");
        // Both clusters must be reported, not just the first one.
        assert!(
            hint.contains("betaWrong") && hint.contains("gammaWrong"),
            "{hint}"
        );
        assert!(hint.contains("sigmaWrong"), "{hint}");
        assert!(hint.contains("const beta = 2;"), "{hint}");
        assert!(hint.contains("const sigma = 20;"), "{hint}");
        // '-' lines use the same physical file numbers as '+' lines; the old
        // string's own line numbers (3/4/49) must never leak into the diff.
        assert!(hint.contains("-   44 |   const betaWrong = 2;"), "{hint}");
        assert!(hint.contains("-   45 |   const gammaWrong = 3;"), "{hint}");
        assert!(hint.contains("+   44 |   const beta = 2;"), "{hint}");
        assert!(hint.contains("+   45 |   const gamma = 3;"), "{hint}");
        assert!(hint.contains("-   90 |   const sigmaWrong = 20;"), "{hint}");
        assert!(hint.contains("+   90 |   const sigma = 20;"), "{hint}");
        assert!(!hint.contains("-    3 |   const betaWrong"), "{hint}");
        assert!(!hint.contains("-   49 |   const sigmaWrong"), "{hint}");
    }

    fn one_block_fixture(wrong: &[usize]) -> (String, String) {
        let mut lines = vec!["// header".to_string()];
        for i in 0..10 {
            lines.push(format!("const pre{i} = {i};"));
        }
        lines.push("function settings() {".into());
        for i in 0..30 {
            lines.push(format!("  const v{i} = {i};"));
        }
        lines.push("}".into());
        let content = lines.join("\n") + "\n";

        let mut old_lines = vec!["function settings() {".to_string()];
        for i in 0..30 {
            if wrong.contains(&i) {
                old_lines.push(format!("  const v{i}Wrong = {i};"));
            } else {
                old_lines.push(format!("  const v{i} = {i};"));
            }
        }
        old_lines.push("}".into());
        (content, old_lines.join("\n") + "\n")
    }

    #[test]
    fn one_block_with_sparse_mismatches_prints_multiple_hunks() {
        // One contiguous old_string, three wrong lines separated by 8 Equal
        // lines each (> 2*context), so each cluster must get its own
        // discrepancy + diff block.
        let (content, old) = one_block_fixture(&[3, 12, 21]);
        let file_norm = NormalizedFile::new(&content);
        let hint = find_closest_match_snippet(None, &file_norm, &old).unwrap();

        assert_diff_invariants(&hint);
        assert_eq!(hint.matches("👉 Conflict found").count(), 3, "{hint}");
        for (file_line, wrong, right) in [
            (16, "v3Wrong", "v3"),
            (25, "v12Wrong", "v12"),
            (34, "v21Wrong", "v21"),
        ] {
            assert!(
                hint.contains(&format!("-   {file_line} |   const {wrong} = ")),
                "{hint}"
            );
            assert!(
                hint.contains(&format!("+   {file_line} |   const {right} = ")),
                "{hint}"
            );
        }
        // old_string indices 5/14/23 must never appear as file lines.
        assert!(!hint.contains("-    5 |   const v3Wrong"), "{hint}");
        assert!(!hint.contains("-   14 |   const v12Wrong"), "{hint}");
        assert!(!hint.contains("-   23 |   const v21Wrong"), "{hint}");
        assert!(
            !hint.contains("<no corresponding line at this position>"),
            "{hint}"
        );
    }

    #[test]
    fn one_block_with_near_mismatches_merges_into_one_hunk() {
        // Two wrong lines separated by only 2 Equal lines (<= 2*context) stay
        // in one hunk, but both conflict runs are still printed.
        let (content, old) = one_block_fixture(&[3, 6]);
        let file_norm = NormalizedFile::new(&content);
        let hint = find_closest_match_snippet(None, &file_norm, &old).unwrap();

        assert_diff_invariants(&hint);
        assert_eq!(hint.matches("👉 Conflict found").count(), 1, "{hint}");
        assert!(hint.contains("-   16 |   const v3Wrong = 3;"), "{hint}");
        assert!(hint.contains("-   19 |   const v6Wrong = 6;"), "{hint}");
        assert!(hint.contains("+   16 |   const v3 = 3;"), "{hint}");
        assert!(hint.contains("+   19 |   const v6 = 6;"), "{hint}");
        // Exactly three context lines above the first change and below the last.
        assert!(hint.contains("   13 |   const v0 = 0;"), "{hint}");
        assert!(hint.contains("   22 |   const v9 = 9;"), "{hint}");
        assert!(!hint.contains("   12 | function settings()"), "{hint}");
        assert!(!hint.contains("   23 |   const v10 = 10;"), "{hint}");
    }

    #[test]
    fn hunk_merge_boundary_is_six_unchanged_lines() {
        // Gap of 6 untouched lines -> the +/- 3 context windows touch, so the
        // two conflicts merge into one hunk.
        let (content, old) = one_block_fixture(&[3, 10]);
        let file_norm = NormalizedFile::new(&content);
        let hint = find_closest_match_snippet(None, &file_norm, &old).unwrap();
        assert_diff_invariants(&hint);
        assert_eq!(hint.matches("👉 Conflict found").count(), 1, "{hint}");
        // v3 is line 16, v10 is line 23; merged context = 13..26.
        assert!(hint.contains("   13 |   const v0 = 0;"), "{hint}");
        assert!(hint.contains("   26 |   const v13 = 13;"), "{hint}");
        assert!(!hint.contains("   12 | function settings()"), "{hint}");
        assert!(!hint.contains("   27 |   const v14 = 14;"), "{hint}");
        assert!(hint.contains("-   16 |   const v3Wrong = 3;"), "{hint}");
        assert!(hint.contains("-   23 |   const v10Wrong = 10;"), "{hint}");

        // Gap of 7 untouched lines -> a one-line hole remains, so they split.
        let (content, old) = one_block_fixture(&[3, 11]);
        let file_norm = NormalizedFile::new(&content);
        let hint = find_closest_match_snippet(None, &file_norm, &old).unwrap();
        assert_diff_invariants(&hint);
        assert_eq!(hint.matches("👉 Conflict found").count(), 2, "{hint}");
        // Hunk 1 = 13..19, hunk 2 = 21..27; line 20 is the middle of the gap.
        assert!(hint.contains("   19 |   const v6 = 6;"), "{hint}");
        assert!(hint.contains("   21 |   const v8 = 8;"), "{hint}");
        assert!(!hint.contains("   20 |   const v7 = 7;"), "{hint}");
        assert!(hint.contains("   27 |   const v14 = 14;"), "{hint}");
    }

    /// Manual end-to-end smoke: node generates a long fixture and an
    /// old_string with multiple cross-region conflicts, then the real tool is
    /// invoked against it. Run with --ignored --nocapture and both env vars.
    #[tokio::test]
    #[ignore = "manual smoke: set JEIKCODE_EDIT_DIAG_FIXTURE / JEIKCODE_EDIT_DIAG_OLD"]
    async fn manual_node_fixture_multi_region_diagnostic() {
        let (Ok(fixture), Ok(old_path)) = (
            std::env::var("JEIKCODE_EDIT_DIAG_FIXTURE"),
            std::env::var("JEIKCODE_EDIT_DIAG_OLD"),
        ) else {
            eprintln!("skip: set JEIKCODE_EDIT_DIAG_FIXTURE and JEIKCODE_EDIT_DIAG_OLD");
            return;
        };
        let old = std::fs::read_to_string(&old_path).unwrap();
        let fixture_path = std::path::PathBuf::from(&fixture);
        let dir = fixture_path.parent().unwrap().to_path_buf();
        let name = fixture_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let args = serde_json::json!({
            "path": name,
            "edits": [{ "old_string": old, "new_string": "unused" }]
        })
        .to_string();
        let r = EditFileTool.execute(&args, &ctx(&dir)).await;
        assert!(
            r.is_error,
            "the deliberately wrong old_string must fail: {}",
            r.content
        );
        println!("{}", r.content);
        assert_diff_invariants(&r.content);
        let allow_extra = std::env::var("JEIKCODE_EDIT_DIAG_ALLOW_EXTRA")
            .map(|v| v == "1")
            .unwrap_or(false);
        if !allow_extra {
            assert!(
                !r.content
                    .contains("<no corresponding line at this position>"),
                "{}",
                r.content
            );
        }
        let expected_hunks: usize = std::env::var("JEIKCODE_EDIT_DIAG_EXPECT_HUNKS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1);
        assert_eq!(
            r.content.matches("👉 Conflict found").count(),
            expected_hunks,
            "{}",
            r.content
        );
    }

    #[test]
    fn test_token_bag_window_boundary_tie_break_avoids_bogus_discrepancy() {
        let content = "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport {\n  buildTurnNavItems,\n  buildTurnNavItemsFromOutline,\n  filterTurnNavItems,\n  resolveActiveTurnId,\n  truncateTurnNavLabel,\n  turnNavId,\n  turnNavScrollTop,\n} from './turnNav.ts';\n\ntest('turnNavId is stable', () => {});\n";
        let file_norm = NormalizedFile::new(content);

        // old_string 从 import { 开始，但多写了 compactTurnNavText
        let old_string = "import {\n  buildTurnNavItems,\n  buildTurnNavItemsFromOutline,\n  compactTurnNavText,\n  filterTurnNavItems,\n  resolveActiveTurnId,\n  truncateTurnNavLabel,\n  turnNavId,\n  turnNavScrollTop,\n} from './turnNav.ts';";
        let hint = find_closest_match_snippet(None, &file_norm, old_string).unwrap();

        // 核心验证：必须准确定位到真正冲突的 compactTurnNavText 所在行（第 6 行），
        // 绝不能因为平局先到先得误将第 2 行的 import assert 当作 expected: "" 误报！
        assert!(hint.contains("compactTurnNavText"), "hint: {hint}");
        assert!(
            !hint.contains("import assert"),
            "hint should not claim line 2 import assert is mismatched: {hint}"
        );
        assert!(
            hint.contains("-   -- |   compactTurnNavText,"),
            "the extra old line must be visible in the diff: {hint}"
        );
        assert!(hint.contains("👉 Conflict found"), "hint: {hint}");
    }

    #[tokio::test]
    async fn test_topological_disambiguation_resolves_duplicate_hunks() {
        let d = tempfile::tempdir().unwrap();
        let file_path = d.path().join("code.rs");
        std::fs::write(
            &file_path,
            "fn head() { 0 }\nmatch output { Ok(()) => () }\nmatch output { Ok(()) => () }\nfn tail() { 9 }\n",
        )
        .unwrap();

        let r = EditFileTool
            .execute(
                &serde_json::json!({
                    "file_path": "code.rs",
                    "edits": [
                        { "old_string": "fn head() { 0 }", "new_string": "fn head() { 100 }" },
                        { "old_string": "match output { Ok(()) => () }", "new_string": "match output { Ok(()) => 1 }" },
                        { "old_string": "match output { Ok(()) => () }", "new_string": "match output { Ok(()) => 2 }" },
                        { "old_string": "fn tail() { 9 }", "new_string": "fn tail() { 900 }" }
                    ]
                })
                .to_string(),
                &ctx(d.path()),
            )
            .await;

        assert!(!r.is_error, "disambiguation should succeed: {}", r.content);
        let updated = std::fs::read_to_string(&file_path).unwrap();
        assert!(updated.contains("fn head() { 100 }"));
        assert!(updated.contains("match output { Ok(()) => 1 }"));
        assert!(updated.contains("match output { Ok(()) => 2 }"));
        assert!(updated.contains("fn tail() { 900 }"));
    }

    #[tokio::test]
    async fn test_cascading_overlap_conflict_diagnostics() {
        let d = tempfile::tempdir().unwrap();
        let file_path = d.path().join("code.rs");
        let initial = [
            "fn run() {",
            "    init_stage();",
            "    process_data();",
            "    cleanup();",
            "}",
            "",
        ]
        .join("\n");
        std::fs::write(&file_path, &initial).unwrap();

        // Both Hunk 1 and Hunk 2 write to line 3 (process_data)
        // Hunk 1 writes handle_alpha()
        // Hunk 2 writes handle_beta()
        // This is a TRUE write-write conflict that cannot be resolved by reordering
        let r = EditFileTool
            .execute(
                &serde_json::json!({
                    "file_path": "code.rs",
                    "edits": [
                        {
                            "old_string": "    init_stage();\n    process_data();",
                            "new_string": "    init_stage();\n    handle_alpha();"
                        },
                        {
                            "old_string": "    process_data();\n    cleanup();",
                            "new_string": "    handle_beta();\n    cleanup();"
                        }
                    ]
                })
                .to_string(),
                &ctx(d.path()),
            )
            .await;

        assert!(
            r.is_error,
            "cascading overlap must be rejected: {}",
            r.content
        );
        assert!(r
            .content
            .contains("⚠️ Cascading Overlap Conflict (Hunk 2 ➔ Hunk 1)"));
        assert!(r.content.contains("Hunk 1 (edits[0]) targets code in lines 2-3 that was just modified or removed by Hunk 2 (edits[1])"));
        assert!(r.content.contains("Overlap Site:"));
        assert!(r.content.contains("Intersection lines"));

        // File must stay 100% untouched on disk
        let on_disk = std::fs::read_to_string(&file_path).unwrap();
        assert_eq!(on_disk, initial);
    }
}
