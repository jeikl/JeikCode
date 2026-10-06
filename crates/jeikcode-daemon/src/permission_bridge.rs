//! 把 daemon `/chat` 的交互式权限决策桥接到 HTTP。
//!
//! `/chat` approvals are correlated by `(session_id, approval_id)`. The exact
//! route is consumed before a decision is delivered, so duplicate/stale POSTs
//! cannot fall through to a later approval in the same session.

use jeikcode_capabilities::tools::PermissionDecision;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tokio::sync::oneshot;

struct PendingPermissionResponder {
    tx: oneshot::Sender<PermissionSubmissionEnvelope>,
    tool_name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PermissionSubmission {
    pub decision: PermissionDecision,
    pub persist: bool,
}

/// One exact HTTP approval submission plus an acknowledgement that is resolved
/// only when the runtime driver actually consumes the decision. A successful
/// oneshot send alone is not enough: the driver's request timeout can win the
/// same scheduling race after the value was queued but before it was observed.
#[derive(Debug)]
pub struct PermissionSubmissionEnvelope {
    submission: PermissionSubmission,
    accepted: Option<oneshot::Sender<()>>,
}

impl PermissionSubmissionEnvelope {
    fn with_ack(submission: PermissionSubmission, accepted: oneshot::Sender<()>) -> Self {
        Self {
            submission,
            accepted: Some(accepted),
        }
    }

    pub(crate) fn without_ack(submission: PermissionSubmission) -> Self {
        Self {
            submission,
            accepted: None,
        }
    }

    pub fn submission(&self) -> PermissionSubmission {
        self.submission
    }

    /// Acknowledge only after the runtime has consumed this exact decision.
    /// Queueing the envelope at the HTTP bridge is not sufficient: timeout or
    /// cancellation may still win before the runtime request boundary accepts it.
    pub fn acknowledge(mut self) -> PermissionSubmission {
        if let Some(accepted) = self.accepted.take() {
            let _ = accepted.send(());
        }
        self.submission
    }

    /// Back-compat helper for tests/callers that already established runtime
    /// consumption by some other means.
    pub fn accept(self) -> PermissionSubmission {
        self.acknowledge()
    }
}

enum PermissionResponderEntry {
    Pending(PendingPermissionResponder),
    /// The runtime already timed out/cancelled this exact approval. Keep a
    /// per-turn tombstone until normal turn cleanup so a racing late POST is
    /// rejected rather than falling through to another transport.
    Expired,
}

pub enum PermissionDelivery {
    Submitted {
        tool_name: String,
        accepted: oneshot::Receiver<()>,
    },
    Expired,
    Absent,
}

/// Stable identity for one persisted pending approval. The runtime writes the
/// checkpoint before publishing the request, so the same id can be reconstructed
/// after refresh/restart while a later turn that reuses the provider call id gets
/// a different id from `created_at`.
pub fn approval_id_for_pending(
    pending: &jeikcode_capabilities::session::PendingPermission,
) -> String {
    use sha2::{Digest, Sha256};

    let mut digest = Sha256::new();
    digest.update(pending.session_id.as_bytes());
    digest.update([0]);
    digest.update(pending.created_at.to_le_bytes());
    digest.update([0]);
    digest.update(pending.call_id.as_bytes());
    digest.update([0]);
    digest.update(pending.tool_name.as_bytes());
    format!("{:x}", digest.finalize())
}

/// Exact `/chat` approval routes keyed by `(session_id, approval_id)`.
#[derive(Clone, Default)]
pub struct PermissionResponders {
    inner: Arc<RwLock<HashMap<(String, String), PermissionResponderEntry>>>,
}

/// A pending `/chat` structured-input request, keyed by the native runtime request id.
/// The runtime remains the request owner; this registry is only the HTTP response route.
#[derive(Clone, Default)]
pub struct UserInputResponders {
    inner: Arc<RwLock<HashMap<(String, u64), oneshot::Sender<serde_json::Value>>>>,
}

impl UserInputResponders {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(
        &self,
        session_id: String,
        request_id: u64,
        tx: oneshot::Sender<serde_json::Value>,
    ) {
        self.inner
            .write()
            .unwrap()
            .insert((session_id, request_id), tx);
    }

    pub fn unregister(&self, session_id: &str, request_id: u64) {
        self.inner
            .write()
            .unwrap()
            .remove(&(session_id.to_owned(), request_id));
    }

    pub fn unregister_session(&self, session_id: &str) {
        self.inner
            .write()
            .unwrap()
            .retain(|(registered, _), _| registered != session_id);
    }

