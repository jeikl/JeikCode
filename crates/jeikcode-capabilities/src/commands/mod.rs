//! User-invoked slash commands: `commands/*.md` prompt templates.
//!
//! This is the Command side of the Skill/Command split. Commands are expanded by
//! [`template::render`] (`$ARGUMENTS` / `$N` / shell blocks); skills are
//! model-invoked guides returned verbatim by the `skills` capability.
//!
//! Commands are discovered in these locations (LOW→HIGH priority, later wins):
//!
//! 1. `$JEIKCODE_HOME/commands/`
//! 2. `<home>/.claude/commands/`
//! 3. `<home>/.agents/commands/`
//! 4. `<project>/.claude/commands/`
//! 5. `<project>/.agents/commands/`
//! 6. `<project>/.jeikcode/commands/`
//! 7. installed plugin `commands/` dirs (namespaced as `<plugin>:<name>`)
//!
//! Missing frontmatter / `name` falls back to the file stem; `argument-hint`
//! (Claude-Code field) behaves like `args: optional`.

//! Each command file has the shape:
//!
//! ```markdown
//! ---
//! name: review
//! description: review the current diff
//! args: optional
//! ---
//! Review: $ARGUMENTS
//! ```
//!
//! `args` is `none` (default), `optional`, or `required`. Template variables are
//! `$ARGUMENTS` / `${ARGUMENTS}`, `$1` / `${1}` (1-based), and `` !`cmd` ``.
//! The registry is user-invoked only — commands are never exposed to the model
//! as tools.

pub mod template;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// A single user command parsed from a `.md` template file.
#[derive(Debug, Clone)]
pub struct UserCommand {
    pub name: String,
    pub description: String,
    pub args_requirement: ArgsRequirement,
    pub template: String,
    pub source: PathBuf,
    pub namespace: Option<String>,
}

impl UserCommand {
    /// The lookup key used in the registry — `"plugin:name"` when namespaced,
    /// otherwise just `"name"`.
    pub fn key(&self) -> String {
        match &self.namespace {
            Some(ns) => format!("{}:{}", ns, self.name),
            None => self.name.clone(),
        }
    }

    /// Render the template with the shared command-template engine
    /// (`$ARGUMENTS` / `$N` / `` !`cmd` ``). Skills never use this path.
    pub fn render(&self, args: &str) -> String {
        self.render_in(args, None)
    }

    /// Render with an explicit cwd for `` !`cmd` `` shell blocks.
    pub fn render_in(&self, args: &str, cwd: Option<&Path>) -> String {
        template::render_in(&self.template, args, cwd)
    }
}

/// Whether a user command expects arguments from the user, controlling
/// both the slash-menu Enter behaviour and dispatch validation:
///
/// | Value      | Menu Enter          | Empty-arg submit |
/// |------------|---------------------|------------------|
/// | `None`     | Execute immediately | Accepted         |
/// | `Optional` | Complete to `/name `| Accepted         |
/// | `Required` | Complete to `/name `| Rejected (error) |
#[derive(Debug, Clone, PartialEq)]
pub enum ArgsRequirement {
    Required,
    Optional,
    None,
}

/// In-memory registry of all user commands discovered from the standard
/// command directories. Later directories override earlier ones when names
/// collide.
pub struct UserCommandRegistry {
    commands: HashMap<String, UserCommand>,
}

