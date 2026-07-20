//! OAuth 2.0 / 2.1 authentication module — Rust port of presence/auth.py
//!
//! Covers:
//! - PKCE code verifier/challenge generation (RFC 7636, S256)
//! - Kick OAuth 2.1 login + callback (PKCE + state)
//! - Twitch OAuth 2.0 login + callback
//! - Token refresh for both platforms
//! - Kick category database sync
//! - Axum-based OAuth callback HTTP server (replaces Flask routes)
//! - Widget token rotation (Security Audit #5)
//! - Fixed postMessage origin (Security Audit #2)
//! - Loopback on 127.0.0.1 only (Security Audit #1)

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    response::Html,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::task;

use crate::app_base_dir;
use crate::config::AppConfig;

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const KICK_AUTH_URL: &str = "https://id.kick.com/oauth/authorize";
const KICK_TOKEN_URL: &str = "https://id.kick.com/oauth/token";
const KICK_REDIRECT_URI: &str = "http://localhost:53735/oauth/callback/kick";
const KICK_CATEGORIES_URL: &str = "https://api.kick.com/public/v2/categories?limit=1000";

const TWITCH_AUTH_URL: &str = "https://id.twitch.tv/oauth2/authorize";
const TWITCH_TOKEN_URL: &str = "https://id.twitch.tv/oauth2/token";
const TWITCH_REDIRECT_URI: &str = "https://127.0.0.1:53735/oauth/callback/twitch";
const TWITCH_USERS_URL: &str = "https://api.twitch.tv/helix/users";

/// postMessage origin — NOT wildcard "*" (Security Audit #2)
const WEBVIEW_ORIGIN: &str = "http://localhost:5173";

// ═══════════════════════════════════════════════════════════════════════════════
// PKCE (RFC 7636)
// ═══════════════════════════════════════════════════════════════════════════════

pub fn generate_code_verifier() -> String {
    let mut bytes = vec![0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(&bytes)
}

pub fn generate_code_challenge(verifier: &str) -> String {
    let hash = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hash)
}

// ═══════════════════════════════════════════════════════════════════════════════
// OAuth State
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Default)]
pub struct PkceState {
    pub verifier: String,
    pub state: String,
}

pub struct OAuthState {
    /// Pending PKCE verifiers and state tokens, keyed by platform ("kick", "twitch")
    pub pkce: Mutex<HashMap<String, PkceState>>,
}

impl OAuthState {
    pub fn new() -> Self {
        Self {
            pkce: Mutex::new(HashMap::new()),
        }
    }
}

pub type SharedOAuthState = Arc<OAuthState>;

// ═══════════════════════════════════════════════════════════════════════════════
// HTML Popup Response (replaces _popup_response from auth.py)
// ═══════════════════════════════════════════════════════════════════════════════

