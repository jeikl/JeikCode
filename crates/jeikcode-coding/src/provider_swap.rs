//! In-turn provider hot-swap seam.
//!
//! The kernel owns one `Arc<dyn LlmProvider>` for an Agent's lifetime. A normal
//! `/model` switch rebuilds the Agent, which terminates the in-flight turn. The
//! "runtime model switch" setting instead needs to keep the SAME conversation
//! and swap only the provider used by the NEXT model request, exactly like a
//! steer fold. `SwappableProvider` is that seam: `swap_pending` stores the
//! candidate, and `chat_stream` applies it at the next round boundary.
//!
//! The swap is purely a transport/attribution concern; the conversation and the
//! kernel message stream are untouched, so no timing/label metadata reaches the
//! model context.

use std::sync::{Arc, Mutex, OnceLock, RwLock};

use async_trait::async_trait;
use futures::stream::BoxStream;
use jeikcode_kernel::message::Message;
use jeikcode_kernel::provider::{ChatOptions, LlmProvider};
use jeikcode_kernel::stream::{ProviderError, StreamEvent};
use jeikcode_kernel::tool::ToolDef;

use crate::runtime::CodingRuntimeEvent;

/// One queued provider candidate. `requested_at_ms` is stamped when the user
/// asked for the switch; `applied_at_ms` when the next model request starts.
struct PendingSwap {
    provider: Arc<dyn LlmProvider>,
    provider_name: String,
    model: String,
    requested_at_ms: u64,
}

pub struct SwappableProvider {
    inner: RwLock<Arc<dyn LlmProvider>>,
    /// Leaked model strings: the `LlmProvider::model_name(&self) -> &str`
    /// contract cannot borrow through a lock. A swap is a rare user action, so
    /// leaking one tiny `model` id per switch is bounded and safe.
    model_name: RwLock<&'static str>,
    pending: Mutex<Option<PendingSwap>>,
    session_id: OnceLock<String>,
    event_tx: Mutex<Option<tokio::sync::mpsc::UnboundedSender<CodingRuntimeEvent>>>,
}

/// Monotonic-ish wall clock; this seam is observability, not scheduling.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn leak_model(model: &str) -> &'static str {
    Box::leak(model.to_string().into_boxed_str())
}

impl SwappableProvider {
    pub fn new(provider: Arc<dyn LlmProvider>, model: &str) -> Self {
        Self {
            inner: RwLock::new(provider),
            model_name: RwLock::new(leak_model(model)),
            pending: Mutex::new(None),
            session_id: OnceLock::new(),
            event_tx: Mutex::new(None),
        }
    }

    /// Install the runtime event channel after the owner loop has created it.
    pub fn set_event_sender(&self, tx: tokio::sync::mpsc::UnboundedSender<CodingRuntimeEvent>) {
        *self
            .event_tx
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(tx);
    }

    /// Queue a provider for the next `chat_stream` (next kernel round).
    /// Returns the request timestamp for the ops log.
    pub fn swap_pending(
        &self,
        provider: Arc<dyn LlmProvider>,
        provider_name: impl Into<String>,
        model: impl Into<String>,
    ) -> u64 {
        let requested_at_ms = now_ms();
        *self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(PendingSwap {
            provider,
            provider_name: provider_name.into(),
            model: model.into(),
            requested_at_ms,
        });
        requested_at_ms
    }

    /// Replace immediately (normal idle `/model` reassembly). Clears any queued
    /// swap so a stale pending candidate cannot overwrite the explicit choice.
    pub fn replace_now(&self, provider: Arc<dyn LlmProvider>, model: &str) {
        if let Some(sid) = self.session_id.get() {
            provider.bind_session_id(sid);
        }
        *self
            .inner
            .write()
            .unwrap_or_else(|error| error.into_inner()) = provider;
        *self
            .model_name
            .write()
            .unwrap_or_else(|error| error.into_inner()) = leak_model(model);
        *self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
    }

