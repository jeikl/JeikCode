//! Compile-time checkout metadata for offline diagnostics.
//!
//! These fields describe what the build script observed. They do not attest
//! that every input to the executable came from the committed source tree.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildInfo {
    pub schema_version: u32,
    /// Zero (including a missing field) means no declared repair protocol.
    #[serde(default)]
    pub repair_protocol: u32,
    /// Older hosts must not be assumed to honor the skill's expansion opt-out.
    #[serde(default)]
    pub skill_shell_expansion_opt_out: bool,
    pub package_name: String,
    pub package_version: String,
    pub target: String,
    pub source_commit: Option<String>,
    /// The committed HEAD tree. Uncommitted changes are not represented here.
    pub source_tree: Option<String>,
    /// Includes tracked changes and nonignored untracked files. `None` means
    /// the build script could not determine the checkout's state.
    pub source_dirty: Option<bool>,
    /// Build metadata alone cannot prove a source-to-artifact relationship.
    pub source_artifact_relation: String,
}

impl BuildInfo {
    /// Read embedded metadata without inspecting config, Git, or the network.
    pub fn current() -> Self {
        Self {
            schema_version: 1,
            repair_protocol: 1,
            skill_shell_expansion_opt_out: true,
            package_name: env!("CARGO_PKG_NAME").into(),
            package_version: env!("CARGO_PKG_VERSION").into(),
            target: option_env!("JEIKCODE_BUILD_TARGET")
                .unwrap_or("unknown")
                .into(),
            source_commit: known_value(option_env!("JEIKCODE_SOURCE_COMMIT")),
            source_tree: known_value(option_env!("JEIKCODE_SOURCE_TREE")),
            source_dirty: match option_env!("JEIKCODE_SOURCE_DIRTY") {
                Some("true") => Some(true),
                Some("false") => Some(false),
                _ => None,
            },
            source_artifact_relation: "unknown".into(),
        }
    }
}

fn known_value(value: Option<&str>) -> Option<String> {
    value
        .filter(|value| !value.is_empty() && *value != "unknown")
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::BuildInfo;

    #[test]
    fn build_info_declares_capabilities_without_attesting_source() {
        let info = BuildInfo::current();
        let value = serde_json::to_value(&info).unwrap();
        assert_eq!(value["schema_version"], 1);
        assert_eq!(value["repair_protocol"], 1);
        assert_eq!(value["skill_shell_expansion_opt_out"], true);
        assert_eq!(value["source_artifact_relation"], "unknown");
        assert_eq!(serde_json::from_value::<BuildInfo>(value).unwrap(), info);
    }

    #[test]
    fn missing_capability_fields_do_not_enable_repair_or_expansion_opt_out() {
        let mut value = serde_json::to_value(BuildInfo::current()).unwrap();
        value.as_object_mut().unwrap().remove("repair_protocol");
        value
            .as_object_mut()
            .unwrap()
            .remove("skill_shell_expansion_opt_out");
        let previous = serde_json::from_value::<BuildInfo>(value).unwrap();
        assert_eq!(previous.repair_protocol, 0);
        assert!(!previous.skill_shell_expansion_opt_out);
    }
}
