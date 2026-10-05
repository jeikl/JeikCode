use std::borrow::Cow;
use std::io::{self, IsTerminal, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use jeikcode_config::config::NotificationConfig;

/// Why a turn stopped, decoupled from host-specific stop-reason enums so this
/// module (L0) needs no dependency on kernel or UI event types. Hosts map their
/// stop reason into this enum before calling [`notify`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyStopReason {
    Natural,
    Cancelled,
    Error,
    TurnLimit,
    StepLimit,
}

#[derive(Debug, Clone)]
pub struct TurnNotification<'a> {
    pub duration: Duration,
    pub turn_count: usize,
    pub tool_call_count: usize,
    pub total_tokens: Option<usize>,
    pub stop_reason: NotifyStopReason,
    pub working_dir: Option<&'a Path>,
}

#[derive(Debug, Clone)]
pub struct ApprovalNotification<'a> {
    pub tool_name: &'a str,
    pub detail: Option<&'a str>,
    pub working_dir: Option<&'a Path>,
}

#[derive(Debug, Clone)]
pub enum NotificationEvent<'a> {
    ApprovalNeeded(ApprovalNotification<'a>),
    TurnFinished(TurnNotification<'a>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalApp {
    Kitty,
    WezTerm,
    Ghostty,
    ITerm2,
    AppleTerminal,
    WindowsTerminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VisibilityPolicy {
    BackgroundOnlyBestEffort,
}

#[derive(Debug, Clone)]
struct NotificationPlan {
    title: Cow<'static, str>,
    body: String,
    terminal_id: &'static str,
    visibility: VisibilityPolicy,
    emit_terminal: bool,
    emit_system: bool,
    emit_bell: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeliveryResult {
    Delivered,
    Unsupported,
    Failed,
}

const FOCUS_UNKNOWN: u8 = 0;
const FOCUS_TRUE: u8 = 1;
const FOCUS_FALSE: u8 = 2;

static TERMINAL_FOCUS_STATE: AtomicU8 = AtomicU8::new(FOCUS_UNKNOWN);

pub fn set_terminal_focus_state(focused: Option<bool>) {
    let encoded = match focused {
        Some(true) => FOCUS_TRUE,
        Some(false) => FOCUS_FALSE,
        None => FOCUS_UNKNOWN,
    };
    TERMINAL_FOCUS_STATE.store(encoded, Ordering::Relaxed);
}

fn terminal_focus_state() -> Option<bool> {
    match TERMINAL_FOCUS_STATE.load(Ordering::Relaxed) {
        FOCUS_TRUE => Some(true),
        FOCUS_FALSE => Some(false),
        _ => None,
    }
}

pub fn notify(cfg: &NotificationConfig, event: NotificationEvent<'_>) {
    let Some(plan) = build_notification_plan(cfg, event) else {
        return;
    };
    dispatch_notification(plan);
}

pub fn notify_turn_finished(cfg: &NotificationConfig, turn: TurnNotification<'_>) {
    notify(cfg, NotificationEvent::TurnFinished(turn));
}

/// Fire an OS notification immediately, including on Windows.
///
/// The TUI path keeps Windows system toasts off: a NotifyIcon balloon in that
/// process has crashed the terminal. This entry is for a host that is not the
/// TUI (the daemon). It always spawns a detached notifier and ignores terminal
/// focus, so a background WebUI session still reaches the OS.
pub fn notify_system_now(title: &str, body: &str) {
    notify_system_launch(title, body, None);
}

/// Same as [`notify_system_now`], plus an optional `jeikcode-focus:` launch
/// target. A click on Windows, macOS, and Linux opens that session. The toast
/// stays up long enough to hit. A value that is not a focus URI is dropped,
/// and the toast is still shown.
pub fn notify_system_launch(title: &str, body: &str, launch: Option<&str>) {
    let (title, body) = prepare_system_notification(title, body);
    let launch = launch.and_then(accepted_focus_launch);
    spawn_system_notification(title, body, launch);
}

/// Session ids that may travel in a focus URI. UUIDs match. Anything else is
/// rejected so a toast click cannot smuggle a shell metacharacter.
pub fn sanitize_focus_session_id(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 128 {
        return None;
    }
    if raw
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        Some(raw.to_string())
    } else {
        None
    }
}

/// `jeikcode-focus:<port>:<32 hex secret>:<session id>`.
pub fn focus_launch(port: u16, secret: &str, session_id: &str) -> Option<String> {
    if port == 0 {
        return None;
    }
    let session_id = sanitize_focus_session_id(session_id)?;
    accepted_focus_launch(&format!("jeikcode-focus:{port}:{secret}:{session_id}"))
}

fn accepted_focus_launch(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let rest = raw.strip_prefix("jeikcode-focus:")?;
    let (port, rest) = rest.split_once(':')?;
    let (secret, session) = rest.split_once(':')?;
    if port.is_empty()
        || port.len() > 5
        || !port.bytes().all(|b| b.is_ascii_digit())
        || port.starts_with('0')
    {
        return None;
    }
    if secret.len() != 32 || !secret.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let session = sanitize_focus_session_id(session)?;
    Some(format!("jeikcode-focus:{port}:{secret}:{session}"))
}

#[cfg(target_os = "windows")]
const JEIKCODE_ICON_BYTES: &[u8] = include_bytes!("../../../desktop/src-tauri/icons/icon.png");

#[cfg(target_os = "windows")]
fn get_windows_icon_uri() -> Option<String> {
    let home = jeikcode_config::config::Config::default_path()
        .parent()?
        .to_path_buf();
    let icon_path = home.join("assets").join("icon.png");
    if icon_path.is_file() {
        Some(icon_path.to_string_lossy().replace('\\', "/"))
    } else {
        None
    }
}

/// App ids that raise a desktop banner on Windows.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
///
/// The bare name `JeikCode` is absent on purpose. `Show()` for an unregistered
/// AUMID returns without throwing, Windows files the toast, and no banner
/// appears. Treating that as success used to skip the PowerShell id, which is
/// the call that actually pops a banner (the same id a direct test uses).
fn windows_toast_app_ids() -> &'static [&'static str] {
    &[
        r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe",
        "Microsoft.Windows.Explorer",
    ]
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_toast_xml(title: &str, body: &str, launch: Option<&str>) -> String {
    let launch_attr = match launch {
        Some(uri) => format!(
            " duration=\"long\" activationType=\"protocol\" launch=\"{}\"",
            xml_escape(uri)
        ),
        None => " duration=\"long\"".to_string(),
    };
    let lower_title = title.to_lowercase();
    let is_terminal = lower_title.contains("done")
        || lower_title.contains("finished")
        || lower_title.contains("completed")
        || lower_title.contains("stopped")
        || lower_title.contains("failed")
        || title.contains("完成")
        || title.contains("已结束")
        || title.contains("已停止")
        || title.contains("失败");

    // 严禁根据 body（因 body 经常包含会话标题，如 "PR 审核"）误判为审批！
    // 只有标题明确为审核/审批时，且非已完成终态通知，才允许添加 Approve/Deny 按钮。
    let is_approval = !is_terminal
        && (lower_title.contains("approval")
            || lower_title.contains("review")
            || title.contains("审核")
            || title.contains("审批"));

    let is_zh = title
        .chars()
        .any(|c| (c as u32) >= 0x4e00 && (c as u32) <= 0x9fff);

    let is_question = !is_terminal
        && (lower_title.contains("answer")
            || lower_title.contains("ask")
            || title.contains("回答")
            || title.contains("提问"));
    let actions = match (launch, is_approval, is_question) {
        (Some(uri), true, _) => {
            let allow_uri = format!("{}:allow", xml_escape(uri));
            let deny_uri = format!("{}:deny", xml_escape(uri));
            let (allow_text, deny_text) = if is_zh {
                ("同意", "拒绝")
            } else {
                ("Approve", "Deny")
            };
            format!(
                "<actions>\
                   <action content=\"{allow_text}\" arguments=\"{allow_uri}\" activationType=\"protocol\"/>\
                   <action content=\"{deny_text}\" arguments=\"{deny_uri}\" activationType=\"protocol\"/>\
                 </actions>"
            )
        }
        (Some(uri), false, true) => {
            let answer_uri = xml_escape(uri);
            let answer_text = if is_zh { "作答" } else { "Answer" };
            format!(
                "<actions>\
                   <action content=\"{answer_text}\" arguments=\"{answer_uri}\" activationType=\"protocol\"/>\
                 </actions>"
            )
        }
        _ => String::new(),
    };

    // 提取会话标识：如果在 launch 里有 session id，或者在 body 里有会话信息，呈现多行结构化展示
    let session_header = if let Some(uri) = launch {
        uri.strip_prefix("jeikcode-focus:")
            .and_then(|u| u.split(':').nth(2))
            .filter(|sid| !sid.is_empty())
            .map(|sid| {
                let short_sid = if sid.len() > 8 { &sid[..8] } else { sid };
                if is_zh {
                    format!("会话: {short_sid}")
                } else {
                    format!("Session: {short_sid}")
                }
            })
    } else {
        None
    };

    let logo_element = {
        #[cfg(target_os = "windows")]
        {
            if let Some(uri) = get_windows_icon_uri() {
                format!("<image placement=\"appLogoOverride\" hint-crop=\"circle\" src=\"file:///{}\" />", xml_escape(&uri))
            } else {
                String::new()
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            String::new()
        }
    };

    let text_elements = if let Some(sh) = session_header {
        format!(
            "<text>{}</text><text>{}</text><text>{}</text>",
            xml_escape(title),
            xml_escape(&sh),
            xml_escape(body)
        )
    } else {
        format!(
            "<text>{}</text><text>{}</text>",
            xml_escape(title),
            xml_escape(body)
        )
    };

    format!(
        "<toast{launch_attr}><visual><binding template=\"ToastGeneric\">{logo_element}{text_elements}</binding></visual>{actions}</toast>",
    )
}

/// Install the click handler for OS toasts. Safe to call more than once.
pub fn ensure_focus_protocol() {
    #[cfg(target_os = "windows")]
    {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            let _ = install_windows_focus_protocol();
        });
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            let _ = install_focus_shell();
        });
    }
}

