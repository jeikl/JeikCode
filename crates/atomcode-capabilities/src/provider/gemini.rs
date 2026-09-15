//! Google Gemini native `generateContent` / `streamGenerateContent` adapter.
//!
//! Sibling of [`openai_compat`](super::openai_compat) and [`anthropic`](super::anthropic).
//! The kernel still speaks `Message` / `StreamEvent` / `ChatOptions`; this maps:
//!   - thinking text → [`StreamEvent::Reasoning`]
//!   - `thoughtSignature` → [`StreamEvent::ReasoningSignature`] (`provider = "gemini"`)
//!   - `thinkingConfig.thinkingLevel` / `thinkingBudget` / `includeThoughts` from
//!     `thinking_enabled` + `reasoning_effort` + `thinking_budget`
//!   - `usageMetadata` (incl. `thoughtsTokenCount` + cache) → [`StreamEvent::Usage`]
//!   - tools as `functionDeclarations` / `functionCall` / `functionResponse`

use super::openai_compat::{build_http_client, SwappableClient};
use super::reasoning::ReasoningPolicy;
use super::retry::{self, RetryPolicy};
use async_trait::async_trait;
use atomcode_kernel::message::{Message, Role};
use atomcode_kernel::provider::{ChatOptions, LlmProvider, ReasoningEffort, ToolChoice};
use atomcode_kernel::stream::{ProviderError, StreamEvent, TokenUsage};
use atomcode_kernel::tool::{ToolCall, ToolDef};
use futures::stream::BoxStream;
use futures::StreamExt;
use serde_json::{json, Map, Value};
use std::time::Duration;

const PROVIDER: &str = "gemini";
const DEFAULT_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";

#[derive(Clone)]
pub struct GeminiConfig {
    pub api_key: String,
    /// Host root (`https://generativelanguage.googleapis.com`) or versioned prefix
    /// (`…/v1beta`). A URL already containing `:streamGenerateContent` is used as-is.
    pub base_url: String,
    pub model: String,
    pub context_window: u32,
    pub max_tokens: Option<u32>,
    /// `Some(false)` forces thinking off (`thinkingBudget: 0` / `MINIMAL`).
    /// `None` follows the model heuristic (Gemini 2.5 / 3 think by default).
    pub thinking_enabled: Option<bool>,
    /// Explicit 2.5-style token budget. Ignored when thinking is off.
    pub thinking_budget: Option<u32>,
    pub reasoning_model: Option<bool>,
    pub reasoning_policy: Option<ReasoningPolicy>,
    pub idle_timeout: Duration,
    pub connect_timeout: Duration,
    pub retry: RetryPolicy,
    pub user_agent: Option<String>,
    pub skip_tls_verify: bool,
    pub supports_vision: bool,
}

impl GeminiConfig {
    pub fn new(
        api_key: impl Into<String>,
        base_url: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        let model = model.into();
        Self {
            api_key: api_key.into(),
            base_url: base_url.into(),
            model,
            context_window: 1_048_576,
            max_tokens: None,
            thinking_enabled: None,
            thinking_budget: None,
            reasoning_model: None,
            reasoning_policy: None,
            idle_timeout: Duration::from_secs(120),
            connect_timeout: Duration::from_secs(30),
            retry: RetryPolicy::default(),
            user_agent: None,
            skip_tls_verify: false,
            supports_vision: true,
        }
    }
}

pub struct GeminiProvider {
    cfg: GeminiConfig,
    policy: ReasoningPolicy,
    client: std::sync::Arc<SwappableClient>,
    url: String,
    session_id: std::sync::OnceLock<String>,
}

impl GeminiProvider {
    pub fn new(cfg: GeminiConfig) -> Result<Self, ProviderError> {
        let policy = cfg
            .reasoning_policy
            .or_else(|| {
                cfg.reasoning_model.map(|rm| {
                    if rm {
                        ReasoningPolicy::Include
                    } else {
                        ReasoningPolicy::Exclude
                    }
                })
            })
            .unwrap_or_else(|| ReasoningPolicy::derive(&cfg.model, &cfg.base_url));
        let connect_timeout = cfg.connect_timeout;
        let skip_tls_verify = cfg.skip_tls_verify;
        let user_agent = cfg.user_agent.clone();
        let url = stream_endpoint_url(&cfg.base_url, &cfg.model);
        let initial_tls12 = atomcode_config::tls::should_cap_url(&url);
        let client = std::sync::Arc::new(SwappableClient::new(initial_tls12, move |tls12| {
            build_http_client(connect_timeout, skip_tls_verify, user_agent.clone(), tls12)
        })?);
        Ok(Self {
            cfg,
            policy,
            client,
            url,
            session_id: std::sync::OnceLock::new(),
        })
    }
}

#[async_trait]
impl LlmProvider for GeminiProvider {
    fn model_name(&self) -> &str {
        &self.cfg.model
    }

    fn context_window(&self) -> u32 {
        self.cfg.context_window
    }

