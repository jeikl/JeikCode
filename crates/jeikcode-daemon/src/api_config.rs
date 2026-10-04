use axum::extract::State;
use axum::{response::IntoResponse, Json};
use jeikcode_config::config::provider::ProviderConfig;
use jeikcode_config::config::Config;
use jeikcode_config::ConfigStore;

use crate::{json_error, AppState, ConfigResponse, ProviderInfo};

/// Load config from disk.
pub(crate) fn load_config() -> Result<Config, String> {
    let path = Config::default_path();
    match Config::load(&path) {
        Ok(config) => Ok(config),
        Err(e) => {
            let is_missing = e.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
            });
            if is_missing {
                Ok(empty_config())
            } else {
                Err(format!("Failed to load config: {:#}", e))
            }
        }
    }
}

fn empty_config() -> Config {
    Config::default()
}

/// Build a sanitized ConfigResponse from a loaded Config.
///
/// Lists the unified model catalog (`logical_models`) so new-schema and folded
/// CodingPlan models — which no longer live in `config.providers` — are still
/// selectable in the webui. Each selection id is reconstructed into a
/// `ProviderConfig` view via the resolution boundary.
pub(crate) fn config_response(config: &Config) -> ConfigResponse {
    let default_selection = config.effective_model_selection().unwrap_or_default();
    let logical_models = config.logical_models();
    let mut ids: Vec<String> = logical_models.keys().cloned().collect();
    ids.sort();
    let providers = ids
        .iter()
        .filter_map(|id| {
            config.provider_config_for_selection(id).map(|p| {
                let mut info = provider_info(id, &p, &default_selection);
                if let Some(m) = logical_models.get(id) {
                    info.account = Some(m.account.clone());
                }
                info
            })
        })
        .collect();

    let logical_accounts = config.logical_accounts();
    let mut account_ids: Vec<String> = logical_accounts.keys().cloned().collect();
    account_ids.sort();
    let accounts = account_ids
        .into_iter()
        .map(|id| {
            let a = &logical_accounts[&id];
            crate::AccountInfo {
                id: id.clone(),
                provider_type: a.provider.clone(),
                base_url: a.base_url.clone(),
                has_api_key: a.api_key.as_ref().is_some_and(|k| !k.is_empty()),
                skip_tls_verify: a.skip_tls_verify,
            }
        })
        .collect();

    let language = match config.language {
        Some(jeikcode_config::locale::Locale::ZhCn) => "zh-CN".to_string(),
        Some(jeikcode_config::locale::Locale::En) | None => "en".to_string(),
    };
    ConfigResponse {
        path: Config::default_path(),
        default_provider: default_selection,
        default_workdir: config.default_workdir.clone(),
        providers,
        accounts,
        language,
    }
}

/// Build a sanitized ProviderInfo from a name + ProviderConfig.
pub(crate) fn provider_info(
    name: &str,
    p: &ProviderConfig,
    default_provider: &str,
) -> ProviderInfo {
    ProviderInfo {
        name: name.to_string(),
        provider_type: p.provider_type.clone(),
        model: p.model.clone(),
        base_url: p.base_url.clone(),
        has_api_key: p.resolved_api_key().is_some(),
        requires_login: p
            .base_url
            .as_deref()
            .is_some_and(jeikcode_auth::gateway_crypto::is_jeikcode_gateway),
        is_default: name == default_provider,
        context_window: p.context_window,
        max_tokens: p.max_tokens,
        thinking_enabled: p.thinking_enabled,
        thinking_budget: p.thinking_budget,
        thinking_type: p.thinking_type.clone(),
        thinking_keep: p.thinking_keep.clone(),
        reasoning_history: p.reasoning_history.clone(),
        reasoning_effort: p.reasoning_effort.clone(),
        skip_tls_verify: p.skip_tls_verify,
        ephemeral: p.ephemeral,
        pricing: p.pricing,
        supports_vision: p.supports_vision,
        reasoning_model: p.reasoning_model,
        account: None,
    }
}

/// Validate a provider name. Returns the trimmed name on success.
pub(crate) fn validate_provider_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Provider name cannot be empty".into());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("Provider name cannot be '.' or '..'".into());
    }
    if trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
        || trimmed.contains('\n')
        || trimmed.contains('\r')
        || trimmed.contains('\t')
    {
        return Err(
            "Provider name cannot contain /, \\, NUL, newline, carriage return, or tab".into(),
        );
    }
    Ok(trimmed.to_string())
}

/// Apply one config delta to the latest on-disk snapshot. Provider/config API
/// handlers should use this instead of load-mutate-save to avoid lost updates
/// when an IDE and TUI write concurrently.
pub(crate) fn update_config(
    mutate: impl FnOnce(&mut Config) -> anyhow::Result<()>,
) -> Result<Config, String> {
    ConfigStore::default_store()
        .update(mutate)
        .map(|commit| commit.snapshot.config)
        .map_err(|e| format!("Failed to update config: {e:#}"))
}

// ============================================================================
// Handlers
// ============================================================================

/// GET /config - Returns sanitized config state.
pub(crate) async fn get_config() -> impl IntoResponse {
    let config = match load_config() {
        Ok(c) => c,
        Err(e) => {
            return json_error(axum::http::StatusCode::INTERNAL_SERVER_ERROR, e).into_response()
        }
    };
    Json(config_response(&config)).into_response()
}

