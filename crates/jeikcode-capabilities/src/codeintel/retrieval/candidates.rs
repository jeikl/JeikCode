//! Cheap candidate generation for large code graphs.
//!
//! The full scorer is O(symbols × fields). On a 31万-symbol ERP that is the
//! dominant query cost. This index builds two compact postings maps once per
//! graph revision:
//!
//! - CJK 2-grams from names / docs / comments (the vocabulary Chinese business
//!   queries actually use);
//! - ASCII identifier terms from names plus a capped slice of doc text.
//!
//! Query time intersects a handful of the rarest postings and keeps candidates
//! matching at least two query terms (or one for a single-term query). When the
//! candidate set is too small, callers fall back to the full scan — this is a
//! precision-preserving prefilter, never a hard recall gate.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use super::super::bilingual_nlp::{compact_ident, is_cjk, split_identifier, SearchTokens};
use super::super::graph::{CodeGraph, SymbolId};
use super::stats::{symbol_ascii_terms, symbol_cjk_phrases};

/// Cap unique terms stored per symbol. Names/docs come first in the text
/// concatenation, so identifier terms are never crowded out by comment noise.
const MAX_TERMS_PER_SYMBOL: usize = 48;
/// Cap postings scanned for one query term. A term present in >20k symbols is
/// too common to be a useful seed; other rarer terms carry the intersection.
const MAX_POSTINGS_PER_TERM: usize = 20_000;
/// Cap the final candidate set. The scorer then runs on this bounded slice.
const MAX_CANDIDATES: usize = 5_000;
/// Query-term fanout: at most this many postings lists are unioned/intersected.
const MAX_QUERY_TERMS: usize = 12;

#[derive(Debug, Default)]
pub struct CandidateIndex {
    cjk_bigrams: HashMap<String, Vec<SymbolId>>,
    ascii_terms: HashMap<String, Vec<SymbolId>>,
    total_symbols: usize,
}

impl CandidateIndex {
    /// Build postings from the current graph. This is an offline/index-time
    /// cost; query time only reads the maps. Symbols are processed sequentially
    /// so peak memory stays bounded (the index is roughly one posting entry per
    /// unique term per symbol).
    pub fn build(graph: &CodeGraph) -> Self {
        let mut index = Self {
            cjk_bigrams: HashMap::new(),
            ascii_terms: HashMap::new(),
            total_symbols: graph.nodes.len(),
        };

        for (id, node) in &graph.nodes {
            let mut seen: HashSet<String> = HashSet::new();

            for term in symbol_ascii_terms(node)
                .into_iter()
                .take(MAX_TERMS_PER_SYMBOL)
            {
                if term.len() >= 2 && seen.insert(term.clone()) {
                    index.ascii_terms.entry(term).or_default().push(*id);
                }
            }
            let compact = compact_ident(&node.name);
            if compact.len() >= 4 && seen.insert(compact.clone()) {
                index.ascii_terms.entry(compact).or_default().push(*id);
            }
            // CamelCase/snake_case subwords are what users type ("double11",
            // "promotion"); the full identifier alone would miss them.
            for part in split_identifier(&node.name) {
                let part = part.to_ascii_lowercase();
                if part.len() >= 2 && seen.insert(part.clone()) {
                    index.ascii_terms.entry(part).or_default().push(*id);
                }
            }

            let mut cjk_seen: HashSet<String> = HashSet::new();
            for phrase in symbol_cjk_phrases(node) {
                let chars = phrase.chars().count();
                if chars == 2 && cjk_seen.insert(phrase.clone()) {
                    index.cjk_bigrams.entry(phrase).or_default().push(*id);
                    if cjk_seen.len() >= MAX_TERMS_PER_SYMBOL {
                        break;
                    }
                }
            }
        }

        index
    }

    pub fn total_symbols(&self) -> usize {
        self.total_symbols
    }

