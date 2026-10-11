//! Unified capability enable/disable surface for **MCP servers** and **skills**.
//!
//! Both families expose the SAME model — a [`CapItem`] carrying a GLOBAL and a PROJECT
//! disabled flag (plus the derived `effective_disabled`) — so a host can render one
//! toggle component for both and reflect per-project differences when the active
//! project changes. Each family keeps its own standard config file and scope mapping;
//! this module is the adapter that erases the difference:
//!
//! - **MCP**: `$JEIKCODE_HOME/mcp.json` (GLOBAL) + `<project>/.mcp.json` (PROJECT), each
//!   server's `disabled` key ([`crate::mcp::config`]).
//! - **Skills**: `$JEIKCODE_HOME/skills.json` (GLOBAL) + `<project>/.jeikcode/skills.json`
//!   (PROJECT), a `disabled` name list ([`crate::skills::controls`]).
//!
//! Compiled only when at least one family is present; the endpoint in the daemon layers
//! connection status / folder paths on top of the returned items.

#[cfg(any(feature = "mcp", feature = "skills"))]
use std::path::Path;

/// Which capability family an item belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CapKind {
    Mcp,
    Skill,
}

/// The scope a toggle applies to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CapScope {
    Global,
    Project,
}

/// One toggleable capability, unified across families.
#[derive(Clone, Debug, serde::Serialize)]
pub struct CapItem {
    pub kind: CapKind,
    /// Stable identity for the toggle endpoint: the MCP server name or the skill's
    /// registry name (e.g. `skills:foo`).
    pub id: String,
    /// Human-facing name (skills show the bare name; MCP shows the server name).
    pub name: String,
    pub description: String,
    /// Disabled via the GLOBAL scope file.
    pub global_disabled: bool,
    /// Disabled via the PROJECT scope file.
    pub project_disabled: bool,
    /// The state the runtime actually applies (project overrides global when the
    /// project declares the item; otherwise the global state stands).
    pub effective_disabled: bool,
    /// Skills only: the folder that owns the skill (for "reveal in file explorer").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
}

/// Every configured MCP server with its per-scope disabled state. Empty when the `mcp`
/// feature is not compiled in.
#[cfg(any(feature = "mcp", feature = "skills"))]
pub fn mcp_items(project_dir: &Path) -> Vec<CapItem> {
    #[cfg(feature = "mcp")]
    {
        crate::mcp::config::list_mcp_server_states(project_dir)
            .into_iter()
            .map(|state| CapItem {
                kind: CapKind::Mcp,
                id: state.name.clone(),
                name: state.name,
                description: state.description,
                global_disabled: state.global_disabled,
                project_disabled: state.project_disabled,
                effective_disabled: state.effective_disabled,
                dir: None,
            })
            .collect()
    }
    #[cfg(not(feature = "mcp"))]
    {
        let _ = project_dir;
        Vec::new()
    }
}

/// Persist a capability's disabled flag at `scope` in the family's standard config file.
#[cfg(any(feature = "mcp", feature = "skills"))]
pub fn set_disabled(
    project_dir: &Path,
    kind: CapKind,
    id: &str,
    scope: CapScope,
    disabled: bool,
) -> Result<(), String> {
    let global = matches!(scope, CapScope::Global);
    match kind {
        CapKind::Mcp => {
            #[cfg(feature = "mcp")]
            {
                crate::mcp::config::set_mcp_server_disabled(project_dir, id, global, disabled)
                    .map_err(|error| error.to_string())
            }
            #[cfg(not(feature = "mcp"))]
            {
                let _ = (project_dir, id, global, disabled);
                Err("MCP support is not compiled into this build".into())
            }
        }
        CapKind::Skill => {
            #[cfg(feature = "skills")]
            {
                crate::skills::controls::set_disabled(project_dir, id, global, disabled)
            }
            #[cfg(not(feature = "skills"))]
            {
                let _ = (project_dir, id, global, disabled);
                Err("skills support is not compiled into this build".into())
            }
        }
    }
}
