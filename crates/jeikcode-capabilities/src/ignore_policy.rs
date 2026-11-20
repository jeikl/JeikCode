//! Shared ignore policy for codegraph indexing, search (`grep`/`glob`) and
//! sensitive-path gating.
//!
//! Three visibility models share these rules, but apply them with different
//! profiles:
//!
//! | Profile | Noise (`.codegraphignore`) | Sensitive (`.codegraphignore.graph`) | VCS (`.gitignore`) |
//! | :--- | :--- | :--- | :--- |
//! | [`VisibilityProfile::GraphIndex`] | ignored | ignored | caller applies |
//! | [`VisibilityProfile::Search`] | ignored unless `include_ignored` | ignored unless approval | intentionally not applied |
//! | [`VisibilityProfile::ExplicitRead`] | allowed (explicit path) | approval-gated | allowed |
//!
//! Precedence is **project over global** for noise rules, and sensitive rules
//! are a separate matcher so a project `!` can never re-open a credential path.
//! Within one scope the later file wins (`.jeikcode` over project root, project
//! root over global), matching normal gitignore last-match-wins semantics.

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::WalkBuilder;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Which visibility contract a caller is applying.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VisibilityProfile {
    GraphIndex,
    Search,
    ExplicitRead,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub enum IgnoreKind {
    Noise,
    Sensitive,
}

#[derive(Debug, Clone)]
struct ScopedMatcher {
    base: PathBuf,
    /// Higher wins. Root-scoped files share the same depth and use `order`.
    order: usize,
    source: PathBuf,
    matcher: Gitignore,
}

#[derive(Debug, Clone, Default)]
pub struct IgnorePolicy {
    root: PathBuf,
    noise: Vec<ScopedMatcher>,
    sensitive: Vec<ScopedMatcher>,
    /// Fingerprint of the loaded ignore files (path + mtime + len). Callers can
    /// include this in a graph/query revision so editing a rule invalidates
    /// cached decisions.
    fingerprint: u64,
}

impl IgnorePolicy {
    /// Load global, project-root and project `.jeikcode` rules.
    ///
    /// Order is intentional: global first, project root next, `.jeikcode` last.
    /// Because `ignore` uses last-match-wins, project rules override global and
    /// `.jeikcode` overrides the project root. Sensitive rules live in a
    /// separate matcher and are never mixed with noise negations.
    pub fn load(root: &Path) -> Self {
        let root = canonical_root(root);
        let cfg = crate::paths::config_dir();
        let signature = policy_source_signature(&root, &cfg);
        if let Some(cached) = fast_policy_cache()
            .lock()
            .ok()
            .and_then(|cache| cache.get(&root).cloned())
        {
            if cached.0 == signature {
                return cached.1;
            }
        }
        let mut policy = Self {
            root: root.clone(),
            ..Default::default()
        };
        let scopes = [
            // (directory containing the ignore files, base for matching, order)
            (cfg, root.clone(), 0usize),
            (root.clone(), root.clone(), 10usize),
            (root.join(".jeikcode"), root.clone(), 20usize),
        ];

        for (dir, base, order) in scopes {
            for (name, sensitive) in [
                (".codegraphignore", false),
                (".codegraignore", false),
                (".codegraphignore.graph", true),
                (".codegraignore.graph", true),
            ] {
                let path = dir.join(name);
                if !path.is_file() {
                    continue;
                }
                let mut builder = GitignoreBuilder::new(&base);
                if builder.add(&path).is_some() {
                    continue;
                }
                let Ok(matcher) = builder.build() else {
                    continue;
                };
                if sensitive {
                    // Sensitive rules are a hard gate: whitelist lines are
                    // deliberately not honored here.
                    policy.sensitive.push(ScopedMatcher {
                        base: base.clone(),
                        order,
                        source: path.clone(),
                        matcher,
                    });
                } else {
                    policy.noise.push(ScopedMatcher {
                        base: base.clone(),
                        order,
                        source: path.clone(),
                        matcher,
                    });
                }
            }
        }

        policy.fingerprint = signature;
        if let Ok(mut cache) = fast_policy_cache().lock() {
            if cache.len() >= 64 {
                cache.clear();
            }
            cache.insert(root, (signature, policy.clone()));
        }
        policy
    }

    pub fn fingerprint(&self) -> u64 {
        self.fingerprint
    }

    /// Load the fast scopes plus nested `.codegraphignore` / `.graph` files.
    /// Nested rules win over their parent directory, matching gitignore
    /// semantics. This is intentionally a separate constructor: the directory
    /// scan is only needed by full graph indexing and search walks, not by every
    /// explicit `read`.
    pub fn load_deep(root: &Path) -> Self {
        let mut policy = Self::load(root);
        let root = policy.root.clone();
        let mut hasher = DefaultHasher::new();
        policy.fingerprint.hash(&mut hasher);

        for path in nested_ignore_files(&root) {
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let sensitive = name.ends_with(".graph");
            let Some(base) = path.parent() else {
                continue;
            };
            let mut builder = GitignoreBuilder::new(base);
            if builder.add(&path).is_some() {
                continue;
            }
            let Ok(matcher) = builder.build() else {
                continue;
            };
            let order = 100 + base.components().count();
            let scoped = ScopedMatcher {
                base: base.to_path_buf(),
                order,
                source: path.clone(),
                matcher,
            };
            if sensitive {
                policy.sensitive.push(scoped);
            } else {
                policy.noise.push(scoped);
            }
            fingerprint_file(&mut hasher, &path);
        }

        policy.fingerprint = hasher.finish();
        policy
    }

    pub fn is_sensitive(&self, path: &Path) -> bool {
        if is_hard_sensitive_path(path) {
            return true;
        }
        let path = absolute(path, &self.root);
        self.sensitive.iter().any(|m| {
            let Some(rel) = strip_base_prefix(&path, &m.base) else {
                return false;
            };
            if rel.as_os_str().is_empty() {
                return false;
            }
            m.matcher
                .matched_path_or_any_parents(&rel, path.is_dir())
                .is_ignore()
        })
    }

    pub fn is_noise_ignored(&self, path: &Path) -> bool {
        matches!(
            best_noise_match(&self.noise, &self.root, path),
            Some((true, _))
        )
    }

    pub fn is_ignored_for_graph(&self, path: &Path) -> bool {
        self.is_sensitive(path) || self.is_noise_ignored(path)
    }

    /// Cheap path-specific graph ignore check: fast scopes plus nested rules in
    /// the target's own ancestors. Used by the agent fast-patch path so an edit
    /// to a nested-ignored file cannot bypass the graph policy.
    pub fn is_ignored_at(root: &Path, path: &Path) -> bool {
        let root = canonical_root(root);
        let mut policy = Self::load(&root);
        policy.add_nested_ancestor_matchers(path, &root);
        policy.is_ignored_for_graph(path)
    }

    /// Cheap path-specific sensitive check for explicit reads: root/global
    /// `.graph` rules plus `.graph` files in the target's own ancestors. Avoids
    /// a full nested-policy directory scan on every `read`.
    pub fn is_sensitive_at(root: &Path, path: &Path) -> bool {
        let root = canonical_root(root);
        let mut policy = Self::load(&root);
        policy.add_nested_ancestor_matchers(path, &root);
        policy.is_sensitive(path)
    }

    fn add_nested_ancestor_matchers(&mut self, path: &Path, root: &Path) {
        let path = absolute(path, root);
        if strip_base_prefix(&path, root).is_none() {
            return;
        }
        let mut current = path.parent();
        while let Some(dir) = current {
            if dir == root || strip_base_prefix(dir, root).is_none() {
                break;
            }
            for (name, sensitive) in [
                (".codegraphignore", false),
                (".codegraignore", false),
                (".codegraphignore.graph", true),
                (".codegraignore.graph", true),
            ] {
                let source = dir.join(name);
                if !source.is_file() {
                    continue;
                }
                let mut builder = GitignoreBuilder::new(dir);
                if builder.add(&source).is_some() {
                    continue;
                }
                if let Ok(matcher) = builder.build() {
                    let scoped = ScopedMatcher {
                        base: dir.to_path_buf(),
                        order: 100 + dir.components().count(),
                        source,
                        matcher,
                    };
                    if sensitive {
                        self.sensitive.push(scoped);
                    } else {
                        self.noise.push(scoped);
                    }
                }
            }
            current = dir.parent();
        }
    }

    #[allow(dead_code)]
    pub fn is_ignored_for_search(&self, path: &Path, include_ignored: bool) -> bool {
        self.is_sensitive(path) || (!include_ignored && self.is_noise_ignored(path))
    }

    /// Explicit reads bypass noise rules; only the sensitive gate applies.
    #[allow(dead_code)]
    pub fn is_explicit_read_blocked(&self, path: &Path) -> bool {
        self.is_sensitive(path)
    }

    /// Explain the highest-precedence decision for diagnostics / hints.
    #[allow(dead_code)]
    pub fn explain(
        &self,
        path: &Path,
        profile: VisibilityProfile,
    ) -> Option<(IgnoreKind, PathBuf)> {
        let path = absolute(path, &self.root);
        if let Some((_, source)) = self.best_sensitive_match(&path) {
            return Some((IgnoreKind::Sensitive, source));
        }
        if profile == VisibilityProfile::ExplicitRead {
            return None;
        }
        match best_noise_match(&self.noise, &self.root, &path) {
            Some((true, source)) => Some((IgnoreKind::Noise, source)),
            _ => None,
        }
    }

    fn best_sensitive_match(&self, path: &Path) -> Option<(bool, PathBuf)> {
        let mut best: Option<(usize, usize, bool, PathBuf)> = None;
        for m in &self.sensitive {
            let Some(rel) = strip_base_prefix(path, &m.base) else {
                continue;
            };
            if rel.as_os_str().is_empty() {
                continue;
            }
            let matched = m.matcher.matched_path_or_any_parents(&rel, path.is_dir());
            if !matched.is_ignore() {
                continue;
            }
            let key = (m.base.components().count(), m.order);
            if best
                .as_ref()
                .map_or(true, |(depth, order, _, _)| key > (*depth, *order))
            {
                best = Some((key.0, key.1, true, m.source.clone()));
            }
        }
        best.map(|(_, _, ignore, source)| (ignore, source))
    }
}

fn best_noise_match(
    matchers: &[ScopedMatcher],
    root: &Path,
    path: &Path,
) -> Option<(bool, PathBuf)> {
    let path = absolute(path, root);
    let mut best: Option<(usize, usize, bool, PathBuf)> = None;
    for m in matchers {
        let Some(rel) = strip_base_prefix(&path, &m.base) else {
            continue;
        };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let matched = m.matcher.matched_path_or_any_parents(&rel, path.is_dir());
        if !matched.is_ignore() && !matched.is_whitelist() {
            continue;
        }
        let key = (m.base.components().count(), m.order);
        if best
            .as_ref()
            .map_or(true, |(depth, order, _, _)| key > (*depth, *order))
        {
            best = Some((key.0, key.1, matched.is_ignore(), m.source.clone()));
        }
    }
    best.map(|(_, _, ignore, source)| (ignore, source))
}

fn absolute(path: &Path, root: &Path) -> PathBuf {
    let raw = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    crate::pathnorm::lexical_normalize(&raw)
}

fn strip_base_prefix<'a>(path: &'a Path, base: &Path) -> Option<std::borrow::Cow<'a, Path>> {
    if let Ok(rel) = path.strip_prefix(base) {
        return Some(std::borrow::Cow::Borrowed(rel));
    }
    if let (Ok(c_path), Ok(c_base)) = (path.canonicalize(), base.canonicalize()) {
        let stripped_path = crate::pathnorm::strip_verbatim_path(&c_path);
        let stripped_base = crate::pathnorm::strip_verbatim_path(&c_base);
        if let Ok(rel) = stripped_path.strip_prefix(&stripped_base) {
            return Some(std::borrow::Cow::Owned(rel.to_path_buf()));
        }
    }
    None
}

