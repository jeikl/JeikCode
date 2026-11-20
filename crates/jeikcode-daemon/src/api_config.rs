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

    let language = config
        .language
        .unwrap_or_default()
        .language_key()
        .to_string();
    let update_dead = jeikcode_config::config::runtime_state::is_dead();
    ConfigResponse {
        path: Config::default_path(),
        default_provider: default_selection,
        default_workdir: config.default_workdir.clone(),
        providers,
        accounts,
        language,
        github_logo: config.github_logo && !update_dead,
        update_dead,
        auto_git_sync: config.auto_git_sync,
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
///
/// 落盘成功后广播 `config_reloaded`：语言/主题/模型/提供商/思考参数等**任何**
/// 界面设置都是同一份 config，别的实例必须立即重读，而不是等手动 reload 或冷启动。
pub(crate) fn update_config(
    mutate: impl FnOnce(&mut Config) -> anyhow::Result<()>,
) -> Result<Config, String> {
    let result = ConfigStore::default_store()
        .update(mutate)
        .map(|commit| commit.snapshot.config)
        .map_err(|e| format!("Failed to update config: {e:#}"));
    if result.is_ok() {
        crate::publish_global(crate::GlobalWireEvent::ConfigReloaded);
    }
    result
}

// ============================================================================
// Handlers
// ============================================================================

/// GET /config - Returns sanitized config state.
pub(crate) async fn get_config() -> impl IntoResponse {
    let config = match load_config() {
        Ok(c) => c,
        Err(e) => {
            return json_error(axum::http::StatusCode::INTERNAL_SERVER_ERROR, e).into_response();
        }
    };
    Json(config_response(&config)).into_response()
}

#[derive(Debug, serde::Deserialize)]
pub(crate) struct LanguageBody {
    language: String,
}

fn parse_language(input: &str) -> Result<jeikcode_config::locale::Locale, String> {
    input.parse().map_err(|_| {
        "Supported languages: en, vi-VN, zh-CN / Ngôn ngữ hỗ trợ: en, vi-VN, zh-CN / 支持的语言：en, vi-VN, zh-CN".to_string()
    })
}

fn persist_language(
    locale: jeikcode_config::locale::Locale,
    store: &ConfigStore,
) -> Result<Config, String> {
    let config = store
        .update(|cfg| {
            cfg.language = Some(locale);
            Ok(())
        })
        .map_err(|err| format!("Failed to update config: {err:#}"))?
        .snapshot
        .config;
    jeikcode_config::i18n::set_locale(locale);
    Ok(config)
}

/// POST /config/language — persist the global UI language and apply it in this process.
pub(crate) async fn set_language(Json(body): Json<LanguageBody>) -> impl IntoResponse {
    let locale = match parse_language(&body.language) {
        Ok(locale) => locale,
        Err(err) => return json_error(axum::http::StatusCode::BAD_REQUEST, err).into_response(),
    };
    let config = match persist_language(locale, &ConfigStore::default_store()) {
        Ok(config) => config,
        Err(err) => {
            return json_error(axum::http::StatusCode::INTERNAL_SERVER_ERROR, err).into_response();
        }
    };
    // 语言（小地球）也是全局设置：别的实例/标签页必须立即跟随，冷启动再读同一个 config。
    crate::publish_global(crate::GlobalWireEvent::ConfigReloaded);
    Json(config_response(&config)).into_response()
}

#[derive(Debug, serde::Deserialize)]
pub(crate) struct AutoGitSyncBody {
    enabled: bool,
}

/// POST /config/auto-git-sync — 持久化「Agent 执行 git 变更命令后自动刷新/同步」开关。
pub(crate) async fn set_auto_git_sync(Json(body): Json<AutoGitSyncBody>) -> impl IntoResponse {
    let config = match update_config(|cfg| {
        cfg.auto_git_sync = body.enabled;
        Ok(())
    }) {
        Ok(config) => config,
        Err(err) => {
            return json_error(axum::http::StatusCode::INTERNAL_SERVER_ERROR, err).into_response();
        }
    };
    // update_config 已统一广播 config_reloaded（语言/主题/模型/提供商同一份 config）。
    Json(config_response(&config)).into_response()
}

#[derive(Debug, Default, serde::Deserialize)]
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
    /// Immediately restart the daemon to apply changed host or port.
    #[serde(default)]
    restart: bool,
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
    /// Host saved for the next launch when it differs from the socket that
    /// is listening now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    next_host: Option<String>,
    /// How this process was started: `desktop` / `systemd` / `procd` /
    /// `launchd` / `windows-logon` / `foreground`. Restarts follow this mode.
    launch_mode: &'static str,
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
        .load(std::sync::atomic::Ordering::Relaxed)
        || !state
            .enforce_token
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
        next_host: None,
        launch_mode: jeikcode_updater::detect_launch_mode().as_str(),
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
        shareable_network_addrs()
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

pub(crate) fn shareable_network_addrs() -> Vec<String> {
    let blob = interface_network_blob();
    let mut found = Vec::new();

    for ip4 in collect_ipv4_literals(&blob) {
        if !found.contains(&ip4) {
            found.push(ip4);
        }
    }
    if let Some(primary) = crate::primary_lan_ipv4() {
        if let Ok(ip) = primary.parse::<std::net::Ipv4Addr>() {
            if ipv4_is_shareable(&ip) && !found.contains(&primary) {
                found.push(primary);
            }
        }
    }

    for ip6 in collect_ipv6_literals(&blob) {
        if !found.contains(&ip6) {
            found.push(ip6);
        }
    }
    if let Some(primary6) = crate::primary_lan_ipv6() {
        if let Ok(ip) = primary6.parse::<std::net::Ipv6Addr>() {
            if ipv6_is_shareable(&ip) && !found.contains(&primary6) {
                found.push(primary6);
            }
        }
    }

    found.sort_by(|left, right| {
        network_ip_rank(left)
            .cmp(&network_ip_rank(right))
            .then(left.cmp(right))
    });
    if let Some(primary6) = crate::primary_lan_ipv6() {
        if let Some(pos) = found.iter().position(|item| item == &primary6) {
            let ip = found.remove(pos);
            let insert_pos = found
                .iter()
                .position(|item| network_ip_rank(item) >= 1)
                .unwrap_or(found.len());
            found.insert(insert_pos, ip);
        }
    }
    if let Some(primary) = crate::primary_lan_ipv4() {
        if let Some(pos) = found.iter().position(|item| item == &primary) {
            let ip = found.remove(pos);
            found.insert(0, ip);
        }
    }
    found
}

pub(crate) fn ipv4_is_shareable(ip: &std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    if octets[0] == 0 || octets[0] == 127 || octets[0] >= 224 {
        return false;
    }
    !ip.is_unspecified() && !ip.is_loopback() && !ip.is_broadcast() && !ip.is_multicast()
}

pub(crate) fn ipv6_is_shareable(ip: &std::net::Ipv6Addr) -> bool {
    if ip.is_unspecified() || ip.is_loopback() || ip.is_multicast() {
        return false;
    }
    let segments = ip.segments();
    // Exclude link-local fe80::/10
    if (segments[0] & 0xffc0) == 0xfe80 {
        return false;
    }
    // Exclude IPv4-mapped ::ffff:0:0/96
    if segments[0] == 0
        && segments[1] == 0
        && segments[2] == 0
        && segments[3] == 0
        && segments[4] == 0
        && segments[5] == 0xffff
    {
        return false;
    }
    // Exclude documentation and benchmarking prefixes
    if segments[0] == 0x2001 && segments[1] == 0x0db8 {
        return false;
    }
    if segments[0] == 0x0100 && segments[1] == 0 {
        return false;
    }
    // Allow Global Unicast (2000::/3, e.g. 2409:: / 240e:: / 2600::) and Unique Local Addresses (fc00::/7, e.g. fd00::)
    let first = segments[0];
    let is_gua = (first & 0xe000) == 0x2000;
    let is_ula = (first & 0xfe00) == 0xfc00;
    is_gua || is_ula
}

fn network_ip_rank(text: &str) -> u8 {
    if let Ok(ip4) = text.parse::<std::net::Ipv4Addr>() {
        if !ipv4_is_shareable(&ip4) {
            9
        } else if ip4.is_private() {
            0
        } else if ip4.is_link_local() {
            3
        } else {
            2
        }
    } else if let Ok(ip6) = text.parse::<std::net::Ipv6Addr>() {
        if !ipv6_is_shareable(&ip6) {
            9
        } else {
            1
        }
    } else {
        9
    }
}

pub(crate) fn collect_ipv4_literals(bytes: &[u8]) -> Vec<String> {
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

pub(crate) fn collect_ipv6_literals(bytes: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let text = String::from_utf8_lossy(bytes);
    for token in text.split_whitespace() {
        let trimmed = token
            .trim_matches(|c: char| !c.is_ascii_hexdigit() && c != ':' && c != '%' && c != '/')
            .trim();
        let candidate = if let Some((head, _)) = trimmed.split_once('%') {
            head
        } else {
            trimmed
        };
        let candidate = if let Some((head, _)) = candidate.split_once('/') {
            head
        } else {
            candidate
        };
        if candidate.contains(':') {
            if let Ok(ip) = candidate.parse::<std::net::Ipv6Addr>() {
                if ipv6_is_shareable(&ip) {
                    let rendered = ip.to_string();
                    if !out.contains(&rendered) {
                        out.push(rendered);
                    }
                }
            }
        }
    }
    out
}

fn interface_network_blob() -> Vec<u8> {
    #[cfg(windows)]
    {
        windows_ipconfig_bytes()
    }
    #[cfg(target_os = "macos")]
    {
        mac_ifconfig_bytes()
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        linux_ip_addr_bytes()
    }
}

#[cfg(target_os = "macos")]
fn mac_ifconfig_bytes() -> Vec<u8> {
    let mut child = match std::process::Command::new("ifconfig")
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

#[cfg(all(not(windows), not(target_os = "macos")))]
fn linux_ip_addr_bytes() -> Vec<u8> {
    let child = std::process::Command::new("ip")
        .args(["-o", "addr"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(_) => match std::process::Command::new("ifconfig")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(_) => return Vec::new(),
        },
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
    state.enforce_token.store(
        state.initial_enforce_token,
        std::sync::atomic::Ordering::Relaxed,
    );
}

pub(crate) fn bind_listener(
    addr: std::net::SocketAddr,
    only_v6: bool,
) -> std::io::Result<tokio::net::TcpListener> {
    let domain = if addr.is_ipv4() {
        socket2::Domain::IPV4
    } else {
        socket2::Domain::IPV6
    };
    let socket = socket2::Socket::new(domain, socket2::Type::STREAM, Some(socket2::Protocol::TCP))?;
    // 允许地址复用（消除 TIME_WAIT 状态导致原地重启交接时的端口冲突）
    let _ = socket.set_reuse_address(true);
    #[cfg(all(unix, not(target_os = "solaris")))]
    let _ = socket.set_reuse_port(true);
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
    child.wait().map(|status| status.success()).unwrap_or(false)
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    host: Option<String>,
    port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token: Option<String>,
}

fn webui_listen_pref_path() -> std::path::PathBuf {
    jeikcode_config::config::Config::config_dir().join("webui-listen.json")
}

fn load_webui_listen_pref() -> Option<WebuiListenPref> {
    let text = std::fs::read_to_string(webui_listen_pref_path()).ok()?;
    let root = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    let obj = root.as_object()?;
    // Field-wise read so one malformed value cannot discard the saved token or
    // host on the next write (which would lock remote clients out after reload).
    let port = obj
        .get("port")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .filter(|port| *port != 0)?;
    Some(WebuiListenPref {
        host: obj
            .get("host")
            .and_then(serde_json::Value::as_str)
            .filter(|host| !host.trim().is_empty())
            .map(str::to_string),
        port,
        token: obj
            .get("token")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
    })
}

fn saved_listen_port() -> Option<u16> {
    load_webui_listen_pref()
        .map(|pref| pref.port)
        .filter(|port| *port != 0)
}

pub(crate) fn saved_listen_token() -> Option<String> {
    load_webui_listen_pref()
        .and_then(|pref| pref.token)
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// Write the next desktop launch. `token: None` keeps the token already on disk.
pub(crate) fn save_webui_listen_pref(
    host: Option<String>,
    port: u16,
    token: Option<String>,
) -> Result<(), String> {
    if port == 0 {
        return Err("port must be 1-65535".to_string());
    }
    let path = webui_listen_pref_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    }
    let mut pref = load_webui_listen_pref().unwrap_or(WebuiListenPref {
        host: None,
        port,
        token: None,
    });
    pref.port = port;
    if let Some(h) = host {
        let trimmed = h.trim();
        if !trimmed.is_empty() {
            pref.host = Some(trimmed.to_string());
        }
    }
    if token.is_some() {
        pref.token = token;
    }
    let body = serde_json::to_string_pretty(&pref).map_err(|err| err.to_string())?;
    // Contains the access token: atomic replace, user-only permissions.
    jeikcode_capabilities::fs::atomic_write(&path, body.as_bytes(), 0o600)
        .map_err(|err| err.to_string())
}

/// The running socket stays as it is. A matching port registers the token now.
/// A different port is only remembered for the next `0.0.0.0` start.
/// Checking "no token" changes this process and is not written down.
fn apply_launch_settings(
    state: &crate::AppState,
    body: &RemoteAccessBody,
) -> Result<RemoteAccessStatus, String> {
    if body.port == 0 {
        return Err("port must be 1-65535".to_string());
    }
    let target_host = body.host.trim();
    let host_opt = if !target_host.is_empty() {
        Some(target_host.to_string())
    } else {
        None
    };
    let port_changed = body.port != state.bind_port;
    let host_changed =
        !target_host.is_empty() && !target_host.eq_ignore_ascii_case(&state.bind_host);

    if body.no_token {
        if !port_changed && !host_changed {
            apply_remote_auth(state, true);
        } else {
            save_webui_listen_pref(host_opt, body.port, None)?;
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
        if !port_changed && !host_changed {
            state.webui_tokens.set_display(&token);
            apply_remote_auth(state, false);
        }
        save_webui_listen_pref(host_opt, body.port, Some(token))?;
    }
    let mut status = remote_status(state, None);
    if port_changed || host_changed {
        if port_changed {
            status.next_port = Some(body.port);
        }
        if host_changed {
            status.next_host = Some(body.host.clone());
        }
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
    // Remote-access is a privilege expansion: it must never turn a loopback/no-token
    // daemon into a network-reachable/no-token daemon. Explicit `serve --no-token`
    // startup semantics remain unchanged; this only constrains the runtime expansion API.
    if body.no_token {
        let already_unauthenticated_remote = !state.initial_enforce_token
            && !crate::auth_token::is_loopback_bind_host(&state.bind_host);
        if !already_unauthenticated_remote {
            let target = body.host.trim();
            let affected_host = if body.apply_launch && !body.restart && target.is_empty() {
                state.bind_host.as_str()
            } else if !target.is_empty() {
                target
            } else {
                state.bind_host.as_str()
            };
            if !crate::auth_token::is_loopback_bind_host(affected_host) {
                return json_error(
                    axum::http::StatusCode::BAD_REQUEST,
                    "non-loopback remote access requires an access token",
                )
                .into_response();
            }
        }
    }
    if body.apply_launch {
        let should_restart = body.restart;
        let old_port = state.bind_port;
        let restart_host = body.host.trim().to_string();
        let restart_port = body.port;
        let no_token = body.no_token;
        return match apply_launch_settings(&state, &body) {
            Ok(status) => {
                if should_restart {
                    let effective_token = status.token.clone().or_else(|| {
                        let t = body.token.trim();
                        (!t.is_empty()).then(|| t.to_string())
                    });
                    tokio::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                        if let Ok(exe) = jeikcode_updater::current_exe_path() {
                            let _ = jeikcode_updater::restart_process_with_config(
                                &exe,
                                old_port,
                                if restart_host.is_empty() {
                                    None
                                } else {
                                    Some(&restart_host)
                                },
                                restart_port,
                                effective_token.as_deref(),
                                Some(no_token),
                            );
                        }
                    });
                }
                Json(status).into_response()
            }
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
        || host
            .chars()
            .any(|ch| ch.is_whitespace() || ch == '/' || ch == '\\')
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
            return json_error(axum::http::StatusCode::BAD_REQUEST, "token is empty")
                .into_response();
        }
    };

    let same_as_primary =
        host.eq_ignore_ascii_case(&state.bind_host) && body.port == state.bind_port;
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

#[derive(Debug, Clone, serde::Serialize)]
pub struct ZombieProcessInfo {
    pub pid: u32,
    pub name: String,
    pub path: Option<String>,
    pub reason: String,
}

#[derive(Debug, serde::Serialize)]
pub struct LegacyStatusResponse {
    pub has_legacy_files: bool,
    pub legacy_files: Vec<String>,
    pub has_dirty_path: bool,
    pub zombie_count: usize,
    pub zombies: Vec<ZombieProcessInfo>,
    pub needs_migration: bool,
}

#[derive(Debug, serde::Deserialize)]
pub struct MigrateLegacyRequest {
    #[serde(default)]
    pub kill_zombies: bool,
}

#[derive(Debug, serde::Serialize)]
pub struct MigrateLegacyResponse {
    pub success: bool,
    pub cleaned_files_count: usize,
    pub killed_zombies_count: usize,
}

/// 判定某进程条目是否属于当前进程自身、当前线程组（TGID）或任意内核/用户态线程。
///
/// Linux 上 `sysinfo` 会把 `/proc/<TGID>/task/<TID>` 作为独立条目录入 `sys.processes()`，
/// 对线程 TID 调用 `kill()` 会向整个线程组发送 SIGKILL 导致自身秒退（Issue #88）。
fn is_protected_process_entry(
    pid_u32: u32,
    is_thread: bool,
    exe_canon: Option<&std::path::Path>,
    parent_pid: Option<u32>,
    my_pid: Option<u32>,
    self_task_pids: &std::collections::HashSet<u32>,
    current_exe_canon: Option<&std::path::Path>,
) -> bool {
    if is_thread {
        return true;
    }
    if my_pid.is_some_and(|mine| mine == pid_u32) || self_task_pids.contains(&pid_u32) {
        return true;
    }
    if my_pid.is_some_and(|mine| parent_pid == Some(mine)) {
        return true;
    }
    if let (Some(target_exe), Some(self_exe)) = (exe_canon, current_exe_canon) {
        if target_exe == self_exe {
            return true;
        }
    }
    false
}

fn canonical_exe_or_raw(path: Option<&std::path::Path>) -> Option<std::path::PathBuf> {
    path.map(|p| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()))
}

fn collect_self_task_pids(sys: &sysinfo::System) -> std::collections::HashSet<u32> {
    let mut set = std::collections::HashSet::new();
    let Ok(my_pid) = sysinfo::get_current_pid() else {
        return set;
    };
    set.insert(my_pid.as_u32());
    if let Some(my_proc) = sys.process(my_pid) {
        if let Some(tasks) = my_proc.tasks() {
            for tid in tasks {
                set.insert(tid.as_u32());
            }
        }
    }
    set
}

pub fn scan_zombie_processes() -> Vec<ZombieProcessInfo> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::everything(),
    );
    let my_pid = sysinfo::get_current_pid().ok().map(|p| p.as_u32());
    let self_task_pids = collect_self_task_pids(&sys);
    let current_exe_canon = canonical_exe_or_raw(std::env::current_exe().ok().as_deref());
    let mut out = Vec::new();

    // 收集所有当前活跃的桌面壳 PID (jeikcode-desktop)，仅统计主进程，不把线程计入
    let mut active_desktop_pids = std::collections::HashSet::new();
    for (pid, proc_) in sys.processes() {
        if proc_.thread_kind().is_some() {
            continue;
        }
        let name = proc_.name().to_string_lossy().to_ascii_lowercase();
        if name.contains("desktop") || name.contains("tauri") {
            active_desktop_pids.insert(pid.as_u32());
        }
    }

    for (pid, proc_) in sys.processes() {
        let pid_u32 = pid.as_u32();
        let exe_canon = canonical_exe_or_raw(proc_.exe());
        let parent_pid = proc_.parent().map(|p| p.as_u32());
        if is_protected_process_entry(
            pid_u32,
            proc_.thread_kind().is_some(),
            exe_canon.as_deref(),
            parent_pid,
            my_pid,
            &self_task_pids,
            current_exe_canon.as_deref(),
        ) {
            continue;
        }
        let name = proc_.name().to_string_lossy().to_ascii_lowercase();
        if name.contains("desktop") || name.contains("tauri") {
            continue;
        }

        let is_jeik_family = name.starts_with("jeikcode") || name.starts_with("atomcode");
        if !is_jeik_family {
            continue;
        }

        let exe_path_str = proc_
            .exe()
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        let exe_path_lower = exe_path_str.to_ascii_lowercase();

        // 1. 判定是否为老旧 Dropper 目录残存
        let is_legacy_path = exe_path_lower.contains(".local\\bin")
            || exe_path_lower.contains(".local/bin")
            || exe_path_lower.contains("atomcode");

        // 2. 检查环境变量是否包含 JEIKCODE_DESKTOP=1
        let is_desktop_env = proc_.environ().iter().any(|env_str| {
            let s = env_str.to_string_lossy();
            s.starts_with("JEIKCODE_DESKTOP=")
                || s.starts_with("JEIKCODE_DESKTOP_CLI_BIN=")
                || s.starts_with("JEIKCODE_DESKTOP_PID=")
        });

        let declared_desktop_pid = proc_.environ().iter().find_map(|env_str| {
            let s = env_str.to_string_lossy();
            s.strip_prefix("JEIKCODE_DESKTOP_PID=")
                .and_then(|val| val.trim().parse::<u32>().ok())
                .filter(|pid| *pid > 0)
        });

        // 3. 检查父进程与绑定的桌面壳状态
        let desktop_owner_alive = parent_pid
            .is_some_and(|ppid| active_desktop_pids.contains(&ppid))
            || declared_desktop_pid.is_some_and(|dpid| active_desktop_pids.contains(&dpid));

        // 判定准则（严格保护普通终端/开发/TUI 实例）：
        // - 如果是运行在旧目录 .local\bin 下的实例 -> 100% 历史遗留僵尸
        // - 如果原本是桌面端子进程 (is_desktop_env)，但绑定的父级桌面壳已不再存活 -> 100% 孤儿僵尸
        let mut zombie_reason = None;
        if is_legacy_path {
            zombie_reason = Some("旧版 ~/.local/bin 遗留运行实例".to_string());
        } else if is_desktop_env && !desktop_owner_alive {
            zombie_reason = Some("父级桌面壳已退出，脱离托管的孤儿子进程".to_string());
        }

        if let Some(reason) = zombie_reason {
            out.push(ZombieProcessInfo {
                pid: pid_u32,
                name: name.clone(),
                path: if exe_path_str.is_empty() {
                    None
                } else {
                    Some(exe_path_str)
                },
                reason,
            });
        }
    }
    out
}

pub fn kill_zombie_processes_all() -> usize {
    let zombies = scan_zombie_processes();
    if zombies.is_empty() {
        return 0;
    }
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::everything(),
    );
    let my_pid = sysinfo::get_current_pid().ok().map(|p| p.as_u32());
    let self_task_pids = collect_self_task_pids(&sys);
    let current_exe_canon = canonical_exe_or_raw(std::env::current_exe().ok().as_deref());
    let mut killed = 0;
    for z in zombies {
        if let Some(proc_) = sys.process(Pid::from_u32(z.pid)) {
            let exe_canon = canonical_exe_or_raw(proc_.exe());
            let parent_pid = proc_.parent().map(|p| p.as_u32());
            // 二次硬守卫：发信号前再次核对非自身/非线程/非同可执行文件
            if is_protected_process_entry(
                z.pid,
                proc_.thread_kind().is_some(),
                exe_canon.as_deref(),
                parent_pid,
                my_pid,
                &self_task_pids,
                current_exe_canon.as_deref(),
            ) {
                continue;
            }
            if proc_.kill() {
                killed += 1;
            }
        }
    }
    killed
}

fn collect_legacy_status_blocking() -> LegacyStatusResponse {
    let mut legacy_files = Vec::new();
    let current_exe = canonical_exe_or_raw(std::env::current_exe().ok().as_deref());
    if let Some(home) = jeikcode_config::util::real_home_dir() {
        let local_bin = home.join(".local").join("bin");
        if let Ok(entries) = std::fs::read_dir(&local_bin) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let name = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    let path_canon = canonical_exe_or_raw(Some(&path));
                    let is_current = current_exe.is_some() && current_exe == path_canon;
                    if (name.starts_with("jeikcode") || name.starts_with("atomcode")) && !is_current
                    {
                        legacy_files.push(path.display().to_string());
                    }
                }
            }
        }
    }

    let mut has_dirty_path = false;
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;
        if let Ok(env) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Environment") {
            let path_val: String = env.get_value("Path").unwrap_or_default();
            for item in path_val.split(';') {
                let lower = item.trim().to_ascii_lowercase();
                if lower.contains(".local\\bin")
                    || lower.contains(".local/bin")
                    || lower.contains("atomcode")
                {
                    has_dirty_path = true;
                    break;
                }
            }
        }
    }

    let zombies = scan_zombie_processes();
    let zombie_count = zombies.len();
    let has_legacy_files = !legacy_files.is_empty();
    let needs_migration = has_legacy_files || has_dirty_path || zombie_count > 0;

    LegacyStatusResponse {
        has_legacy_files,
        legacy_files,
        has_dirty_path,
        zombie_count,
        zombies,
        needs_migration,
    }
}

