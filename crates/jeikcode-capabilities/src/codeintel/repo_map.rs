//! `repo_map` — high-density 2-level architectural codebase tree map.
//!
//! Index-backed: reuses the shared [`CodeIndex`] the graph tools hold, so the
//! directory tree shows EXACTLY the files `code_explore` can
//! resolve — one source of truth, never a separate (and drifting) walk.
//!
//! Exposes a clean 2-level directory tree overview:
//! - Level 1: Subdirectories and root files (up to a readable ceiling).
//! - Level 2: Subdirectories under Level 1.
//! - Anything deeper than Level 2 is summarized with concise counts: `(X files, Y subdirs)`.

use super::index::CodeIndex;
use super::{err, ok};
use async_trait::async_trait;
use jeikcode_kernel::tool::{Tool, ToolContext, ToolResult};
use serde::Deserialize;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub struct RepoMapTool {
    index: Arc<CodeIndex>,
}

impl RepoMapTool {
    pub fn new(index: Arc<CodeIndex>) -> Self {
        Self { index }
    }
}

#[derive(Deserialize)]
struct Args {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    _max_files: Option<usize>,
    #[serde(default)]
    _mode: Option<String>,
}

#[async_trait]
impl Tool for RepoMapTool {
    fn name(&self) -> &str {
        "repo_map"
    }

    fn description(&self) -> &str {
        "Generate codebase 2-level architectural directory tree structure overview."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "default": ".",
                    "description": "Target directory to map: workspace root ('.') or specific module/subdirectory."
                }
            }
        })
    }

    fn read_only_hint(&self) -> bool {
        true
    }

    fn never_truncate_result(&self) -> bool {
        true
    }

    async fn execute(&self, args: &str, ctx: &ToolContext) -> ToolResult {
        let t0 = std::time::Instant::now();
        let a: Args = match serde_json::from_str(args) {
            Ok(a) => a,
            Err(_) => Args {
                path: None,
                _max_files: None,
                _mode: None,
            },
        };

        let target_dir = match a.path {
            Some(ref p) if !p.trim().is_empty() => {
                let resolved = crate::pathutil::resolve_path(p, &ctx.working_dir);
                crate::pathnorm::canonicalize(&resolved).unwrap_or(resolved)
            }
            _ => crate::pathnorm::canonicalize(&ctx.working_dir)
                .unwrap_or_else(|_| ctx.working_dir.clone()),
        };

        if !target_dir.exists() {
            return err(format!(
                "repo_map: target directory does not exist: {}",
                target_dir.display()
            ));
        }

        let working_dir = ctx.working_dir.clone();
        let _log_guard = super::index_log::ToolCallGuard::enter(
            "repo_map",
            json!({
                "path": a.path,
            }),
        );
        let index = self.index.clone();
        let log_root = working_dir.clone();

        let result =
            tokio::task::spawn_blocking(move || build_repo_map(&index, &target_dir, &working_dir))
                .await;

        match result {
            Ok(content) => {
                let cost_time = t0.elapsed();
                let stats = self.index.last_stats(&log_root);
                super::index_log::log_tool_call(
                    &log_root,
                    json!({
                        "outcome": "ok",
                        "total_ms": cost_time.as_millis() as u64,
                        "result_chars": content.len(),
                        "cache_hit": stats.as_ref().map(|s| s.cache_hit),
                        "reparsed": stats.as_ref().map(|s| s.reparsed),
                    }),
                );
                ok(format!(
                    "> ⏱️ **Cost Time**: {}ms\n\n{content}",
                    cost_time.as_millis()
                ))
            }
            Err(e) => err(format!("repo_map execution failed: {e}")),
        }
    }
}

pub(crate) fn path_within(p: &Path, dir: &Path) -> bool {
    let norm = |x: &Path| {
        let s = x.to_string_lossy();
        let s = if let Some(rest) = s.strip_prefix(r"\\?\") {
            rest
        } else {
            &s
        };
        s.replace('/', "\\").to_ascii_lowercase()
    };
    let p_n = norm(p);
    let d_n = norm(dir).trim_end_matches('\\').to_string();
    p_n.starts_with(&d_n) && (p_n.len() == d_n.len() || p_n[d_n.len()..].starts_with('\\'))
}

