use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use jeikcode_kernel::message::{Message, Role};
use jeikcode_kernel::provider::{ChatOptions, LlmProvider, ReasoningEffort, ToolChoice};
use jeikcode_kernel::stream::StreamEvent;
use futures::StreamExt;

static TITLE_FLIGHTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn title_flights() -> &'static Mutex<HashSet<String>> {
    TITLE_FLIGHTS.get_or_init(|| Mutex::new(HashSet::new()))
}

/// RAII claim on the single in-flight AI title attempt for one session.
/// Dropping releases the claim so a later retry may start — never overlapping.
#[must_use]
pub struct TitleFlightGuard {
    session_id: String,
}

impl Drop for TitleFlightGuard {
    fn drop(&mut self) {
        title_flights()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.session_id);
    }
}

/// Atomically claim the per-session title flight.
/// Returns `None` when another attempt is already running for this session.
pub fn try_begin_title_flight(session_id: &str) -> Option<TitleFlightGuard> {
    if session_id.is_empty() {
        return None;
    }
    let mut set = title_flights()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !set.insert(session_id.to_string()) {
        return None;
    }
    Some(TitleFlightGuard {
        session_id: session_id.to_string(),
    })
}

const MAX_TITLE_CHARS: usize = 40;
/// Auxiliary title call. Chat Completions / Responses thinking models may spend
/// several seconds on hidden reasoning before the visible title; 10s was enough
/// for Anthropic (which always sends `max_tokens` and streams `text_delta`) but
/// truncated the other two protocols.
pub const TITLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// Cap covering hidden reasoning plus a ≤6-word title. Anthropic always injects
/// `max_tokens` from config; Chat Completions / Responses omit it when unset, so
/// reasoning models can consume the whole implicit budget and emit no
/// `TextDelta` — which left WebUI stuck on the provisional first-line title.
/// Keep this above a typical low-effort think budget so a short title still fits.
const TITLE_MAX_TOKENS: u32 = 768;

/// First-line provisional title from the user's raw (unwrapped) input.
/// Used at first Submit so the session is catalog-visible before the turn ends.
pub fn provisional_title_from_user_input(raw: &str) -> Option<String> {
    let text = strip_leading_image_markers(raw.trim());
    let name: String = text
        .lines()
        .next()
        .unwrap_or_default()
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(MAX_TITLE_CHARS)
        .collect();
    let name = name.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// Remove only TUI-generated image attachment markers from the beginning of a
/// prompt so titles stay human-readable.
fn strip_leading_image_markers(mut text: &str) -> &str {
    loop {
        let trimmed = text.trim_start();
        let Some(marker) = trimmed.strip_prefix("[Image #") else {
            return trimmed;
        };
        let Some(close) = marker.find(']') else {
            return trimmed;
        };
        text = marker[close + 1..].trim_start();
    }
}

pub fn session_title_prompt(conversation: &str) -> String {
    format!(
        "Generate a short, specific title for this conversation. \
         Rules: at most 6 words, same language as the user, no surrounding \
         quotes, no trailing punctuation, no leading label like \"Title:\". \
         Reply with only the title.\n\n{conversation}"
    )
}

pub fn sanitize_generated_title(raw: &str) -> Option<String> {
    let scrubbed: String = raw
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    let mut title = scrubbed.trim();
    for label in ["Title:", "title:", "标题:", "标题：", "主题:", "主题："] {
        if let Some(rest) = title.strip_prefix(label) {
            title = rest.trim();
        }
    }
    let collapsed = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let unquoted = collapsed
        .trim_matches(|character| matches!(character, '"' | '\'' | '`' | '“' | '”'))
        .trim();
    let title = unquoted.trim_end_matches(['.', '。']).trim();
    if title.is_empty() {
        return None;
    }
    Some(title.chars().take(MAX_TITLE_CHARS).collect())
}

pub fn first_exchange_text(messages: &[Message]) -> Option<String> {
    first_exchange_text_in(messages, Path::new(""))
}

/// Like [`first_exchange_text`], but unwraps `user-wrap.md` so AI titles never
/// echo the wrap template boilerplate — only the user's real input.
pub fn first_exchange_text_in(messages: &[Message], working_dir: &Path) -> Option<String> {
    let user = messages
        .iter()
        .filter(|message| {
            matches!(message.role, Role::User)
                && !message.synthetic
                && !jeikcode_capabilities::reminder::is_system_reminder(&message.text)
        })
        .map(|message| {
            jeikcode_capabilities::session::user_text_for_display(working_dir, &message.text)
        })
        .next()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())?;
    let assistant = messages
        .iter()
        .filter(|message| matches!(message.role, Role::Assistant))
        .map(|message| message.text.as_str())
        .next()
        .map(str::trim)
        .unwrap_or("");
    let mut conversation = format!("User: {user}");
    if !assistant.is_empty() {
        conversation.push_str(&format!("\nAssistant: {assistant}"));
    }
    Some(conversation)
}

pub fn should_accept_ai_name(user_renamed: bool, ai_named: bool) -> bool {
    !user_renamed && !ai_named
}