#[derive(Debug, serde::Deserialize)]
pub(crate) struct LanguageBody {
    language: String,
}

/// POST /config/language — persist the global UI language and apply it in this process.
pub(crate) async fn set_language(
    Json(body): Json<LanguageBody>,
) -> impl IntoResponse {
    let locale = match body.language.parse::<jeikcode_config::locale::Locale>() {
        Ok(locale) => locale,
        Err(err) => {
            return json_error(axum::http::StatusCode::BAD_REQUEST, err).into_response()
        }
    };
    let config = match update_config(|cfg| {
        cfg.language = Some(locale);
        Ok(())
    }) {
        Ok(config) => config,
        Err(err) => {
            return json_error(axum::http::StatusCode::INTERNAL_SERVER_ERROR, err).into_response()
        }
    };
    jeikcode_config::i18n::set_locale(locale);
    Json(config_response(&config)).into_response()
}

#[derive(Debug, serde::Deserialize)]
pub(crate) struct RemoteAccessBody {
    host: String,
    port: u16,
    #[serde(default)]
    token: String,
    #[serde(default)]
    no_token: bool,
    #[serde(default)]
    stop: bool,
    /// Save the port and token for the next desktop launch (`0.0.0.0`).
    /// The same port updates the live token. A different port waits until
    /// the next start. `no_token` is never written to disk.
    #[serde(default)]
    apply_launch: bool,
}

#[derive(Debug, serde::Serialize)]
struct RemoteAccessStatus {
    host: String,
    port: u16,
    no_token: bool,
    active: bool,
    token: Option<String>,
    url: Option<String>,
    /// Every address another device can open. `url` is the first of these.
    /// Empty when the bind is up but this machine reported no shareable IPv4.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    urls: Vec<String>,
    /// `allowed` when this exe may receive inbound connections, `prompt` when
    /// Windows still needs an Allow click. Absent on loopback and non-Windows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    firewall: Option<String>,
    /// Port saved for the next launch when it differs from the socket that
    /// is listening now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    next_port: Option<u16>,
}

fn remote_status(state: &crate::AppState, token: Option<String>) -> RemoteAccessStatus {
    // Copy the bind out and drop the mutex before any address lookup.
    // `extra_remote` is a std mutex: calling back into this function while
    // the guard is still held deadlocks the worker, and the WebUI Apply
    // button then stays disabled forever.
    let (host, port, active, active_token) = {
        let extra = state.extra_remote.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(bind) = extra.as_ref() {
            (bind.host.clone(), bind.port, true, bind.token.clone())
        } else {
            let host = state.bind_host.clone();
            // The desktop starts on 0.0.0.0. That socket is the remote
            // listener; there is no second port to open.
            let sharing = !is_loopback_host(&host);
            (host, state.bind_port, sharing, state.webui_tokens.display())
        }
    };
    let token = token.or(active_token);
    let no_token = state
        .token_optional
        .load(std::sync::atomic::Ordering::Relaxed);
    let urls = if active {
        access_urls(&host, port, token.as_deref(), no_token)
    } else {
        Vec::new()
    };
    let url = urls.first().cloned();
    RemoteAccessStatus {
        host,
        port,
        no_token,
        active,
        token,
        url,
        urls,
        firewall: None,
        next_port: saved_listen_port().filter(|saved| *saved != port),
    }
}

fn format_access_url(host: &str, port: u16, token: Option<&str>, no_token: bool) -> String {
    let display = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    if !no_token {
        if let Some(tok) = token.filter(|item| !item.is_empty()) {
            return format!("http://{display}:{port}/?token={tok}");
        }
    }
    format!("http://{display}:{port}/")
}

/// Addresses that belong on a link sent to another device.
///
/// A `0.0.0.0` / `::` listener is reachable on every interface, but the URL
/// must not be `127.0.0.1`: that address only opens on this computer.
fn access_urls(host: &str, port: u16, token: Option<&str>, no_token: bool) -> Vec<String> {
    let hosts = if is_unspecified_host(host) {
        shareable_ipv4_addrs()
    } else if is_loopback_host(host) {
        vec!["127.0.0.1".to_string()]
    } else {
        vec![host.to_string()]
    };
    hosts
        .into_iter()
        .map(|item| format_access_url(&item, port, token, no_token))
        .collect()
}

fn is_unspecified_host(host: &str) -> bool {
    matches!(host, "0.0.0.0" | "::" | "[::]")
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]")
}

fn shareable_ipv4_addrs() -> Vec<String> {
    let mut found = collect_ipv4_literals(&interface_ipv4_blob());
    if let Some(primary) = crate::primary_lan_ipv4() {
        if let Ok(ip) = primary.parse::<std::net::Ipv4Addr>() {
            if ipv4_is_shareable(&ip) && !found.iter().any(|item| item == &primary) {
                found.push(primary);
            }
        }
    }
    found.sort_by(|left, right| ipv4_rank(left).cmp(&ipv4_rank(right)).then(left.cmp(right)));
    if let Some(primary) = crate::primary_lan_ipv4() {
        if let Some(pos) = found.iter().position(|item| item == &primary) {
            let ip = found.remove(pos);
            found.insert(0, ip);
        }
    }
    found
}

