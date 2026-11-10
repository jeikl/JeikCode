//! ChatGPT Plus / Codex OAuth login flow with PKCE (RFC 7636).
//!
//! Enables developers with ChatGPT Plus / Pro subscriptions to authenticate
//! directly with OpenAI's OAuth endpoints and utilize the Codex backend endpoint
//! (`https://chatgpt.com/backend-api/codex`).

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

use anyhow::{Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use jeikcode_config::config::Config;

/// OpenAI OAuth authorize URL
pub const OPENAI_OAUTH_AUTH_URL: &str = "https://auth.openai.com/oauth/authorize";
/// OpenAI OAuth token endpoint
pub const OPENAI_OAUTH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
/// Public client ID for Codex CLI OAuth applications
pub const OPENAI_CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
/// Standard OAuth scopes required for Codex models
pub const OPENAI_DEFAULT_SCOPE: &str =
    "openid profile email offline_access api.connectors.read api.connectors.invoke";
/// Standard Codex loopback callback ports (1455 primary, 1457 fallback)
pub const OPENAI_CODEX_PORTS: [u16; 2] = [1455, 1457];
/// Default loopback redirect URI
pub const DEFAULT_REDIRECT_URI: &str = "http://127.0.0.1:1455/auth/callback";

/// PKCE challenge material (RFC 7636).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PkceChallenge {
    pub verifier: String,
    pub challenge: String,
    pub method: &'static str,
}

impl PkceChallenge {
    /// Generate a fresh PKCE verifier and S256 challenge.
    pub fn new() -> Self {
        let mut entropy = [0u8; 32];
        entropy[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        entropy[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());

        let verifier = URL_SAFE_NO_PAD.encode(entropy);
        let challenge = compute_s256_challenge(&verifier);

        Self {
            verifier,
            challenge,
            method: "S256",
        }
    }
}

impl Default for PkceChallenge {
    fn default() -> Self {
        Self::new()
    }
}

/// Compute base64url-encoded SHA-256 digest of verifier (RFC 7636 Section 4.2).
pub fn compute_s256_challenge(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let hash = hasher.finalize();
    URL_SAFE_NO_PAD.encode(hash)
}

/// Construct the full browser authorization URL for OpenAI OAuth PKCE flow.
pub fn build_authorization_url(
    redirect_uri: &str,
    challenge: &PkceChallenge,
    state: &str,
    client_id: Option<&str>,
) -> String {
    let client_id = client_id.unwrap_or(OPENAI_CODEX_CLIENT_ID);
    let mut u = Url::parse(OPENAI_OAUTH_AUTH_URL).expect("valid auth base URL");
    u.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("response_type", "code")
        .append_pair("scope", OPENAI_DEFAULT_SCOPE)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("code_challenge", &challenge.challenge)
        .append_pair("code_challenge_method", challenge.method)
        .append_pair("state", state)
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true");
    u.to_string()
}

/// Extract ChatGPT account ID from a JWT token (id_token or access_token).
pub fn extract_chatgpt_account_id_from_jwt(jwt: &str) -> Option<String> {
    let parts: Vec<&str> = jwt.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    let payload = parts[1];
    let unpadded = payload.trim_end_matches('=');
    let decoded = URL_SAFE_NO_PAD
        .decode(unpadded)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(unpadded))
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload))
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(payload))
        .ok()?;
    let value: serde_json::Value = serde_json::from_slice(&decoded).ok()?;

    // 1. Direct namespaced claim URI
    if let Some(id) = value
        .get("https://api.openai.com/auth.chatgpt_account_id")
        .and_then(|v| v.as_str())
    {
        return Some(id.to_string());
    }
    if let Some(id) = value
        .get("https://api.openai.com/auth/chatgpt_account_id")
        .and_then(|v| v.as_str())
    {
        return Some(id.to_string());
    }

    // 2. Auth0 namespaced JSON object: "https://api.openai.com/auth": { "chatgpt_account_id": "..." }
    if let Some(auth_obj) = value
        .get("https://api.openai.com/auth")
        .and_then(|v| v.as_object())
    {
        if let Some(id) = auth_obj.get("chatgpt_account_id").and_then(|v| v.as_str()) {
            return Some(id.to_string());
        }
        if let Some(orgs) = auth_obj.get("organizations").and_then(|v| v.as_array()) {
            if let Some(first) = orgs
                .first()
                .and_then(|o| o.get("id"))
                .and_then(|v| v.as_str())
            {
                return Some(first.to_string());
            }
        }
    }

    // 3. Top-level claim
    if let Some(id) = value.get("chatgpt_account_id").and_then(|v| v.as_str()) {
        return Some(id.to_string());
    }
    if let Some(orgs) = value.get("organizations").and_then(|v| v.as_array()) {
        if let Some(first) = orgs
            .first()
            .and_then(|o| o.get("id"))
            .and_then(|v| v.as_str())
        {
            return Some(first.to_string());
        }
    }
    None
}