/// Older name. Installs the click handler on every desktop, not only Windows.
pub fn ensure_windows_focus_protocol() {
    ensure_focus_protocol();
}

fn prepare_system_notification(title: &str, body: &str) -> (String, String) {
    let title = clip_notify_text(&sanitize_plain_text(title), 120);
    let body = clip_notify_text(&sanitize_plain_text(body), 240);
    let title = if title.is_empty() {
        "JeikCode".to_string()
    } else {
        title
    };
    (title, body)
}

fn clip_notify_text(s: &str, max_chars: usize) -> String {
    let count = s.chars().count();
    if count <= max_chars {
        return s.to_string();
    }
    let mut out = s
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    out.push('…');
    out
}

fn build_notification_plan(
    cfg: &NotificationConfig,
    event: NotificationEvent<'_>,
) -> Option<NotificationPlan> {
    if !cfg.enabled {
        return None;
    }
    if cfg.background_only && terminal_focus_state() == Some(true) {
        return None;
    }

    let (title, body, terminal_id, visibility) = match event {
        NotificationEvent::ApprovalNeeded(approval) => {
            let (title, body) = build_approval_notification_text(&approval);
            (
                title,
                body,
                "jeikcode-approval",
                VisibilityPolicy::BackgroundOnlyBestEffort,
            )
        }
        NotificationEvent::TurnFinished(turn) => {
            if turn.duration < Duration::from_secs(cfg.min_duration_secs) {
                return None;
            }
            let (title, body) = build_system_notification_text(&turn);
            (
                title,
                body,
                "jeikcode-task",
                VisibilityPolicy::BackgroundOnlyBestEffort,
            )
        }
    };

    // Windows 上系统通知走 PowerShell NotifyIcon，实测会让 TUI 闪退，整条通道关掉。
    //
    // For background-only notifications, only use OS-native fallbacks when we
    // know the terminal is actually unfocused. macOS Terminal.app does not feed
    // focus events into our current reader, so its state stays Unknown while the
    // user may still be reading scrollback in the foreground. BEL / terminal
    // protocols can still let the terminal decide how much attention to request.
    let emit_system = cfg.system
        && !cfg!(target_os = "windows")
        && (!cfg.background_only || terminal_focus_state() == Some(false));

    Some(NotificationPlan {
        title,
        body,
        terminal_id,
        visibility,
        emit_terminal: cfg.terminal,
        emit_system,
        emit_bell: cfg.bell,
    })
}

fn dispatch_notification(plan: NotificationPlan) {
    let terminal_result = if plan.emit_terminal {
        deliver_terminal_notification(&plan)
    } else {
        DeliveryResult::Unsupported
    };

    if plan.emit_bell {
        let _ = emit_bell();
    }

    if plan.emit_system && terminal_result != DeliveryResult::Delivered {
        spawn_system_notification(plan.title.into_owned(), plan.body, None);
    }
}

fn deliver_terminal_notification(plan: &NotificationPlan) -> DeliveryResult {
    match emit_terminal_notification(plan) {
        Ok(true) => DeliveryResult::Delivered,
        Ok(false) => DeliveryResult::Unsupported,
        Err(_) => DeliveryResult::Failed,
    }
}

fn emit_terminal_notification(plan: &NotificationPlan) -> io::Result<bool> {
    let Some(app) = detect_terminal_app() else {
        return Ok(false);
    };
    let mut stdout = io::stdout();
    if stdout.is_terminal() {
        if !write_terminal_notification(&mut stdout, app, plan)? {
            return Ok(false);
        }
        stdout.flush()?;
        return Ok(true);
    }
    let mut stderr = io::stderr();
    if stderr.is_terminal() {
        if !write_terminal_notification(&mut stderr, app, plan)? {
            return Ok(false);
        }
        stderr.flush()?;
        return Ok(true);
    }
    Ok(false)
}

