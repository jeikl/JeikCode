//! `SkillCatalogHook` — injects the `=== AVAILABLE SKILLS ===` catalog as an
//! independent System block (Block 3, order 30) at session start.
//!
//! Why this exists: the v2 coding path registered the `use_skill` / `list_skills`
//! tools but NEVER told the model which skills are installed — so a skill that
//! should trigger on a description match (brainstorming before creative work, …)
//! was effectively invisible and "basically never fired". The catalog is what the
//! daemon path already injected inline; this hook brings the coding path to parity
//! (via the budget-gated, source-ranked [`super::render`]).
//!
//! Identified by [`super::render::CATALOG_HEADER`] so `--resume` reconciles it
//! in place; lands as an independent System block (Block 3) after CodeTools (25)
//! and before MCP (40) / Baseline (60).
//!
//! HOT-RELOAD: refreshed on BOTH `session_start` AND `turn_start` (mirroring
//! [`super::super::mcp`]-side `McpInstructionsHook`), so a capability reload that
//! rebuilds this hook from a fresh registry — e.g. disabling/enabling a skill —
//! lands in the VERY NEXT prompt instead of waiting for a new session. A
//! `last_block` memo skips a no-op rewrite when the catalog is byte-identical,
//! so an unchanged catalog leaves the prefix cache untouched.

use super::render::CATALOG_HEADER;
use async_trait::async_trait;
use jeikcode_kernel::hook::LifecycleHooks;
use jeikcode_kernel::message::Conversation;
use std::sync::Mutex;

/// Injects the pre-rendered skill catalog. `None` catalog (no skills installed) →
/// the hook is a no-op on a fresh session and prunes a stale block on resume.
pub struct SkillCatalogHook {
    catalog: Option<String>,
    /// Last reconciled catalog. `turn_start` early-returns when unchanged so the
    /// prefix cache stays byte-stable (same memo pattern as `McpInstructionsHook`).
    last_block: Mutex<Option<Option<String>>>,
}

impl SkillCatalogHook {
    /// Build from a rendered catalog (see [`super::SkillRegistry::render_catalog`]).
    pub fn new(catalog: Option<String>) -> Self {
        Self {
            catalog,
            last_block: Mutex::new(None),
        }
    }

    /// Reconcile the catalog block in place. No-op when the catalog is unchanged.
    fn refresh_in_place(&self, convo: &mut Conversation) {
        {
            let mut last = self.last_block.lock().unwrap_or_else(|error| error.into_inner());
            if last.as_ref() == Some(&self.catalog) {
                return;
            }
            *last = Some(self.catalog.clone());
        }
        // Clean up any legacy system block if resuming from older versions
        convo.reconcile_system_block(CATALOG_HEADER, None);
        convo.reconcile_system_block("=== AVAILABLE SKILLS ===", None);
        convo.reconcile_system_block("=== AVAILABLE SKILLS (*.md) ===", None);
        // Reconcile as ordered frozen synthetic user block (Block 3)
        convo.reconcile_frozen_user_block(CATALOG_HEADER, self.catalog.clone());
    }
}

#[async_trait]
impl LifecycleHooks for SkillCatalogHook {
    async fn session_start(&self, convo: &mut Conversation, _resumed: bool) {
        self.refresh_in_place(convo);
    }

