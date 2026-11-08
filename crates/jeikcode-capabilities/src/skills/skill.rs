//! A loaded skill: a markdown guide with optional YAML-ish frontmatter. Content is
//! returned verbatim; argument/variable substitution belongs to user-invoked command
//! templates (`crate::commands::template`), never to skills.

use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// The guide body (everything after the frontmatter block), returned verbatim.
    pub content: String,
    /// If false (`user-invocable: false` in frontmatter), hidden from the `/` menu;
    /// the model can still auto-invoke it. Absent → true.
    pub user_invocable: bool,
    /// Directory containing the skill file (for `${CLAUDE_SKILL_DIR}`).
    pub skill_dir: PathBuf,
    pub source_path: PathBuf,
}

impl Skill {
    /// Render the minimal path-bearing payload around `body`:
    ///
    /// ```text
    /// Skill Path: {absolute skill directory}
    /// Skill Guide: {absolute guide .md path}
    /// <Skill Guide>
    /// {body}
    /// </Skill Guide>
    /// ```
    fn render_injection(&self, body: &str) -> String {
        let path = display_skill_path(&self.skill_dir.to_string_lossy(), cfg!(windows));
        let guide = display_skill_path(&self.source_path.to_string_lossy(), cfg!(windows));
        let mut out = format!("Skill Path: {path}\nSkill Guide: {guide}\n<Skill Guide>\n{body}");
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str("</Skill Guide>");
        out
    }

    /// Raw guide for the `use_skill` tool: the SKILL.md body verbatim, with no
    /// argument, variable, or shell substitution.
    pub fn raw_for_injection(&self) -> String {
        self.render_injection(&self.content)
    }
}

/// `SKILL.md` in any ASCII case (`skill.md`, `Skill.md`, …).
pub(crate) fn is_skill_md_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("skill.md")
}

/// Format a skill path for model-facing output. On Windows, convert `\` → `/` so the
/// path works uniformly across read/Python/Git Bash (a raw backslash path breaks when
/// bash treats `\U`/`\s` as escapes). Windows separators are always `\` and filenames
/// can't contain `\`, so the replace is lossless. On Unix, `\` is a legal filename char,
/// so leave it. Display-only — never used for IO.
fn display_skill_path(raw: &str, is_windows: bool) -> String {
    if is_windows {
        raw.replace('\\', "/")
    } else {
        raw.to_string()
    }
}

// ── Frontmatter + parsing ────────────────────────────────────────────────────

struct Frontmatter {
    name: Option<String>,
    description: String,
    /// If false (`user-invocable: false`), hidden from the `/` menu — the model can
    /// still auto-invoke. Absent → true.
    user_invocable: bool,
}

impl Default for Frontmatter {
    fn default() -> Self {
        Self {
            name: None,
            description: String::new(),
            user_invocable: true,
        }
    }
}

fn fm_value(s: &str) -> String {
    // Strip a surrounding pair of double OR single quotes (production parity).
    s.trim().trim_matches('"').trim_matches('\'').to_string()
}

/// True when a YAML scalar value is a block-scalar indicator (`>`, `|`, `>-`, `|+`, …).
/// Bare indicators keep content on following indented lines — a line-only parser that
/// stores `">"` as the description is the root cause of `name: >` catalog rows.
fn is_yaml_block_scalar_indicator(value: &str) -> bool {
    let v = value.trim();
    let Some(first) = v.as_bytes().first().copied() else {
        return false;
    };
    if first != b'>' && first != b'|' {
        return false;
    }
    v[1..]
        .bytes()
        .all(|b| matches!(b, b'+' | b'-' | b'0'..=b'9'))
}

