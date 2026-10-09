//! Narrow source-repair bridge supplied by a capable CLI host.
//! Native repair owns file validation and frozen export; this module owns HTTP
//! admission. It cannot prepare candidates, run probes, send packets or activate code.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{auth_token, coded_json_error, AppState};

const PROTOCOL: u32 = 1;
const MAX_REQUEST_BYTES: usize = 16 * 1024;
const MAX_PATH_BYTES: usize = 4096;
const UNAVAILABLE_REASON: &str = "This server was started without a native repair backend.";
const TOKEN_REQUIRED_REASON: &str = "Repair requires a valid WebUI access token.";

/// The complete host operation surface. Paths are data, never shell arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RepairRequest {
    Info {
        source: PathBuf,
    },
    Preview {
        source: PathBuf,
        run: PathBuf,
    },
    Export {
        source: PathBuf,
        run: PathBuf,
        accept: String,
        output: PathBuf,
    },
}

/// Implemented by the CLI host, keeping the existing CLI -> daemon dependency.
pub trait RepairBackend: Send + Sync {
    fn execute(&self, request: RepairRequest) -> anyhow::Result<Value>;
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InfoInput {
    source: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewInput {
    source: String,
    run: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExportInput {
    source: String,
    run: String,
    accept: String,
    output: String,
}

pub(crate) fn register_repair_routes(
    router: Router<AppState>,
    state: AppState,
) -> Router<AppState> {
    let repair = Router::new()
        .route("/repair/capability", get(capability))
        .route("/repair/info", post(info))
        .route("/repair/preview", post(preview))
        .route("/repair/export", post(export))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .route_layer(middleware::from_fn_with_state(state, authorize));
    router.merge(repair)
}

fn error(status: StatusCode, code: &str, message: impl Into<String>, retryable: bool) -> Response {
    no_store(coded_json_error(status, code, message, retryable).into_response())
}

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn authorize(State(state): State<AppState>, req: Request, next: Next) -> Response {
    // Capability is static metadata; every operation that can touch a file is
    // POST and requires a real token even in no-token or optional-token mode.
    if req.method() == Method::POST {
        if !auth_token::has_valid_webui_token(&state, req.headers()) {
            return error(
                StatusCode::UNAUTHORIZED,
                "repair_unauthorized",
                TOKEN_REQUIRED_REASON,
                false,
            );
        }
        if !origin_matches_host(req.headers()) {
            return error(
                StatusCode::FORBIDDEN,
                "repair_origin_mismatch",
                "Repair requires an HTTP or HTTPS Origin matching the request Host and port.",
                false,
            );
        }
    }
    no_store(next.run(req).await)
}

fn authority_url(scheme: &str, authority: &str) -> Option<reqwest::Url> {
    if authority.is_empty()
        || authority.ends_with(':')
        || authority
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || "/\\@?#%".contains(c))
    {
        return None;
    }
    let url = reqwest::Url::parse(&format!("{scheme}://{authority}")).ok()?;
    if url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(url)
}

fn origin_matches_host(headers: &HeaderMap) -> bool {
    if headers.get_all(header::ORIGIN).iter().count() != 1
        || headers.get_all(header::HOST).iter().count() != 1
    {
        return false;
    }
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Some((scheme, authority)) = origin.split_once("://") else {
        return false;
    };
    if !matches!(scheme, "http" | "https") {
        return false;
    }
    let authority = authority.strip_suffix('/').unwrap_or(authority);
    let Some(origin) = authority_url(scheme, authority) else {
        return false;
    };
    let Some(request) = authority_url(scheme, host) else {
        return false;
    };
    // Compare the browser's authority with Host, including effective ports.
    // Do not trust forwarded headers. HTTPS termination must preserve Host;
    // this guard does not claim to authenticate the proxy's transport scheme.
    origin.host() == request.host()
        && origin.port_or_known_default() == request.port_or_known_default()
}

async fn capability(State(state): State<AppState>, headers: HeaderMap) -> Json<Value> {
    let reason = if state.repair_backend.is_none() {
        Some(UNAVAILABLE_REASON)
    } else if !auth_token::has_valid_webui_token(&state, &headers) {
        Some(TOKEN_REQUIRED_REASON)
    } else {
        None
    };
    Json(json!({
        "status": if reason.is_none() { "available" } else { "unavailable" },
        "protocol": PROTOCOL,
        "reason": reason,
    }))
}

fn parse_body<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, Response> {
    body.map(|Json(value)| value).map_err(|rejection| {
        error(
            rejection.status(),
            "repair_invalid_request",
            rejection.body_text(),
            false,
        )
    })
}

fn absolute_path(value: String, field: &str) -> Result<PathBuf, Response> {
    if value.is_empty()
        || value.len() > MAX_PATH_BYTES
        || value.chars().any(char::is_control)
        || !Path::new(&value).is_absolute()
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "repair_invalid_path",
            format!("{field} must be an absolute path of at most {MAX_PATH_BYTES} bytes without control characters."),
            false,
        ));
    }
    Ok(PathBuf::from(value))
}