fn build_popup_response(platform: &str, success: bool, error_msg: &str) -> String {
    let status = if success { "success" } else { "error" };
    let title = if success {
        format!("{} Connected!", capitalize(platform))
    } else {
        format!("{} Connection Failed", capitalize(platform))
    };
    let icon = if success { "&#10003;" } else { "&#10007;" };
    let bg = if success {
        "rgba(76,175,80,0.12)"
    } else {
        "rgba(244,67,54,0.12)"
    };
    let fg = if success { "#4caf50" } else { "#f44336" };
    let border = if success {
        "rgba(76,175,80,0.2)"
    } else {
        "rgba(244,67,54,0.2)"
    };
    let msg = if success {
        "You can close this window."
    } else {
        "Please try again from the Settings tab."
    };
    let detail = if success {
        String::new()
    } else {
        format!(
            "<p style=\"font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;word-break:break-all;\">{}</p>",
            html_escape(error_msg)
        )
    };
    let payload = serde_json::json!({
        "type": "oauth-callback",
        "platform": platform,
        "status": status,
        "error": error_msg,
    });

    format!(
        r#"<!DOCTYPE html><html><head><meta charset="utf-8"><title>StatusForge</title>
<style>
body{{background:#050505;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif}}
.card{{background:#0c0c0c;border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:40px 36px;text-align:center;max-width:360px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.6)}}
.icon{{width:56px;height:56px;border-radius:16px;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:24px;background:{bg};color:{fg};border:1px solid {border}}}
h1{{font-size:17px;color:#fff;margin:0 0 6px}}
p{{font-size:13px;color:rgba(255,255,255,0.45);margin:0}}
.brand{{position:fixed;bottom:16px;left:0;right:0;text-align:center;font-size:10px;color:rgba(255,255,255,0.12);letter-spacing:0.5px}}
</style></head><body>
<div class="card">
<div class="icon">{icon}</div>
<h1>{title}</h1>
<p>{msg}</p>
{detail}
</div>
<div class="brand">StatusForge</div>
<script>
try{{window.opener&&window.opener.postMessage({payload},"{origin}")}}catch(e){{}}
setTimeout(function(){{window.close()}},1500);
</script>
</body></html>"#,
        bg = bg,
        fg = fg,
        border = border,
        icon = icon,
        title = title,
        msg = msg,
        detail = detail,
        payload = payload,
        origin = WEBVIEW_ORIGIN,
    )
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(ch) => ch.to_uppercase().collect::<String>() + c.as_str(),
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#x27;")
}

// ═══════════════════════════════════════════════════════════════════════════════
// Unified OAuth Callback Handler
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Deserialize)]
pub struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

/// Single callback route: /oauth/callback/:platform
/// Handles both "kick" and "twitch". Mounted by `server::build_router`.
pub async fn oauth_callback(
    Path(platform): Path<String>,
    Query(params): Query<CallbackQuery>,
    State(oauth_state): State<SharedOAuthState>,
) -> Html<String> {
    let error_desc = params
        .error_description
        .clone()
        .or(params.error.clone())
        .unwrap_or_default();

    // OAuth-level error from the authorization server
    if params.error.is_some() {
        return Html(build_popup_response(&platform, false, &error_desc));
    }

    let code = match params.code {
        Some(c) if !c.is_empty() => c,
        _ => {
            return Html(build_popup_response(
                &platform,
                false,
                "No authorization code received",
            ));
        }
    };

    // Load config
    let base_dir = match app_base_dir() {
        Ok(d) => d,
        Err(e) => return Html(build_popup_response(&platform, false, &e)),
    };
    let mut config = match load_config_at(&base_dir) {
        Ok(c) => c,
        Err(e) => return Html(build_popup_response(&platform, false, &e)),
    };

    match platform.as_str() {
        "kick" => {
            handle_kick_callback(code, params.state, &mut config, &base_dir, &oauth_state).await
        }
        "twitch" => {
            handle_twitch_callback(code, params.state, &mut config, &base_dir, &oauth_state).await
        }
        other => Html(build_popup_response(other, false, "Unknown platform")),
    }
}

async fn handle_kick_callback(
    code: String,
    state: Option<String>,
    config: &mut AppConfig,
    base_dir: &std::path::Path,
    oauth_state: &OAuthState,
) -> Html<String> {
    // Validate PKCE state
    let pkce = {
        let mut guard = oauth_state.pkce.lock().unwrap();
        guard.remove("kick")
    };
    let pkce = match pkce {
        Some(p) => p,
        None => {
            return Html(build_popup_response(
                "kick",
                false,
                "No PKCE state — possible CSRF",
            ))
        }
    };
    if state.as_ref() != Some(&pkce.state) {
        return Html(build_popup_response(
            "kick",
            false,
            "State mismatch — possible CSRF",
        ));
    }

    let client_id = &config.broadcaster.kick_client;
    let client_secret = &config.broadcaster.kick_secret;
    if client_id.is_empty() || client_secret.is_empty() {
        return Html(build_popup_response(
            "kick",
            false,
            "Kick client_id or secret not configured",
        ));
    }

    // Exchange code for tokens
    let token_resp =
        match exchange_kick_token(&code, client_id, client_secret, &pkce.verifier).await {
            Ok(r) => r,
            Err(e) => return Html(build_popup_response("kick", false, &e)),
        };

    config.broadcaster.kick_token = token_resp.access_token.clone();
    config.broadcaster.kick_refresh = token_resp.refresh_token.clone().unwrap_or_default();
    if let Err(e) = save_config_at(base_dir, config) {
        log::warn!("[AUTH] Failed to save Kick tokens: {}", e);
    }

    // Sync Kick category database in background
    let access_token = token_resp.access_token.clone();
    let base = base_dir.to_owned();
    task::spawn(async move {
        if let Err(e) = sync_kick_database(&access_token, &base).await {
            log::warn!("[AUTH] Kick DB sync failed: {}", e);
        }
    });

    Html(build_popup_response("kick", true, ""))
}

async fn handle_twitch_callback(
    code: String,
    state: Option<String>,
    config: &mut AppConfig,
    base_dir: &std::path::Path,
    oauth_state: &OAuthState,
) -> Html<String> {
    // Validate the CSRF state token, same as Kick's flow — without this, an
    // attacker who starts their own Twitch OAuth flow could get a victim to
    // hit this callback with the attacker's own `code`, causing the app to
    // store the attacker's tokens as if they were the user's connection.
    let pending = {
        let mut guard = oauth_state.pkce.lock().unwrap();
        guard.remove("twitch")
    };
    let pending = match pending {
        Some(p) => p,
        None => {
            return Html(build_popup_response(
                "twitch",
                false,
                "No pending request — possible CSRF",
            ))
        }
    };
    if state.as_ref() != Some(&pending.state) {
        return Html(build_popup_response(
            "twitch",
            false,
            "State mismatch — possible CSRF",
        ));
    }

    let client_id = &config.broadcaster.twitch_client;
    let client_secret = &config.broadcaster.twitch_secret;
    if client_id.is_empty() || client_secret.is_empty() {
        return Html(build_popup_response(
            "twitch",
            false,
            "Twitch client_id or secret not configured",
        ));
    }

    let token_resp =
        match exchange_twitch_token(&code, client_id, client_secret, &pending.verifier).await {
            Ok(r) => r,
            Err(e) => return Html(build_popup_response("twitch", false, &e)),
        };

    // Fetch broadcaster ID
    let access_token = token_resp.access_token.clone();
    let broadcaster_id = match fetch_twitch_broadcaster_id(&access_token, client_id).await {
        Ok(id) => id,
        Err(e) => {
            log::warn!("[AUTH] Failed to fetch Twitch broadcaster ID: {}", e);
            String::new()
        }
    };

    config.broadcaster.twitch_token = access_token;
    config.broadcaster.twitch_refresh = token_resp.refresh_token.clone().unwrap_or_default();
    if !broadcaster_id.is_empty() {
        config.broadcaster.twitch_broadcaster_id = broadcaster_id;
    }
    if let Err(e) = save_config_at(base_dir, config) {
        log::warn!("[AUTH] Failed to save Twitch tokens: {}", e);
    }

    Html(build_popup_response("twitch", true, ""))
}

// ═══════════════════════════════════════════════════════════════════════════════
// Token Exchange HTTP Calls
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Debug)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    #[allow(dead_code)]
    expires_in: Option<u64>,
}

async fn exchange_kick_token(
    code: &str,
    client_id: &str,
    client_secret: &str,
    code_verifier: &str,
) -> Result<TokenResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let params = [
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("redirect_uri", KICK_REDIRECT_URI),
        ("code", code),
        ("code_verifier", code_verifier),
    ];

    let resp = client
        .post(KICK_TOKEN_URL)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Kick token exchange failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Kick token exchange: {}",
            resp.text().await.unwrap_or_default()
        ));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Kick token parse error: {}", e))?;
    Ok(TokenResponse {
        access_token: json["access_token"].as_str().unwrap_or("").to_string(),
        refresh_token: json["refresh_token"].as_str().map(|s| s.to_string()),
        expires_in: json["expires_in"].as_u64(),
    })
}

