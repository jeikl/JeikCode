//! Real `LlmProvider` adapters (L1).
//!
//! The kernel's [`LlmProvider`](jeikcode_kernel::provider::LlmProvider) trait is the
//! seam; these types implement it against real backends. Five adapters live here:
//!   - [`OpenAiCompatProvider`] — the **OpenAI-compatible** chat/completions surface
//!     (GLM / DeepSeek / any OpenAI-shaped endpoint);
//!   - [`ResponsesProvider`] — the **OpenAI Responses API** (`/v1/responses`), including
//!     native `function_call` items and `reasoning.encrypted_content` round-trip;
//!   - [`AnthropicProvider`] — the **Anthropic Messages API** (`/v1/messages`, Claude),
//!     including the signed extended-thinking round-trip;
//!   - [`GeminiProvider`] — the **Google Gemini** `generateContent` /
//!     `streamGenerateContent` surface (`thoughtSignature` + `thinkingConfig`);
//!   - [`OllamaProvider`] — the **Ollama native** `/api/chat` (local models, NDJSON).
//!
//! Division of labour (mechanism vs policy):
//!   - the kernel owns the *mechanism* — neutral `Message`/`StreamEvent`/`ChatOptions`
//!     and lossless `reasoning` storage;
//!   - this adapter owns the *policy* — how each neutral knob maps onto the wire, how
//!     SSE deltas assemble into whole `ToolCall`s, and whether prior-turn reasoning is
//!     echoed back ([`ReasoningPolicy`]).

mod anthropic;
mod gemini;
mod ollama;
mod openai_compat;
mod pricing_catalog;
mod reasoning;
mod responses;
mod retry;
mod sign;
mod timeouts;

pub use anthropic::{AnthropicConfig, AnthropicProvider};
pub fn signer_available() -> bool {
    false
}
pub fn is_jeikcode_gateway(_base_url: &str) -> bool {
    false
}

/// Attach the product's OWN brand session headers to an outgoing provider request.
///
/// One definition shared by EVERY transport (openai-compatible, responses,
/// anthropic, gemini, ollama): a gateway pins/reuses a conversation by this id,
/// so a probe must send the same headers a real chat does. Keeping it in one
/// place means a new protocol can never silently drop the session header, and
/// only the product's own brand is advertised. Empty id ⇒ omitted (sub-agent /
/// summary calls without a conversation).
pub(crate) fn apply_session_affinity(
    req: reqwest::RequestBuilder,
    session_id: &str,
) -> reqwest::RequestBuilder {
    if session_id.is_empty() {
        return req;
    }
    req.header("x-jeikcode-session-id", session_id)
        .header("x-session-id", session_id)
}
pub use gemini::{model_supports_thinking, GeminiConfig, GeminiProvider};
pub use ollama::{OllamaConfig, OllamaProvider};
pub use openai_compat::{
    effort_control_applicable, model_suggests_vision, reason_effort_applicable,
    resolve_wire_effort, OpenAiCompatConfig, OpenAiCompatProvider,
};
pub use pricing_catalog::{
    ensure_models_dev_catalog, resolve_models_dev_pricing, spawn_models_dev_catalog_refresh,
    CatalogPricing,
};
pub use reasoning::{ReasoningPolicy, REASONING_PLACEHOLDER};
pub use responses::{ResponsesConfig, ResponsesProvider};
pub use retry::RetryPolicy;
pub use sign::{RequestSigner, RequestSigningError, SignedAuth};
pub use timeouts::ApplyTimeouts;

use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};

/// Fallback User-Agent when a provider config carries no explicit `user_agent`.
/// Bare (no version) on purpose: this crate is versioned independently of the
/// product (`0.0.0`), so a local `CARGO_PKG_VERSION` would be MISLEADING. The
/// host adapter injects the real `jeikcode/<version>` via `*Config::user_agent`;
/// this fallback only applies to direct/test construction.
pub(crate) const DEFAULT_USER_AGENT: &str = "jeikcode";