    fn bind_session_id(&self, session_id: &str) {
        let _ = self.session_id.set(session_id.to_string());
    }

    async fn chat_stream(
        &self,
        messages: &[Message],
        tools: &[ToolDef],
        options: &ChatOptions,
    ) -> Result<BoxStream<'static, StreamEvent>, ProviderError> {
        let body = build_request_body(&self.cfg, messages, tools, options, self.policy);
        super::wire_dump_request(&self.cfg.model, &body);
        let idle = self.cfg.idle_timeout;
        let policy = self.cfg.retry.clone();
        let client = self.client.clone();
        let url = self.url.clone();
        let api_key = self.cfg.api_key.clone();
        let session_id = self.session_id.get().cloned().unwrap_or_default();
        let rate_limit_retry_owner = options.rate_limit_retry_owner;

        let s = async_stream::stream! {
            const MAX_STREAM_ATTEMPTS: u32 = 2;
            let mut stream_attempt = 0u32;
            let mut reconnect_attempts = 0u32;
            let mut resp = match open_stream(
                &client.get(),
                &url,
                &body,
                &api_key,
                &session_id,
                &policy,
                rate_limit_retry_owner,
            ).await {
                Ok(r) => r,
                Err(e) => {
                    yield StreamEvent::Error(e);
                    return;
                }
            };

            'reopen: loop {
                let mut dec = GeminiSseDecoder::default();
                let mut emitted_replay_sensitive = false;
                let mut pending_metadata = Vec::new();
                let byte_stream = resp.bytes_stream();
                futures::pin_mut!(byte_stream);
                loop {
                    match tokio::time::timeout(idle, byte_stream.next()).await {
                        Err(_elapsed) => {
                            yield StreamEvent::Error(ProviderError {
                                retryable: false,
                                message: "stream idle timeout".to_string(),
                                ..Default::default()
                            });
                            return;
                        }
                        Ok(None) => {
                            for ev in dec.finish() {
                                if !emitted_replay_sensitive && retry::is_attempt_metadata_event(&ev) {
                                    pending_metadata.push(ev);
                                    continue;
                                }
                                if retry::is_replay_sensitive_event(&ev)
                                    || matches!(ev, StreamEvent::Done { .. } | StreamEvent::Error(_))
                                {
                                    for metadata in pending_metadata.drain(..) { yield metadata; }
                                }
                                emitted_replay_sensitive |= retry::is_replay_sensitive_event(&ev);
                                yield ev;
                            }
                            return;
                        }
                        Ok(Some(Err(e))) => {
                            if !emitted_replay_sensitive && stream_attempt < MAX_STREAM_ATTEMPTS {
                                reconnect_attempts += 1;
                                tokio::time::sleep(retry::compute_backoff(stream_attempt, &policy)).await;
                                if let Ok(fresh) = open_stream(
                                    &client.get(),
                                    &url,
                                    &body,
                                    &api_key,
                                    &session_id,
                                    &policy,
                                    rate_limit_retry_owner,
                                ).await {
                                    stream_attempt += 1;
                                    resp = fresh;
                                    continue 'reopen;
                                }
                            }
                            yield StreamEvent::Error(ProviderError {
                                retryable: false,
                                message: retry::stream_read_error_message(
                                    &e,
                                    if emitted_replay_sensitive {
                                        retry::StreamReadRecovery::PartialResponse
                                    } else {
                                        retry::StreamReadRecovery::RetryExhausted {
                                            attempts: reconnect_attempts,
                                        }
                                    },
                                ),
                                ..Default::default()
                            });
                            return;
                        }
                        Ok(Some(Ok(chunk))) => {
                            let mut saw_done = false;
                            for ev in dec.feed(chunk.as_ref()) {
                                if !emitted_replay_sensitive && retry::is_attempt_metadata_event(&ev) {
                                    pending_metadata.push(ev);
                                    continue;
                                }
                                if retry::is_replay_sensitive_event(&ev)
                                    || matches!(ev, StreamEvent::Done { .. } | StreamEvent::Error(_))
                                {
                                    for metadata in pending_metadata.drain(..) { yield metadata; }
                                }
                                emitted_replay_sensitive |= retry::is_replay_sensitive_event(&ev);
                                if matches!(ev, StreamEvent::Done { .. }) {
                                    saw_done = true;
                                }
                                yield ev;
                            }
                            if saw_done { return; }
                        }
                    }
                }
            }
        };
        Ok(s.boxed())
    }
}

