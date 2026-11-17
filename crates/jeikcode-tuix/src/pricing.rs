//! Model pricing — maps model names to per-million-token costs.

/// Returns (input_price, output_price) in USD per million tokens.
/// Uses substring matching to handle version suffixes (e.g. "claude-sonnet-4-20250514").
///
/// Match order matters: specific names (gpt-4o-mini, o1-mini) are tested
/// before their broader prefixes (gpt-4o, o1) to prevent premature hits.
/// This is tested by the ordering of the if-else chain — adding a new model
/// that is a substring of an existing one must go ABOVE the broader match.
/// Unknown models get a conservative (1.0, 3.0) fallback so cost tracking
/// never silently returns zero for a billable model.
pub fn cost_per_million(model: &str) -> (f64, f64) {
    if let Some((input, output)) = list_price(model).and_then(|p| Some((p.input?, p.output?))) {
        return (input, output);
    }
    let m = model.to_lowercase();
    // Claude
    if m.contains("opus") {
        (15.0, 75.0)
    } else if m.contains("sonnet") {
        (3.0, 15.0)
    } else if m.contains("haiku") {
        (0.25, 1.25)
    }
    // OpenAI (gpt-4o-mini must come before gpt-4o to avoid premature match)
    else if m.contains("gpt-4o-mini") {
        (0.15, 0.6)
    } else if m.contains("gpt-4o") {
        (2.5, 10.0)
    } else if m.contains("gpt-4.1") {
        (2.0, 8.0)
    }
    // o1/o3 mini must come before o1/o3 to avoid premature match
    else if m.contains("o1-mini") || m.contains("o3-mini") {
        (3.0, 12.0)
    } else if m.contains("o1") {
        (15.0, 60.0)
    } else if m.contains("o3") {
        (10.0, 40.0)
    }
    // DeepSeek
    else if m.contains("deepseek") {
        (0.27, 1.1)
    }
    // Qwen
    else if m.contains("qwen") {
        (0.5, 2.0)
    }
    // GLM / Zhipu
    else if m.contains("glm") {
        (0.5, 2.0)
    }
    // SiliconFlow / open models
    else if m.contains("llama") || m.contains("mistral") {
        (0.3, 0.6)
    }
    // MiniMax
    else if m.contains("minimax") || m.contains("m2.7") {
        (0.5, 2.0)
    }
    // Local / Ollama — free
    else if m.contains("ollama") {
        (0.0, 0.0)
    }
    // Unknown — conservative estimate
    else {
        (1.0, 3.0)
    }
}

/// The provider's list price for an exact Anthropic, OpenAI or Gemini model id
/// (dated snapshots and `provider/` prefixes included), from `llm-prices`.
/// Every row there cites the pricing page it was read from and the date.
fn list_price(model: &str) -> Option<&'static llm_prices::Price> {
    llm_prices::lookup(model).filter(|p| matches!(p.provider, "anthropic" | "openai" | "google"))
}

/// Calculate cost in USD from token counts and model name.
pub fn calculate_cost(
    model: &str,
    prompt_tokens: usize,
    completion_tokens: usize,
    cached_tokens: usize,
) -> f64 {
    let (input_price, output_price) = cost_per_million(model);
    // The listed cache-read price when there is one (0.5x input on gpt-4o,
    // 0.05x on Claude Opus 5.5); otherwise 90% off input.
    let cached_price = list_price(model)
        .and_then(|p| p.cache_read)
        .unwrap_or(input_price * 0.1);

    let input_cost = (prompt_tokens as f64 / 1_000_000.0) * input_price;
    let cached_cost = (cached_tokens as f64 / 1_000_000.0) * cached_price;
    let output_cost = (completion_tokens as f64 / 1_000_000.0) * output_price;

    input_cost + cached_cost + output_cost
}

