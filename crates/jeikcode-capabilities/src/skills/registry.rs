//! Discover + index skills from a set of directories. Neutral: the caller supplies the
//! directories (the standard `~/.claude/skills` etc. precedence is a driver concern —
//! see [`standard_skill_dirs`]). Ported from production `skill.rs` `SkillRegistry`.

use super::skill::{is_skill_md_name, parse_skill_dir, Skill};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Skills indexed by name. `BTreeMap` for deterministic (sorted) order — the skill list
/// is injected into the system prompt, so a stable order keeps the prompt prefix
/// byte-identical (prompt-prefix caching), same rationale as the kernel ToolRegistry.
pub struct SkillRegistry {
    skills: BTreeMap<String, Arc<Skill>>,
}

impl SkillRegistry {
    pub fn new() -> Self {
        Self {
            skills: BTreeMap::new(),
        }
    }

    /// Load from `dirs` in LOW→HIGH priority order (a later dir's same-named skill wins).
    /// Each dir is scanned for `*/SKILL.md` subdirectories (case-insensitive); parse
    /// failures are skipped. Flat `*.md` files are commands, not skills.
    pub fn load(dirs: &[PathBuf]) -> Self {
        let mut reg = Self::new();
        for dir in dirs {
            reg.load_dir(dir, None);
        }
        reg
    }

    /// Load one directory, optionally namespacing the skill names (`{ns}:{name}`).
    pub fn load_dir(&mut self, dir: &Path, namespace: Option<&str>) {
        self.scan_skill_dir(dir, namespace, 0);
    }

