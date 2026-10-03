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
}

#[derive(Debug, serde::Serialize)]
struct RemoteAccessStatus {
    host: String,
    port: u16,
    no_token: bool,
    active: bool,
    token: Option<String>,
    url: Option<String>,
}

fn remote_status(state: &crate::AppState, token: Option<String>) -> RemoteAccessStatus {
    let extra = state.extra_remote.lock().unwrap_or_else(|e| e.into_inner());
    let (host, port, active) = if let Some(bind) = extra.as_ref() {
        (bind.host.clone(), bind.port, true)
    } else {
        (state.bind_host.clone(), state.bind_port, false)
    };
    let no_token = state
        .token_optional
        .load(std::sync::atomic::Ordering::Relaxed);
    let url = if active {
        let display = if host == "0.0.0.0" || host == "::" {
            crate::primary_lan_ipv4().unwrap_or_else(|| "127.0.0.1".into())
        } else {
            host.clone()
        };
        let mut url = format!("http://{display}:{port}/");
        if !no_token {
            if let Some(tok) = token.as_ref().filter(|t| !t.is_empty()) {
                url = format!("http://{display}:{port}/?token={tok}");
            }
        }
        Some(url)
    } else {
        None
    };
    RemoteAccessStatus {
        host,
        port,
        no_token,
        active,
        token,
        url,
    }
}

/// GET /api/remote-access — current temporary listener, if one is open.
pub(crate) async fn get_remote_access(State(state): State<AppState>) -> impl IntoResponse {
    Json(remote_status(&state, None))
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
    if body.stop {
        if let Some(prev) = state
            .extra_remote
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            prev.abort.abort();
        }
        state
            .token_optional
            .store(false, std::sync::atomic::Ordering::Relaxed);
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

    state
        .token_optional
        .store(body.no_token, std::sync::atomic::Ordering::Relaxed);
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
        return Json(remote_status(&state, minted)).into_response();
    }

    let already = state
        .extra_remote
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .is_some_and(|bind| bind.host == host && bind.port == body.port);
    if already {
        return Json(remote_status(&state, minted)).into_response();
    }

    let Some(router) = state.http_router.get().cloned() else {
        return json_error(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "server is still starting",
        )
        .into_response();
    };
    let addr = format!("{host}:{}", body.port);
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(listener) => listener,
        Err(err) => {
            return json_error(
                axum::http::StatusCode::CONFLICT,
                format!("failed to listen on {addr}: {err}"),
            )
            .into_response();
        }
    };
    if let Some(prev) = state
        .extra_remote
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
    {
        prev.abort.abort();
    }
    let task = tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, router).await {
            tracing::error!(?err, "temporary remote listener stopped");
        }
    });
    let abort = task.abort_handle();
    *state.extra_remote.lock().unwrap_or_else(|e| e.into_inner()) = Some(crate::ExtraRemoteBind {
        host,
        port: body.port,
        abort,
    });
    Json(remote_status(&state, minted)).into_response()
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
}
