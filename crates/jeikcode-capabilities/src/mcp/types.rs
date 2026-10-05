//! MCP type definitions.

use serde::{Deserialize, Serialize};

/// Protocol revision this client asks for in `initialize`.
///
/// The server answers with the revision it will actually speak (see
/// [`InitializeResult::protocol_version`]); that answer — not this constant — is what
/// the HTTP transport echoes back in `MCP-Protocol-Version`. Every revision from
/// `2024-11-05` through this one is wire-compatible for the tools-only surface we use,
/// so an older server simply negotiates itself down.
///
/// Not bumped past `2025-11-25`: `2026-07-28` removes the `initialize` handshake
/// entirely in favour of `server/discover`, which this hand-rolled client does not speak.
pub const MCP_PROTOCOL_VERSION: &str = "2025-11-25";

/// `initialize` params, shared by every transport so the three handshakes cannot drift.
///
/// `capabilities` is deliberately EMPTY. The client-side capability set is
/// `roots` / `sampling` / `elicitation` (plus `experimental`), and this client
/// implements none of them. It previously advertised `{"tools": {}}`, which was a
/// category error — `tools` is a SERVER capability, so that object told every server
/// exactly nothing.
pub fn initialize_params() -> serde_json::Value {
    serde_json::json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": {
            "name": "jeikcode",
            "version": env!("CARGO_PKG_VERSION")
        }
    })
}

/// JSON-RPC request wrapper.
#[derive(Debug, Serialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: &'static str,
    pub id: u64,
    pub method: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

/// JSON-RPC response wrapper.
#[derive(Debug, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: u64,
    #[serde(default)]
    pub result: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<JsonRpcError>,
}

/// JSON-RPC error.
#[derive(Debug, Deserialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
}

/// MCP initialize result.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol_version: String,
    pub capabilities: ServerCapabilities,
    pub server_info: ServerInfo,
    /// Optional server-scoped guidance describing how its features should be used.
    /// The registry treats this as untrusted external input and projects it only
    /// alongside tools mounted from the same server.
    #[serde(default)]
    pub instructions: Option<String>,
}

/// Server capabilities.
#[derive(Debug, Deserialize, Default)]
pub struct ServerCapabilities {
    #[serde(default)]
    pub tools: Option<ToolsCapability>,
}

/// Tools capability marker.
#[derive(Debug, Deserialize)]
pub struct ToolsCapability {}

/// Server info.
#[derive(Debug, Deserialize)]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
}

/// Tool definition from MCP server.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolDefinition {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, rename = "inputSchema")]
    pub input_schema: serde_json::Value,
    /// Optional MCP tool annotations (`readOnlyHint`, `destructiveHint`, …). Captured
    /// so plan mode can allow read-only external queries. Absent on servers that don't
    /// annotate → treated as unknown (not read-only).
    #[serde(default)]
    pub annotations: Option<McpToolAnnotations>,
}

/// MCP tool behavior hints from `tools/list` (`annotations` object). All optional and
/// advisory — a missing hint means "unknown", handled conservatively.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolAnnotations {
    /// The tool does not modify its environment (safe to run during read-only work).
    #[serde(default)]
    pub read_only_hint: Option<bool>,
    /// The tool may perform destructive updates (only meaningful when not read-only).
    #[serde(default)]
    pub destructive_hint: Option<bool>,
}

impl McpToolDefinition {
    /// True only when the server EXPLICITLY annotated this tool `readOnlyHint: true`
    /// AND did NOT also flag it `destructiveHint: true`. A tool that claims to be both
    /// read-only and destructive is contradictory self-attestation, so we fail closed
    /// and treat it as NOT read-only — matching codex, which forces approval whenever
    /// `destructiveHint: true`, even alongside `readOnlyHint`. Conservative throughout:
    /// unknown / unannotated → false.
    pub fn is_read_only(&self) -> bool {
        matches!(
            self.annotations,
            Some(McpToolAnnotations { read_only_hint: Some(true), destructive_hint, .. })
                if destructive_hint != Some(true)
        )
    }
}

/// List tools result.
#[derive(Debug, Deserialize)]
pub struct ListToolsResult {
    pub tools: Vec<McpToolDefinition>,
}

fn default_image_mime_type() -> String {
    "image/png".to_string()
}

