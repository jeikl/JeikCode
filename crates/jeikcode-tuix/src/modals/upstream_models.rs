//! Upstream model catalog for the `/provider` / `/modeladd` form.
//!
//! Hits the official list endpoint for each of the three chat protocols
//! (OpenAI Chat Completions, OpenAI Responses, Anthropic Messages) plus Ollama.
//! A failed request yields an empty list so the user can still type a model id.

use std::time::Duration;

/// Connection facts needed to list models on an account.
#[derive(Clone, Debug)]
pub struct UpstreamListSpec {
    /// Wire protocol: `openai` / `responses` / `anthropic` / `claude` / `gemini` / `ollama`.
    pub protocol: String,
    pub base_url: String,
    pub api_key: String,
    pub skip_tls_verify: bool,
}

/// Build the catalog URL for `protocol` at `base_url`.
///
/// OpenAI / Responses: `{base}/v1/models` (or `{base}/models` when base already ends in `/v1`).
/// Anthropic: the same path, but hosts without `/v1` get `/v1/models`.
/// Gemini: `{base}/models` when base already has `/v1beta` or `/v1`, else `{base}/v1beta/models`.
/// Ollama: `{origin}/api/tags`.
pub fn models_endpoint(protocol: &str, base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let p = protocol.to_ascii_lowercase();
    if p == "ollama" {
        let origin = base
            .strip_suffix("/v1")
            .unwrap_or(base)
            .trim_end_matches('/');
        return format!("{origin}/api/tags");
    }
    if p == "gemini" || p == "google-gemini" || p == "gemini-compatible" {
        if base.ends_with("/v1beta") || base.ends_with("/v1") {
            return format!("{base}/models");
        }
        return format!("{base}/v1beta/models");
    }
    if base.ends_with("/v1") {
        format!("{base}/models")
    } else {
        format!("{base}/v1/models")
    }
}

/// Parse OpenAI `{data:[{id}]}`, Anthropic `{data:[{id}]}`, or Ollama `{models:[{name}]}`.
pub fn parse_model_ids(body: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    if let Some(arr) = value.get("data").and_then(|d| d.as_array()) {
        for item in arr {
            if let Some(id) = item.get("id").and_then(|x| x.as_str()) {
                if !id.is_empty() {
                    ids.push(normalize_listed_model_id(id));
                }
            } else if let Some(id) = item.as_str() {
                if !id.is_empty() {
                    ids.push(normalize_listed_model_id(id));
                }
            }
        }
    }
    if ids.is_empty() {
        if let Some(arr) = value.get("models").and_then(|d| d.as_array()) {
            for item in arr {
                let id = item
                    .get("id")
                    .and_then(|x| x.as_str())
                    .or_else(|| item.get("name").and_then(|x| x.as_str()))
                    .or_else(|| item.get("model").and_then(|x| x.as_str()));
                if let Some(id) = id.filter(|s| !s.is_empty()) {
                    ids.push(normalize_listed_model_id(id));
                }
            }
        }
    }
    ids.sort();
    ids.dedup();
    ids
}

fn normalize_listed_model_id(id: &str) -> String {
    id.strip_prefix("models/").unwrap_or(id).to_string()
}

/// GET the catalog. Any transport/HTTP/parse failure is `Err` — callers empty the list.
pub async fn fetch_upstream_model_ids(spec: UpstreamListSpec) -> Result<Vec<String>, String> {
    if spec.base_url.trim().is_empty() {
        return Err("no base_url".into());
    }
    let url = models_endpoint(&spec.protocol, &spec.base_url);
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .connect_timeout(Duration::from_secs(5));
    if spec.skip_tls_verify {
        builder = builder.danger_accept_invalid_certs(true);
    }
    let client = builder.build().map_err(|e| e.to_string())?;
    let mut req = client.get(&url);
    let protocol = spec.protocol.to_ascii_lowercase();
    if protocol == "anthropic" || protocol == "claude" {
        if !spec.api_key.is_empty() {
            req = req
                .header("x-api-key", spec.api_key.as_str())
                .header("anthropic-version", "2023-06-01");
        }
    } else if protocol == "gemini" || protocol == "google-gemini" || protocol == "gemini-compatible"
    {
        if !spec.api_key.is_empty() {
            req = req
                .header("x-goog-api-key", spec.api_key.as_str())
                .bearer_auth(&spec.api_key);
        }
    } else if !spec.api_key.is_empty() {
        req = req.bearer_auth(&spec.api_key);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(parse_model_ids(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_and_responses_use_v1_models() {
        assert_eq!(
            models_endpoint("openai", "https://api.openai.com/v1"),
            "https://api.openai.com/v1/models"
        );
        assert_eq!(
            models_endpoint("responses", "http://127.0.0.1:8000/v1"),
            "http://127.0.0.1:8000/v1/models"
        );
        assert_eq!(
            models_endpoint("openai-compatible", "https://gw.example/v1/"),
            "https://gw.example/v1/models"
        );
    }

    #[test]
    fn anthropic_adds_v1_when_host_has_none() {
        assert_eq!(
            models_endpoint("anthropic", "https://api.anthropic.com"),
            "https://api.anthropic.com/v1/models"
        );
        assert_eq!(
            models_endpoint("claude", "https://api.anthropic.com/v1"),
            "https://api.anthropic.com/v1/models"
        );
    }

    #[test]
    fn ollama_uses_api_tags() {
        assert_eq!(
            models_endpoint("ollama", "http://127.0.0.1:11434"),
            "http://127.0.0.1:11434/api/tags"
        );
        assert_eq!(
            models_endpoint("ollama", "http://127.0.0.1:11434/v1"),
            "http://127.0.0.1:11434/api/tags"
        );
    }

    #[test]
    fn gemini_lists_v1beta_models() {
        assert_eq!(
            models_endpoint("gemini", "https://generativelanguage.googleapis.com/v1beta"),
            "https://generativelanguage.googleapis.com/v1beta/models"
        );
        assert_eq!(
            models_endpoint(
                "gemini-compatible",
                "https://generativelanguage.googleapis.com"
            ),
            "https://generativelanguage.googleapis.com/v1beta/models"
        );
    }

    #[test]
    fn parse_gemini_models_strips_prefix() {
        let body =
            r#"{"models":[{"name":"models/gemini-2.5-flash"},{"name":"models/gemini-3-pro"}]}"#;
        assert_eq!(
            parse_model_ids(body),
            vec!["gemini-2.5-flash".to_string(), "gemini-3-pro".to_string()]
        );
    }

    #[test]
    fn parse_openai_data_ids() {
        let body =
            r#"{"object":"list","data":[{"id":"grok-4.6"},{"id":"grok-4.5"},{"id":"grok-4.6"}]}"#;
        assert_eq!(
            parse_model_ids(body),
            vec!["grok-4.5".to_string(), "grok-4.6".to_string()]
        );
    }

    #[test]
    fn parse_anthropic_data_ids() {
        let body = r#"{"data":[{"id":"claude-sonnet-4-6","type":"model"}]}"#;
        assert_eq!(parse_model_ids(body), vec!["claude-sonnet-4-6".to_string()]);
    }

    #[test]
    fn parse_ollama_names() {
        let body = r#"{"models":[{"name":"llama3:8b","size":1},{"name":"qwen2:7b"}]}"#;
        assert_eq!(
            parse_model_ids(body),
            vec!["llama3:8b".to_string(), "qwen2:7b".to_string()]
        );
    }

    #[test]
    fn parse_garbage_is_empty() {
        assert!(parse_model_ids("not-json").is_empty());
        assert!(parse_model_ids("{}").is_empty());
    }
}