#[cfg(test)]
fn build_turn_terminal_notification_text(
    app: TerminalApp,
    turn: &TurnNotification<'_>,
) -> (Cow<'static, str>, String) {
    let (title, mut body) = build_system_notification_text(turn);
    if matches!(
        app,
        TerminalApp::Kitty | TerminalApp::WezTerm | TerminalApp::Ghostty
    ) {
        if let Some(scope) = turn
            .working_dir
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty())
        {
            body = format!("{} · {}", scope, body);
        }
    }
    (title, body)
}

fn build_turn_system_notification_text(turn: &TurnNotification<'_>) -> (Cow<'static, str>, String) {
    let title = match turn.stop_reason {
        NotifyStopReason::Natural => Cow::Borrowed("JeikCode done"),
        NotifyStopReason::Cancelled => Cow::Borrowed("JeikCode cancelled"),
        NotifyStopReason::Error => Cow::Borrowed("JeikCode failed"),
        NotifyStopReason::TurnLimit => Cow::Borrowed("JeikCode stopped"),
        NotifyStopReason::StepLimit => Cow::Borrowed("JeikCode stopped"),
    };
    let status = match turn.stop_reason {
        NotifyStopReason::Natural => "Done",
        NotifyStopReason::Cancelled => "Cancelled",
        NotifyStopReason::Error => "Failed",
        NotifyStopReason::TurnLimit => "Stopped",
        NotifyStopReason::StepLimit => "Stopped",
    };
    let mut body = format!("{} · {}", status, fmt_duration(turn.duration));
    if turn.turn_count > 0 {
        body.push_str(&format!(" · {} rounds", turn.turn_count));
    }
    if turn.tool_call_count > 0 {
        body.push_str(&format!(" · {} tools", turn.tool_call_count));
    }
    (title, body)
}

fn build_system_notification_text(turn: &TurnNotification<'_>) -> (Cow<'static, str>, String) {
    build_turn_system_notification_text(turn)
}

fn build_approval_notification_text(
    approval: &ApprovalNotification<'_>,
) -> (Cow<'static, str>, String) {
    let title = Cow::Borrowed("JeikCode approval needed");
    let mut body = format!("{} is waiting for Y/A/N", approval.tool_name);
    if let Some(scope) = approval
        .working_dir
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
    {
        body.push_str(&format!(" · {}", scope));
    }
    if let Some(detail) = approval.detail.filter(|s| !s.trim().is_empty()) {
        body.push_str(&format!(" · {}", detail.trim()));
    }
    (title, body)
}

fn fmt_duration(duration: Duration) -> String {
    let ms = duration.as_millis();
    if ms < 1000 {
        format!("{}ms", ms)
    } else {
        format!("{:.1}s", duration.as_secs_f64())
    }
}

fn emit_bell() -> io::Result<bool> {
    let mut stdout = io::stdout();
    if stdout.is_terminal() {
        stdout.write_all(b"\x07")?;
        stdout.flush()?;
        return Ok(true);
    }
    let mut stderr = io::stderr();
    if stderr.is_terminal() {
        stderr.write_all(b"\x07")?;
        stderr.flush()?;
        return Ok(true);
    }
    Ok(false)
}

fn write_terminal_notification(
    out: &mut dyn Write,
    app: TerminalApp,
    plan: &NotificationPlan,
) -> io::Result<bool> {
    match app {
        TerminalApp::Kitty => {
            let title = &plan.title;
            let body = &plan.body;
            write_kitty_notification(out, plan.terminal_id, plan.visibility, title, body)?;
            Ok(true)
        }
        TerminalApp::WezTerm | TerminalApp::Ghostty => {
            let title = &plan.title;
            let body = &plan.body;
            write_osc777_notification(out, title, body)?;
            Ok(true)
        }
        TerminalApp::ITerm2 => {
            let title = &plan.title;
            let body = &plan.body;
            write_iterm2_notification(out, title, body)?;
            Ok(true)
        }
        TerminalApp::AppleTerminal | TerminalApp::WindowsTerminal => Ok(false),
    }
}

fn write_kitty_notification(
    out: &mut dyn Write,
    id: &str,
    visibility: VisibilityPolicy,
    title: &str,
    body: &str,
) -> io::Result<()> {
    let title = sanitize_plain_text(title);
    let body = sanitize_plain_text(body);
    let visibility = match visibility {
        VisibilityPolicy::BackgroundOnlyBestEffort => "unfocused",
    };
    write!(out, "\x1b]99;i={id}:o={visibility}:d=0;{title}\x1b\\")?;
    write!(out, "\x1b]99;i={id}:p=body;{body}\x1b\\")?;
    Ok(())
}

fn write_osc777_notification(out: &mut dyn Write, title: &str, body: &str) -> io::Result<()> {
    let title = sanitize_plain_text(title).replace(';', ":");
    let body = sanitize_plain_text(body).replace(';', ":");
    write!(out, "\x1b]777;notify;{title};{body}\x1b\\")?;
    Ok(())
}

fn write_iterm2_notification(out: &mut dyn Write, title: &str, body: &str) -> io::Result<()> {
    let payload = match (title.trim().is_empty(), body.trim().is_empty()) {
        (false, false) => sanitize_plain_text(&format!("{title}: {body}")),
        (false, true) => sanitize_plain_text(title),
        (true, false) => sanitize_plain_text(body),
        (true, true) => String::from("JeikCode"),
    };
    write!(out, "\x1b]9;{payload}\x1b\\")?;
    Ok(())
}

fn detect_terminal_app() -> Option<TerminalApp> {
    if std::env::var_os("KITTY_WINDOW_ID").is_some() {
        return Some(TerminalApp::Kitty);
    }
    if std::env::var_os("WEZTERM_PANE").is_some() {
        return Some(TerminalApp::WezTerm);
    }
    if std::env::var_os("WT_SESSION").is_some() {
        return Some(TerminalApp::WindowsTerminal);
    }

    let term_program = std::env::var("TERM_PROGRAM").unwrap_or_default();
    if term_program.eq_ignore_ascii_case("wezterm") {
        return Some(TerminalApp::WezTerm);
    }
    if term_program.eq_ignore_ascii_case("ghostty") {
        return Some(TerminalApp::Ghostty);
    }
    if term_program == "iTerm.app" || term_program.eq_ignore_ascii_case("iTerm2") {
        return Some(TerminalApp::ITerm2);
    }
    if term_program.eq_ignore_ascii_case("apple_terminal")
        || term_program.eq_ignore_ascii_case("terminal.app")
        || term_program.eq_ignore_ascii_case("terminal")
    {
        return Some(TerminalApp::AppleTerminal);
    }
    if term_program.eq_ignore_ascii_case("windows_terminal") {
        return Some(TerminalApp::WindowsTerminal);
    }

    let lc_terminal = std::env::var("LC_TERMINAL").unwrap_or_default();
    if lc_terminal.eq_ignore_ascii_case("iTerm2") {
        return Some(TerminalApp::ITerm2);
    }
    if lc_terminal.eq_ignore_ascii_case("Terminal") {
        return Some(TerminalApp::AppleTerminal);
    }

    let term = std::env::var("TERM").unwrap_or_default();
    if term.contains("kitty") {
        return Some(TerminalApp::Kitty);
    }

    None
}