/// Tool call result content.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text {
        #[serde(default)]
        text: String,
    },
    #[serde(rename = "image")]
    Image {
        #[serde(default)]
        data: String,
        #[serde(
            rename = "mimeType",
            alias = "mime_type",
            default = "default_image_mime_type"
        )]
        mime_type: String,
    },
    #[serde(rename = "resource")]
    Resource { resource: ResourceContent },
    #[serde(other)]
    Unknown,
}

/// Resource content in tool result.
#[derive(Debug, Clone, Deserialize)]
pub struct ResourceContent {
    #[serde(default)]
    pub uri: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub blob: Option<String>,
    #[serde(rename = "mimeType", alias = "mime_type", default)]
    pub mime_type: Option<String>,
}

/// Tool call result.
#[derive(Debug, Clone, Deserialize)]
pub struct CallToolResult {
    #[serde(default)]
    pub content: Vec<ContentBlock>,
    #[serde(rename = "isError", alias = "is_error", default)]
    pub is_error: bool,
}

impl CallToolResult {
    /// Leniently parse a tool call result value from standard MCP responses,
    /// camelCase/snake_case variations, and non-standard fallbacks.
    pub fn parse_lenient(value: serde_json::Value) -> Self {
        // 1. Standard or tolerant serde deserialization
        if let Ok(res) = serde_json::from_value::<Self>(value.clone()) {
            let has_meaningful_content = res
                .content
                .iter()
                .any(|b| !matches!(b, ContentBlock::Unknown));
            let had_content_field = value.as_object().and_then(|m| m.get("content")).is_some();
            if has_meaningful_content || had_content_field {
                return res;
            }
        }

        // 2. Fallback for object with string content, text, or result
        if let serde_json::Value::Object(mut map) = value.clone() {
            let is_error = map
                .get("isError")
                .or_else(|| map.get("is_error"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            if let Some(content_val) = map.remove("content") {
                if let serde_json::Value::String(s) = content_val {
                    return Self {
                        content: vec![ContentBlock::Text { text: s }],
                        is_error,
                    };
                }
            }

            if let Some(serde_json::Value::String(s)) = map.remove("text") {
                return Self {
                    content: vec![ContentBlock::Text { text: s }],
                    is_error,
                };
            }

            if let Some(serde_json::Value::String(s)) = map.remove("result") {
                return Self {
                    content: vec![ContentBlock::Text { text: s }],
                    is_error,
                };
            }
        }

        // 3. Fallback for primitive string
        if let serde_json::Value::String(s) = value.clone() {
            return Self {
                content: vec![ContentBlock::Text { text: s }],
                is_error: false,
            };
        }

        // 4. Ultimate fallback: stringify the JSON value as text
        Self {
            content: vec![ContentBlock::Text {
                text: value.to_string(),
            }],
            is_error: false,
        }
    }
}

/// Server status for display.
#[derive(Debug, Clone, PartialEq)]
pub enum ServerStatus {
    Connecting,
    Connected,
    BlockedUntrusted,
    Failed(String),
    Disconnected,
}

impl std::fmt::Display for ServerStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServerStatus::Connecting => write!(f, "connecting"),
            ServerStatus::Connected => write!(f, "connected"),
            ServerStatus::BlockedUntrusted => write!(f, "blocked: untrusted project"),
            ServerStatus::Failed(e) => write!(f, "failed: {}", e),
            ServerStatus::Disconnected => write!(f, "disconnected"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_optional_initialize_instructions() {
        let result: InitializeResult = serde_json::from_value(serde_json::json!({
            "protocolVersion": "2025-11-25",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "voice", "version": "1.0" },
            "instructions": "Speak only the final answer."
        }))
        .unwrap();
        assert_eq!(
            result.instructions.as_deref(),
            Some("Speak only the final answer.")
        );

        let without: InitializeResult = serde_json::from_value(serde_json::json!({
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "serverInfo": { "name": "plain", "version": "1.0" }
        }))
        .unwrap();
        assert!(without.instructions.is_none());
    }

    #[test]
    fn parses_read_only_hint_annotation() {
        let def: McpToolDefinition = serde_json::from_value(serde_json::json!({
            "name": "query_users",
            "description": "list users",
            "inputSchema": {},
            "annotations": { "readOnlyHint": true, "destructiveHint": false }
        }))
        .unwrap();
        assert!(def.is_read_only());
    }

    #[test]
    fn unannotated_or_non_readonly_is_not_read_only() {
        // No annotations object at all.
        let bare: McpToolDefinition =
            serde_json::from_value(serde_json::json!({ "name": "x", "inputSchema": {} })).unwrap();
        assert!(!bare.is_read_only());
        // Annotations present but readOnlyHint absent/false.
        let write: McpToolDefinition = serde_json::from_value(serde_json::json!({
            "name": "delete_user", "inputSchema": {},
            "annotations": { "destructiveHint": true }
        }))
        .unwrap();
        assert!(!write.is_read_only());
    }

    #[test]
    fn destructive_hint_overrides_read_only_hint() {
        // Contradictory self-attestation: readOnlyHint AND destructiveHint both true.
        // Fail closed → NOT read-only, so it still requires approval (codex parity —
        // codex forces approval on destructiveHint:true even alongside readOnlyHint).
        let contradictory: McpToolDefinition = serde_json::from_value(serde_json::json!({
            "name": "wipe", "inputSchema": {},
            "annotations": { "readOnlyHint": true, "destructiveHint": true }
        }))
        .unwrap();
        assert!(
            !contradictory.is_read_only(),
            "destructiveHint:true must veto readOnlyHint"
        );
    }

    #[test]
    fn parses_standard_mcp_image_and_camel_case() {
        let value = serde_json::json!({
            "content": [
                {
                    "type": "image",
                    "data": "iVBORw0KGgoAAAANSUhEUgAA",
                    "mimeType": "image/png"
                },
                {
                    "type": "resource",
                    "resource": {
                        "uri": "file:///test.txt",
                        "mimeType": "text/plain",
                        "text": "hello"
                    }
                }
            ],
            "isError": false
        });

        let parsed: CallToolResult = serde_json::from_value(value).unwrap();
        assert!(!parsed.is_error);
        assert_eq!(parsed.content.len(), 2);
        match &parsed.content[0] {
            ContentBlock::Image { data, mime_type } => {
                assert_eq!(data, "iVBORw0KGgoAAAANSUhEUgAA");
                assert_eq!(mime_type, "image/png");
            }
            _ => panic!("expected Image block"),
        }
        match &parsed.content[1] {
            ContentBlock::Resource { resource } => {
                assert_eq!(resource.uri, "file:///test.txt");
                assert_eq!(resource.mime_type.as_deref(), Some("text/plain"));
                assert_eq!(resource.text.as_deref(), Some("hello"));
            }
            _ => panic!("expected Resource block"),
        }
    }

    #[test]
    fn parses_is_error_camel_case() {
        let value = serde_json::json!({
            "content": [
                { "type": "text", "text": "something failed" }
            ],
            "isError": true
        });

        let parsed: CallToolResult = serde_json::from_value(value).unwrap();
        assert!(parsed.is_error);
        assert_eq!(parsed.content.len(), 1);
    }

    #[test]
    fn ignores_unknown_content_block_types() {
        let value = serde_json::json!({
            "content": [
                { "type": "audio", "data": "base64audio" },
                { "type": "text", "text": "sound played" }
            ]
        });

        let parsed: CallToolResult = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.content.len(), 2);
        assert!(matches!(parsed.content[0], ContentBlock::Unknown));
        assert!(matches!(parsed.content[1], ContentBlock::Text { .. }));
    }

    #[test]
    fn lenient_parser_handles_string_and_custom_objects() {
        // Plain string
        let res1 = CallToolResult::parse_lenient(serde_json::json!("plain string response"));
        assert!(!res1.is_error);
        assert_eq!(res1.content.len(), 1);
        match &res1.content[0] {
            ContentBlock::Text { text } => assert_eq!(text, "plain string response"),
            _ => panic!("expected text"),
        }

        // Custom object with content: string
        let res2 = CallToolResult::parse_lenient(serde_json::json!({
            "content": "single string content",
            "isError": true
        }));
        assert!(res2.is_error);
        match &res2.content[0] {
            ContentBlock::Text { text } => assert_eq!(text, "single string content"),
            _ => panic!("expected text"),
        }

        // Custom object with text: string
        let res3 = CallToolResult::parse_lenient(serde_json::json!({
            "text": "text field value"
        }));
        assert!(!res3.is_error);
        match &res3.content[0] {
            ContentBlock::Text { text } => assert_eq!(text, "text field value"),
            _ => panic!("expected text"),
        }
    }
}