/// Folded (`>`) YAML block: newlines → spaces, collapse runs of whitespace.
fn fold_yaml_block(lines: &[String]) -> String {
    lines
        .iter()
        .map(|l| l.as_str())
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Collect a YAML block scalar starting after a `key: >` / `key: |` line.
/// Subsequent lines that are blank or indented belong to the scalar; the first
/// unindented non-blank line ends it (returned as the next index to process).
fn take_yaml_block_scalar(lines: &[&str], start: usize, folded: bool) -> (String, usize) {
    let mut collected: Vec<String> = Vec::new();
    let mut i = start;
    // Common indent of the first non-empty content line (YAML chomping-ish).
    let mut indent: Option<usize> = None;
    while i < lines.len() {
        let line = lines[i];
        if line.is_empty() {
            collected.push(String::new());
            i += 1;
            continue;
        }
        let leading = line.chars().take_while(|c| *c == ' ' || *c == '\t').count();
        if leading == 0 {
            break; // next top-level key
        }
        if indent.is_none() {
            indent = Some(leading);
        }
        let strip = indent.unwrap_or(leading).min(leading);
        collected.push(line.chars().skip(strip).collect());
        i += 1;
    }
    // Drop trailing blank lines (YAML clip chomping default).
    while collected.last().is_some_and(|s| s.is_empty()) {
        collected.pop();
    }
    let value = if folded {
        fold_yaml_block(&collected)
    } else {
        collected.join("\n")
    };
    (value, i)
}

/// Parse `---`-delimited frontmatter; returns `(Frontmatter, body)`. Absent/unclosed
/// frontmatter → empty frontmatter + the whole content as body.
///
/// Supports YAML block scalars on `description:` (`>` folded / `|` literal), matching
/// Grok/OpenCode skill frontmatter so multi-line Chinese descriptions are not stored
/// as the bare indicator `">"`.
fn parse_frontmatter(content: &str) -> (Frontmatter, String) {
    let mut fm = Frontmatter::default();
    if !content.starts_with("---\n") && !content.starts_with("---\r\n") {
        return (fm, content.to_string());
    }
    let after_open = &content[if content.starts_with("---\r\n") { 5 } else { 4 }..];
    let (close_pos, skip) = match find_frontmatter_close(after_open) {
        Some(x) => x,
        None => return (fm, content.to_string()),
    };
    let block = &after_open[..close_pos];
    let body = &after_open[close_pos + skip..];
    let lines: Vec<&str> = block.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        // Top-level keys are matched after trim_start so lightly-indented
        // frontmatter (and test fixtures with source indentation) still parse.
        // Block-scalar body lines stay on the original `lines` slice so their
        // relative indent is preserved for `take_yaml_block_scalar`.
        let key_line = lines[i].trim_start();
        if let Some(v) = key_line.strip_prefix("name:") {
            fm.name = Some(fm_value(v));
            i += 1;
        } else if let Some(v) = key_line.strip_prefix("description:") {
            let rest = v.trim();
            if is_yaml_block_scalar_indicator(rest) {
                let folded = rest.as_bytes().first() == Some(&b'>');
                let (value, next) = take_yaml_block_scalar(&lines, i + 1, folded);
                fm.description = value;
                i = next;
            } else {
                let parsed = fm_value(v);
                // Never keep a bare block indicator as the description.
                fm.description = if is_yaml_block_scalar_indicator(&parsed) {
                    String::new()
                } else {
                    parsed
                };
                i += 1;
            }
        } else if let Some(v) = key_line.strip_prefix("user-invocable:") {
            // Mirror core: only the literal `false` hides it; anything else stays true.
            fm.user_invocable = v.trim() != "false";
            i += 1;
        } else {
            i += 1;
        }
    }
    (fm, body.to_string())
}

/// Locate the closing `---`. Returns `(offset_of_close_newline, bytes_to_skip)`.
fn find_frontmatter_close(after_open: &str) -> Option<(usize, usize)> {
    // Closing delimiter at EOF with no trailing newline (empty / minimal frontmatter).
    if after_open == "---" {
        return Some((0, 3));
    }
    if after_open == "---\r" {
        return Some((0, 4));
    }
    if after_open.starts_with("---\n") {
        return Some((0, 4)); // empty frontmatter
    }
    if after_open.starts_with("---\r\n") {
        return Some((0, 5));
    }
    if let Some(pos) = after_open.find("\n---\n") {
        return Some((pos, 5));
    }
    if let Some(pos) = after_open.find("\n---\r\n") {
        return Some((pos, 6));
    }
    if after_open.ends_with("\n---") {
        return Some((after_open.len() - 4, 4));
    }
    if after_open.ends_with("\n---\r") {
        return Some((after_open.len() - 5, 5));
    }
    None
}

