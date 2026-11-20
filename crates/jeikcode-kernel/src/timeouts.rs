//! Unified stream-timeout policy for the coding client.
//!
//! Transport fields (`connect`, `open`) are consumed by L1 adapters. Content
//! phases (`ttft`, `transition`, `streaming`) are consumed by the kernel stream
//! loop. Heartbeats and observational metadata must not reset content deadlines.

use std::time::Duration;

/// Content-liveness phase of one provider stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamPhase {
    /// No thinking / text / tool token yet (queue, prefill, hidden reasoning).
    Ttft,
    /// Reasoning tokens are flowing.
    Thinking,
    /// Reasoning has gone quiet; waiting for the first text or tool token.
    Transition,
    /// Text or tool tokens are flowing; sliding window between business tokens.
    Streaming,
}

/// One policy object for every adapter and the kernel content clock.
///
/// Content fields are `None` on the neutral kernel (unbounded). Production
/// assembly fills them from `[coding]` / env. `connect` / `open` always have
/// concrete defaults so a half-built adapter still has a TTFB cap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeoutPolicy {
    /// TCP/TLS connect budget.
    pub connect: Duration,
    /// Wait for HTTP response headers (`req.send()`). Does not cap the body.
    pub open: Duration,
    /// First business token (thinking, text, or tool). `None` = no TTFT arm.
    pub ttft: Option<Duration>,
    /// After thinking, wait for the first text/tool token. `None` falls back.
    pub transition: Option<Duration>,
    /// Sliding window between adjacent business tokens. `None` falls back.
    pub streaming: Option<Duration>,
}

impl TimeoutPolicy {
    pub const DEFAULT_CONNECT_SECS: u64 = 10;
    pub const DEFAULT_OPEN_SECS: u64 = 180;
    pub const DEFAULT_TTFT_SECS: u64 = 180;
    pub const DEFAULT_TRANSITION_SECS: u64 = 360;
    pub const DEFAULT_STREAMING_SECS: u64 = 360;

    /// Neutral kernel default: content clocks off, transport still bounded.
    pub const fn unbounded() -> Self {
        Self {
            connect: Duration::from_secs(Self::DEFAULT_CONNECT_SECS),
            open: Duration::from_secs(Self::DEFAULT_OPEN_SECS),
            ttft: None,
            transition: None,
            streaming: None,
        }
    }

    /// Production defaults matching the gateway three-phase content clocks.
    pub const fn production() -> Self {
        Self {
            connect: Duration::from_secs(Self::DEFAULT_CONNECT_SECS),
            open: Duration::from_secs(Self::DEFAULT_OPEN_SECS),
            ttft: Some(Duration::from_secs(Self::DEFAULT_TTFT_SECS)),
            transition: Some(Duration::from_secs(Self::DEFAULT_TRANSITION_SECS)),
            streaming: Some(Duration::from_secs(Self::DEFAULT_STREAMING_SECS)),
        }
    }

    /// Set every content phase to `d` (tests / `--stream-timeout`).
    pub fn with_content_liveness(mut self, d: Duration) -> Self {
        if d.is_zero() {
            self.ttft = None;
            self.transition = None;
            self.streaming = None;
        } else {
            self.ttft = Some(d);
            self.transition = Some(d);
            self.streaming = Some(d);
        }
        self
    }

    /// Duration allowed in `phase`. Missing fields fall back so a builder that
    /// only sets `streaming` still bounds first-token wait (existing tests).
    pub fn phase_limit(self, phase: StreamPhase) -> Option<Duration> {
        match phase {
            StreamPhase::Ttft => self.ttft.or(self.streaming),
            StreamPhase::Transition => self.transition.or(self.ttft).or(self.streaming),
            StreamPhase::Thinking | StreamPhase::Streaming => self.streaming.or(self.ttft),
        }
    }

    /// Adapter byte-idle fuse: longest content wait, at least `open`.
    /// Heartbeats keep this alive; the kernel content clock is the real guard.
    pub fn idle_watchdog(self) -> Duration {
        self.ttft
            .into_iter()
            .chain(self.transition)
            .chain(self.streaming)
            .chain(std::iter::once(self.open))
            .max()
            .unwrap_or(self.open)
    }
}

impl Default for TimeoutPolicy {
    fn default() -> Self {
        Self::unbounded()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streaming_only_bounds_every_phase() {
        let p = TimeoutPolicy::unbounded().with_content_liveness(Duration::from_millis(50));
        assert_eq!(
            p.phase_limit(StreamPhase::Ttft),
            Some(Duration::from_millis(50))
        );
        assert_eq!(
            p.phase_limit(StreamPhase::Transition),
            Some(Duration::from_millis(50))
        );
        assert_eq!(
            p.phase_limit(StreamPhase::Streaming),
            Some(Duration::from_millis(50))
        );
    }

    #[test]
    fn production_uses_three_phase_windows() {
        let p = TimeoutPolicy::production();
        assert_eq!(
            p.phase_limit(StreamPhase::Ttft),
            Some(Duration::from_secs(180))
        );
        assert_eq!(
            p.phase_limit(StreamPhase::Transition),
            Some(Duration::from_secs(360))
        );
        assert_eq!(
            p.phase_limit(StreamPhase::Thinking),
            Some(Duration::from_secs(360))
        );
        assert_eq!(
            p.phase_limit(StreamPhase::Streaming),
            Some(Duration::from_secs(360))
        );
        assert_eq!(p.idle_watchdog(), Duration::from_secs(360));
        assert_eq!(p.connect, Duration::from_secs(10));
        assert_eq!(p.open, Duration::from_secs(180));
    }

    #[test]
    fn zero_content_liveness_disables_phase_clocks() {
        let p = TimeoutPolicy::production().with_content_liveness(Duration::ZERO);
        assert_eq!(p.phase_limit(StreamPhase::Ttft), None);
        assert_eq!(p.phase_limit(StreamPhase::Streaming), None);
    }
}
