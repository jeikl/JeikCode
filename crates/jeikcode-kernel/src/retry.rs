//! 统一自动重试引擎：一条退避阶梯、一个计数器、一次故障一条通知。
//!
//! 历史上「瞬时故障」被四套独立机制各自重试（OPEN、首 token、流空闲、
//! 空响应），每套都有自己的次数、间隔与文案；叠加起来一次 OPEN 失败最多会
//! 打 12 次请求，且没有任何一层负责「已经吐出正文之后断流」的恢复。
//!
//! 本模块把调度收敛到一处：
//! * [`RETRY_LADDER_SECS`] 是**唯一**的退避序列，所有失败类型都从它取值；
//! * [`RetryClass`] 只决定「最多用到第几格」和「怎么重试」，不再自带第二套数字；
//! * [`RetryEngine`] 持有本轮的唯一计数器与故障身份（`incident_id`），
//!   调用方据此保证「同一次故障只弹一条通知」。
//!
//! 429 等待窗口、上下文溢出压缩、长度截断续写属于**不同动作**（等待外部状态 /
//! 压缩 / 继续生成），仍由各自路径处理，但计数与通知同样走本引擎。

use std::time::Duration;

use crate::stream::ProviderError;

/// 统一退避阶梯（秒）：第 N 次重试前等待。非递减，累计 257 秒。
pub const RETRY_LADDER_SECS: [u64; 9] = [0, 2, 5, 10, 15, 30, 45, 60, 90];

/// 失败分类：只描述「哪一类故障」，不携带自己的次数/间隔。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetryClass {
    /// 请求还没建立（OPEN）：5xx / 408 / 425 / 传输类。
    OpenTransient,
    /// 已开流后断流（网络重置、TLS 损坏、body 读失败）。
    StreamDrop,
    /// 已开流但长时间没有任何数据（空闲超时）。
    Stall,
    /// 首 token 超时（一个 token 都没出）。
    FirstToken,
    /// 200 但零内容（空响应 / 只返回思考 / 格式异常）。
    EmptyResponse,
    /// 429：等待窗口由服务端/宿主决定，不使用阶梯。
    RateLimited,
    /// 上下文溢出：先压缩再重发，不使用阶梯。
    Overflow,
    /// 输出被长度上限截断：继续生成，不是失败。
    Truncated,
    /// 不可重试（认证 / 参数 / 解析失败 / 用户取消 / 策略拒绝…）。
    Terminal,
}

impl RetryClass {
    /// 该类最多用到阶梯的第几格（0 = 不重试）。
    pub fn cap(self) -> u32 {
        match self {
            Self::OpenTransient | Self::StreamDrop | Self::Stall => 9,
            Self::FirstToken | Self::EmptyResponse => 6,
            Self::RateLimited => 5,
            Self::Overflow => 3,
            Self::Truncated => 2,
            Self::Terminal => 0,
        }
    }

    /// 重试时如何处理已经产生的输出。
    pub fn mode(self) -> RetryMode {
        match self {
            Self::OpenTransient | Self::FirstToken | Self::EmptyResponse => RetryMode::Replay,
            // 断流/空闲：由调用方按「是否已出内容、是否有工具片段」细分为
            // Replay / Continue / DropToolTailThenContinue。
            Self::StreamDrop | Self::Stall => RetryMode::Replay,
            Self::RateLimited => RetryMode::WaitForWindow,
            Self::Overflow => RetryMode::CompactThenReplay,
            Self::Truncated => RetryMode::ContinueGeneration,
            Self::Terminal => RetryMode::Terminal,
        }
    }
}

/// 重试动作。与 [`RetryClass`] 分开，因为「同一类故障」可能对应不同动作
/// （断流时有没有吐出正文，决定了是整请求重发还是接着写）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetryMode {
    /// 没有任何输出：原样重发整个请求。
    Replay,
    /// 已输出正文/思考：带着已产出的前半段继续生成（新气泡）。
    Continue,
    /// 工具调用片段中断：丢掉没拼完的那个调用，保留之前的完整内容后继续生成。
    DropToolTailThenContinue,
    /// 等限流窗口。
    WaitForWindow,
    /// 先压缩再重发。
    CompactThenReplay,
    /// 继续生成被截断的输出。
    ContinueGeneration,
    /// 不重试。
    Terminal,
}

/// OPEN 阶段的失败分类。OPEN 失败没有「已输出」问题，因此 `retryable` 即
/// 整请求重发；`http_status` 缺失时的传输类失败同样属于此层。
pub fn classify_open(err: &ProviderError) -> RetryClass {
    if err.http_status == Some(429) {
        return RetryClass::RateLimited;
    }
    if err.is_context_overflow() {
        return RetryClass::Overflow;
    }
    if err.retryable {
        return RetryClass::OpenTransient;
    }
    RetryClass::Terminal
}