async fn exchange_twitch_token(
    code: &str,
    client_id: &str,
    client_secret: &str,
    code_verifier: &str,
) -> Result<TokenResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let params = [
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("redirect_uri", TWITCH_REDIRECT_URI),
        ("code", code),
        ("code_verifier", code_verifier),
    ];

    let resp = client
        .post(TWITCH_TOKEN_URL)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Twitch token exchange failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Twitch token exchange: {}",
            resp.text().await.unwrap_or_default()
        ));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Twitch token parse error: {}", e))?;
    Ok(TokenResponse {
        access_token: json["access_token"].as_str().unwrap_or("").to_string(),
        refresh_token: json["refresh_token"].as_str().map(|s| s.to_string()),
        expires_in: json["expires_in"].as_u64(),
    })
}

async fn fetch_twitch_broadcaster_id(
    access_token: &str,
    client_id: &str,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = client
        .get(TWITCH_USERS_URL)
        .header("Authorization", format!("Bearer {}", access_token))
        .header("Client-Id", client_id)
        .send()
        .await
        .map_err(|e| format!("Twitch users request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Twitch users request returned {}", resp.status()));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Twitch users parse error: {}", e))?;
    Ok(json["data"][0]["id"].as_str().unwrap_or("").to_string())
}

// ═══════════════════════════════════════════════════════════════════════════════
// Token Refresh
// ═══════════════════════════════════════════════════════════════════════════════