/// Raw token response from `https://auth.openai.com/oauth/token`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAiTokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub token_type: Option<String>,
    pub expires_in: Option<i64>,
    pub scope: Option<String>,
    pub id_token: Option<String>,
}

/// Stored authentication data for ChatGPT / OpenAI Codex.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenAiAuthInfo {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub token_type: String,
    pub expires_in: Option<i64>,
    #[serde(default)]
    pub created_at: i64,
    pub account_id: Option<String>,
}

impl OpenAiAuthInfo {
    /// True if the token is expired or within the 5-minute safety margin.
    pub fn is_expired(&self) -> bool {
        let default_lifetime = 86400; // 24h fallback window when expires_in is omitted
        let expires_in = self.expires_in.unwrap_or(default_lifetime);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(i64::MAX);
        if self.created_at == 0 && self.refresh_token.is_some() {
            true
        } else {
            let expires_at = self.created_at + expires_in;
            now >= expires_at - 300
        }
    }
}

/// Exchange authorization code for access and refresh tokens via application/x-www-form-urlencoded.
pub fn exchange_code(
    code: &str,
    verifier: &str,
    redirect_uri: &str,
    client_id: Option<&str>,
) -> Result<OpenAiTokenResponse> {
    let client_id = client_id.unwrap_or(OPENAI_CODEX_CLIENT_ID);
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .user_agent(crate::JEIKCODE_USER_AGENT)
        .build()
        .context("failed to build HTTP client for token exchange")?;

    let form = [
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("code", code),
        ("code_verifier", verifier),
        ("redirect_uri", redirect_uri),
    ];

    let resp = client
        .post(OPENAI_OAUTH_TOKEN_URL)
        .form(&form)
        .send()
        .context("Failed to send token exchange request to OpenAI")?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        anyhow::bail!("OpenAI token exchange failed ({status}): {body}");
    }

    resp.json::<OpenAiTokenResponse>()
        .context("Failed to parse OpenAI token exchange response")
}

/// Refresh an expired access token using the stored refresh token via application/x-www-form-urlencoded.
pub fn refresh_openai_token(
    refresh_token: &str,
    client_id: Option<&str>,
) -> Result<OpenAiTokenResponse> {
    let client_id = client_id.unwrap_or(OPENAI_CODEX_CLIENT_ID);
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .user_agent(crate::JEIKCODE_USER_AGENT)
        .build()
        .context("failed to build HTTP client for token refresh")?;

    let form = [
        ("grant_type", "refresh_token"),
        ("client_id", client_id),
        ("refresh_token", refresh_token),
    ];

    let resp = client
        .post(OPENAI_OAUTH_TOKEN_URL)
        .form(&form)
        .send()
        .context("Failed to send token refresh request to OpenAI")?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        anyhow::bail!("OpenAI token refresh failed ({status}): {body}");
    }

    resp.json::<OpenAiTokenResponse>()
        .context("Failed to parse OpenAI token refresh response")
}