impl UserCommandRegistry {
    /// Scan [`runtime_command_dirs`] plus installed plugin command dirs, merging
    /// results. Later entries win on name collision.
    pub fn load(project_root: &Path) -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        Self::load_with_home(project_root, &home)
    }

    /// [`load`] with an explicit home dir (test seam; production uses
    /// `dirs::home_dir()`).
    fn load_with_home(project_root: &Path, home: &Path) -> Self {
        let mut commands = HashMap::new();
        for dir in runtime_command_dirs(home, project_root) {
            Self::load_from_dir(&dir, None, &mut commands);
        }
        #[cfg(feature = "plugin")]
        for assets in crate::plugin::loader::iter_installed_plugin_assets_for(project_root) {
            Self::load_from_dir(&assets.commands_dir(), Some(&assets.plugin), &mut commands);
        }
        Self { commands }
    }

    /// An empty registry — useful for tests or when user commands are
    /// disabled.
    pub fn empty() -> Self {
        Self {
            commands: HashMap::new(),
        }
    }

    /// Register a single command into the registry. Used by tests and
    /// plugin installers that build commands programmatically rather than
    /// reading `.md` files from disk.
    pub fn register(&mut self, cmd: UserCommand) {
        let key = cmd.key();
        self.commands.insert(key, cmd);
    }

    fn load_from_dir(
        dir: &Path,
        namespace: Option<&str>,
        commands: &mut HashMap<String, UserCommand>,
    ) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            if let Some(mut cmd) = Self::parse_command_file(&path) {
                if let Some(ns) = namespace {
                    cmd.namespace = Some(ns.to_string());
                }
                let key = cmd.key();
                commands.insert(key, cmd);
            }
        }
    }

    fn parse_command_file(path: &Path) -> Option<UserCommand> {
        // Skip oversized command files to avoid high memory usage at startup.
        const MAX_COMMAND_FILE_SIZE: u64 = 1 << 20; // 1 MiB
        if std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) > MAX_COMMAND_FILE_SIZE {
            return None;
        }
        let content = std::fs::read_to_string(path).ok()?;
        // Frontmatter is optional (Claude-Code commands often omit it, or omit
        // `name`) — fall back to the file stem so `.claude/commands` load.
        let (frontmatter, template) = match Self::split_frontmatter(&content) {
            Some((fm, body)) => (fm, body),
            None => (String::new(), content),
        };
        let name = Self::extract_field(&frontmatter, "name")
            .filter(|name| !name.is_empty())
            .or_else(|| {
                path.file_stem()
                    .and_then(|stem| stem.to_str())
                    .map(str::to_string)
            })?;
        let description = Self::extract_field(&frontmatter, "description")
            .unwrap_or_else(|| format!("Custom command: {}", name));
        let args_str = Self::extract_field(&frontmatter, "args").unwrap_or_else(|| {
            if Self::extract_field(&frontmatter, "argument-hint").is_some() {
                "optional".into()
            } else {
                "none".into()
            }
        });
        let args_requirement = match args_str.as_str() {
            "required" => ArgsRequirement::Required,
            "optional" => ArgsRequirement::Optional,
            _ => ArgsRequirement::None,
        };
        let template = template.trim().to_string();
        if template.is_empty() {
            return None;
        }
        Some(UserCommand {
            name,
            description,
            args_requirement,
            template,
            source: path.to_path_buf(),
            namespace: None,
        })
    }

    /// Split `---\n..frontmatter..\n---\nbody` into (frontmatter, body).
    /// Returns `None` when the content doesn't start with `---`.
    fn split_frontmatter(content: &str) -> Option<(String, String)> {
        let content = content.trim();
        if !content.starts_with("---") {
            return None;
        }
        let rest = &content[3..];
        let end = rest.find("---")?;
        Some((rest[..end].trim().to_string(), rest[end + 3..].to_string()))
    }

    /// Extract a `key: value` field from frontmatter text. Handles leading
    /// whitespace but not quoted values — keeps parsing minimal.
    fn extract_field(frontmatter: &str, key: &str) -> Option<String> {
        for line in frontmatter.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix(key) {
                if let Some(value) = rest.trim_start().strip_prefix(':') {
                    return Some(value.trim().to_string());
                }
            }
        }
        None
    }

    /// Look up a command by name.
    pub fn get(&self, name: &str) -> Option<&UserCommand> {
        self.commands.get(name)
    }

    /// Resolve `name` to a command: by exact key first (`name` or
    /// `plugin:name`), then falling back to a **bare-name** match. Plugin
    /// commands are keyed `plugin:name` but listed/typed as just `name` — so
    /// `/wechat` resolves to `weixin:wechat` when that bare name is unique.
    /// Ambiguous bare names (same command name in two plugins) require the
    /// full `plugin:name`.
    ///
    /// This is the single source of truth for "is `name` a known user
    /// command?" — both the TUI submit gate (which decides whether to treat
    /// `/name` as a slash command vs. a chat message) and [`render`] go
    /// through it, so they can never disagree. Using exact-key [`get`] in the
    /// gate while rendering via the bare-name path here was the bug that sent
    /// `/wechat` to the agent as plain text.
    pub fn resolve(&self, name: &str) -> Option<&UserCommand> {
        self.commands.get(name).or_else(|| {
            let mut matches = self.commands.values().filter(|c| c.name == name);
            let first = matches.next();
            match matches.next() {
                None => first,   // unique bare-name match
                Some(_) => None, // ambiguous → require plugin:name
            }
        })
    }

    /// Render the template for `name`, replacing `$ARGUMENTS` /
    /// `${ARGUMENTS}` with the provided args string. Name resolution follows
    /// [`resolve`].
    ///
    /// Note: this method does NOT validate `args_requirement` — it always
    /// performs the substitution. Empty-arg validation for `Required` happens
    /// in the dispatch layer (`execute_slash_command_impl`).
    pub fn render(&self, name: &str, args: &str) -> Option<String> {
        let cmd = self.resolve(name)?;
        Some(cmd.render(args))
    }

    /// All commands, sorted by name.
    pub fn list(&self) -> Vec<&UserCommand> {
        let mut cmds: Vec<_> = self.commands.values().collect();
        cmds.sort_by_key(|c| &c.name);
        cmds
    }

    /// Render `name` with `args`, respecting `args_requirement`: a `required`
    /// command with no arguments is not rendered (caller should keep the raw
    /// text or reject it).
    pub fn render_invocation(&self, name: &str, args: &str) -> Option<String> {
        self.render_invocation_in(name, args, None)
    }

    /// [`render_invocation`] with an explicit cwd for shell blocks.
    pub fn render_invocation_in(
        &self,
        name: &str,
        args: &str,
        cwd: Option<&Path>,
    ) -> Option<String> {
        let cmd = self.resolve(name)?;
        if cmd.args_requirement == ArgsRequirement::Required && args.trim().is_empty() {
            return None;
        }
        Some(cmd.render_in(args, cwd))
    }

    /// `(name, description)` pairs for every registered user command, sorted by
    /// name. Convenient for feeding into completion / menu builders.
    pub fn command_names_and_descriptions(&self) -> Vec<(String, String)> {
        self.list()
            .iter()
            .map(|c| (c.name.clone(), c.description.clone()))
            .collect()
    }
}