async fn open_stream(
    client: &reqwest::Client,
    url: &str,
    body: &Value,
    api_key: &str,
    session_id: &str,
    policy: &RetryPolicy,
    rate_limit_retry_owner: atomcode_kernel::provider::RateLimitRetryOwner,
) -> Result<reqwest::Response, ProviderError> {
    let mut attempt = 1u32;
    loop {
        let mut req = client
            .post(url)
            .header("Content-Type", "application/json")
            .json(body);
        if !api_key.is_empty() {
            req = req.header("x-goog-api-key", api_key).bearer_auth(api_key);
        }
        if !session_id.is_empty() {
            req = req.header("x-jeikcode-session-id", session_id);
            req = req.header("x-session-id", session_id);
        }
        match req.send().await {
            Ok(resp) => {
                let code = resp.status().as_u16();
                if !resp.status().is_success() {
                    if retry::should_retry_open_status(code, rate_limit_retry_owner)
                        && attempt < policy.max_attempts
                    {
                        let wait = retry::parse_retry_after(resp.headers())
                            .unwrap_or_else(|| retry::compute_backoff(attempt, policy));
                        tokio::time::sleep(wait).await;
                        attempt += 1;
                        continue;
                    }
                    let retry_after_secs =
                        retry::parse_retry_after(resp.headers()).map(|d| d.as_secs());
                    let text = resp.text().await.unwrap_or_default();
                    let (detail, structured) = parse_gemini_error(&text);
                    return Err(ProviderError {
                        retryable: retry::is_retryable_status(code),
                        message: super::friendly_http_error(code, &detail),
                        http_status: Some(code),
                        code: structured,
                        retry_after_secs,
                    });
                }
                return Ok(resp);
            }
            Err(e) => {
                if retry::is_retryable_reqwest_error(&e) && attempt < policy.max_attempts {
                    tokio::time::sleep(retry::compute_backoff(attempt, policy)).await;
                    attempt += 1;
                    continue;
                }
                return Err(ProviderError {
                    retryable: retry::is_retryable_reqwest_error(&e),
                    message: format!("gemini request failed: {}", retry::err_chain(&e)),
                    ..Default::default()
                });
            }
        }
    }
}

fn parse_gemini_error(text: &str) -> (String, Option<String>) {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return (truncate_msg(text), None);
    };
    let err = v.get("error").unwrap_or(&v);
    let msg = err
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or(text)
        .trim();
    let code = err
        .get("status")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            err.get("code").and_then(|c| {
                c.as_str()
                    .map(str::to_string)
                    .or_else(|| c.as_i64().map(|n| n.to_string()))
            })
        });
    (truncate_msg(msg), code)
}

fn truncate_msg(s: &str) -> String {
    const MAX: usize = 800;
    if s.chars().count() <= MAX {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(MAX).collect::<String>())
    }
}

pub(crate) fn stream_endpoint_url(base_url: &str, model: &str) -> String {
    let base = normalize_gemini_base(base_url);
    let model = model.trim().strip_prefix("models/").unwrap_or(model.trim());
    if base.contains(":streamGenerateContent") || base.contains(":generateContent") {
        if base.contains("alt=sse") {
            return base;
        }
        return if base.contains('?') {
            format!("{base}&alt=sse")
        } else {
            format!("{base}?alt=sse")
        };
    }
    format!("{base}/models/{model}:streamGenerateContent?alt=sse")
}

fn normalize_gemini_base(base_url: &str) -> String {
    let b = base_url.trim().trim_end_matches('/');
    if b.is_empty() {
        return DEFAULT_BASE.to_string();
    }
    if b.contains("/models/") || b.ends_with("/v1beta") || b.ends_with("/v1") {
        return b.to_string();
    }
    format!("{b}/v1beta")
}

pub fn model_supports_thinking(model: &str) -> bool {
    atomcode_config::config::provider::gemini_defaults_thinking(model)
}

fn uses_thinking_level(model: &str) -> bool {
    atomcode_config::config::provider::gemini_uses_thinking_level(model)
}

fn thinking_is_on(cfg: &GeminiConfig, options: &ChatOptions) -> bool {
    if cfg.thinking_enabled == Some(false) {
        return false;
    }
    if options
        .reasoning_effort
        .as_ref()
        .map(|e| e.as_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("off") || s.eq_ignore_ascii_case("none"))
    {
        return false;
    }
    if cfg.thinking_enabled == Some(true) {
        return true;
    }
    if cfg.reasoning_model == Some(false) && options.reasoning_effort.is_none() {
        return false;
    }
    if cfg.reasoning_model == Some(true) || options.reasoning_effort.is_some() {
        return true;
    }
    model_supports_thinking(&cfg.model)
}

fn thinking_level_for(effort: &ReasoningEffort) -> &'static str {
    match effort {
        ReasoningEffort::Low => "LOW",
        ReasoningEffort::Medium => "MEDIUM",
        ReasoningEffort::High | ReasoningEffort::Max | ReasoningEffort::XHigh => "HIGH",
        ReasoningEffort::Custom(s) => match s.to_ascii_uppercase().as_str() {
            "MINIMAL" => "MINIMAL",
            "LOW" => "LOW",
            "MEDIUM" => "MEDIUM",
            "HIGH" | "MAX" | "XHIGH" => "HIGH",
            _ => "HIGH",
        },
    }
}

