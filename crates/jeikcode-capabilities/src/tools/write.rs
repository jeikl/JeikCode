//! `write` — create or overwrite a file (auto-creating parent dirs). Mutates
//! the filesystem ⇒ always `Risky`. Neutral core ported from the production writer,
//! minus the coding enrichments (file_history backup, file_store/read_cache
//! invalidation, LSP notify).

use super::{err, ok, resolve_path};
use crate::tool_feedback::parse_tool_args;
use async_trait::async_trait;
use jeikcode_kernel::tool::{RiskLevel, Tool, ToolContext, ToolResult};
use serde::Deserialize;
use serde_json::json;

pub struct WriteFileTool;

#[derive(Deserialize)]
struct Args {
    #[serde(alias = "file_path")]
    path: String,
    content: String,
}

#[async_trait]
impl Tool for WriteFileTool {
    fn name(&self) -> &str {
        "write"
    }
    fn aliases(&self) -> &'static [&'static str] {
        &["write_file", "create_file"]
    }
    fn description(&self) -> &str {
        "Write content to a file. Creates file and parent directories if absent, or overwrites existing file content."
    }
    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path to write (relative or absolute). Parent directories are created automatically if absent." },
                "content": { "type": "string", "description": "Content to write." }
            },
            "required": ["path", "content"]
        })
    }
    fn risk(&self, _args: &str) -> RiskLevel {
        RiskLevel::Risky // creates / overwrites files
    }
    fn always_grant_scope(&self, _args: &str) -> String {
        // Tool-wide: "总是 / Always" approves every write this session (v1 parity).
        String::new()
    }
    async fn execute(&self, args: &str, ctx: &ToolContext) -> ToolResult {
        let a: Args =
            match parse_tool_args("write", args, r#"{"path":"<path>","content":"<text>"}"#)
                .or_else(|_| {
                    parse_tool_args(
                        "write_file",
                        args,
                        r#"{"path":"<path>","content":"<text>"}"#,
                    )
                })
                .or_else(|_| {
                    parse_tool_args(
                        "create_file",
                        args,
                        r#"{"path":"<path>","content":"<text>"}"#,
                    )
                }) {
                Ok(a) => a,
                Err(e) => return e.into_tool_result(),
            };
        let path = resolve_path(&a.path, &ctx.working_dir);
        let disp = crate::pathnorm::to_display(&path);

        // Acquire the normalized path write lock shared with `EditFileTool` so
        // concurrent subagents or scheduled tasks editing/writing the same file serialize cleanly.
        let lock_key = super::edit::lock_key_for_write_path(path.clone()).await;
        let _lock = match super::edit::acquire_edit_lock(&lock_key, &ctx.cancel).await {
            Ok(guard) => guard,
            Err(e) => return err(e),
        };

        // State machine check: if file exists, enforce read confirmation in current turn
        if tokio::fs::try_exists(&path).await.unwrap_or(false)
            && crate::tools::write_state::check_write_permitted(&path)
                == crate::tools::write_state::WritePermission::RefusedUnread
        {
            let refusal_msg =
                crate::tools::write_state::build_unread_refusal_message(&path, &disp).await;
            return err(refusal_msg);
        }

        // Capture pre-existing content and line count for an overwrite diff message.
        let old_content = tokio::fs::read_to_string(&path).await.ok();
        let old_lines = old_content.as_ref().map(|s| s.lines().count());

        if let Some(parent) = path.parent() {
            if let Err(e) = tokio::fs::create_dir_all(parent).await {
                return err(format!(
                    "write: failed to create parent directory {}: {e}",
                    crate::pathnorm::to_display(parent)
                ));
            }
        }
        let new_lines = a.content.lines().count();
        let bytes = a.content.len();
        if let Err(e) = tokio::fs::write(&path, &a.content).await {
            return err(format!("write: failed to write {disp}: {e}"));
        }

        crate::tools::write_state::record_write_success(&path);

        #[cfg(feature = "codeintel")]
        crate::codeintel::notify_code_index_file_changed(&path, Some(&a.content));

        let msg = match old_lines {
            Some(old) => {
                let diff_count = new_lines as i64 - old as i64;
                let sign = if diff_count >= 0 { "+" } else { "" };
                let mut m = format!(
                    "Overwrote {disp} (was {old} lines, now {new_lines} lines, {sign}{diff_count})"
                );
                // Warn on a large shrink — the model may have dropped content.
                if old > 20 && new_lines < old / 2 {
                    m.push_str(&format!(
                        "\n⚠ WARNING: file shrank by {}%. Verify no important content was lost.",
                        100 - (new_lines * 100 / old)
                    ));
                }
                if let Some(old_text) = old_content.as_deref() {
                    let diff = super::edit::build_compact_diff(old_text, &a.content, Some(&path));
                    if !diff.is_empty() {
                        m.push('\n');
                        m.push_str(&diff);
                    }
                }
                m
            }
            None => format!("Created {disp} ({bytes} bytes, {new_lines} lines)"),
        };
        ok(msg)
    }
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

    #[tokio::test]
    async fn creates_new_file_and_parents() {
        let d = tempfile::tempdir().unwrap();
        let r = WriteFileTool
            .execute(
                r#"{"file_path":"nested/dir/a.txt","content":"hello\nworld\n"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("Created"), "{}", r.content);
        let on_disk = std::fs::read_to_string(d.path().join("nested/dir/a.txt")).unwrap();
        assert_eq!(on_disk, "hello\nworld\n");
    }

    #[tokio::test]
    async fn overwrite_reports_line_diff() {
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("a.txt");
        std::fs::write(&target, "1\n2\n3\n").unwrap();
        crate::tools::write_state::advance_turn_for_dir(d.path());
        crate::tools::write_state::record_read(&target);
        let r = WriteFileTool
            .execute(
                r#"{"file_path":"a.txt","content":"1\n2\n3\n4\n5\n"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(r.content.contains("Overwrote"), "{}", r.content);
        assert!(
            r.content.contains("was 3 lines, now 5 lines, +2"),
            "{}",
            r.content
        );
        assert!(
            r.content.contains("--- a/"),
            "output should retain unified diff for presentation: {}",
            r.content
        );
        assert!(
            r.content.contains("+++ b/"),
            "output should retain unified diff for presentation: {}",
            r.content
        );
        let model_view = crate::provider::strip_tool_result_diff_for_model(&r.content);
        assert!(
            !model_view.contains("--- a/"),
            "model view must strip diff: {model_view}"
        );
        assert!(
            model_view.contains("was 3 lines, now 5 lines, +2"),
            "model view must retain concise summary: {model_view}"
        );
    }

    #[tokio::test]
    async fn large_shrink_warns() {
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("a.txt");
        let big: String = (0..100).map(|i| format!("line {i}\n")).collect();
        std::fs::write(&target, big).unwrap();
        crate::tools::write_state::advance_turn_for_dir(d.path());
        crate::tools::write_state::record_read(&target);
        let r = WriteFileTool
            .execute(
                r#"{"file_path":"a.txt","content":"tiny\n"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(r.content.contains("WARNING: file shrank"), "{}", r.content);
    }

    #[tokio::test]
    async fn write_is_risky() {
        assert_eq!(WriteFileTool.risk("{}"), RiskLevel::Risky);
    }

    // =========================================================================
    // Write State Machine Tests
    // =========================================================================

    #[tokio::test]
    async fn test_unread_existing_file_is_intercepted_with_1500_lines_content() {
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("unread.txt");
        std::fs::write(&target, "line 1\nline 2\nline 3\n").unwrap();

        // Advance turn for this workspace directory to ensure fresh unread state
        crate::tools::write_state::advance_turn_for_dir(d.path());

        let r = WriteFileTool
            .execute(
                r#"{"file_path":"unread.txt","content":"overwritten"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            r.is_error,
            "writing to unread existing file must be intercepted"
        );
        assert!(
            r.content
                .contains("Write Intercepted: File Unread Confirmation Required"),
            "{}",
            r.content
        );
        assert!(
            r.content
                .contains("Please verify the existing content before writing"),
            "{}",
            r.content
        );
        assert!(r.content.contains("1→line 1"), "{}", r.content);
        assert!(r.content.contains("line 2"), "{}", r.content);
        assert!(r.content.contains("complete content"), "{}", r.content);

        // Verify disk content was untouched
        let disk = std::fs::read_to_string(&target).unwrap();
        assert_eq!(disk, "line 1\nline 2\nline 3\n");

        // Because full content was returned, state is now marked as read.
        // A second write in the same turn should succeed directly!
        let r2 = WriteFileTool
            .execute(
                r#"{"file_path":"unread.txt","content":"overwritten directly\n"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            !r2.is_error,
            "subsequent write in same turn must succeed: {}",
            r2.content
        );
        let disk2 = std::fs::read_to_string(&target).unwrap();
        assert_eq!(disk2, "overwritten directly\n");
    }

    #[tokio::test]
    async fn test_unread_existing_file_truncated_when_over_1500_lines() {
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("huge.txt");
        let content: String = (1..=1600).map(|i| format!("content line {i}\n")).collect();
        std::fs::write(&target, content).unwrap();

        crate::tools::write_state::advance_turn_for_dir(d.path());

        let r = WriteFileTool
            .execute(
                r#"{"file_path":"huge.txt","content":"new content"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            r.is_error,
            "writing to unread huge file must be intercepted"
        );
        assert!(
            r.content
                .contains("[Showing lines 1-1500 of 1600. 100 lines remaining.]"),
            "{}",
            r.content
        );
        assert!(
            r.content.contains("Please read the complete file (using `read` with offset=1501, limit=1500) before writing."),
            "{}",
            r.content
        );

        // Because the file was truncated (not full content), it should NOT be marked as read yet.
        // A second write without reading the remainder must still be intercepted.
        let r2 = WriteFileTool
            .execute(
                r#"{"file_path":"huge.txt","content":"still not permitted"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            r2.is_error,
            "must still be intercepted because file was truncated"
        );
    }

    #[tokio::test]
    async fn test_read_file_then_write_file_succeeds() {
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("flow.txt");
        std::fs::write(&target, "initial content\n").unwrap();

        crate::tools::write_state::advance_turn_for_dir(d.path());

        // 1. Read file first
        let read_res = crate::tools::read::ReadFileTool::default()
            .execute(r#"{"file_path":"flow.txt"}"#, &ctx(d.path()))
            .await;
        assert!(!read_res.is_error, "{}", read_res.content);

        // 2. Write file
        let write_res = WriteFileTool
            .execute(
                r#"{"file_path":"flow.txt","content":"modified content\n"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            !write_res.is_error,
            "write after read must succeed: {}",
            write_res.content
        );

        let disk = std::fs::read_to_string(&target).unwrap();
        assert_eq!(disk, "modified content\n");
    }

    #[tokio::test]
    async fn test_multi_write_in_same_turn_persists() {
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("multi.txt");
        std::fs::write(&target, "start\n").unwrap();

        crate::tools::write_state::advance_turn_for_dir(d.path());

        // Read once
        crate::tools::write_state::record_read(&target);

        // 1st write
        let r1 = WriteFileTool
            .execute(
                r#"{"file_path":"multi.txt","content":"v1\n"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r1.is_error, "1st write must succeed: {}", r1.content);

        // 2nd write without re-reading (same turn persists)
        let r2 = WriteFileTool
            .execute(
                r#"{"file_path":"multi.txt","content":"v2\n"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            !r2.is_error,
            "2nd write in same turn must succeed: {}",
            r2.content
        );

        let disk = std::fs::read_to_string(&target).unwrap();
        assert_eq!(disk, "v2\n");
    }

    #[tokio::test]
    async fn test_next_turn_resets_read_status_to_zero() {
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("turn_reset.txt");
        std::fs::write(&target, "base\n").unwrap();

        crate::tools::write_state::advance_turn_for_dir(d.path());

        // Turn 1: Read + Write succeeds
        crate::tools::write_state::record_read(&target);
        let r1 = WriteFileTool
            .execute(
                r#"{"file_path":"turn_reset.txt","content":"turn1\n"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r1.is_error, "Turn 1 write must succeed: {}", r1.content);

        // Advance to Turn 2
        crate::tools::write_state::advance_turn_for_dir(d.path());

        // Turn 2: Attempt write without read -> must be intercepted!
        let r2 = WriteFileTool
            .execute(
                r#"{"file_path":"turn_reset.txt","content":"turn2\n"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            r2.is_error,
            "Turn 2 write without read must be intercepted: {}",
            r2.content
        );
        assert!(r2
            .content
            .contains("Write Intercepted: File Unread Confirmation Required"));

        // Turn 2: Read then write -> succeeds!
        crate::tools::write_state::record_read(&target);
        let r3 = WriteFileTool
            .execute(
                r#"{"file_path":"turn_reset.txt","content":"turn2_ok\n"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            !r3.is_error,
            "Turn 2 write after read must succeed: {}",
            r3.content
        );
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "turn2_ok\n");
    }

    #[tokio::test]
    async fn test_edit_between_read_and_write_resets_read_confirmation() {
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("interleaved.txt");
        std::fs::write(&target, "content\n").unwrap();

        crate::tools::write_state::advance_turn_for_dir(d.path());

        // Read file
        crate::tools::write_state::record_read(&target);
        // An edit occurs before write
        crate::tools::write_state::record_edit(&target);

        // Attempt write: last_op was Edit, not Read -> must be intercepted
        let r = WriteFileTool
            .execute(
                r#"{"file_path":"interleaved.txt","content":"new\n"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(r.is_error, "write after edit must be intercepted");
        assert!(r
            .content
            .contains("Write Intercepted: File Unread Confirmation Required"));

        // Read again, then write -> succeeds
        crate::tools::write_state::record_read(&target);
        let r2 = WriteFileTool
            .execute(
                r#"{"file_path":"interleaved.txt","content":"new\n"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r2.is_error, "{}", r2.content);
    }

    #[tokio::test]
    async fn create_file_alias_creates_new_file() {
        let d = tempfile::tempdir().unwrap();
        let tool = WriteFileTool;
        assert!(tool.aliases().contains(&"create_file"));
        let r = tool
            .execute(
                r#"{"path":"created.txt","content":"hello from create_file\n"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        let on_disk = std::fs::read_to_string(d.path().join("created.txt")).unwrap();
        assert_eq!(on_disk, "hello from create_file\n");
    }

    #[tokio::test]
    async fn test_intercept_full_content_survives_across_turn_start_grace() {
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("intercept_retry.txt");
        std::fs::write(&target, "existing line 1\nexisting line 2\n").unwrap();

        // Turn 1: Force fresh turn
        crate::tools::write_state::advance_turn_for_dir(d.path());

        // Turn 1: Attempt write -> must be intercepted and return full content
        let r1 = WriteFileTool
            .execute(
                r#"{"path":"intercept_retry.txt","content":"new content v1\n"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(r1.is_error, "Turn 1 must be intercepted: {}", r1.content);
        assert!(r1.content.contains("existing line 1"));
        assert!(r1.content.contains("complete content"));

        // Simulate Turn 2 start via actual LifecycleHooks (turn counter increments)
        let hook = crate::tools::write_state::WriteStateHook::with_dir(d.path());
        let mut convo = jeikcode_kernel::message::Conversation::new();
        jeikcode_kernel::hook::LifecycleHooks::turn_start(&hook, &mut convo).await;

        // Turn 2: Retried write must succeed across the turn boundary!
        let r2 = WriteFileTool
            .execute(
                r#"{"path":"intercept_retry.txt","content":"new content v1\n"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            !r2.is_error,
            "Turn 2 retry write must succeed via grace period: {}",
            r2.content
        );
        let on_disk = std::fs::read_to_string(&target).unwrap();
        assert_eq!(on_disk, "new content v1\n");

        // Simulate Turn 3 start (after successful write, grace is consumed)
        jeikcode_kernel::hook::LifecycleHooks::turn_start(&hook, &mut convo).await;

        // Turn 3: Attempt write without read must be intercepted again!
        let r3 = WriteFileTool
            .execute(
                r#"{"path":"intercept_retry.txt","content":"blind overwrite\n"}"#,
                &ctx(d.path()),
            )
            .await;
        assert!(
            r3.is_error,
            "Turn 3 blind write must be intercepted again: {}",
            r3.content
        );
    }

    #[tokio::test]
    async fn write_and_edit_share_normalized_per_file_lock() {
        let d = tempfile::tempdir().unwrap();
        let existing = d.path().join("shared.txt");
        std::fs::write(&existing, "initial\n").unwrap();

        let key_via_dot =
            crate::tools::edit::lock_key_for_write_path(d.path().join(".").join("shared.txt"))
                .await;
        let key_direct = crate::tools::edit::lock_key_for_write_path(existing.clone()).await;
        assert_eq!(key_via_dot, key_direct);

        let brand_new = d.path().join("nested").join("new_file.txt");
        let brand_new_dot = d
            .path()
            .join(".")
            .join("nested")
            .join("..")
            .join("nested")
            .join("new_file.txt");
        let new_k1 = crate::tools::edit::lock_key_for_write_path(brand_new).await;
        let new_k2 = crate::tools::edit::lock_key_for_write_path(brand_new_dot).await;
        assert_eq!(new_k1, new_k2);

        let cancel = CancellationToken::new();
        let guard = crate::tools::edit::acquire_edit_lock(&key_direct, &cancel)
            .await
            .expect("first lock acquisition must succeed");
        let blocked = tokio::time::timeout(
            std::time::Duration::from_millis(60),
            crate::tools::edit::acquire_edit_lock(&key_via_dot, &cancel),
        )
        .await;
        assert!(
            blocked.is_err(),
            "concurrent write/edit on normalized identical path must wait while guard is held"
        );
        drop(guard);
        let acquired = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            crate::tools::edit::acquire_edit_lock(&key_via_dot, &cancel),
        )
        .await
        .expect("lock must become available once previous holder drops")
        .expect("lock reacquisition should succeed");
        drop(acquired);
    }
}
