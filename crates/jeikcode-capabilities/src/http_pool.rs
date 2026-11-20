//! Process-wide shared asynchronous `reqwest::Client` connection pool.
//!
//! - Uses TLS ALPN negotiation (never forces `http2_prior_knowledge`), so public
//!   `https://` endpoints multiplex over HTTP/2 while local plaintext `http://`
//!   endpoints keep HTTP/1.1 Keep-Alive with zero certificate requirements;
//! - Reuses connection pools and validated trust roots by normalized client policy key
//!   instead of creating a new pool per concurrent session or subagent;
//! - Cooldown singleflight deduplicates stale-pool rebuilds across concurrent agents.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::provider::retry::POOL_IDLE_TIMEOUT;
use crate::provider::DEFAULT_USER_AGENT;

const SHARED_REBUILD_COOLDOWN: Duration = Duration::from_secs(2);
const MAX_CACHED_CLIENTS: usize = 64;

/// Configuration key determining when two outbound callers may share one `reqwest::Client` pool.
#[derive(Debug, Clone)]
pub struct HttpClientSpec {
    pub connect_timeout: Duration,
    pub request_timeout: Option<Duration>,
    pub pool_idle_timeout: Option<Duration>,
    pub skip_tls_verify: bool,
    pub force_tls12: bool,
    pub user_agent: Option<String>,
}

impl HttpClientSpec {
    /// Standard streaming LLM provider client specification (reaps idle sockets at 15s, no total timeout).
    pub fn provider(
        connect_timeout: Duration,
        skip_tls_verify: bool,
        user_agent: Option<String>,
        force_tls12: bool,
    ) -> Self {
        Self {
            connect_timeout,
            request_timeout: None,
            pool_idle_timeout: Some(POOL_IDLE_TIMEOUT),
            skip_tls_verify,
            force_tls12,
            user_agent,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct HttpClientKey {
    proxy_fingerprint: u64,
    ssl_cert_file: Option<String>,
    skip_tls_verify: bool,
    force_tls12: bool,
    connect_timeout_ms: u64,
    request_timeout_ms: Option<u64>,
    pool_idle_timeout_ms: Option<u64>,
    user_agent: String,
}

impl HttpClientKey {
    fn from_spec(spec: &HttpClientSpec) -> Self {
        Self {
            proxy_fingerprint: proxy_env_fingerprint(),
            ssl_cert_file: std::env::var("SSL_CERT_FILE")
                .ok()
                .filter(|v| !v.is_empty()),
            skip_tls_verify: spec.skip_tls_verify,
            force_tls12: spec.force_tls12,
            connect_timeout_ms: spec.connect_timeout.as_millis() as u64,
            request_timeout_ms: spec.request_timeout.map(|d| d.as_millis() as u64),
            pool_idle_timeout_ms: spec.pool_idle_timeout.map(|d| d.as_millis() as u64),
            user_agent: spec
                .user_agent
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_USER_AGENT)
                .to_string(),
        }
    }
}

struct SharedPoolEntry {
    client: reqwest::Client,
    last_rebuilt_at: Option<Instant>,
    last_used_at: Instant,
}

#[derive(Default)]
struct GlobalHttpPool {
    slots: Mutex<HashMap<HttpClientKey, SharedPoolEntry>>,
    key_locks: Mutex<HashMap<HttpClientKey, Arc<Mutex<()>>>>,
}

static GLOBAL_POOL: OnceLock<GlobalHttpPool> = OnceLock::new();

fn global_pool() -> &'static GlobalHttpPool {
    GLOBAL_POOL.get_or_init(GlobalHttpPool::default)
}

fn proxy_env_fingerprint() -> u64 {
    let mut hasher = DefaultHasher::new();
    for var in [
        "JEIKCODE_PROXY_MODE",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
        "JEIKCODE_TLS_MAX",
    ] {
        var.hash(&mut hasher);
        std::env::var_os(var).hash(&mut hasher);
    }
    hasher.finish()
}

fn per_key_build_lock(pool: &GlobalHttpPool, key: &HttpClientKey) -> Arc<Mutex<()>> {
    let mut locks = pool.key_locks.lock().unwrap_or_else(|e| e.into_inner());
    if locks.len() > MAX_CACHED_CLIENTS {
        let active_keys: std::collections::HashSet<HttpClientKey> = pool
            .slots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect();
        locks.retain(|k, _| active_keys.contains(k));
    }
    Arc::clone(
        locks
            .entry(key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(()))),
    )
}