fn thinking_budget_for(cfg: &GeminiConfig, options: &ChatOptions) -> u32 {
    if let Some(b) = cfg.thinking_budget {
        return b;
    }
    match &options.reasoning_effort {
        Some(ReasoningEffort::Low) => 1024,
        Some(ReasoningEffort::Medium) => 4096,
        Some(ReasoningEffort::High | ReasoningEffort::Max | ReasoningEffort::XHigh) => 8192,
        Some(ReasoningEffort::Custom(s)) => s.parse().unwrap_or(8192),
        None => 8192,
    }
}

pub(crate) fn thinking_config_value(cfg: &GeminiConfig, options: &ChatOptions) -> Value {
    let mut obj = Map::new();
    if !thinking_is_on(cfg, options) {
        obj.insert("includeThoughts".into(), json!(false));
        if uses_thinking_level(&cfg.model) {
            obj.insert("thinkingLevel".into(), json!("MINIMAL"));
        } else {
            obj.insert("thinkingBudget".into(), json!(0));
        }
        return Value::Object(obj);
    }
    obj.insert("includeThoughts".into(), json!(true));
    if uses_thinking_level(&cfg.model) {
        let level = options
            .reasoning_effort
            .as_ref()
            .map(thinking_level_for)
            .unwrap_or("HIGH");
        obj.insert("thinkingLevel".into(), json!(level));
        if let Some(budget) = cfg.thinking_budget {
            obj.insert("thinkingBudget".into(), json!(budget));
        }
    } else {
        obj.insert(
            "thinkingBudget".into(),
            json!(thinking_budget_for(cfg, options)),
        );
    }
    Value::Object(obj)
}

fn build_request_body(
    cfg: &GeminiConfig,
    messages: &[Message],
    tools: &[ToolDef],
    options: &ChatOptions,
    policy: ReasoningPolicy,
) -> Value {
    let echo = matches!(policy, ReasoningPolicy::Include);
    let (system_blocks, contents) = format_contents(messages, echo, cfg.supports_vision);
    let mut body = Map::new();
    body.insert("contents".into(), json!(contents));
    if !system_blocks.is_empty() {
        let parts: Vec<Value> = system_blocks
            .into_iter()
            .map(|text| json!({ "text": text }))
            .collect();
        body.insert("systemInstruction".into(), json!({ "parts": parts }));
    }
    let mut gen = Map::new();
    if let Some(mt) = options.max_tokens.or(cfg.max_tokens) {
        gen.insert("maxOutputTokens".into(), json!(mt));
    }
    if let Some(t) = options.temperature {
        gen.insert("temperature".into(), json!(t));
    }
    if model_supports_thinking(&cfg.model)
        || cfg.thinking_enabled.is_some()
        || cfg.reasoning_model == Some(true)
        || options.reasoning_effort.is_some()
    {
        gen.insert("thinkingConfig".into(), thinking_config_value(cfg, options));
    }
    body.insert("generationConfig".into(), Value::Object(gen));

    if !tools.is_empty() {
        let decls: Vec<Value> = tools
            .iter()
            .map(|td| {
                json!({
                    "name": td.name,
                    "description": td.description,
                    "parameters": super::sanitize_schema_for_wire(&td.parameters),
                })
            })
            .collect();
        body.insert("tools".into(), json!([{ "functionDeclarations": decls }]));
        let mut fcc = Map::new();
        match &options.tool_choice {
            ToolChoice::None => {
                fcc.insert("mode".into(), json!("NONE"));
            }
            ToolChoice::Required => {
                fcc.insert("mode".into(), json!("ANY"));
            }
            ToolChoice::Specific(name) => {
                fcc.insert("mode".into(), json!("ANY"));
                fcc.insert("allowedFunctionNames".into(), json!([name]));
            }
            ToolChoice::Auto => {
                fcc.insert("mode".into(), json!("AUTO"));
            }
        }
        body.insert("toolConfig".into(), json!({ "functionCallingConfig": fcc }));
    }
    Value::Object(body)
}

fn format_contents(
    messages: &[Message],
    echo_thinking: bool,
    vision: bool,
) -> (Vec<String>, Vec<Value>) {
    let mut system_blocks = Vec::new();
    let mut contents = Vec::new();
    let mut i = 0;
    while i < messages.len() {
        let m = &messages[i];
        match m.role {
            Role::System => {
                if !m.text.trim().is_empty() {
                    system_blocks.push(m.text.clone());
                }
                i += 1;
            }
            Role::User => {
                contents.push(json!({
                    "role": "user",
                    "parts": user_parts(m, vision),
                }));
                i += 1;
            }
            Role::Assistant => {
                contents.push(json!({
                    "role": "model",
                    "parts": model_parts(m, echo_thinking),
                }));
                i += 1;
            }
            Role::Tool => {
                let mut parts = Vec::new();
                while i < messages.len() && messages[i].role == Role::Tool {
                    let name = tool_name_for(messages, i);
                    parts.push(function_response_part(&messages[i], &name));
                    i += 1;
                }
                contents.push(json!({ "role": "user", "parts": parts }));
            }
        }
    }
    (system_blocks, contents)
}