    /// Scan `dir` for skills, recursing into grouping subdirectories. A subdir holding
    /// `SKILL.md` / `skill.md` (any ASCII case) is a skill (NOT descended into — its own
    /// files are skill resources); a subdir without one is a grouping directory whose
    /// nested skills are discovered recursively, so `skills/GROUP/SUB/SKILL.md` is still
    /// found. Flat `*.md` files are never skills — user-invocable commands live in
    /// `crate::commands`. `depth` is bounded to guard against symlink cycles.
    fn scan_skill_dir(&mut self, dir: &Path, namespace: Option<&str>, depth: usize) {
        const MAX_DEPTH: usize = 8;
        if depth > MAX_DEPTH {
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
        entries.sort();
        for p in entries {
            if p.is_dir() {
                self.load_child(&p, namespace, depth + 1);
            }
        }
    }

    /// Read `dir` once: a skill entry file makes it a skill; otherwise it is a
    /// grouping directory whose nested skill dirs are scanned recursively.
    fn load_child(&mut self, dir: &Path, namespace: Option<&str>, depth: usize) {
        const MAX_DEPTH: usize = 8;
        if depth > MAX_DEPTH {
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
        entries.sort();
        if let Some(skill_md) = find_skill_md(&entries) {
            if let Ok(s) = parse_skill_dir(dir, &skill_md, namespace) {
                self.skills.insert(s.name.clone(), Arc::new(s));
            }
            return;
        }
        for p in entries {
            if p.is_dir() {
                self.load_child(&p, namespace, depth + 1);
            }
        }
    }

    /// Resolve a skill by its registry key, falling back to bare-name lookup.
    ///
    /// File skills are keyed by their namespaced identity
    /// (`skills:jeikcode-smoke-test`), but the `$` trigger and the `/skills`
    /// sub-menu display and submit the *unqualified* name for skills whose
    /// bare name is unique (see `build_skill_menu_items`). Without this
    /// fallback, `get("jeikcode-smoke-test")` misses the `skills:`-prefixed
    /// key — so every user invocation of a file skill either errors with a
    /// bogus "unknown skill" (menu path) or is silently sent to the model as
    /// plain `$name` text (typed path). The model path is unaffected because
    /// the injected catalog carries the fully-qualified name.
    ///
    /// A bare name that maps to more than one namespace is disambiguated the
    /// way the menu is: `build_skill_menu_items` lists only user-invocable
    /// skills and shows the bare name when it is unique among THEM, so a lone
    /// user-invocable match wins even if a hidden (`user-invocable: false`)
    /// skill shares the bare name. Only a genuinely ambiguous bare name — zero
    /// or several user-invocable matches — returns `None`; the menu shows the
    /// qualified form there, which resolves via the exact-match branch.
    pub fn get(&self, name: &str) -> Option<Arc<Skill>> {
        if let Some(skill) = self.skills.get(name) {
            return Some(skill.clone());
        }
        if name.contains(':') {
            return None;
        }
        let suffix = format!(":{}", name.to_ascii_lowercase());
        let mut n_all = 0usize;
        let mut last_all: Option<&Arc<Skill>> = None;
        let mut n_invocable = 0usize;
        let mut last_invocable: Option<&Arc<Skill>> = None;
        for skill in self.skills.values() {
            if skill.name.ends_with(&suffix) {
                n_all += 1;
                last_all = Some(skill);
                if skill.user_invocable {
                    n_invocable += 1;
                    last_invocable = Some(skill);
                }
            }
        }
        if n_all == 1 {
            return last_all.cloned();
        }
        // Multiple namespaces share this bare name: resolve to the sole
        // user-invocable one (mirrors the menu). Zero or several ⇒ ambiguous.
        if n_invocable == 1 {
            return last_invocable.cloned();
        }
        None
    }
    pub fn len(&self) -> usize {
        self.skills.len()
    }
    pub fn is_empty(&self) -> bool {
        self.skills.is_empty()
    }
    /// `(name, description)` for every skill, sorted by name.
    pub fn list(&self) -> Vec<(String, String)> {
        self.skills
            .values()
            .map(|s| (s.name.clone(), s.description.clone()))
            .collect()
    }

    /// Clear and reload from the standard home+project skill dirs (the `/skills`
    /// slash-menu source), under the `skills:` namespace — matching the driver's
    /// slash-command convention. Mirrors core `SkillRegistry::reload`.
    ///
    /// Returns per-skill load warnings for signature compatibility with core's
    /// `reload` (driver call sites surface them). Currently always empty: this loader
    /// silently skips unparseable skills — the SAME behavior the runtime skill path
    /// uses — so no parse warnings are collected.
    pub fn reload(&mut self, working_dir: &Path) -> Vec<String> {
        self.skills.clear();
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        for dir in runtime_skill_dirs(&home, working_dir) {
            self.load_dir(&dir, Some("skills"));
        }
        Vec::new()
    }

    /// Skills a user can invoke from the `/` menu (frontmatter `user-invocable` not
    /// `false`), sorted by name.
    pub fn user_invocable(&self) -> impl Iterator<Item = &Skill> {
        self.skills
            .values()
            .map(|s| s.as_ref())
            .filter(|s| s.user_invocable)
    }

    /// Insert a skill programmatically (same-name replaces). Mirrors core
    /// `SkillRegistry::register`; used by drivers injecting non-file skills and by tests.
    pub fn register(&mut self, skill: Skill) {
        self.skills.insert(skill.name.clone(), Arc::new(skill));
    }

    /// Every loaded skill, sorted by name.
    pub fn all(&self) -> impl Iterator<Item = &Skill> {
        self.skills.values().map(|s| s.as_ref())
    }

    /// Drop every skill whose registry name is listed in `disabled`. Used by the
    /// runtime and the `/skills` + capability endpoints to honor the persisted
    /// GLOBAL/PROJECT disable state ([`super::controls`]).
    /// Matches both bare names ("foo") and namespaced IDs ("skills:foo").
    pub fn retain_enabled(&mut self, disabled: &std::collections::BTreeSet<String>) {
        if disabled.is_empty() {
            return;
        }
        self.skills
            .retain(|name, _| !super::controls::is_skill_disabled(disabled, name));
    }

    /// Render the `=== AVAILABLE SKILLS ===` frozen user-prefix section (budget-gated,
    /// source-ranked), or `None` when no skills are installed. See
    /// [`super::render`].
    pub fn render_catalog(&self) -> Option<String> {
        let entries: Vec<super::render::CatalogEntry> = self
            .skills
            .values()
            .map(|s| super::render::CatalogEntry {
                name: s.name.clone(),
                hint: None, // capabilities skills carry no argument hint
                description: s.description.clone(),
                source_rank: super::render::source_rank(&s.source_path),
            })
            .collect();
        super::render::render_skill_catalog(&entries)
    }
}

impl Default for SkillRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Locate the skill entry file in `dir`, case-insensitively. Prefers the canonical
/// uppercase spelling when a case-sensitive filesystem holds both variants.
fn find_skill_md(entries: &[PathBuf]) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = entries
        .iter()
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(is_skill_md_name)
        })
        .cloned()
        .collect();
    candidates.sort();
    candidates
        .iter()
        .find(|p| p.file_name().and_then(|n| n.to_str()) == Some("SKILL.md"))
        .cloned()
        .or_else(|| candidates.into_iter().next())
}

