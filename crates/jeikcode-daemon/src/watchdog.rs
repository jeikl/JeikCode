//! Tokio network reactor scheduling stall watchdog (P0-2).
//!
//! Uses adaptive probing (`500ms` while turns are active, `3s` when idle) and
//! emits a rate-limited diagnostic warning whenever scheduling overshoots
//! `100ms` by default (configurable via `JEIKCODE_WATCHDOG_THRESHOLD_MS`, and
//! disableable via `JEIKCODE_WATCHDOG=0`).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const ACTIVE_WATCHDOG_INTERVAL: Duration = Duration::from_millis(500);
const IDLE_WATCHDOG_INTERVAL: Duration = Duration::from_secs(3);
const DEFAULT_STALL_THRESHOLD_MS: u64 = 100;
const WATCHDOG_WARN_COOLDOWN: Duration = Duration::from_secs(1);

/// Parse whether the reactor watchdog is enabled from `JEIKCODE_WATCHDOG`.
pub(crate) fn watchdog_enabled_from_raw(raw: Option<&str>) -> bool {
    !matches!(
        raw.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("0" | "false" | "off" | "no" | "disabled")
    )
}

/// Resolve the overshoot stall threshold from `JEIKCODE_WATCHDOG_THRESHOLD_MS`.
pub(crate) fn stall_threshold_from_raw(raw: Option<&str>) -> Duration {
    let ms = raw
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|&ms| ms > 0)
        .unwrap_or(DEFAULT_STALL_THRESHOLD_MS);
    Duration::from_millis(ms)
}

/// Choose adaptive sleep cadence: `500ms` when active turns exist, `3s` when idle.
pub(crate) fn probe_interval_for_active_turns(active_turns: usize) -> Duration {
    if active_turns > 0 {
        ACTIVE_WATCHDOG_INTERVAL
    } else {
        IDLE_WATCHDOG_INTERVAL
    }
}

/// Return the scheduling stall overshoot when `elapsed - expected > threshold`.
pub(crate) fn classify_reactor_stall(
    elapsed: Duration,
    expected: Duration,
    threshold: Duration,
) -> Option<Duration> {
    let stall = elapsed.saturating_sub(expected);
    (stall > threshold).then_some(stall)
}

/// Emit a single rate-limited stall warning, attaching a backtrace only when explicitly requested.
fn emit_stall_warning(
    stall: Duration,
    elapsed: Duration,
    interval: Duration,
    threshold: Duration,
    active_turns: usize,
    active_conns: usize,
) {
    let bt = std::env::var_os("JEIKCODE_WATCHDOG_BACKTRACE")
        .is_some_and(|v| v == "1")
        .then(|| std::backtrace::Backtrace::force_capture().to_string());
    tracing::warn!(
        target: "jeikcode::watchdog",
        stall_ms = stall.as_millis() as u64,
        elapsed_ms = elapsed.as_millis() as u64,
        interval_ms = interval.as_millis() as u64,
        threshold_ms = threshold.as_millis() as u64,
        active_turns,
        active_conns,
        backtrace = bt.as_deref(),
        "tokio reactor scheduling stall detected"
    );
}

/// Spawn the adaptive reactor latency probe tied to the daemon server lifetime.
pub(crate) fn spawn_reactor_watchdog(
    active_chats: crate::ActiveChatRegistry,
    active_connections: Arc<AtomicUsize>,
) -> tokio::task::JoinHandle<()> {
    let enabled_env = std::env::var("JEIKCODE_WATCHDOG").ok();
    if !watchdog_enabled_from_raw(enabled_env.as_deref()) {
        return tokio::spawn(std::future::pending());
    }
    let threshold_env = std::env::var("JEIKCODE_WATCHDOG_THRESHOLD_MS").ok();
    let stall_threshold = stall_threshold_from_raw(threshold_env.as_deref());

    tokio::spawn(async move {
        let mut last_warn_at: Option<Instant> = None;
        loop {
            let interval = probe_interval_for_active_turns(active_chats.active_operation_count());
            let started = Instant::now();
            tokio::time::sleep(interval).await;
            let elapsed = started.elapsed();
            let Some(stall) = classify_reactor_stall(elapsed, interval, stall_threshold) else {
                continue;
            };
            if last_warn_at.is_some_and(|prev| prev.elapsed() < WATCHDOG_WARN_COOLDOWN) {
                continue;
            }
            last_warn_at = Some(Instant::now());
            emit_stall_warning(
                stall,
                elapsed,
                interval,
                stall_threshold,
                active_chats.active_operation_count(),
                active_connections.load(Ordering::Relaxed),
            );
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_reactor_stall_only_flags_overshoots_above_threshold() {
        let expected = ACTIVE_WATCHDOG_INTERVAL;
        let threshold = Duration::from_millis(DEFAULT_STALL_THRESHOLD_MS);
        assert_eq!(
            classify_reactor_stall(Duration::from_millis(499), expected, threshold),
            None
        );
        assert_eq!(
            classify_reactor_stall(Duration::from_millis(600), expected, threshold),
            None
        );
        assert_eq!(
            classify_reactor_stall(Duration::from_millis(625), expected, threshold),
            Some(Duration::from_millis(125))
        );
    }

    #[test]
    fn adaptive_interval_and_env_overrides_behave_as_expected() {
        assert_eq!(probe_interval_for_active_turns(0), Duration::from_secs(3));
        assert_eq!(
            probe_interval_for_active_turns(2),
            Duration::from_millis(500)
        );
        assert_eq!(stall_threshold_from_raw(None), Duration::from_millis(100));
        assert_eq!(
            stall_threshold_from_raw(Some("20")),
            Duration::from_millis(20)
        );
        assert_eq!(
            stall_threshold_from_raw(Some("0")),
            Duration::from_millis(100)
        );
        assert!(watchdog_enabled_from_raw(None));
        assert!(watchdog_enabled_from_raw(Some("1")));
        assert!(!watchdog_enabled_from_raw(Some("0")));
        assert!(!watchdog_enabled_from_raw(Some("off")));
    }
}