fn user_parts(m: &Message, vision: bool) -> Vec<Value> {
    let mut parts = Vec::new();
    if !m.text.is_empty() {
        parts.push(json!({ "text": m.text }));
    }
    if vision {
        for img in &m.images {
            if img.data.is_empty() {
                continue;
            }
            parts.push(json!({
                "inlineData": {
                    "mimeType": img.media_type,
                    "data": img.data,
                }
            }));
        }
    }
    if parts.is_empty() {
        parts.push(json!({ "text": "" }));
    }
    parts
}

fn model_parts(m: &Message, echo_thinking: bool) -> Vec<Value> {
    let mut parts = Vec::new();
    let mut leftover_sigs: Vec<String> = Vec::new();
    if echo_thinking {
        for b in m
            .reasoning_blocks
            .iter()
            .filter(|b| b.provider.as_deref() == Some(PROVIDER))
        {
            let opaque = b.opaque.clone().unwrap_or_default();
            if b.text.is_empty() {
                if !opaque.is_empty() {
                    leftover_sigs.push(opaque);
                }
                continue;
            }
            let mut part = Map::new();
            part.insert("text".into(), json!(b.text));
            part.insert("thought".into(), json!(true));
            if !opaque.is_empty() {
                part.insert("thoughtSignature".into(), json!(opaque));
            }
            parts.push(Value::Object(part));
        }
        if parts.is_empty() {
            if let Some(text) = m.reasoning.as_deref().filter(|s| !s.is_empty()) {
                parts.push(json!({ "text": text, "thought": true }));
            }
        }
    }
    if !m.text.is_empty() {
        parts.push(json!({ "text": m.text }));
    }
    let fallback_sig = echo_thinking
        .then(|| {
            m.reasoning_blocks
                .iter()
                .rev()
                .filter(|b| b.provider.as_deref() == Some(PROVIDER))
                .find_map(|b| b.opaque.clone().filter(|s| !s.is_empty()))
        })
        .flatten();
    for tc in &m.tool_calls {
        let args: Value = serde_json::from_str(tc.arguments.trim())
            .ok()
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        let mut part = Map::new();
        let mut fc = Map::new();
        fc.insert("name".into(), json!(tc.name));
        fc.insert("args".into(), args);
        if !tc.id.is_empty() {
            fc.insert("id".into(), json!(tc.id));
        }
        part.insert("functionCall".into(), Value::Object(fc));
        let sig = if leftover_sigs.is_empty() {
            fallback_sig.clone()
        } else {
            Some(leftover_sigs.remove(0))
        };
        if let Some(sig) = sig.filter(|s| !s.is_empty()) {
            part.insert("thoughtSignature".into(), json!(sig));
        }
        parts.push(Value::Object(part));
    }
    if parts.is_empty() {
        parts.push(json!({ "text": "" }));
    }
    parts
}

fn tool_name_for(messages: &[Message], idx: usize) -> String {
    let id = messages[idx].tool_call_id.as_deref().unwrap_or("");
    for m in messages[..idx].iter().rev() {
        if m.role == Role::Assistant {
            if let Some(tc) = m.tool_calls.iter().find(|tc| tc.id == id) {
                return tc.name.clone();
            }
        }
    }
    "unknown".into()
}

fn function_response_part(m: &Message, name: &str) -> Value {
    let response: Value = serde_json::from_str(m.text.trim())
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({ "result": m.text }));
    let mut fr = Map::new();
    fr.insert("name".into(), json!(name));
    fr.insert("response".into(), response);
    if let Some(id) = m.tool_call_id.as_deref().filter(|s| !s.is_empty()) {
        fr.insert("id".into(), json!(id));
    }
    json!({ "functionResponse": fr })
}

#[derive(Default)]
struct GeminiSseDecoder {
    buf: Vec<u8>,
    truncated: bool,
    done: bool,
    emitted_id: bool,
    emitted_model: bool,
    last_usage: Option<TokenUsage>,
    tool_index: u32,
}

