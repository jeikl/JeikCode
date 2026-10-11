//! Persisted enable/disable state for skills, split into two standardized scopes that
//! mirror the MCP model:
//!
//! - **GLOBAL**: `$JEIKCODE_HOME/skills.json`
//! - **PROJECT**: `<project>/.jeikcode/skills.json`
//!
//! A skill is DISABLED when EITHER scope lists its registry name (e.g. `skills:foo`).
//! Both files share ONE standard schema:
//!
//! ```json
//! { "disabled": ["skills:foo", "plugin:bar"] }
//! ```
//!
//! The store is non-destructive — it never edits a user's `SKILL.md`; disabling is a
//! pure overlay. Removing the id (or the whole file) re-enables the skill.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::paths::config_dir;

/// The standard on-disk shape (identical for the global and project files).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct StateFile {
    #[serde(default)]
    disabled: BTreeSet<String>,
}

/// `$JEIKCODE_HOME/skills.json`
pub fn global_state_path() -> PathBuf {
    config_dir().join("skills.json")
}

/// `<project>/.jeikcode/skills.json`
pub fn project_state_path(project_dir: &Path) -> PathBuf {
    project_dir.join(".jeikcode").join("skills.json")
}

fn read_set(path: &Path) -> BTreeSet<String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<StateFile>(&text).ok())
        .map(|file| file.disabled)
        .unwrap_or_default()
}

/// Disabled skill ids recorded in the GLOBAL scope file.
pub fn load_global() -> BTreeSet<String> {
    read_set(&global_state_path())
}

/// Disabled skill ids recorded in the PROJECT scope file.
pub fn load_project(project_dir: &Path) -> BTreeSet<String> {
    read_set(&project_state_path(project_dir))
}

/// The union the runtime applies: a skill disabled at EITHER scope is disabled.
pub fn load_disabled(project_dir: &Path) -> BTreeSet<String> {
    let mut set = load_global();
    set.extend(load_project(project_dir));
    set
}

/// Set (or clear) the disabled flag for `skill_id` at the chosen scope. Creates the file
/// (and its parent directory) as needed. When enabling, the id is removed; an empty file
/// stays behind so the scope remains explicit.
pub fn set_disabled(
    project_dir: &Path,
    skill_id: &str,
    global: bool,
    disabled: bool,
) -> Result<(), String> {
    if skill_id.trim().is_empty() {
        return Err("skill id must not be empty".into());
    }
    let path = if global {
        global_state_path()
    } else {
        project_state_path(project_dir)
    };
    let mut set = read_set(&path);
    if disabled {
        set.insert(skill_id.to_string());
    } else {
        set.remove(skill_id);
    }
    write_set(&path, &set)
}

fn write_set(path: &Path, set: &BTreeSet<String>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("create {}: {error}", parent.display()))?;
        }
    }
    let file = StateFile {
        disabled: set.clone(),
    };
    let text = serde_json::to_string_pretty(&file).map_err(|error| error.to_string())?;
    std::fs::write(path, format!("{text}\n"))
        .map_err(|error| format!("write {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[serial_test::serial]
    fn toggles_each_scope_independently_and_unions_on_load() {
        let config = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let prev = std::env::var_os("JEIKCODE_HOME");
        std::env::set_var("JEIKCODE_HOME", config.path());

        // Global disable of one skill, project disable of another.
        set_disabled(project.path(), "skills:alpha", true, true).unwrap();
        set_disabled(project.path(), "skills:beta", false, true).unwrap();

        assert!(load_global().contains("skills:alpha"));
        assert!(!load_global().contains("skills:beta"));
        assert!(load_project(project.path()).contains("skills:beta"));

        // Effective set is the union of both scopes.
        let union = load_disabled(project.path());
        assert!(union.contains("skills:alpha") && union.contains("skills:beta"));

        // Enabling at the owning scope removes the id.
        set_disabled(project.path(), "skills:alpha", true, false).unwrap();
        assert!(!load_global().contains("skills:alpha"));
        assert!(load_disabled(project.path()).contains("skills:beta"));

        match prev {
            Some(value) => std::env::set_var("JEIKCODE_HOME", value),
            None => std::env::remove_var("JEIKCODE_HOME"),
        }
    }

    #[test]
    #[serial_test::serial]
    fn missing_files_read_as_empty() {
        let config = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let prev = std::env::var_os("JEIKCODE_HOME");
        std::env::set_var("JEIKCODE_HOME", config.path());
        assert!(load_global().is_empty());
        assert!(load_project(project.path()).is_empty());
        assert!(load_disabled(project.path()).is_empty());
        match prev {
            Some(value) => std::env::set_var("JEIKCODE_HOME", value),
            None => std::env::remove_var("JEIKCODE_HOME"),
        }
    }
}