fn accepted_digest(value: String) -> Result<String, Response> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "repair_invalid_digest",
            "accept must be the complete lowercase SHA-256 of the displayed packet.",
            false,
        ));
    }
    Ok(value)
}

async fn info(
    State(state): State<AppState>,
    body: Result<Json<InfoInput>, JsonRejection>,
) -> Response {
    let request = (|| {
        let input = parse_body(body)?;
        Ok(RepairRequest::Info {
            source: absolute_path(input.source, "source")?,
        })
    })();
    dispatch(state, request).await
}

async fn preview(
    State(state): State<AppState>,
    body: Result<Json<PreviewInput>, JsonRejection>,
) -> Response {
    let request = (|| {
        let input = parse_body(body)?;
        Ok(RepairRequest::Preview {
            source: absolute_path(input.source, "source")?,
            run: absolute_path(input.run, "run")?,
        })
    })();
    dispatch(state, request).await
}

async fn export(
    State(state): State<AppState>,
    body: Result<Json<ExportInput>, JsonRejection>,
) -> Response {
    let request = (|| {
        let input = parse_body(body)?;
        Ok(RepairRequest::Export {
            source: absolute_path(input.source, "source")?,
            run: absolute_path(input.run, "run")?,
            accept: accepted_digest(input.accept)?,
            output: absolute_path(input.output, "output")?,
        })
    })();
    dispatch(state, request).await
}

