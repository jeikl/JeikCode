//! Two-block instruction loader — the v2 port of v1 `config/instructions.rs`.
//!
//! - **GLOBAL tier** (`~/.jeikcode/AGENTS.md` → `~/.jeikcode/JEIKCODE.md`) renders as an
//!   independent `<user_preferences>` block (cross-project personal preferences).
//! - **PROJECT tier** (`AGENTS.md` / `.jeikcode.md` / `JEIKCODE.md` / `CLAUDE.md` /
//!   `claude.md`, first match wins) plus the additive knowledge packs renders as an
//!   independent `<project_instructions>` block.
//!
//! Both blocks are pure (paths in, string out) so they are testable without touching the
//! real home dir; [`SessionContextHook`] supplies the config-root and project paths and
//! reconciles each block separately. The legacy `.jeikcode.user.md` tier was removed.
//!
//! Also loads optional **additive knowledge packs** (coexist with AGENTS.md):
//! - domain glossary — business term → code aliases
//! - business rules — org structure, domain rules, process
//! - db words — common tables / columns / schema nicknames
//!
//! All packs are full-file, hot-reloaded each user turn via [`SessionContextHook`]
//! (mtime + length cache: unchanged files skip `read_to_string`).
//!
//! [`SessionContextHook`]: super::context::SessionContextHook

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use jeikcode_config::config::instructions::{GLOBAL_INSTRUCTION_FILES, PROJECT_INSTRUCTION_FILES};

// Project-tier file-name precedence lives in `jeikcode-config` (`PROJECT_INSTRUCTION_FILES`)
// as the SINGLE source of truth, shared with the `/status` display loader so the two tables
// can never drift apart again.

/// Header for the GLOBAL tier block: cross-project user preferences.
pub const USER_PREFERENCES_HEADER: &str = "<user_preferences>";

/// Header for the PROJECT tier block: project instructions + additive knowledge packs.
pub const INSTRUCTIONS_HEADER: &str = "<project_instructions>";

/// The PROJECT-tier-only tail (the knowledge packs live in this block): the code-review stance
/// plus the pack semantics. Deliberately NOT emitted in `<user_preferences>`, so the two
/// blocks never repeat this paragraph.
const PROJECT_PREAMBLE_EXTRA: &str = "\
When reviewing code or advising other developers, apply only the PROJECT rules and conventions — never surface or enforce the user's personal preferences. DOMAIN GLOSSARY / BUSINESS RULES / DB WORDS (if present) are project knowledge packs: use them for term expansion, policy, and schema mapping; they do not override safety gates.";

/// Additive knowledge pack: first existing path wins per pack; packs do not replace each other.
struct KnowledgePack {
    /// Header label shown to the model, e.g. `DOMAIN GLOSSARY`.
    header: &'static str,
    /// Short usage hint prepended before the file body.
    hint: &'static str,
    /// Candidate paths relative to project root (first existing file wins).
    candidates: &'static [&'static str],
}

const KNOWLEDGE_PACKS: &[KnowledgePack] = &[
    KnowledgePack {
        header: "DOMAIN GLOSSARY",
        hint: "\
Use this glossary when the user speaks in business terms: expand each term into the \
listed code aliases, then search those aliases (and the original term) in parallel. \
Prefer code_explore once you have an exact type/method name from the glossary.",
        candidates: &[
            ".jeikcode/glossary.md",
            ".jeikcode/domain-glossary.md",
            "docs/domain-glossary.md",
            "docs/glossary.md",
            "domain-glossary.md",
            "DOMAIN.md",
        ],
    },
    KnowledgePack {
        header: "BUSINESS RULES",
        hint: "\
Domain / org / process rules for this product (organization structure, approval flows, \
business constraints). Treat as authoritative project knowledge when implementing or \
explaining features. Prefer these over guessing product policy.",
        candidates: &[
            ".jeikcode/rules.md",
            ".jeikcode/business-rules.md",
            "docs/rules.md",
            "docs/business-rules.md",
            "rules.md",
        ],
    },
    KnowledgePack {
        header: "DB WORDS",
        hint: "\
Common database tables, columns, and nicknames. Use when the user mentions data entities \
or when writing SQL / ORM / migrations: map spoken names to real table/column identifiers \
before searching code or inventing schema.",
        candidates: &[
            ".jeikcode/dbwords.md",
            ".jeikcode/db-words.md",
            ".jeikcode/schema.md",
            "docs/dbwords.md",
            "docs/db-words.md",
            "dbwords.md",
        ],
    },
];