/// Hard credential paths shared by graph indexing, grep/glob and the explicit
/// read gate. `.codegraphignore.graph` adds user/project rules on top; this is
/// the baseline that must still hold when that file is absent or edited.
pub fn is_hard_sensitive_path(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if name == ".env" || (name.starts_with(".env.") && !is_env_template(&name)) {
        return true;
    }
    if matches!(
        name.as_str(),
        "id_rsa"
            | "id_dsa"
            | "id_ecdsa"
            | "id_ed25519"
            | ".npmrc"
            | ".pypirc"
            | ".netrc"
            | ".git-credentials"
            | ".htpasswd"
    ) {
        return true;
    }
    if path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            matches!(
                e.to_ascii_lowercase().as_str(),
                "pem" | "key" | "p12" | "pfx" | "der" | "crt" | "cer"
            )
        })
        .unwrap_or(false)
    {
        return true;
    }
    if name == "auth.toml"
        && path.components().any(|c| {
            c.as_os_str()
                .to_str()
                .is_some_and(|s| s.eq_ignore_ascii_case(".jeikcode"))
        })
    {
        return true;
    }
    if let Some(home) = crate::pathutil::home_dir() {
        for dir in [".ssh", ".aws", ".gnupg"] {
            if path.starts_with(home.join(dir)) {
                return true;
            }
        }
    }
    false
}