fn first_paragraph(template: &str) -> String {
    template
        .split("\n\n")
        .map(str::trim)
        .find(|p| !p.is_empty())
        .unwrap_or("")
        .lines()
        .map(str::trim)
        .collect::<Vec<_>>()
        .join(" ")
}

fn validate_skill_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 {
        return Err(format!("skill name '{name}' must be 1-64 characters"));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '/')
    {
        return Err(format!("skill name '{name}' has invalid characters"));
    }
    if name.starts_with(['/', '-'])
        || name.ends_with(['/', '-'])
        || name.contains("//")
        || name.contains("--")
    {
        return Err(format!(
            "skill name '{name}' has a bad slash/hyphen position"
        ));
    }
    Ok(())
}

fn make_name(base: &str, namespace: Option<&str>) -> String {
    let norm = base.to_ascii_lowercase().replace('/', "-");
    match namespace {
        Some(ns) => format!("{}:{norm}", ns.to_ascii_lowercase()),
        None => norm,
    }
}

/// Parse a directory-style `<dir>/SKILL.md` (name = directory name unless overridden).
/// The file name is matched case-insensitively by the registry.
pub(crate) fn parse_skill_dir(
    skill_dir: &Path,
    skill_md: &Path,
    namespace: Option<&str>,
) -> Result<Skill, String> {
    let content = std::fs::read_to_string(skill_md).map_err(|e| e.to_string())?;
    let dir_name = skill_dir
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("invalid directory name")?;
    build_skill(&content, dir_name, skill_dir, skill_md, namespace)
}