pub(crate) fn rel_path(p: &Path, root: &Path) -> Option<PathBuf> {
    let norm = |x: &Path| {
        let s = x.to_string_lossy();
        let s = if let Some(rest) = s.strip_prefix(r"\\?\") {
            rest
        } else {
            &s
        };
        s.replace('/', "\\").to_ascii_lowercase()
    };
    let p_n = norm(p);
    let r_n = norm(root).trim_end_matches('\\').to_string();
    if !(p_n.starts_with(&r_n) && (p_n.len() == r_n.len() || p_n[r_n.len()..].starts_with('\\'))) {
        return None;
    }
    let s = p.to_string_lossy();
    let s = if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest
    } else {
        &s
    };
    let rest = s[r_n.len()..].trim_start_matches(['\\', '/']);
    if rest.is_empty() {
        return None;
    }
    Some(PathBuf::from(rest))
}

/// Render a clean 2-level architectural codebase tree from CodeIndex.
/// - Level 1 subdirectories are listed with 0-indent.
/// - Level 2 subdirectories are listed with 2-space indent.
/// - Deeper content under Level 2 is summarized with numbers: `(X files, Y subdirs)` (or `(X files)`).
/// - Direct root files are listed in full (up to 40 files).
pub fn render_two_level_tree_from_index(
    index: &CodeIndex,
    target_dir: &Path,
    working_dir: &Path,
) -> Option<String> {
    let graph = index.get(working_dir);
    let mut files: Vec<PathBuf> = graph.file_symbols.keys().cloned().collect();
    if target_dir != working_dir {
        files.retain(|p| {
            let full = if p.is_absolute() {
                p.clone()
            } else {
                working_dir.join(p)
            };
            path_within(&full, target_dir) || path_within(p, target_dir)
        });
    }

    if files.is_empty() {
        return None;
    }

    #[derive(Default)]
    struct L2Summary {
        file_count: usize,
        subdirs: BTreeSet<String>,
    }

    #[derive(Default)]
    struct L1Dir {
        direct_files: Vec<String>,
        l2_dirs: BTreeMap<String, L2Summary>,
    }

    let mut root_files: Vec<String> = Vec::new();
    let mut l1_dirs: BTreeMap<String, L1Dir> = BTreeMap::new();

    for p in &files {
        let Some(rel) = rel_path(p, target_dir) else {
            continue;
        };
        let s = rel.to_string_lossy();
        let comps: Vec<String> = s
            .split(['\\', '/'])
            .filter(|c| !c.is_empty())
            .map(str::to_string)
            .collect();
        if comps.is_empty() {
            continue;
        }

        if comps.len() == 1 {
            // Level 1 direct file under target_dir
            root_files.push(comps[0].clone());
        } else if comps.len() == 2 {
            // File directly inside Level 1 directory (e.g. `crates/README.md`)
            let l1 = l1_dirs.entry(comps[0].clone()).or_default();
            l1.direct_files.push(comps[1].clone());
        } else {
            // comps.len() >= 3: Inside a Level 2 directory (e.g. `crates/kernel/src/lib.rs`)
            let l1 = l1_dirs.entry(comps[0].clone()).or_default();
            let l2 = l1.l2_dirs.entry(comps[1].clone()).or_default();
            l2.file_count += 1;
            if comps.len() >= 4 {
                // Deeper subdirectory inside Level 2
                l2.subdirs.insert(comps[2].clone());
            }
        }
    }

    root_files.sort();

    let display_path = crate::pathnorm::to_display(target_dir);
    let mut out = String::new();
    out.push_str(&format!(
        "[Directory: {display_path} (2-level architecture overview, {} indexed files)]\n\n",
        files.len()
    ));

    // Render L1 directories first
    for (l1_name, l1_content) in &l1_dirs {
        out.push_str(&format!("{l1_name}/\n"));

        // Render L2 directories under L1
        for (l2_name, l2_summary) in &l1_content.l2_dirs {
            out.push_str(&format!("  {l2_name}/\n"));
            let summary_str = if l2_summary.file_count > 0 && !l2_summary.subdirs.is_empty() {
                let s_plural = if l2_summary.subdirs.len() == 1 {
                    ""
                } else {
                    "s"
                };
                let f_plural = if l2_summary.file_count == 1 { "" } else { "s" };
                format!(
                    "({} file{f_plural}, {} subdir{s_plural})",
                    l2_summary.file_count,
                    l2_summary.subdirs.len()
                )
            } else if l2_summary.file_count > 0 {
                let f_plural = if l2_summary.file_count == 1 { "" } else { "s" };
                format!("({} file{f_plural})", l2_summary.file_count)
            } else if !l2_summary.subdirs.is_empty() {
                let s_plural = if l2_summary.subdirs.len() == 1 {
                    ""
                } else {
                    "s"
                };
                format!("({} subdir{s_plural})", l2_summary.subdirs.len())
            } else {
                "(empty)".to_string()
            };
            out.push_str(&format!("    {summary_str}\n"));
        }

        // Render L1 direct files
        if !l1_content.direct_files.is_empty() {
            let mut sorted_files = l1_content.direct_files.clone();
            sorted_files.sort();
            if sorted_files.len() <= 6 {
                for f in &sorted_files {
                    out.push_str(&format!("  {f}\n"));
                }
            } else {
                out.push_str(&format!("  ({} files)\n", sorted_files.len()));
            }
        }
    }

    // Render Root direct files
    if !root_files.is_empty() {
        if root_files.len() <= 40 {
            for f in &root_files {
                out.push_str(&format!("{f}\n"));
            }
        } else {
            for f in root_files.iter().take(30) {
                out.push_str(&format!("{f}\n"));
            }
            out.push_str(&format!("... (and {} more files)\n", root_files.len() - 30));
        }
    }

    out.push_str("\n[Tip: Call read(path=\"<subdir>\") to explore deeper, or code_explore to trace cross-module symbols/flows.]");

    Some(out.trim_end().to_string())
}