fn ipv4_is_shareable(ip: &std::net::Ipv4Addr) -> bool {
    !ip.is_unspecified() && !ip.is_loopback() && !ip.is_broadcast() && !ip.is_multicast()
}

fn ipv4_rank(text: &str) -> u8 {
    let Ok(ip) = text.parse::<std::net::Ipv4Addr>() else {
        return 9;
    };
    if !ipv4_is_shareable(&ip) {
        9
    } else if ip.is_private() {
        0
    } else if ip.is_link_local() {
        3
    } else {
        1
    }
}

fn collect_ipv4_literals(bytes: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        let start = index;
        let mut dots = 0;
        let mut octet_len = 0;
        let mut ok = true;
        while index < bytes.len() {
            let byte = bytes[index];
            if byte.is_ascii_digit() {
                octet_len += 1;
                if octet_len > 3 {
                    ok = false;
                }
                index += 1;
            } else if byte == b'.' && dots < 3 && octet_len > 0 {
                dots += 1;
                octet_len = 0;
                index += 1;
            } else {
                break;
            }
        }
        if ok && dots == 3 && octet_len > 0 {
            let bounded = (start == 0 || !bytes[start - 1].is_ascii_digit())
                && (index >= bytes.len() || !bytes[index].is_ascii_digit());
            if bounded {
                if let Ok(text) = std::str::from_utf8(&bytes[start..index]) {
                    if let Ok(ip) = text.parse::<std::net::Ipv4Addr>() {
                        if ipv4_is_shareable(&ip) {
                            let rendered = ip.to_string();
                            if !out.contains(&rendered) {
                                out.push(rendered);
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

fn interface_ipv4_blob() -> Vec<u8> {
    #[cfg(windows)]
    {
        windows_ipconfig_bytes()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[cfg(windows)]
fn windows_ipconfig_bytes() -> Vec<u8> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut child = match std::process::Command::new("ipconfig")
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return Vec::new(),
    };
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < std::time::Duration::from_millis(1500) => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Vec::new();
            }
        }
    }
    child
        .wait_with_output()
        .map(|output| output.stdout)
        .unwrap_or_default()
}

fn apply_remote_auth(state: &crate::AppState, no_token: bool) {
    if no_token {
        state
            .token_optional
            .store(true, std::sync::atomic::Ordering::Relaxed);
        state
            .enforce_token
            .store(false, std::sync::atomic::Ordering::Relaxed);
    } else {
        state
            .token_optional
            .store(false, std::sync::atomic::Ordering::Relaxed);
        state
            .enforce_token
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

fn restore_remote_auth(state: &crate::AppState) {
    state
        .token_optional
        .store(false, std::sync::atomic::Ordering::Relaxed);
    state
        .enforce_token
        .store(state.initial_enforce_token, std::sync::atomic::Ordering::Relaxed);
}

fn bind_listener(addr: std::net::SocketAddr, only_v6: bool) -> std::io::Result<tokio::net::TcpListener> {
    let domain = if addr.is_ipv4() {
        socket2::Domain::IPV4
    } else {
        socket2::Domain::IPV6
    };
    let socket = socket2::Socket::new(domain, socket2::Type::STREAM, Some(socket2::Protocol::TCP))?;
    // Windows defaults IPV6_V6ONLY to 0, so a `[::]` socket also claims
    // `0.0.0.0` and can leave the IPv4 listener accepting only this PC.
    // Keep the two stacks on separate sockets.
    if only_v6 {
        socket.set_only_v6(true)?;
    }
    socket.set_nonblocking(true)?;
    socket.bind(&socket2::SockAddr::from(addr))?;
    socket.listen(1024)?;
    let listener: std::net::TcpListener = socket.into();
    tokio::net::TcpListener::from_std(listener)
}

async fn open_listeners(
    host: &str,
    port: u16,
) -> Result<(tokio::net::TcpListener, Option<tokio::net::TcpListener>), String> {
    if host == "0.0.0.0" {
        let v4 = std::net::SocketAddr::from((std::net::Ipv4Addr::UNSPECIFIED, port));
        let primary = bind_listener(v4, false)
            .map_err(|err| format!("failed to listen on {host}:{port}: {err}"))?;
        let v6 = std::net::SocketAddr::from((std::net::Ipv6Addr::UNSPECIFIED, port));
        let secondary = match bind_listener(v6, true) {
            Ok(listener) => {
                tracing::info!(%v6, "temporary remote access: IPv6 listener active");
                Some(listener)
            }
            Err(err) => {
                tracing::warn!(%v6, %err, "temporary remote access: IPv6 bind failed (IPv4 only)");
                None
            }
        };
        ensure_unspecified(&primary, host)?;
        return Ok((primary, secondary));
    }
    if host == "::" || host == "[::]" {
        let v6 = std::net::SocketAddr::from((std::net::Ipv6Addr::UNSPECIFIED, port));
        let primary = bind_listener(v6, true)
            .map_err(|err| format!("failed to listen on {host}:{port}: {err}"))?;
        let v4 = std::net::SocketAddr::from((std::net::Ipv4Addr::UNSPECIFIED, port));
        let secondary = match bind_listener(v4, false) {
            Ok(listener) => {
                tracing::info!(%v4, "temporary remote access: IPv4 listener active");
                Some(listener)
            }
            Err(err) => {
                tracing::warn!(%v4, %err, "temporary remote access: IPv4 bind failed");
                None
            }
        };
        ensure_unspecified(&primary, host)?;
        return Ok((primary, secondary));
    }
    if let Ok(addr) = format!("{host}:{port}").parse::<std::net::SocketAddr>() {
        let primary = bind_listener(addr, addr.is_ipv6())
            .map_err(|err| format!("failed to listen on {host}:{port}: {err}"))?;
        return Ok((primary, None));
    }
    match tokio::net::TcpListener::bind(format!("{host}:{port}")).await {
        Ok(listener) => Ok((listener, None)),
        Err(err) => Err(format!("failed to listen on {host}:{port}: {err}")),
    }
}

fn ensure_unspecified(listener: &tokio::net::TcpListener, host: &str) -> Result<(), String> {
    let bound = listener
        .local_addr()
        .map_err(|err| format!("failed to read listener address: {err}"))?;
    if bound.ip().is_loopback() {
        return Err(format!(
            "listener for {host} came up on {bound}, which other devices cannot open"
        ));
    }
    tracing::info!(%bound, "temporary remote access listening");
    Ok(())
}

fn take_extra_remote(state: &crate::AppState) -> Option<crate::ExtraRemoteBind> {
    state
        .extra_remote
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .take()
}

async fn with_firewall(mut status: RemoteAccessStatus) -> RemoteAccessStatus {
    if status.active && !is_loopback_host(&status.host) {
        status.firewall = inbound_firewall_status().await;
    }
    status
}

async fn inbound_firewall_status() -> Option<String> {
    #[cfg(all(windows, not(test)))]
    {
        if FIREWALL_ALLOWED.load(std::sync::atomic::Ordering::Relaxed) {
            return Some("allowed".to_string());
        }
        let status = tokio::task::spawn_blocking(windows_firewall_status)
            .await
            .ok()
            .flatten();
        if status.as_deref() == Some("allowed") {
            FIREWALL_ALLOWED.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        return status;
    }
    #[cfg(not(all(windows, not(test))))]
    {
        None
    }
}

#[cfg(all(windows, not(test)))]
static FIREWALL_ALLOWED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(all(windows, not(test)))]
static FIREWALL_PROMPTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(all(windows, not(test)))]
fn windows_firewall_status() -> Option<String> {
    let exe = current_exe_path()?;
    if firewall_rule_matches(&exe) {
        return Some("allowed".to_string());
    }
    if try_add_firewall_rule(&exe) && firewall_rule_matches(&exe) {
        return Some("allowed".to_string());
    }
    if !FIREWALL_PROMPTED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        let _ = spawn_elevated_firewall_rule(&exe);
    }
    Some("prompt".to_string())
}

#[cfg(all(windows, not(test)))]
fn current_exe_path() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let text = exe.display().to_string();
    let text = text.trim_start_matches(r"\\?\").trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

#[cfg(all(windows, not(test)))]
fn firewall_rule_matches(exe: &str) -> bool {
    let Some(text) = netsh_text(&[
        "advfirewall",
        "firewall",
        "show",
        "rule",
        "name=JeikCode",
        "verbose",
    ]) else {
        return false;
    };
    let folded = text.to_ascii_lowercase();
    folded.contains(&exe.to_ascii_lowercase())
        && (folded.contains("allow") || folded.contains("允许"))
}

#[cfg(all(windows, not(test)))]
fn try_add_firewall_rule(exe: &str) -> bool {
    netsh_status(&[
        "advfirewall",
        "firewall",
        "add",
        "rule",
        "name=JeikCode",
        "dir=in",
        "action=allow",
        &format!("program={exe}"),
        "enable=yes",
        "profile=any",
    ])
}

#[cfg(all(windows, not(test)))]
fn spawn_elevated_firewall_rule(exe: &str) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let path = std::env::temp_dir().join("jeikcode-firewall.ps1");
    let escaped = exe.replace('\'', "''");
    let body = format!(
        "netsh advfirewall firewall delete rule name=JeikCode | Out-Null\r\nnetsh advfirewall firewall add rule name=JeikCode dir=in action=allow program='{escaped}' enable=yes profile=any\r\n"
    );
    if std::fs::write(&path, body).is_err() {
        return false;
    }
    let script = path.display().to_string().replace('\'', "''");
    let launch = format!(
        "Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','{script}'"
    );
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &launch])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .is_ok()
}

#[cfg(all(windows, not(test)))]
fn netsh_text(args: &[&str]) -> Option<String> {
    let mut child = netsh_command(args).spawn().ok()?;
    if !wait_child(&mut child, std::time::Duration::from_millis(1500)) {
        return None;
    }
    let output = child.wait_with_output().ok()?;
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Some(text)
}

#[cfg(all(windows, not(test)))]
fn netsh_status(args: &[&str]) -> bool {
    let mut child = match netsh_command(args).spawn() {
        Ok(child) => child,
        Err(_) => return false,
    };
    if !wait_child(&mut child, std::time::Duration::from_millis(1500)) {
        return false;
    }
    child
        .wait()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(all(windows, not(test)))]
fn netsh_command(args: &[&str]) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = std::process::Command::new("netsh");
    command
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    command
}

#[cfg(all(windows, not(test)))]
fn wait_child(child: &mut std::process::Child, limit: std::time::Duration) -> bool {
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if started.elapsed() < limit => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct WebuiListenPref {
    port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token: Option<String>,
}

fn webui_listen_pref_path() -> std::path::PathBuf {
    jeikcode_config::config::Config::config_dir().join("webui-listen.json")
}

fn load_webui_listen_pref() -> Option<WebuiListenPref> {
    let text = std::fs::read_to_string(webui_listen_pref_path()).ok()?;
    serde_json::from_str(&text).ok()
}

fn saved_listen_port() -> Option<u16> {
    load_webui_listen_pref()
        .map(|pref| pref.port)
        .filter(|port| *port != 0)
}

/// Write the next desktop launch. `token: None` keeps the token already on disk.
fn save_webui_listen_pref(port: u16, token: Option<String>) -> Result<(), String> {
    if port == 0 {
        return Err("port must be 1-65535".to_string());
    }
    let path = webui_listen_pref_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    }
    let mut pref = load_webui_listen_pref().unwrap_or(WebuiListenPref { port, token: None });
    pref.port = port;
    if token.is_some() {
        pref.token = token;
    }
    let body = serde_json::to_string_pretty(&pref).map_err(|err| err.to_string())?;
    std::fs::write(path, body).map_err(|err| err.to_string())
}

/// The running socket stays as it is. A matching port registers the token now.
/// A different port is only remembered for the next `0.0.0.0` start.
/// Checking "no token" changes this process and is not written down.
fn apply_launch_settings(state: &crate::AppState, body: &RemoteAccessBody) -> Result<RemoteAccessStatus, String> {
    if body.port == 0 {
        return Err("port must be 1-65535".to_string());
    }
    let port_changed = body.port != state.bind_port;
    if body.no_token {
        if !port_changed {
            apply_remote_auth(state, true);
        } else {
            save_webui_listen_pref(body.port, None)?;
            apply_remote_auth(state, true);
        }
    } else {
        let token = body.token.trim();
        let token = if token.is_empty() {
            state
                .webui_tokens
                .display()
                .unwrap_or_else(|| state.webui_tokens.mint())
        } else {
            if !state.webui_tokens.register(token) {
                return Err("token is empty".to_string());
            }
            token.to_string()
        };
        if !port_changed {
            state.webui_tokens.set_display(&token);
            apply_remote_auth(state, false);
        }
        save_webui_listen_pref(body.port, Some(token))?;
    }
    let mut status = remote_status(state, None);
    if port_changed {
        status.next_port = Some(body.port);
        if !body.no_token {
            if let Some(pref) = load_webui_listen_pref() {
                status.token = pref.token;
            }
        }
    }
    Ok(status)
}

/// GET /api/remote-access — current temporary listener, if one is open.
pub(crate) async fn get_remote_access(State(state): State<AppState>) -> impl IntoResponse {
    let extra_open = state
        .extra_remote
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .is_some();
    let status = remote_status(&state, None);
    if extra_open {
        Json(with_firewall(status).await).into_response()
    } else {
        Json(status).into_response()
    }
}

/// POST /api/remote-access — open or close an extra listen address.
///
/// The desktop and local WebUI stay on their original port. This binds a
/// second listener (default `0.0.0.0:4096`) so a phone on the LAN can connect
/// without restarting the process.
pub(crate) async fn post_remote_access(
    State(state): State<AppState>,
    Json(body): Json<RemoteAccessBody>,
) -> impl IntoResponse {
    if body.apply_launch {
        return match apply_launch_settings(&state, &body) {
            Ok(status) => Json(status).into_response(),
            Err(err) => json_error(axum::http::StatusCode::BAD_REQUEST, err).into_response(),
        };
    }
    if body.stop {
        if let Some(prev) = take_extra_remote(&state) {
            prev.abort_all();
        }
        restore_remote_auth(&state);
        return Json(remote_status(&state, None)).into_response();
    }

    let host = body.host.trim().to_string();
    if host.is_empty()
        || host.len() > 255
        || host.chars().any(|ch| ch.is_whitespace() || ch == '/' || ch == '\\')
    {
        return json_error(
            axum::http::StatusCode::BAD_REQUEST,
            "listen address is empty or invalid",
        )
        .into_response();
    }
    if body.port == 0 {
        return json_error(axum::http::StatusCode::BAD_REQUEST, "port must be 1-65535")
            .into_response();
    }

    let minted = if body.no_token {
        None
    } else {
        let token = body.token.trim();
        if token.is_empty() {
            Some(state.webui_tokens.mint())
        } else if state.webui_tokens.register(token) {
            Some(token.to_string())
        } else {
            return json_error(axum::http::StatusCode::BAD_REQUEST, "token is empty").into_response();
        }
    };

    let same_as_primary = host.eq_ignore_ascii_case(&state.bind_host) && body.port == state.bind_port;
    if same_as_primary {
        apply_remote_auth(&state, body.no_token);
        return Json(with_firewall(remote_status(&state, minted)).await).into_response();
    }

    // Same host and port: update the token only. Drop the mutex before
    // `remote_status` — it locks `extra_remote` again, and a std mutex does
    // not allow that on the same thread.
    let reused = {
        let mut guard = state
            .extra_remote
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if let Some(bind) = guard.as_mut() {
            if bind.host == host && bind.port == body.port {
                bind.token = minted.clone();
                true
            } else {
                false
            }
        } else {
            false
        }
    };
    if reused {
        apply_remote_auth(&state, body.no_token);
        return Json(with_firewall(remote_status(&state, minted)).await).into_response();
    }

    let Some(router) = state.http_router.get().cloned() else {
        return json_error(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "server is still starting",
        )
        .into_response();
    };

    // A different port is bound first, so a failed Apply keeps the listener
    // that is already open. The same port has to be released before the new
    // socket can take it; Windows often needs a moment after the abort.
    let previous_port = {
        let guard = state
            .extra_remote
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        guard.as_ref().map(|bind| bind.port)
    };
    let same_port = previous_port == Some(body.port);
    if same_port {
        if let Some(prev) = take_extra_remote(&state) {
            prev.abort_all();
            tokio::task::yield_now().await;
        }
    }

    let opened = match open_listeners(&host, body.port).await {
        Ok(listeners) => Ok(listeners),
        Err(err) if same_port => {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            match open_listeners(&host, body.port).await {
                Ok(listeners) => Ok(listeners),
                Err(_) => Err(err),
            }
        }
        Err(err) => Err(err),
    };
    let (primary_listener, secondary_listener) = match opened {
        Ok(listeners) => listeners,
        Err(err) => {
            if same_port {
                restore_remote_auth(&state);
            }
            return json_error(axum::http::StatusCode::CONFLICT, err).into_response();
        }
    };

    if !same_port {
        if let Some(prev) = take_extra_remote(&state) {
            prev.abort_all();
        }
    }

    let mut aborts = Vec::new();
    let router_primary = router.clone();
    let task_primary = tokio::spawn(async move {
        if let Err(err) = axum::serve(primary_listener, router_primary).await {
            tracing::error!(?err, "temporary remote listener stopped");
        }
    });
    aborts.push(task_primary.abort_handle());

    if let Some(secondary) = secondary_listener {
        let router_secondary = router.clone();
        let task_secondary = tokio::spawn(async move {
            if let Err(err) = axum::serve(secondary, router_secondary).await {
                tracing::error!(?err, "temporary remote secondary listener stopped");
            }
        });
        aborts.push(task_secondary.abort_handle());
    }

    apply_remote_auth(&state, body.no_token);
    *state
        .extra_remote
        .lock()
        .unwrap_or_else(|err| err.into_inner()) = Some(crate::ExtraRemoteBind {
        host,
        port: body.port,
        aborts,
        token: minted.clone(),
    });

    Json(with_firewall(remote_status(&state, minted)).await).into_response()
}

/// POST /config/reload - Reloads config.toml from disk, remounts MCP/skills on
/// the live runtime, and returns the sanitized config view.
pub(crate) async fn reload_config(State(state): State<AppState>) -> impl IntoResponse {
    let config = match load_config() {
        Ok(c) => c,
        Err(e) => {
            return json_error(axum::http::StatusCode::INTERNAL_SERVER_ERROR, e).into_response()
        }
    };
    let _ = crate::reload_mcp_and_live_runtime(&state).await;
    Json(config_response(&config)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(base_url: &str) -> ProviderConfig {
        ProviderConfig {
            provider_type: "openai".into(),
            api_key: None,
            model: "model".into(),
            base_url: Some(base_url.into()),
            system_prompt: None,
            user_agent: None,
            context_window: 128_000,
            max_tokens: None,
            thinking_type: None,
            thinking_keep: None,
            reasoning_history: None,
            reasoning_effort: None,
            reasoning_levels: None,
            thinking_enabled: None,
            thinking_budget: None,
            skip_tls_verify: false,
            ephemeral: false,
            capable_model: None,
            pricing: None,
            supports_vision: None,
            reasoning_model: None,
        }
    }

    #[test]
    fn config_response_lists_new_schema_and_folded_codingplan_models() {
        // A config where the selectable models live ONLY in the new schema
        // (provider_accounts + models) — none in [providers.*].
        let config: Config = serde_json::from_value(serde_json::json!({
            "default_model": "JeikCode-GLM-5.2",
            "provider_accounts": { "JeikCode": { "provider": "openai", "base_url": "" } },
            "models": {
                "JeikCode-GLM-5.2": { "account": "JeikCode", "model": "GLM-5.2", "context_window": 128000 },
                "JeikCode-Qwen": { "account": "JeikCode", "model": "Qwen", "context_window": 128000 }
            }
        }))
        .unwrap();
        let resp = config_response(&config);
        let names: Vec<&str> = resp.providers.iter().map(|p| p.name.as_str()).collect();
        assert!(
            names.contains(&"JeikCode-GLM-5.2"),
            "new-schema model listed"
        );
        assert!(names.contains(&"JeikCode-Qwen"));
        assert_eq!(resp.default_provider, "JeikCode-GLM-5.2");
        let glm = resp
            .providers
            .iter()
            .find(|p| p.name == "JeikCode-GLM-5.2")
            .unwrap();
        assert!(glm.is_default);
        assert!(!glm.requires_login, "gateway signing is retired");
        assert_eq!(glm.model, "GLM-5.2");
    }

    #[test]
    fn provider_info_reports_login_dependency_from_gateway() {
        assert!(!provider_info("renamed", &provider(""), "renamed").requires_login);
        assert!(
            !provider_info(
                "JeikCode-looking-custom",
                &provider("https://example.test/v1"),
                "JeikCode-looking-custom"
            )
            .requires_login
        );
    }

    #[test]
    fn provider_info_exposes_pricing_without_credentials() {
        let mut configured = provider("https://example.test/v1");
        configured.pricing = Some(jeikcode_config::config::provider::ProviderPricing {
            input_per_million: 1.0,
            output_per_million: 2.0,
            cached_input_per_million: 0.25,
        });
        let info = provider_info("custom", &configured, "custom");
        assert_eq!(info.pricing, configured.pricing);
        assert!(!info.has_api_key);
    }

    #[tokio::test]
    async fn remote_status_and_enforce_token_lifecycle() {
        let home = crate::tests::ScopedChatHome::new();
        let state = crate::tests::chat_test_state(&home);

        // 1. 初始状态：未激活临时访问，enforce_token = false
        assert!(!state.is_token_enforced());
        let status = remote_status(&state, None);
        assert!(!status.active);
        assert!(status.url.is_none());

        // 2. 模拟配置带 token 的监听
        let _ = state.webui_tokens.register("test-token");
        state.enforce_token.store(true, std::sync::atomic::Ordering::Relaxed);
        *state.extra_remote.lock().unwrap() = Some(crate::ExtraRemoteBind {
            host: "0.0.0.0".into(),
            port: 4096,
            aborts: Vec::new(),
            token: Some("test-token".into()),
        });

        // 验证状态回显与 token 保留。通配监听不能把 127.0.0.1 当成分享地址。
        assert!(state.is_token_enforced());
        let active_status = remote_status(&state, None);
        assert!(active_status.active);
        assert_eq!(active_status.token.as_deref(), Some("test-token"));
        for url in active_status
            .url
            .iter()
            .chain(active_status.urls.iter())
        {
            assert!(url.contains(":4096/?token=test-token"), "{url}");
            assert!(!url.contains("127.0.0.1"), "{url}");
            assert!(!url.contains("[::1]"), "{url}");
        }

        // 3. 停止临时访问后，恢复到初始 enforce_token (false)
        state.extra_remote.lock().unwrap().take();
        state.enforce_token.store(state.initial_enforce_token, std::sync::atomic::Ordering::Relaxed);
        assert!(!state.is_token_enforced());
        let stopped_status = remote_status(&state, None);
        assert!(!stopped_status.active);
    }

    #[test]
    fn ipv4_literals_skip_loopback_and_keep_lan_addresses() {
        let blob = b"IPv4 Address. . . . . . . . . . . : 192.168.1.20\r\n\
                     Autoconfiguration IPv4 Address. . : 169.254.8.9\r\n\
                     IPv4 Address. . . . . . . . . . . : 127.0.0.1\r\n\
                     IPv4 Address. . . . . . . . . . . : 10.0.0.8\r\n\
                     IPv4 Address. . . . . . . . . . . : 0.0.0.0\r\n";
        let found = collect_ipv4_literals(blob);
        assert_eq!(
            found,
            vec![
                "192.168.1.20".to_string(),
                "169.254.8.9".to_string(),
                "10.0.0.8".to_string(),
            ]
        );
        let urls = access_urls("127.0.0.1", 4096, Some("tok"), false);
        assert_eq!(urls, vec!["http://127.0.0.1:4096/?token=tok".to_string()]);
    }

    #[tokio::test]
    async fn wildcard_bind_accepts_loopback_on_an_unspecified_socket() {
        let listener = bind_listener(
            std::net::SocketAddr::from((std::net::Ipv4Addr::UNSPECIFIED, 0)),
            false,
        )
        .expect("bind 0.0.0.0");
        let bound = listener.local_addr().unwrap();
        assert!(bound.ip().is_unspecified(), "{bound}");
        let port = bound.port();
        let probe = tokio::net::TcpStream::connect(("127.0.0.1", port)).await;
        assert!(probe.is_ok(), "this PC should reach a 0.0.0.0 listener");
    }

    #[tokio::test]
    async fn reapply_same_remote_bind_returns_and_stop_clears_it() {
        use axum::extract::State;
        use axum::Json;

        let home = crate::tests::ScopedChatHome::new();
        let state = crate::tests::chat_test_state(&home);
        *state.extra_remote.lock().unwrap() = Some(crate::ExtraRemoteBind {
            host: "0.0.0.0".into(),
            port: 4096,
            aborts: Vec::new(),
            token: Some("old-token".into()),
        });

        let apply = post_remote_access(
            State(state.clone()),
            Json(RemoteAccessBody {
                host: "0.0.0.0".into(),
                port: 4096,
                token: "next-token".into(),
                no_token: false,
                stop: false,
                apply_launch: false,
            }),
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), apply)
            .await
            .expect("reapply deadlocked while the Apply button would stay disabled");
        assert_eq!(
            state
                .extra_remote
                .lock()
                .unwrap()
                .as_ref()
                .and_then(|bind| bind.token.clone())
                .as_deref(),
            Some("next-token")
        );

        let stop = post_remote_access(
            State(state.clone()),
            Json(RemoteAccessBody {
                host: "0.0.0.0".into(),
                port: 4096,
                token: String::new(),
                no_token: false,
                stop: true,
                apply_launch: false,
            }),
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), stop)
            .await
            .expect("stop deadlocked");
        assert!(state.extra_remote.lock().unwrap().is_none());
        assert!(!state.is_token_enforced());
    }

    #[tokio::test]
    async fn failed_rebind_keeps_the_open_listener_until_the_same_port_is_released() {
        use axum::extract::State;
        use axum::Json;

        let home = crate::tests::ScopedChatHome::new();
        let state = crate::tests::chat_test_state(&home);
        state
            .http_router
            .set(axum::Router::new())
            .expect("router slot empty");
        state
            .enforce_token
            .store(true, std::sync::atomic::Ordering::Relaxed);
        *state.extra_remote.lock().unwrap() = Some(crate::ExtraRemoteBind {
            host: "0.0.0.0".into(),
            port: 4096,
            aborts: Vec::new(),
            token: Some("old-token".into()),
        });

        // 192.0.2.1 is documentation space and is not assigned to this PC,
        // so the bind fails before the existing listener is touched.
        let different_port = post_remote_access(
            State(state.clone()),
            Json(RemoteAccessBody {
                host: "192.0.2.1".into(),
                port: 4097,
                token: "next-token".into(),
                no_token: false,
                stop: false,
                apply_launch: false,
            }),
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), different_port)
            .await
            .expect("different-port failure returned");
        {
            let guard = state.extra_remote.lock().unwrap();
            let kept = guard.as_ref().expect("previous listener stays open");
            assert_eq!(kept.port, 4096);
            assert_eq!(kept.token.as_deref(), Some("old-token"));
        }
        assert!(state.is_token_enforced());

        let same_port = post_remote_access(
            State(state.clone()),
            Json(RemoteAccessBody {
                host: "192.0.2.1".into(),
                port: 4096,
                token: "next-token".into(),
                no_token: false,
                stop: false,
                apply_launch: false,
            }),
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), same_port)
            .await
            .expect("same-port failure returned");
        assert!(state.extra_remote.lock().unwrap().is_none());
        assert!(!state.is_token_enforced());
    }

    #[tokio::test]
    async fn launch_pref_applies_token_now_and_keeps_a_new_port_for_the_next_start() {
        use axum::extract::State;
        use axum::Json;

        let home = crate::tests::ScopedChatHome::new();
        let mut state = crate::tests::chat_test_state(&home);
        state.bind_host = "0.0.0.0".into();
        state.bind_port = 13457;
        state.webui_tokens.register("old-token");
        state.webui_tokens.set_display("old-token");
        state
            .enforce_token
            .store(true, std::sync::atomic::Ordering::Relaxed);

        let same_port = post_remote_access(
            State(state.clone()),
            Json(RemoteAccessBody {
                host: "0.0.0.0".into(),
                port: 13457,
                token: "user-token".into(),
                no_token: false,
                stop: false,
                apply_launch: true,
            }),
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), same_port)
            .await
            .expect("same-port token update returned");
        assert_eq!(state.webui_tokens.display().as_deref(), Some("user-token"));
        assert!(state.webui_tokens.is_valid("old-token"));
        assert!(state.webui_tokens.is_valid("user-token"));
        assert!(state.is_token_enforced());
        let saved = std::fs::read_to_string(webui_listen_pref_path()).unwrap();
        assert!(saved.contains("\"port\": 13457"), "{saved}");
        assert!(saved.contains("user-token"), "{saved}");
        assert!(!saved.contains("no_token"), "{saved}");

        let next_port = post_remote_access(
            State(state.clone()),
            Json(RemoteAccessBody {
                host: "0.0.0.0".into(),
                port: 4096,
                token: "later-token".into(),
                no_token: false,
                stop: false,
                apply_launch: true,
            }),
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), next_port)
            .await
            .expect("port change returned");
        assert_eq!(state.bind_port, 13457);
        assert_eq!(state.webui_tokens.display().as_deref(), Some("user-token"));
        let saved = std::fs::read_to_string(webui_listen_pref_path()).unwrap();
        assert!(saved.contains("\"port\": 4096"), "{saved}");
        assert!(saved.contains("later-token"), "{saved}");

        let open_now = post_remote_access(
            State(state.clone()),
            Json(RemoteAccessBody {
                host: "0.0.0.0".into(),
                port: 13457,
                token: String::new(),
                no_token: true,
                stop: false,
                apply_launch: true,
            }),
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), open_now)
            .await
            .expect("no-token update returned");
        assert!(!state.is_token_enforced());
        let saved = std::fs::read_to_string(webui_listen_pref_path()).unwrap();
        assert!(saved.contains("\"port\": 4096"), "{saved}");
        assert!(saved.contains("later-token"), "{saved}");
        assert!(!saved.contains("no_token"), "{saved}");
    }
}