    /// Return a bounded candidate set for one intent, or `None` when the query
    /// has no usable terms / no postings (caller should fall back to the full
    /// scan). A returned set is always non-empty.
    pub fn candidates(
        &self,
        graph: &CodeGraph,
        tokens: &SearchTokens,
        scope: Option<&Path>,
    ) -> Option<HashSet<SymbolId>> {
        let mut cjk_terms: HashSet<String> = HashSet::new();
        let mut ascii_terms: HashSet<String> = HashSet::new();
        let mut hard_ascii: HashSet<String> = HashSet::new();

        for segment in &tokens.cjk_segments {
            let chars: Vec<char> = segment.chars().collect();
            if chars.len() < 2 {
                continue;
            }
            for window in chars.windows(2) {
                if window.iter().all(|c| is_cjk(*c)) {
                    cjk_terms.insert(window.iter().copied().collect());
                }
            }
        }
        // A single-CJK-char segment (rare) is too generic to seed a candidate.
        for word in &tokens.words {
            if word.len() >= 2 {
                for part in split_identifier(word) {
                    if part.len() >= 2 {
                        ascii_terms.insert(part.to_ascii_lowercase());
                    }
                }
                ascii_terms.insert(word.to_ascii_lowercase());
                ascii_terms.insert(compact_ident(word));
            }
        }
        for ident in &tokens.code_identifiers {
            for part in split_identifier(ident) {
                if part.len() >= 2 {
                    ascii_terms.insert(part.to_ascii_lowercase());
                }
            }
            ascii_terms.insert(compact_ident(ident));
        }
        for term in tokens.hard_expanded_terms.iter() {
            let low = term.to_ascii_lowercase();
            ascii_terms.insert(low.clone());
            hard_ascii.insert(low.clone());
            for part in split_identifier(term) {
                if part.len() >= 2 {
                    let part = part.to_ascii_lowercase();
                    ascii_terms.insert(part.clone());
                    hard_ascii.insert(part);
                }
            }
            let compact = compact_ident(term);
            if compact.len() >= 2 {
                ascii_terms.insert(compact.clone());
                hard_ascii.insert(compact);
            }
        }
        for term in tokens.soft_expanded_terms.iter() {
            ascii_terms.insert(term.to_ascii_lowercase());
            for part in split_identifier(term) {
                if part.len() >= 2 {
                    ascii_terms.insert(part.to_ascii_lowercase());
                }
            }
        }
        ascii_terms.retain(|t| t.len() >= 2);

        // Seed with the rarest postings first: common terms (e.g. "order") add
        // noise and scanning cost, while a rare business term prunes hard.
        // Hard dictionary terms carry weight 2: an exact business-language
        // bridge (e.g. 部门前置喜报 -> depqzxibao) is by itself a strong seed,
        // while a shared CJK suffix is only weight 1.
        let mut seeds: Vec<(usize, u32, &str, &Vec<SymbolId>)> = Vec::new();
        for term in cjk_terms.iter() {
            if let Some(ids) = self.cjk_bigrams.get(term) {
                seeds.push((ids.len(), 1, term.as_str(), ids));
            }
        }
        for term in ascii_terms.iter() {
            if let Some(ids) = self.ascii_terms.get(term) {
                let weight = if hard_ascii.contains(term) { 2 } else { 1 };
                seeds.push((ids.len(), weight, term.as_str(), ids));
            }
        }
        seeds.sort_by_key(|(len, _, _, _)| *len);
        seeds.truncate(MAX_QUERY_TERMS);
        if seeds.is_empty() {
            return None;
        }

        let mut counts: HashMap<SymbolId, u32> = HashMap::new();
        for (_, weight, _, ids) in &seeds {
            for id in ids.iter().take(MAX_POSTINGS_PER_TERM) {
                *counts.entry(*id).or_insert(0) += *weight;
            }
        }

        // Require two distinct query terms when the query has at least two
        // seeds. This is the prefilter that stops a shared "喜报" suffix from
        // pulling every sibling Xibao class into the scoring pass.
        let required = if seeds.len() >= 2 { 2 } else { 1 };
        let mut ranked: Vec<(SymbolId, u32)> = counts
            .into_iter()
            .filter(|(_, count)| *count >= required)
            .collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1));
        // Apply the scope before the cap: a narrow `path:` query must not lose
        // its in-scope candidates because 5000 global hits filled the budget.
        ranked.retain(|(id, _)| {
            scope.is_none_or(|sc| {
                graph
                    .nodes
                    .get(id)
                    .is_some_and(|node| super::super::path_matches_scope(&node.file, sc))
            })
        });
        ranked.truncate(MAX_CANDIDATES);

        let candidates: HashSet<SymbolId> = ranked.into_iter().map(|(id, _)| id).collect();

        (!candidates.is_empty()).then_some(candidates)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codeintel::bilingual_nlp::{parse_bilingual_query_with_thesaurus, DynamicThesaurus};
    use crate::codeintel::graph::{SymbolKind, Visibility};
    use std::path::PathBuf;

    fn node(id: u64, name: &str, doc: &str) -> crate::codeintel::graph::SymbolNode {
        crate::codeintel::graph::SymbolNode {
            id,
            name: name.into(),
            kind: SymbolKind::Class,
            visibility: Visibility::Public,
            file: PathBuf::from(format!("backend/{name}.cs")),
            start_line: 1,
            end_line: 10,
            docstring: Some(doc.into()),
            ..Default::default()
        }
    }

    #[test]
    fn shared_suffix_candidates_require_two_terms() {
        let mut graph = CodeGraph::new();
        graph.add_symbol(node(1, "DepQZXibao", "Render the poster"));
        graph.add_symbol(node(2, "PersonMLZTXibao", "个人美莱转推喜报"));
        graph.add_symbol(node(3, "DacuXibao", "大促喜报"));
        let index = CandidateIndex::build(&graph);

        let mut dt = DynamicThesaurus::default();
        dt.parse_and_append("部门前置喜报 = depqzxibao\n");
        let tokens = parse_bilingual_query_with_thesaurus("部门前置喜报", &dt);
        let candidates = index.candidates(&graph, &tokens, None).unwrap_or_default();
        assert!(
            candidates.contains(&1),
            "hard-expanded physical symbol must be a candidate: {candidates:?}"
        );
        assert!(
            !candidates.contains(&3),
            "a sibling matching only 喜报 must be filtered: {candidates:?}"
        );
    }

    #[test]
    fn ascii_identifier_query_finds_compact_name() {
        let mut graph = CodeGraph::new();
        graph.add_symbol(node(1, "BuildDouble11PromotionPlan", ""));
        graph.add_symbol(node(2, "UnrelatedService", ""));
        let index = CandidateIndex::build(&graph);
        let tokens = SearchTokens {
            raw_query: "double11".into(),
            words: vec!["double11".into()],
            ..Default::default()
        };
        let candidates = index.candidates(&graph, &tokens, None).unwrap_or_default();
        assert!(candidates.contains(&1), "{candidates:?}");
        assert!(!candidates.contains(&2), "{candidates:?}");
    }
}