pub fn refresh_kick_token(config: &AppConfig) -> Result<String, String> {
    let (client_id, client_secret, refresh_token) = (
        &config.broadcaster.kick_client,
        &config.broadcaster.kick_secret,
        &config.broadcaster.kick_refresh,
    );
    if client_id.is_empty() || client_secret.is_empty() || refresh_token.is_empty() {
        return Err("Missing Kick credentials for token refresh".to_string());
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = client
        .post(KICK_TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("refresh_token", refresh_token.as_str()),
        ])
        .send()
        .map_err(|e| format!("Kick refresh failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Kick refresh: {}", resp.text().unwrap_or_default()));
    }

    let json: serde_json::Value = resp
        .json()
        .map_err(|e| format!("Kick refresh parse error: {}", e))?;
    Ok(json["access_token"].as_str().unwrap_or("").to_string())
}

pub fn refresh_twitch_token(config: &AppConfig) -> Result<String, String> {
    let (client_id, client_secret, refresh_token) = (
        &config.broadcaster.twitch_client,
        &config.broadcaster.twitch_secret,
        &config.broadcaster.twitch_refresh,
    );
    if client_id.is_empty() || client_secret.is_empty() || refresh_token.is_empty() {
        return Err("Missing Twitch credentials for token refresh".to_string());
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = client
        .post(TWITCH_TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("refresh_token", refresh_token.as_str()),
        ])
        .send()
        .map_err(|e| format!("Twitch refresh failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Twitch refresh: {}",
            resp.text().unwrap_or_default()
        ));
    }

    let json: serde_json::Value = resp
        .json()
        .map_err(|e| format!("Twitch refresh parse error: {}", e))?;
    Ok(json["access_token"].as_str().unwrap_or("").to_string())
}

// ═══════════════════════════════════════════════════════════════════════════════
// Manual Token Validation — "alternate connection" for users who generate
// their own access token via an external OAuth tool/callback instead of
// using our "Connect X" popup. Confirms the token actually works and backs
// out the identity fields (channel slug / broadcaster ID) the OAuth flow
// would normally have fetched automatically.
// ═══════════════════════════════════════════════════════════════════════════════

/// Validates a manually-pasted Kick access token via `GET /public/v1/users`
/// (also serves as Kick's de facto token-introspection endpoint — a 401
/// means the token is invalid/expired). Returns (display_name, channel_slug).
pub async fn validate_kick_token(token: &str) -> Result<(String, String), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let user_resp = client
        .get("https://api.kick.com/public/v1/users")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Kick token validation failed: {}", e))?;
    if !user_resp.status().is_success() {
        return Err(format!(
            "Kick token invalid or expired ({})",
            user_resp.status()
        ));
    }
    let user_json: serde_json::Value = user_resp
        .json()
        .await
        .map_err(|e| format!("Kick user response parse error: {}", e))?;
    let name = user_json["data"][0]["name"]
        .as_str()
        .unwrap_or("")
        .to_string();
    if name.is_empty() {
        return Err("Kick token has no associated user".to_string());
    }

    // Best-effort: the channel slug isn't required for a valid connection,
    // just nice to have for the Channel ID field.
    let slug = client
        .get("https://api.kick.com/public/v1/channels")
        .bearer_auth(token)
        .send()
        .await
        .ok()
        .filter(|r| r.status().is_success());
    let slug = match slug {
        Some(r) => r
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|j| j["data"][0]["slug"].as_str().map(str::to_string))
            .unwrap_or_default(),
        None => String::new(),
    };

    Ok((name, slug))
}