fn sanitize_plain_text(s: &str) -> String {
    s.chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(target_os = "macos")]
fn macos_terminal_bundle_id(app: Option<TerminalApp>) -> Option<&'static str> {
    match app {
        Some(TerminalApp::AppleTerminal) => Some("com.apple.Terminal"),
        Some(TerminalApp::ITerm2) => Some("com.googlecode.iterm2"),
        Some(TerminalApp::WezTerm) => Some("com.github.wez.wezterm"),
        Some(TerminalApp::Ghostty) => Some("com.mitchellh.ghostty"),
        Some(TerminalApp::Kitty) => Some("net.kovidgoyal.kitty"),
        _ => None,
    }
}

// Only the macOS branch of `spawn_system_notification` calls this (to
// find `terminal-notifier`). Linux uses notify-send unconditionally and
// Windows shells out to powershell.exe — neither needs PATH lookup.
// Kept callable on every platform because `missing_executable_lookup_
// returns_none` is a portable unit test of PATH-iteration semantics.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn find_executable_on_path(name: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn spawn_system_notification(title: String, body: String, launch: Option<String>) {
    std::thread::spawn(move || {
        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        let _ = &launch;

        #[cfg(target_os = "macos")]
        {
            let _ = install_focus_shell();
            if let Some(bin) = find_executable_on_path("terminal-notifier") {
                let mut cmd = Command::new(bin);
                cmd.arg("-title")
                    .arg(&title)
                    .arg("-message")
                    .arg(&body)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                if let (Some(uri), Some(script)) = (launch.as_deref(), focus_shell_path()) {
                    cmd.arg("-execute")
                        .arg(macos_execute_line(&script.to_string_lossy(), uri));
                } else if let Some(bundle_id) = macos_terminal_bundle_id(detect_terminal_app()) {
                    cmd.arg("-activate").arg(bundle_id);
                }
                if cmd.spawn().is_ok() {
                    return;
                }
            }

            ensure_macos_focus_helper();
            if let (Some(uri), Some(helper)) = (launch.as_deref(), macos_focus_helper_bin()) {
                if Command::new(helper)
                    .arg(&title)
                    .arg(&body)
                    .arg(uri)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .is_ok()
                {
                    return;
                }
            }

            let script = format!(
                "display notification {} with title {}",
                apple_script_string(&body),
                apple_script_string(&title)
            );
            let _ = Command::new("osascript")
                .arg("-e")
                .arg(script)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
        }

        #[cfg(target_os = "linux")]
        {
            let _ = install_focus_shell();
            if let Some(script) = focus_shell_path() {
                if Command::new(script)
                    .arg("linux-notify")
                    .arg(&title)
                    .arg(&body)
                    .arg(launch.as_deref().unwrap_or(""))
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .is_ok()
                {
                    return;
                }
            }
            let _ = Command::new("notify-send")
                .arg(&title)
                .arg(&body)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
        }

        #[cfg(target_os = "windows")]
        {
            // WinRT toast in a separate process. NotifyIcon balloons in the TUI
            // process have crashed the terminal, so this path stays detached
            // and never pumps a message loop on the caller.
            //
            // App id order matters: an unregistered "JeikCode" Show() does not
            // throw, so it must not be tried first or the registered PowerShell
            // id (the one that raises a banner) never runs.
            let xml = windows_toast_xml(&title, &body, launch.as_deref());
            let app_ids = windows_toast_app_ids()
                .iter()
                .map(|id| format!("'{}'", powershell_string_literal(id)))
                .collect::<Vec<_>>()
                .join(", ");
            let script = format!(
                "$ErrorActionPreference = 'Stop'; \
                 [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; \
                 [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null; \
                 $xml = New-Object Windows.Data.Xml.Dom.XmlDocument; \
                 $xml.LoadXml('{}'); \
                 $toast = [Windows.UI.Notifications.ToastNotification]::new($xml); \
                 $shown = $false; \
                 foreach ($appId in @({app_ids})) {{ \
                   try {{ [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast); $shown = $true; break }} catch {{ }} \
                 }}; \
                 if (-not $shown) {{ \
                   Add-Type -AssemblyName System.Windows.Forms; \
                   Add-Type -AssemblyName System.Drawing; \
                   $n = New-Object System.Windows.Forms.NotifyIcon; \
                   $n.Icon = [System.Drawing.SystemIcons]::Information; \
                   $n.BalloonTipTitle = '{}'; \
                   $n.BalloonTipText = '{}'; \
                   $n.Visible = $true; \
                   $n.ShowBalloonTip(25000); \
                   Start-Sleep -Milliseconds 26000; \
                   $n.Dispose(); \
                 }}",
                powershell_string_literal(&xml),
                powershell_string_literal(&title),
                powershell_string_literal(&body),
            );
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let _ = Command::new("powershell.exe")
                .arg("-NoProfile")
                .arg("-NonInteractive")
                .arg("-WindowStyle")
                .arg("Hidden")
                .arg("-Command")
                .arg(script)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
        }
    });
}

#[cfg(target_os = "macos")]
fn apple_script_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(target_os = "windows")]
fn powershell_string_literal(s: &str) -> String {
    s.replace('\'', "''")
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(target_os = "windows")]
const FOCUS_PROTOCOL_SCRIPT: &str = r#"param([Parameter(Position=0)][string]$Uri)
$ErrorActionPreference = 'Continue'
try {
  if ([string]::IsNullOrWhiteSpace($Uri)) { exit 0 }
  $Uri = $Uri.Trim().Trim('"').Trim("'")
  if ($Uri -notmatch '^jeikcode-focus:(\d{1,5}):([0-9a-fA-F]{32}):([A-Za-z0-9_-]{1,128})(?::([A-Za-z0-9_]{1,32}))?$') { exit 0 }
  $port = $Matches[1]
  $secret = $Matches[2]
  $session = $Matches[3]
  $action = $Matches[4]
  $payload = '{"session_id":"' + $session + '","secret":"' + $secret + '"}'
  try {
    Invoke-RestMethod -Method Post -Uri ("http://127.0.0.1:" + $port + "/notify-focus") -ContentType 'application/json; charset=utf-8' -Body $payload -TimeoutSec 3 | Out-Null
  } catch {}
  if (-not [string]::IsNullOrWhiteSpace($action)) {
    $permPayload = '{"session_id":"' + $session + '","decision":"' + $action + '"}'
    try {
      Invoke-RestMethod -Method Post -Uri ("http://127.0.0.1:" + $port + "/chat/permission") -ContentType 'application/json; charset=utf-8' -Body $permPayload -TimeoutSec 3 | Out-Null
    } catch {}
    try {
      Invoke-RestMethod -Method Post -Uri ("http://127.0.0.1:" + $port + "/live/permission") -ContentType 'application/json; charset=utf-8' -Body $permPayload -TimeoutSec 3 | Out-Null
    } catch {}
  }

  # 安全激活已有的 JeikCode 桌面窗口，使用 Windows 标准安全 COM 组件，绝不包含底层 C# 注入和键盘模拟，根除杀软误报
  try {
    $wshell = New-Object -ComObject WScript.Shell
    $desktopProcs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $_.ProcessName -match '(?i)^(jeikcode-desktop|jeikcode_desktop|jeikcode desktop|jeikcode)$'
    })
    foreach ($p in $desktopProcs) {
      if ($p.MainWindowHandle -ne [IntPtr]::Zero) {
        [void]$wshell.AppActivate($p.Id)
        break
      }
    }
  } catch {}
} catch {
  exit 0
}
"#;