/// Bind a loopback callback listener on port 1455 (with fallback to 1457).
pub fn bind_openai_callback_listener() -> Result<(u16, TcpListener)> {
    for &port in &OPENAI_CODEX_PORTS {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
            return Ok((port, listener));
        }
    }
    anyhow::bail!(
        "Failed to bind OpenAI OAuth loopback listener on ports {} or {}",
        OPENAI_CODEX_PORTS[0],
        OPENAI_CODEX_PORTS[1]
    );
}

/// Parsed result of an incoming loopback HTTP request.
#[derive(Debug, PartialEq, Eq)]
pub enum CallbackParseResult {
    /// Successful authorization callback containing code and state.
    Success { code: String, state: String },
    /// OAuth error parameter returned by authorization server.
    Error(String),
    /// Favicon request.
    Favicon,
    /// Unrelated resource request.
    NotFound,
    /// Callback request missing required code or state.
    MissingParameters,
}

/// Parse an incoming HTTP request line and query string for the OAuth callback.
pub fn parse_callback_request(req: &str) -> CallbackParseResult {
    let path = match req
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
    {
        Some(p) => p,
        None => return CallbackParseResult::NotFound,
    };

    if path.starts_with("/favicon.ico") {
        return CallbackParseResult::Favicon;
    }

    let parsed_url = if path.starts_with("http://") || path.starts_with("https://") {
        match Url::parse(path) {
            Ok(u) => u,
            Err(_) => return CallbackParseResult::NotFound,
        }
    } else {
        match Url::parse(&format!("http://127.0.0.1{}", path)) {
            Ok(u) => u,
            Err(_) => return CallbackParseResult::NotFound,
        }
    };

    if !parsed_url.path().starts_with("/auth/callback") {
        return CallbackParseResult::NotFound;
    }

    if let Some((_, err)) = parsed_url.query_pairs().find(|(k, _)| k == "error") {
        return CallbackParseResult::Error(err.into_owned());
    }

    let code = parsed_url
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned());
    let state = parsed_url
        .query_pairs()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.into_owned());

    match (code, state) {
        (Some(code), Some(state)) => CallbackParseResult::Success { code, state },
        _ => CallbackParseResult::MissingParameters,
    }
}

/// Wait for incoming OAuth redirect callback on the loopback listener.
fn await_openai_callback(listener: TcpListener, timeout: Duration) -> Result<(String, String)> {
    let start = std::time::Instant::now();
    listener
        .set_nonblocking(true)
        .context("Failed to configure listener socket")?;

    loop {
        if start.elapsed() > timeout {
            anyhow::bail!("Timed out waiting for OpenAI OAuth browser callback");
        }

        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut buf = [0u8; 4096];
                let n = match stream.read(&mut buf) {
                    Ok(n) if n > 0 => n,
                    _ => continue,
                };
                let req = String::from_utf8_lossy(&buf[..n]);

                match parse_callback_request(&req) {
                    CallbackParseResult::Success { code, state } => {
                        let body = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Authentication Complete</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f172a;color:#f8fafc}.card{background:#1e293b;padding:2rem;border-radius:1rem;text-align:center;box-shadow:0 10px 25px rgba(0,0,0,0.5)}h2{color:#38bdf8;margin-bottom:0.5rem}</style></head><body><div class=\"card\"><h2>Authentication Successful!</h2><p>You may now close this tab and return to JeikCode.</p></div></body></html>";
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            body.len(), body
                        );
                        let _ = stream.write_all(resp.as_bytes());
                        let _ = stream.flush();
                        return Ok((code, state));
                    }
                    CallbackParseResult::Error(err) => {
                        let body = format!("Authentication error: {}", err);
                        let resp = format!(
                            "HTTP/1.1 400 Bad Request\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            body.len(), body
                        );
                        let _ = stream.write_all(resp.as_bytes());
                        let _ = stream.flush();
                        anyhow::bail!("OpenAI OAuth callback reported error: {err}");
                    }
                    CallbackParseResult::Favicon | CallbackParseResult::NotFound => {
                        let resp = "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
                        let _ = stream.write_all(resp.as_bytes());
                        let _ = stream.flush();
                        continue;
                    }
                    CallbackParseResult::MissingParameters => {
                        let body = "Missing code or state parameter";
                        let resp = format!(
                            "HTTP/1.1 400 Bad Request\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            body.len(), body
                        );
                        let _ = stream.write_all(resp.as_bytes());
                        let _ = stream.flush();
                        continue;
                    }
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                anyhow::bail!("Error accepting connection on loopback listener: {e}");
            }
        }
    }
}

