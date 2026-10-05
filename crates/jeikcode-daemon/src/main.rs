//! JeikCode API Service — standalone binary entrypoint.
//!
//! This is a thin shell around [`jeikcode_daemon::run_server`]: it parses CLI
//! arguments, performs process-global bootstrap (Windows console attach, legacy
//! session migration) and then delegates to the shared server logic in the
//! `jeikcode_daemon` library crate.

// On Windows, mark this binary as a GUI-subsystem application so that
// launching it from a GUI parent (e.g. VSCode extension host) does NOT
// allocate a visible console window. When launched from a terminal the
// daemon will attempt to re-attach to the parent console for stderr output.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use jeikcode_daemon::{run_server, ServerOpts};
use jeikcode_telemetry::{CliOverride, SessionMode};

/// Default idle timeout in seconds (30 minutes) before the daemon self-shuts
/// down when no client activity is observed.
const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 30 * 60;

fn parse_daemon_args_from(
    args: impl IntoIterator<Item = String>,
    env_idle_timeout: Option<String>,
    env_token: Option<String>,
) -> (String, u16, CliOverride, u64, SessionMode, Option<String>) {
    const DEFAULT_HOST: &str = "127.0.0.1";
    const DEFAULT_PORT: u16 = 13456;

    let mut host: Option<String> = None;
    let mut port: Option<u16> = None;
    let mut no_telemetry = false;
    let mut idle_timeout: Option<u64> = None;
    let mut client_mode: Option<String> = None;
    let mut token: Option<String> = None;

    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if arg == "--host" {
            if let Some(value) = args.next() {
                host = Some(value);
            }
            continue;
        }

        if let Some(value) = arg.strip_prefix("--host=") {
            host = Some(value.to_string());
            continue;
        }

        if arg == "--port" {
            if let Some(value) = args.next() {
                port = value.parse().ok();
            }
            continue;
        }

        if let Some(value) = arg.strip_prefix("--port=") {
            port = value.parse().ok();
            continue;
        }

        if arg == "--token" {
            if let Some(value) = args.next() {
                token = Some(value);
            }
            continue;
        }

        if let Some(value) = arg.strip_prefix("--token=") {
            token = Some(value.to_string());
            continue;
        }

        if arg == "--no-telemetry" {
            no_telemetry = true;
            continue;
        }

        if arg == "--idle-timeout" {
            if let Some(value) = args.next() {
                idle_timeout = value.parse().ok();
            }
            continue;
        }

        if let Some(value) = arg.strip_prefix("--idle-timeout=") {
            idle_timeout = value.parse().ok();
            continue;
        }

        if arg == "--client" {
            if let Some(value) = args.next() {
                client_mode = Some(value);
            }
            continue;
        }

        if let Some(value) = arg.strip_prefix("--client=") {
            client_mode = Some(value.to_string());
            continue;
        }
    }

    let cli_override = if no_telemetry {
        CliOverride { disabled: true }
    } else {
        CliOverride::default()
    };

    // Allow env var override: JEIKCODE_DAEMON_IDLE_TIMEOUT=<seconds>
    // 0 = disabled; non-zero values are clamped to a minimum of 60s to prevent
    // accidental rapid cycling from misconfigured environments.
    let raw_timeout = idle_timeout
        .or_else(|| env_idle_timeout.and_then(|value| value.parse().ok()))
        .unwrap_or(DEFAULT_IDLE_TIMEOUT_SECS);
    let timeout = if raw_timeout == 0 {
        0
    } else {
        raw_timeout.max(60)
    };

    let mode = match client_mode.as_deref() {
        Some("vscode") => SessionMode::Vscode,
        Some("jetbrains") => SessionMode::Jetbrains,
        Some("webui") => SessionMode::Webui,
        Some("jeikcode-air") => SessionMode::JeikcodeAir,
        _ => SessionMode::Ide,
    };

    (
        host.unwrap_or_else(|| DEFAULT_HOST.to_string()),
        port.unwrap_or(DEFAULT_PORT),
        cli_override,
        timeout,
        mode,
        token.or(env_token),
    )
}

fn parse_daemon_args() -> (String, u16, CliOverride, u64, SessionMode, Option<String>) {
    parse_daemon_args_from(
        std::env::args().skip(1),
        std::env::var("JEIKCODE_DAEMON_IDLE_TIMEOUT").ok(),
        std::env::var("JEIKCODE_SERVER_TOKEN").ok(),
    )
}

#[tokio::main]
async fn main() {
    // On Windows, when built as a GUI-subsystem binary (windows_subsystem = "windows"),
    // there is no default console. If launched from a terminal (cmd.exe / PowerShell),
    // re-attach to the parent's console so eprintln!/tracing output is visible.
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
        unsafe {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }

    // Used by IDE packaging to reject a daemon compiled after the private
    // signer overlay was removed. Keep this check side-effect free.
    if std::env::args().any(|arg| arg == "--check-official-build") {
        std::process::exit(if jeikcode_capabilities::provider::signer_available() {
            0
        } else {
            1
        });
    }

    // Ensure legacy sessions (macOS pre-v4.16 ~/Library/Application Support/jeikcode/sessions)
    // are migrated to the canonical location ($JEIKCODE_HOME/sessions) before any handler reads it.
    if let Err(error) = jeikcode_capabilities::session::SessionManager::migrate_from_legacy() {
        tracing::warn!("[session] Failed to migrate legacy sessions: {error}");
    }

    let (host, port, cli_override, idle_timeout_secs, startup_mode, token) = parse_daemon_args();
    let webui_tokens =
        match jeikcode_daemon::auth_token::standalone_daemon_tokens(&host, token.as_deref()) {
            Ok(tokens) => tokens,
            Err(error) => {
                eprintln!("Fatal: {error}");
                std::process::exit(1);
            }
        };

    if let Err(e) = run_server(ServerOpts {
        host,
        port,
        cli_override,
        idle_timeout_secs,
        startup_mode,
        webui_tokens,
        // 独立二进制：保留完整启动横幅。
        quiet: false,
        // 独立二进制 / VSCode：沿用 config 的 default_workdir，不覆盖。
        working_dir_override: None,
        // 独立二进制自行 bind host:port，不预绑定。
        prebound_listener: None,
        // 独立 daemon 模式不需要 app user_id 校验。
        app_user_id: None,
        startup_footer: None,
        yolo: false,
    })
    .await
    {
        eprintln!("Fatal: daemon server error: {e:#}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::parse_daemon_args_from;

    fn parse(args: &[&str], env_token: Option<&str>) -> Option<String> {
        let parsed = parse_daemon_args_from(
            args.iter().map(|arg| (*arg).to_string()),
            None,
            env_token.map(str::to_string),
        );
        parsed.5
    }

    #[test]
    fn daemon_parser_accepts_split_token_argument() {
        assert_eq!(
            parse(&["--token", "sk-split"], None).as_deref(),
            Some("sk-split")
        );
    }

    #[test]
    fn daemon_parser_accepts_equals_token_argument() {
        assert_eq!(
            parse(&["--token=sk-equals"], None).as_deref(),
            Some("sk-equals")
        );
    }

    #[test]
    fn daemon_parser_prefers_cli_token_over_environment() {
        assert_eq!(
            parse(&["--token", "sk-cli"], Some("sk-env")).as_deref(),
            Some("sk-cli")
        );
        assert_eq!(parse(&[], Some("sk-env")).as_deref(), Some("sk-env"));
    }
}