#[cfg(target_os = "windows")]
const FOCUS_VBS_SCRIPT: &str = r#"Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1Path = fso.BuildPath(scriptDir, "notify-focus.ps1")
args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " """ & WScript.Arguments(i) & """"
Next
WshShell.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & ps1Path & """" & args, 0, False
"#;

#[cfg(target_os = "windows")]
fn install_windows_focus_protocol() -> io::Result<()> {
    let home = jeikcode_config::config::Config::default_path()
        .parent()
        .map(|path| path.to_path_buf())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "jeikcode home"))?;
    std::fs::create_dir_all(&home)?;

    // 释放官方应用 Logo，用于 Windows Toast 的 appLogoOverride 呈现
    let assets_dir = home.join("assets");
    let _ = std::fs::create_dir_all(&assets_dir);
    let icon_path = assets_dir.join("icon.png");
    let _ = std::fs::write(&icon_path, JEIKCODE_ICON_BYTES);

    let script_path = home.join("notify-focus.ps1");
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(FOCUS_PROTOCOL_SCRIPT.as_bytes());
    std::fs::write(&script_path, bytes)?;

    let vbs_path = home.join("notify-focus.vbs");
    let mut vbs_bytes = vec![0xEF, 0xBB, 0xBF];
    vbs_bytes.extend_from_slice(FOCUS_VBS_SCRIPT.as_bytes());
    std::fs::write(&vbs_path, vbs_bytes)?;

    let wscript = std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .map(|root| root.join(r"System32\wscript.exe"))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| std::path::PathBuf::from("wscript.exe"));
    let command = format!(
        "\"{}\" //B //nologo \"{}\" \"%1\"",
        wscript.display(),
        vbs_path.display(),
    );
    let _ = reg_add(&[
        "add",
        r"HKCU\Software\Classes\jeikcode-focus",
        "/ve",
        "/d",
        "URL:JeikCode Focus",
        "/f",
    ]);
    let _ = reg_add(&[
        "add",
        r"HKCU\Software\Classes\jeikcode-focus",
        "/v",
        "URL Protocol",
        "/t",
        "REG_SZ",
        "/d",
        "",
        "/f",
    ]);
    let _ = reg_add(&[
        "add",
        r"HKCU\Software\Classes\jeikcode-focus\shell\open\command",
        "/ve",
        "/d",
        &command,
        "/f",
    ]);

    // 注册应用专属 AUMID 标识与图标，根除 PowerShell 默认大标题
    let _ = reg_add(&[
        "add",
        r"HKCU\Software\Classes\AppUserModelId\JeikCode",
        "/v",
        "DisplayName",
        "/t",
        "REG_SZ",
        "/d",
        "JeikCode",
        "/f",
    ]);
    let _ = reg_add(&[
        "add",
        r"HKCU\Software\Classes\AppUserModelId\JeikCode",
        "/v",
        "IconUri",
        "/t",
        "REG_SZ",
        "/d",
        &icon_path.to_string_lossy(),
        "/f",
    ]);
    Ok(())
}

#[cfg(target_os = "windows")]
fn reg_add(args: &[&str]) -> io::Result<()> {
    let status = Command::new("reg.exe")
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::Other,
            format!("reg add failed: {status}"),
        ))
    }
}

#[cfg_attr(
    not(any(target_os = "macos", target_os = "linux", test)),
    allow(dead_code)
)]
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn macos_execute_line(script: &str, launch: &str) -> String {
    format!(
        "{} focus {}",
        shell_single_quote(script),
        shell_single_quote(launch)
    )
}

#[cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]
fn jeikcode_home() -> Option<std::path::PathBuf> {
    jeikcode_config::config::Config::default_path()
        .parent()
        .map(|path| path.to_path_buf())
}

#[cfg_attr(
    not(any(target_os = "macos", target_os = "linux", test)),
    allow(dead_code)
)]
fn focus_shell_script() -> String {
    FOCUS_SHELL_SCRIPT.replace("\r\n", "\n")
}

#[cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]
fn focus_shell_path() -> Option<std::path::PathBuf> {
    let path = jeikcode_home()?.join("notify-focus.sh");
    path.is_file().then_some(path)
}

#[cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]
fn install_focus_shell() -> io::Result<std::path::PathBuf> {
    let home =
        jeikcode_home().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "jeikcode home"))?;
    std::fs::create_dir_all(&home)?;
    let path = home.join("notify-focus.sh");
    std::fs::write(&path, focus_shell_script())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(path)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn macos_focus_helper_bin() -> Option<std::path::PathBuf> {
    let path = jeikcode_home()?.join("JeikCodeFocus.app/Contents/MacOS/JeikCodeFocus");
    path.is_file().then_some(path)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn ensure_macos_focus_helper() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = build_macos_focus_helper();
    });
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn build_macos_focus_helper() -> io::Result<()> {
    let home =
        jeikcode_home().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "jeikcode home"))?;
    let contents = home.join("JeikCodeFocus.app/Contents");
    let macos_dir = contents.join("MacOS");
    std::fs::create_dir_all(&macos_dir)?;
    std::fs::write(contents.join("Info.plist"), MACOS_FOCUS_PLIST)?;
    let source = home.join("focus.swift");
    std::fs::write(&source, macos_notifier_swift())?;
    let bin = macos_dir.join("JeikCodeFocus");
    if bin.is_file() {
        let bin_time = std::fs::metadata(&bin)
            .and_then(|meta| meta.modified())
            .ok();
        let src_time = std::fs::metadata(&source)
            .and_then(|meta| meta.modified())
            .ok();
        if matches!((bin_time, src_time), (Some(bin_at), Some(src_at)) if bin_at >= src_at) {
            return Ok(());
        }
    }
    let staged = macos_dir.join("JeikCodeFocus.new");
    let status = Command::new("swiftc")
        .arg("-O")
        .arg("-o")
        .arg(&staged)
        .arg(&source)
        .arg("-framework")
        .arg("AppKit")
        .arg("-framework")
        .arg("UserNotifications")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if !status.success() {
        let _ = std::fs::remove_file(&staged);
        return Err(io::Error::new(io::ErrorKind::Other, "swiftc failed"));
    }
    std::fs::rename(&staged, &bin)?;
    let app = home.join("JeikCodeFocus.app");
    let _ = Command::new("codesign")
        .arg("--force")
        .arg("--sign")
        .arg("-")
        .arg(&app)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
    let _ = Command::new(lsregister)
        .arg("-f")
        .arg(&app)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    Ok(())
}

const FOCUS_SHELL_SCRIPT: &str = r#"#!/bin/sh
cmd=${1:-}
if [ "$#" -gt 0 ]; then
  shift
fi

