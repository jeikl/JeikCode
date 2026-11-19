mod ar;
mod de;
mod en;
mod es;
mod fr;
mod ja;
mod ko;
mod messages;
mod ru;
#[cfg(test)]
mod terminal_tests;
mod vi;
#[cfg(test)]
mod vi_tests;
mod zh_cn;
mod zh_tw;

pub use crate::locale::Locale;
pub use messages::{ConfigSyncChange, Msg};

use std::borrow::Cow;
use std::sync::atomic::{AtomicU8, Ordering};

// Encoded representation: 0 = ZhCn, 1 = En, 2 = Vi.
static LOCALE: AtomicU8 = AtomicU8::new(Locale::En.as_u8());

/// Translate a message using the current global locale.
///
/// Returns a `Cow<'static, str>` — static for literal translations,
/// owned for interpolated ones.
pub fn t(msg: Msg<'_>) -> Cow<'static, str> {
    t_with(current_locale(), msg)
}

/// Look up against an explicit locale.
pub fn t_with(locale: Locale, msg: Msg<'_>) -> Cow<'static, str> {
    match locale {
        Locale::En => en::en(msg),
        Locale::Vi => vi::vi(msg),
        Locale::ZhCn => zh_cn::zh_cn(msg),
        Locale::ZhTw => zh_tw::zh_tw(msg),
        Locale::Ja => ja::ja(msg),
        Locale::Ko => ko::ko(msg),
        Locale::Ru => ru::ru(msg),
        Locale::Fr => fr::fr(msg),
        Locale::Es => es::es(msg),
        Locale::De => de::de(msg),
        Locale::Ar => ar::ar(msg),
    }
}

/// Return one atomic snapshot of the current UI language.
pub fn current_locale() -> Locale {
    Locale::from_u8(LOCALE.load(Ordering::Relaxed))
}

/// Switch the global locale used by [`t`].
pub fn set_locale(locale: Locale) {
    LOCALE.store(locale.as_u8(), Ordering::Relaxed);
}

/// Format a raw token count into a compact, scannable string for the
/// inter-turn divider. Large totals (e.g. `3672812`) are hard to read at a
/// glance, so we collapse them with `K` / `M` suffixes:
///   `< 1_000`        → `942`        (verbatim)
///   `>= 1_000`       → `3.67K`      (two decimals)
///   `>= 1_000_000`   → `3.67M`      (two decimals)
/// The caller appends the localised `tokens` word, so this returns only the
/// numeric part. Unit-agnostic across locales — the digits read the same.
pub fn fmt_tokens(n: usize) -> String {
    if n >= 1_000_000 {
        format!("{:.2}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.2}K", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

/// Format the localized marker shown after a committed compaction.
pub fn format_compaction_mark(
    removed_messages: usize,
    estimated_tokens_before: usize,
    estimated_tokens_after: usize,
) -> String {
    if removed_messages > 0 {
        let before = fmt_compaction_tokens(estimated_tokens_before);
        let after = fmt_compaction_tokens(estimated_tokens_after);
        t(Msg::CompactMarkDrain {
            messages: removed_messages,
            before: &before,
            after: &after,
        })
        .into_owned()
    } else {
        let saved =
            fmt_compaction_tokens(estimated_tokens_before.saturating_sub(estimated_tokens_after));
        t(Msg::CompactMarkStub { saved: &saved }).into_owned()
    }
}

/// Format the localized acknowledgement for a user-requested compaction that
/// left the conversation unchanged.
pub fn format_compaction_noop(
    estimated_tokens_before: usize,
    estimated_tokens_after: usize,
    summary_would_grow: bool,
) -> String {
    if summary_would_grow {
        let before = fmt_compaction_tokens(estimated_tokens_before);
        let after = fmt_compaction_tokens(estimated_tokens_after);
        t(Msg::CompactNothingNoSavings {
            before: &before,
            after: &after,
        })
        .into_owned()
    } else {
        t(Msg::CompactNothingShort).into_owned()
    }
}

/// Format the localized acknowledgement for an accepted compaction that was
/// interrupted by runtime replacement or shutdown.
pub fn format_compaction_interrupted() -> String {
    t(Msg::CompactInterrupted).into_owned()
}

pub fn format_agent_retry_empty(attempt: u32, max: u32, wait: u64) -> String {
    t(Msg::AgentRetryEmpty { attempt, max, wait }).into_owned()
}

pub fn format_agent_retry_thinking(attempt: u32, max: u32, wait: u64) -> String {
    t(Msg::AgentRetryThinking { attempt, max, wait }).into_owned()
}

pub fn format_agent_retry_malformed(attempt: u32, max: u32, wait: u64) -> String {
    t(Msg::AgentRetryMalformed { attempt, max, wait }).into_owned()
}

pub fn format_agent_retry_first_token(secs: u64, attempt: u32, max: u32) -> String {
    t(Msg::AgentRetryFirstToken { secs, attempt, max }).into_owned()
}

pub fn format_agent_retry_api(reason: &str, wait: u64, attempt: u32, max: u32) -> String {
    t(Msg::AgentRetryApi {
        reason,
        wait,
        attempt,
        max,
    })
    .into_owned()
}

pub fn format_agent_over_window(estimate_k: u32, window_k: u32, buffer_k: u32) -> String {
    t(Msg::AgentOverWindow {
        estimate_k,
        window_k,
        buffer_k,
    })
    .into_owned()
}

pub fn format_agent_echo_loop_nudge() -> String {
    t(Msg::AgentEchoLoopNudge).into_owned()
}

pub fn format_agent_echo_loop_warning() -> String {
    t(Msg::AgentEchoLoopWarning).into_owned()
}

pub fn format_agent_model_high_latency_terminal(retries: u32, secs: u64) -> String {
    t(Msg::AgentModelHighLatencyTerminal { retries, secs }).into_owned()
}

pub fn format_agent_exhausted_malformed(max: u32) -> String {
    t(Msg::AgentExhaustedMalformed { max }).into_owned()
}

pub fn format_agent_exhausted_thinking_over_window_intro(max: u32) -> String {
    t(Msg::AgentExhaustedThinkingOverWindowIntro { max }).into_owned()
}

pub fn format_agent_exhausted_thinking_over_window_size(
    max: u32,
    prompt_k: u32,
    window_k: u32,
) -> String {
    t(Msg::AgentExhaustedThinkingOverWindowSize {
        max,
        prompt_k,
        window_k,
    })
    .into_owned()
}

pub fn format_agent_exhausted_thinking_generic(max: u32) -> String {
    t(Msg::AgentExhaustedThinkingGeneric { max }).into_owned()
}

pub fn format_agent_exhausted_empty_over_window_intro(max: u32) -> String {
    t(Msg::AgentExhaustedEmptyOverWindowIntro { max }).into_owned()
}

pub fn format_agent_exhausted_empty_over_window_size(
    max: u32,
    prompt_k: u32,
    window_k: u32,
) -> String {
    t(Msg::AgentExhaustedEmptyOverWindowSize {
        max,
        prompt_k,
        window_k,
    })
    .into_owned()
}

pub fn format_agent_exhausted_empty_generic(max: u32) -> String {
    t(Msg::AgentExhaustedEmptyGeneric { max }).into_owned()
}

pub fn format_agent_status_rate_limited() -> String {
    t(Msg::AgentStatusRateLimited).into_owned()
}

pub fn format_agent_status_upstream_unavailable() -> String {
    t(Msg::AgentStatusUpstreamUnavailable).into_owned()
}

pub fn format_agent_status_response_timeout() -> String {
    t(Msg::AgentStatusResponseTimeout).into_owned()
}

pub fn format_agent_status_connection_failed() -> String {
    t(Msg::AgentStatusConnectionFailed).into_owned()
}

pub fn format_agent_status_insufficient_balance() -> String {
    t(Msg::AgentStatusInsufficientBalance).into_owned()
}

pub fn format_agent_status_unauthorized() -> String {
    t(Msg::AgentStatusUnauthorized).into_owned()
}

pub fn format_stream_read_retry_exhausted(attempts: u32) -> String {
    t(Msg::StreamReadRetryExhausted { attempts }).into_owned()
}

pub fn format_stream_read_partial_response() -> String {
    t(Msg::StreamReadPartialResponse).into_owned()
}

pub fn format_stream_read_interrupted() -> String {
    t(Msg::StreamReadInterrupted).into_owned()
}

/// 统一重试提示：一次故障只发一条，后续重试静默。
pub fn format_agent_auto_retry(max: u32) -> String {
    t(Msg::AgentAutoRetry { max }).into_owned()
}

/// 重试进度：`重试 x/9 次`。
pub fn format_agent_retry_progress(attempt: u32, max: u32) -> String {
    t(Msg::AgentRetryProgress { attempt, max }).into_owned()
}

/// 流空闲超时重试进度。
pub fn format_agent_retry_stall_progress(attempt: u32, max: u32, has_output: bool) -> String {
    t(Msg::AgentRetryStallProgress {
        attempt,
        max,
        has_output,
    })
    .into_owned()
}

/// 连接中断重试进度。
pub fn format_agent_retry_drop_progress(attempt: u32, max: u32, has_output: bool) -> String {
    t(Msg::AgentRetryDropProgress {
        attempt,
        max,
        has_output,
    })
    .into_owned()
}

/// 重试恢复成功收口文案。
pub fn format_agent_retry_recovered(attempts: u32) -> String {
    t(Msg::AgentRetryRecovered { attempts }).into_owned()
}

/// Echo 循环告警通知文案（人类可见，模型仍接收纯英文 nudge）。
pub fn format_agent_echo_loop_notice(final_warning: bool) -> String {
    t(Msg::AgentEchoLoopNotice { final_warning }).into_owned()
}

/// Echo 循环触发硬终止文案。
pub fn format_agent_echo_loop_terminal(rounds: u32) -> String {
    t(Msg::AgentEchoLoopTerminal { rounds }).into_owned()
}

/// 精确工具循环预警文案。
pub fn format_agent_tool_loop_warning(threshold: u32) -> String {
    t(Msg::AgentToolLoopWarning { threshold }).into_owned()
}

/// 精确工具循环触顶终止文案。
pub fn format_agent_tool_loop_terminal(threshold: u32) -> String {
    t(Msg::AgentToolLoopTerminal { threshold }).into_owned()
}

/// 重复工具调用模式触发硬终止文案。
pub fn format_agent_repeat_loop_terminal(rounds: u32) -> String {
    t(Msg::AgentRepeatLoopTerminal { rounds }).into_owned()
}

/// 自动重连耗尽后的流超时终态文案。
pub fn format_agent_stream_timeout_terminal() -> String {
    t(Msg::AgentStreamTimeoutTerminal).into_owned()
}

/// 429 自动退避等待文案。
pub fn format_agent_rate_limited_waiting(secs: u64) -> String {
    t(Msg::AgentRateLimitedWaiting { secs }).into_owned()
}

/// 429 暂停终态文案。
pub fn format_agent_rate_limited_paused(detail: &str) -> String {
    t(Msg::AgentRateLimitedPaused { detail }).into_owned()
}

/// 响应被截断提示文案。
pub fn format_agent_response_truncated() -> String {
    t(Msg::AgentResponseTruncated).into_owned()
}

/// 回合中上下文溢出触发压缩重试的提示文案。
pub fn format_agent_context_overflow(round: u32, attempt: u32) -> String {
    t(Msg::AgentContextOverflow { round, attempt }).into_owned()
}

/// 恢复会话遇到不支持快照版本时的降级提示文案。
pub fn format_agent_unsupported_snapshot(version: u32, supported: u32) -> String {
    t(Msg::AgentUnsupportedSnapshot { version, supported }).into_owned()
}

/// 已产生部分回复后流超时（终态）。
pub fn format_agent_stream_timeout_partial_response() -> String {
    t(Msg::AgentStreamTimeoutPartialResponse).into_owned()
}

pub fn format_stream_read_reset_hint() -> String {
    t(Msg::StreamReadResetHint).into_owned()
}

pub fn format_stream_read_details_prefix() -> String {
    t(Msg::StreamReadDetailsPrefix).into_owned()
}

fn fmt_compaction_tokens(tokens: usize) -> String {
    if tokens >= 1_000 {
        format!("{:.1}K", tokens as f64 / 1_000.0)
    } else {
        tokens.to_string()
    }
}

/// Determine the initial locale:
///   1. CLI `--lang` flag (if valid)
///   2. Config file `language` field (if explicitly configured)
///   3. OS environment detection (`LC_ALL`, `LC_MESSAGES`, `LANG`, Windows LocaleName) on unconfigured first run
///   4. Fallback to English baseline (`Locale::En`)
pub fn resolve_initial_locale(cli_lang: Option<&str>, config_lang: Option<Locale>) -> Locale {
    resolve_initial_locale_with_sources(
        cli_lang,
        config_lang,
        &|k| std::env::var(k).ok(),
        &get_native_os_locale,
    )
}

#[doc(hidden)]
pub fn resolve_initial_locale_with_env(
    cli_lang: Option<&str>,
    config_lang: Option<Locale>,
    env: &dyn Fn(&str) -> Option<String>,
) -> Locale {
    resolve_initial_locale_with_sources(cli_lang, config_lang, env, &|| None)
}

#[doc(hidden)]
pub fn resolve_initial_locale_with_sources(
    cli_lang: Option<&str>,
    config_lang: Option<Locale>,
    env: &dyn Fn(&str) -> Option<String>,
    native_os: &dyn Fn() -> Option<String>,
) -> Locale {
    if let Some(s) = cli_lang {
        if let Ok(loc) = s.parse::<Locale>() {
            return loc;
        }
    }
    if let Some(loc) = config_lang {
        return loc;
    }
    // 1. Check standard environment variables (POSIX, terminals, WSL, macOS, Linux)
    for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Some(val) = env(key) {
            if !val.trim().is_empty() {
                return classify_env_locale(&val);
            }
        }
    }
    // 2. Check native OS user UI language (e.g. Windows International LocaleName)
    if let Some(os_locale) = native_os() {
        if !os_locale.trim().is_empty() {
            return classify_env_locale(&os_locale);
        }
    }
    // 3. Fallback to English baseline
    Locale::En
}

#[cfg(windows)]
fn get_native_os_locale() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(key) = hkcu.open_subkey("Control Panel\\International") {
        if let Ok(locale_name) = key.get_value::<String, _>("LocaleName") {
            let trimmed = locale_name.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn get_native_os_locale() -> Option<String> {
    // Read AppleLocale from macOS global preferences
    if let Ok(output) = std::process::Command::new("defaults")
        .args(["read", "-g", "AppleLocale"])
        .output()
    {
        if output.status.success() {
            let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    None
}

#[cfg(all(unix, not(target_os = "macos")))]
fn get_native_os_locale() -> Option<String> {
    // Read system-wide locale configurations (Linux/Unix systemd & distribution paths)
    for path in ["/etc/locale.conf", "/etc/default/locale"] {
        if let Ok(content) = std::fs::read_to_string(path) {
            for line in content.lines() {
                let trimmed = line.trim();
                if let Some(val) = trimmed.strip_prefix("LANG=") {
                    let cleaned = val.trim_matches('"').trim_matches('\'').trim();
                    if !cleaned.is_empty() {
                        return Some(cleaned.to_string());
                    }
                }
            }
        }
    }
    None
}

#[cfg(not(any(windows, unix)))]
fn get_native_os_locale() -> Option<String> {
    None
}

fn classify_env_locale(value: &str) -> Locale {
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("zh_tw")
        || lower.starts_with("zh-tw")
        || lower.starts_with("zh_hk")
        || lower.starts_with("zh-hk")
        || lower.starts_with("zh_hant")
        || lower.starts_with("zh-hant")
    {
        Locale::ZhTw
    } else if lower == "zh"
        || lower.starts_with("zh_")
        || lower.starts_with("zh-")
        || lower.starts_with("zh.")
    {
        Locale::ZhCn
    } else if lower == "ja"
        || lower.starts_with("ja_")
        || lower.starts_with("ja-")
        || lower.starts_with("ja.")
    {
        Locale::Ja
    } else if lower == "ko"
        || lower.starts_with("ko_")
        || lower.starts_with("ko-")
        || lower.starts_with("ko.")
    {
        Locale::Ko
    } else if lower == "ru"
        || lower.starts_with("ru_")
        || lower.starts_with("ru-")
        || lower.starts_with("ru.")
    {
        Locale::Ru
    } else if lower == "fr"
        || lower.starts_with("fr_")
        || lower.starts_with("fr-")
        || lower.starts_with("fr.")
    {
        Locale::Fr
    } else if lower == "es"
        || lower.starts_with("es_")
        || lower.starts_with("es-")
        || lower.starts_with("es.")
    {
        Locale::Es
    } else if lower == "de"
        || lower.starts_with("de_")
        || lower.starts_with("de-")
        || lower.starts_with("de.")
    {
        Locale::De
    } else if lower == "ar"
        || lower.starts_with("ar_")
        || lower.starts_with("ar-")
        || lower.starts_with("ar.")
    {
        Locale::Ar
    } else if lower == "vi"
        || lower.starts_with("vi_")
        || lower.starts_with("vi-")
        || lower.starts_with("vi.")
    {
        Locale::Vi
    } else {
        Locale::En
    }
}

/// Serialization lock for tests that mutate the global locale.
/// Prevents test races when multiple tests call `set_locale`, AND
/// restores the original locale on guard drop so a test that flips
/// to `ZhCn` doesn't leak into the next test that assumes the
/// default `En`.
///
/// Exposed unconditionally (not `#[cfg(test)]`-gated) because tests in
/// downstream crates (jeikcode-tuix, etc.) need to take this lock too,
/// and `cfg(test)` only applies to the crate currently being tested.
/// The lock is a `OnceLock` so it costs nothing at runtime until first
/// use.
///
/// Return value is a custom guard that:
///   1. Owns the underlying `MutexGuard<'static, ()>` so the lock is
///      released when it drops.
///   2. Captures `current_locale()` at construction.
///   3. Restores that captured locale in its own `Drop` (runs BEFORE
///      the inner MutexGuard's Drop, since fields drop in declaration
///      order — so the next test sees the restored locale AND the
///      lock is still held while restoration happens).
pub fn test_lock() -> LocaleTestGuard {
    use std::sync::{Mutex, OnceLock};
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    // Recover from a poisoned mutex (a previous test panicked while
    // holding the guard). The locale value the panicking test wrote
    // is irrelevant — we restore from `current_locale()` next, and
    // each test sets its own desired locale immediately after taking
    // the lock. Without this, one panicking test would cascade and
    // fail every subsequent locale-touching test with PoisonError.
    let guard = LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let original = current_locale();
    LocaleTestGuard {
        original,
        _guard: guard,
    }
}

/// RAII guard returned by `test_lock()`. Holds the serialisation
/// mutex AND restores the locale that was current at lock-acquire
/// time. Field declaration order matters: `original` (with its
/// `Drop` impl below) drops before `_guard`, so the locale is
/// restored while the lock is still held — the next waiter never
/// sees a transient mixed state.
pub struct LocaleTestGuard {
    original: Locale,
    _guard: std::sync::MutexGuard<'static, ()>,
}

impl Drop for LocaleTestGuard {
    fn drop(&mut self) {
        set_locale(self.original);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fmt_tokens_scales_with_magnitude() {
        // < 1_000 → verbatim, no suffix.
        assert_eq!(fmt_tokens(0), "0");
        assert_eq!(fmt_tokens(942), "942");
        assert_eq!(fmt_tokens(999), "999");
        // >= 1_000 → K with two decimals.
        assert_eq!(fmt_tokens(1_000), "1.00K");
        assert_eq!(fmt_tokens(1_696), "1.70K");
        assert_eq!(fmt_tokens(999_999), "1000.00K");
        // >= 1_000_000 → M with two decimals.
        assert_eq!(fmt_tokens(1_000_000), "1.00M");
        assert_eq!(fmt_tokens(3_672_812), "3.67M");
    }

    #[test]
    fn t_with_returns_english_for_en() {
        let s = t_with(Locale::En, Msg::WelcomeBannerLine1);
        assert!(s.starts_with("Welcome to JeikCode"));
    }

    #[test]
    fn t_with_returns_chinese_for_zh_cn() {
        let s = t_with(Locale::ZhCn, Msg::WelcomeBannerLine1);
        assert!(s.starts_with("欢迎使用 JeikCode"));
    }

    #[test]
    fn set_locale_flips_global() {
        let _g = test_lock();
        set_locale(Locale::ZhCn);
        assert_eq!(current_locale(), Locale::ZhCn);
        let s = t(Msg::WelcomeBannerLine1);
        assert!(s.starts_with("欢迎使用"));

        set_locale(Locale::En);
        assert_eq!(current_locale(), Locale::En);
        let s = t(Msg::WelcomeBannerLine1);
        assert!(s.starts_with("Welcome to JeikCode"));
    }

    #[test]
    fn err_unsupported_locale_includes_input() {
        let s = t_with(Locale::En, Msg::ErrUnsupportedLocale { input: "fr" });
        assert!(s.contains("fr"));
        let s = t_with(Locale::ZhCn, Msg::ErrUnsupportedLocale { input: "fr" });
        assert!(s.contains("fr"));
    }

    fn has_cjk(s: &str) -> bool {
        s.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
    }

    #[test]
    fn turn_summary_appends_cached_pct_only_when_present() {
        let with = t_with(
            Locale::En,
            Msg::TurnSummary {
                done: "Dialed in",
                turn_count: 30,
                tool_call_count: 32,
                duration: "435.3s",
                total_tokens: 152_000,
                cached_pct: Some(97),
            },
        );
        assert!(with.contains("152.00K tokens · 97% cache"), "got: {with}");
        let without = t_with(
            Locale::En,
            Msg::TurnSummary {
                done: "Dialed in",
                turn_count: 30,
                tool_call_count: 32,
                duration: "435.3s",
                total_tokens: 152_000,
                cached_pct: None,
            },
        );
        assert!(
            without.trim_end().ends_with("152.00K tokens"),
            "got: {without}"
        );
        assert!(
            !without.contains("cached"),
            "no annotation when None: {without}"
        );
    }

    #[test]
    fn gateway_auth_unavailable_is_localized_and_keeps_url() {
        let url = "";
        let en = t_with(Locale::En, Msg::GatewayAuthUnavailable { base_url: url });
        assert!(en.contains(url), "EN must echo the base_url: {en}");
        assert!(en.to_lowercase().contains("gateway"), "EN keyword: {en}");
        let zh = t_with(Locale::ZhCn, Msg::GatewayAuthUnavailable { base_url: url });
        assert!(zh.contains(url), "ZH must echo the base_url: {zh}");
        assert!(has_cjk(&zh), "ZH must actually be Chinese: {zh}");
    }

    #[test]
    fn provider_init_frame_keeps_detail_both_locales() {
        let en = t_with(Locale::En, Msg::ProviderInitFailed { detail: "DETAIL_X" });
        assert!(en.contains("DETAIL_X"));
        let zh = t_with(Locale::ZhCn, Msg::ProviderInitFailed { detail: "DETAIL_X" });
        assert!(zh.contains("DETAIL_X"));
        assert!(has_cjk(&zh), "ZH frame must be Chinese: {zh}");
    }

    #[test]
    fn plugin_manager_empty_hints_advertise_esc() {
        // Regression: every plugin-manager screen advertises Esc-to-go-back in
        // its hint, EXCEPT these empty-state hints once did not — so an empty
        // list (e.g. /plugin → Installed with 0 plugins) looked frozen with no
        // visible way out. Keep the Esc affordance on the empty states too.
        fn has_esc(s: &str) -> bool {
            s.to_lowercase().contains("esc")
        }
        for (en, zh) in [
            (
                t_with(Locale::En, Msg::PluginMgrEmptyInstalled),
                t_with(Locale::ZhCn, Msg::PluginMgrEmptyInstalled),
            ),
            (
                t_with(Locale::En, Msg::PluginMgrEmptyMarketplaces),
                t_with(Locale::ZhCn, Msg::PluginMgrEmptyMarketplaces),
            ),
            (
                t_with(Locale::En, Msg::PluginMgrEmptyPlugins),
                t_with(Locale::ZhCn, Msg::PluginMgrEmptyPlugins),
            ),
        ] {
            assert!(has_esc(&en), "EN empty hint missing esc: {en}");
            assert!(has_esc(&zh), "ZH empty hint missing esc: {zh}");
        }
    }

    #[test]
    fn cli_flag_wins_over_everything() {
        let env = |_: &str| Some("zh_CN.UTF-8".to_string());
        assert_eq!(
            resolve_initial_locale_with_env(Some("en"), Some(Locale::ZhCn), &env),
            Locale::En
        );
    }

    #[test]
    fn config_beats_env() {
        let env = |_: &str| Some("zh_CN.UTF-8".to_string());
        assert_eq!(
            resolve_initial_locale_with_env(None, Some(Locale::En), &env),
            Locale::En
        );
    }

    #[test]
    fn env_zh_cn_resolves_to_zh_cn() {
        let env = |k: &str| {
            if k == "LANG" {
                Some("zh_CN.UTF-8".into())
            } else {
                None
            }
        };
        assert_eq!(
            resolve_initial_locale_with_env(None, None, &env),
            Locale::ZhCn
        );
    }

    #[test]
    fn native_os_locale_detects_chinese_and_vietnamese_when_env_empty() {
        let env_empty = |_: &str| None;
        let os_zh = || Some("zh-CN".to_string());
        let os_vi = || Some("vi-VN".to_string());
        let os_unsupported = || Some("it-IT".to_string());

        assert_eq!(
            resolve_initial_locale_with_sources(None, None, &env_empty, &os_zh),
            Locale::ZhCn
        );
        assert_eq!(
            resolve_initial_locale_with_sources(None, None, &env_empty, &os_vi),
            Locale::Vi
        );
        assert_eq!(
            resolve_initial_locale_with_sources(None, None, &env_empty, &os_unsupported),
            Locale::En
        );
    }

    #[test]
    fn env_zh_tw_resolves_to_zh_tw() {
        let env = |k: &str| {
            if k == "LANG" {
                Some("zh_TW".into())
            } else {
                None
            }
        };
        assert_eq!(
            resolve_initial_locale_with_env(None, None, &env),
            Locale::ZhTw
        );
    }

    #[test]
    fn env_vi_vn_resolves_to_vi() {
        let env = |k: &str| {
            if k == "LANG" {
                Some("vi_VN.UTF-8".into())
            } else {
                None
            }
        };
        assert_eq!(
            resolve_initial_locale_with_env(None, None, &env),
            Locale::Vi
        );
    }

    #[test]
    fn env_unsupported_falls_back_to_en() {
        let env = |k: &str| {
            if k == "LANG" {
                Some("it_IT.UTF-8".into())
            } else {
                None
            }
        };
        assert_eq!(
            resolve_initial_locale_with_env(None, None, &env),
            Locale::En
        );
    }

    #[test]
    fn env_c_or_english_resolves_to_en() {
        let mk = |val: &'static str| {
            move |k: &str| {
                if k == "LANG" {
                    Some(val.to_string())
                } else {
                    None
                }
            }
        };
        assert_eq!(
            resolve_initial_locale_with_env(None, None, &mk("C")),
            Locale::En
        );
        assert_eq!(
            resolve_initial_locale_with_env(None, None, &mk("en_US.UTF-8")),
            Locale::En
        );
        assert_eq!(
            resolve_initial_locale_with_env(None, None, &mk("")),
            Locale::En
        );
    }

    #[test]
    fn env_no_locale_vars_resolves_to_en() {
        let env = |_: &str| None;
        assert_eq!(
            resolve_initial_locale_with_env(None, None, &env),
            Locale::En
        );
    }

    #[test]
    fn lc_all_overrides_lc_messages_and_lang() {
        let env = |k: &str| match k {
            "LC_ALL" => Some("zh_CN.UTF-8".into()),
            "LANG" => Some("en_US.UTF-8".into()),
            _ => None,
        };
        assert_eq!(
            resolve_initial_locale_with_env(None, None, &env),
            Locale::ZhCn
        );
    }

    #[test]
    fn lc_messages_overrides_lang() {
        let env = |k: &str| match k {
            "LC_MESSAGES" => Some("vi_VN.UTF-8".into()),
            "LANG" => Some("en_US.UTF-8".into()),
            _ => None,
        };
        assert_eq!(
            resolve_initial_locale_with_env(None, None, &env),
            Locale::Vi
        );
    }

    #[test]
    fn compact_mark_drain_renders_numbers_and_arrow() {
        // Locale-invariant assertion (numbers + the → arrow appear in both en & zh).
        let s = crate::i18n::t(crate::i18n::Msg::CompactMarkDrain {
            messages: 12,
            before: "48.2K",
            after: "9.1K",
        });
        assert!(s.contains("12"), "message count missing: {s}");
        assert!(
            s.contains("48.2K") && s.contains("9.1K"),
            "token figures missing: {s}"
        );
        assert!(s.contains('→'), "before→after arrow missing: {s}");
        assert!(s.contains('~'), "estimate marker missing: {s}");
        assert!(s.contains("tok"), "token unit missing: {s}");
    }

    #[test]
    fn compact_mark_stub_renders_saved_without_arrow() {
        let s = crate::i18n::t(crate::i18n::Msg::CompactMarkStub { saved: "6.0K" });
        assert!(s.contains("6.0K"), "saved figure missing: {s}");
        assert!(
            !s.contains('→'),
            "stub marker shows a single figure, no arrow: {s}"
        );
        assert!(s.contains("tok"), "token unit missing: {s}");
    }

    #[test]
    fn format_compaction_mark_renders_drain_estimates() {
        let s = format_compaction_mark(129, 42_900, 11_103);

        assert!(s.contains("129") && s.contains("42.9K") && s.contains("11.1K"));
    }

    #[test]
    fn format_compaction_mark_renders_stub_savings() {
        let s = format_compaction_mark(0, 42_900, 34_320);

        assert!(s.contains("8.6K") && !s.contains('→'));
    }

    #[test]
    fn format_compaction_noop_distinguishes_net_loss() {
        let s = format_compaction_noop(5_000, 7_500, true);

        assert!(s.contains("5.0K") && s.contains("7.5K") && s.contains('→'));
    }

    #[test]
    fn format_compaction_interrupted_is_not_a_noop_message() {
        let s = format_compaction_interrupted();

        assert!(s.contains("interrupt") || s.contains("中断"));
        assert!(!s.contains("nothing to compact") && !s.contains("无需压缩"));
    }

    #[test]
    fn cli_flag_unparseable_falls_through() {
        let env = |_: &str| None;
        assert_eq!(
            resolve_initial_locale_with_env(Some("xx_unsupported"), Some(Locale::ZhCn), &env),
            Locale::ZhCn
        );
        assert_eq!(
            resolve_initial_locale_with_env(Some("xx_unsupported"), None, &env),
            Locale::En
        );
    }

    #[test]
    fn todo_panel_labels_render() {
        // Default locale (En); exact copy is locale-dependent, assert non-empty + digit.
        assert!(!t(Msg::TodoPanelTitle).is_empty());
        assert!(t(Msg::TodoPanelCompleted { n: 3 }).contains('3'));
        assert!(t(Msg::TodoPanelMore { n: 2 }).contains('2'));
    }

    #[test]
    fn welcome_tip_descriptions_present_both_langs() {
        // Check a representative subset of the new welcome-tips variants in both locales.
        macro_rules! check {
            ($variant:expr) => {{
                let en = t_with(Locale::En, $variant);
                assert!(!en.is_empty(), "EN empty for {}", stringify!($variant));
                let zh = t_with(Locale::ZhCn, $variant);
                assert!(!zh.is_empty(), "ZH empty for {}", stringify!($variant));
            }};
        }
        check!(Msg::WelcomeTipsHeading);
        check!(Msg::WelcomeTipProvider);
        check!(Msg::WelcomeTipGoal);
        check!(Msg::WelcomeTipLoop);
        check!(Msg::WelcomeTipSession);
        check!(Msg::WelcomeTipInit);
    }

    #[test]
    fn model_copy_explains_default_and_current_session_scope() {
        let en_desc = t_with(Locale::En, Msg::CmdDescModel);
        let zh_desc = t_with(Locale::ZhCn, Msg::CmdDescModel);
        assert!(en_desc.contains("default") && en_desc.contains("this session"));
        assert!(zh_desc.contains("默认") && zh_desc.contains("当前会话"));

        let en_switched = t_with(
            Locale::En,
            Msg::ModelSwitchedAndDefault {
                provider: "provider",
                model: "model",
            },
        );
        let zh_switched = t_with(
            Locale::ZhCn,
            Msg::ModelSwitchedAndDefault {
                provider: "provider",
                model: "model",
            },
        );
        assert!(en_switched.contains("default for new sessions"));
        assert!(zh_switched.contains("新会话默认"));

        let ephemeral = t_with(
            Locale::En,
            Msg::ModelSwitched {
                provider: "provider",
                model: "model",
            },
        );
        assert!(ephemeral.contains("this session"));
        assert!(!ephemeral.contains("default"));
    }

    #[test]
    fn provider_panel_copy_is_localized_in_both_languages() {
        let en_tabs = (
            t_with(Locale::En, Msg::ProviderPanelTabAccounts),
            t_with(Locale::En, Msg::ProviderPanelTabModels),
        );
        let zh_tabs = (
            t_with(Locale::ZhCn, Msg::ProviderPanelTabAccounts),
            t_with(Locale::ZhCn, Msg::ProviderPanelTabModels),
        );
        assert_eq!(en_tabs.0, "Accounts");
        assert_eq!(en_tabs.1, "Models");
        assert_eq!(zh_tabs.0, "账号");
        assert_eq!(zh_tabs.1, "模型");

        let en_hint = t_with(Locale::En, Msg::ProviderPanelAccountsHint);
        let zh_hint = t_with(Locale::ZhCn, Msg::ProviderPanelAccountsHint);
        assert!(en_hint.contains("add") && en_hint.contains("delete"));
        assert!(zh_hint.contains("添加") && zh_hint.contains("删除"));
        assert!(en_hint.contains("Ctrl+Dx2"));
        assert!(zh_hint.contains("Ctrl+Dx2"));
        assert!(en_hint.contains("Ctrl+A") && en_hint.contains("Ctrl+E"));
        assert!(zh_hint.contains("Ctrl+A") && zh_hint.contains("Ctrl+E"));
        assert_eq!(
            t_with(Locale::En, Msg::ProviderPanelAddModelRow),
            "+ Add model"
        );
        assert_eq!(
            t_with(Locale::ZhCn, Msg::ProviderPanelAddModelRow),
            "＋ 添加模型"
        );
        assert_eq!(
            t_with(Locale::En, Msg::ProviderPanelAddProviderRow),
            "+ Add custom provider"
        );
        assert_eq!(
            t_with(Locale::ZhCn, Msg::ProviderPanelAddProviderRow),
            "＋ 添加自定义 provider"
        );
        assert_eq!(t_with(Locale::En, Msg::ProviderPanelFieldName), "Name");
        assert_eq!(t_with(Locale::ZhCn, Msg::ProviderPanelFieldName), "名称");
        assert_eq!(
            t_with(Locale::En, Msg::ProviderPanelFieldProtocol),
            "Protocol"
        );
        assert_eq!(
            t_with(Locale::ZhCn, Msg::ProviderPanelFieldProtocol),
            "协议"
        );
        assert_eq!(t_with(Locale::En, Msg::ProviderPanelRequired), "(required)");
        assert_eq!(t_with(Locale::ZhCn, Msg::ProviderPanelRequired), "(必填)");
        assert_eq!(t_with(Locale::En, Msg::ProviderPanelLocked), "(locked)");
        assert_eq!(t_with(Locale::ZhCn, Msg::ProviderPanelLocked), "(锁定)");
        assert_eq!(
            t_with(Locale::En, Msg::ProviderPanelAddTitle),
            "[Add provider]"
        );
        assert_eq!(
            t_with(Locale::ZhCn, Msg::ProviderPanelAddTitle),
            "【添加 Provider】"
        );
        assert_eq!(
            t_with(Locale::En, Msg::ProviderPanelEmptyAccounts),
            "(No providers yet — press Ctrl+A to add one)"
        );
        assert_eq!(
            t_with(Locale::ZhCn, Msg::ProviderPanelEmptyAccounts),
            "（尚无 Provider — 按 Ctrl+A 添加）"
        );

        assert_eq!(
            t_with(Locale::En, Msg::ProviderPanelEmptyModels),
            "(No models yet — press Ctrl+A to add one; fetches upstream /models)"
        );
        assert_eq!(
            t_with(Locale::ZhCn, Msg::ProviderPanelEmptyModels),
            "（尚无模型 — 按 Ctrl+A 添加，将拉取上游 /models）"
        );

        assert_eq!(
            t_with(
                Locale::En,
                Msg::ProviderPanelModelSaved {
                    model: "deepseek-chat"
                }
            ),
            "Saved model \"deepseek-chat\"."
        );
        assert_eq!(
            t_with(
                Locale::ZhCn,
                Msg::ProviderPanelModelSaved {
                    model: "deepseek-chat"
                }
            ),
            "已保存模型“deepseek-chat”。"
        );
        assert_eq!(
            t_with(Locale::En, Msg::ProviderPanelImageDirectWhileVlSet),
            "Images go to this model; turn off image input to use VL."
        );
        assert_eq!(
            t_with(Locale::ZhCn, Msg::ProviderPanelImageDirectWhileVlSet),
            "贴图将直发本模型；要用 VL 请关闭「支持图片输入」。"
        );

        let en_row = t_with(Locale::En, Msg::ProviderPanelModelCount { count: 3 });
        let zh_row = t_with(Locale::ZhCn, Msg::ProviderPanelModelCount { count: 3 });
        assert_eq!(en_row, "3 models");
        assert_eq!(zh_row, "3 个模型");

        assert!(!t_with(Locale::En, Msg::ProviderPanelModelPlaceholder).is_empty());
        assert!(!t_with(Locale::ZhCn, Msg::ProviderPanelModelPlaceholder).is_empty());
        assert!(!t_with(Locale::En, Msg::ProviderPanelUpstreamListLabel).is_empty());
        assert!(!t_with(Locale::ZhCn, Msg::ProviderPanelUpstreamListLabel).is_empty());
        assert!(t_with(Locale::En, Msg::ProviderPanelUpstreamLoaded { n: 4 }).contains("4"));
        assert!(t_with(
            Locale::ZhCn,
            Msg::ProviderPanelUpstreamFailed { error: "HTTP 401" }
        )
        .contains("401"));
    }

    #[test]
    fn system_notice_messages_localized_across_all_supported_locales() {
        let cases: &[Msg<'_>] = &[
            Msg::AgentRetryEmpty {
                attempt: 2,
                max: 6,
                wait: 5,
            },
            Msg::AgentRetryThinking {
                attempt: 2,
                max: 6,
                wait: 0,
            },
            Msg::AgentRetryMalformed {
                attempt: 3,
                max: 6,
                wait: 10,
            },
            Msg::AgentRetryFirstToken {
                secs: 45,
                attempt: 2,
                max: 6,
            },
            Msg::AgentRetryApi {
                reason: "503",
                wait: 5,
                attempt: 2,
                max: 9,
            },
            Msg::AgentOverWindow {
                estimate_k: 180,
                window_k: 200,
                buffer_k: 20,
            },
            Msg::AgentContextOverflow {
                round: 3,
                attempt: 1,
            },
            Msg::AgentStreamReconnecting { attempt: 2, max: 9 },
            Msg::AgentResponseTruncated,
            Msg::AgentUnsupportedSnapshot {
                version: 99,
                supported: 2,
            },
            Msg::AgentModelHighLatencyTerminal {
                retries: 6,
                secs: 45,
            },
            Msg::AgentExhaustedMalformed { max: 6 },
            Msg::AgentExhaustedThinkingOverWindowIntro { max: 6 },
            Msg::AgentExhaustedThinkingOverWindowSize {
                max: 6,
                prompt_k: 190,
                window_k: 200,
            },
            Msg::AgentExhaustedThinkingGeneric { max: 6 },
            Msg::AgentExhaustedEmptyOverWindowIntro { max: 6 },
            Msg::AgentExhaustedEmptyOverWindowSize {
                max: 6,
                prompt_k: 190,
                window_k: 200,
            },
            Msg::AgentExhaustedEmptyGeneric { max: 6 },
            Msg::AgentStatusRateLimited,
            Msg::AgentStatusUpstreamUnavailable,
            Msg::AgentStatusResponseTimeout,
            Msg::AgentStatusConnectionFailed,
            Msg::AgentStatusInsufficientBalance,
            Msg::AgentStatusUnauthorized,
            Msg::StreamReadRetryExhausted { attempts: 9 },
            Msg::StreamReadPartialResponse,
            Msg::StreamReadInterrupted,
            Msg::AgentAutoRetry { max: 9 },
            Msg::AgentRetryProgress { attempt: 2, max: 9 },
            Msg::AgentRetryStallProgress {
                attempt: 2,
                max: 9,
                has_output: true,
            },
            Msg::AgentRetryStallProgress {
                attempt: 2,
                max: 9,
                has_output: false,
            },
            Msg::AgentRetryDropProgress {
                attempt: 3,
                max: 9,
                has_output: true,
            },
            Msg::AgentRetryDropProgress {
                attempt: 3,
                max: 9,
                has_output: false,
            },
            Msg::AgentRetryRecovered { attempts: 2 },
            Msg::AgentStreamTimeoutTerminal,
            Msg::AgentRateLimitedWaiting { secs: 30 },
            Msg::AgentRateLimitedPaused { detail: "" },
            Msg::AgentRateLimitedPaused {
                detail: "quota reset 12:00",
            },
            Msg::AgentStreamTimeoutPartialResponse,
            Msg::StreamReadResetHint,
            Msg::StreamReadDetailsPrefix,
            Msg::AgentEchoLoopNotice {
                final_warning: false,
            },
            Msg::AgentEchoLoopNotice {
                final_warning: true,
            },
            Msg::AgentEchoLoopTerminal { rounds: 5 },
            Msg::AgentToolLoopWarning { threshold: 3 },
            Msg::AgentToolLoopTerminal { threshold: 5 },
            Msg::AgentRepeatLoopTerminal { rounds: 6 },
        ];

        for msg in cases {
            let en_text = t_with(Locale::En, *msg);
            assert!(!en_text.trim().is_empty(), "empty English copy for {msg:?}");
            for &locale in Locale::ALL {
                let text = t_with(locale, *msg);
                assert!(
                    !text.trim().is_empty(),
                    "empty translation for {locale:?} {msg:?}"
                );
                if locale != Locale::En
                    && !(locale == Locale::De && matches!(msg, Msg::StreamReadDetailsPrefix))
                {
                    assert_ne!(
                        text, en_text,
                        "locale {locale:?} must not fall back to English for {msg:?}"
                    );
                }
            }
        }
        // 繁體中文通知不應回退成簡體字。
        assert_ne!(
            t_with(
                Locale::ZhTw,
                Msg::AgentRetryDropProgress {
                    attempt: 1,
                    max: 9,
                    has_output: true,
                }
            ),
            t_with(
                Locale::ZhCn,
                Msg::AgentRetryDropProgress {
                    attempt: 1,
                    max: 9,
                    has_output: true,
                }
            ),
        );
    }
}