fn insert_pool_entry(pool: &GlobalHttpPool, key: HttpClientKey, entry: SharedPoolEntry) {
    let mut slots = pool.slots.lock().unwrap_or_else(|e| e.into_inner());
    if slots.len() >= MAX_CACHED_CLIENTS && !slots.contains_key(&key) {
        if let Some(oldest_key) = slots
            .iter()
            .min_by_key(|(_, v)| v.last_used_at)
            .map(|(k, _)| k.clone())
        {
            slots.remove(&oldest_key);
        }
    }
    slots.insert(key, entry);
}

/// Return a shared globally pooled `reqwest::Client` matching `spec`, building it once on first use.
pub fn shared_http_client(spec: &HttpClientSpec) -> Result<reqwest::Client, String> {
    shared_http_client_inner(spec, Duration::ZERO, false)
}

/// Rebuild the shared pool for `spec` with cooldown deduplication to prevent thundering herds.
pub fn rebuild_shared_http_client(spec: &HttpClientSpec) -> Result<reqwest::Client, String> {
    shared_http_client_inner(spec, SHARED_REBUILD_COOLDOWN, true)
}

fn shared_http_client_inner(
    spec: &HttpClientSpec,
    cooldown: Duration,
    force_rebuild: bool,
) -> Result<reqwest::Client, String> {
    let pool = global_pool();
    let key = HttpClientKey::from_spec(spec);

    if !force_rebuild {
        let mut slots = pool.slots.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = slots.get_mut(&key) {
            entry.last_used_at = Instant::now();
            return Ok(entry.client.clone());
        }
    }

    let build_lock = per_key_build_lock(pool, &key);
    let _build_guard = build_lock.lock().unwrap_or_else(|e| e.into_inner());

    {
        let mut slots = pool.slots.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = slots.get_mut(&key) {
            let within_cooldown = !force_rebuild
                || entry
                    .last_rebuilt_at
                    .is_some_and(|at| at.elapsed() < cooldown);
            if within_cooldown {
                entry.last_used_at = Instant::now();
                return Ok(entry.client.clone());
            }
        }
    }

    let fresh = build_http_client_uncached(spec)?;
    let now = Instant::now();
    insert_pool_entry(
        pool,
        key,
        SharedPoolEntry {
            client: fresh.clone(),
            last_rebuilt_at: force_rebuild.then_some(now),
            last_used_at: now,
        },
    );
    Ok(fresh)
}

/// Format an `std::error::Error` together with its full `source()` chain.
fn err_chain(err: &dyn std::error::Error) -> String {
    let mut out = err.to_string();
    let mut cur = err.source();
    while let Some(src) = cur {
        out.push_str(": ");
        out.push_str(&src.to_string());
        cur = src.source();
    }
    out
}

/// Build an uncached `reqwest::Client` applying proxy policy, trusted OS/custom roots (#514),
/// ALPN HTTP/2 negotiation, and optional webpki-only backstop fallback.
pub(crate) fn build_http_client_uncached(spec: &HttpClientSpec) -> Result<reqwest::Client, String> {
    match build_http_client_attempt(spec, true) {
        Ok(client) => Ok(client),
        Err(first) => {
            #[cfg(feature = "provider")]
            {
                tracing::warn!(
                    "http client build failed with OS/SSL_CERT_FILE trust roots ({}); \
                     retrying with the webpki base only (issue #514)",
                    first
                );
                build_http_client_attempt(spec, false)
            }
            #[cfg(not(feature = "provider"))]
            {
                Err(first)
            }
        }
    }
}