fn is_env_template(name: &str) -> bool {
    [
        ".env.example",
        ".env.sample",
        ".env.template",
        ".env.dist",
        ".env.defaults",
    ]
    .contains(&name)
}

fn canonical_root(root: &Path) -> PathBuf {
    crate::pathnorm::lexical_normalize(root)
}

fn fingerprint_file(hasher: &mut DefaultHasher, path: &Path) {
    path.hash(hasher);
    if let Ok(md) = std::fs::metadata(path) {
        md.len().hash(hasher);
        if let Ok(t) = md.modified() {
            if let Ok(d) = t.duration_since(std::time::UNIX_EPOCH) {
                d.as_nanos().hash(hasher);
            }
        }
    }
}

fn policy_source_signature(root: &Path, cfg: &Path) -> u64 {
    let mut hasher = DefaultHasher::new();
    "jeikcode-ignore-policy-v1".hash(&mut hasher);
    let mut paths = Vec::new();
    for (dir, _) in [
        (cfg.to_path_buf(), 0usize),
        (root.to_path_buf(), 1usize),
        (root.join(".jeikcode"), 2usize),
    ] {
        for name in [
            ".codegraphignore",
            ".codegraignore",
            ".codegraphignore.graph",
            ".codegraignore.graph",
        ] {
            let path = dir.join(name);
            if path.is_file() {
                paths.push(path);
            }
        }
    }
    paths.sort();
    paths.dedup();
    for path in paths {
        fingerprint_file(&mut hasher, &path);
    }
    hasher.finish()
}