/// Validates a manually-pasted Twitch access token via `GET /helix/users`.
/// Client ID is still required — Twitch's API needs it on every request
/// regardless of how the token was obtained. Returns (display_name, user_id).
pub async fn validate_twitch_token(
    token: &str,
    client_id: &str,
) -> Result<(String, String), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = client
        .get(TWITCH_USERS_URL)
        .header("Authorization", format!("Bearer {}", token))
        .header("Client-Id", client_id)
        .send()
        .await
        .map_err(|e| format!("Twitch token validation failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Twitch token invalid or expired ({})",
            resp.status()
        ));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Twitch user response parse error: {}", e))?;
    let id = json["data"][0]["id"].as_str().unwrap_or("").to_string();
    let display_name = json["data"][0]["display_name"]
        .as_str()
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return Err("No Twitch user found for this token".to_string());
    }
    Ok((display_name, id))
}

// ═══════════════════════════════════════════════════════════════════════════════
// Kick Category Database Sync
// ═══════════════════════════════════════════════════════════════════════════════

pub async fn sync_kick_database(
    access_token: &str,
    base_dir: &std::path::Path,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = client
        .get(KICK_CATEGORIES_URL)
        .header("Authorization", format!("Bearer {}", access_token))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Kick categories request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Kick categories returned {}", resp.status()));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Kick categories parse error: {}", e))?;

    let categories: Vec<serde_json::Value> = match &json {
        serde_json::Value::Object(m) => m
            .get("data")
            .and_then(|d| d.as_array())
            .cloned()
            .unwrap_or_default(),
        serde_json::Value::Array(a) => a.clone(),
        _ => Vec::new(),
    };

    let mut kick_map = HashMap::new();
    for cat in &categories {
        if let (Some(name), Some(id)) = (cat["name"].as_str(), cat["id"].as_str()) {
            kick_map.insert(name.to_string(), id.to_string());
        }
    }

    if !kick_map.is_empty() {
        let kick_db_path = base_dir.join("kick_db.json");
        let json_str = serde_json::to_string_pretty(&kick_map)
            .map_err(|e| format!("Kick DB serialize error: {}", e))?;
        let tmp = kick_db_path.with_extension("tmp");
        tokio::fs::write(&tmp, json_str)
            .await
            .map_err(|e| format!("Kick DB write error: {}", e))?;
        tokio::fs::rename(&tmp, &kick_db_path)
            .await
            .map_err(|e| format!("Kick DB rename error: {}", e))?;
        log::info!("[AUTH] Kick database synced: {} categories", kick_map.len());
    }

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════════
// Config Helpers
// ═══════════════════════════════════════════════════════════════════════════════

pub fn load_config_at(base_dir: &std::path::Path) -> Result<AppConfig, String> {
    let config_path = base_dir.join("Config.json");
    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {}", e))?;
    let mut config: AppConfig =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))?;
    backfill_from_keychain(&mut config);
    Ok(config)
}

