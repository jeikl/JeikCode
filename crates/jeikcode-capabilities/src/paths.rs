//! Shared path resolution for every capability that touches the jeikcode config
//! tree (`mcp` / `session` / `memory`) — ONE home for the rule, one place to
//! document its single known divergence from production.

use std::path::PathBuf;

/// The jeikcode config/data root: `$JEIKCODE_HOME` if set & non-empty, else
/// `~/.jeikcode`. Mirrors `jeikcode_core::config::Config::config_dir` so everything
/// L1 persists (`sessions/`, `memory.md`, MCP OAuth tokens) lands in the SAME tree
/// as production's.
///
/// KNOWN DIVERGENCE (deliberate L1 simplification): the core helper additionally
/// resolves `$SUDO_USER` via getpwnam, so under `sudo` WITHOUT `$JEIKCODE_HOME` set
/// production resolves the invoking user's home while this resolves root's — the
/// two stacks would then read/write parallel trees. Setting `$JEIKCODE_HOME`
/// (checked first, byte-identical to production) keeps them aligned.
pub(crate) fn config_dir() -> PathBuf {
    if let Ok(p) = std::env::var("JEIKCODE_HOME") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    if let Ok(p) = std::env::var("ATOMCODE_HOME") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let jeik_dir = home.join(".jeikcode");
    if jeik_dir.exists() {
        return jeik_dir;
    }
    let legacy_dir = home.join(".atomcode");
    if legacy_dir.exists() {
        return legacy_dir;
    }
    jeik_dir
}

// NO unit test here ON PURPOSE: testing this means mutating the process-global
// `JEIKCODE_HOME`, and libtest runs the lib's unit tests in parallel threads — any
// future unit test touching `config_dir()` (memory.md, session paths, OAuth token
// store) would race it nondeterministically. The `$JEIKCODE_HOME`-wins behavior is
// exercised by the env-isolating INTEGRATION binaries (each its own process):
// capabilities `tests/session.rs` + `tests/mcp.rs`, coding `tests/full_assembly.rs`.