/// 流阶段的失败分类。约定（见 `conformance/providers.rs`）：中流错误的
/// `http_status` 必为 `None`；能续写的传输类失败由 adapter 置 `resumable`。
/// 有状态码的 429 仍归限流，其余一律不可重试。
pub fn classify_stream(err: &ProviderError) -> RetryClass {
    if err.http_status == Some(429) {
        return RetryClass::RateLimited;
    }
    if err.is_context_overflow() {
        return RetryClass::Overflow;
    }
    if err.resumable || (err.retryable && err.http_status.is_none()) {
        return RetryClass::StreamDrop;
    }
    RetryClass::Terminal
}

/// 一次具体重试：第几次、等多久、属于哪次故障、是不是这次故障的第一次。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RetryStep {
    pub number: u32,
    pub wait: Duration,
    pub incident_id: String,
    /// 本次故障的首次重试 —— 调用方只在此刻弹提示。
    pub first: bool,
}

/// 本轮的唯一重试账本。成功完成一轮即 [`RetryEngine::reset`]。
#[derive(Debug, Default)]
pub struct RetryEngine {
    attempts: u32,
    incident: Option<String>,
    /// 当前故障卡已累计的重试次数；随 [`Self::close_incident`] 归零。
    incident_attempts: u32,
    /// 本轮内已开启的独立故障卡序号（1 起步，同 round 内续写后再次断流递增）。
    incident_seq: u32,
}

impl RetryEngine {
    pub fn new() -> Self {
        Self::default()
    }

    /// 一轮正常完成：预算回满、故障身份关闭（下一条故障会得到新 id）。
    pub fn reset(&mut self) {
        self.attempts = 0;
        self.incident = None;
        self.incident_attempts = 0;
        self.incident_seq = 0;
    }

    /// 收口当前故障卡（例如重连后已产出新气泡内容），清除活跃 `incident_id` 并归零本卡计数，
    /// 但保留本轮累计 `attempts` 预算上限以防止无限重试；若随后再次断流将分配新 `incident_id`。
    pub fn close_incident(&mut self) {
        self.incident = None;
        self.incident_attempts = 0;
    }

    pub fn attempts(&self) -> u32 {
        self.attempts
    }

    /// 当前活跃故障卡已累计的重试次数。
    pub fn incident_attempts(&self) -> u32 {
        self.incident_attempts
    }

    /// 本次故障的稳定身份；`None` 表示还没有发生过重试。
    pub fn incident_id(&self) -> Option<&str> {
        self.incident.as_deref()
    }