/// Process-local sequence so dumps sort in call order even when two land in the same
/// nanosecond (the timestamp alone isn't a tiebreaker under concurrency).
static WIRE_DUMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// BYTE-LEVEL outbound-request dump for wire diagnosis. No-op unless `JEIKCODE_WIRE_DUMP=1`.
/// Writes the EXACT JSON body an adapter built (post-projection, pre-send) to
/// `<config_dir>/wire-dump/<seq>-<ts>-<model>.req.json`. Best-effort: any failure (env unset,
/// unwritable dir) is silently ignored so diagnostics never break a real request.
///
/// This is the ADAPTER-level, provider-SPECIFIC counterpart to the neutral
/// [`WireLogHooks`](crate::hooks::WireLogHooks) (which logs the kernel `Message` view, not
/// these bytes). The kernel has NO byte seam by design — byte framing is intrinsically the
/// adapter's concern (each backend's JSON differs), so every adapter routes its built body
/// through here. Ported from core's v1 `JEIKCODE_WIRE_DUMP` (same env + `wire-dump/` dir),
/// but `config_dir()` honors `$JEIKCODE_HOME` (v1 used `$HOME`).
pub(crate) fn wire_dump_request(model: &str, body: &Value) {
    if std::env::var("JEIKCODE_WIRE_DUMP").ok().as_deref() != Some("1") {
        return;
    }
    wire_dump_to(&crate::paths::config_dir().join("wire-dump"), model, body);
}

/// The pure writer behind [`wire_dump_request`] — `dir`-injected so it's testable without
/// mutating the process-global `$JEIKCODE_HOME`/`$JEIKCODE_WIRE_DUMP`. Best-effort.
fn wire_dump_to(dir: &std::path::Path, model: &str, body: &Value) {
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| format!("{}.{:09}", d.as_secs(), d.subsec_nanos()))
        .unwrap_or_default();
    let seq = WIRE_DUMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let safe_model: String = model
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let path = dir.join(format!("{seq:06}-{ts}-{safe_model}.req.json"));
    if let Ok(s) = serde_json::to_string_pretty(body) {
        let _ = std::fs::write(&path, s);
    }
}

/// Push a `system` wire message, COALESCING it into the previous wire entry when that is
/// also a `system` message (joined with a blank line).
///
/// The kernel's neutral history can carry SEVERAL `Role::System` messages (persona +
/// `memory.md` + any future capability), but many OpenAI-compatible models / chat
/// templates accept only a SINGLE system message — extra ones are rejected outright or
/// silently honor just the first (dropping memory). Both `role:"system"`-on-the-wire
/// adapters (OpenAI-compatible and Ollama) route their `Role::System` arm through here so
/// a model never sees more than one. (The Anthropic adapter instead lifts+joins all System
/// messages into the top-level `system` field — same guarantee, different wire shape.)
///
/// Coalescing is over CONSECUTIVE system entries only; in practice every System message is
/// leading and contiguous, so this yields exactly one leading system block. It is pure and
/// deterministic, so the outgoing prefix stays byte-stable across rounds (cache-safe).
pub(crate) fn push_system_coalesced(out: &mut Vec<Value>, text: &str) {
    if let Some(last) = out.last_mut() {
        if last.get("role").and_then(Value::as_str) == Some("system") {
            let prev = last.get("content").and_then(Value::as_str).unwrap_or("");
            let joined = if prev.is_empty() || text.is_empty() {
                format!("{prev}{text}")
            } else {
                format!("{prev}\n\n{text}")
            };
            last["content"] = json!(joined);
            return;
        }
    }
    out.push(json!({ "role": "system", "content": text }));
}

/// Strips the unified-diff section from successful file modification tool results
/// before projecting them into the model context layer.
///
/// This maintains clean context separation:
/// - Presentation layer (TUI, WebUI, display log) retains the full diff for user inspection.
/// - Model context layer receives only the concise success acknowledgement, preventing
///   diff-marker context degradation, token bloating, and prompt-cache invalidation.
pub(crate) fn strip_tool_result_diff_for_model(text: &str) -> std::borrow::Cow<'_, str> {
    // Only strip if it looks like a successful file edit/write result
    let is_edit_success = (text.contains("has been updated successfully")
        || text.contains("has been created")
        || text.contains("Edited ")
        || text.contains("Created ")
        || text.contains("Overwrote "))
        && !text.contains("failed")
        && !text.contains("error:")
        && !text.contains("Error:");

    if !is_edit_success {
        return std::borrow::Cow::Borrowed(text);
    }

    // Look for unified diff start markers
    let diff_markers = ["\n--- a/", "\n--- ", "\n@@ -", "\ndiff --git "];
    let mut cut_idx = None;
    for marker in &diff_markers {
        if let Some(idx) = text.find(marker) {
            cut_idx = Some(cut_idx.map_or(idx, |cur: usize| cur.min(idx)));
        }
    }

    if let Some(idx) = cut_idx {
        let concise = text[..idx].trim_end();
        if !concise.is_empty() {
            return std::borrow::Cow::Owned(concise.to_string());
        }
    }

    std::borrow::Cow::Borrowed(text)
}

