//! Cross-file code graph: symbol nodes + call edges, with BFS traversal. Ported from
//! production `graph/mod.rs` (the model + traversal the 5 graph tools need; persistence,
//! incremental remove_file, and the summary helpers are omitted — not used here).
//!
//! EDGE CONVENTION (load-bearing, from production): `edges_out[from]` holds `Edge{to:
//! callee}` (forward); `edges_in[to]` holds `Edge{to: from}` — i.e. in the reverse map
//! the `to` field stores the SOURCE (caller). Do not "fix" this.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};

pub type SymbolId = u64;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SymbolKind {
    Function,
    Method,
    Struct,
    Class,
    Trait,
    Interface,
    Enum,
    Constant,
    Variable,
    Property,
    Module,
    Import,
    TypeAlias,
    RouteEndpoint,
    SqlStatement,
    ConfigProperty,
    PluginDeclaration,
    Middleware,
    UiElement,
    Other(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Visibility {
    Public,
    Private,
    Protected,
    Internal,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CommentScope {
    BranchInline { branch_kind: String },
    Docstring,
    MethodHeader,
    PropertyDoc,
    PlainInline,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StructuredComment {
    pub text: String,
    pub scope: CommentScope,
    pub line: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SqlPredicate {
    pub raw_clause: String,
    pub target_fields: Vec<String>,
    pub line: usize,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AstMetrics {
    #[serde(default)]
    pub cyclomatic_complexity: usize,
    #[serde(default)]
    pub branch_count: usize,
    #[serde(default)]
    pub has_sql_or_qs: bool,
    #[serde(default)]
    pub is_pure_dto: bool,
    #[serde(default)]
    pub is_active_logic: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SymbolNode {
    pub id: SymbolId,
    pub name: String,
    pub kind: SymbolKind,
    pub visibility: Visibility,
    pub file: PathBuf,
    pub start_line: usize,
    pub end_line: usize,
    pub signature: Option<String>,
    #[serde(default)]
    pub docstring: Option<String>,
    #[serde(default)]
    pub inline_comments: Vec<String>,
    #[serde(default)]
    pub comments: Vec<StructuredComment>,
    #[serde(default)]
    pub sql_predicates: Vec<SqlPredicate>,
    #[serde(default)]
    pub string_literals: Vec<String>,
    #[serde(default)]
    pub metrics: AstMetrics,
}

impl Default for SymbolNode {
    fn default() -> Self {
        Self {
            id: 0,
            name: String::new(),
            kind: SymbolKind::Other("unknown".to_string()),
            visibility: Visibility::Unknown,
            file: PathBuf::new(),
            start_line: 0,
            end_line: 0,
            signature: None,
            docstring: None,
            inline_comments: Vec::new(),
            comments: Vec::new(),
            sql_predicates: Vec::new(),
            string_literals: Vec::new(),
            metrics: AstMetrics::default(),
        }
    }
}

impl SymbolNode {
    pub fn new(
        id: SymbolId,
        name: String,
        kind: SymbolKind,
        visibility: Visibility,
        file: PathBuf,
        start_line: usize,
        end_line: usize,
    ) -> Self {
        Self {
            id,
            name,
            kind,
            visibility,
            file,
            start_line,
            end_line,
            signature: None,
            docstring: None,
            inline_comments: Vec::new(),
            comments: Vec::new(),
            sql_predicates: Vec::new(),
            string_literals: Vec::new(),
            metrics: AstMetrics::default(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EdgeKind {
    Calls,
    Imports,
    Inherits,
    Implements,
    References,
    HttpDispatches,
    MapperBinds,
    ConfigBinds,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Edge {
    pub to: SymbolId,
    pub kind: EdgeKind,
    pub line: usize,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CodeGraph {
    pub nodes: HashMap<SymbolId, SymbolNode>,
    pub edges_out: HashMap<SymbolId, Vec<Edge>>,
    pub edges_in: HashMap<SymbolId, Vec<Edge>>,
    pub file_symbols: HashMap<PathBuf, Vec<SymbolId>>,
    pub file_mtimes: HashMap<PathBuf, u64>,
    /// name → symbol ids. Derivable from `nodes`; `#[serde(skip)]` keeps it out of any
    /// serialized form, so `rebuild_name_index` must be called after a deserialize.
    /// Lets `find_by_name` be O(candidates) instead of an O(nodes) scan.
    #[serde(skip)]
    pub by_name: HashMap<String, Vec<SymbolId>>,
}

impl CodeGraph {
    pub fn new() -> Self {
        Self::default()
    }

    /// Deterministic id from (file, name, start_line) — stable across runs.
    pub fn make_id(file: &Path, name: &str, start_line: usize) -> SymbolId {
        let mut h = DefaultHasher::new();
        file.hash(&mut h);
        name.hash(&mut h);
        start_line.hash(&mut h);
        h.finish()
    }

    pub fn add_symbol(&mut self, node: SymbolNode) {
        let id = node.id;
        let file = node.file.clone();
        self.by_name.entry(node.name.clone()).or_default().push(id);
        self.nodes.insert(id, node);
        self.file_symbols.entry(file).or_default().push(id);
    }

    pub fn add_edge(&mut self, from: SymbolId, edge: Edge) {
        let to = edge.to;
        let kind = edge.kind.clone();
        let line = edge.line;
        self.edges_out.entry(from).or_default().push(edge);
        // reverse map stores the SOURCE in `to` (production convention).
        self.edges_in.entry(to).or_default().push(Edge {
            to: from,
            kind,
            line,
        });
    }

    pub fn node(&self, id: SymbolId) -> Option<&SymbolNode> {
        self.nodes.get(&id)
    }
    pub fn symbols_in_file(&self, file: &Path) -> Option<&Vec<SymbolId>> {
        if let Some(ids) = self.file_symbols.get(file) {
            return Some(ids);
        }
        let key = self.resolve_file_key(file)?;
        self.file_symbols.get(&key)
    }

    /// Locate the `file_symbols` key that refers to the same on-disk file,
    /// tolerating slash / drive-letter drift between the walker and editors.
    fn resolve_file_key(&self, file: &Path) -> Option<PathBuf> {
        if self.file_symbols.contains_key(file) {
            return Some(file.to_path_buf());
        }
        // Ưu tiên identity lexical đã lưu; chỉ resolve alias khi không tìm thấy.
        let lexical = normalize_path_cmp(file);
        if let Some(key) = self
            .file_symbols
            .keys()
            .find(|k| normalize_path_cmp(k) == lexical)
        {
            return Some(key.clone());
        }
        // Resolve only the query: scanning graph keys must never do filesystem I/O.
        #[cfg(windows)]
        let identity = crate::pathnorm::codeintel_path(file);
        #[cfg(not(windows))]
        let identity = crate::pathnorm::canonicalize(file).unwrap_or_else(|_| file.to_path_buf());
        let resolved = normalize_path_cmp(&identity);
        self.file_symbols
            .keys()
            .find(|k| normalize_path_cmp(k) == resolved)
            .cloned()
    }
    pub fn callees(&self, id: SymbolId) -> Option<&Vec<Edge>> {
        self.edges_out.get(&id)
    }
    pub fn callers(&self, id: SymbolId) -> Option<&Vec<Edge>> {
        self.edges_in.get(&id)
    }
    pub fn find_by_name(&self, name: &str) -> Vec<&SymbolNode> {
        match self.by_name.get(name) {
            Some(ids) => ids.iter().filter_map(|id| self.nodes.get(id)).collect(),
            None => Vec::new(),
        }
    }

    /// Rebuild `by_name` from `nodes`. Call after constructing a graph by any path that
    /// bypasses `add_symbol` (e.g. a serde deserialize, which skips `by_name`).
    pub fn rebuild_name_index(&mut self) {
        self.by_name.clear();
        for (id, node) in &self.nodes {
            self.by_name.entry(node.name.clone()).or_default().push(*id);
        }
    }

    pub fn remove_symbol(&mut self, id: SymbolId) {
        if let Some(node) = self.nodes.remove(&id) {
            if let Some(ids) = self.by_name.get_mut(&node.name) {
                ids.retain(|&x| x != id);
            }
            if let Some(ids) = self.file_symbols.get_mut(&node.file) {
                ids.retain(|&x| x != id);
            }
            // remove outgoing edges from id
            if let Some(outs) = self.edges_out.remove(&id) {
                for edge in outs {
                    if let Some(ins) = self.edges_in.get_mut(&edge.to) {
                        ins.retain(|e| e.to != id);
                    }
                }
            }
            // remove incoming edges to id
            if let Some(ins) = self.edges_in.remove(&id) {
                for edge in ins {
                    if let Some(outs) = self.edges_out.get_mut(&edge.to) {
                        outs.retain(|e| e.to != id);
                    }
                }
            }
        }
    }

    pub fn remove_file(&mut self, file: &Path) {
        let key = self
            .resolve_file_key(file)
            .unwrap_or_else(|| file.to_path_buf());
        if let Some(ids) = self.file_symbols.get(&key).cloned() {
            for id in ids {
                self.remove_symbol(id);
            }
        }
        self.file_symbols.remove(&key);
        self.file_mtimes.remove(&key);
        if key != file {
            self.file_symbols.remove(file);
            self.file_mtimes.remove(file);
        }
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// BFS over incoming edges (who calls `id`), up to `max_depth`. Returns
    /// (caller_id, depth) pairs, deduped.
    pub fn trace_callers(&self, id: SymbolId, max_depth: usize) -> Vec<(SymbolId, usize)> {
        self.trace(id, max_depth, true)
    }
    /// BFS over outgoing edges (what `id` calls), up to `max_depth`.
    pub fn trace_callees(&self, id: SymbolId, max_depth: usize) -> Vec<(SymbolId, usize)> {
        self.trace(id, max_depth, false)
    }
    fn trace(&self, id: SymbolId, max_depth: usize, callers: bool) -> Vec<(SymbolId, usize)> {
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        let mut result = Vec::new();
        visited.insert(id);
        queue.push_back((id, 0usize));
        while let Some((cur, depth)) = queue.pop_front() {
            if depth >= max_depth {
                continue;
            }
            let edges = if callers {
                self.callers(cur)
            } else {
                self.callees(cur)
            };
            if let Some(edges) = edges {
                for e in edges {
                    if visited.insert(e.to) {
                        result.push((e.to, depth + 1));
                        queue.push_back((e.to, depth + 1));
                    }
                }
            }
        }
        result
    }

    /// Shortest forward call path `from → … → to` (BFS, ≤10 hops). Includes both ends.
    pub fn shortest_path(&self, from: SymbolId, to: SymbolId) -> Option<Vec<SymbolId>> {
        if from == to {
            return Some(vec![from]);
        }
        const MAX_HOPS: usize = 10;
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        let mut parent: HashMap<SymbolId, SymbolId> = HashMap::new();
        visited.insert(from);
        queue.push_back((from, 0usize));
        while let Some((cur, depth)) = queue.pop_front() {
            if depth >= MAX_HOPS {
                continue;
            }
            if let Some(edges) = self.callees(cur) {
                for e in edges {
                    if visited.insert(e.to) {
                        parent.insert(e.to, cur);
                        if e.to == to {
                            let mut path = vec![to];
                            let mut c = to;
                            while let Some(&p) = parent.get(&c) {
                                path.push(p);
                                c = p;
                            }
                            path.reverse();
                            return Some(path);
                        }
                        queue.push_back((e.to, depth + 1));
                    }
                }
            }
        }
        None
    }

    /// Files (other than `file`) whose symbols transitively call into `file`'s symbols.
    pub fn file_dependents(&self, file: &Path, max_depth: usize) -> Vec<PathBuf> {
        let fb = file.to_path_buf();
        let ids = match self.file_symbols.get(&fb) {
            Some(i) => i.clone(),
            None => return Vec::new(),
        };
        let mut deps = HashSet::new();
        for sid in ids {
            for (cid, _) in self.trace_callers(sid, max_depth) {
                if let Some(n) = self.node(cid) {
                    if n.file != fb {
                        deps.insert(n.file.clone());
                    }
                }
            }
        }
        deps.into_iter().collect()
    }

    /// Extract an architectural capability capsule summarizing top types, pipelines, and plugins in a file.
    pub fn file_capsule(&self, file: &Path) -> Vec<String> {
        let mut out = Vec::new();
        let mut types = Vec::new();
        let mut pipelines = Vec::new();
        let mut plugins = Vec::new();

        if let Some(ids) = self.file_symbols.get(file) {
            for &id in ids {
                if let Some(node) = self.node(id) {
                    match node.kind {
                        SymbolKind::Struct
                        | SymbolKind::Class
                        | SymbolKind::Trait
                        | SymbolKind::Interface
                        | SymbolKind::Enum => {
                            types.push(format!("{}:L{}", node.name, node.start_line));
                        }
                        SymbolKind::Function
                        | SymbolKind::Method
                        | SymbolKind::Middleware
                        | SymbolKind::RouteEndpoint => {
                            pipelines.push(format!("{}:L{}", node.name, node.start_line));
                        }
                        SymbolKind::PluginDeclaration | SymbolKind::ConfigProperty => {
                            plugins.push(format!("{}:L{}", node.name, node.start_line));
                        }
                        _ => {}
                    }
                }
            }
        }

        if !types.is_empty() {
            out.push(format!(
                "**Types/Traits**: {}",
                types.iter().take(6).cloned().collect::<Vec<_>>().join(", ")
            ));
        }
        if !pipelines.is_empty() {
            out.push(format!(
                "**Pipelines/Methods**: {}",
                pipelines
                    .iter()
                    .take(8)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if !plugins.is_empty() {
            out.push(format!(
                "**Plugins/Configs**: {}",
                plugins
                    .iter()
                    .take(6)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        out
    }
}

/// Purely lexical comparison of stored identities; no per-key canonicalization.
fn normalize_path_cmp(p: &Path) -> String {
    #[cfg(windows)]
    {
        crate::pathnorm::strip_verbatim(&p.to_string_lossy())
            .replace('/', "\\")
            .to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        p.to_string_lossy().into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn node(id: SymbolId, name: &str, file: &str) -> SymbolNode {
        SymbolNode::new(
            id,
            name.into(),
            SymbolKind::Function,
            Visibility::Unknown,
            PathBuf::from(file),
            1,
            2,
        )
    }

    #[cfg(unix)]
    #[test]
    fn unix_synthetic_identity_delete_and_replace() {
        // Không tạo fixture: path chưa tồn tại vẫn phải xóa/thay thế đúng key lexical.
        let file = r"/synthetic-codeintel/目录\MiXeD.rs";
        let distinct = "/synthetic-codeintel/目录/MiXeD.rs";
        let mut g = CodeGraph::new();
        g.add_symbol(node(1, "old", file));
        g.add_symbol(node(2, "distinct", distinct));
        g.file_mtimes.insert(PathBuf::from(file), 1);
        assert_eq!(g.symbols_in_file(Path::new(file)), Some(&vec![1]));
        g.remove_file(Path::new(file));
        assert!(g.find_by_name("old").is_empty());
        assert!(!g.file_mtimes.contains_key(Path::new(file)));
        assert_eq!(g.symbols_in_file(Path::new(distinct)), Some(&vec![2]));
        g.add_symbol(node(3, "previous", file));
        g.remove_file(Path::new(file));
        g.add_symbol(node(4, "replacement", file));
        assert!(g.find_by_name("previous").is_empty());
        assert_eq!(g.symbols_in_file(Path::new(file)), Some(&vec![4]));
        assert_eq!(g.node_count(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn unix_root_alias_deleted_file_removes_stored_identity() {
        use std::os::unix::fs::symlink;
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("real");
        std::fs::create_dir(&root).unwrap();
        let alias = fixture.path().join("alias");
        symlink(&root, &alias).unwrap();
        let file = root.join(r"native\name.rs");
        let aliased_file = alias.join(r"native\name.rs");
        std::fs::write(&file, "fn indexed() {}\n").unwrap();
        let mut graph = super::super::index::build_graph(&alias);
        let key = super::super::canonical(&file);
        assert_eq!(graph.find_by_name("indexed").len(), 1);
        assert_eq!(
            graph.symbols_in_file(&aliased_file),
            graph.symbols_in_file(&key)
        );
        std::fs::remove_file(&file).unwrap();
        graph.remove_file(&aliased_file);
        assert!(graph.find_by_name("indexed").is_empty());
        assert!(graph.symbols_in_file(&key).is_none());
        assert!(!graph.file_mtimes.contains_key(&key));
    }

    #[cfg(unix)]
    #[test]
    fn unix_symlink_lookup_does_not_index_external_files() {
        use std::os::unix::fs::symlink;
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let file = workspace.path().join("source.rs");
        std::fs::write(&file, "fn inside() {}\n").unwrap();
        std::fs::write(outside.path().join("external.rs"), "fn external() {}\n").unwrap();
        let alias = outside.path().join("alias.rs");
        symlink(&file, &alias).unwrap();
        let mut g = super::super::index::build_graph(workspace.path());
        let stored = super::super::canonical(&file);
        assert_eq!(g.symbols_in_file(&alias), g.symbols_in_file(&stored));
        assert!(g.symbols_in_file(&alias).is_some());
        assert!(g.find_by_name("external").is_empty());
        assert!(g
            .symbols_in_file(&outside.path().join("external.rs"))
            .is_none());
        g.remove_file(&alias);
        assert!(g.find_by_name("inside").is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn unix_native_paths_graph_and_sqlite_roundtrip() {
        use super::super::index::{build_graph, FileUnit};
        use super::super::index_db::IndexDb;
        use std::io::{ErrorKind, Write};
        use std::os::unix::fs::{symlink, MetadataExt};

        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        // Canonical root also handles macOS /var -> /private/var temp aliases.
        let root = super::super::canonical(workspace.path());
        let native = root.join("目录\\MiXeD.rs");
        std::fs::write(&native, "fn native_name() {}\n").unwrap();
        let external = outside.path().join("external.rs");
        std::fs::write(&external, "fn external_only() {}\n").unwrap();
        symlink(&external, root.join("external_link.rs")).unwrap();

        let upper = root.join("Case.rs");
        let lower = root.join("case.rs");
        // Lexical identity must stay distinct even on case-insensitive macOS.
        assert_ne!(
            crate::pathnorm::codeintel_path(&upper),
            crate::pathnorm::codeintel_path(&lower)
        );
        std::fs::write(&upper, "fn upper_case() {}\n").unwrap();
        let case_sensitive = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lower)
        {
            Ok(mut file) => {
                file.write_all(b"fn lower_case() {}\n").unwrap();
                let a = std::fs::metadata(&upper).unwrap();
                let b = std::fs::metadata(&lower).unwrap();
                assert_ne!((a.dev(), a.ino()), (b.dev(), b.ino()));
                true
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => {
                let a = std::fs::metadata(&upper).unwrap();
                let b = std::fs::metadata(&lower).unwrap();
                assert_eq!((a.dev(), a.ino()), (b.dev(), b.ino()));
                eprintln!(
                    "case-insensitive fixture filesystem: lexical case assertions still exercised"
                );
                false
            }
            Err(err) => panic!("case capability probe failed: {err}"),
        };

        let graph = build_graph(&root);
        assert!(graph.find_by_name("external_only").is_empty());
        assert!(graph.symbols_in_file(&external).is_none());
        assert!(graph
            .symbols_in_file(&root.join("external_link.rs"))
            .is_none());
        let symbols = graph.find_by_name("native_name");
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].file, native);
        assert!(graph.symbols_in_file(&native).is_some());
        assert_eq!(graph.find_by_name("upper_case").len(), 1);
        if case_sensitive {
            assert_eq!(graph.find_by_name("lower_case").len(), 1);
            assert_ne!(graph.symbols_in_file(&upper), graph.symbols_in_file(&lower));
        }

        let writes: Vec<_> = graph
            .file_symbols
            .iter()
            .map(|(path, ids)| {
                let unit = FileUnit {
                    mtime_ns: 1,
                    len: std::fs::metadata(path).unwrap().len(),
                    nodes: ids.iter().map(|id| graph.nodes[id].clone()).collect(),
                    calls: Vec::new(),
                };
                (path.clone(), unit)
            })
            .collect();
        let db_path = root.join("roundtrip.db");
        {
            let db = IndexDb::open(&db_path).unwrap();
            db.sync_incremental(1, &writes, &[], &graph).unwrap();
        }
        let db = IndexDb::open(&db_path).unwrap();
        let restored = db.load_graph().expect("persisted graph");
        let units = db.load_units();
        assert_eq!(units.len(), writes.len());
        for (path, unit) in &writes {
            assert_eq!(restored.symbols_in_file(path), graph.symbols_in_file(path));
            let loaded = units.get(path).expect("full native SQLite key");
            assert_eq!(loaded.nodes.len(), unit.nodes.len());
            assert!(loaded.nodes.iter().all(|node| &node.file == path));
        }
        assert_eq!(restored.find_by_name("native_name")[0].file, native);
        assert!(restored.find_by_name("external_only").is_empty());
        assert!(units.contains_key(&native));
        assert!(!units.contains_key(&root.join("目录/MiXeD.rs")));
    }

    #[cfg(windows)]
    #[test]
    fn windows_case_alias_delete_and_update_removes_old_symbols() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("MiXeD.rs");
        std::fs::write(&file, "fn old() {}\n").unwrap();
        let stored = super::super::canonical(&file);
        let alias = PathBuf::from(
            stored
                .to_string_lossy()
                .replace('\\', "/")
                .to_ascii_lowercase(),
        );
        let mut g = CodeGraph::new();
        g.add_symbol(node(1, "old", stored.to_str().unwrap()));
        g.file_mtimes.insert(stored.clone(), 1);
        assert_eq!(g.symbols_in_file(&alias), Some(&vec![1]));
        std::fs::remove_file(&file).unwrap();
        assert_ne!(crate::pathnorm::codeintel_path(&alias), stored);
        g.remove_file(&alias);
        assert!(g.nodes.is_empty());
        assert!(g.file_symbols.is_empty());
        assert!(g.file_mtimes.is_empty());
        assert!(g.find_by_name("old").is_empty());

        // An update arriving under another spelling must replace, not duplicate.
        std::fs::write(&file, "fn replacement() {}\n").unwrap();
        g.add_symbol(node(2, "previous", stored.to_str().unwrap()));
        g.remove_file(&alias);
        g.add_symbol(node(3, "replacement", alias.to_str().unwrap()));
        assert!(g.find_by_name("previous").is_empty());
        assert_eq!(g.symbols_in_file(&stored), Some(&vec![3]));
        assert_eq!(g.node_count(), 1);
    }

    // a → b → c
    fn chain() -> CodeGraph {
        let mut g = CodeGraph::new();
        g.add_symbol(node(1, "a", "a.rs"));
        g.add_symbol(node(2, "b", "b.rs"));
        g.add_symbol(node(3, "c", "c.rs"));
        g.add_edge(
            1,
            Edge {
                to: 2,
                kind: EdgeKind::Calls,
                line: 1,
            },
        );
        g.add_edge(
            2,
            Edge {
                to: 3,
                kind: EdgeKind::Calls,
                line: 1,
            },
        );
        g
    }

    #[test]
    fn callees_and_callers() {
        let g = chain();
        assert_eq!(g.callees(1).unwrap()[0].to, 2);
        assert_eq!(g.callers(3).unwrap()[0].to, 2); // reverse map stores source
    }

    #[test]
    fn trace_callees_depth() {
        let g = chain();
        let r = g.trace_callees(1, 5);
        let ids: Vec<SymbolId> = r.iter().map(|(id, _)| *id).collect();
        assert!(ids.contains(&2) && ids.contains(&3), "{ids:?}");
        // depth-limited: only direct callee
        let r1 = g.trace_callees(1, 1);
        assert_eq!(r1, vec![(2, 1)]);
    }

    #[test]
    fn trace_callers_reverse() {
        let g = chain();
        let r = g.trace_callers(3, 5);
        let ids: Vec<SymbolId> = r.iter().map(|(id, _)| *id).collect();
        assert!(ids.contains(&2) && ids.contains(&1), "{ids:?}");
    }

    #[test]
    fn shortest_path_chain() {
        let g = chain();
        assert_eq!(g.shortest_path(1, 3), Some(vec![1, 2, 3]));
        assert_eq!(g.shortest_path(3, 1), None);
        assert_eq!(g.shortest_path(2, 2), Some(vec![2]));
    }

    #[test]
    fn file_dependents_excludes_self() {
        let g = chain();
        let deps = g.file_dependents(&PathBuf::from("c.rs"), 5);
        assert!(deps.contains(&PathBuf::from("a.rs")));
        assert!(deps.contains(&PathBuf::from("b.rs")));
        assert!(!deps.contains(&PathBuf::from("c.rs")));
    }

    #[test]
    fn name_index_finds_all_same_named() {
        let mut g = CodeGraph::new();
        g.add_symbol(node(1, "dup", "a.rs"));
        g.add_symbol(node(2, "dup", "b.rs"));
        g.add_symbol(node(3, "other", "c.rs"));
        assert_eq!(g.find_by_name("dup").len(), 2, "both dup symbols found");
        assert_eq!(g.find_by_name("other").len(), 1);
        assert!(g.find_by_name("missing").is_empty());
    }

    #[test]
    fn rebuild_name_index_restores_lookup() {
        let mut g = CodeGraph::new();
        g.add_symbol(node(1, "dup", "a.rs"));
        g.add_symbol(node(2, "dup", "b.rs"));
        // Simulate a graph produced by a path that bypasses add_symbol (serde skips by_name).
        g.by_name.clear();
        assert!(
            g.find_by_name("dup").is_empty(),
            "empty index → lookup misses"
        );
        g.rebuild_name_index();
        assert_eq!(g.find_by_name("dup").len(), 2, "rebuild restores the index");
    }
}