focus_uri() {
  uri=$(printf '%s' "$1" | tr -d '"' | tr -d "'")
  case "$uri" in
    jeikcode-focus:*) ;;
    *) return 0 ;;
  esac
  rest=${uri#jeikcode-focus:}
  port=${rest%%:*}
  rest=${rest#*:}
  secret=${rest%%:*}
  rest=${rest#*:}
  session=${rest%%:*}
  if [ "$session" != "$rest" ]; then
    action=${rest#*:}
  else
    action=""
  fi
  case "$port" in
    ''|0*|*[!0-9]*) return 0 ;;
  esac
  if [ "${#port}" -gt 5 ]; then
    return 0
  fi
  case "$secret" in
    *[!0-9a-fA-F]*|'') return 0 ;;
  esac
  if [ "${#secret}" -ne 32 ]; then
    return 0
  fi
  case "$session" in
    *[!A-Za-z0-9_-]*|'') return 0 ;;
  esac
  if [ "${#session}" -gt 128 ]; then
    return 0
  fi
  payload=$(printf '{"session_id":"%s","secret":"%s"}' "$session" "$secret")
  url="http://127.0.0.1:${port}/notify-focus"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 3 -X POST -H 'Content-Type: application/json' --data "$payload" "$url" >/dev/null 2>&1 || true
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 3 -O /dev/null --header='Content-Type: application/json' --post-data="$payload" "$url" >/dev/null 2>&1 || true
  fi
  if [ -n "$action" ]; then
    act_payload=$(printf '{"session_id":"%s","decision":"%s"}' "$session" "$action")
    act_url="http://127.0.0.1:${port}/chat/permission"
    if command -v curl >/dev/null 2>&1; then
      curl -fsS -m 3 -X POST -H 'Content-Type: application/json' --data "$act_payload" "$act_url" >/dev/null 2>&1 || true
    elif command -v wget >/dev/null 2>&1; then
      wget -q -T 3 -O /dev/null --header='Content-Type: application/json' --post-data="$act_payload" "$act_url" >/dev/null 2>&1 || true
    fi
  fi
  raise_jeikcode_window
}

raise_jeikcode_window() {
  os=$(uname -s 2>/dev/null || echo unknown)
  if [ "$os" = "Darwin" ]; then
    osascript -e 'tell application "JeikCode Desktop" to activate' >/dev/null 2>&1 || true
    osascript >/dev/null 2>&1 <<'APPLESCRIPT' || true
tell application "System Events"
  repeat with proc in processes
    try
      repeat with w in windows of proc
        if name of w contains "JeikCode" then
          set frontmost of proc to true
          exit repeat
        end if
      end repeat
    end try
  end repeat
end tell
APPLESCRIPT
    return
  fi
  if command -v wmctrl >/dev/null 2>&1; then
    wmctrl -a JeikCode >/dev/null 2>&1 || true
  fi
  if command -v xdotool >/dev/null 2>&1; then
    wid=$(xdotool search --name JeikCode 2>/dev/null | head -n 1)
    if [ -n "$wid" ]; then
      xdotool windowactivate "$wid" >/dev/null 2>&1 || true
    fi
  fi
}

case "$cmd" in
  focus)
    focus_uri "${1:-}"
    ;;
  linux-notify)
    title=${1:-}
    body=${2:-}
    uri=${3:-}
    action=""
    is_appr=0
    case "$title $body" in
      *approval*|*审核*|*review*) is_appr=1 ;;
    esac
    if command -v notify-send >/dev/null 2>&1; then
      if [ "$is_appr" -eq 1 ]; then
        action=$(notify-send -a JeikCode -t 25000 -A allow="Approve" -A deny="Deny" -A default="Open" -w "$title" "$body" 2>/dev/null || echo "")
      else
        action=$(notify-send -a JeikCode -t 25000 -A default="Answer / Open" -w "$title" "$body" 2>/dev/null || echo "")
      fi
    fi
    case "$action" in
      allow)
        if [ -n "$uri" ]; then focus_uri "${uri}:allow"; fi
        ;;
      deny)
        if [ -n "$uri" ]; then focus_uri "${uri}:deny"; fi
        ;;
      default|Open|"Answer / Open")
        if [ -n "$uri" ]; then focus_uri "$uri"; fi
        ;;
    esac
    ;;
esac
"#;

#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn macos_notifier_swift() -> &'static str {
    MACOS_NOTIFIER_SWIFT
}

const MACOS_NOTIFIER_SWIFT: &str = r#"import AppKit
import Foundation
import UserNotifications

final class ClickDelegate: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        if #available(macOS 11.0, *) {
            completionHandler([.banner, .list, .sound])
        } else {
            completionHandler([])
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        if let uri = info["launch"] as? String {
            runFocus(uri)
        }
        completionHandler()
        NSApp.stop(nil)
    }
}

private let clickDelegate = ClickDelegate()

func scriptPath() -> String {
    Bundle.main.bundleURL
        .deletingLastPathComponent()
        .appendingPathComponent("notify-focus.sh")
        .path
}

func runFocus(_ uri: String) {
    guard uri.hasPrefix("jeikcode-focus:") else { return }
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/bin/sh")
    task.arguments = [scriptPath(), "focus", uri]
    try? task.run()
    task.waitUntilExit()
}

