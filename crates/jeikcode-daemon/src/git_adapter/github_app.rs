//! 纯 Rust 原生的 GitHub App 认证模块
//!
//! 无需安装任何 Python 解释器或外部脚本。
//! 纯内存解析 RSA PEM 私钥、签发 RS256 JWT、并向 GitHub API 自动换取官方 [bot] 安装访问令牌。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
struct CachedInstallationToken {
    token: String,
    expires_at_secs: u64,
}

static TOKEN_CACHE: OnceLock<Mutex<HashMap<String, CachedInstallationToken>>> = OnceLock::new();

fn token_cache() -> &'static Mutex<HashMap<String, CachedInstallationToken>> {
    TOKEN_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Serialize, Deserialize)]
struct GitHubAppClaims {
    iat: i64,
    exp: i64,
    iss: String,
}

/// 使用纯 Rust 在内存中计算 RS256 签名的 GitHub App JWT（有效期 9 分钟）
pub fn create_app_jwt(app_id: u64, private_key_pem: &str) -> Result<String, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let claims = GitHubAppClaims {
        iat: now - 60,
        exp: now + (9 * 60),
        iss: app_id.to_string(),
    };

    let header = Header::new(Algorithm::RS256);
    let key = EncodingKey::from_rsa_pem(private_key_pem.trim().as_bytes())
        .map_err(|e| format!("Invalid RSA private key PEM: {e}"))?;

    encode(&header, &claims, &key).map_err(|e| format!("Failed to sign JWT in Rust: {e}"))
}

/// 核心函数：根据 App ID 和私钥，向 GitHub 换取官方 [bot] 安装访问令牌
/// 内置 55 分钟智能内存缓存：有效期内复用既有令牌，杜绝高频请求触发 GitHub 频率风控
pub async fn fetch_installation_token(
    app_id: u64,
    private_key_pem: &str,
    repo_identifier: &str,
) -> Result<(String, String), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let cache_key = format!("{app_id}:{repo_identifier}");

    // 1. 优先检查内存缓存：如果当前令牌距过期还有 5 分钟以上，直接复用，不向 GitHub 发送任何换签请求！
    {
        let guard = token_cache().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(cached) = guard.get(&cache_key) {
            if now + 300 < cached.expires_at_secs {
                return Ok((cached.token.clone(), "cached".to_string()));
            }
        }
    }

    let jwt = create_app_jwt(app_id, private_key_pem)?;
    let client = crate::git_adapter::shared_http_client();

    // 1. 查询该 App 的所有安装实体 (Installations)
    let resp = client
        .get("https://api.github.com/app/installations")
        .header("Authorization", format!("Bearer {jwt}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "JeikCode-Bot/1.0")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch GitHub App installations: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let err = resp.text().await.unwrap_or_default();
        return Err(format!(
            "GitHub App installations query failed ({status}): {err}"
        ));
    }

    let installations: Vec<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse installations JSON: {e}"))?;

    if installations.is_empty() {
        return Err(
            "No installations found for this GitHub App. Please click 'Install App' in your GitHub App settings to install it on your repository first!"
                .to_string(),
        );
    }

    // 2. 匹配目标仓库所在的安装 ID
    let target_inst = installations
        .iter()
        .find(|inst| {
            let account = inst["account"]["login"].as_str().unwrap_or("");
            if account.is_empty() {
                return false;
            }
            repo_identifier
                .to_lowercase()
                .contains(&account.to_lowercase())
        })
        .unwrap_or(&installations[0]);

    let inst_id = target_inst["id"]
        .as_u64()
        .ok_or_else(|| "Installation missing 'id'".to_string())?;

    // 3. 为该安装换取官方 Installation Access Token (ghs_...)
    let token_resp = client
        .post(format!(
            "https://api.github.com/app/installations/{inst_id}/access_tokens"
        ))
        .header("Authorization", format!("Bearer {jwt}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "JeikCode-Bot/1.0")
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| format!("Failed to create installation token: {e}"))?;

    if !token_resp.status().is_success() {
        let status = token_resp.status();
        let err = token_resp.text().await.unwrap_or_default();
        return Err(format!(
            "GitHub App token creation failed ({status}): {err}"
        ));
    }

    let token_json: serde_json::Value = token_resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse token response: {e}"))?;

    let token = token_json["token"]
        .as_str()
        .ok_or_else(|| "Response missing 'token'".to_string())?
        .to_string();

    // 写入内存缓存（按 55 分钟安全有效期缓存，即 3300 秒）
    {
        let mut guard = token_cache().lock().unwrap_or_else(|p| p.into_inner());
        guard.insert(
            cache_key,
            CachedInstallationToken {
                token: token.clone(),
                expires_at_secs: now + 3300,
            },
        );
    }

    Ok((token, inst_id.to_string()))
}
