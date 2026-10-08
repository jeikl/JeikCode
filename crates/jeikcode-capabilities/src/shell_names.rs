// Tên và alias shell dùng chung, không phụ thuộc feature tools.
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