/// Map an HTTP error status to a plain-language headline so the TUI shows the
/// *cause*, not a bare `HTTP 401:` (which, when the server returns an empty
/// body, carried no hint at all). Shared by every provider protocol
/// (openai-compat, Anthropic/Claude, ollama, …) so the wording stays consistent
/// regardless of which wire format hit the error.
///
/// 401/402 get a headline, and for those the provider's raw `detail` is
/// deliberately DROPPED — the headline already says it and this short form folds
/// cleanly into the interrupted-turn summary (`✗ 已中断：账户余额不足（HTTP 402）`).
/// 403 and other responses stay raw because JeikCode reuses that status for
/// session-concurrency conflicts and their structured reason must survive. 429
/// must keep the literal `HTTP 429: ` prefix the kernel rate-limit path
/// (`rate_limit_server_message`) strips. Everything else keeps
/// `HTTP {code}: {detail}` (the detail is the only signal there).
pub(crate) fn friendly_http_error(code: u16, detail: &str) -> String {
    let headline = match code {
        401 => jeikcode_config::i18n::format_agent_status_unauthorized(),
        402 => jeikcode_config::i18n::format_agent_status_insufficient_balance(),
        _ => return format!("HTTP {code}: {detail}"),
    };
    format!("{headline} (HTTP {code})")
}

/// Recursively clean and normalize tool parameter schemas for universal LLM wire compatibility
/// (OpenAI, Anthropic, Gemini gateways, Ollama, Bedrock, etc.).
///
/// Cleans external MCP artifacts (leaked headers, pseudo-objects like Brave Search),
/// converts Draft-6+ `const: "val"` to OpenAPI-3.0-standard `enum: ["val"]`,
/// flattens polymorphic `oneOf`/`anyOf` discriminator objects into clean flat schemas,
/// and strips meta keywords like `$schema`/`$id` that cause upstream 400s (e.g. Gemini Schema errors).
pub(crate) fn sanitize_schema_for_wire(val: &Value) -> Value {
    let sanitized = crate::schema_sanitizer::sanitize_mcp_schema(val.clone());
    sanitize_schema_for_wire_inner(&sanitized, 0)
}

const MAX_WIRE_SANITIZE_DEPTH: usize = 64;

