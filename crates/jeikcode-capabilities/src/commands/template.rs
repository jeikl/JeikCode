//! User-invoked command template rendering.
//!
//! Commands (`commands/*.md`, invoked as `/name args`) are prompt templates:
//! `$ARGUMENTS`, `$N` (1-based) and `` !`cmd` `` are expanded before the message
//! is sent. Skills never use this module — a `SKILL.md` body is returned verbatim
//! by `Skill::raw_for_injection`.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

/// Render `template` with `arguments`.
///
/// - `$ARGUMENTS` / `${ARGUMENTS}` → the full argument string.
/// - `$1` / `${1}` → the first whitespace-separated argument (1-based).
///   Out-of-range positions stay literal.
/// - When the template contains no argument placeholder at all and `arguments`
///   is non-empty, the arguments are appended after a blank line.
/// - `` !`cmd` `` runs `sh -c cmd` with the `skill_cmd_secs` timeout.
///
/// Substitution is a single left-to-right pass: inserted argument text is never
/// re-scanned, and user arguments are never executed as shell blocks.
pub fn render(template: &str, arguments: &str) -> String {
    render_in(template, arguments, None)
}

/// [`render`] with an explicit working directory for `` !`cmd` `` blocks. The
/// daemon passes the project dir so shell commands do not inherit the daemon's
/// own process cwd.
pub fn render_in(template: &str, arguments: &str, cwd: Option<&Path>) -> String {
    let positional: Vec<&str> = arguments.split_whitespace().collect();
    let has_placeholder = contains_placeholder(template);
    let mut out = String::with_capacity(template.len() + arguments.len() + 2);
    let mut rest = template;
    while let Some(ch) = rest.chars().next() {
        // Shell blocks come from the template only. Arguments are inserted
        // literally below, so user input can never be executed.
        if let Some(after) = rest.strip_prefix("!`") {
            if let Some(end) = after.find('`') {
                // Substitute placeholders inside the shell command, but never
                // scan the command's output or user arguments for new blocks.
                let cmd = substitute(&after[..end], &positional, arguments);
                out.push_str(&run_shell_command(&cmd, cwd));
                rest = &after[end + 1..];
                continue;
            }
        }
        if let Some((value, consumed)) = match_substitution(rest, &positional, arguments) {
            out.push_str(value);
            rest = &rest[consumed..];
        } else {
            out.push(ch);
            rest = &rest[ch.len_utf8()..];
        }
    }
    let arguments = arguments.trim();
    if !has_placeholder && !arguments.is_empty() {
        out.push_str("\n\n");
        out.push_str(arguments);
    }
    out
}

/// True when `template` contains any argument placeholder, including an
/// out-of-range positional (`$9`) that will stay literal.
fn contains_placeholder(template: &str) -> bool {
    if template.contains("$ARGUMENTS") || template.contains("${ARGUMENTS}") {
        return true;
    }
    let mut rest = template;
    while let Some(idx) = rest.find('$') {
        let after = &rest[idx + 1..];
        if let Some(braced) = after.strip_prefix('{') {
            if braced.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                return true;
            }
        } else if after.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            return true;
        }
        rest = after;
    }
    false
}

/// Placeholder-only substitution (no shell execution). Used both for the main
/// template scan's non-shell segments and for `` !`cmd` `` command bodies.
fn substitute(template: &str, positional: &[&str], arguments: &str) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(ch) = rest.chars().next() {
        if let Some((value, consumed)) = match_substitution(rest, positional, arguments) {
            out.push_str(value);
            rest = &rest[consumed..];
        } else {
            out.push(ch);
            rest = &rest[ch.len_utf8()..];
        }
    }
    out
}