    /// 申请一次重试。预算耗尽返回 `None`（调用方走终态）。
    ///
    /// `cap_override` 用于配置覆盖（例如首 token 重试次数由配置决定），
    /// 仍然复用同一条阶梯。
    pub fn next(
        &mut self,
        class: RetryClass,
        seed: &str,
        cap_override: Option<u32>,
    ) -> Option<RetryStep> {
        let cap = cap_override
            .unwrap_or_else(|| class.cap())
            .min(RETRY_LADDER_SECS.len() as u32);
        if cap == 0 || self.attempts >= cap {
            return None;
        }
        let index = (self.attempts as usize).min(RETRY_LADDER_SECS.len() - 1);
        self.attempts += 1;
        self.incident_attempts += 1;
        if self.incident.is_none() {
            self.incident_seq = self.incident_seq.saturating_add(1);
            let id = if self.incident_seq <= 1 {
                format!("{seed}:retry")
            } else {
                format!("{seed}-i{}:retry", self.incident_seq)
            };
            self.incident = Some(id);
        }
        let incident = self
            .incident
            .clone()
            .unwrap_or_else(|| format!("{seed}:retry"));
        Some(RetryStep {
            number: self.attempts,
            wait: Duration::from_secs(RETRY_LADDER_SECS[index]),
            incident_id: incident,
            first: self.incident_attempts == 1,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(retryable: bool, resumable: bool) -> ProviderError {
        ProviderError {
            retryable,
            resumable,
            message: "boom".into(),
            ..Default::default()
        }
    }

    #[test]
    fn ladder_is_the_single_agreed_sequence() {
        assert_eq!(RETRY_LADDER_SECS, [0, 2, 5, 10, 15, 30, 45, 60, 90]);
        assert!(
            RETRY_LADDER_SECS.windows(2).all(|w| w[0] <= w[1]),
            "阶梯必须非递减"
        );
    }

    #[test]
    fn engine_walks_the_shared_ladder_and_then_exhausts() {
        let mut engine = RetryEngine::new();
        let waits: Vec<u64> = (0..9)
            .map(|_| {
                engine
                    .next(RetryClass::StreamDrop, "m1", None)
                    .expect("within budget")
                    .wait
                    .as_secs()
            })
            .collect();
        assert_eq!(waits, RETRY_LADDER_SECS.to_vec());
        assert!(engine.next(RetryClass::StreamDrop, "m1", None).is_none());
        assert_eq!(engine.attempts(), 9);
    }

    #[test]
    fn first_step_carries_the_incident_identity_and_only_it_is_first() {
        let mut engine = RetryEngine::new();
        let first = engine.next(RetryClass::StreamDrop, "m1", None).unwrap();
        assert!(first.first);
        assert_eq!(first.number, 1);
        assert_eq!(first.incident_id, "m1:retry");
        let second = engine.next(RetryClass::StreamDrop, "m1", None).unwrap();
        assert!(!second.first);
        assert_eq!(second.incident_id, first.incident_id);
    }

    #[test]
    fn reset_closes_the_incident_and_refills_the_budget() {
        let mut engine = RetryEngine::new();
        let _ = engine.next(RetryClass::Stall, "m1", None).unwrap();
        engine.reset();
        assert_eq!(engine.attempts(), 0);
        assert!(engine.incident_id().is_none());
        let next = engine.next(RetryClass::StreamDrop, "m2", None).unwrap();
        assert!(next.first, "新故障必须重新弹一次提示");
        assert_eq!(next.incident_id, "m2:retry");
    }

    #[test]
    fn close_incident_opens_new_id_while_preserving_total_budget() {
        let mut engine = RetryEngine::new();
        let first = engine
            .next(RetryClass::StreamDrop, "turn-1-r1", None)
            .unwrap();
        assert_eq!(first.incident_id, "turn-1-r1:retry");
        assert_eq!(first.number, 1);
        assert_eq!(engine.incident_attempts(), 1);

        // 重连产出新内容后关闭上一张故障卡，保留本轮总预算上限。
        engine.close_incident();
        assert!(engine.incident_id().is_none());
        assert_eq!(engine.incident_attempts(), 0);
        assert_eq!(engine.attempts(), 1);

        let second = engine
            .next(RetryClass::StreamDrop, "turn-1-r1", None)
            .unwrap();
        assert!(second.first, "第二次独立断网应标记为新故障卡的首条");
        assert_eq!(second.incident_id, "turn-1-r1-i2:retry");
        assert_eq!(second.number, 2);
        assert_eq!(engine.incident_attempts(), 1);
        assert_eq!(engine.attempts(), 2);

        // 预算上限仍按本轮累计 attempts 封顶（9 次），不会被 close_incident 无限续命。
        for _ in 0..7 {
            assert!(engine
                .next(RetryClass::StreamDrop, "turn-1-r1", None)
                .is_some());
        }
        assert!(engine
            .next(RetryClass::StreamDrop, "turn-1-r1", None)
            .is_none());
    }

    #[test]
    fn class_caps_use_the_same_ladder() {
        for (class, cap) in [
            (RetryClass::OpenTransient, 9),
            (RetryClass::StreamDrop, 9),
            (RetryClass::Stall, 9),
            (RetryClass::FirstToken, 6),
            (RetryClass::EmptyResponse, 6),
            (RetryClass::RateLimited, 5),
            (RetryClass::Overflow, 3),
            (RetryClass::Truncated, 2),
            (RetryClass::Terminal, 0),
        ] {
            assert_eq!(class.cap(), cap);
            let mut engine = RetryEngine::new();
            for _ in 0..cap {
                assert!(
                    engine.next(class, "s", None).is_some(),
                    "{class:?} within cap"
                );
            }
            assert!(
                engine.next(class, "s", None).is_none(),
                "{class:?} exhausted"
            );
        }
    }

    #[test]
    fn cap_override_is_clamped_to_the_ladder() {
        let mut engine = RetryEngine::new();
        for _ in 0..6 {
            assert!(engine.next(RetryClass::FirstToken, "s", Some(6)).is_some());
        }
        assert!(engine.next(RetryClass::FirstToken, "s", Some(6)).is_none());
        // 配置给得再大也不能超过阶梯长度。
        let mut engine = RetryEngine::new();
        for _ in 0..9 {
            assert!(engine.next(RetryClass::FirstToken, "s", Some(99)).is_some());
        }
        assert!(engine.next(RetryClass::FirstToken, "s", Some(99)).is_none());
    }

    #[test]
    fn classify_covers_the_failure_matrix() {
        assert_eq!(
            classify_open(&ProviderError {
                http_status: Some(429),
                ..Default::default()
            }),
            RetryClass::RateLimited
        );
        assert_eq!(
            classify_open(&ProviderError {
                http_status: Some(400),
                message: "context length exceeded".into(),
                ..Default::default()
            }),
            RetryClass::Overflow
        );
        assert_eq!(
            classify_open(&ProviderError {
                retryable: true,
                message: "dns error".into(),
                ..Default::default()
            }),
            RetryClass::OpenTransient,
            "OPEN 阶段的传输类失败按整个请求重发处理"
        );
        assert_eq!(classify_open(&err(false, false)), RetryClass::Terminal);

        assert_eq!(
            classify_stream(&err(false, true)),
            RetryClass::StreamDrop,
            "resumable 明确表示可续写"
        );
        assert_eq!(
            classify_stream(&err(true, false)),
            RetryClass::StreamDrop,
            "无状态码的瞬态错误属于中流"
        );
        assert_eq!(classify_stream(&err(false, false)), RetryClass::Terminal);
    }
}
