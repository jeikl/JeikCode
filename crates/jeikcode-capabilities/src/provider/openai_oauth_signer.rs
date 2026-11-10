//! RequestSigner implementation for ChatGPT Plus / Codex OAuth tokens.

use super::sign::{RequestSigner, RequestSigningError, SignedAuth};
use async_trait::async_trait;

#[derive(Debug, Default, Clone)]
pub struct OpenAiOAuthSigner;

impl OpenAiOAuthSigner {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl RequestSigner for OpenAiOAuthSigner {
    fn sign(&self, _body: &[u8]) -> Result<SignedAuth, RequestSigningError> {
        let auth = jeikcode_auth::openai_oauth::get_valid_openai_auth()
            .map_err(|e| RequestSigningError::CredentialsUnavailable(e.to_string()))?;

        let account_id = auth.account_id.clone().or_else(|| {
            jeikcode_auth::openai_oauth::extract_chatgpt_account_id_from_jwt(&auth.access_token)
        });

        let mut headers = vec![
            (
                "OpenAI-Beta".to_string(),
                "responses=experimental".to_string(),
            ),
            ("originator".to_string(), "codex_cli".to_string()),
            ("Accept".to_string(), "text/event-stream".to_string()),
        ];

        if let Some(ref acc_id) = account_id {
            headers.push(("chatgpt-account-id".to_string(), acc_id.clone()));
        }

        Ok(SignedAuth {
            bearer: Some(auth.access_token),
            headers,
            account_id,
        })
    }

    async fn recover_unauthorized(
        &self,
        rejected: &SignedAuth,
    ) -> Result<bool, RequestSigningError> {
        let rejected_token = rejected.bearer.clone().unwrap_or_default();
        let expected_account_id = rejected.account_id.clone();

        tokio::task::spawn_blocking(move || {
            jeikcode_auth::openai_oauth::refresh_openai_auth_if_current(
                &rejected_token,
                expected_account_id.as_deref(),
            )
        })
        .await
        .map_err(|e| RequestSigningError::RecoveryTransient(e.to_string()))?
        .map_err(|e| {
            let msg = e.to_string();
            let lower = msg.to_lowercase();
            if lower.contains("timed out")
                || lower.contains("timeout")
                || lower.contains("connection")
                || lower.contains("connect")
                || lower.contains("502")
                || lower.contains("503")
                || lower.contains("504")
                || lower.contains("network")
            {
                RequestSigningError::RecoveryTransient(msg)
            } else {
                RequestSigningError::ReauthenticationRequired(msg)
            }
        })?;

        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signer_constructs() {
        let signer = OpenAiOAuthSigner::new();
        let _arc_signer: std::sync::Arc<dyn RequestSigner> = std::sync::Arc::new(signer);
    }

    #[test]
    fn signer_header_population_with_stored_auth() {
        let _home = jeikcode_config::test_util::isolated_home();

        let auth_info = jeikcode_auth::OpenAiAuthInfo {
            access_token: "test-token-123".to_string(),
            refresh_token: Some("test-refresh-456".to_string()),
            token_type: "Bearer".to_string(),
            expires_in: Some(3600),
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64,
            account_id: Some("org-acct-test".to_string()),
        };
        jeikcode_auth::save_openai_auth(&auth_info).unwrap();

        let signer = OpenAiOAuthSigner::new();
        let signed = signer.sign(b"{}").unwrap();
        assert_eq!(signed.bearer.as_deref(), Some("test-token-123"));
        assert_eq!(signed.account_id.as_deref(), Some("org-acct-test"));
        assert!(signed.headers.contains(&(
            "OpenAI-Beta".to_string(),
            "responses=experimental".to_string()
        )));
        assert!(signed
            .headers
            .contains(&("originator".to_string(), "codex_cli".to_string())));
        assert!(signed
            .headers
            .contains(&("Accept".to_string(), "text/event-stream".to_string())));
        assert!(signed.headers.contains(&(
            "chatgpt-account-id".to_string(),
            "org-acct-test".to_string()
        )));

        let _ = jeikcode_auth::logout_openai();
    }
}