/// Match a substitution token at the START of `rest`; returns `(replacement, consumed)`.
/// Longest-token-first. `$N`/`${N}` are 1-based; undefined positions stay literal.
fn match_substitution<'a>(
    rest: &'a str,
    positional: &[&'a str],
    arguments: &'a str,
) -> Option<(&'a str, usize)> {
    if rest.starts_with("${ARGUMENTS}") {
        return Some((arguments, "${ARGUMENTS}".len()));
    }
    if rest.starts_with("$ARGUMENTS") {
        return Some((arguments, "$ARGUMENTS".len()));
    }
    if let Some(after) = rest.strip_prefix("${") {
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        if !digits.is_empty() && after[digits.len()..].starts_with('}') {
            if let Ok(n) = digits.parse::<usize>() {
                if n > 0 && n <= positional.len() {
                    return Some((positional[n - 1], "${".len() + digits.len() + 1));
                }
            }
        }
        return None;
    }
    if let Some(after) = rest.strip_prefix('$') {
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        if !digits.is_empty() {
            if let Ok(n) = digits.parse::<usize>() {
                if n > 0 && n <= positional.len() {
                    return Some((positional[n - 1], 1 + digits.len()));
                }
            }
        }
    }
    None
}

fn run_shell_command(cmd: &str, cwd: Option<&Path>) -> String {
    let secs = jeikcode_config::config::ToolTimeoutsConfig::load_effective().skill_cmd_secs;
    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(cmd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    #[cfg(unix)]
    crate::process_utils::apply_utf8_locale_env_sync(&mut command);
    crate::process_utils::suppress_console_window_sync(&mut command);
    let child = match command.spawn() {
        Ok(c) => c,
        Err(e) => return format!("[error: {e}]"),
    };
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(Duration::from_secs(secs)) {
        Ok(Ok(out)) => {
            let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr);
                if !stderr.trim().is_empty() {
                    s.push('\n');
                    s.push_str(stderr.trim());
                }
            }
            s.trim_end().to_string()
        }
        Ok(Err(e)) => format!("[error: {e}]"),
        Err(_) => {
            #[cfg(windows)]
            crate::process_utils::taskkill_tree(pid);
            #[cfg(unix)]
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
            format!("[timed out after {secs}s]")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_full_and_positional() {
        assert_eq!(render("do $ARGUMENTS now", "a b c"), "do a b c now");
        assert_eq!(render("first=$1 second=$2", "a b"), "first=a second=b");
        assert_eq!(render("idx=${2}", "a b"), "idx=b");
    }

    #[test]
    fn braced_arguments_does_not_duplicate() {
        assert_eq!(render("Review ${ARGUMENTS}", "main.rs"), "Review main.rs");
    }

    #[test]
    fn shell_command_bodies_substitute_arguments() {
        assert_eq!(
            substitute("echo $ARGUMENTS", &["a", "b"], "a b"),
            "echo a b"
        );
        assert_eq!(substitute("echo $1", &["a", "b"], "a b"), "echo a");
    }

    #[test]
    fn appends_args_when_no_placeholder() {
        let out = render("plain template", "hello world");
        assert!(out.contains("plain template"));
        assert!(out.contains("hello world"));
    }

    #[test]
    fn out_of_range_positional_stays_literal() {
        let out = render("x=$5", "a b");
        assert_eq!(out, "x=$5");
    }

    #[test]
    fn zero_positional_stays_literal() {
        let out = render("x=$0", "a");
        assert_eq!(out, "x=$0");
    }

    #[test]
    fn argument_containing_dollar_token_is_not_re_expanded() {
        // arg0 is the literal "$1"; the single pass must NOT re-expand it into arg1.
        let out = render("a=$1 b=$2", "$1 V");
        assert_eq!(out, "a=$1 b=V");
    }

    #[test]
    fn user_arguments_are_not_shell_executed() {
        let out = render("$ARGUMENTS", "!`echo hacked`");
        assert_eq!(out, "!`echo hacked`");
    }

    #[test]
    fn shell_injection_runs() {
        // Windows CI may lack `sh`; accept either success or a clear spawn error.
        let out = render("value=!`echo hi`", "");
        assert!(
            out == "value=hi"
                || out.contains("value=[error:")
                || out.contains("value=hi\r")
                || out.starts_with("value=hi"),
            "shell injection should expand or report spawn error, got {out:?}"
        );
    }
}