/// An active OpenAI Codex OAuth login session.
pub struct OpenAiLoginSession {
    pub port: u16,
    pub redirect_uri: String,
    pub pkce: PkceChallenge,
    pub state: String,
    pub auth_url: String,
    listener: TcpListener,
}

impl OpenAiLoginSession {
    /// Start a login session, binding to 127.0.0.1:1455 (or 1457).
    pub fn start() -> Result<Self> {
        let (port, listener) = bind_openai_callback_listener()?;
        let redirect_uri = format!("http://127.0.0.1:{}/auth/callback", port);
        let pkce = PkceChallenge::new();
        let state = uuid::Uuid::new_v4().to_string();
        let auth_url = build_authorization_url(&redirect_uri, &pkce, &state, None);

        Ok(Self {
            port,
            redirect_uri,
            pkce,
            state,
            auth_url,
            listener,
        })
    }

    /// Authorization URL the user must visit in their browser.
    pub fn url(&self) -> &str {
        &self.auth_url
    }

    /// Attempt to launch the system default browser with the authorization URL.
    pub fn open_browser_best_effort(&self) {
        let _ = crate::oauth::open_browser(&self.auth_url);
    }

    /// Wait for browser callback, exchange authorization code, extract account ID,
    /// persist credentials to `openai_auth.toml`, and return the authenticated info.
    pub fn wait_for_completion(self, timeout: Duration) -> Result<OpenAiAuthInfo> {
        let (code, state) = await_openai_callback(self.listener, timeout)?;
        if state != self.state {
            anyhow::bail!("OAuth state mismatch: possible CSRF or stale callback");
        }

        let token_resp = exchange_code(&code, &self.pkce.verifier, &self.redirect_uri, None)?;
        let account_id = token_resp
            .id_token
            .as_deref()
            .and_then(extract_chatgpt_account_id_from_jwt)
            .or_else(|| extract_chatgpt_account_id_from_jwt(&token_resp.access_token));

        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let auth_info = OpenAiAuthInfo {
            access_token: token_resp.access_token,
            refresh_token: token_resp.refresh_token,
            token_type: token_resp
                .token_type
                .unwrap_or_else(|| "Bearer".to_string()),
            expires_in: token_resp.expires_in,
            created_at,
            account_id,
        };

        save_openai_auth(&auth_info)?;
        Ok(auth_info)
    }
}

/// Convenience interactive login flow for CLI / TUI callers.
pub fn login_openai_interactive() -> Result<OpenAiAuthInfo> {
    let session = OpenAiLoginSession::start()?;
    println!("\n  Open the following URL in your browser to log in with ChatGPT Plus/Pro:");
    println!("  {}\n", session.url());
    session.open_browser_best_effort();
    println!(
        "  Waiting for authorization callback on http://127.0.0.1:{}/auth/callback ...",
        session.port
    );
    let auth = session.wait_for_completion(Duration::from_secs(300))?;
    println!("  Successfully authenticated with OpenAI Codex!");
    if let Some(ref acc_id) = auth.account_id {
        println!("  Account ID: {acc_id}");
    }
    Ok(auth)
}