/// `migrate_tokens_to_keychain` (lib.rs) moves OAuth/API-key fields out of
/// Config.json into the OS keychain and blanks them on disk. Every other
/// consumer in this app (pusher, hub, metadata scans, token validation)
/// reads these fields straight off the loaded `AppConfig` — without this
/// backfill, migrating leaves those fields permanently empty in memory and
/// silently breaks category pushes and metadata API scans even though the
/// token is safely stored. A field already non-empty on disk (not migrated,
/// or keychain unavailable on this OS) is left untouched — the keychain
/// only fills gaps, never overrides what Config.json already has.
fn backfill_from_keychain(config: &mut AppConfig) {
    let read = |keychain_name: &str| -> Option<String> {
        let entry = keyring::Entry::new(crate::KEYRING_SERVICE, keychain_name).ok()?;
        match entry.get_password() {
            Ok(v) => Some(v),
            // NoEntry just means this field was never migrated — expected
            // and silent. Anything else (locked keychain, no Secret Service
            // provider running, permission denied, ...) means a migrated
            // credential exists but can't currently be read, which otherwise
            // looks identical to "never connected" with no way to tell why.
            Err(keyring::Error::NoEntry) => None,
            Err(e) => {
                log::warn!(
                    "[KEYCHAIN] Failed to read {} from OS keychain: {}",
                    keychain_name,
                    e
                );
                None
            }
        }
    };

    if config.broadcaster.twitch_token.is_empty() {
        if let Some(v) = read("twitch_access_token") {
            config.broadcaster.twitch_token = v;
        }
    }
    if config.broadcaster.twitch_refresh.is_empty() {
        if let Some(v) = read("twitch_refresh_token") {
            config.broadcaster.twitch_refresh = v;
        }
    }
    if config.broadcaster.kick_token.is_empty() {
        if let Some(v) = read("kick_access_token") {
            config.broadcaster.kick_token = v;
        }
    }
    if config.broadcaster.kick_refresh.is_empty() {
        if let Some(v) = read("kick_refresh_token") {
            config.broadcaster.kick_refresh = v;
        }
    }
    if config.broadcaster.twitch_secret.is_empty() {
        if let Some(v) = read("twitch_client_secret") {
            config.broadcaster.twitch_secret = v;
        }
    }
    if config.broadcaster.kick_secret.is_empty() {
        if let Some(v) = read("kick_client_secret") {
            config.broadcaster.kick_secret = v;
        }
    }
    if config.api_keys.igdb_token.is_empty() {
        if let Some(v) = read("igdb_api_token") {
            config.api_keys.igdb_token = v;
        }
    }
    if config.api_keys.igdb_secret.is_empty() {
        if let Some(v) = read("igdb_api_secret") {
            config.api_keys.igdb_secret = v;
        }
    }
    if config.api_keys.rawg.is_empty() {
        if let Some(v) = read("rawg_api_key") {
            config.api_keys.rawg = v;
        }
    }
    if config.api_keys.steamgrid.is_empty() {
        if let Some(v) = read("steamgrid_api_key") {
            config.api_keys.steamgrid = v;
        }
    }
}

pub fn save_config_at(base_dir: &std::path::Path, config: &AppConfig) -> Result<(), String> {
    let config_path = base_dir.join("Config.json");
    // `config` may carry secrets that `load_config_at` backfilled in-memory
    // from the OS keychain (e.g. a caller loaded, tweaked one unrelated
    // field like the Blipy pin, and is saving the whole struct back). Never
    // let an already-migrated field regain a plaintext copy on disk here —
    // re-sync the (possibly refreshed, e.g. after a token-refresh-and-save)
    // value into the keychain instead and blank it in what actually gets
    // written. A field with no existing keychain entry (never migrated) is
    // untouched, so first-time OAuth connects still save normally.
    let mut to_write = config.clone();
    redact_migrated_secrets(&mut to_write);
    let raw = serde_json::to_string_pretty(&to_write)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    let tmp = config_path.with_extension("tmp");
    std::fs::write(&tmp, raw).map_err(|e| format!("Failed to write temp config: {}", e))?;
    std::fs::rename(&tmp, &config_path).map_err(|e| format!("Failed to rename config: {}", e))?;
    Ok(())
}

