//! AtomGit LLM gateway identification stubs (CodingPlan signing retired).

use thiserror::Error;

pub trait RequestSigner: Send + Sync {
    fn sign(&self, req: SignInput<'_>) -> Result<SignOutput, SignError>;
    fn algorithm_version(&self) -> u8;
}

pub struct SignInput<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub body: &'a [u8],
    pub oauth_token: &'a str,
    pub user_id: &'a str,
    pub timestamp_unix: u64,
    pub nonce: [u8; 16],
}

#[derive(Debug)]
pub struct SignOutput {
    pub headers: Vec<(&'static str, String)>,
}

#[derive(Debug, Error)]
pub enum SignError {
    #[error("signer unavailable in this build")]
    Unavailable,
    #[error("signing-key derivation failed: {0}")]
    Derive(String),
}

pub struct UnavailableSigner;

impl RequestSigner for UnavailableSigner {
    fn sign(&self, _req: SignInput<'_>) -> Result<SignOutput, SignError> {
        Err(SignError::Unavailable)
    }

    fn algorithm_version(&self) -> u8 {
        0
    }
}

static UNAVAILABLE_SIGNER: UnavailableSigner = UnavailableSigner;

pub fn signer() -> &'static dyn RequestSigner {
    &UNAVAILABLE_SIGNER
}

pub fn signer_available() -> bool {
    false
}

pub fn is_atomgit_gateway(_base_url: &str) -> bool {
    false
}

pub fn canonical_chat_completions_path(base_url: &str) -> String {
    let path = url::Url::parse(base_url)
        .ok()
        .map(|url| url.path().to_string())
        .unwrap_or_else(|| "/v1/chat/completions".to_string());
    if path.ends_with("/chat/completions") {
        path
    } else {
        format!("{}/chat/completions", path.trim_end_matches('/'))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_signer_is_explicit() {
        let error = UnavailableSigner
            .sign(SignInput {
                method: "POST",
                path: "/v1/chat/completions",
                body: b"{}",
                oauth_token: "token",
                user_id: "user",
                timestamp_unix: 1,
                nonce: [0; 16],
            })
            .expect_err("source signer must fail");
        assert!(matches!(error, SignError::Unavailable));
        assert_eq!(UnavailableSigner.algorithm_version(), 0);
    }

    #[test]
    fn gateway_matching_is_disabled() {
        for url in [
            "",
            "https://api-ai.gitcode.com/v1",
            "https://api.openai.com/v1",
        ] {
            assert!(!is_atomgit_gateway(url), "gateway signing is retired: {url}");
        }
    }

    #[test]
    fn source_build_reports_signer_unavailable() {
        assert!(!signer_available());
    }
}