    /// Delivers at most one answer. Removing before send rejects duplicate/stale POSTs.
    pub fn deliver(&self, session_id: &str, request_id: u64, value: serde_json::Value) -> bool {
        self.inner
            .write()
            .unwrap()
            .remove(&(session_id.to_owned(), request_id))
            .is_some_and(|tx| tx.send(value).is_ok())
    }
}

impl PermissionResponders {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register exactly one approval round-trip.
    pub fn register(
        &self,
        session_id: String,
        approval_id: String,
        tool_name: String,
        tx: oneshot::Sender<PermissionSubmissionEnvelope>,
    ) {
        self.inner.write().unwrap().insert(
            (session_id, approval_id),
            PermissionResponderEntry::Pending(PendingPermissionResponder { tx, tool_name }),
        );
    }

    /// Remove one exact pending approval after it was resolved locally (for
    /// example by switching to Auto). Timeout/cancel should call [`Self::expire`]
    /// instead so a racing stale POST sees an explicit tombstone.
    pub fn unregister(&self, session_id: &str, approval_id: &str) {
        self.inner
            .write()
            .unwrap()
            .remove(&(session_id.to_owned(), approval_id.to_owned()));
    }

    /// Mark one exact approval as expired while preserving a short-lived
    /// tombstone until turn cleanup.
    pub fn expire(&self, session_id: &str, approval_id: &str) {
        let key = (session_id.to_owned(), approval_id.to_owned());
        let mut guard = self.inner.write().unwrap();
        if guard.contains_key(&key) {
            guard.insert(key, PermissionResponderEntry::Expired);
        }
    }

    pub fn unregister_session(&self, session_id: &str) {
        self.inner
            .write()
            .unwrap()
            .retain(|(registered, _), _| registered != session_id);
    }

    /// Submit one exact approval. Removing the pending route and queuing the
    /// decision claims the HTTP route, but the caller must still await the
    /// returned `accepted` receiver before reporting success to the user. The
    /// runtime resolves that acknowledgement only after it actually consumes
    /// the decision rather than timing out/cancelling concurrently.
    pub fn deliver(
        &self,
        session_id: &str,
        approval_id: &str,
        submission: PermissionSubmission,
    ) -> PermissionDelivery {
        let key = (session_id.to_owned(), approval_id.to_owned());
        let mut guard = self.inner.write().unwrap();
        match guard.remove(&key) {
            None => PermissionDelivery::Absent,
            Some(PermissionResponderEntry::Expired) => {
                guard.insert(key, PermissionResponderEntry::Expired);
                PermissionDelivery::Expired
            }
            Some(PermissionResponderEntry::Pending(pending)) => {
                let (accepted_tx, accepted_rx) = oneshot::channel();
                match pending.tx.send(PermissionSubmissionEnvelope::with_ack(
                    submission,
                    accepted_tx,
                )) {
                    Ok(()) => PermissionDelivery::Submitted {
                        tool_name: pending.tool_name,
                        accepted: accepted_rx,
                    },
                    Err(_) => {
                        guard.insert(key, PermissionResponderEntry::Expired);
                        PermissionDelivery::Expired
                    }
                }
            }
        }
    }

