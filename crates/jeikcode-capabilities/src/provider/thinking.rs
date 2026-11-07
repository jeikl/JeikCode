//! Central policy for thinking / reasoning budgets.
//!
//! The kernel owns the per-request OUTPUT budget (`ChatOptions::max_tokens`).
//! This module resolves the THINKING budget as a strictly downstream constraint:
//! it may shrink to leave answer room, but it NEVER inflates the output budget.
//!
//! Protocol adapters should ask this module for a budget instead of carrying
//! their own magic-number tables. Model-generation quirks (e.g. Claude 4.7+
//! requiring adaptive thinking) live here, not in the request builders.

use jeikcode_kernel::provider::ReasoningEffort;

/// Tokens always reserved for the visible answer when thinking shares the
/// response ceiling. Mirrors pi's `MIN_ANSWER_TOKENS`.
pub const MIN_ANSWER_TOKENS: u32 = 1024;

/// Anthropic's hard minimum for `thinking.budget_tokens`.
pub const MIN_ANTHROPIC_BUDGET_TOKENS: u32 = 1024;

/// Legacy Anthropic default when thinking is enabled but no budget/effort is set.
pub const DEFAULT_ANTHROPIC_BUDGET: u32 = 10_000;

/// Gemini 2.5 default when thinking is enabled but no budget/effort is set.
pub const DEFAULT_GEMINI_BUDGET: u32 = 8_192;

/// A conservative upper bound for Gemini 2.5 numeric budgets. Model-specific
/// limits can be tightened once the catalog exposes them.
pub const MAX_GEMINI_25_BUDGET: u32 = 32_768;

/// Which wire family a model belongs to. This is a *policy* classification, not
/// a wire format: adapters still own their request body shape.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThinkingFamily {
    /// Claude <= 4.6: `thinking: {type:"enabled", budget_tokens}`.
    AnthropicLegacy,
    /// Claude >= 4.7: `thinking: {type:"adaptive"}` + `output_config.effort`.
    AnthropicAdaptive,
    /// Gemini 2.5: `thinkingConfig.thinkingBudget`.
    Gemini25,
    /// Gemini 3+: `thinkingConfig.thinkingLevel`.
    Gemini3Plus,
    /// OpenAI Chat Completions: `reasoning_effort`; numeric budget only when
    /// explicitly configured by a compatible gateway.
    OpenAiChat,
}

impl ThinkingFamily {
    /// Whether this family can put a numeric token budget on the wire.
    pub fn supports_numeric_budget(self) -> bool {
        matches!(
            self,
            Self::AnthropicLegacy | Self::Gemini25 | Self::OpenAiChat
        )
    }

    /// Minimum legal budget for this family.
    pub fn min_budget(self) -> u32 {
        match self {
            Self::AnthropicLegacy => MIN_ANTHROPIC_BUDGET_TOKENS,
            // Gemini 2.5 allows 0 (thinking off), but a *thinking* budget must
            // leave at least one token.
            Self::Gemini25 => 1,
            _ => 1,
        }
    }

    /// Family-wide upper bound, if known. The per-request output budget is
    /// always the tighter bound and is applied by [`resolve_budget`].
    pub fn max_budget(self) -> Option<u32> {
        match self {
            Self::Gemini25 => Some(MAX_GEMINI_25_BUDGET),
            _ => None,
        }
    }
}

/// A resolved numeric thinking budget.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ThinkingBudget {
    pub tokens: u32,
    /// True when the requested value was shrunk to satisfy the family bound or
    /// the answer-room invariant.
    pub clamped: bool,
}

/// True for an explicit "thinking off" effort, including custom aliases.
pub fn is_effort_off(effort: Option<&ReasoningEffort>) -> bool {
    match effort {
        None => false,
        Some(ReasoningEffort::Off) => true,
        Some(other) => {
            let value = other.as_str();
            value.eq_ignore_ascii_case("off")
                || value.eq_ignore_ascii_case("none")
                || value.eq_ignore_ascii_case("disabled")
                || value == "0"
        }
    }
}