fn build_repo_map(index: &CodeIndex, target_dir: &Path, working_dir: &Path) -> String {
    if let Some(rendered) = render_two_level_tree_from_index(index, target_dir, working_dir) {
        return rendered;
    }

    if !super::has_nonempty_codegraph(working_dir) && !super::has_nonempty_codegraph(target_dir) {
        return super::no_codegraph_tool_guidance().to_string();
    }
    "(no indexed source files found in target directory)".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_two_level_tree_overview() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();

        // Level 1 root files
        std::fs::write(root.join("Cargo.toml"), "[package]\n").unwrap();
        std::fs::write(root.join("README.md"), "# Hello\n").unwrap();

        // Level 1 subdirs + Level 2 subdirs + deeper files
        let kernel_src = root.join("crates/kernel/src");
        std::fs::create_dir_all(&kernel_src).unwrap();
        std::fs::write(kernel_src.join("lib.rs"), "pub fn run() {}\n").unwrap();
        std::fs::write(kernel_src.join("agent.rs"), "pub struct Agent;\n").unwrap();

        let index = Arc::new(CodeIndex::new());
        let _ = index.build(root);

        let output = build_repo_map(&index, root, root);
        assert!(output.contains("2-level architecture overview"), "{output}");
        assert!(output.contains("crates/"), "{output}");
        assert!(output.contains("kernel/"), "{output}");
        // Level 2 under kernel/src is aggregated into (2 files, 1 subdir)
        assert!(output.contains("files"), "{output}");
        assert!(output.contains("Cargo.toml"), "{output}");
        assert!(output.contains("README.md"), "{output}");
    }

    #[tokio::test]
    async fn test_scoped_submodule_two_level_tree() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();

        let kernel = root.join("crates/kernel");
        let kernel_src = kernel.join("src");
        let kernel_tests = kernel.join("tests");
        std::fs::create_dir_all(&kernel_src).unwrap();
        std::fs::create_dir_all(&kernel_tests).unwrap();
        std::fs::write(kernel.join("Cargo.toml"), "[package]\n").unwrap();
        std::fs::write(kernel_src.join("lib.rs"), "pub fn k() {}\n").unwrap();
        std::fs::write(kernel_tests.join("test.rs"), "fn t() {}\n").unwrap();

        let index = Arc::new(CodeIndex::new());
        let _ = index.build(root);

        let output = build_repo_map(&index, &kernel, root);
        assert!(output.contains("src/"), "{output}");
        assert!(output.contains("tests/"), "{output}");
        assert!(output.contains("Cargo.toml"), "{output}");
    }
}