async fn dispatch(state: AppState, request: Result<RepairRequest, Response>) -> Response {
    let request = match request {
        Ok(request) => request,
        Err(error) => return error,
    };
    let Some(backend) = state.repair_backend.clone() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "repair_unavailable",
            UNAVAILABLE_REASON,
            false,
        );
    };
    let permit = match Arc::clone(&state.repair_operations).try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            return error(
                StatusCode::CONFLICT,
                "repair_busy",
                "Another repair operation is still running.",
                true,
            );
        }
    };
    let result = tokio::task::spawn_blocking(move || {
        // The blocking operation owns the permit: disconnecting or canceling
        // its HTTP waiter must not admit another operation while it still runs.
        let _permit = permit;
        backend.execute(request)
    })
    .await;
    match result {
        Ok(Ok(value)) => no_store(Json(value).into_response()),
        Ok(Err(failure)) => error(
            StatusCode::BAD_REQUEST,
            "repair_failed",
            format!("{failure:#}"),
            false,
        ),
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "repair_backend_failed",
            "The native repair operation did not complete normally.",
            false,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::Ordering, Mutex};
    use std::time::Duration;

    fn origin_headers(origin: &str, host: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
        headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        headers
    }

    #[test]
    fn origin_guard_supports_actual_host_and_effective_ports() {
        for (origin, host) in [
            ("http://127.0.0.1:13457", "127.0.0.1:13457"),
            ("http://LOCALHOST", "localhost:80"),
            ("http://[::1]:13457", "[::1]:13457"),
            ("https://repair.example", "repair.example:443"),
            ("https://repair.example:8443", "repair.example:8443"),
            ("http://100.100.20.30:13457", "100.100.20.30:13457"),
        ] {
            assert!(
                origin_matches_host(&origin_headers(origin, host)),
                "{origin} {host}"
            );
        }
    }

    #[test]
    fn origin_guard_rejects_cross_origin_ambiguous_and_forwarded_authorities() {
        for (origin, host) in [
            ("http://localhost:1234", "localhost:13457"),
            ("http://192.168.1.50:13457", "127.0.0.1:13457"),
            ("http://other.ts.net", "owner.ts.net"),
            ("https://evil.example", "repair.example"),
            ("null", "localhost"),
            ("file://localhost", "localhost"),
            ("https://user@repair.example", "repair.example"),
            ("https://repair.example/path", "repair.example"),
            ("https://repair.example/../", "repair.example"),
            ("https://repair.example?key=value", "repair.example"),
            ("https://repair.example#fragment", "repair.example"),
            ("https://repair.example", "repair.example/path"),
            ("https://repair.example", "user@repair.example"),
            ("https://repair.example", "repair.example:"),
        ] {
            assert!(
                !origin_matches_host(&origin_headers(origin, host)),
                "{origin} {host}"
            );
        }
        let mut headers = origin_headers("https://public.example", "127.0.0.1:13457");
        headers.insert(
            "x-forwarded-host",
            HeaderValue::from_static("public.example"),
        );
        assert!(!origin_matches_host(&headers));
        let mut headers = origin_headers("http://localhost", "localhost");
        headers.append(header::ORIGIN, HeaderValue::from_static("http://localhost"));
        assert!(!origin_matches_host(&headers));
        assert!(!origin_matches_host(&HeaderMap::new()));
    }

    #[derive(Default)]
    struct RecordingBackend {
        requests: Mutex<Vec<RepairRequest>>,
    }

    impl RecordingBackend {
        fn count(&self) -> usize {
            self.requests.lock().unwrap().len()
        }
    }

    impl RepairBackend for RecordingBackend {
        fn execute(&self, request: RepairRequest) -> anyhow::Result<Value> {
            let operation = match &request {
                RepairRequest::Info { .. } => "info",
                RepairRequest::Preview { .. } => "preview",
                RepairRequest::Export { .. } => "export",
            };
            self.requests.lock().unwrap().push(request);
            Ok(json!({ "operation": operation, "payload": "unchanged native result" }))
        }
    }

    struct TestServer {
        base: String,
        client: reqwest::Client,
        task: tokio::task::JoinHandle<()>,
    }

    impl TestServer {
        async fn start(state: AppState) -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            // Match production ordering: old optional auth covers old routes;
            // repair supplies its mandatory guard and then shares app-user auth.
            let existing = Router::new()
                .route(
                    "/legacy-test",
                    post(|| async { Json(json!({ "ok": true })) }),
                )
                .route_layer(middleware::from_fn_with_state(
                    state.clone(),
                    auth_token::require_webui_token,
                ));
            let app = register_repair_routes(existing, state.clone())
                .route_layer(middleware::from_fn_with_state(
                    state.clone(),
                    auth_token::require_app_user_id,
                ))
                .with_state(state);
            let task = tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            Self {
                base,
                client: reqwest::Client::builder()
                    .no_proxy()
                    .timeout(Duration::from_secs(5))
                    .build()
                    .unwrap(),
                task,
            }
        }

        fn post(&self, path: &str) -> reqwest::RequestBuilder {
            self.client
                .post(format!("{}{path}", self.base))
                .header(header::ORIGIN, &self.base)
                .bearer_auth("repair-api-test-token")
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn assert_error(response: reqwest::Response, status: StatusCode, code: &str) {
        assert_eq!(response.status(), status);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let value: Value = response.json().await.unwrap();
        assert_eq!(value["success"], false);
        assert_eq!(value["code"], code);
        assert!(value["error"]
            .as_str()
            .is_some_and(|message| !message.is_empty()));
    }

    #[tokio::test]
    async fn routes_and_capability_require_real_tokens_even_when_optional_auth_changes() {
        let home = crate::tests::ScopedChatHome::new();
        let mut state = crate::tests::chat_test_state(&home);
        let backend = Arc::new(RecordingBackend::default());
        state.repair_backend = Some(backend.clone());
        state.webui_tokens.register("repair-api-test-token");
        let server = TestServer::start(state.clone()).await;
        let source = std::env::temp_dir().join("repair-api-source");
        let body = json!({ "source": source });

        for (enforced, optional) in [(false, false), (true, false), (true, true), (false, true)] {
            state.enforce_token.store(enforced, Ordering::Relaxed);
            state.token_optional.store(optional, Ordering::Relaxed);
            let response = server
                .client
                .get(format!("{}/repair/capability", server.base))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let value: Value = response.json().await.unwrap();
            assert_eq!(
                value,
                json!({
                    "status": "unavailable", "protocol": 1, "reason": TOKEN_REQUIRED_REASON,
                })
            );
            let response = server
                .client
                .get(format!("{}/repair/capability", server.base))
                .bearer_auth("repair-api-test-token")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let value: Value = response.json().await.unwrap();
            assert_eq!(
                value,
                json!({
                    "status": "available", "protocol": 1, "reason": null,
                })
            );
            // Malformed JSON also proves token admission precedes body parsing.
            let response = server
                .client
                .post(format!("{}/repair/info", server.base))
                .header(header::ORIGIN, &server.base)
                .header(header::CONTENT_TYPE, "application/json")
                .body("{")
                .send()
                .await
                .unwrap();
            assert_error(response, StatusCode::UNAUTHORIZED, "repair_unauthorized").await;
            let legacy = server
                .client
                .post(format!("{}/legacy-test", server.base))
                .send()
                .await
                .unwrap();
            assert_eq!(
                legacy.status(),
                if enforced && !optional {
                    StatusCode::UNAUTHORIZED
                } else {
                    StatusCode::OK
                }
            );
        }
        assert_eq!(backend.count(), 0);

        let response = server
            .post("/repair/info")
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(backend.count(), 1);
        let cookie = format!("{}=repair-api-test-token", state.webui_cookie_name);
        let response = server
            .client
            .post(format!("{}/repair/info", server.base))
            .header(header::ORIGIN, &server.base)
            .header(header::COOKIE, &cookie)
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(backend.count(), 2);
        // An invalid higher-priority token must not fall back to a valid cookie.
        let response = server
            .client
            .post(format!("{}/repair/info", server.base))
            .header(header::ORIGIN, &server.base)
            .header(header::COOKIE, &cookie)
            .bearer_auth("wrong-token")
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_error(response, StatusCode::UNAUTHORIZED, "repair_unauthorized").await;
        assert_eq!(backend.count(), 2);
    }

    #[tokio::test]
    async fn routes_validate_origin_schema_paths_and_size_before_native_work() {
        let home = crate::tests::ScopedChatHome::new();
        let mut state = crate::tests::chat_test_state(&home);
        let backend = Arc::new(RecordingBackend::default());
        state.repair_backend = Some(backend.clone());
        state.webui_tokens.register("repair-api-test-token");
        let server = TestServer::start(state).await;
        let source = std::env::temp_dir().join("repair-api-source");
        let run = std::env::temp_dir().join("repair-api-run");
        let output = std::env::temp_dir().join("repair-api-export");
        let accept = "a".repeat(64);

        for origin in [None, Some("null"), Some("http://other.local:13457")] {
            let mut request = server
                .client
                .post(format!("{}/repair/info", server.base))
                .bearer_auth("repair-api-test-token");
            if let Some(origin) = origin {
                request = request.header(header::ORIGIN, origin);
            }
            let response = request
                .json(&json!({ "source": source }))
                .send()
                .await
                .unwrap();
            assert_error(response, StatusCode::FORBIDDEN, "repair_origin_mismatch").await;
        }
        for (path, body, status, code) in [
            (
                "/repair/info",
                json!({ "source": source, "command": "prepare" }),
                StatusCode::UNPROCESSABLE_ENTITY,
                "repair_invalid_request",
            ),
            (
                "/repair/info",
                json!({ "source": "relative" }),
                StatusCode::BAD_REQUEST,
                "repair_invalid_path",
            ),
            (
                "/repair/info",
                json!({ "source": format!("{}\n", source.display()) }),
                StatusCode::BAD_REQUEST,
                "repair_invalid_path",
            ),
            (
                "/repair/preview",
                json!({ "source": source, "run": "relative" }),
                StatusCode::BAD_REQUEST,
                "repair_invalid_path",
            ),
            (
                "/repair/export",
                json!({ "source": source, "run": run, "accept": "A".repeat(64), "output": output }),
                StatusCode::BAD_REQUEST,
                "repair_invalid_digest",
            ),
            (
                "/repair/export",
                json!({ "source": source, "run": run, "accept": "a".repeat(63), "output": output }),
                StatusCode::BAD_REQUEST,
                "repair_invalid_digest",
            ),
            (
                "/repair/export",
                json!({ "source": source, "run": run, "accept": accept, "output": "relative" }),
                StatusCode::BAD_REQUEST,
                "repair_invalid_path",
            ),
        ] {
            let response = server.post(path).json(&body).send().await.unwrap();
            assert_error(response, status, code).await;
        }
        let source_json = serde_json::to_string(&source).unwrap();
        let duplicate = format!("{{\"source\":{source_json},\"source\":{source_json}}}");
        let response = server
            .post("/repair/info")
            .header(header::CONTENT_TYPE, "application/json")
            .body(duplicate)
            .send()
            .await
            .unwrap();
        assert_error(
            response,
            StatusCode::UNPROCESSABLE_ENTITY,
            "repair_invalid_request",
        )
        .await;
        let response = server
            .post("/repair/info")
            .json(&json!({ "source": "x".repeat(MAX_REQUEST_BYTES) }))
            .send()
            .await
            .unwrap();
        assert_error(
            response,
            StatusCode::PAYLOAD_TOO_LARGE,
            "repair_invalid_request",
        )
        .await;
        assert_eq!(backend.count(), 0);

        for (path, body, operation) in [
            ("/repair/info", json!({ "source": source }), "info"),
            (
                "/repair/preview",
                json!({ "source": source, "run": run }),
                "preview",
            ),
            (
                "/repair/export",
                json!({ "source": source, "run": run, "accept": accept, "output": output }),
                "export",
            ),
        ] {
            let response = server.post(path).json(&body).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            let value: Value = response.json().await.unwrap();
            assert_eq!(
                value,
                json!({ "operation": operation, "payload": "unchanged native result" })
            );
        }
        assert_eq!(
            *backend.requests.lock().unwrap(),
            vec![
                RepairRequest::Info {
                    source: source.clone()
                },
                RepairRequest::Preview {
                    source: source.clone(),
                    run: run.clone()
                },
                RepairRequest::Export {
                    source,
                    run,
                    accept,
                    output
                },
            ]
        );
    }

    #[tokio::test]
    async fn unavailable_hosts_expose_capability_without_reading_files() {
        let home = crate::tests::ScopedChatHome::new();
        let state = crate::tests::chat_test_state(&home);
        state.webui_tokens.register("repair-api-test-token");
        let server = TestServer::start(state).await;
        let response = server
            .client
            .get(format!("{}/repair/capability", server.base))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let value: Value = response.json().await.unwrap();
        assert_eq!(
            value,
            json!({ "status": "unavailable", "protocol": 1, "reason": UNAVAILABLE_REASON })
        );
        let response = server
            .post("/repair/info")
            .json(&json!({ "source": std::env::temp_dir().join("nonexistent-repair-source") }))
            .send()
            .await
            .unwrap();
        assert_error(
            response,
            StatusCode::SERVICE_UNAVAILABLE,
            "repair_unavailable",
        )
        .await;
    }

    struct BlockingBackend {
        entered: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
    }

    impl RepairBackend for BlockingBackend {
        fn execute(&self, _request: RepairRequest) -> anyhow::Result<Value> {
            self.entered
                .lock()
                .unwrap()
                .take()
                .unwrap()
                .send(())
                .unwrap();
            self.release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))?;
            Ok(json!({ "finished": true }))
        }
    }

    #[tokio::test]
    async fn canceling_waiter_does_not_release_running_native_operation() {
        let home = crate::tests::ScopedChatHome::new();
        let mut state = crate::tests::chat_test_state(&home);
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        state.repair_backend = Some(Arc::new(BlockingBackend {
            entered: Mutex::new(Some(entered_tx)),
            release: Mutex::new(release_rx),
        }));
        let request = RepairRequest::Info {
            source: std::env::temp_dir(),
        };
        let waiter = tokio::spawn(dispatch(state.clone(), Ok(request.clone())));
        tokio::time::timeout(Duration::from_secs(3), entered_rx)
            .await
            .unwrap()
            .unwrap();
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        let response = dispatch(state.clone(), Ok(request)).await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["code"], "repair_busy");
        assert_eq!(value["retryable"], true);
        release_tx.send(()).unwrap();
        let permit = tokio::time::timeout(
            Duration::from_secs(3),
            Arc::clone(&state.repair_operations).acquire_owned(),
        )
        .await
        .unwrap()
        .unwrap();
        drop(permit);
    }
}