/// Default budget for an effort level, per family.
///
/// `None` means "this family does not translate effort into a numeric budget".
/// Explicit `thinking_budget` config still wins over this table (see
/// [`resolve_budget`]).
pub fn budget_for(family: ThinkingFamily, effort: Option<&ReasoningEffort>) -> Option<u32> {
    match family {
        ThinkingFamily::AnthropicLegacy => Some(match effort {
            Some(ReasoningEffort::Off) => 0,
            Some(ReasoningEffort::Low) => 2_048,
            Some(ReasoningEffort::Medium) => 8_192,
            Some(ReasoningEffort::High) => 16_384,
            Some(ReasoningEffort::XHigh) => 32_768,
            Some(ReasoningEffort::Max) => 65_536,
            Some(ReasoningEffort::Custom(value)) => {
                value.parse().unwrap_or(DEFAULT_ANTHROPIC_BUDGET)
            }
            None => DEFAULT_ANTHROPIC_BUDGET,
        }),
        ThinkingFamily::Gemini25 => Some(match effort {
            Some(ReasoningEffort::Off) => 0,
            Some(ReasoningEffort::Low) => 2_048,
            Some(ReasoningEffort::Medium) => 8_192,
            // Gemini 2.5's highest numeric tier is High; Max/XHigh collapse.
            Some(ReasoningEffort::High | ReasoningEffort::Max | ReasoningEffort::XHigh) => 16_384,
            Some(ReasoningEffort::Custom(value)) => value.parse().unwrap_or(DEFAULT_GEMINI_BUDGET),
            None => DEFAULT_GEMINI_BUDGET,
        }),
        // OpenAI-compatible families do NOT invent a numeric budget from
        // effort. A gateway that needs one must opt in via `thinking_budget`.
        _ => None,
    }
}

/// Resolve a numeric budget while preserving the invariant
/// `budget <= output_budget - MIN_ANSWER_TOKENS`.
///
/// Returns `None` when the family has no numeric budget, thinking is off, or
/// the output budget cannot fit a legal thinking budget plus answer room.
pub fn resolve_budget(
    family: ThinkingFamily,
    configured: Option<u32>,
    effort: Option<&ReasoningEffort>,
    output_budget: u32,
) -> Option<ThinkingBudget> {
    if !family.supports_numeric_budget() || is_effort_off(effort) {
        return None;
    }

    let requested = configured.or_else(|| budget_for(family, effort))?;
    if requested == 0 {
        return None;
    }

    let answer_room = output_budget.saturating_sub(MIN_ANSWER_TOKENS);
    if answer_room < family.min_budget() {
        return None;
    }

    let mut budget = requested.max(family.min_budget());
    if let Some(max) = family.max_budget() {
        budget = budget.min(max);
    }

    let clamped = budget != requested || budget > answer_room;
    budget = budget.min(answer_room);
    if budget < family.min_budget() {
        return None;
    }

    Some(ThinkingBudget {
        tokens: budget,
        clamped,
    })
}

/// Whether an Anthropic model requires adaptive thinking.
///
/// Claude 4.7+ and the 5.x family reject `thinking.type = "enabled"` with
/// `budget_tokens` (HTTP 400) and require `thinking.type = "adaptive"` plus
/// `output_config.effort`. Claude 4.6 and earlier keep the legacy manual mode.
pub fn anthropic_uses_adaptive_thinking(model: &str) -> bool {
    let model = model.trim().to_ascii_lowercase().replace('_', "-");
    let Some(rest) = model.split("claude").nth(1) else {
        return false;
    };

    let bytes = rest.as_bytes();
    let mut index = 0;
    while index < bytes.len() && !bytes[index].is_ascii_digit() {
        index += 1;
    }
    let major_start = index;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    let Ok(major) = rest[major_start..index].parse::<u32>() else {
        return false;
    };

    if major >= 5 {
        return true;
    }
    if major < 4 {
        return false;
    }

    // Minor must be a 1-2 digit version component. A longer run such as the
    // release date in `claude-opus-4-20250514` is not a minor version.
    let mut minor_start = index;
    if minor_start < bytes.len() && (bytes[minor_start] == b'.' || bytes[minor_start] == b'-') {
        minor_start += 1;
    }
    let mut minor_end = minor_start;
    while minor_end < bytes.len() && bytes[minor_end].is_ascii_digit() {
        minor_end += 1;
    }
    let minor_len = minor_end - minor_start;
    if minor_len == 1 || minor_len == 2 {
        rest[minor_start..minor_end]
            .parse::<u32>()
            .map(|minor| minor >= 7)
            .unwrap_or(false)
    } else {
        false
    }
}