fn migrate_legacy_blocking(kill_zombies: bool) -> MigrateLegacyResponse {
    let mut cleaned_files_count = 0;
    let current_exe = canonical_exe_or_raw(std::env::current_exe().ok().as_deref());
    if let Some(home) = jeikcode_config::util::real_home_dir() {
        let local_bin = home.join(".local").join("bin");
        if let Ok(entries) = std::fs::read_dir(&local_bin) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let name = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    let path_canon = canonical_exe_or_raw(Some(&path));
                    let is_current = current_exe.is_some() && current_exe == path_canon;
                    if (name.starts_with("jeikcode") || name.starts_with("atomcode")) && !is_current
                    {
                        if std::fs::remove_file(&path).is_ok() {
                            cleaned_files_count += 1;
                        }
                    }
                }
            }
        }
        let _ = std::fs::remove_dir(&local_bin);
    }

    jeikcode_updater::migrate_legacy_environment();

    let mut killed_zombies_count = 0;
    if kill_zombies {
        killed_zombies_count = kill_zombie_processes_all();
    }

    MigrateLegacyResponse {
        success: true,
        cleaned_files_count,
        killed_zombies_count,
    }
}

pub(crate) async fn get_legacy_status() -> impl IntoResponse {
    let status = tokio::task::spawn_blocking(collect_legacy_status_blocking)
        .await
        .unwrap_or(LegacyStatusResponse {
            has_legacy_files: false,
            legacy_files: Vec::new(),
            has_dirty_path: false,
            zombie_count: 0,
            zombies: Vec::new(),
            needs_migration: false,
        });
    Json(status)
}

