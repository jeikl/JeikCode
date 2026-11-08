//! Skills capability (L1): a `*/SKILL.md` loader + the `use_skill` tool. A *skill* is a
//! reusable instruction guide (Claude-Code / Agent-Skills compatible). Its body is
//! returned verbatim — user-invoked command templates (`commands/*.md`) own
//! `$ARGUMENTS` / `$N` / shell expansion (see `crate::commands::template`).
//!
//! NEUTRAL boundary: this crate loads skills from directories the CALLER supplies; the
//! standard `~/.claude/skills` etc. precedence is a driver concern (use
//! [`standard_skill_dirs`] or pass your own). Skill CONTENT is user-authored and trusted.
//!
//! Behind the opt-in `skills` cargo feature (no extra dependencies).

use jeikcode_kernel::tool::{ToolRegistry, ToolResult};
use std::sync::Arc;

pub mod catalog_hook;
pub mod controls;
pub mod registry;
pub mod render;
pub mod skill;
pub mod use_skill;

pub use catalog_hook::SkillCatalogHook;
pub use registry::{runtime_skill_dirs, standard_skill_dirs, SkillRegistry};
pub use render::{render_skill_catalog, CatalogEntry};
pub use skill::Skill;
pub use use_skill::UseSkillTool;

/// Names of the skill tools — pass to [`ToolRegistry::mount`](jeikcode_kernel::tool::ToolRegistry::mount).
pub fn skill_tool_names() -> &'static [&'static str] {
    &["use_skill"]
}

/// Register skill tools over a (caller-built) [`SkillRegistry`].
pub fn register_skill_tools(reg: &mut ToolRegistry, registry: Arc<SkillRegistry>) {
    reg.register(Arc::new(UseSkillTool::new(registry)));
}

pub(crate) fn ok(content: impl Into<String>) -> ToolResult {
    ToolResult {
        call_id: String::new(),
        content: content.into(),
        is_error: false,
        images: vec![],
    }
}
pub(crate) fn err(content: impl Into<String>) -> ToolResult {
    ToolResult {
        call_id: String::new(),
        content: content.into(),
        is_error: true,
        images: vec![],
    }
}