/// Classify an Anthropic model into the legacy or adaptive family.
pub fn anthropic_family(model: &str) -> ThinkingFamily {
    if anthropic_uses_adaptive_thinking(model) {
        ThinkingFamily::AnthropicAdaptive
    } else {
        ThinkingFamily::AnthropicLegacy
    }
}

/// Classify a Gemini model into the budget (2.5) or level (3+) family.
pub fn gemini_family(model: &str) -> ThinkingFamily {
    if jeikcode_config::config::provider::gemini_uses_thinking_level(model) {
        ThinkingFamily::Gemini3Plus
    } else {
        ThinkingFamily::Gemini25
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_adaptive_generation_detection() {
        for model in [
            "claude-opus-4-7",
            "claude-opus-4.7",
            "claude-opus-4-8",
            "claude-opus-4.8",
            "claude-sonnet-5",
            "claude-4.7-opus",
            "claude-opus-5-5",
        ] {
            assert!(
                anthropic_uses_adaptive_thinking(model),
                "{model} must use adaptive thinking"
            );
        }
        for model in [
            "claude-sonnet-4-5",
            "claude-opus-4-6",
            "claude-3-7-sonnet",
            "claude-opus-4-20250514",
            "gpt-4o",
        ] {
            assert!(
                !anthropic_uses_adaptive_thinking(model),
                "{model} must keep legacy/manual thinking"
            );
        }
    }

    #[test]
    fn budget_is_clamped_to_answer_room_not_output_growth() {
        let plan = resolve_budget(
            ThinkingFamily::AnthropicLegacy,
            Some(32_768),
            Some(&ReasoningEffort::Max),
            6_000,
        )
        .expect("a legal budget must remain");
        assert_eq!(plan.tokens, 4_976);
        assert!(plan.clamped, "32K must shrink to fit a 6K output budget");
    }

    #[test]
    fn tiny_output_budget_disables_thinking_instead_of_sending_invalid_wire() {
        assert!(
            resolve_budget(ThinkingFamily::AnthropicLegacy, Some(16_384), None, 1_500,).is_none()
        );
    }

    #[test]
    fn openai_chat_has_no_default_budget_and_honors_explicit_one() {
        assert!(resolve_budget(
            ThinkingFamily::OpenAiChat,
            None,
            Some(&ReasoningEffort::High),
            65_536,
        )
        .is_none());
        let plan = resolve_budget(
            ThinkingFamily::OpenAiChat,
            Some(16_384),
            Some(&ReasoningEffort::High),
            65_536,
        )
        .expect("explicit gateway budget is honored");
        assert_eq!(plan.tokens, 16_384);
    }

    #[test]
    fn gemini_25_effort_table_collapses_max_to_high() {
        assert_eq!(
            budget_for(ThinkingFamily::Gemini25, Some(&ReasoningEffort::Max)),
            Some(16_384)
        );
        assert_eq!(
            budget_for(ThinkingFamily::Gemini25, Some(&ReasoningEffort::Medium)),
            Some(8_192)
        );
        assert_eq!(budget_for(ThinkingFamily::Gemini3Plus, None), None);
    }

    #[test]
    fn off_wins_over_every_default() {
        assert!(is_effort_off(Some(&ReasoningEffort::Off)));
        assert!(is_effort_off(Some(&ReasoningEffort::Custom("none".into()))));
        assert!(resolve_budget(
            ThinkingFamily::AnthropicLegacy,
            Some(16_384),
            Some(&ReasoningEffort::Off),
            65_536,
        )
        .is_none());
    }
}