/// Render the GLOBAL tier (`~/.jeikcode/AGENTS.md` → `~/.jeikcode/JEIKCODE.md`) as an
/// independent `<user_preferences>` block. `None` when no non-empty global file exists.
///
/// `home` = config root (`~/.jeikcode`).
pub fn render_user_preferences(home: &Path) -> Option<String> {
    // Prefer AGENTS.md (open standard); fall back to the JeikCode-native name. The order
    // comes from `jeikcode-config` (single source of truth), shared with the display loader.
    let fallback = home.join(GLOBAL_INSTRUCTION_FILES[GLOBAL_INSTRUCTION_FILES.len() - 1]);
    let global = first_existing(home, &GLOBAL_INSTRUCTION_FILES).unwrap_or(fallback);
    let body = read_tier(&global)?;
    let filename = global
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("JEIKCODE.md");
    Some(format!(
        "{USER_PREFERENCES_HEADER}\n\n# USER PREFERENCES ({filename})\n{body}\n</user_preferences>"
    ))
}

/// Render the PROJECT tier (first existing AGENTS.md / .jeikcode.md / JEIKCODE.md /
/// CLAUDE.md / claude.md) plus the additive knowledge packs as an independent
/// `<project_instructions>` block. `None` when no project tier file and no pack exists.
///
/// `project` = workspace root.
pub fn render_project_instructions(project: &Path) -> Option<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(proj) = project_file(project) {
        if let Some(body) = read_tier(&proj) {
            let filename = proj
                .file_name()
                .and_then(|f| f.to_str())
                .unwrap_or("AGENTS.md");
            out.push(format!("# PROJECT INSTRUCTIONS ({filename})\n{body}"));
        }
    }
    for pack in KNOWLEDGE_PACKS {
        if let Some(path) = first_existing(project, pack.candidates) {
            if let Some(body) = read_tier(&path) {
                let filename = path
                    .file_name()
                    .and_then(|f| f.to_str())
                    .unwrap_or("knowledge.md");
                out.push(format!(
                    "# {} ({filename})\n{}\n\n{body}",
                    pack.header, pack.hint
                ));
            }
        }
    }
    if out.is_empty() {
        return None;
    }
    Some(format!(
        "{INSTRUCTIONS_HEADER}\n\n{PROJECT_PREAMBLE_EXTRA}\n\n{}\n</project_instructions>",
        out.join("\n\n")
    ))
}

/// The removed legacy `.jeikcode.user.md` tier. Detected once per process so we can tell the
/// user their personal per-project preferences are silently no longer injected.
const LEGACY_USER_TIER_FILE: &str = ".jeikcode.user.md";
static LEGACY_USER_TIER_WARNED: OnceLock<()> = OnceLock::new();

/// Emit a ONE-TIME migration notice when a legacy `.jeikcode.user.md` is present but no
/// longer honored (the tier was removed). Hot-reload calls this every turn, so the
/// `OnceLock` guard keeps it to a single log line per process. No-op when the file is absent.
pub fn warn_legacy_user_tier_once(project: &Path) {
    if !project.join(LEGACY_USER_TIER_FILE).is_file() {
        return;
    }
    if LEGACY_USER_TIER_WARNED.set(()).is_ok() {
        tracing::warn!(
            "[instructions] `{}` is no longer an instruction tier and is being IGNORED. \
             Migrate its personal preferences into `~/.jeikcode/AGENTS.md` (cross-project) or \
             the project `AGENTS.md` (team-shared).",
            project.join(LEGACY_USER_TIER_FILE).display()
        );
    }
}

/// The first existing project-tier file (precedence order), if any.
fn project_file(project: &Path) -> Option<PathBuf> {
    first_existing(project, &PROJECT_INSTRUCTION_FILES)
}

fn first_existing(project: &Path, names: &[&str]) -> Option<PathBuf> {
    names.iter().map(|n| project.join(n)).find(|p| p.is_file())
}