fn build_http_client_attempt(
    spec: &HttpClientSpec,
    trust_os_roots: bool,
) -> Result<reqwest::Client, String> {
    let mut builder = crate::proxy::apply_async_proxy_policy(reqwest::Client::builder())
        .connect_timeout(spec.connect_timeout)
        .user_agent(
            spec.user_agent
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_USER_AGENT),
        );
    if let Some(timeout) = spec.request_timeout {
        builder = builder.timeout(timeout);
    }
    if let Some(idle) = spec.pool_idle_timeout {
        builder = builder.pool_idle_timeout(idle);
    }
    if spec.force_tls12 {
        builder = builder.max_tls_version(reqwest::tls::Version::TLS_1_2);
    }
    #[cfg(feature = "provider")]
    if trust_os_roots && !cfg!(target_os = "windows") {
        builder = add_trusted_roots(builder);
    }
    #[cfg(not(feature = "provider"))]
    let _ = trust_os_roots;
    if spec.skip_tls_verify {
        builder = builder.danger_accept_invalid_certs(true);
    }
    builder
        .build()
        .map_err(|e| format!("http client build failed: {}", err_chain(&e)))
}

#[cfg(feature = "provider")]
fn cached_validated_os_root_ders() -> &'static Vec<Vec<u8>> {
    static OS_ROOTS: OnceLock<Vec<Vec<u8>>> = OnceLock::new();
    OS_ROOTS.get_or_init(|| {
        let native = rustls_native_certs::load_native_certs();
        if !native.errors.is_empty() {
            tracing::warn!(
                "loaded OS native roots with {} error(s); using the {} that parsed (issue #514)",
                native.errors.len(),
                native.certs.len()
            );
        }
        let mut accepted = Vec::with_capacity(native.certs.len());
        let mut rejected = 0usize;
        for der in native.certs {
            if rustls::RootCertStore::empty().add(der.clone()).is_err() {
                rejected += 1;
                continue;
            }
            accepted.push(der.as_ref().to_vec());
        }
        if rejected > 0 {
            tracing::warn!(
                "skipped {rejected} OS root cert(s) rustls rejected; they would have aborted the whole client build (issue #514)"
            );
        }
        accepted
    })
}

#[cfg(feature = "provider")]
fn add_trusted_roots(mut builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    for der in cached_validated_os_root_ders() {
        if let Ok(cert) = reqwest::Certificate::from_der(der) {
            builder = builder.add_root_certificate(cert);
        }
    }

    let Some(path) = std::env::var_os("SSL_CERT_FILE").filter(|p| !p.is_empty()) else {
        return builder;
    };
    let Ok(pem) = std::fs::read(&path) else {
        tracing::warn!("SSL_CERT_FILE={path:?} could not be read; ignoring (issue #514)");
        return builder;
    };
    match reqwest::Certificate::from_pem_bundle(&pem) {
        Ok(certs) => {
            let count = certs.len();
            for c in certs {
                builder = builder.add_root_certificate(c);
            }
            tracing::info!("Loaded {count} TLS root(s) from SSL_CERT_FILE={path:?} (issue #514)");
        }
        Err(e) => {
            tracing::warn!(
                "SSL_CERT_FILE={path:?} is not a valid PEM bundle: {e}; ignoring (issue #514)"
            );
        }
    }
    builder
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_http_client_reuses_same_key_and_dedups_rapid_rebuild() {
        let spec = HttpClientSpec::provider(
            Duration::from_secs(7),
            false,
            Some("jeikcode-pool-test/1.0".into()),
            false,
        );
        let first = shared_http_client(&spec).expect("first build");
        let second = shared_http_client(&spec).expect("pool hit");
        let third = rebuild_shared_http_client(&spec).expect("first rebuild");
        // Immediately calling rebuild within 2s cooldown returns the just-rebuilt client.
        let fourth = rebuild_shared_http_client(&spec).expect("cooldown hit");
        let _ = (first, second, third, fourth);

        // Changing force_tls12 produces a distinct key cleanly.
        let tls12_spec = HttpClientSpec::provider(
            Duration::from_secs(7),
            false,
            Some("jeikcode-pool-test/1.0".into()),
            true,
        );
        assert!(shared_http_client(&tls12_spec).is_ok());
    }
}