/// For every field `migrate_tokens_to_keychain` can move to the OS keychain:
/// if it's non-empty here AND a keychain entry already exists for it (i.e.
/// this install has migrated), push the current value into the keychain
/// (picks up a refreshed token) and blank it before it's serialized — so
/// Config.json never regains a plaintext secret once migrated, regardless
/// of which code path loaded (and keychain-backfilled) this config first.
pub(crate) fn redact_migrated_secrets(config: &mut AppConfig) {
    let sync = |field: &mut String, keychain_name: &str| {
        if field.is_empty() {
            return;
        }
        let Ok(entry) = keyring::Entry::new(crate::KEYRING_SERVICE, keychain_name) else {
            return;
        };
        // Only redact if this field was already migrated — an entry existing
        // is exactly that signal. A never-migrated field saves as plaintext,
        // same as before this fix existed.
        if entry.get_password().is_ok() {
            // Only blank the Config.json copy if the keychain write actually
            // succeeded. If the OS keychain is locked, unavailable, or the
            // write is otherwise rejected, keep the plaintext value where it
            // is rather than losing the credential from both places.
            match entry.set_password(field) {
                Ok(()) => field.clear(),
                Err(e) => log::warn!(
                    "[KEYCHAIN] Failed to sync {} to OS keychain ({}) — keeping it in Config.json",
                    keychain_name,
                    e
                ),
            }
        }
    };
    sync(&mut config.broadcaster.twitch_token, "twitch_access_token");
    sync(
        &mut config.broadcaster.twitch_refresh,
        "twitch_refresh_token",
    );
    sync(&mut config.broadcaster.kick_token, "kick_access_token");
    sync(&mut config.broadcaster.kick_refresh, "kick_refresh_token");
    sync(
        &mut config.broadcaster.twitch_secret,
        "twitch_client_secret",
    );
    sync(&mut config.broadcaster.kick_secret, "kick_client_secret");
    sync(&mut config.api_keys.igdb_token, "igdb_api_token");
    sync(&mut config.api_keys.igdb_secret, "igdb_api_secret");
    sync(&mut config.api_keys.rawg, "rawg_api_key");
    sync(&mut config.api_keys.steamgrid, "steamgrid_api_key");
}

// ═══════════════════════════════════════════════════════════════════════════════
// Self-signed TLS cert for local OAuth callback (Twitch requires https://)
// ═══════════════════════════════════════════════════════════════════════════════

/// Generate a self-signed TLS cert + key (PEM) for local OAuth callback.
/// Covers both `localhost` and `127.0.0.1` SANs.
pub fn generate_self_signed_pem() -> Result<(String, String), String> {
    let cert = rcgen::generate_simple_self_signed(vec!["localhost".into(), "127.0.0.1".into()])
        .map_err(|e| format!("Failed to generate self-signed cert: {}", e))?;
    let cert_pem = cert.cert.pem();
    let key_pem = cert.key_pair.serialize_pem();
    Ok((cert_pem, key_pem))
}

// ═══════════════════════════════════════════════════════════════════════════════
// URL Builders
// ═══════════════════════════════════════════════════════════════════════════════

pub fn build_kick_auth_url(client_id: &str, state: &str, code_challenge: &str) -> String {
    let scopes = urlencoding::encode("user:read channel:write");
    format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&state={}&code_challenge={}&code_challenge_method=S256&scope={}",
        KICK_AUTH_URL,
        urlencoding::encode(client_id),
        urlencoding::encode(KICK_REDIRECT_URI),
        urlencoding::encode(state),
        urlencoding::encode(code_challenge),
        scopes
    )
}

pub fn build_twitch_auth_url(client_id: &str, state: &str, code_challenge: &str) -> String {
    let scopes = urlencoding::encode("channel:manage:broadcast");
    format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
        TWITCH_AUTH_URL,
        urlencoding::encode(client_id),
        urlencoding::encode(TWITCH_REDIRECT_URI),
        scopes,
        urlencoding::encode(state),
        urlencoding::encode(code_challenge)
    )
}

// ═══════════════════════════════════════════════════════════════════════════════
// Overlay Token Rotation (Security Audit #5)
// ═══════════════════════════════════════════════════════════════════════════════

pub fn rotate_overlay_token(base_dir: &std::path::Path) -> Result<String, String> {
    let mut config = load_config_at(base_dir)?;
    let mut bytes = vec![0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    let new_token = URL_SAFE_NO_PAD.encode(&bytes);
    config.engine_settings.overlay_token = new_token.clone();
    save_config_at(base_dir, &config)?;
    log::info!("[AUTH] Overlay token rotated successfully");
    Ok(new_token)
}