/// Path to `openai_auth.toml` in the JeikCode configuration directory.
pub fn openai_auth_file_path() -> std::path::PathBuf {
    Config::config_dir().join("openai_auth.toml")
}

/// Load stored OpenAI authentication data, distinguishing missing file from corrupted contents.
pub fn load_openai_auth_result() -> Result<Option<OpenAiAuthInfo>> {
    let path = openai_auth_file_path();
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path)
        .with_context(|| format!("Failed to read OpenAI auth file at {}", path.display()))?;
    let info: OpenAiAuthInfo = toml::from_str(&content).with_context(|| {
        format!(
            "Corrupted OpenAI auth file at {}. Please re-authenticate.",
            path.display()
        )
    })?;
    Ok(Some(info))
}

/// Load stored OpenAI authentication data if present and valid.
pub fn load_openai_auth() -> Option<OpenAiAuthInfo> {
    load_openai_auth_result().ok().flatten()
}

/// Internal unlocked save function (caller must hold file lock).
fn save_openai_auth_unlocked(info: &OpenAiAuthInfo) -> Result<()> {
    let path = openai_auth_file_path();
    let content = toml::to_string_pretty(info).context("Failed to serialize OpenAI auth info")?;
    crate::write_auth_file_secure(&path, &content)
}

/// Save OpenAI authentication data with file locking and 0600 permissions.
pub fn save_openai_auth(info: &OpenAiAuthInfo) -> Result<()> {
    let lock_path = Config::config_dir().join("auth-refresh.lock");
    crate::oauth::with_auth_lock_file(&lock_path, || save_openai_auth_unlocked(info))
}

/// Remove stored OpenAI credentials under file lock.
pub fn logout_openai() -> Result<()> {
    let path = openai_auth_file_path();
    if !path.exists() {
        return Ok(());
    }
    let lock_path = Config::config_dir().join("auth-refresh.lock");
    crate::oauth::with_auth_lock_file(&lock_path, || {
        if path.exists() {
            std::fs::remove_file(&path).context("Failed to remove OpenAI auth file")?;
        }
        Ok(())
    })
}

/// Serialize refresh-token consumption across threads and processes.
pub fn refresh_openai_auth_if_current(
    rejected_access_token: &str,
    expected_account_id: Option<&str>,
) -> Result<OpenAiAuthInfo> {
    let lock_path = Config::config_dir().join("auth-refresh.lock");
    crate::oauth::with_auth_lock_file(&lock_path, || {
        let auth = load_openai_auth_result()?
            .context("Not logged in to ChatGPT/Codex — please authenticate first")?;

        if let Some(expected) = expected_account_id {
            if let Some(ref current) = auth.account_id {
                if current != expected {
                    anyhow::bail!("OpenAI account changed — please re-authenticate");
                }
            }
        }

        if !rejected_access_token.is_empty() && auth.access_token != rejected_access_token {
            return Ok(auth);
        }

        let refresh_token = auth
            .refresh_token
            .as_deref()
            .context("No refresh token available for ChatGPT/Codex login")?;

        let refreshed = refresh_openai_token(refresh_token, None)?;
        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let account_id = refreshed
            .id_token
            .as_deref()
            .and_then(extract_chatgpt_account_id_from_jwt)
            .or_else(|| extract_chatgpt_account_id_from_jwt(&refreshed.access_token))
            .or(auth.account_id);

        let new_auth = OpenAiAuthInfo {
            access_token: refreshed.access_token,
            refresh_token: refreshed.refresh_token.or(auth.refresh_token),
            token_type: refreshed.token_type.unwrap_or(auth.token_type),
            expires_in: refreshed.expires_in.or(auth.expires_in),
            created_at,
            account_id,
        };

        save_openai_auth_unlocked(&new_auth)?;
        Ok(new_auth)
    })
}