fn sanitize_schema_for_wire_inner(val: &Value, depth: usize) -> Value {
    if depth > MAX_WIRE_SANITIZE_DEPTH {
        return val.clone();
    }
    match val {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();

            // Check if this object is a oneOf / anyOf container of object variants that should be normalized
            if let Some(one_of) = map
                .get("oneOf")
                .or_else(|| map.get("anyOf"))
                .and_then(|v| v.as_array())
            {
                let is_object_union = !one_of.is_empty()
                    && one_of.iter().all(|item| {
                        item.as_object().map_or(false, |obj| {
                            obj.get("type").and_then(|t| t.as_str()) == Some("object")
                                || obj.get("properties").is_some()
                        })
                    });
                if is_object_union {
                    let mut merged_props = serde_json::Map::new();
                    let mut merged_desc = map.get("description").cloned();
                    let mut kinds = Vec::new();

                    for item in one_of {
                        if let Some(item_obj) = item.as_object() {
                            if merged_desc.is_none() {
                                merged_desc = item_obj.get("description").cloned();
                            }
                            if let Some(props) =
                                item_obj.get("properties").and_then(|p| p.as_object())
                            {
                                for (k, v) in props {
                                    if k == "kind" || k == "type" || k == "action" {
                                        if let Some(c) = v.get("const").and_then(|c| c.as_str()) {
                                            if !kinds.contains(&c.to_string()) {
                                                kinds.push(c.to_string());
                                            }
                                        } else if let Some(e) =
                                            v.get("enum").and_then(|e| e.as_array())
                                        {
                                            for ev in e {
                                                if let Some(s) = ev.as_str() {
                                                    if !kinds.contains(&s.to_string()) {
                                                        kinds.push(s.to_string());
                                                    }
                                                }
                                            }
                                        } else {
                                            merged_props.insert(
                                                k.clone(),
                                                sanitize_schema_for_wire_inner(v, depth + 1),
                                            );
                                        }
                                    } else {
                                        merged_props.insert(
                                            k.clone(),
                                            sanitize_schema_for_wire_inner(v, depth + 1),
                                        );
                                    }
                                }
                            }
                        }
                    }

                    if !kinds.is_empty() {
                        let kind_prop = json!({
                            "type": "string",
                            "enum": kinds,
                            "description": "Scope kind or discriminator."
                        });
                        merged_props.insert("kind".to_string(), kind_prop);
                    }

                    if !merged_props.is_empty() {
                        out.insert("type".to_string(), json!("object"));
                        if let Some(desc) = merged_desc {
                            out.insert("description".to_string(), desc);
                        }
                        out.insert("properties".to_string(), Value::Object(merged_props));
                        return Value::Object(out);
                    }
                }
            }

            for (k, v) in map {
                // Strip unsupported meta fields
                if k == "$schema" || k == "$id" {
                    continue;
                }
                // Convert const to enum
                if k == "const" {
                    out.insert("enum".to_string(), json!([v]));
                    continue;
                }
                out.insert(k.clone(), sanitize_schema_for_wire_inner(v, depth + 1));
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(
            arr.iter()
                .map(|item| sanitize_schema_for_wire_inner(item, depth + 1))
                .collect(),
        ),
        _ => val.clone(),
    }
}

#[cfg(test)]
mod session_affinity_tests {
    use super::apply_session_affinity;

    fn headers(session_id: &str) -> reqwest::header::HeaderMap {
        apply_session_affinity(
            reqwest::Client::new().post("http://127.0.0.1/probe"),
            session_id,
        )
        .build()
        .expect("request builds offline")
        .headers()
        .clone()
    }

    #[test]
    fn every_transport_advertises_our_own_brand_session_header() {
        // 所有协议共用这一个定义：探测与真实对话发送完全相同的自家品牌会话头。
        let head = headers("probe-1234");
        assert_eq!(head.get("x-jeikcode-session-id").unwrap(), "probe-1234");
        assert_eq!(head.get("x-session-id").unwrap(), "probe-1234");
        assert!(
            head.get("x-opencode-session").is_none(),
            "only our own brand is advertised"
        );
    }

    #[test]
    fn unbound_requests_omit_the_session_headers() {
        let head = headers("");
        assert!(head.get("x-jeikcode-session-id").is_none());
        assert!(head.get("x-session-id").is_none());
    }
}

#[cfg(test)]
mod coalesce_tests {
    use super::push_system_coalesced;
    use serde_json::json;

    #[test]
    fn merges_runs_and_preserves_non_system_boundaries() {
        let mut out = Vec::new();
        push_system_coalesced(&mut out, "persona");
        push_system_coalesced(&mut out, "memory");
        assert_eq!(
            out,
            vec![json!({"role":"system","content":"persona\n\nmemory"})]
        );
        // A non-system entry breaks the run: a later system would start a fresh block.
        out.push(json!({"role":"user","content":"hi"}));
        push_system_coalesced(&mut out, "late");
        assert_eq!(
            out.len(),
            3,
            "system after a user is NOT merged into the leading block"
        );
        assert_eq!(out[2], json!({"role":"system","content":"late"}));
    }

    #[test]
    fn empty_text_does_not_inject_blank_separator() {
        let mut out = Vec::new();
        push_system_coalesced(&mut out, "");
        push_system_coalesced(&mut out, "real");
        assert_eq!(out, vec![json!({"role":"system","content":"real"})]);
    }
}

#[cfg(test)]
mod wire_dump_tests {
    use super::wire_dump_to;
    use serde_json::json;

    #[test]
    fn writes_body_as_req_json_into_dir() {
        let dir = tempfile::tempdir().unwrap();
        let body = json!({"model": "deepseek-v4", "messages": [{"role": "user", "content": "hi"}]});
        wire_dump_to(dir.path(), "deepseek-v4", &body);

        let files: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(files.len(), 1, "one dump file written: {files:?}");
        let name = &files[0];
        assert!(name.ends_with(".req.json"), "req.json suffix: {name}");
        assert!(name.contains("deepseek-v4"), "model in filename: {name}");

        // The dumped bytes round-trip to the exact body (byte-level content preserved).
        let written = std::fs::read_to_string(dir.path().join(name)).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&written).unwrap();
        assert_eq!(parsed, body, "dumped JSON equals the outbound body");
    }

    #[test]
    fn model_name_is_filename_sanitized() {
        let dir = tempfile::tempdir().unwrap();
        // A slash / colon in a model id must not escape the dir or break the path.
        wire_dump_to(dir.path(), "org/model:v1", &json!({}));
        let name = std::fs::read_dir(dir.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .file_name()
            .to_string_lossy()
            .into_owned();
        assert!(
            !name.contains('/') && !name.contains(':'),
            "unsafe chars stripped: {name}"
        );
        assert!(
            name.contains("org_model_v1"),
            "sanitized model retained: {name}"
        );
    }

    #[test]
    fn sanitize_schema_converts_const_and_normalizes_one_of() {
        use super::sanitize_schema_for_wire;

        // Test 1: const conversion
        let s = json!({
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "kind": { "const": "working_tree" }
            }
        });
        let sanitized = sanitize_schema_for_wire(&s);
        assert!(!sanitized.as_object().unwrap().contains_key("$schema"));
        assert_eq!(
            sanitized["properties"]["kind"]["enum"],
            json!(["working_tree"])
        );

        // Test 2: oneOf discriminator normalization
        let one_of_schema = json!({
            "oneOf": [
                { "type": "object", "properties": { "kind": { "const": "working_tree" } }, "required": ["kind"] },
                { "type": "object", "properties": { "kind": { "const": "staged" } }, "required": ["kind"] },
                { "type": "object", "properties": { "kind": { "const": "range" }, "base": { "type": "string" } }, "required": ["kind", "base"] }
            ],
            "description": "Scope selection"
        });
        let res = sanitize_schema_for_wire(&one_of_schema);
        assert_eq!(res["type"], "object");
        assert_eq!(res["description"], "Scope selection");
        assert_eq!(
            res["properties"]["kind"]["enum"],
            json!(["working_tree", "staged", "range"])
        );
        assert_eq!(res["properties"]["base"]["type"], "string");
    }

    #[test]
    fn test_sanitize_schema_cleans_headers_and_preserves_array() {
        use super::sanitize_schema_for_wire;

        let tool_schema = json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Search query" },
                "goggles": { "type": "array", "items": { "type": "string" }, "description": "Goggles URLs" },
                "accept": { "type": "string", "description": "HTTP Accept header" },
                "user-agent": { "type": "string", "description": "HTTP User-Agent" }
            },
            "required": ["query", "accept"]
        });

        let sanitized = sanitize_schema_for_wire(&tool_schema);
        let props = sanitized.get("properties").unwrap().as_object().unwrap();

        // Leaked headers stripped
        assert!(!props.contains_key("accept"));
        assert!(!props.contains_key("user-agent"));

        // Required cleaned
        let req = sanitized.get("required").unwrap().as_array().unwrap();
        assert_eq!(req, &vec![json!("query")]);

        // goggles preserves type: "array" and items (vital for Gemini API)
        assert_eq!(props["goggles"]["type"], "array");
        assert_eq!(props["goggles"]["items"], json!({ "type": "string" }));
    }

    #[test]
    fn test_strip_tool_result_diff_for_model() {
        use super::strip_tool_result_diff_for_model;

        // 1. Successful edit with diff: diff is stripped, concise success is kept
        let full_edit = "The file src/main.rs has been updated successfully (1 replacement). Edited successfully.\n--- a/src/main.rs\n+++ b/src/main.rs\n@@ -1,3 +1,3 @@\n-old\n+new";
        let model_view = strip_tool_result_diff_for_model(full_edit);
        assert_eq!(
            model_view,
            "The file src/main.rs has been updated successfully (1 replacement). Edited successfully."
        );

        // 2. Edit with auto-heal note: note and success kept, diff stripped
        let heal_edit = "⚠️ **[Auto-heal Note]**: A conflict was resolved.\n\nThe file src/lib.rs has been updated successfully (2 replacements).\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -10,2 +10,2 @@\n-a\n+b";
        let heal_model_view = strip_tool_result_diff_for_model(heal_edit);
        assert_eq!(
            heal_model_view,
            "⚠️ **[Auto-heal Note]**: A conflict was resolved.\n\nThe file src/lib.rs has been updated successfully (2 replacements)."
        );

        // 3. Failed edit: preserved entirely for error diagnosis
        let failed_edit = "edit: hunk 1/1 failed. old_string not found in file.";
        let failed_model_view = strip_tool_result_diff_for_model(failed_edit);
        assert_eq!(failed_model_view, failed_edit);

        // 4. Non-edit output: preserved entirely
        let read_output = "Line 1\nLine 2\nLine 3";
        assert_eq!(strip_tool_result_diff_for_model(read_output), read_output);
    }
}
