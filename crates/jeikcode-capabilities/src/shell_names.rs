// Shared shell tool names and aliases, independent of the tools feature.
/// Canonical name advertised to the model. `bash` remains an alias so old
/// transcripts and models trained to call `bash` still resolve.
pub const SHELL_TOOL_NAME: &str = "run_command";
pub const SHELL_TOOL_ALIASES: &[&str] = &["bash"];

pub fn is_shell_tool_name(name: &str) -> bool {
    name.eq_ignore_ascii_case(SHELL_TOOL_NAME)
        || SHELL_TOOL_ALIASES
            .iter()
            .any(|alias| name.eq_ignore_ascii_case(alias))
}

// --- Shell command argument key + extractor -------------------------------
// Single source of truth for "where is the command in a shell call's args".
// Argument repair normalizes every alias to `command`; the workspace gate and
// the turn execution policy read through `extract_shell_command`, so the alias
// set is defined in exactly ONE place and can never drift between consumers.

/// Canonical command-argument key (matches the shell tool's JSON schema).
pub const SHELL_COMMAND_KEY: &str = "command";
/// Accepted aliases for the command key, in priority order. Kept here (not in
/// each consumer) so adding an alias updates repair + every gate at once.
pub const SHELL_COMMAND_ALIASES: &[&str] = &["cmd"];

/// Extract the shell command string from a tool call's raw args, honoring the
/// canonical key plus every [`SHELL_COMMAND_ALIASES`] entry. Returns `None` only
/// on a JSON parse failure or when no key holds a string value.
pub fn extract_shell_command(args: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(args).ok()?;
    std::iter::once(SHELL_COMMAND_KEY)
        .chain(SHELL_COMMAND_ALIASES.iter().copied())
        .find_map(|key| value.get(key).and_then(serde_json::Value::as_str))
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::extract_shell_command;

    #[test]
    fn extracts_canonical_key_and_alias() {
        assert_eq!(
            extract_shell_command(r#"{"command":"cargo test"}"#).as_deref(),
            Some("cargo test")
        );
        assert_eq!(
            extract_shell_command(r#"{"cmd":"cargo test"}"#).as_deref(),
            Some("cargo test")
        );
        // The canonical key wins when both are present.
        assert_eq!(
            extract_shell_command(r#"{"command":"a","cmd":"b"}"#).as_deref(),
            Some("a")
        );
    }

    #[test]
    fn returns_none_without_a_string_command() {
        assert_eq!(extract_shell_command(r#"{"cwd":"/tmp"}"#), None);
        assert_eq!(extract_shell_command("not json"), None);
        assert_eq!(extract_shell_command(r#"{"cmd":123}"#), None);
    }
}