/// The standard skill directories (LOW→HIGH priority), Claude-Code-compatible. A driver
/// may pass this to [`SkillRegistry::load`] or supply its own. `home` = user home dir;
/// `project` = the workspace root. `commands/*.md` are deliberately absent — they are
/// user-invoked command templates, not model-visible skills.
pub fn standard_skill_dirs(home: &Path, project: &Path) -> Vec<PathBuf> {
    vec![
        home.join(".claude/skills"),
        // Cross-agent shared conventions (`.agents/skills`, opencode et al.).
        // Placed before `.jeikcode` so jeikcode-native skills win a same-name collision.
        home.join(".agents/skills"),
        home.join(".skills"),
        home.join(".jeikcode/skills"),
        project.join(".claude/skills"),
        project.join(".agents/skills"),
        project.join(".skills"),
        project.join("skills"),
        project.join(".jeikcode/skills"),
    ]
}

/// The standard skill directories with the user-level `.jeikcode` root resolved
/// from `JEIKCODE_HOME` when it is set. `JEIKCODE_HOME` is the config root (the
/// equivalent of `~/.jeikcode`), so every user-level `~/.jeikcode/skills` entry is
/// rebased onto it; other products' dirs (`.claude`, `.agents`) and all
/// project-relative dirs stay put. An empty `JEIKCODE_HOME` is
/// treated as unset — mirroring [`jeikcode_config`]'s `Config::config_dir` — so a
/// stray `JEIKCODE_HOME=` never rebases skills onto a bogus relative `skills` path.
pub fn runtime_skill_dirs(home: &Path, project: &Path) -> Vec<PathBuf> {
    let dirs = standard_skill_dirs(home, project);
    // Unified derivation (env → legacy → real home, resolved once, plus the
    // thread-local test override). Reading `JEIKCODE_HOME` here used to be a
    // second rule that could rebase skills onto a different root than
    // `Config::config_dir()` — the exact "two homes" drift.
    let jeikcode_home = jeikcode_config::Config::config_dir();
    let user_jeikcode = home.join(".jeikcode");
    dirs.into_iter()
        .map(|dir| match dir.strip_prefix(&user_jeikcode) {
            Ok(rest) => jeikcode_home.join(rest),
            Err(_) => dir,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[serial_test::serial]
    fn runtime_dirs_redirect_user_jeikcode_skills_and_leave_others() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let config_root = tempfile::tempdir().unwrap();
        // 线程级 home（不再全局写 env）。
        let _home = jeikcode_config::test_util::IsolatedHome::at(config_root.path());
        let dirs = runtime_skill_dirs(home.path(), project.path());

        // The user-level `.jeikcode/skills` entry moves under JEIKCODE_HOME.
        assert!(dirs.contains(&config_root.path().join("skills")));
        // Commands are not skills; they must not be scanned here at all.
        assert!(!dirs.iter().any(|d| d.ends_with("commands")));
        // The stale real-home `.jeikcode/*` entries are gone.
        assert!(!dirs.contains(&home.path().join(".jeikcode/skills")));
        // Other products' dirs (`.claude`, `.agents`) stay at real home; project dirs unchanged.
        assert!(dirs.contains(&home.path().join(".claude/skills")));
        assert!(dirs.contains(&home.path().join(".agents/skills")));
        assert!(dirs.contains(&project.path().join(".jeikcode/skills")));
    }

    #[test]
    #[serial_test::serial]
    fn runtime_dirs_treat_empty_jeikcode_home_as_unset() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        // “空 JEIKCODE_HOME = 未设置”现在等价于“本线程用默认临时 home”：重点断言
        // 不产生 bogus 的相对 `skills` 目录（历史回归：`PathBuf::from("").join("skills")`）。
        // 把 seam 钉在**本测试 home 的 .jeikcode 根**上：`runtime_skill_dirs` 会把
        // `home/.jeikcode/*` 重基到 `Config::config_dir()`（也就是 seam 根本身），
        // 所以 seam 必须等于 `home/.jeikcode`，两侧才会一致。
        let _home = jeikcode_config::test_util::IsolatedHome::at(home.path().join(".jeikcode"));
        let dirs = runtime_skill_dirs(home.path(), project.path());

        // Empty JEIKCODE_HOME must be treated as unset — NOT redirected to a bogus
        // relative `skills` path (regression: `PathBuf::from("").join("skills")`).
        assert!(!dirs.iter().any(|d| d == std::path::Path::new("skills")));
        assert_eq!(dirs, standard_skill_dirs(home.path(), project.path()));
    }

    #[test]
    fn loads_directory_skills_with_precedence() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("review")).unwrap();
        std::fs::write(
            d.path().join("review/SKILL.md"),
            "---\ndescription: review code\n---\nReview the diff.\n",
        )
        .unwrap();

        let reg = SkillRegistry::load(&[d.path().to_path_buf()]);
        assert_eq!(reg.len(), 1);
        let review = reg.get("review").unwrap();
        assert_eq!(review.description, "review code");
    }

    #[test]
    fn flat_md_files_are_not_skills() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("greet.md"), "Hello $ARGUMENTS\n").unwrap();
        let reg = SkillRegistry::load(&[d.path().to_path_buf()]);
        assert!(reg.is_empty(), "flat .md files are commands, not skills");
    }

    #[test]
    fn skill_md_name_is_case_insensitive() {
        let d = tempfile::tempdir().unwrap();
        for (dir, file) in [("lower", "skill.md"), ("mixed", "Skill.MD")] {
            std::fs::create_dir_all(d.path().join(dir)).unwrap();
            std::fs::write(
                d.path().join(dir).join(file),
                "---\ndescription: x\n---\nbody\n",
            )
            .unwrap();
        }
        let reg = SkillRegistry::load(&[d.path().to_path_buf()]);
        assert!(reg.get("lower").is_some(), "skill.md must load");
        assert!(reg.get("mixed").is_some(), "Skill.MD must load");
    }

    /// A namespaced file skill (`skills:jeikcode-smoke-test`) must resolve by
    /// its bare name — the exact spelling the `$` trigger and `/skills` menu
    /// submit. Regression for the reported "first `$jeikcode-smoke-test` errors
    /// with 未知技能, second runs it as plain text" bug.
    #[test]
    fn get_resolves_namespaced_skill_by_bare_name() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("jeikcode-smoke-test")).unwrap();
        std::fs::write(
            d.path().join("jeikcode-smoke-test/SKILL.md"),
            "---\nname: jeikcode-smoke-test\ndescription: probe\n---\nbody\n",
        )
        .unwrap();
        let mut reg = SkillRegistry::new();
        reg.load_dir(d.path(), Some("skills"));

        // Stored under the namespaced key…
        assert!(reg.get("skills:jeikcode-smoke-test").is_some());
        // …but the bare name the menu submits must resolve too.
        assert_eq!(
            reg.get("jeikcode-smoke-test").map(|s| s.name.clone()),
            Some("skills:jeikcode-smoke-test".to_string())
        );
        // Case-insensitive on the bare fallback (menu names are lowercased,
        // but a typed capitalisation should still land).
        assert!(reg.get("Jeikcode-Smoke-Test").is_some());
    }

    /// When two namespaces own the same bare name the reference is ambiguous:
    /// the bare fallback must decline (the menu shows the qualified form, which
    /// still resolves via exact match).
    #[test]
    fn get_bare_name_is_ambiguous_across_namespaces() {
        let mut reg = SkillRegistry::new();
        reg.register(Skill {
            name: "skills:dup".into(),
            description: "a".into(),
            content: "A".into(),
            user_invocable: true,
            skill_dir: PathBuf::from("a"),
            source_path: PathBuf::from("a"),
        });
        reg.register(Skill {
            name: "plugin:dup".into(),
            description: "b".into(),
            content: "B".into(),
            user_invocable: true,
            skill_dir: PathBuf::from("b"),
            source_path: PathBuf::from("b"),
        });
        assert!(reg.get("dup").is_none(), "ambiguous bare name must decline");
        // Qualified names still resolve exactly.
        assert!(reg.get("skills:dup").is_some());
        assert!(reg.get("plugin:dup").is_some());
    }

    /// The `$`/`/skills` menu lists only user-invocable skills and shows a bare
    /// name when unique AMONG THEM. So a hidden (`user-invocable: false`) skill
    /// sharing the bare name must NOT make the menu-shown bare name ambiguous —
    /// otherwise the "menu shows it but resolve fails → 未知技能" bug returns.
    #[test]
    fn get_bare_name_prefers_sole_user_invocable_over_hidden() {
        let mut reg = SkillRegistry::new();
        reg.register(Skill {
            name: "skills:review".into(),
            description: "visible".into(),
            content: "V".into(),
            user_invocable: true,
            skill_dir: PathBuf::from("v"),
            source_path: PathBuf::from("v"),
        });
        reg.register(Skill {
            name: "plugin:review".into(),
            description: "hidden".into(),
            content: "H".into(),
            user_invocable: false,
            skill_dir: PathBuf::from("h"),
            source_path: PathBuf::from("h"),
        });
        assert_eq!(
            reg.get("review").map(|s| s.name.clone()),
            Some("skills:review".to_string()),
            "bare name must resolve to the sole user-invocable skill"
        );
    }

    #[test]
    fn later_dir_overrides_same_name() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        for (root, body) in [(&a, "from A"), (&b, "from B")] {
            std::fs::create_dir_all(root.path().join("x")).unwrap();
            std::fs::write(
                root.path().join("x/SKILL.md"),
                format!("---\ndescription: x\n---\n{body}\n"),
            )
            .unwrap();
        }
        let reg = SkillRegistry::load(&[a.path().to_path_buf(), b.path().to_path_buf()]);
        assert!(
            reg.get("x").unwrap().content.contains("from B"),
            "later dir wins"
        );
    }

    #[test]
    fn missing_dir_is_skipped() {
        let reg = SkillRegistry::load(&[PathBuf::from("/no/such/skills/dir")]);
        assert!(reg.is_empty());
    }

    #[test]
    fn retain_enabled_drops_only_disabled_names() {
        let d = tempfile::tempdir().unwrap();
        for (name, body) in [("alpha", "A"), ("beta", "B")] {
            std::fs::create_dir_all(d.path().join(name)).unwrap();
            std::fs::write(
                d.path().join(name).join("SKILL.md"),
                format!("---\ndescription: {name}\n---\n{body}\n"),
            )
            .unwrap();
        }
        let mut reg = SkillRegistry::load(&[d.path().to_path_buf()]);
        assert_eq!(reg.len(), 2);
        // "skills:alpha" in disabled must drop bare "alpha" in registry
        let disabled: std::collections::BTreeSet<String> =
            ["skills:alpha".to_string()].into_iter().collect();
        reg.retain_enabled(&disabled);
        assert_eq!(reg.len(), 1);
        assert!(reg.get("beta").is_some());
        assert!(reg.get("alpha").is_none());
    }

    #[test]
    fn standard_dirs_include_agents_skills_between_claude_and_jeikcode() {
        let home = Path::new("/home/u");
        let project = Path::new("/proj");
        let dirs = standard_skill_dirs(home, project);
        // `.agents/skills` is the cross-agent shared convention (opencode et al.) —
        // scanned at BOTH user and project level so shared skills load directly.
        assert!(
            dirs.contains(&home.join(".agents/skills")),
            "user-level ~/.agents/skills"
        );
        assert!(
            !dirs.contains(&home.join(".agent/skills")),
            "singular .agent/skills is intentionally not scanned"
        );
        assert!(
            dirs.contains(&project.join(".agents/skills")),
            "project-level .agents/skills"
        );
        assert!(
            !dirs.contains(&project.join(".agent/skills")),
            "singular .agent/skills is intentionally not scanned"
        );
        assert!(
            dirs.contains(&project.join(".skills")),
            "project-level .skills"
        );
        assert!(
            !dirs.iter().any(|d| d.ends_with("commands")),
            "commands are not skills"
        );
        // Precedence (last-wins): .claude < .agents < .jeikcode at each level, so a
        // user's jeikcode-native skill still overrides a same-named shared one.
        let pos = |p: PathBuf| dirs.iter().position(|d| *d == p).expect("dir present");
        assert!(pos(home.join(".claude/skills")) < pos(home.join(".agents/skills")));
        assert!(pos(home.join(".agents/skills")) < pos(home.join(".jeikcode/skills")));
        assert!(pos(project.join(".claude/skills")) < pos(project.join(".agents/skills")));
        assert!(pos(project.join(".agents/skills")) < pos(project.join(".jeikcode/skills")));
    }

    #[test]
    #[serial_test::serial]
    fn runtime_dirs_honor_jeikcode_home_for_duplicate_directory_skills() {
        let home = tempfile::tempdir().unwrap();
        let config_root = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        // 线程级 home（不再全局写 env）。
        let _home = jeikcode_config::test_util::IsolatedHome::at(config_root.path());
        let skill_root = config_root.path().join("skills");
        for (dir, body) in [("dedup-a", "from A"), ("dedup-b", "from B")] {
            let skill_dir = skill_root.join(dir);
            std::fs::create_dir_all(&skill_dir).unwrap();
            std::fs::write(
                skill_dir.join("SKILL.md"),
                format!("---\nname: dedup-skill\ndescription: duplicate\n---\n{body}\n"),
            )
            .unwrap();
        }

        let dirs = runtime_skill_dirs(home.path(), project.path());
        let user_skills = dirs
            .iter()
            .find(|dir| *dir == &skill_root)
            .cloned()
            .expect("JEIKCODE_HOME skills directory should be scanned");
        let reg = SkillRegistry::load(&[user_skills]);
        assert_eq!(reg.len(), 1, "same-name skills must collapse to one entry");
        assert!(reg.get("dedup-skill").is_some());
    }

    #[test]
    fn discovers_nested_skills_under_grouping_dirs() {
        let d = tempfile::tempdir().unwrap();
        // A grouping dir (no SKILL.md of its own) holding a nested skill two levels deep.
        std::fs::create_dir_all(d.path().join("GROUP/sub")).unwrap();
        std::fs::write(
            d.path().join("GROUP/sub/SKILL.md"),
            "---\ndescription: nested skill\n---\nDo the nested thing.\n",
        )
        .unwrap();
        // A skill dir's OWN nested *.md must NOT be mis-loaded as a separate skill.
        std::fs::create_dir_all(d.path().join("top")).unwrap();
        std::fs::write(
            d.path().join("top/SKILL.md"),
            "---\ndescription: top\n---\nTop.\n",
        )
        .unwrap();
        std::fs::write(
            d.path().join("top/resource.md"),
            "internal resource, not a command\n",
        )
        .unwrap();

        let reg = SkillRegistry::load(&[d.path().to_path_buf()]);
        assert!(
            reg.get("sub").is_some(),
            "nested GROUP/sub/SKILL.md must be discovered"
        );
        assert_eq!(reg.get("sub").unwrap().description, "nested skill");
        assert!(reg.get("top").is_some(), "top-level skill dir loaded");
        assert!(
            reg.get("resource").is_none(),
            "a skill's own resource .md is not a command"
        );
    }
}
