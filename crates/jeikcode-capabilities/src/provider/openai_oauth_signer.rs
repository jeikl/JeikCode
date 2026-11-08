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
        let token = jeikcode_auth::openai_oauth::get_valid_openai_token()
            .map_err(|e| RequestSigningError::CredentialsUnavailable(e.to_string()))?;
        Ok(SignedAuth {
            bearer: Some(token),
            headers: Vec::new(),
            account_id: None,
        })
    }

    async fn recover_unauthorized(
        &self,
        _rejected: &SignedAuth,
    ) -> Result<bool, RequestSigningError> {
        jeikcode_auth::openai_oauth::force_refresh_openai_token()
            .map_err(|e| RequestSigningError::ReauthenticationRequired(e.to_string()))?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signer_constructs() {
        let signer = OpenAiOAuthSigner::new();
        // Verifies trait object construction
        let _arc_signer: std::sync::Arc<dyn RequestSigner> = std::sync::Arc::new(signer);
    }
}