    /// Resolve every approval that is pending *now* (used when switching to Auto).
    /// Expired tombstones remain until turn cleanup.
    pub fn deliver_all(&self, decision: PermissionDecision) -> usize {
        let mut guard = self.inner.write().unwrap();
        let keys: Vec<_> = guard
            .iter()
            .filter_map(|(key, value)| {
                matches!(value, PermissionResponderEntry::Pending(_)).then(|| key.clone())
            })
            .collect();
        let pending: Vec<_> = keys
            .into_iter()
            .filter_map(|key| match guard.remove(&key) {
                Some(PermissionResponderEntry::Pending(pending)) => Some(pending.tx),
                _ => None,
            })
            .collect();
        drop(guard);
        pending
            .into_iter()
            .map(|tx| {
                tx.send(PermissionSubmissionEnvelope::without_ack(
                    PermissionSubmission {
                        decision,
                        persist: false,
                    },
                ))
                .is_ok()
            })
            .filter(|sent| *sent)
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jeikcode_capabilities::tools::PermissionDecision;

    #[test]
    fn approval_id_distinguishes_reused_provider_call_ids_across_checkpoints() {
        let first = jeikcode_capabilities::session::PendingPermission {
            session_id: "sess-1".into(),
            call_id: "ollama_call_0".into(),
            tool_name: "bash".into(),
            reason: "Requires approval".into(),
            arguments: serde_json::json!({ "command": "git status" }),
            created_at: 1000,
        };
        let mut second = first.clone();
        second.created_at = 2000;

        assert_eq!(
            approval_id_for_pending(&first),
            approval_id_for_pending(&first)
        );
        assert_ne!(
            approval_id_for_pending(&first),
            approval_id_for_pending(&second)
        );
    }

    #[tokio::test]
    async fn routes_decision_to_registered_session() {
        let reg = PermissionResponders::new();
        let (tx, rx) = tokio::sync::oneshot::channel();
        reg.register("sess-1".into(), "call-1".into(), "bash".into(), tx);

        let delivery = reg.deliver(
            "sess-1",
            "call-1",
            PermissionSubmission {
                decision: PermissionDecision::AllowOnce,
                persist: false,
            },
        );
        let PermissionDelivery::Submitted {
            tool_name,
            mut accepted,
        } = delivery
        else {
            panic!("registered approval must be submitted")
        };
        assert_eq!(tool_name, "bash");
        assert!(matches!(
            accepted.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        let envelope = rx.await.unwrap();
        let submission = envelope.accept();
        assert_eq!(
            submission,
            PermissionSubmission {
                decision: PermissionDecision::AllowOnce,
                persist: false,
            }
        );
        assert!(accepted.await.is_ok());
    }

    #[tokio::test]
    async fn submitted_decision_is_rejected_if_runtime_drops_it_before_consuming() {
        let reg = PermissionResponders::new();
        let (tx, rx) = tokio::sync::oneshot::channel();
        reg.register("sess-1".into(), "call-1".into(), "bash".into(), tx);

        let delivery = reg.deliver(
            "sess-1",
            "call-1",
            PermissionSubmission {
                decision: PermissionDecision::AllowOnce,
                persist: false,
            },
        );
        let PermissionDelivery::Submitted { accepted, .. } = delivery else {
            panic!("registered approval must be submitted")
        };
        drop(rx.await.unwrap());
        assert!(
            accepted.await.is_err(),
            "HTTP acknowledgement must fail when the runtime drops a queued decision"
        );
    }

    #[test]
    fn stale_or_duplicate_approval_id_is_rejected() {
        let reg = PermissionResponders::new();
        let (tx, _rx) = tokio::sync::oneshot::channel();
        reg.register("sess-1".into(), "call-new".into(), "bash".into(), tx);
        assert!(matches!(
            reg.deliver(
                "sess-1",
                "call-old",
                PermissionSubmission {
                    decision: PermissionDecision::AllowOnce,
                    persist: false,
                },
            ),
            PermissionDelivery::Absent
        ));
        assert!(matches!(
            reg.deliver(
                "sess-1",
                "call-new",
                PermissionSubmission {
                    decision: PermissionDecision::Deny,
                    persist: false,
                },
            ),
            PermissionDelivery::Submitted { .. }
        ));
        assert!(matches!(
            reg.deliver(
                "sess-1",
                "call-new",
                PermissionSubmission {
                    decision: PermissionDecision::AllowOnce,
                    persist: false,
                },
            ),
            PermissionDelivery::Absent
        ));
    }

    #[test]
    fn expired_approval_remains_a_tombstone_until_session_cleanup() {
        let reg = PermissionResponders::new();
        let (tx, _rx) = tokio::sync::oneshot::channel();
        reg.register("sess-1".into(), "call-1".into(), "bash".into(), tx);
        reg.expire("sess-1", "call-1");

        assert!(matches!(
            reg.deliver(
                "sess-1",
                "call-1",
                PermissionSubmission {
                    decision: PermissionDecision::AllowOnce,
                    persist: false,
                },
            ),
            PermissionDelivery::Expired
        ));
        assert!(matches!(
            reg.deliver(
                "sess-1",
                "call-1",
                PermissionSubmission {
                    decision: PermissionDecision::AllowOnce,
                    persist: false,
                },
            ),
            PermissionDelivery::Expired
        ));

        reg.unregister_session("sess-1");
        assert!(matches!(
            reg.deliver(
                "sess-1",
                "call-1",
                PermissionSubmission {
                    decision: PermissionDecision::AllowOnce,
                    persist: false,
                },
            ),
            PermissionDelivery::Absent
        ));
    }

    #[tokio::test]
    async fn deliver_all_wakes_all_waiting_sessions() {
        let reg = PermissionResponders::new();
        let (tx1, rx1) = tokio::sync::oneshot::channel();
        let (tx2, rx2) = tokio::sync::oneshot::channel();
        reg.register("sess-1".into(), "call-1".into(), "bash".into(), tx1);
        reg.register("sess-2".into(), "call-2".into(), "write".into(), tx2);

        let count = reg.deliver_all(PermissionDecision::AllowOnce);
        assert_eq!(count, 2);
        assert_eq!(
            rx1.await.unwrap().accept().decision,
            PermissionDecision::AllowOnce
        );
        assert_eq!(
            rx2.await.unwrap().accept().decision,
            PermissionDecision::AllowOnce
        );
    }

    #[tokio::test]
    async fn routes_user_input_once_by_session_and_request() {
        let reg = UserInputResponders::new();
        let (tx, rx) = tokio::sync::oneshot::channel();
        reg.register("sess-1".into(), 42, tx);

        assert!(!reg.deliver("sess-1", 41, serde_json::json!({"text":"wrong"})));
        assert!(reg.deliver("sess-1", 42, serde_json::json!({"text":"ok"})));
        assert!(!reg.deliver("sess-1", 42, serde_json::json!({"text":"late"})));
        assert_eq!(rx.await.unwrap(), serde_json::json!({"text":"ok"}));
    }
}