pub async fn generate_session_title(
    provider: Arc<dyn LlmProvider>,
    conversation: String,
) -> Option<String> {
    let prompt = session_title_prompt(&conversation);
    // Do NOT set temperature: Responses / several Chat Completions reasoners
    // reject sampling params (400), while Anthropic already omits them by
    // default — which is why only the Anthropic path looked "fixed" before.
    // Force Low effort so Grok cannot fall through to its implicit High and
    // spend the whole output budget before any visible title text.
    let options = ChatOptions {
        max_tokens: Some(TITLE_MAX_TOKENS),
        temperature: None,
        tool_choice: ToolChoice::None,
        reasoning_effort: Some(ReasoningEffort::Low),
        ..ChatOptions::default()
    };
    let task = async move {
        let messages = [Message::user(prompt)];
        let mut stream = match provider.chat_stream(&messages, &[], &options).await {
            Ok(stream) => stream,
            Err(error) => {
                tracing::debug!(?error, "session title generation failed before sampling");
                return None;
            }
        };
        let mut raw = String::new();
        while let Some(event) = stream.next().await {
            match event {
                StreamEvent::TextDelta(text) => raw.push_str(&text),
                StreamEvent::Error(error) => {
                    tracing::debug!(?error, "session title generation stream failed");
                    // Keep whatever visible text already arrived — some adapters
                    // emit a trailing stream error after a successful completion.
                    break;
                }
                StreamEvent::Done { .. } => break,
                _ => {}
            }
        }
        let title = sanitize_generated_title(&raw);
        if title.is_none() {
            tracing::debug!(
                output_chars = raw.chars().count(),
                "session title generation produced no acceptable output"
            );
        }
        title
    };
    match tokio::time::timeout(TITLE_TIMEOUT, task).await {
        Ok(title) => title,
        Err(_) => {
            tracing::debug!("session title generation timed out");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_exchange_skips_synthetic_context() {
        let messages = vec![
            Message::synthetic_user("[context compressed]"),
            Message::user("修复登录错误"),
            Message::assistant("已修复", vec![]),
        ];
        assert_eq!(
            first_exchange_text(&messages).as_deref(),
            Some("User: 修复登录错误\nAssistant: 已修复")
        );
    }

    #[test]
    fn first_exchange_skips_injected_system_reminder() {
        let messages = vec![
            Message::user(jeikcode_capabilities::reminder::system_reminder(
                "当前日期：2026-08-09",
            )),
            Message::user("修复登录错误"),
            Message::assistant("已修复", vec![]),
        ];
        assert_eq!(
            first_exchange_text(&messages).as_deref(),
            Some("User: 修复登录错误\nAssistant: 已修复")
        );
    }

    #[test]
    fn first_exchange_unwraps_user_wrap_for_title_prompt() {
        let temp = tempfile::TempDir::new().unwrap();
        std::fs::write(
            temp.path().join("user-wrap.md"),
            "用户提问：【{{input}}】\n请严格遵守规则。",
        )
        .unwrap();
        let messages = vec![
            Message::user("用户提问：【修复登录错误】\n请严格遵守规则。"),
            Message::assistant("已修复", vec![]),
        ];
        assert_eq!(
            first_exchange_text_in(&messages, temp.path()).as_deref(),
            Some("User: 修复登录错误\nAssistant: 已修复")
        );
    }

    #[test]
    fn provisional_title_uses_first_line_only() {
        assert_eq!(
            provisional_title_from_user_input("[Image #1] 帮我看图\n第二行").as_deref(),
            Some("帮我看图")
        );
    }

    #[tokio::test]
    async fn generated_title_is_sanitized() {
        let provider = Arc::new(jeikcode_kernel::testkit::MockProvider::new(vec![vec![
            StreamEvent::TextDelta("Title: \"修复登录错误。\"".into()),
            StreamEvent::Done { truncated: false },
        ]]));
        assert_eq!(
            generate_session_title(provider, "User: 修复登录错误".into()).await,
            Some("修复登录错误".into())
        );
    }

    #[tokio::test]
    async fn trailing_stream_error_keeps_collected_title() {
        let provider = Arc::new(jeikcode_kernel::testkit::MockProvider::new(vec![vec![
            StreamEvent::TextDelta("修复登录错误".into()),
            StreamEvent::Error(jeikcode_kernel::stream::ProviderError {
                retryable: false,
                message: "connection reset after completion".into(),
                ..Default::default()
            }),
        ]]));
        assert_eq!(
            generate_session_title(provider, "User: 修复登录错误".into()).await,
            Some("修复登录错误".into())
        );
    }

    #[test]
    fn acceptance_preserves_explicit_or_existing_names() {
        assert!(should_accept_ai_name(false, false));
        assert!(!should_accept_ai_name(true, false));
        assert!(!should_accept_ai_name(false, true));
    }

    #[test]
    fn title_flight_is_exclusive_per_session_until_released() {
        let id = format!("title-flight-{}", uuid::Uuid::new_v4());
        let first = try_begin_title_flight(&id);
        assert!(first.is_some());
        assert!(try_begin_title_flight(&id).is_none());
        drop(first);
        assert!(try_begin_title_flight(&id).is_some());
    }

    #[test]
    fn title_flight_claims_are_independent_across_sessions() {
        let a = format!("title-flight-a-{}", uuid::Uuid::new_v4());
        let b = format!("title-flight-b-{}", uuid::Uuid::new_v4());
        let guard_a = try_begin_title_flight(&a).expect("claim a");
        let guard_b = try_begin_title_flight(&b).expect("claim b");
        assert!(try_begin_title_flight(&a).is_none());
        assert!(try_begin_title_flight(&b).is_none());
        drop(guard_a);
        drop(guard_b);
    }
}