pub(crate) async fn post_migrate_legacy(
    Json(payload): Json<MigrateLegacyRequest>,
) -> impl IntoResponse {
    let kill_zombies = payload.kill_zombies;
    let res = tokio::task::spawn_blocking(move || migrate_legacy_blocking(kill_zombies))
        .await
        .unwrap_or(MigrateLegacyResponse {
            success: false,
            cleaned_files_count: 0,
            killed_zombies_count: 0,
        });
    Json(res)
}

fn default_close_action() -> String {
    "ask".to_string()
}

fn default_agent_mode_policy() -> String {
    "memory".to_string()
}

fn default_agent_global_mode() -> String {
    "build".to_string()
}

fn default_toggle_shortcut() -> String {
    "Ctrl+Alt+J".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DesktopSettingsPayload {
    #[serde(default = "default_close_action")]
    pub close_action: String,
    /// 启动与日常权限模式策略：`"memory"`（默认，按会话记忆）或 `"global"`（全局统一模式）。
    #[serde(default = "default_agent_mode_policy")]
    pub agent_mode_policy: String,
    /// 选择 `"global"` 策略时生效的全局模式：`"build"` | `"plan"` | `"accept_edits"` | `"bypass"`。
    #[serde(default = "default_agent_global_mode")]
    pub agent_global_mode: String,
    /// 运行时切换模型：开启后，运行中的回合在下一个模型小轮自动换 provider，
    /// 保留当前上下文；关闭时沿用“下一轮生效/延后”的旧行为。
    #[serde(default)]
    pub runtime_model_switch: bool,
    /// 开机自启（静默到托盘，不闪窗口）。
    #[serde(default)]
    pub autostart: bool,
    /// 隐藏任务栏图标。
    #[serde(default)]
    pub hide_taskbar_icon: bool,
    /// 唤起/隐藏桌面窗口的全局快捷键；空串 = 禁用。
    #[serde(default = "default_toggle_shortcut")]
    pub toggle_shortcut: String,
}

impl Default for DesktopSettingsPayload {
    fn default() -> Self {
        Self {
            close_action: default_close_action(),
            agent_mode_policy: default_agent_mode_policy(),
            agent_global_mode: default_agent_global_mode(),
            runtime_model_switch: false,
            autostart: false,
            hide_taskbar_icon: false,
            toggle_shortcut: default_toggle_shortcut(),
        }
    }
}

#[derive(Debug, Default, serde::Deserialize)]
pub struct DesktopSettingsUpdate {
    #[serde(default)]
    pub close_action: Option<String>,
    #[serde(default)]
    pub agent_mode_policy: Option<String>,
    #[serde(default)]
    pub agent_global_mode: Option<String>,
    #[serde(default)]
    pub runtime_model_switch: Option<bool>,
    #[serde(default)]
    pub autostart: Option<bool>,
    #[serde(default)]
    pub hide_taskbar_icon: Option<bool>,
    #[serde(default)]
    pub toggle_shortcut: Option<String>,
}

pub(crate) fn normalize_desktop_settings(
    mut payload: DesktopSettingsPayload,
) -> DesktopSettingsPayload {
    payload.close_action = match payload.close_action.trim().to_ascii_lowercase().as_str() {
        "tray" => "tray".to_string(),
        "quit" => "quit".to_string(),
        _ => default_close_action(),
    };
    payload.agent_mode_policy = if payload
        .agent_mode_policy
        .trim()
        .eq_ignore_ascii_case("global")
    {
        "global".to_string()
    } else {
        default_agent_mode_policy()
    };
    payload.agent_global_mode =
        crate::live_api::parse_approval_mode_wire(Some(&payload.agent_global_mode))
            .unwrap_or(crate::approval_mode::ApprovalMode::Build)
            .wire()
            .to_string();
    payload.toggle_shortcut = payload.toggle_shortcut.trim().to_string();
    payload
}

fn desktop_settings_file_path() -> std::path::PathBuf {
    jeikcode_config::config::Config::config_dir().join("desktop-settings.json")
}

/// Process-level projection of the persisted `runtime_model_switch` checkbox.
/// Initialized at daemon startup and refreshed on every settings save so the
/// `/live/provider` active-turn branch does not need a disk read per switch.
static RUNTIME_MODEL_SWITCH: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub(crate) fn runtime_model_switch_enabled() -> bool {
    RUNTIME_MODEL_SWITCH.load(std::sync::atomic::Ordering::Acquire)
}

pub(crate) fn set_runtime_model_switch(enabled: bool) {
    RUNTIME_MODEL_SWITCH.store(enabled, std::sync::atomic::Ordering::Release);
}

pub(crate) fn init_runtime_model_switch_from_desktop_settings() {
    set_runtime_model_switch(load_desktop_settings_payload().runtime_model_switch);
}

pub(crate) fn load_desktop_settings_payload_at(path: &std::path::Path) -> DesktopSettingsPayload {
    let text = std::fs::read_to_string(path).unwrap_or_else(|_| "{}".into());
    let root = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    normalize_desktop_settings(desktop_settings_from_object(&root))
}

/// Field-wise extraction shared by cold start and the merge writer.
///
/// A single null/typed-wrong value must not reset the whole document; the old
/// typed parse returned `default()` and cold start silently reverted to
/// memory/Build. Unknown fields are intentionally ignored here and preserved by
/// [`merge_desktop_settings_at`]'s original JSON object.
fn desktop_settings_from_object(
    root: &serde_json::Map<String, serde_json::Value>,
) -> DesktopSettingsPayload {
    DesktopSettingsPayload {
        close_action: root
            .get("close_action")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("ask")
            .to_string(),
        agent_mode_policy: root
            .get("agent_mode_policy")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("memory")
            .to_string(),
        agent_global_mode: root
            .get("agent_global_mode")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("build")
            .to_string(),
        runtime_model_switch: root
            .get("runtime_model_switch")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        autostart: root
            .get("autostart")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        hide_taskbar_icon: root
            .get("hide_taskbar_icon")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        toggle_shortcut: root
            .get("toggle_shortcut")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .unwrap_or("Ctrl+Alt+J")
            .to_string(),
    }
}

pub(crate) fn load_desktop_settings_payload() -> DesktopSettingsPayload {
    load_desktop_settings_payload_at(&desktop_settings_file_path())
}

pub(crate) fn merge_desktop_settings_at(
    path: &std::path::Path,
    update: &DesktopSettingsUpdate,
) -> DesktopSettingsPayload {
    // Serialize the read-modify-write inside this process: the mode pill and the
    // system-settings dialog can now persist concurrently, and a lost update
    // would resurrect the previous policy after a refresh.
    static DESKTOP_SETTINGS_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = DESKTOP_SETTINGS_WRITE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    // Preserve fields this build does not know about (the desktop shell or a
    // newer daemon may already own them). Rewriting a typed struct here used to
    // drop them silently — same class of bug as the old native close-action
    // writer that erased the Agent mode policy.
    let mut root = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    // Read known fields individually so one malformed/null value cannot reset
    // the whole document to defaults (which would clobber the mode policy).
    let mut current = desktop_settings_from_object(&root);
    if let Some(close_action) = &update.close_action {
        current.close_action = close_action.clone();
    }
    if let Some(policy) = &update.agent_mode_policy {
        current.agent_mode_policy = policy.clone();
    }
    if let Some(mode) = &update.agent_global_mode {
        current.agent_global_mode = mode.clone();
    }
    if let Some(enabled) = update.runtime_model_switch {
        current.runtime_model_switch = enabled;
    }
    if let Some(enabled) = update.autostart {
        current.autostart = enabled;
    }
    if let Some(enabled) = update.hide_taskbar_icon {
        current.hide_taskbar_icon = enabled;
    }
    if let Some(shortcut) = &update.toggle_shortcut {
        current.toggle_shortcut = shortcut.clone();
    }
    let normalized = normalize_desktop_settings(current);
    root.insert(
        "close_action".to_string(),
        serde_json::Value::String(normalized.close_action.clone()),
    );
    root.insert(
        "agent_mode_policy".to_string(),
        serde_json::Value::String(normalized.agent_mode_policy.clone()),
    );
    root.insert(
        "agent_global_mode".to_string(),
        serde_json::Value::String(normalized.agent_global_mode.clone()),
    );
    root.insert(
        "runtime_model_switch".to_string(),
        serde_json::Value::Bool(normalized.runtime_model_switch),
    );
    root.insert(
        "autostart".to_string(),
        serde_json::Value::Bool(normalized.autostart),
    );
    root.insert(
        "hide_taskbar_icon".to_string(),
        serde_json::Value::Bool(normalized.hide_taskbar_icon),
    );
    root.insert(
        "toggle_shortcut".to_string(),
        serde_json::Value::String(normalized.toggle_shortcut.clone()),
    );
    let body = serde_json::to_string_pretty(&serde_json::Value::Object(root)).unwrap_or_default();
    // Atomic replace: a crash mid-write must never leave a truncated settings
    // file that cold start would silently normalize back to defaults.
    if let Err(error) = jeikcode_capabilities::fs::atomic_write(path, body.as_bytes(), 0o644) {
        eprintln!(
            "[desktop-settings] failed to persist {}: {error}",
            path.display()
        );
    }
    normalized
}

/// Persist the Agent mode policy without re-applying it.
///
/// `/approval_mode` (mode pill + global switch) is the live control surface; it
/// must write the same `desktop-settings.json` fields as the system-settings
/// dialog, otherwise a page refresh / daemon restart snaps back to the stale
/// policy on disk. The caller already applied the change in memory, so this
/// helper is write-only and never recurses into the apply path.
pub(crate) fn persist_agent_mode_policy(
    policy: &str,
    global_mode: crate::approval_mode::ApprovalMode,
) -> DesktopSettingsPayload {
    merge_desktop_settings_at(
        &desktop_settings_file_path(),
        &DesktopSettingsUpdate {
            close_action: None,
            agent_mode_policy: Some(policy.to_string()),
            agent_global_mode: Some(global_mode.wire().to_string()),
            ..Default::default()
        },
    )
}

pub(crate) async fn get_desktop_settings() -> impl IntoResponse {
    Json(load_desktop_settings_payload())
}

pub(crate) async fn post_desktop_settings(
    State(state): State<AppState>,
    Json(update): Json<DesktopSettingsUpdate>,
) -> impl IntoResponse {
    let mode_touched = update.agent_mode_policy.is_some() || update.agent_global_mode.is_some();
    let payload = merge_desktop_settings_at(&desktop_settings_file_path(), &update);
    // The runtime switch branch reads this process-level projection per model
    // change; keep it in lockstep with the just-persisted document.
    set_runtime_model_switch(payload.runtime_model_switch);
    if mode_touched {
        crate::live_api::apply_persisted_agent_mode_policy(
            &state,
            &payload.agent_mode_policy,
            &payload.agent_global_mode,
        )
        .await;
    }
    crate::publish_global(crate::GlobalWireEvent::DesktopSettingsChanged {
        settings: payload.clone(),
    });
    Json(serde_json::json!({ "success": true, "settings": payload }))
}

/// POST /config/reload - Reloads config.toml from disk, remounts MCP/skills on
/// the live runtime, and returns the sanitized config view.
pub(crate) async fn reload_config(State(state): State<AppState>) -> impl IntoResponse {
    let config = match load_config() {
        Ok(c) => c,
        Err(e) => {
            return json_error(axum::http::StatusCode::INTERNAL_SERVER_ERROR, e).into_response();
        }
    };
    let _ = crate::reload_mcp_and_live_runtime(&state, true, None).await;
    crate::publish_global(crate::GlobalWireEvent::ConfigReloaded);
    Json(config_response(&config)).into_response()
}

#[cfg(test)]
mod tests {
    #[test]
    fn language_endpoint_canonical_choices_persist_before_atomic_update() {
        use jeikcode_config::{i18n, locale::Locale, ConfigStore};
        let _guard = i18n::test_lock();
        let tmp = tempfile::TempDir::new().unwrap();
        let store = ConfigStore::new(tmp.path().join("config.toml"));
        for (key, locale) in [
            ("en", Locale::En),
            ("vi-VN", Locale::Vi),
            ("zh-CN", Locale::ZhCn),
        ] {
            let parsed = super::parse_language(key).unwrap();
            assert_eq!(parsed, locale);
            let config = super::persist_language(parsed, &store).unwrap();
            assert_eq!(super::config_response(&config).language, key);
            assert_eq!(store.read().unwrap().config.language, Some(locale));
            assert_eq!(i18n::current_locale(), locale);
        }
        let before = std::fs::read(store.path()).unwrap();
        for invalid in ["invalid_lang", "vi-VN-extra", "", "vi_US"] {
            assert!(super::parse_language(invalid).is_err());
            assert_eq!(std::fs::read(store.path()).unwrap(), before);
            assert_eq!(i18n::current_locale(), Locale::ZhCn);
        }
        let bad_store = ConfigStore::new(tmp.path());
        assert!(super::persist_language(Locale::Vi, &bad_store).is_err());
        assert_eq!(i18n::current_locale(), Locale::ZhCn);
    }

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
        state
            .enforce_token
            .store(true, std::sync::atomic::Ordering::Relaxed);
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
        for url in active_status.url.iter().chain(active_status.urls.iter()) {
            assert!(url.contains(":4096/?token=test-token"), "{url}");
            assert!(!url.contains("127.0.0.1"), "{url}");
            assert!(!url.contains("[::1]"), "{url}");
        }

        // 3. 停止临时访问后，恢复到初始 enforce_token (false)
        state.extra_remote.lock().unwrap().take();
        state.enforce_token.store(
            state.initial_enforce_token,
            std::sync::atomic::Ordering::Relaxed,
        );
        assert!(!state.is_token_enforced());
        let stopped_status = remote_status(&state, None);
        assert!(!stopped_status.active);
    }

    #[test]
    fn ipv4_literals_skip_loopback_and_keep_lan_addresses() {
        let blob = b"IPv4 Address. . . . . . . . . . . : 192.168.1.20\r\n\
                     Subnet Mask . . . . . . . . . . . : 255.255.255.0\r\n\
                     Autoconfiguration IPv4 Address. . : 169.254.8.9\r\n\
                     Subnet Mask . . . . . . . . . . . : 255.255.240.0\r\n\
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

    #[test]
    fn ipv6_literals_extract_gua_and_ula_skip_link_local() {
        let blob = b"IPv6 Address. . . . . . . . . . . : 2409:8a00:1234:5678::1\r\n\
                     Temporary IPv6 Address. . . . . . : 2409:8a00:1234:5678:abcd:ef01:2345:6789\r\n\
                     Link-local IPv6 Address . . . . . : fe80::51b2:2cb4:9999:8888%12\r\n\
                     IPv6 Address. . . . . . . . . . . : fd12:3456:789a::1\r\n\
                     IPv6 Address. . . . . . . . . . . : ::1\r\n\
                     IPv6 Address. . . . . . . . . . . : ::\r\n";
        let found = collect_ipv6_literals(blob);
        assert_eq!(
            found,
            vec![
                "2409:8a00:1234:5678::1".to_string(),
                "2409:8a00:1234:5678:abcd:ef01:2345:6789".to_string(),
                "fd12:3456:789a::1".to_string(),
            ]
        );
    }

    #[test]
    fn ipv6_literals_strip_cidr_and_supports_linux_ip_addr_output() {
        let blob = b"2: eth0    inet6 2409:8a00:1234:5678::100/64 scope global dynamic \r\n\
                     3: wlan0   inet6 fe80::1234/64 scope link \r\n\
                     4: docker0 inet6 fd00:dead:beef::1/48 scope global \r\n\
                     1: lo      inet6 ::1/128 scope host \r\n";
        let found = collect_ipv6_literals(blob);
        assert_eq!(
            found,
            vec![
                "2409:8a00:1234:5678::100".to_string(),
                "fd00:dead:beef::1".to_string(),
            ]
        );
    }

    #[test]
    fn access_urls_formats_ipv6_with_brackets() {
        let url = format_access_url("2409:8a00:1::1", 13457, Some("anhuang"), false);
        assert_eq!(url, "http://[2409:8a00:1::1]:13457/?token=anhuang");
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
                restart: false,
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
                restart: false,
            }),
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), stop)
            .await
            .expect("stop deadlocked");
        assert!(state.extra_remote.lock().unwrap().is_none());
        assert!(!state.is_token_enforced());
    }

    #[tokio::test]
    async fn loopback_no_token_daemon_cannot_expand_to_unauthenticated_wildcard_listener() {
        use axum::extract::State;
        use axum::response::IntoResponse;
        use axum::Json;

        let home = crate::tests::ScopedChatHome::new();
        let state = crate::tests::chat_test_state(&home);
        assert!(
            !state.is_token_enforced(),
            "test starts in legacy loopback no-token mode"
        );

        let response = post_remote_access(
            State(state.clone()),
            Json(RemoteAccessBody {
                host: "0.0.0.0".into(),
                port: 4096,
                token: String::new(),
                no_token: true,
                stop: false,
                apply_launch: false,
                restart: false,
            }),
        )
        .await
        .into_response();

        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
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
                restart: false,
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
                restart: false,
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
        state.initial_enforce_token = true;
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
                restart: false,
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
                restart: false,
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
                restart: false,
            }),
        );
        let response = tokio::time::timeout(std::time::Duration::from_secs(5), open_now)
            .await
            .expect("no-token update returned")
            .into_response();
        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        assert!(state.is_token_enforced());
        let saved = std::fs::read_to_string(webui_listen_pref_path()).unwrap();
        assert!(saved.contains("\"port\": 4096"), "{saved}");
        assert!(saved.contains("later-token"), "{saved}");
        assert!(!saved.contains("no_token"), "{saved}");
    }

    #[test]
    fn zombie_guard_protects_self_threads_children_and_same_exe() {
        let mut self_tasks = std::collections::HashSet::new();
        self_tasks.insert(226712);
        self_tasks.insert(226717);
        let self_exe = std::path::Path::new("/usr/local/bin/jeikcode");
        let legacy_exe = std::path::Path::new("/home/u/.local/bin/jeikcode");

        // 1. 主进程自身
        assert!(is_protected_process_entry(
            226712,
            false,
            Some(legacy_exe),
            Some(1),
            Some(226712),
            &self_tasks,
            Some(self_exe),
        ));
        // 2. 同线程组工作线程（即使 is_thread=false 也命中 self_tasks）
        assert!(is_protected_process_entry(
            226717,
            false,
            Some(legacy_exe),
            Some(226712),
            Some(226712),
            &self_tasks,
            Some(self_exe),
        ));
        // 3. 任意线程（Linux sysinfo thread_kind().is_some() == true）
        assert!(is_protected_process_entry(
            999001,
            true,
            Some(legacy_exe),
            Some(999000),
            Some(226712),
            &self_tasks,
            Some(self_exe),
        ));
        // 4. 同一可执行文件路径
        assert!(is_protected_process_entry(
            300001,
            false,
            Some(self_exe),
            Some(1),
            Some(226712),
            &self_tasks,
            Some(self_exe),
        ));
        // 5. 真正异路径、非线程、非本进程/子进程的遗留实例才允许判定
        assert!(!is_protected_process_entry(
            400001,
            false,
            Some(legacy_exe),
            Some(1),
            Some(226712),
            &self_tasks,
            Some(self_exe),
        ));
    }

    #[test]
    fn desktop_settings_preserve_agent_mode_policy_on_partial_close_action_update() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("desktop-settings.json");

        let saved = super::merge_desktop_settings_at(
            &path,
            &super::DesktopSettingsUpdate {
                close_action: Some("ask".into()),
                agent_mode_policy: Some("global".into()),
                agent_global_mode: Some("bypass".into()),
                ..Default::default()
            },
        );
        assert_eq!(saved.agent_mode_policy, "global");
        assert_eq!(saved.agent_global_mode, "bypass");

        // Close-prompt dialog only updates close_action; agent mode policy must survive intact.
        let after_close = super::merge_desktop_settings_at(
            &path,
            &super::DesktopSettingsUpdate {
                close_action: Some("tray".into()),
                agent_mode_policy: None,
                agent_global_mode: None,
                ..Default::default()
            },
        );
        assert_eq!(after_close.close_action, "tray");
        assert_eq!(after_close.agent_mode_policy, "global");
        assert_eq!(after_close.agent_global_mode, "bypass");

        // Unknown values normalize safely back to memory + build defaults.
        let normalized = super::normalize_desktop_settings(super::DesktopSettingsPayload {
            close_action: "".into(),
            agent_mode_policy: "invalid".into(),
            agent_global_mode: "invalid".into(),
            ..Default::default()
        });
        assert_eq!(normalized.close_action, "ask");
        assert_eq!(normalized.agent_mode_policy, "memory");
        assert_eq!(normalized.agent_global_mode, "build");
    }

    #[test]
    fn desktop_settings_load_tolerates_one_bad_field_without_resetting_others() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("desktop-settings.json");
        std::fs::write(
            &path,
            r#"{"close_action":"tray","agent_mode_policy":"global","agent_global_mode":null}"#,
        )
        .unwrap();
        let loaded = super::load_desktop_settings_payload_at(&path);
        assert_eq!(loaded.close_action, "tray");
        assert_eq!(loaded.agent_mode_policy, "global");
        assert_eq!(loaded.agent_global_mode, "build");
    }

    #[test]
    fn desktop_settings_runtime_switch_autostart_and_shortcut_round_trip() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("desktop-settings.json");
        std::fs::write(
            &path,
            r#"{"runtime_model_switch":true,"autostart":true,"toggle_shortcut":"Ctrl+Shift+K"}"#,
        )
        .unwrap();
        let loaded = super::load_desktop_settings_payload_at(&path);
        assert!(loaded.runtime_model_switch);
        assert!(loaded.autostart);
        assert_eq!(loaded.toggle_shortcut, "Ctrl+Shift+K");

        // A partial close-action write must preserve the new OS/runtime settings.
        let saved = super::merge_desktop_settings_at(
            &path,
            &super::DesktopSettingsUpdate {
                close_action: Some("tray".into()),
                ..Default::default()
            },
        );
        assert!(saved.runtime_model_switch);
        assert!(saved.autostart);
        assert_eq!(saved.toggle_shortcut, "Ctrl+Shift+K");

        // An explicitly empty shortcut means "disabled" and must survive.
        let cleared = super::merge_desktop_settings_at(
            &path,
            &super::DesktopSettingsUpdate {
                toggle_shortcut: Some(String::new()),
                ..Default::default()
            },
        );
        assert_eq!(cleared.toggle_shortcut, "");
        let reloaded = super::load_desktop_settings_payload_at(&path);
        assert_eq!(reloaded.toggle_shortcut, "");
    }

    #[test]
    fn desktop_settings_hide_taskbar_icon_round_trip() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("desktop-settings.json");
        assert!(!super::load_desktop_settings_payload_at(&path).hide_taskbar_icon);
        let saved = super::merge_desktop_settings_at(
            &path,
            &super::DesktopSettingsUpdate {
                hide_taskbar_icon: Some(true),
                ..Default::default()
            },
        );
        assert!(saved.hide_taskbar_icon);
        super::merge_desktop_settings_at(
            &path,
            &super::DesktopSettingsUpdate {
                close_action: Some("tray".into()),
                ..Default::default()
            },
        );
        assert!(super::load_desktop_settings_payload_at(&path).hide_taskbar_icon);
        super::merge_desktop_settings_at(
            &path,
            &super::DesktopSettingsUpdate {
                hide_taskbar_icon: Some(false),
                ..Default::default()
            },
        );
        assert!(!super::load_desktop_settings_payload_at(&path).hide_taskbar_icon);
    }

    #[test]
    fn desktop_settings_merge_preserves_fields_written_by_other_writers() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("desktop-settings.json");
        std::fs::write(
            &path,
            r#"{
  "close_action": "ask",
  "agent_mode_policy": "global",
  "agent_global_mode": "plan",
  "future_window_geometry": { "width": 1280 }
}"#,
        )
        .unwrap();

        let saved = super::merge_desktop_settings_at(
            &path,
            &super::DesktopSettingsUpdate {
                close_action: Some("tray".into()),
                agent_mode_policy: None,
                agent_global_mode: None,
                ..Default::default()
            },
        );
        assert_eq!(saved.close_action, "tray");
        assert_eq!(saved.agent_mode_policy, "global");
        assert_eq!(saved.agent_global_mode, "plan");

        let written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            written["future_window_geometry"]["width"], 1280,
            "a partial settings write must not drop fields owned by the desktop shell"
        );
    }
}