fn build_skill(
    content: &str,
    default_name: &str,
    skill_dir: &Path,
    source: &Path,
    namespace: Option<&str>,
) -> Result<Skill, String> {
    let (fm, body) = parse_frontmatter(content);
    let base = fm.name.as_deref().unwrap_or(default_name);
    validate_skill_name(base)?;
    let name = make_name(base, namespace);
    let description = if fm.description.is_empty() {
        first_paragraph(&body)
    } else {
        fm.description
    };
    Ok(Skill {
        name,
        description,
        content: body,
        user_invocable: fm.user_invocable,
        skill_dir: skill_dir.to_path_buf(),
        source_path: source.to_path_buf(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(content: &str) -> Skill {
        Skill {
            name: "t".into(),
            description: String::new(),
            content: content.into(),
            user_invocable: true,
            skill_dir: PathBuf::from("/sk"),
            source_path: PathBuf::from("/sk/SKILL.md"),
        }
    }

    #[test]
    fn frontmatter_parses_user_invocable() {
        // `user-invocable: false` hides a skill from the `/` menu; anything else
        // (incl. absent) defaults to true. Mirrors core skill.rs parsing.
        let (fm, _) = parse_frontmatter("---\nname: x\nuser-invocable: false\n---\nbody");
        assert!(!fm.user_invocable);
        let (fm2, _) = parse_frontmatter("---\nname: x\n---\nbody");
        assert!(fm2.user_invocable, "absent → default true");
    }

    #[test]
    fn frontmatter_parse() {
        let (fm, body) = parse_frontmatter(
            "---\nname: my-skill\ndescription: \"does X\"\nallowed-tools: read, run_command\n---\nbody here\n",
        );
        assert_eq!(fm.name.as_deref(), Some("my-skill"));
        assert_eq!(fm.description, "does X");
        assert_eq!(body.trim(), "body here");
    }

    #[test]
    fn frontmatter_folded_description_block_scalar() {
        // Real community skills use `description: >` multi-line YAML — previously
        // stored as the bare indicator ">" and rendered as `name: >` in the catalog.
        // Closing `---` must be at column 0 (YAML frontmatter delimiter).
        let src = "---\nname: multi-db-executor\ndescription: >\n  连接公司内部数据库查询数据。当用户的需求涉及到数据库、\n  或着自身执行过程中需要查数据验证正确性时时使用该技能。\n---\n# multi-db-executor\nbody\n";
        let (fm, body) = parse_frontmatter(src);
        assert_eq!(fm.name.as_deref(), Some("multi-db-executor"));
        assert!(
            fm.description.contains("连接公司内部数据库"),
            "folded block must become real description, got {:?}",
            fm.description
        );
        assert!(
            fm.description.contains("验证正确性"),
            "second folded line must join: {:?}",
            fm.description
        );
        assert!(!fm.description.trim().starts_with('>'));
        assert!(body.contains("multi-db-executor"));
    }

    #[test]
    fn frontmatter_literal_description_block_scalar() {
        let src = "---\ndescription: |\n  line one\n  line two\n---\nbody\n";
        let (fm, _) = parse_frontmatter(src);
        assert_eq!(fm.description, "line one\nline two");
    }

    #[test]
    fn raw_injection_renders_paths_and_guide_content_only() {
        let dir = tempfile::tempdir().unwrap();
        // Directory name must be a valid skill name (tempdir basenames often start with `.`).
        let skill_dir = dir.path().join("demo-skill");
        std::fs::create_dir_all(skill_dir.join("scripts")).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\ndescription: d\n---\nDo X\n",
        )
        .unwrap();
        std::fs::write(skill_dir.join("scripts/db_executor.py"), "print(1)\n").unwrap();
        let skill = parse_skill_dir(&skill_dir, &skill_dir.join("SKILL.md"), None).unwrap();
        let out = skill.raw_for_injection();
        let display = |p: &Path| {
            let raw = p.to_string_lossy();
            if cfg!(windows) {
                raw.replace('\\', "/")
            } else {
                raw.into_owned()
            }
        };
        assert!(
            out.starts_with(&format!("Skill Path: {}\n", display(&skill_dir))),
            "{out}"
        );
        assert!(
            out.contains(&format!(
                "Skill Guide: {}\n",
                display(&skill_dir.join("SKILL.md"))
            )),
            "{out}"
        );
        assert!(out.contains("<Skill Guide>\nDo X\n</Skill Guide>"), "{out}");
        // 不再注入 frontmatter 元数据、基目录提示或打包资源清单。
        assert!(!out.contains("description="), "{out}");
        assert!(!out.contains("Base directory"), "{out}");
        assert!(!out.contains("<skill_files>"), "{out}");
        assert!(!out.contains("db_executor.py"), "{out}");
    }

    #[test]
    fn raw_injection_keeps_guide_body_verbatim() {
        let s = skill("Run ${SKILL_DIR}/x.py $ARGUMENTS !`echo hi`");
        let out = s.raw_for_injection();
        assert!(
            out.contains(
                "<Skill Guide>\nRun ${SKILL_DIR}/x.py $ARGUMENTS !`echo hi`\n</Skill Guide>"
            ),
            "{out}"
        );
    }

    #[test]
    fn no_frontmatter_is_all_body() {
        let (fm, body) = parse_frontmatter("just a template\nmore");
        assert!(fm.name.is_none());
        assert_eq!(body, "just a template\nmore");
    }

    #[test]
    fn frontmatter_single_quotes() {
        let (fm, _) = parse_frontmatter(
            "---\nname: 'my-skill'\nallowed-tools: read run_command grep\n---\nbody\n",
        );
        assert_eq!(fm.name.as_deref(), Some("my-skill"));
    }

    #[test]
    fn frontmatter_close_at_eof() {
        let (fm, body) = parse_frontmatter("---\ndescription: x\n---");
        assert_eq!(fm.description, "x");
        assert_eq!(body, "");
    }

    #[test]
    fn name_validation() {
        assert!(validate_skill_name("good-name_1").is_ok());
        assert!(validate_skill_name("").is_err());
        assert!(validate_skill_name("-bad").is_err());
        assert!(validate_skill_name("a--b").is_err());
        assert!(validate_skill_name("has space").is_err());
        assert_eq!(make_name("My/Skill", Some("Plug")), "plug:my-skill");
    }
}