impl GeminiSseDecoder {
    fn feed(&mut self, chunk: &[u8]) -> Vec<StreamEvent> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        loop {
            let Some(pos) = self.buf.iter().position(|&b| b == b'\n') else {
                break;
            };
            let mut line = self.buf.drain(..=pos).collect::<Vec<_>>();
            if line.last() == Some(&b'\n') {
                line.pop();
            }
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.is_empty() {
                continue;
            }
            let Ok(s) = std::str::from_utf8(&line) else {
                out.push(StreamEvent::Malformed);
                continue;
            };
            let s = s.trim();
            if s.is_empty() || s.starts_with(':') {
                continue;
            }
            let payload = s.strip_prefix("data:").map(str::trim).unwrap_or(s);
            if payload.is_empty() || payload == "[DONE]" {
                continue;
            }
            match serde_json::from_str::<Value>(payload) {
                Ok(v) => out.extend(self.ingest_chunk(&v)),
                Err(_) => out.push(StreamEvent::Malformed),
            }
        }
        out
    }

    fn ingest_chunk(&mut self, v: &Value) -> Vec<StreamEvent> {
        let mut out = Vec::new();
        if !self.emitted_id {
            if let Some(id) = v.get("responseId").and_then(Value::as_str) {
                self.emitted_id = true;
                out.push(StreamEvent::ResponseId(id.to_string()));
            }
        }
        if !self.emitted_model {
            if let Some(model) = v.get("modelVersion").and_then(Value::as_str) {
                self.emitted_model = true;
                out.push(StreamEvent::ResponseModel(model.to_string()));
            }
        }
        if let Some(err) = v.get("error") {
            let msg = err
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("gemini stream error");
            out.push(StreamEvent::Error(ProviderError {
                retryable: false,
                message: msg.to_string(),
                ..Default::default()
            }));
            self.done = true;
            return out;
        }
        if let Some(usage) = v.get("usageMetadata") {
            self.last_usage = Some(parse_usage(usage));
        }
        if let Some(cands) = v.get("candidates").and_then(Value::as_array) {
            if let Some(c) = cands.first() {
                if let Some(reason) = c.get("finishReason").and_then(Value::as_str) {
                    match reason {
                        "MAX_TOKENS" => self.truncated = true,
                        "SAFETY" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII" => {
                            out.push(StreamEvent::Error(ProviderError {
                                retryable: false,
                                message: format!("gemini blocked the response ({reason})"),
                                ..Default::default()
                            }));
                        }
                        _ => {}
                    }
                    if reason != "FINISH_REASON_UNSPECIFIED" && !reason.is_empty() {
                        self.done = true;
                    }
                }
                if let Some(parts) = c
                    .get("content")
                    .and_then(|content| content.get("parts"))
                    .and_then(Value::as_array)
                {
                    for part in parts {
                        out.extend(self.ingest_part(part));
                    }
                }
            }
        }
        if let Some(fb) = v.get("promptFeedback") {
            if let Some(reason) = fb.get("blockReason").and_then(Value::as_str) {
                if reason != "BLOCK_REASON_UNSPECIFIED" && !reason.is_empty() {
                    out.push(StreamEvent::Error(ProviderError {
                        retryable: false,
                        message: format!("gemini blocked the prompt ({reason})"),
                        ..Default::default()
                    }));
                    self.done = true;
                }
            }
        }
        out
    }

    fn ingest_part(&mut self, part: &Value) -> Vec<StreamEvent> {
        let mut out = Vec::new();
        let thought = part
            .get("thought")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let sig = part
            .get("thoughtSignature")
            .or_else(|| part.get("thought_signature"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            if !text.is_empty() {
                if thought {
                    out.push(StreamEvent::Reasoning(text.to_string()));
                } else {
                    out.push(StreamEvent::TextDelta(text.to_string()));
                }
            }
        }
        if let Some(fc) = part.get("functionCall") {
            let index = self.tool_index;
            self.tool_index += 1;
            let name = fc.get("name").and_then(Value::as_str).unwrap_or("unknown");
            let args = fc.get("args").cloned().unwrap_or_else(|| json!({}));
            let id = fc
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("gemini_call_{index}"));
            let arguments = if args.is_object() {
                args.to_string()
            } else {
                "{}".into()
            };
            out.push(StreamEvent::ToolCallDelta {
                index,
                id: Some(id.clone()),
                name: Some(name.to_string()),
                arguments: arguments.clone(),
            });
            out.push(StreamEvent::ToolCall(ToolCall {
                id,
                name: name.to_string(),
                arguments,
            }));
        }
        if let Some(opaque) = sig {
            out.push(StreamEvent::ReasoningSignature {
                opaque: opaque.to_string(),
                provider: PROVIDER.to_string(),
                id: None,
            });
        }
        out
    }

    fn finish(&mut self) -> Vec<StreamEvent> {
        let mut out = Vec::new();
        if let Some(u) = self.last_usage.take() {
            out.push(StreamEvent::Usage(u));
        }
        out.push(StreamEvent::Done {
            truncated: self.truncated,
        });
        out
    }
}