/// Standard user-command directories (LOW→HIGH priority), Claude-Code/opencode
/// compatible. `home` = user home dir; `project` = the workspace root.
pub fn standard_command_dirs(home: &Path, project: &Path) -> Vec<PathBuf> {
    vec![
        home.join(".claude/commands"),
        home.join(".agents/commands"),
        home.join(".jeikcode/commands"),
        project.join(".claude/commands"),
        project.join(".agents/commands"),
        project.join(".jeikcode/commands"),
    ]
}

/// [`standard_command_dirs`] with the user-level `.jeikcode` root resolved from
/// `JEIKCODE_HOME` when set (the same rebasing rule as skills). Other products'
/// dirs (`.claude`, `.agents`) and project-relative dirs stay put.
pub fn runtime_command_dirs(home: &Path, project: &Path) -> Vec<PathBuf> {
    let dirs = standard_command_dirs(home, project);
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
    fn split_frontmatter_works() {
        let content = "---\nname: review\ndescription: Code review\n---\nTemplate body here";
        let (fm, body) = UserCommandRegistry::split_frontmatter(content).unwrap();
        assert!(fm.contains("name: review"));
        assert!(fm.contains("description: Code review"));
        assert_eq!(body.trim(), "Template body here");
    }

    #[test]
    fn split_frontmatter_returns_none_without_delimiters() {
        assert!(UserCommandRegistry::split_frontmatter("no frontmatter here").is_none());
        assert!(UserCommandRegistry::split_frontmatter("--- only opening").is_none());
    }

    #[test]
    fn extract_field_works() {
        let fm = "name: review\ndescription: Code review\nargs: optional";
        assert_eq!(
            UserCommandRegistry::extract_field(fm, "name"),
            Some("review".into())
        );
        assert_eq!(
            UserCommandRegistry::extract_field(fm, "description"),
            Some("Code review".into())
        );
        assert_eq!(
            UserCommandRegistry::extract_field(fm, "args"),
            Some("optional".into())
        );
        assert_eq!(UserCommandRegistry::extract_field(fm, "missing"), None);
    }

    #[test]
    fn parse_command_file_works() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("review.md");
        std::fs::write(
            &path,
            "---\nname: review\ndescription: Code review\nargs: optional\n---\nReview: $ARGUMENTS",
        )
        .unwrap();
        let cmd = UserCommandRegistry::parse_command_file(&path).unwrap();
        assert_eq!(cmd.name, "review");
        assert_eq!(cmd.description, "Code review");
        assert_eq!(cmd.args_requirement, ArgsRequirement::Optional);
        assert_eq!(cmd.template, "Review: $ARGUMENTS");
        assert_eq!(cmd.source, path);
    }

    #[test]
    fn parse_command_file_skips_oversized_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("huge.md");
        // Create a file larger than 1 MiB (1_048_576 bytes).
        let padding = "x".repeat(1_048_577);
        let huge_content = format!("---\nname: huge\ndescription: Huge\n---\n{}", padding);
        std::fs::write(&path, huge_content).unwrap();
        assert!(UserCommandRegistry::parse_command_file(&path).is_none());
    }

    #[test]
    fn render_replaces_arguments() {
        let dir = tempfile::tempdir().unwrap();
        let cmd_dir = dir.path().join(".jeikcode/commands");
        std::fs::create_dir_all(&cmd_dir).unwrap();
        std::fs::write(
            cmd_dir.join("review.md"),
            "---\nname: review\ndescription: Review\nargs: optional\n---\nReview $ARGUMENTS and ${ARGUMENTS} done",
        )
        .unwrap();
        let home = tempfile::tempdir().unwrap();
        let reg = UserCommandRegistry::load_with_home(dir.path(), home.path());
        let rendered = reg.render("review", "main.rs").unwrap();
        assert_eq!(rendered, "Review main.rs and main.rs done");
    }

    #[test]
    fn render_empty_args() {
        let dir = tempfile::tempdir().unwrap();
        let cmd_dir = dir.path().join(".jeikcode/commands");
        std::fs::create_dir_all(&cmd_dir).unwrap();
        std::fs::write(
            cmd_dir.join("test.md"),
            "---\nname: test\ndescription: Run tests\n---\nRun all tests. Focus: $ARGUMENTS",
        )
        .unwrap();
        let home = tempfile::tempdir().unwrap();
        let reg = UserCommandRegistry::load_with_home(dir.path(), home.path());
        let rendered = reg.render("test", "").unwrap();
        assert_eq!(rendered, "Run all tests. Focus: ");
    }

    #[test]
    fn load_from_dir_skips_non_md() {
        let dir = tempfile::tempdir().unwrap();
        let cmd_dir = dir.path().join("commands");
        std::fs::create_dir_all(&cmd_dir).unwrap();
        // Valid .md file
        std::fs::write(
            cmd_dir.join("valid.md"),
            "---\nname: valid\ndescription: Valid cmd\n---\nTemplate",
        )
        .unwrap();
        // Non-md file — should be skipped
        std::fs::write(
            cmd_dir.join("skip.txt"),
            "---\nname: skip\ndescription: Skip\n---\nNope",
        )
        .unwrap();
        // No extension — should be skipped
        std::fs::write(
            cmd_dir.join("noext"),
            "---\nname: noext\ndescription: No ext\n---\nNope",
        )
        .unwrap();
        let mut commands = HashMap::new();
        UserCommandRegistry::load_from_dir(&cmd_dir, None, &mut commands);
        assert_eq!(commands.len(), 1);
        assert!(commands.contains_key("valid"));
    }

    #[test]
    fn project_overrides_global_same_name() {
        let root = tempfile::tempdir().unwrap();

        // Simulate global dir
        let global_dir = root.path().join("global_commands");
        std::fs::create_dir_all(&global_dir).unwrap();
        std::fs::write(
            global_dir.join("review.md"),
            "---\nname: review\ndescription: Global review\n---\nGlobal template",
        )
        .unwrap();

        // Simulate project dir
        let project_dir = root.path().join("project_commands");
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::write(
            project_dir.join("review.md"),
            "---\nname: review\ndescription: Project review\n---\nProject template",
        )
        .unwrap();

        let mut commands = HashMap::new();
        // Load global first, then project — project should override.
        UserCommandRegistry::load_from_dir(&global_dir, None, &mut commands);
        UserCommandRegistry::load_from_dir(&project_dir, None, &mut commands);

        let cmd = commands.get("review").unwrap();
        assert_eq!(cmd.description, "Project review");
        assert_eq!(cmd.template, "Project template");
    }

    #[test]
    #[serial_test::serial]
    fn list_returns_sorted_commands() {
        // Isolate $JEIKCODE_HOME so the global commands dir and any installed
        // plugin commands on the dev machine don't leak into the assertion.
        let home = tempfile::tempdir().unwrap();
        // 线程级 home（不再全局写 env）。
        let _home = jeikcode_config::test_util::IsolatedHome::at(home.path());
        let dir = tempfile::tempdir().unwrap();
        let cmd_dir = dir.path().join(".jeikcode/commands");
        std::fs::create_dir_all(&cmd_dir).unwrap();
        std::fs::write(
            cmd_dir.join("zebra.md"),
            "---\nname: zebra\ndescription: Z\n---\nZ",
        )
        .unwrap();
        std::fs::write(
            cmd_dir.join("alpha.md"),
            "---\nname: alpha\ndescription: A\n---\nA",
        )
        .unwrap();
        let reg = UserCommandRegistry::load_with_home(dir.path(), home.path());
        let names: Vec<_> = reg.list().iter().map(|c| c.name.as_str()).collect();

        assert_eq!(names, vec!["alpha", "zebra"]);
    }

    #[test]
    fn standard_command_dirs_cover_agent_dirs_in_order() {
        let home = Path::new("/home/u");
        let project = Path::new("/proj");
        assert_eq!(
            standard_command_dirs(home, project),
            vec![
                home.join(".claude/commands"),
                home.join(".agents/commands"),
                home.join(".jeikcode/commands"),
                project.join(".claude/commands"),
                project.join(".agents/commands"),
                project.join(".jeikcode/commands"),
            ]
        );
    }

    #[test]
    #[serial_test::serial]
    fn runtime_command_dirs_rebase_user_jeikcode() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let config_root = tempfile::tempdir().unwrap();
        let _home = jeikcode_config::test_util::IsolatedHome::at(config_root.path());
        let dirs = runtime_command_dirs(home.path(), project.path());
        assert!(dirs.contains(&config_root.path().join("commands")));
        assert!(!dirs.contains(&home.path().join(".jeikcode/commands")));
        assert!(dirs.contains(&home.path().join(".claude/commands")));
        assert!(dirs.contains(&project.path().join(".jeikcode/commands")));
    }

    #[test]
    fn empty_registry_has_no_commands() {
        let reg = UserCommandRegistry::empty();
        assert!(reg.list().is_empty());
        assert!(reg.get("anything").is_none());
        assert!(reg.render("anything", "").is_none());
    }

    #[test]
    fn parse_file_without_frontmatter_uses_stem() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.md");
        std::fs::write(&path, "No frontmatter here, just text.").unwrap();
        let cmd = UserCommandRegistry::parse_command_file(&path).unwrap();
        assert_eq!(cmd.name, "bad");
        assert_eq!(cmd.template, "No frontmatter here, just text.");
    }

    #[test]
    fn parse_file_without_name_uses_stem() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("noname.md");
        std::fs::write(&path, "---\ndescription: Missing name field\n---\nTemplate").unwrap();
        let cmd = UserCommandRegistry::parse_command_file(&path).unwrap();
        assert_eq!(cmd.name, "noname");
        assert_eq!(cmd.description, "Missing name field");
    }

    #[test]
    fn loads_claude_and_agents_command_dirs() {
        let project = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        for (sub, name) in [
            (".claude/commands", "claude-cmd"),
            (".agents/commands", "agent-cmd"),
        ] {
            let commands = project.path().join(sub);
            std::fs::create_dir_all(&commands).unwrap();
            std::fs::write(
                commands.join(format!("{name}.md")),
                format!("Run {name} with $ARGUMENTS"),
            )
            .unwrap();
        }
        let reg = UserCommandRegistry::load_with_home(project.path(), home.path());
        assert!(reg.get("claude-cmd").is_some());
        assert!(reg.get("agent-cmd").is_some());
    }

    #[test]
    fn default_description_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nodesc.md");
        std::fs::write(&path, "---\nname: nodesc\n---\nTemplate").unwrap();
        let cmd = UserCommandRegistry::parse_command_file(&path).unwrap();
        assert_eq!(cmd.description, "Custom command: nodesc");
    }

    #[test]
    fn default_args_requirement_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("noargs.md");
        std::fs::write(&path, "---\nname: noargs\n---\nTemplate").unwrap();
        let cmd = UserCommandRegistry::parse_command_file(&path).unwrap();
        assert_eq!(cmd.args_requirement, ArgsRequirement::None);
    }

    #[cfg(feature = "plugin")]
    #[test]
    #[serial_test::serial]
    fn load_plugin_layer_namespaces_commands() {
        // Set up an installed plugin on disk via the plugin module's state.
        let tmp = tempfile::tempdir().unwrap();
        // 线程级 home（不再全局写 env）。
        let _home = jeikcode_config::test_util::IsolatedHome::at(tmp.path());
        let plugin_dir = tmp.path().join("plugins/marketplaces/p");
        let cmd_dir = plugin_dir.join("commands");
        std::fs::create_dir_all(&cmd_dir).unwrap();
        std::fs::write(
            cmd_dir.join("greet.md"),
            "---\nname: greet\ndescription: hi\n---\nhello $ARGUMENTS",
        )
        .unwrap();
        std::fs::write(
            tmp.path().join("plugins/installed_plugins.json"),
            r#"{"version":1,"plugins":{"p@p":{"marketplace":"p","plugin":"p","plugin_dir":"marketplaces/p","installed_at":"x"}}}"#,
        )
        .unwrap();

        let working = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let reg = UserCommandRegistry::load_with_home(working.path(), home.path());
        assert!(reg.get("p:greet").is_some());
    }
    #[test]
    fn render_resolves_bare_name_for_namespaced_command() {
        let mut reg = UserCommandRegistry::empty();
        reg.commands.insert(
            "weixin:wechat".into(),
            UserCommand {
                name: "wechat".into(),
                description: "d".into(),
                args_requirement: ArgsRequirement::Optional,
                template: "do $ARGUMENTS".into(),
                source: std::path::PathBuf::from("x"),
                namespace: Some("weixin".into()),
            },
        );
        assert_eq!(reg.render("wechat", "login").as_deref(), Some("do login"));
        assert_eq!(reg.render("weixin:wechat", "").as_deref(), Some("do "));
        assert!(reg.render("nope", "").is_none());
    }

    #[test]
    fn resolve_bare_name_matches_render_for_gate() {
        // The TUI submit gate decides "is `/x` a slash command?" via
        // `resolve()`, while dispatch renders via `render()`. They MUST
        // agree, or a plugin command typed as `/wechat` (keyed
        // `weixin:wechat`) passes neither/one and gets sent to the agent
        // as plain text. `get()` is exact-key only and intentionally does
        // NOT do bare-name fallback — so the gate must use `resolve()`.
        let mut reg = UserCommandRegistry::empty();
        reg.commands.insert(
            "weixin:wechat".into(),
            UserCommand {
                name: "wechat".into(),
                description: "d".into(),
                args_requirement: ArgsRequirement::Optional,
                template: "do $ARGUMENTS".into(),
                source: std::path::PathBuf::from("x"),
                namespace: Some("weixin".into()),
            },
        );
        // The asymmetry that caused the bug: exact-key lookup misses.
        assert!(reg.get("wechat").is_none());
        // resolve() bridges it via the same bare-name fallback render() uses.
        assert!(reg.resolve("wechat").is_some());
        assert!(reg.resolve("weixin:wechat").is_some());
        assert!(reg.resolve("nope").is_none());
        // resolve() and render() must agree on what is a known command.
        assert_eq!(
            reg.resolve("wechat").is_some(),
            reg.render("wechat", "").is_some()
        );
    }

    #[test]
    fn render_bare_name_ambiguous_returns_none() {
        let mut reg = UserCommandRegistry::empty();
        for ns in ["a", "b"] {
            reg.commands.insert(
                format!("{ns}:wechat"),
                UserCommand {
                    name: "wechat".into(),
                    description: "d".into(),
                    args_requirement: ArgsRequirement::None,
                    template: "t".into(),
                    source: std::path::PathBuf::from("x"),
                    namespace: Some(ns.into()),
                },
            );
        }
        assert!(reg.render("wechat", "").is_none());
        assert!(reg.render("a:wechat", "").is_some());
    }
}