/// Obtain a valid OpenAI access token and auth info, refreshing if necessary under lock.
pub fn get_valid_openai_auth() -> Result<OpenAiAuthInfo> {
    let auth = load_openai_auth_result()?
        .context("Not logged in to ChatGPT/Codex — please authenticate first")?;

    if auth.is_expired() {
        return refresh_openai_auth_if_current(&auth.access_token, None);
    }

    if auth.access_token.trim().is_empty() {
        anyhow::bail!("Invalid stored OpenAI credentials — please re-authenticate");
    }

    Ok(auth)
}

/// Obtain a valid OpenAI access token string, refreshing if necessary.
pub fn get_valid_openai_token() -> Result<String> {
    get_valid_openai_auth().map(|a| a.access_token)
}

/// Force a token refresh using the stored refresh token and persist the new credentials.
pub fn force_refresh_openai_token() -> Result<OpenAiAuthInfo> {
    let auth = load_openai_auth_result()?
        .context("Not logged in to ChatGPT/Codex — please authenticate first")?;
    refresh_openai_auth_if_current(&auth.access_token, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc7636_test_vector_challenge() {
        // RFC 7636 Appendix B test vector
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = compute_s256_challenge(verifier);
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn pkce_challenge_generation() {
        let pkce = PkceChallenge::new();
        assert_eq!(pkce.method, "S256");
        assert!(!pkce.verifier.is_empty());
        assert!(!pkce.challenge.is_empty());
        assert_eq!(pkce.challenge, compute_s256_challenge(&pkce.verifier));
    }

    #[test]
    fn authorization_url_contains_codex_params() {
        let pkce = PkceChallenge {
            verifier: "test_verifier".into(),
            challenge: "test_challenge".into(),
            method: "S256",
        };
        let url = build_authorization_url(
            "http://127.0.0.1:1455/auth/callback",
            &pkce,
            "state123",
            None,
        );
        assert!(url.starts_with(OPENAI_OAUTH_AUTH_URL));
        assert!(url.contains("code_challenge=test_challenge"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=state123"));
        assert!(url.contains("client_id=app_EMoamEEZ73f0CkXaXp7hrann"));
        assert!(url.contains("id_token_add_organizations=true"));
        assert!(url.contains("codex_cli_simplified_flow=true"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback"));
        assert!(!url.contains("audience="));
    }

    #[test]
    fn extract_account_id_from_jwt_claims() {
        // JWT with https://api.openai.com/auth.chatgpt_account_id
        let payload1 = serde_json::json!({
            "https://api.openai.com/auth.chatgpt_account_id": "acc-12345",
            "email": "user@example.com"
        });
        let p1_b64 = URL_SAFE_NO_PAD.encode(payload1.to_string().as_bytes());
        let jwt1 = format!("eyJhbGciOiJub25lIn0.{}.signature", p1_b64);
        assert_eq!(
            extract_chatgpt_account_id_from_jwt(&jwt1),
            Some("acc-12345".to_string())
        );

        // JWT with chatgpt_account_id
        let payload2 = serde_json::json!({
            "chatgpt_account_id": "acc-67890"
        });
        let p2_b64 = URL_SAFE_NO_PAD.encode(payload2.to_string().as_bytes());
        let jwt2 = format!("eyJhbGciOiJub25lIn0.{}.signature", p2_b64);
        assert_eq!(
            extract_chatgpt_account_id_from_jwt(&jwt2),
            Some("acc-67890".to_string())
        );

        // JWT with organizations list
        let payload3 = serde_json::json!({
            "organizations": [{"id": "org-abcdef"}]
        });
        let p3_b64 = URL_SAFE_NO_PAD.encode(payload3.to_string().as_bytes());
        let jwt3 = format!("eyJhbGciOiJub25lIn0.{}.signature", p3_b64);
        assert_eq!(
            extract_chatgpt_account_id_from_jwt(&jwt3),
            Some("org-abcdef".to_string())
        );

        // Invalid JWT
        assert_eq!(extract_chatgpt_account_id_from_jwt("invalid.jwt"), None);
    }

    #[test]
    fn token_expiry_logic() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let fresh = OpenAiAuthInfo {
            access_token: "tok1".into(),
            refresh_token: Some("ref1".into()),
            token_type: "Bearer".into(),
            expires_in: Some(3600),
            created_at: now,
            account_id: None,
        };
        assert!(!fresh.is_expired());

        let expired = OpenAiAuthInfo {
            access_token: "tok2".into(),
            refresh_token: Some("ref2".into()),
            token_type: "Bearer".into(),
            expires_in: Some(3600),
            created_at: now - 3400, // 200s left < 300s margin
            account_id: None,
        };
        assert!(expired.is_expired());

        let legacy_refreshable = OpenAiAuthInfo {
            access_token: "tok3".into(),
            refresh_token: Some("ref3".into()),
            token_type: "Bearer".into(),
            expires_in: None,
            created_at: 0,
            account_id: None,
        };
        assert!(legacy_refreshable.is_expired());
    }

    #[test]
    fn serialization_roundtrip() {
        let info = OpenAiAuthInfo {
            access_token: "test_access".into(),
            refresh_token: Some("test_refresh".into()),
            token_type: "Bearer".into(),
            expires_in: Some(7200),
            created_at: 1700000000,
            account_id: Some("user-123".into()),
        };
        let toml_str = toml::to_string_pretty(&info).unwrap();
        let parsed: OpenAiAuthInfo = toml::from_str(&toml_str).unwrap();
        assert_eq!(info, parsed);
    }

    #[test]
    fn extract_account_id_from_nested_and_standard_base64_claims() {
        // Nested Auth0 namespace object: "https://api.openai.com/auth": { "chatgpt_account_id": "org-nested-1" }
        let payload1 = serde_json::json!({
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "org-nested-1",
                "user_id": "user-123"
            }
        });
        let p1_b64 = URL_SAFE_NO_PAD.encode(payload1.to_string().as_bytes());
        let jwt1 = format!("eyJhbGciOiJub25lIn0.{}.signature", p1_b64);
        assert_eq!(
            extract_chatgpt_account_id_from_jwt(&jwt1),
            Some("org-nested-1".to_string())
        );

        // Nested Auth0 organizations in namespace object
        let payload2 = serde_json::json!({
            "https://api.openai.com/auth": {
                "organizations": [{"id": "org-nested-org"}]
            }
        });
        let p2_b64 = URL_SAFE_NO_PAD.encode(payload2.to_string().as_bytes());
        let jwt2 = format!("eyJhbGciOiJub25lIn0.{}.signature", p2_b64);
        assert_eq!(
            extract_chatgpt_account_id_from_jwt(&jwt2),
            Some("org-nested-org".to_string())
        );

        // Slash delimited claim
        let payload3 = serde_json::json!({
            "https://api.openai.com/auth/chatgpt_account_id": "org-slash-3"
        });
        let p3_b64 = URL_SAFE_NO_PAD.encode(payload3.to_string().as_bytes());
        let jwt3 = format!("eyJhbGciOiJub25lIn0.{}.signature", p3_b64);
        assert_eq!(
            extract_chatgpt_account_id_from_jwt(&jwt3),
            Some("org-slash-3".to_string())
        );

        // Standard base64 encoding with '+' and padding '='
        let payload4 = serde_json::json!({
            "chatgpt_account_id": "org-std-base64",
            "extra_bytes": ">>>>????"
        });
        let p4_std =
            base64::engine::general_purpose::STANDARD.encode(payload4.to_string().as_bytes());
        let jwt4 = format!("eyJhbGciOiJub25lIn0.{}.signature", p4_std);
        assert_eq!(
            extract_chatgpt_account_id_from_jwt(&jwt4),
            Some("org-std-base64".to_string())
        );
    }

    #[test]
    fn parse_callback_request_variants() {
        // Standard relative callback URL
        let req1 = "GET /auth/callback?code=auth_code_123&state=state_xyz HTTP/1.1\r\nHost: 127.0.0.1:1455\r\n\r\n";
        assert_eq!(
            parse_callback_request(req1),
            CallbackParseResult::Success {
                code: "auth_code_123".to_string(),
                state: "state_xyz".to_string(),
            }
        );

        // Absolute URI sent by proxy or certain browsers
        let req2 = "GET http://127.0.0.1:1455/auth/callback?code=code_abc&state=state_123 HTTP/1.1\r\nHost: 127.0.0.1:1455\r\n\r\n";
        assert_eq!(
            parse_callback_request(req2),
            CallbackParseResult::Success {
                code: "code_abc".to_string(),
                state: "state_123".to_string(),
            }
        );

        // OAuth error response
        let req3 = "GET /auth/callback?error=access_denied&error_description=User+cancelled HTTP/1.1\r\n\r\n";
        assert_eq!(
            parse_callback_request(req3),
            CallbackParseResult::Error("access_denied".to_string())
        );

        // Favicon request
        let req4 = "GET /favicon.ico HTTP/1.1\r\n\r\n";
        assert_eq!(parse_callback_request(req4), CallbackParseResult::Favicon);

        // Other non-matching endpoint
        let req5 = "GET /index.html HTTP/1.1\r\n\r\n";
        assert_eq!(parse_callback_request(req5), CallbackParseResult::NotFound);

        // Missing parameters on callback endpoint
        let req6 = "GET /auth/callback?code=only_code HTTP/1.1\r\n\r\n";
        assert_eq!(
            parse_callback_request(req6),
            CallbackParseResult::MissingParameters
        );
    }

    #[test]
    fn auth_storage_and_corruption_detection() {
        let _home = jeikcode_config::test_util::isolated_home();

        // 1. Missing file returns Ok(None)
        assert!(load_openai_auth_result().unwrap().is_none());

        // 2. Valid save and load
        let info = OpenAiAuthInfo {
            access_token: "tok-abc".to_string(),
            refresh_token: Some("ref-xyz".to_string()),
            token_type: "Bearer".to_string(),
            expires_in: Some(3600),
            created_at: 1000,
            account_id: Some("acc-test".to_string()),
        };
        save_openai_auth(&info).unwrap();
        let loaded = load_openai_auth_result().unwrap().expect("must be loaded");
        assert_eq!(loaded, info);

        // 3. Corrupted content returns detailed Err
        std::fs::write(openai_auth_file_path(), "not valid toml ::: 1234").unwrap();
        let err = load_openai_auth_result().unwrap_err();
        assert!(err.to_string().contains("Corrupted OpenAI auth file"));

        // 4. Logout cleans up
        logout_openai().unwrap();
        assert!(!openai_auth_file_path().exists());
    }

    #[test]
    fn refresh_openai_auth_concurrency_and_account_protection() {
        let _home = jeikcode_config::test_util::isolated_home();

        let initial_auth = OpenAiAuthInfo {
            access_token: "token-already-refreshed-by-thread-A".to_string(),
            refresh_token: Some("refresh-xyz".to_string()),
            token_type: "Bearer".to_string(),
            expires_in: Some(3600),
            created_at: 1000,
            account_id: Some("acc-alpha".to_string()),
        };
        save_openai_auth(&initial_auth).unwrap();

        // Thread B holds rejected token "old-token-before-refresh"
        // It must detect that auth.access_token != rejected_token and return current auth without calling network
        let res =
            refresh_openai_auth_if_current("old-token-before-refresh", Some("acc-alpha")).unwrap();
        assert_eq!(res.access_token, "token-already-refreshed-by-thread-A");

        // Account mismatch check: caller expected "acc-beta", but storage holds "acc-alpha"
        let mismatch =
            refresh_openai_auth_if_current("token-already-refreshed-by-thread-A", Some("acc-beta"));
        assert!(mismatch.is_err());
        assert!(mismatch
            .unwrap_err()
            .to_string()
            .contains("account changed"));
    }
}
