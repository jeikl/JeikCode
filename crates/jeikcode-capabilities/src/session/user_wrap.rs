//! `UserWrapHook` — applies template wrapping to the user's latest query using `user-wrap.md`.
//!
//! # Purpose
//! Allows users or projects to define custom wrapper formatting (e.g. prompt structuring,
//! safety disclaimers, or project-specific query wrapping) around the user's raw input:
//!
//! ```markdown
//! 用户提问：【{{input}}】
//! 请你根据用户的信息，不能回答政治相关的问题。
//! ```
//!
//! # Resolution Hierarchy (Precedence)
//! 1. Project-level: `<working_dir>/.jeikcode/user-wrap.md`
//! 2. Project-level: `<working_dir>/user-wrap.md`
//! 3. Global-level: `~/.jeikcode/user-wrap.md` (or `$JEIKCODE_HOME/user-wrap.md`)
//!
//! If a project-level file exists, it overrides the global configuration completely.
//!
//! # Execution Guarantees
//! - **Last Real User Message Only**: Only executes when a user query is submitted (`user_prompt_submit`).
//! - **Prefix Stability**: Does not alter system messages, synthetic context, memory, skills, or tool outputs.
//! - **Hot Reload**: mtime + length cached; an edit on disk is picked up on the
//!   next `user_prompt_submit` without restart.

use async_trait::async_trait;
use jeikcode_kernel::hook::LifecycleHooks;
use std::path::{Path, PathBuf};

/// Hook that wraps the user's latest prompt using `user-wrap.md`.
#[derive(Clone, Debug)]
pub struct UserWrapHook {
    working_dir: PathBuf,
}

impl UserWrapHook {
    pub fn new(working_dir: impl Into<PathBuf>) -> Self {
        Self {
            working_dir: working_dir.into(),
        }
    }

    /// Resolve the active `user-wrap.md` path according to precedence rules.
    pub fn resolve_wrap_file(&self) -> Option<PathBuf> {
        Self::resolve_wrap_file_for(&self.working_dir)
    }

    /// Resolve the active `user-wrap.md` path for a given working directory.
    pub fn resolve_wrap_file_for(working_dir: &Path) -> Option<PathBuf> {
        // 1. Project-level: <working_dir>/.jeikcode/user-wrap.md (or legacy .jeikcode)
        let p1_jeik = working_dir.join(".jeikcode").join("user-wrap.md");
        if p1_jeik.is_file() {
            return Some(p1_jeik);
        }
        let p1_legacy = working_dir.join(".atomcode").join("user-wrap.md");
        if p1_legacy.is_file() {
            return Some(p1_legacy);
        }

        // 2. Project-level: <working_dir>/user-wrap.md
        let p2 = working_dir.join("user-wrap.md");
        if p2.is_file() {
            return Some(p2);
        }

        // 3. Global-level: ~/.jeikcode/user-wrap.md or ~/.jeikcode/user-wrap.md
        let global = crate::session::config_dir().join("user-wrap.md");
        if global.is_file() {
            return Some(global);
        }

        None
    }

    /// Wrap the given user input text using the template from `user-wrap.md`.
    pub fn wrap_input(&self, input: &str) -> String {
        let Some(path) = self.resolve_wrap_file() else {
            return input.to_string();
        };

        let Some(content) = crate::session::mtime_file::read_trimmed_cached(&path) else {
            return input.to_string();
        };

        apply_wrap_template(&content, input)
    }

    /// Extract the raw user input from a potentially wrapped message text
    /// using the active `user-wrap.md` template for display purposes (UI/TUI/WebUI).
    pub fn unwrap_input(&self, wrapped: &str) -> String {
        Self::unwrap_input_for(&self.working_dir, wrapped)
    }

    /// Extract the raw user input from a potentially wrapped message text
    /// for a given working directory.
    pub fn unwrap_input_for(working_dir: &Path, wrapped: &str) -> String {
        // StatusReminderHook appends the live date to the bottom of the real user
        // block for model-facing role integrity. Strip that internal suffix before
        // restoring history, titles, or UI text.
        let wrapped = strip_date_reminder_suffix(wrapped);
        let Some(path) = Self::resolve_wrap_file_for(working_dir) else {
            return wrapped.to_string();
        };

        let Some(content) = crate::session::mtime_file::read_trimmed_cached(&path) else {
            return wrapped.to_string();
        };

        let template = content.as_str();
        if template.is_empty() || template == "{{input}}" {
            return wrapped.to_string();
        }

        if let Some((prefix, suffix)) = template.split_once("{{input}}") {
            let mut text = wrapped;
            if !prefix.is_empty() {
                if let Some(rest) = text.strip_prefix(prefix) {
                    text = rest;
                } else if let Some(rest) = text.strip_prefix(prefix.trim_end()) {
                    text = rest;
                } else if let Some(rest) = text.strip_prefix(prefix.trim()) {
                    text = rest;
                } else {
                    return wrapped.to_string();
                }
            }
            if !suffix.is_empty() {
                if let Some(rest) = text.strip_suffix(suffix) {
                    text = rest;
                } else if let Some(rest) = text.strip_suffix(suffix.trim_start()) {
                    text = rest;
                } else if let Some(rest) = text.strip_suffix(suffix.trim()) {
                    text = rest;
                } else {
                    return wrapped.to_string();
                }
            }
            text.to_string()
        } else {
            let prefix = format!("{template}\n\n");
            if let Some(rest) = wrapped.strip_prefix(&prefix) {
                rest.to_string()
            } else if let Some(rest) = wrapped.strip_prefix(template) {
                rest.trim_start().to_string()
            } else {
                wrapped.to_string()
            }
        }
    }
}

