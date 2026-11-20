//! 每个工具调用的轻量旁路可观测信号缓存（参数自动修复、人工审批等待耗时、折叠前结果字节数与截断标记）。
//!
//! 仅依赖标准库并使用有界 FIFO 表（[`MAX_CALL_SIGNALS`]），不依赖 `session` feature，
//! 供参数修复、审批与产物折叠中间件和会话追踪钩子跨层零拷贝汇总。

use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, Mutex};

const MAX_CALL_SIGNALS: usize = 1024;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct CallSignals {
    pub repaired_args: bool,
    pub approval_wait_ms: u64,
    pub raw_result_bytes: Option<usize>,
    pub truncated: bool,
}

#[derive(Default)]
struct CallSignalsStore {
    entries: HashMap<String, CallSignals>,
    order: VecDeque<String>,
}

impl CallSignalsStore {
    fn ensure_entry(&mut self, call_id: &str) -> &mut CallSignals {
        if !self.entries.contains_key(call_id) {
            while self.entries.len() >= MAX_CALL_SIGNALS {
                let Some(evicted) = self.order.pop_front() else {
                    self.entries.clear();
                    break;
                };
                self.entries.remove(&evicted);
            }
            if self.order.len() > MAX_CALL_SIGNALS * 2 {
                self.order.retain(|id| self.entries.contains_key(id));
            }
            self.order.push_back(call_id.to_string());
            self.entries
                .insert(call_id.to_string(), CallSignals::default());
        }
        self.entries
            .get_mut(call_id)
            .expect("inserted entry must exist")
    }
}

static STORE: LazyLock<Mutex<CallSignalsStore>> =
    LazyLock::new(|| Mutex::new(CallSignalsStore::default()));

/// 标记工具调用经历过本地 JSON 参数自动修复且实际改写了参数文本。
pub(crate) fn mark_repaired(call_id: &str) {
    if call_id.is_empty() {
        return;
    }
    if let Ok(mut guard) = STORE.lock() {
        guard.ensure_entry(call_id).repaired_args = true;
    }
}

/// 累加该工具调用在审批门（含写敏感/工作区外审批与通用风险审批）等待交互决定的毫秒数。
pub(crate) fn add_approval_wait(call_id: &str, wait_ms: u64) {
    if call_id.is_empty() {
        return;
    }
    if let Ok(mut guard) = STORE.lock() {
        let entry = guard.ensure_entry(call_id);
        entry.approval_wait_ms = entry.approval_wait_ms.saturating_add(wait_ms);
    }
}

/// 记录工具原始返回文本字节数（折叠前）及是否发生了产物折叠或裁剪。
pub(crate) fn record_result_size(call_id: &str, raw_bytes: usize, truncated: bool) {
    if call_id.is_empty() {
        return;
    }
    if let Ok(mut guard) = STORE.lock() {
        let entry = guard.ensure_entry(call_id);
        entry.raw_result_bytes = Some(raw_bytes);
        entry.truncated |= truncated;
    }
}

/// 取出并移除该工具调用累计的旁路信号；若无记录则返回默认值。
#[cfg_attr(not(feature = "session"), allow(dead_code))]
pub(crate) fn take(call_id: &str) -> CallSignals {
    if call_id.is_empty() {
        return CallSignals::default();
    }
    STORE
        .lock()
        .ok()
        .and_then(|mut guard| guard.entries.remove(call_id))
        .unwrap_or_default()
}