func post(title: String, body: String, launch: String) {
    let center = UNUserNotificationCenter.current()
    center.delegate = clickDelegate
    center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
        DispatchQueue.main.async {
            guard granted else {
                NSApp.stop(nil)
                return
            }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            if launch.hasPrefix("jeikcode-focus:") {
                content.userInfo = ["launch": launch]
            }
            content.sound = .default
            let request = UNNotificationRequest(
                identifier: UUID().uuidString,
                content: content,
                trigger: nil
            )
            center.add(request) { _ in }
            DispatchQueue.main.asyncAfter(deadline: .now() + 25) {
                NSApp.stop(nil)
            }
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
UNUserNotificationCenter.current().delegate = clickDelegate
let args = CommandLine.arguments
if args.count >= 3 {
    let launch = args.count >= 4 ? args[3] : ""
    post(title: args[1], body: args[2], launch: launch)
} else if args.count >= 2, args[1].hasPrefix("jeikcode-focus:") {
    runFocus(args[1])
    exit(0)
}
DispatchQueue.main.asyncAfter(deadline: .now() + 25) {
    NSApp.stop(nil)
}
app.run()
"#;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MACOS_FOCUS_PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.jeikcode.focus</string>
  <key>CFBundleName</key>
  <string>JeikCode</string>
  <key>CFBundleExecutable</key>
  <string>JeikCodeFocus</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundleShortVersionString</key>
  <string>1</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard, OnceLock};

    fn focus_state_test_lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
    }

    #[test]
    fn builds_human_readable_notification_text() {
        let (title, body) = build_system_notification_text(&TurnNotification {
            duration: Duration::from_secs(12),
            turn_count: 3,
            tool_call_count: 5,
            total_tokens: Some(4321),
            stop_reason: NotifyStopReason::Natural,
            working_dir: Some(Path::new("/tmp/demo")),
        });
        assert_eq!(title, "JeikCode done");
        assert_eq!(body, "Done · 12.0s · 3 rounds · 5 tools");
    }

    #[test]
    fn terminal_text_is_compact_for_iterm() {
        let (title, body) = build_turn_terminal_notification_text(
            TerminalApp::ITerm2,
            &TurnNotification {
                duration: Duration::from_secs(49),
                turn_count: 4,
                tool_call_count: 9,
                total_tokens: Some(1209),
                stop_reason: NotifyStopReason::Natural,
                working_dir: Some(Path::new("/tmp/jeikcode")),
            },
        );
        assert_eq!(title, "JeikCode done");
        assert_eq!(body, "Done · 49.0s · 4 rounds · 9 tools");
    }

    #[test]
    fn terminal_text_keeps_scope_for_split_title_body_protocols() {
        let (_title, body) = build_turn_terminal_notification_text(
            TerminalApp::WezTerm,
            &TurnNotification {
                duration: Duration::from_secs(12),
                turn_count: 3,
                tool_call_count: 5,
                total_tokens: None,
                stop_reason: NotifyStopReason::Natural,
                working_dir: Some(Path::new("/tmp/demo")),
            },
        );
        assert!(body.contains("3 rounds"));
        assert!(body.contains("5 tools"));
        assert!(body.starts_with("demo · Done"));
    }

    #[test]
    fn approval_notification_is_action_oriented() {
        let (title, body) = build_approval_notification_text(&ApprovalNotification {
            tool_name: "Bash",
            detail: Some("ls -la ~/.ssh/"),
            working_dir: Some(Path::new("/tmp/demo")),
        });
        assert_eq!(title, "JeikCode approval needed");
        assert!(body.contains("Bash is waiting for Y/A/N"));
        assert!(body.contains("demo"));
        assert!(body.contains("ls -la ~/.ssh/"));
    }

    #[test]
    fn background_only_is_preserved_for_approval_notifications() {
        let plan = NotificationPlan {
            title: Cow::Borrowed("JeikCode approval needed"),
            body: "Bash is waiting for Y/A/N".into(),
            terminal_id: "jeikcode-approval",
            visibility: VisibilityPolicy::BackgroundOnlyBestEffort,
            emit_terminal: true,
            emit_system: true,
            emit_bell: true,
        };
        let mut out = Vec::new();
        assert!(write_terminal_notification(&mut out, TerminalApp::Kitty, &plan).unwrap());
        let rendered = String::from_utf8(out).unwrap();
        assert!(rendered.contains(":o=unfocused:"));
    }

    #[test]
    fn iterm2_uses_osc9_notification_sequence() {
        let plan = NotificationPlan {
            title: Cow::Borrowed("JeikCode approval needed"),
            body: "Bash is waiting for Y/A/N".into(),
            terminal_id: "jeikcode-approval",
            visibility: VisibilityPolicy::BackgroundOnlyBestEffort,
            emit_terminal: true,
            emit_system: true,
            emit_bell: true,
        };
        let mut out = Vec::new();
        assert!(write_terminal_notification(&mut out, TerminalApp::ITerm2, &plan).unwrap());
        let rendered = String::from_utf8(out).unwrap();
        assert!(rendered.starts_with("\u{1b}]9;"));
        assert!(rendered.ends_with("\u{1b}\\"));
    }

    #[test]
    fn apple_terminal_has_no_native_terminal_notification_path() {
        let plan = NotificationPlan {
            title: Cow::Borrowed("JeikCode done"),
            body: "Done · 12.0s".into(),
            terminal_id: "jeikcode-task",
            visibility: VisibilityPolicy::BackgroundOnlyBestEffort,
            emit_terminal: true,
            emit_system: true,
            emit_bell: true,
        };
        let mut out = Vec::new();
        assert!(!write_terminal_notification(&mut out, TerminalApp::AppleTerminal, &plan).unwrap());
        assert!(out.is_empty());
    }

    #[test]
    fn turn_finished_below_threshold_is_suppressed_by_policy() {
        let cfg = NotificationConfig::default();
        let plan = build_notification_plan(
            &cfg,
            NotificationEvent::TurnFinished(TurnNotification {
                duration: Duration::from_secs(2),
                turn_count: 1,
                tool_call_count: 1,
                total_tokens: None,
                stop_reason: NotifyStopReason::Natural,
                working_dir: Some(Path::new("/tmp/demo")),
            }),
        );
        assert!(plan.is_none());
    }

    #[test]
    fn approval_event_ignores_duration_threshold() {
        let cfg = NotificationConfig::default();
        let plan = build_notification_plan(
            &cfg,
            NotificationEvent::ApprovalNeeded(ApprovalNotification {
                tool_name: "Bash",
                detail: Some("ls -la ~/.ssh/"),
                working_dir: Some(Path::new("/tmp/demo")),
            }),
        )
        .unwrap();
        assert_eq!(plan.terminal_id, "jeikcode-approval");
        assert_eq!(plan.visibility, VisibilityPolicy::BackgroundOnlyBestEffort);
    }

    #[test]
    fn focused_terminal_suppresses_background_only_notifications() {
        let _guard = focus_state_test_lock();
        let cfg = NotificationConfig::default();
        set_terminal_focus_state(Some(true));
        let plan = build_notification_plan(
            &cfg,
            NotificationEvent::ApprovalNeeded(ApprovalNotification {
                tool_name: "Bash",
                detail: Some("ls -la ~/.ssh/"),
                working_dir: Some(Path::new("/tmp/demo")),
            }),
        );
        set_terminal_focus_state(None);
        assert!(plan.is_none());
    }

    #[test]
    fn background_only_unknown_focus_suppresses_system_fallback() {
        let _guard = focus_state_test_lock();
        let cfg = NotificationConfig::default();
        set_terminal_focus_state(None);
        let plan = build_notification_plan(
            &cfg,
            NotificationEvent::TurnFinished(TurnNotification {
                duration: Duration::from_secs(12),
                turn_count: 1,
                tool_call_count: 1,
                total_tokens: None,
                stop_reason: NotifyStopReason::Natural,
                working_dir: Some(Path::new("/tmp/demo")),
            }),
        )
        .unwrap();

        assert!(plan.emit_terminal);
        assert!(plan.emit_bell);
        assert!(!plan.emit_system);
    }

    #[test]
    fn background_only_unfocused_allows_system_fallback() {
        let _guard = focus_state_test_lock();
        let cfg = NotificationConfig::default();
        set_terminal_focus_state(Some(false));
        let plan = build_notification_plan(
            &cfg,
            NotificationEvent::TurnFinished(TurnNotification {
                duration: Duration::from_secs(12),
                turn_count: 1,
                tool_call_count: 1,
                total_tokens: None,
                stop_reason: NotifyStopReason::Natural,
                working_dir: Some(Path::new("/tmp/demo")),
            }),
        )
        .unwrap();
        set_terminal_focus_state(None);

        assert_eq!(plan.emit_system, !cfg!(target_os = "windows"));
    }

    #[test]
    fn non_background_only_keeps_system_fallback_for_unknown_focus() {
        let _guard = focus_state_test_lock();
        let mut cfg = NotificationConfig::default();
        cfg.background_only = false;
        set_terminal_focus_state(None);
        let plan = build_notification_plan(
            &cfg,
            NotificationEvent::TurnFinished(TurnNotification {
                duration: Duration::from_secs(12),
                turn_count: 1,
                tool_call_count: 1,
                total_tokens: None,
                stop_reason: NotifyStopReason::Natural,
                working_dir: Some(Path::new("/tmp/demo")),
            }),
        )
        .unwrap();

        assert_eq!(plan.emit_system, !cfg!(target_os = "windows"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_terminal_bundle_ids_match_supported_terminals() {
        assert_eq!(
            macos_terminal_bundle_id(Some(TerminalApp::AppleTerminal)),
            Some("com.apple.Terminal")
        );
        assert_eq!(
            macos_terminal_bundle_id(Some(TerminalApp::ITerm2)),
            Some("com.googlecode.iterm2")
        );
        assert_eq!(
            macos_terminal_bundle_id(Some(TerminalApp::WezTerm)),
            Some("com.github.wez.wezterm")
        );
        assert_eq!(
            macos_terminal_bundle_id(Some(TerminalApp::Ghostty)),
            Some("com.mitchellh.ghostty")
        );
        assert_eq!(
            macos_terminal_bundle_id(Some(TerminalApp::Kitty)),
            Some("net.kovidgoyal.kitty")
        );
    }

    #[test]
    fn missing_executable_lookup_returns_none() {
        assert!(find_executable_on_path("__jeikcode_missing_notifier__").is_none());
    }

    #[test]
    fn control_chars_are_removed_from_payloads() {
        let s = sanitize_plain_text("hi\x07 there\nnext\x1b");
        assert_eq!(s, "hi there next");
    }

    #[test]
    fn system_notification_text_is_clipped() {
        let (title, body) = prepare_system_notification("hi\x07", &"x".repeat(400));
        assert_eq!(title, "hi");
        assert!(body.chars().count() <= 240);
        assert!(body.ends_with('…'));
    }

    #[test]
    fn windows_toast_uses_a_registered_app_id_and_stays_clickable() {
        let ids = windows_toast_app_ids();
        assert!(
            ids.iter().all(|id| *id != "JeikCode"),
            "unregistered JeikCode AUMID swallows the toast without a banner"
        );
        assert!(ids[0].contains("powershell.exe"));
        let secret = "0123456789abcdef0123456789abcdef";
        let launch = focus_launch(13457, secret, "550e8400-e29b-41d4-a716-446655440000")
            .expect("uuid session");
        let xml = windows_toast_xml("JeikCode done", "A & B <session>", Some(&launch));
        assert!(xml.contains("duration=\"long\""));
        assert!(xml.contains("activationType=\"protocol\""));
        assert!(xml.contains(&format!("launch=\"{launch}\"")));
        assert!(xml.contains("A &amp; B &lt;session&gt;"));
        assert!(!xml.contains("A & B"));
        let plain = windows_toast_xml("JeikCode done", "body", None);
        assert!(plain.contains("duration=\"long\""));
        assert!(!plain.contains("activationType"));
        assert!(focus_launch(13457, secret, "bad id").is_none());
        assert!(focus_launch(0, secret, "session-1").is_none());
        assert!(accepted_focus_launch("JeikCode").is_none());
    }

    #[test]
    fn windows_toast_approval_includes_action_buttons() {
        let secret = "0123456789abcdef0123456789abcdef";
        let launch = focus_launch(13457, secret, "550e8400-e29b-41d4-a716-446655440000")
            .expect("uuid session");
        let xml = windows_toast_xml("JeikCode needs approval", "write_file", Some(&launch));
        assert!(xml.contains("<actions>"));
        assert!(xml.contains("content=\"Approve\""));
        assert!(xml.contains("content=\"Deny\""));
        assert!(!xml.contains("同意"));
        assert!(!xml.contains("拒绝"));
        assert!(xml.contains(&format!("arguments=\"{launch}:allow\"")));
        assert!(xml.contains(&format!("arguments=\"{launch}:deny\"")));

        let zh_xml = windows_toast_xml("JeikCode 等待审核", "write_file", Some(&launch));
        assert!(zh_xml.contains("<actions>"));
        assert!(zh_xml.contains("content=\"同意\""));
        assert!(zh_xml.contains("content=\"拒绝\""));
        assert!(!zh_xml.contains("Approve"));
        assert!(!zh_xml.contains("Deny"));

        // 关键防线测试：当标题为完成/停止通知时，即使会话名称(body)包含“审核”，也绝不能误加 Approve/Deny 按钮！
        let done_xml = windows_toast_xml(
            "JeikCode done",
            "JeikCode PR 5 审核 finished",
            Some(&launch),
        );
        assert!(!done_xml.contains("Approve"));
        assert!(!done_xml.contains("Deny"));
        assert!(!done_xml.contains("<actions>"));
    }

    #[test]
    fn windows_toast_question_includes_answer_button() {
        let secret = "0123456789abcdef0123456789abcdef";
        let launch = focus_launch(13457, secret, "550e8400-e29b-41d4-a716-446655440000")
            .expect("uuid session");
        let xml = windows_toast_xml(
            "JeikCode needs an answer",
            "Which port to use?",
            Some(&launch),
        );
        assert!(xml.contains("<actions>"));
        assert!(xml.contains("content=\"Answer\""));
        assert!(!xml.contains("作答"));

        let zh_xml = windows_toast_xml("JeikCode 需要你的回答", "请选择端口？", Some(&launch));
        assert!(zh_xml.contains("<actions>"));
        assert!(zh_xml.contains("content=\"作答\""));
        assert!(!zh_xml.contains("Answer"));
        assert!(xml.contains(&format!("arguments=\"{launch}\"")));
    }

    #[test]
    fn macos_and_linux_clicks_open_the_same_session_as_windows() {
        let script = focus_shell_script();
        assert!(script.contains("http://127.0.0.1:"));
        assert!(script.contains("jeikcode-focus:"));
        assert!(script.contains("linux-notify"));
        assert!(script.contains("-A default="));
        assert!(script.contains("-t 25000"));
        assert!(script.contains("JeikCode Desktop"));
        assert!(script.contains("wmctrl"));
        assert_eq!(shell_single_quote("a b's"), "'a b'\\''s'");
        let line = macos_execute_line(
            "/Users/A B/.jeikcode/notify-focus.sh",
            "jeikcode-focus:13457:0123456789abcdef0123456789abcdef:sess-1",
        );
        assert_eq!(
            line,
            "'/Users/A B/.jeikcode/notify-focus.sh' focus 'jeikcode-focus:13457:0123456789abcdef0123456789abcdef:sess-1'"
        );
        let swift = macos_notifier_swift();
        assert!(swift.contains("jeikcode-focus:"));
        assert!(swift.contains(".banner"));
        assert!(swift.contains("notify-focus.sh"));
        assert!(MACOS_FOCUS_PLIST.contains("JeikCode"));
        assert!(MACOS_FOCUS_PLIST.contains("com.jeikcode.focus"));
    }
}