    /// Hot refresh: a capability reload rebuilds this hook from a fresh registry,
    /// so the next turn's `turn_start` swaps the catalog in place immediately.
    async fn turn_start(&self, convo: &mut Conversation) {
        self.refresh_in_place(convo);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jeikcode_kernel::message::{Message, Role};

    fn convo_with_persona() -> Conversation {
        let mut c = Conversation::default();
        c.push(Message::system("PERSONA"));
        c.push(Message::user("hi"));
        c
    }

    #[tokio::test]
    async fn fresh_inserts_after_leading_system_run() {
        let hook = SkillCatalogHook::new(Some(format!(
            "{CATALOG_HEADER}\n- x: y\n</available_skills>"
        )));
        let mut c = convo_with_persona();
        hook.session_start(&mut c, false).await;
        assert_eq!(c.messages[0].text, "PERSONA");
        assert_eq!(c.messages[1].role, Role::User);
        assert!(c.messages[1].synthetic);
        assert!(
            c.messages[1].text.starts_with(CATALOG_HEADER),
            "catalog as synthetic user block after persona"
        );
        assert_eq!(
            c.messages[2].role,
            Role::User,
            "before the real user message"
        );
        assert!(!c.messages[2].synthetic);
        assert_eq!(c.sacred_floor(), 3);
    }

    #[tokio::test]
    async fn none_catalog_is_noop_on_fresh() {
        let hook = SkillCatalogHook::new(None);
        let mut c = convo_with_persona();
        let before = c.messages.len();
        hook.session_start(&mut c, false).await;
        assert_eq!(c.messages.len(), before, "no skills → nothing injected");
    }

    #[tokio::test]
    async fn resume_refreshes_in_place_no_growth() {
        let hook = SkillCatalogHook::new(Some(format!(
            "{CATALOG_HEADER}\n- fresh: v\n</available_skills>"
        )));
        let mut c = Conversation::default();
        c.push(Message::system("PERSONA"));
        c.push(Message::synthetic_user(format!(
            "{CATALOG_HEADER}\n- stale: old\n</available_skills>"
        )));
        c.push(Message::user("hi"));
        hook.session_start(&mut c, true).await;
        assert_eq!(c.messages.len(), 3, "reconciled in place, no growth");
        assert_eq!(c.messages[1].role, Role::User);
        assert!(c.messages[1].synthetic);
        assert!(c.messages[1].text.contains("- fresh: v"));
        assert!(!c.messages[1].text.contains("stale"));
    }

    #[tokio::test]
    async fn resume_prunes_stale_when_no_skills_left() {
        let hook = SkillCatalogHook::new(None);
        let mut c = Conversation::default();
        c.push(Message::system("PERSONA"));
        c.push(Message::synthetic_user(format!(
            "{CATALOG_HEADER}\n- gone: x\n</available_skills>"
        )));
        c.push(Message::user("hi"));
        hook.session_start(&mut c, true).await;
        assert_eq!(c.messages.len(), 2, "stale block pruned");
        assert_eq!(c.messages[0].text, "PERSONA");
        assert_eq!(c.messages[1].text, "hi");
        assert!(c
            .messages
            .iter()
            .all(|m| !m.text.starts_with(CATALOG_HEADER)));
    }

    /// A capability reload rebuilds this hook from a fresh registry; its `turn_start`
    /// must swap the catalog in place on the VERY NEXT turn (hot reload), no growth.
    #[tokio::test]
    async fn turn_start_hot_refreshes_catalog_after_reload() {
        let first = SkillCatalogHook::new(Some(format!(
            "{CATALOG_HEADER}\n- a: 1\n</available_skills>"
        )));
        let mut c = convo_with_persona();
        first.session_start(&mut c, false).await;
        assert!(c.messages.iter().any(|m| m.text.contains("- a: 1")));

        // Reload: a fresh hook now carries the reduced catalog (skill `a` disabled).
        let reloaded = SkillCatalogHook::new(Some(format!(
            "{CATALOG_HEADER}\n- b: 2\n</available_skills>"
        )));
        let before = c.messages.len();
        reloaded.turn_start(&mut c).await;
        assert_eq!(c.messages.len(), before, "in place, no growth");
        assert!(c.messages.iter().any(|m| m.text.contains("- b: 2")));
        assert!(
            !c.messages.iter().any(|m| m.text.contains("- a: 1")),
            "disabled skill dropped from the catalog"
        );

        // Disabling every skill prunes the block entirely on the next turn.
        let empty = SkillCatalogHook::new(None);
        empty.turn_start(&mut c).await;
        assert!(c
            .messages
            .iter()
            .all(|m| !m.text.starts_with(CATALOG_HEADER)));
    }

    /// An unchanged catalog must NOT rewrite the block (prefix-cache stability).
    #[tokio::test]
    async fn turn_start_is_a_noop_when_catalog_unchanged() {
        let hook = SkillCatalogHook::new(Some(format!(
            "{CATALOG_HEADER}\n- a: 1\n</available_skills>"
        )));
        let mut c = convo_with_persona();
        hook.session_start(&mut c, false).await;
        let snapshot: Vec<String> = c.messages.iter().map(|m| m.text.clone()).collect();
        hook.turn_start(&mut c).await;
        let after: Vec<String> = c.messages.iter().map(|m| m.text.clone()).collect();
        assert_eq!(snapshot, after, "unchanged catalog leaves bytes identical");
    }
}