/// Read a tier file → its trimmed body, or `None` if missing/non-file/empty.
/// No size cap: product policy is full-file hot-reload of instruction/knowledge packs.
/// Unchanged mtime+length reuse the last body so `turn_start` does not re-read.
fn read_tier(path: &Path) -> Option<String> {
    super::mtime_file::read_trimmed_cached(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn empty_dir_produces_nothing() {
        let d = tempfile::tempdir().unwrap();
        let proj = d.path();
        assert!(render_user_preferences(&d.path().join("nohome")).is_none());
        assert!(render_project_instructions(proj).is_none());
    }

    #[test]
    fn global_tier_renders_as_user_preferences_block() {
        let d = tempfile::tempdir().unwrap();
        let home = d.path().join("home");
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("AGENTS.md"), "global habits").unwrap();
        let block = render_user_preferences(&home).expect("global block");
        assert!(block.starts_with(USER_PREFERENCES_HEADER));
        assert!(block.ends_with("</user_preferences>"));
        assert!(block.contains("# USER PREFERENCES (AGENTS.md)"));
        assert!(block.contains("global habits"));
        // The precedence policy lives in the sys-1 prompt; this block must not duplicate it.
        assert!(!block.contains("Non-conflicting rule sets"));
        assert!(!block.contains("PROJECT instructions >> user preferences"));
        // A global-only block never leaks the project tier or its pack semantics.
        assert!(!block.contains("# PROJECT INSTRUCTIONS"));
        assert!(!block.contains("DOMAIN GLOSSARY"));
    }

    #[test]
    fn global_tier_falls_back_to_jeikcode_md() {
        let d = tempfile::tempdir().unwrap();
        let home = d.path().join("home");
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("JEIKCODE.md"), "jeikcode global").unwrap();
        let block = render_user_preferences(&home).expect("global block");
        assert!(block.contains("# USER PREFERENCES (JEIKCODE.md)"));
        assert!(block.contains("jeikcode global"));
    }

    #[test]
    fn project_tier_picks_first_existing_name() {
        let d = tempfile::tempdir().unwrap();
        let proj = d.path();
        // AGENTS.md and CLAUDE.md both exist → AGENTS.md (earlier in precedence) wins.
        fs::write(proj.join("AGENTS.md"), "agents rules").unwrap();
        fs::write(proj.join("CLAUDE.md"), "claude rules").unwrap();
        let out = render_project_instructions(proj).expect("project block");
        assert!(out.starts_with(INSTRUCTIONS_HEADER));
        assert!(out.ends_with("</project_instructions>"));
        assert!(out.contains("# PROJECT INSTRUCTIONS (AGENTS.md)"));
        assert!(out.contains("agents rules"));
        assert!(!out.contains("claude rules"), "first-precedence file wins");
        assert!(!out.contains("Non-conflicting rule sets"));
        assert!(out.contains("never surface or enforce the user's personal preferences"));
        assert!(out.contains("DOMAIN GLOSSARY"));
    }

    #[test]
    fn legacy_user_tier_warns_once_without_panicking() {
        let d = tempfile::tempdir().unwrap();
        // Side-effect-free when absent, and idempotent (global OnceLock) when present.
        warn_legacy_user_tier_once(d.path());
        fs::write(d.path().join(".jeikcode.user.md"), "legacy prefs").unwrap();
        warn_legacy_user_tier_once(d.path());
        warn_legacy_user_tier_once(d.path());
        assert!(d.path().join(".jeikcode.user.md").is_file());
    }

    #[test]
    fn user_tier_is_removed() {
        // `.jeikcode.user.md` is no longer an injection tier — it must be ignored entirely.
        let d = tempfile::tempdir().unwrap();
        let proj = d.path();
        fs::write(proj.join(".jeikcode.user.md"), "should be ignored").unwrap();
        assert!(
            render_project_instructions(proj).is_none(),
            "removed user tier must not render a project block"
        );
        assert!(render_user_preferences(&d.path().join("nohome")).is_none());
    }

    #[test]
    fn missing_and_empty_are_skipped() {
        let d = tempfile::tempdir().unwrap();
        let proj = d.path();
        fs::write(proj.join("AGENTS.md"), "   \n  ").unwrap();
        assert!(render_project_instructions(proj).is_none());
    }

    #[test]
    fn large_file_is_not_truncated() {
        let d = tempfile::tempdir().unwrap();
        let proj = d.path();
        let big = format!("prefix-{}-suffix", "x".repeat(1_100_000));
        fs::write(proj.join("AGENTS.md"), &big).unwrap();
        let out = render_project_instructions(proj).expect("block");
        assert!(!out.contains("[truncated:"));
        assert!(out.contains("prefix-") && out.contains("-suffix"));
        assert!(out.len() > 1_100_000);
    }

    #[test]
    fn domain_glossary_is_additive_with_agents_md() {
        let d = tempfile::tempdir().unwrap();
        let proj = d.path();
        fs::create_dir_all(proj.join(".jeikcode")).unwrap();
        fs::write(proj.join("AGENTS.md"), "build with cargo").unwrap();
        fs::write(
            proj.join(".jeikcode/glossary.md"),
            "- 优惠券 → Coupon, PromoCode, Voucher\n- 结算 → Checkout, Settlement\n",
        )
        .unwrap();
        let out = render_project_instructions(proj).expect("block");
        assert!(out.contains("build with cargo"));
        assert!(out.contains("DOMAIN GLOSSARY") && out.contains("优惠券"));
        assert!(out.contains("expand each term into the listed code aliases"));
        fs::write(proj.join("DOMAIN.md"), "should not win").unwrap();
        let out2 = render_project_instructions(proj).unwrap();
        assert!(!out2.contains("should not win"));
    }

    #[test]
    fn domain_glossary_falls_back_to_docs_path() {
        let d = tempfile::tempdir().unwrap();
        let proj = d.path();
        fs::create_dir_all(proj.join("docs")).unwrap();
        fs::write(
            proj.join("docs/domain-glossary.md"),
            "invoice → Fapiao, InvoiceService\n",
        )
        .unwrap();
        let out = render_project_instructions(proj).expect("block");
        assert!(out.contains("DOMAIN GLOSSARY"));
        assert!(out.contains("InvoiceService"));
    }

    #[test]
    fn rules_and_dbwords_are_additive() {
        let d = tempfile::tempdir().unwrap();
        let proj = d.path();
        fs::create_dir_all(proj.join(".jeikcode")).unwrap();
        fs::write(proj.join("AGENTS.md"), "use cargo").unwrap();
        fs::write(
            proj.join(".jeikcode/rules.md"),
            "## 组织架构\n- 中台 / 交易中心 / 营销中心\n",
        )
        .unwrap();
        fs::write(
            proj.join(".jeikcode/dbwords.md"),
            "| 业务 | 表名 |\n| 优惠券 | t_coupon |\n",
        )
        .unwrap();
        let out = render_project_instructions(proj).expect("block");
        assert!(out.contains("use cargo"));
        assert!(
            out.contains("BUSINESS RULES") && out.contains("组织架构") && out.contains("营销中心"),
            "rules.md injected: {out}"
        );
        assert!(
            out.contains("DB WORDS") && out.contains("t_coupon"),
            "dbwords.md injected: {out}"
        );
        assert!(out.contains("organization structure") || out.contains("org"));
        assert!(out.contains("database tables") || out.contains("schema"));
    }

    #[test]
    fn rules_prefers_jeikcode_dir_over_root() {
        let d = tempfile::tempdir().unwrap();
        let proj = d.path();
        fs::create_dir_all(proj.join(".jeikcode")).unwrap();
        fs::write(proj.join(".jeikcode/rules.md"), "nested-rules").unwrap();
        fs::write(proj.join("rules.md"), "root-rules-should-lose").unwrap();
        let out = render_project_instructions(proj).expect("block");
        assert!(out.contains("nested-rules"));
        assert!(!out.contains("root-rules-should-lose"));
    }

    #[test]
    fn agents_md_wins_over_jeikcode_md() {
        let d = tempfile::tempdir().unwrap();
        let proj = d.path();
        fs::write(proj.join("AGENTS.md"), "agents first").unwrap();
        fs::write(proj.join(".jeikcode.md"), "jeikcode second").unwrap();
        let out = render_project_instructions(proj).expect("block");
        assert!(out.contains("agents first"));
        assert!(!out.contains("jeikcode second"));
        assert!(out.starts_with(INSTRUCTIONS_HEADER));
    }

    #[test]
    fn mtime_cache_returns_same_body_until_the_file_changes() {
        super::super::mtime_file::clear_cache_for_tests();
        let d = tempfile::tempdir().unwrap();
        let proj = d.path();
        fs::write(proj.join("AGENTS.md"), "cached-body-v1").unwrap();
        let first = render_project_instructions(proj).expect("block");
        let second = render_project_instructions(proj).expect("block");
        assert_eq!(first, second);
        assert!(first.contains("cached-body-v1"));
        fs::write(proj.join("AGENTS.md"), "cached-body-v2-hot").unwrap();
        let third = render_project_instructions(proj).expect("block");
        assert!(third.contains("cached-body-v2-hot"));
        assert!(!third.contains("cached-body-v1"));
    }
}
