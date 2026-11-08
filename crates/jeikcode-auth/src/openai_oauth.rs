//! ChatGPT Plus / Codex OAuth login flow with PKCE (RFC 7636).
//!
//! Enables developers with ChatGPT Plus / Pro subscriptions to authenticate
//! directly with OpenAI's OAuth endpoints and utilize the Codex backend endpoint
//! (`https://chatgpt.com/backend-api/codex/responses`).

use std::time::Duration;

use anyhow::{Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use jeikcode_config::config::Config;

/// OpenAI OAuth authorize URL
pub const OPENAI_OAUTH_AUTH_URL: &str = "https://auth.openai.com/oauth/authorize";
/// OpenAI OAuth token endpoint
pub const OPENAI_OAUTH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
/// Default public client ID for Codex / CLI OAuth applications
pub const OPENAI_CODEX_CLIENT_ID: &str = "pdlLIX2Y72MIl2rhLhTE9VV9bN905BpGuy";
/// Standard OAuth scopes required for Codex models
pub const OPENAI_DEFAULT_SCOPE: &str = "openid profile email offline_access model.request";
/// Default audience for OpenAI API access
pub const OPENAI_DEFAULT_AUDIENCE: &str = "https://api.openai.com/v1";
/// Codex backend responses endpoint
pub const OPENAI_CODEX_ENDPOINT: &str = "https://chatgpt.com/backend-api/codex/responses";

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
        // Generate 32 bytes of random entropy from two v4 UUIDs
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
    format!(
        "{}?client_id={}&response_type=code&scope={}&redirect_uri={}&code_challenge={}&code_challenge_method={}&state={}&audience={}",
        OPENAI_OAUTH_AUTH_URL,
        urlencoding_encode(client_id),
        urlencoding_encode(OPENAI_DEFAULT_SCOPE),
        urlencoding_encode(redirect_uri),
        urlencoding_encode(&challenge.challenge),
        challenge.method,
        urlencoding_encode(state),
        urlencoding_encode(OPENAI_DEFAULT_AUDIENCE),
    )
}

/// Minimal URL encoding for query parameters.
fn urlencoding_encode(s: &str) -> String {
    let mut encoded = String::new();
    for b in s.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(b as char)
            }
            _ => encoded.push_str(&format!("%{:02X}", b)),
        }
    }
    encoded
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
        if let Some(expires_in) = self.expires_in {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(i64::MAX);
            let expires_at = self.created_at + expires_in;
            now >= expires_at - 300
        } else {
            false
        }
    }
}

/// Exchange authorization code for access and refresh tokens.
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

    let payload = serde_json::json!({
        "grant_type": "authorization_code",
        "client_id": client_id,
        "code": code,
        "code_verifier": verifier,
        "redirect_uri": redirect_uri,
    });

    let resp = client
        .post(OPENAI_OAUTH_TOKEN_URL)
        .json(&payload)
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

/// Refresh an expired access token using the stored refresh token.
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

    let payload = serde_json::json!({
        "grant_type": "refresh_token",
        "client_id": client_id,
        "refresh_token": refresh_token,
    });

    let resp = client
        .post(OPENAI_OAUTH_TOKEN_URL)
        .json(&payload)
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

/// Path to `openai_auth.toml` in the JeikCode configuration directory.
pub fn openai_auth_file_path() -> std::path::PathBuf {
    Config::config_dir().join("openai_auth.toml")
}

/// Load stored OpenAI authentication data if present.
pub fn load_openai_auth() -> Option<OpenAiAuthInfo> {
    let path = openai_auth_file_path();
    if !path.exists() {
        return None;
    }
    let content = std::fs::read_to_string(&path).ok()?;
    toml::from_str(&content).ok()
}

/// Save OpenAI authentication data with 0600 permissions.
pub fn save_openai_auth(info: &OpenAiAuthInfo) -> Result<()> {
    let path = openai_auth_file_path();
    let content = toml::to_string_pretty(info).context("Failed to serialize OpenAI auth info")?;
    crate::write_auth_file_secure(&path, &content)
}

/// Obtain a valid OpenAI access token, refreshing if necessary.
pub fn get_valid_openai_token() -> Result<String> {
    let mut auth =
        load_openai_auth().context("Not logged in to ChatGPT/Codex — please authenticate first")?;

    if auth.is_expired() {
        auth = force_refresh_openai_token()?;
    }

    if auth.access_token.trim().is_empty() {
        anyhow::bail!("Invalid stored OpenAI credentials — please re-login");
    }

    Ok(auth.access_token)
}

/// Force a token refresh using the stored refresh token and persist the new credentials.
pub fn force_refresh_openai_token() -> Result<OpenAiAuthInfo> {
    let auth =
        load_openai_auth().context("Not logged in to ChatGPT/Codex — please authenticate first")?;
    let refresh_token = auth
        .refresh_token
        .as_deref()
        .context("No refresh token available for ChatGPT/Codex login")?;

    let refreshed = refresh_openai_token(refresh_token, None)?;
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let new_auth = OpenAiAuthInfo {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token.or(auth.refresh_token),
        token_type: refreshed
            .token_type
            .unwrap_or_else(|| auth.token_type.clone()),
        expires_in: refreshed.expires_in.or(auth.expires_in),
        created_at,
        account_id: auth.account_id,
    };

    save_openai_auth(&new_auth)?;
    Ok(new_auth)
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
    fn authorization_url_contains_pkce_params() {
        let pkce = PkceChallenge {
            verifier: "test_verifier".into(),
            challenge: "test_challenge".into(),
            method: "S256",
        };
        let url =
            build_authorization_url("http://127.0.0.1:8765/callback", &pkce, "state123", None);
        assert!(url.starts_with(OPENAI_OAUTH_AUTH_URL));
        assert!(url.contains("code_challenge=test_challenge"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=state123"));
        assert!(url.contains("client_id=pdlLIX2Y72MIl2rhLhTE9VV9bN905BpGuy"));
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
}