fn apply_wrap_template(template: &str, input: &str) -> String {
    if template.is_empty() {
        return input.to_string();
    }
    if template.contains("{{input}}") {
        template.replace("{{input}}", input)
    } else {
        format!("{template}\n\n{input}")
    }
}

fn strip_date_reminder_suffix(text: &str) -> &str {
    const MARKER: &str = "\n\n<system-reminder>\nCurrent date:";
    let trimmed = text.trim_end();
    let Some(start) = trimmed.rfind(MARKER) else {
        return text;
    };
    if trimmed[start + 2..].ends_with("</system-reminder>") {
        &trimmed[..start]
    } else {
        text
    }
}

#[async_trait]
impl LifecycleHooks for UserWrapHook {
    async fn user_prompt_submit(&self, text: &mut String) -> Result<(), String> {
        let wrapped = self.wrap_input(text);
        *text = wrapped;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_wrap_input_no_file() {
        let temp = TempDir::new().unwrap();
        let hook = UserWrapHook::new(temp.path());
        assert_eq!(hook.wrap_input("hello world"), "hello world");
        assert_eq!(hook.unwrap_input("hello world"), "hello world");
    }

    #[test]
    fn test_wrap_and_unwrap_input_with_template() {
        let temp = TempDir::new().unwrap();
        let wrap_file = temp.path().join("user-wrap.md");
        std::fs::write(&wrap_file, "用户提问：【{{input}}】\n请严格遵守规则。").unwrap();

        let hook = UserWrapHook::new(temp.path());
        let wrapped = hook.wrap_input("你好");
        assert_eq!(wrapped, "用户提问：【你好】\n请严格遵守规则。");

        let unwrapped = hook.unwrap_input(&wrapped);
        assert_eq!(unwrapped, "你好");
    }

    #[test]
    fn test_wrap_input_project_jeikcode_dir_precedence() {
        let temp = TempDir::new().unwrap();
        let jeikcode_dir = temp.path().join(".jeikcode");
        std::fs::create_dir_all(&jeikcode_dir).unwrap();

        let p1 = jeikcode_dir.join("user-wrap.md");
        std::fs::write(&p1, "Project JeikCode: {{input}}").unwrap();

        let p2 = temp.path().join("user-wrap.md");
        std::fs::write(&p2, "Project Root: {{input}}").unwrap();

        let hook = UserWrapHook::new(temp.path());
        assert_eq!(hook.wrap_input("test"), "Project JeikCode: test");
        assert_eq!(hook.unwrap_input("Project JeikCode: test"), "test");
    }

    #[test]
    fn test_wrap_input_without_placeholder_appends() {
        let temp = TempDir::new().unwrap();
        let wrap_file = temp.path().join("user-wrap.md");
        std::fs::write(&wrap_file, "PREFIX HEADER").unwrap();

        let hook = UserWrapHook::new(temp.path());
        let wrapped = hook.wrap_input("query");
        assert_eq!(wrapped, "PREFIX HEADER\n\nquery");
        assert_eq!(hook.unwrap_input(&wrapped), "query");
    }

    #[tokio::test]
    async fn test_user_prompt_submit_lifecycle() {
        let temp = TempDir::new().unwrap();
        let wrap_file = temp.path().join("user-wrap.md");
        std::fs::write(&wrap_file, "Wrapped: [{{input}}]").unwrap();

        let hook = UserWrapHook::new(temp.path());
        let mut text = "original".to_string();
        hook.user_prompt_submit(&mut text).await.unwrap();
        assert_eq!(text, "Wrapped: [original]");
        assert_eq!(hook.unwrap_input(&text), "original");
    }

    #[test]
    fn unwrap_strips_appended_date_reminder() {
        let temp = TempDir::new().unwrap();
        let hook = UserWrapHook::new(temp.path());
        let stored =
            "original\n\n<system-reminder>\nCurrent date: 2026-08-27 (Thu)\n</system-reminder>";
        assert_eq!(hook.unwrap_input(stored), "original");
    }

    #[test]
    fn unwrap_strips_date_and_long_bash_list_in_the_same_reminder() {
        let temp = TempDir::new().unwrap();
        let hook = UserWrapHook::new(temp.path());
        let stored = "你好\n\n<system-reminder>\nCurrent date: 2026-09-01 (Tue)\n\
暂存长bash列表：ninja（如果长bash运行效果不达预期，可通过 long_bash_keyword_actions action=delete 取消）\n\
</system-reminder>";
        assert_eq!(hook.unwrap_input(stored), "你好");
    }

    #[test]
    fn wrap_hot_reloads_when_the_file_changes() {
        crate::session::mtime_file::clear_cache_for_tests();
        let temp = TempDir::new().unwrap();
        let wrap_file = temp.path().join("user-wrap.md");
        std::fs::write(&wrap_file, "V1: {{input}}").unwrap();
        let hook = UserWrapHook::new(temp.path());
        assert_eq!(hook.wrap_input("hi"), "V1: hi");
        std::fs::write(&wrap_file, "V2: {{input}}").unwrap();
        assert_eq!(hook.wrap_input("hi"), "V2: hi");
    }
}
