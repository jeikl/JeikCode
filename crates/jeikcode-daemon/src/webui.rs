//! 嵌入式 webui 静态资源服务。
//!
//! 编译期把 `webui/dist/` 打进二进制；运行期 `GET /` 与未匹配的非 API 路径
//! 都回退到 `index.html`，交给前端 SPA 路由。
//!
//! dev 模式（设置 `JEIKCODE_WEBUI_DEV=http://localhost:5173`）下应改为反代/
//! 重定向到 vite dev server——后续任务实现。

use axum::{
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../../webui/dist/"]
#[allow_missing = true]
pub struct WebuiAssets;

/// 取静态资源；未命中时回退 index.html 的内容（SPA）。
pub fn asset_or_index(path: &str) -> Option<std::borrow::Cow<'static, [u8]>> {
    let p = path.trim_start_matches('/');
    if let Some(f) = WebuiAssets::get(p) {
        return Some(f.data);
    }
    WebuiAssets::get("index.html").map(|f| f.data)
}

/// axum handler：服务任意 webui 路径。
pub async fn serve_webui(uri: Uri) -> Response {
    // dev 模式：设置 JEIKCODE_WEBUI_DEV=http://localhost:5173 后，
    // 重定向到 vite dev server，前端开发可享受热更新而非嵌入 bundle。
    if let Ok(dev) = std::env::var("JEIKCODE_WEBUI_DEV") {
        let target = format!("{}{}", dev.trim_end_matches('/'), uri.path());
        return axum::response::Redirect::temporary(&target).into_response();
    }

    let path = uri.path();
    let p = path.trim_start_matches('/');
    let lookup = if p.is_empty() { "index.html" } else { p };
    match WebuiAssets::get(lookup) {
        Some(content) => {
            let mime = mime_guess::from_path(lookup).first_or_octet_stream();
            // 动静分级缓存策略：
            // 1. 带内容 Hash 的编译产物（assets/*）：永久强缓存（immutable），二次冷启动 0ms 命中本地磁盘缓存；
            // 2. index.html：强制 no-cache（必须向服务端核对，确保发版后即时拉取最新 Hash 资源）；
            // 3. 其他根静态资源（如 favicon.png）：短期缓存 1 小时。
            let cache_control = if lookup == "index.html" {
                "no-cache"
            } else if lookup.starts_with("assets/") {
                "public, max-age=31536000, immutable"
            } else {
                "public, max-age=3600"
            };
            (
                [
                    (header::CONTENT_TYPE, mime.as_ref()),
                    (header::CACHE_CONTROL, cache_control),
                ],
                content.data,
            )
                .into_response()
        }
        None => match WebuiAssets::get("index.html") {
            Some(index) => (
                [
                    (header::CONTENT_TYPE, "text/html"),
                    (header::CACHE_CONTROL, "no-cache"),
                ],
                index.data,
            )
                .into_response(),
            None => (StatusCode::NOT_FOUND, "webui not built").into_response(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_embedded_index() {
        assert!(
            WebuiAssets::get("index.html").is_some(),
            "index.html should be embedded"
        );
    }

    #[test]
    fn unknown_path_falls_back_to_index() {
        // 未知路径回退 index.html 内容（SPA 路由）
        assert!(
            asset_or_index("some/spa/route").is_some(),
            "SPA route should fall back to index"
        );
    }
}