    fn current(&self) -> Arc<dyn LlmProvider> {
        self.inner
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    /// Apply the queued candidate (if any) and announce the exact boundary.
    fn apply_pending(&self) {
        let swap = {
            let mut pending = self
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            pending.take()
        };
        let Some(swap) = swap else { return };
        if let Some(sid) = self.session_id.get() {
            swap.provider.bind_session_id(sid);
        }
        *self
            .inner
            .write()
            .unwrap_or_else(|error| error.into_inner()) = swap.provider;
        *self
            .model_name
            .write()
            .unwrap_or_else(|error| error.into_inner()) = leak_model(&swap.model);
        let applied_at = now_ms();
        let tx = self
            .event_tx
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if let Some(tx) = tx {
            let _ = tx.send(CodingRuntimeEvent::ModelSwitched {
                provider: swap.provider_name,
                model: swap.model,
                requested_at: swap.requested_at_ms,
                applied_at,
            });
        }
    }
}

#[async_trait]
impl LlmProvider for SwappableProvider {
    fn model_name(&self) -> &str {
        let model: &'static str = *self
            .model_name
            .read()
            .unwrap_or_else(|error| error.into_inner());
        model
    }

    fn context_window(&self) -> u32 {
        self.current().context_window()
    }

    fn bind_session_id(&self, session_id: &str) {
        // A rebuild re-binds on the same parts; only the first id is canonical,
        // but the current inner provider must still receive it every time.
        let _ = self.session_id.set(session_id.to_string());
        self.current().bind_session_id(session_id);
    }

    async fn chat_stream(
        &self,
        messages: &[Message],
        tools: &[ToolDef],
        options: &ChatOptions,
    ) -> Result<BoxStream<'static, StreamEvent>, ProviderError> {
        // THE boundary: a pending switch takes effect for THIS request only.
        self.apply_pending();
        let provider = self.current();
        provider.chat_stream(messages, tools, options).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt as _;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct NamedProvider {
        name: &'static str,
        calls: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl LlmProvider for NamedProvider {
        fn model_name(&self) -> &str {
            self.name
        }

        async fn chat_stream(
            &self,
            _messages: &[Message],
            _tools: &[ToolDef],
            _options: &ChatOptions,
        ) -> Result<BoxStream<'static, StreamEvent>, ProviderError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            Ok(futures::stream::empty().boxed())
        }
    }

    #[tokio::test]
    async fn pending_switch_applies_at_the_next_chat_stream_only() {
        let first_calls = Arc::new(AtomicUsize::new(0));
        let second_calls = Arc::new(AtomicUsize::new(0));
        let wrapper = SwappableProvider::new(
            Arc::new(NamedProvider {
                name: "model-a",
                calls: first_calls.clone(),
            }),
            "model-a",
        );
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        wrapper.set_event_sender(tx);

        let requested_at = wrapper.swap_pending(
            Arc::new(NamedProvider {
                name: "model-b",
                calls: second_calls.clone(),
            }),
            "provider-b",
            "model-b",
        );
        assert!(requested_at > 0);
        // The OLD provider is still current until the next request boundary.
        assert_eq!(wrapper.model_name(), "model-a");
        assert_eq!(first_calls.load(Ordering::Relaxed), 0);

        let _ = wrapper
            .chat_stream(&[], &[], &ChatOptions::default())
            .await
            .expect("stream");
        assert_eq!(first_calls.load(Ordering::Relaxed), 0);
        assert_eq!(second_calls.load(Ordering::Relaxed), 1);
        assert_eq!(wrapper.model_name(), "model-b");
        assert!(matches!(
            rx.try_recv(),
            Ok(CodingRuntimeEvent::ModelSwitched {
                provider,
                model,
                requested_at: seen_requested,
                ..
            }) if provider == "provider-b" && model == "model-b" && seen_requested == requested_at
        ));

        // A second request uses the already-swapped provider without another event.
        let _ = wrapper
            .chat_stream(&[], &[], &ChatOptions::default())
            .await
            .expect("stream");
        assert_eq!(second_calls.load(Ordering::Relaxed), 2);
        assert!(rx.try_recv().is_err());
    }
}