fn parse_usage(u: &Value) -> TokenUsage {
    let prompt = u
        .get("promptTokenCount")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    let candidates = u
        .get("candidatesTokenCount")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    let thoughts = u
        .get("thoughtsTokenCount")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    let cached = u
        .get("cachedContentTokenCount")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    TokenUsage {
        prompt,
        completion: candidates.saturating_add(thoughts),
        cached,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use atomcode_kernel::message::ReasoningBlock;

    fn cfg(model: &str) -> GeminiConfig {
        GeminiConfig::new("k", DEFAULT_BASE, model)
    }

    #[test]
    fn official_stream_url_appends_model_and_sse() {
        assert_eq!(
            stream_endpoint_url(DEFAULT_BASE, "gemini-2.5-flash"),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
        );
        assert_eq!(
            stream_endpoint_url("https://generativelanguage.googleapis.com", "gemini-3-flash"),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse"
        );
    }

    #[test]
    fn thinking_off_sends_budget_zero_on_2_5() {
        let mut c = cfg("gemini-2.5-flash");
        c.thinking_enabled = Some(false);
        let v = thinking_config_value(&c, &ChatOptions::default());
        assert_eq!(v["includeThoughts"], json!(false));
        assert_eq!(v["thinkingBudget"], json!(0));
        assert!(v.get("thinkingLevel").is_none());
    }

    #[test]
    fn thinking_off_sends_minimal_on_gemini_3() {
        let mut c = cfg("gemini-3.1-pro");
        c.thinking_enabled = Some(false);
        let v = thinking_config_value(&c, &ChatOptions::default());
        assert_eq!(v["thinkingLevel"], json!("MINIMAL"));
        assert_eq!(v["includeThoughts"], json!(false));
    }

    #[test]
    fn effort_maps_to_thinking_level_on_gemini_3() {
        let c = cfg("gemini-3-flash");
        let mut opts = ChatOptions::default();
        opts.reasoning_effort = Some(ReasoningEffort::Low);
        let v = thinking_config_value(&c, &opts);
        assert_eq!(v["thinkingLevel"], json!("LOW"));
        assert_eq!(v["includeThoughts"], json!(true));
    }

    #[test]
    fn effort_maps_to_budget_on_gemini_2_5() {
        let c = cfg("gemini-2.5-pro");
        let mut opts = ChatOptions::default();
        opts.reasoning_effort = Some(ReasoningEffort::High);
        let v = thinking_config_value(&c, &opts);
        assert_eq!(v["thinkingBudget"], json!(8192));
        assert_eq!(v["includeThoughts"], json!(true));
    }

    #[test]
    fn body_includes_system_tools_and_thought_roundtrip() {
        let c = cfg("gemini-3-flash");
        let mut assistant = Message::assistant(
            "ok",
            vec![ToolCall {
                id: "c1".into(),
                name: "read_file".into(),
                arguments: r#"{"path":"a.rs"}"#.into(),
            }],
        );
        assistant.reasoning_blocks = vec![ReasoningBlock {
            text: "plan".into(),
            opaque: Some("sig-1".into()),
            provider: Some(PROVIDER.into()),
            id: None,
        }];
        let msgs = vec![
            Message::system("be concise"),
            Message::user("hi"),
            assistant,
            Message::tool_result("c1", r#"{"ok":true}"#, false),
        ];
        let tools = vec![ToolDef {
            name: "read_file".into(),
            description: "read".into(),
            parameters: json!({"type":"object"}),
        }];
        let body = build_request_body(
            &c,
            &msgs,
            &tools,
            &ChatOptions::default(),
            ReasoningPolicy::Include,
        );
        assert_eq!(
            body["systemInstruction"]["parts"][0]["text"],
            json!("be concise")
        );
        let contents = body["contents"].as_array().unwrap();
        assert_eq!(contents[1]["role"], json!("model"));
        assert_eq!(contents[1]["parts"][0]["thought"], json!(true));
        assert_eq!(contents[1]["parts"][0]["thoughtSignature"], json!("sig-1"));
        assert_eq!(contents[1]["parts"][1]["text"], json!("ok"));
        assert_eq!(
            contents[1]["parts"][2]["functionCall"]["name"],
            json!("read_file")
        );
        assert_eq!(contents[1]["parts"][2]["thoughtSignature"], json!("sig-1"));
        assert_eq!(contents[2]["role"], json!("user"));
        assert_eq!(
            contents[2]["parts"][0]["functionResponse"]["name"],
            json!("read_file")
        );
        assert_eq!(
            body["tools"][0]["functionDeclarations"][0]["name"],
            json!("read_file")
        );
    }

    #[test]
    fn system_messages_stay_as_separate_parts_and_project_instructions_stay_in_contents() {
        let c = cfg("gemini-3-flash");
        let msgs = vec![
            Message::system("<environment>env</environment>"),
            Message::system("<workflow_and_execution_discipline>wf</workflow_and_execution_discipline>"),
            Message::user("=== AUTHORITATIVE PROJECT INSTRUCTIONS & KNOWLEDGE (*.md) ===\nagents"),
            Message::user("hello"),
        ];
        let body = build_request_body(
            &c,
            &msgs,
            &[],
            &ChatOptions::default(),
            ReasoningPolicy::Exclude,
        );
        let parts = body["systemInstruction"]["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["text"], json!("<environment>env</environment>"));
        assert_eq!(
            parts[1]["text"],
            json!("<workflow_and_execution_discipline>wf</workflow_and_execution_discipline>")
        );

        let contents = body["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 2);
        assert_eq!(contents[0]["role"], json!("user"));
        assert!(contents[0]["parts"][0]["text"]
            .as_str()
            .unwrap()
            .contains("AUTHORITATIVE PROJECT INSTRUCTIONS"));
        assert_eq!(contents[1]["parts"][0]["text"], json!("hello"));
    }

    #[test]
    fn decoder_emits_thought_text_signature_usage_and_done() {
        let mut d = GeminiSseDecoder::default();
        let chunk = concat!(
            "data: {\"responseId\":\"r1\",\"modelVersion\":\"gemini-2.5-flash\",",
            "\"candidates\":[{\"content\":{\"parts\":[",
            "{\"text\":\"hmm\",\"thought\":true,\"thoughtSignature\":\"abc\"},",
            "{\"text\":\"hi\"},",
            "{\"functionCall\":{\"name\":\"echo\",\"args\":{\"x\":1}}}",
            "]}}],",
            "\"usageMetadata\":{\"promptTokenCount\":10,\"candidatesTokenCount\":3,",
            "\"thoughtsTokenCount\":7,\"cachedContentTokenCount\":2}}\n"
        );
        let ev = d.feed(chunk.as_bytes());
        assert!(ev
            .iter()
            .any(|e| matches!(e, StreamEvent::ResponseId(id) if id == "r1")));
        assert!(ev
            .iter()
            .any(|e| matches!(e, StreamEvent::Reasoning(t) if t == "hmm")));
        assert!(ev.iter().any(|e| matches!(
            e,
            StreamEvent::ReasoningSignature { opaque, provider, .. }
                if opaque == "abc" && provider == "gemini"
        )));
        assert!(ev
            .iter()
            .any(|e| matches!(e, StreamEvent::TextDelta(t) if t == "hi")));
        assert!(ev.iter().any(|e| matches!(
            e,
            StreamEvent::ToolCall(tc) if tc.name == "echo" && tc.arguments.contains("\"x\":1")
        )));
        let rest = d.finish();
        assert!(rest.iter().any(|e| matches!(
            e,
            StreamEvent::Usage(u) if u.prompt == 10 && u.completion == 10 && u.cached == 2
        )));
        assert!(rest
            .iter()
            .any(|e| matches!(e, StreamEvent::Done { truncated: false })));
    }

    #[test]
    fn gemini_3_plus_defaults_thinking_level_on() {
        for model in ["gemini-3-flash", "gemini-3.8-flash", "gemini-4-pro"] {
            let c = cfg(model);
            let v = thinking_config_value(&c, &ChatOptions::default());
            assert_eq!(v["includeThoughts"], json!(true), "{model}");
            assert_eq!(v["thinkingLevel"], json!("HIGH"), "{model}");
            assert!(v.get("thinkingBudget").is_none(), "{model}");
        }
    }

    #[test]
    fn non_thinking_models_omit_thinking_config() {
        let c = cfg("gemini-2.0-flash");
        let body = build_request_body(
            &c,
            &[Message::user("hi")],
            &[],
            &ChatOptions::default(),
            ReasoningPolicy::Exclude,
        );
        assert!(body["generationConfig"].get("thinkingConfig").is_none());
    }

    #[test]
    fn reasoning_model_false_turns_thinking_off() {
        let mut c = cfg("gemini-2.5-flash");
        c.reasoning_model = Some(false);
        let v = thinking_config_value(&c, &ChatOptions::default());
        assert_eq!(v["includeThoughts"], json!(false));
        assert_eq!(v["thinkingBudget"], json!(0));
    }

    #[test]
    fn empty_thought_signatures_attach_fifo_to_function_calls() {
        let mut assistant = Message::assistant(
            "ok",
            vec![
                ToolCall {
                    id: "a".into(),
                    name: "t1".into(),
                    arguments: "{}".into(),
                },
                ToolCall {
                    id: "b".into(),
                    name: "t2".into(),
                    arguments: "{}".into(),
                },
            ],
        );
        assistant.reasoning_blocks = vec![
            ReasoningBlock {
                text: String::new(),
                opaque: Some("sig-a".into()),
                provider: Some(PROVIDER.into()),
                id: None,
            },
            ReasoningBlock {
                text: String::new(),
                opaque: Some("sig-b".into()),
                provider: Some(PROVIDER.into()),
                id: None,
            },
        ];
        let (_sys, contents) = format_contents(&[assistant], true, false);
        let parts = contents[0]["parts"].as_array().unwrap();
        assert_eq!(parts[1]["thoughtSignature"], json!("sig-a"));
        assert_eq!(parts[2]["thoughtSignature"], json!("sig-b"));
    }

    #[test]
    fn decoder_marks_max_tokens_truncated() {
        let mut d = GeminiSseDecoder::default();
        let chunk = concat!(
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hi\"}]},",
            "\"finishReason\":\"MAX_TOKENS\"}]}\n"
        );
        let _ = d.feed(chunk.as_bytes());
        let rest = d.finish();
        assert!(rest
            .iter()
            .any(|e| matches!(e, StreamEvent::Done { truncated: true })));
    }
}