fn fast_policy_cache() -> &'static Mutex<HashMap<PathBuf, (u64, IgnorePolicy)>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (u64, IgnorePolicy)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Nested ignore files under `root` (depth > 0). The project `.jeikcode`
/// directory is loaded by [`IgnorePolicy::load`] already; VCS/build/vendor trees
/// are skipped so this stays a directory-only scan.
fn nested_ignore_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .ignore(false);
    builder.filter_entry(|e| {
        if e.depth() == 0 {
            return true;
        }
        let Some(name) = e.file_name().to_str() else {
            return false;
        };
        if is_nested_skip_dir(name) {
            return false;
        }
        e.file_type().map(|t| t.is_dir()).unwrap_or(false)
    });
    for entry in builder.build().flatten() {
        if entry.depth() == 0 {
            continue;
        }
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        for name in [
            ".codegraphignore",
            ".codegraignore",
            ".codegraphignore.graph",
            ".codegraignore.graph",
        ] {
            let path = entry.path().join(name);
            if path.is_file() {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

fn is_nested_skip_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".jeikcode"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | "vendor"
            | "__pycache__"
            | ".venv"
            | "venv"
            | ".next"
            | ".cache"
            | ".idea"
            | ".vscode"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_root_rule_can_be_reopened_by_jeikcode() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(".codegraphignore"), "noise.txt\n").unwrap();
        std::fs::create_dir_all(d.path().join(".jeikcode")).unwrap();
        std::fs::write(
            d.path().join(".jeikcode").join(".codegraphignore"),
            "!noise.txt\n",
        )
        .unwrap();
        let policy = IgnorePolicy::load(d.path());
        assert!(
            !policy.is_noise_ignored(&d.path().join("noise.txt")),
            "project .jeikcode must override project-root noise rules"
        );
    }

    #[test]
    fn sensitive_rules_are_a_separate_hard_gate() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(".codegraphignore"), "!.env\n").unwrap();
        std::fs::write(d.path().join(".codegraphignore.graph"), ".env\n").unwrap();
        let policy = IgnorePolicy::load(d.path());
        let env = d.path().join(".env");
        assert!(policy.is_sensitive(&env));
        assert!(
            policy.is_ignored_for_graph(&env),
            "graph must stay indexed-out even when noise re-opens it"
        );
        assert!(
            policy.is_explicit_read_blocked(&env),
            "explicit read must hit the sensitive gate"
        );
    }

    #[test]
    fn path_specific_sensitive_check_sees_nested_rule() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("sub")).unwrap();
        std::fs::write(
            d.path().join("sub").join(".codegraphignore.graph"),
            "secret.txt\n",
        )
        .unwrap();
        std::fs::write(d.path().join("sub/secret.txt"), "x").unwrap();
        assert!(IgnorePolicy::is_sensitive_at(
            d.path(),
            &d.path().join("sub/secret.txt")
        ));
    }

    #[test]
    fn hard_sensitive_baseline_is_independent_of_graph_file() {
        let d = tempfile::tempdir().unwrap();
        let auth = d.path().join(".jeikcode").join("auth.toml");
        assert!(is_hard_sensitive_path(&d.path().join(".env.local")));
        assert!(is_hard_sensitive_path(&auth));
        assert!(is_hard_sensitive_path(&d.path().join("server.pem")));
        assert!(!is_hard_sensitive_path(&d.path().join(".env.example")));
        assert!(!is_hard_sensitive_path(&d.path().join("src/main.rs")));
    }

    #[test]
    fn nested_rule_reopens_parent_noise_rule() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(".codegraphignore"), "sub/keep.rs\n").unwrap();
        std::fs::create_dir_all(d.path().join("sub")).unwrap();
        std::fs::write(d.path().join("sub").join(".codegraphignore"), "!keep.rs\n").unwrap();
        let file = d.path().join("sub/keep.rs");
        assert!(
            IgnorePolicy::load(d.path()).is_noise_ignored(&file),
            "fast policy sees only the parent rule"
        );
        assert!(
            !IgnorePolicy::load_deep(d.path()).is_noise_ignored(&file),
            "nested whitelist must win over the parent rule"
        );
    }

    #[test]
    fn nested_sensitive_rule_is_loaded_by_deep_policy() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("sub")).unwrap();
        std::fs::write(
            d.path().join("sub").join(".codegraphignore.graph"),
            "secret.txt\n",
        )
        .unwrap();
        std::fs::write(d.path().join("sub/secret.txt"), "x").unwrap();
        assert!(
            IgnorePolicy::load_deep(d.path()).is_sensitive(&d.path().join("sub/secret.txt")),
            "nested .graph must be visible to the deep policy"
        );
    }

    #[test]
    fn ignore_fingerprint_changes_when_rule_changes() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join(".codegraphignore");
        std::fs::write(&f, "a.rs\n").unwrap();
        let first = IgnorePolicy::load(d.path()).fingerprint();
        std::fs::write(&f, "a.rs\nb.rs\n").unwrap();
        let second = IgnorePolicy::load(d.path()).fingerprint();
        assert_ne!(first, second);
    }
}