/// Format cost as a human-readable string.
pub fn format_cost(cost: f64) -> String {
    if cost < 0.01 {
        format!("${:.4}", cost)
    } else {
        format!("${:.2}", cost)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_claude_sonnet_pricing() {
        let (i, o) = cost_per_million("claude-sonnet-4-20250514");
        assert_eq!(i, 3.0);
        assert_eq!(o, 15.0);
    }

    #[test]
    fn test_deepseek_pricing() {
        let (i, o) = cost_per_million("deepseek-chat");
        assert_eq!(i, 0.27);
        assert_eq!(o, 1.1);
    }

    #[test]
    fn test_gpt4o_pricing() {
        let (i, o) = cost_per_million("gpt-4o");
        assert_eq!(i, 2.5);
        assert_eq!(o, 10.0);
    }

    #[test]
    fn test_unknown_model() {
        let (i, o) = cost_per_million("some-unknown-model");
        assert_eq!(i, 1.0);
        assert_eq!(o, 3.0);
    }

    #[test]
    fn test_calculate_cost() {
        // 1000 prompt tokens + 500 completion tokens with deepseek
        let cost = calculate_cost("deepseek-chat", 1000, 500, 0);
        let expected = (1000.0 / 1_000_000.0) * 0.27 + (500.0 / 1_000_000.0) * 1.1;
        assert!((cost - expected).abs() < 1e-10);
    }

    #[test]
    fn test_calculate_cost_with_cache() {
        let cost = calculate_cost("claude-sonnet-4-20250514", 1000, 500, 800);
        // input: 1000 * 3.0/1M, cached: 800 * 0.3/1M, output: 500 * 15.0/1M
        let expected = 1000.0 * 3.0 / 1e6 + 800.0 * 0.3 / 1e6 + 500.0 * 15.0 / 1e6;
        assert!((cost - expected).abs() < 1e-10);
    }

    #[test]
    fn current_models_use_their_list_price() {
        // These used to hit the family arms: every Opus at $15/$75, every Haiku
        // at $0.25/$1.25, o3 at $10/$40, and GPT-5 models at the $1/$3 fallback.
        assert_eq!(cost_per_million("claude-opus-4-6"), (5.0, 25.0));
        assert_eq!(cost_per_million("claude-opus-5-5"), (4.0, 20.0));
        assert_eq!(cost_per_million("claude-haiku-4-5-20251001"), (1.0, 5.0));
        assert_eq!(cost_per_million("claude-sonnet-5-5"), (2.0, 10.0));
        assert_eq!(cost_per_million("o3"), (2.0, 8.0));
        assert_eq!(cost_per_million("gpt-5.5"), (5.0, 30.0));
        assert_eq!(cost_per_million("openai/gpt-5.4-mini"), (0.75, 4.5));
        // Ids outside the table keep the existing arms.
        assert_eq!(cost_per_million("claude-opus-9-preview"), (15.0, 75.0));
    }

    #[test]
    fn cached_tokens_use_the_listed_cache_read_price() {
        // gpt-4o lists cached input at $1.25 (half of input), not 10%.
        let cost = calculate_cost("gpt-4o", 0, 0, 1_000_000);
        assert!((cost - 1.25).abs() < 1e-10);
    }

    #[test]
    fn test_format_cost() {
        assert_eq!(format_cost(0.42), "$0.42");
        assert_eq!(format_cost(0.001), "$0.0010");
        assert_eq!(format_cost(12.5), "$12.50");
    }

    #[test]
    fn self_integrated_unknown_model_gets_nonzero_cost() {
        // The whole reason `/cost` exists alongside the gateway-only `/usage`:
        // it prices ANY model from local token accounting. An unknown /
        // self-integrated model must fall back to the conservative estimate,
        // never silently $0. (1.0 in / 3.0 out per M → 100k*1.0 + 50k*3.0.)
        let cost = calculate_cost("my-company-internal-llm-v2", 100_000, 50_000, 0);
        assert!(
            cost > 0.0,
            "self-integrated model must get the fallback price, not $0"
        );
    }
}
