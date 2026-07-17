//! OAuth (public/PKCE client — no client secret, per Joystick's docs) and
//! the chat gateway WebSocket. Confirmed against
//! joysticktv/joysticktv.github.io's developer_support.md.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::response::Html;
use axum::routing::get;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::Emitter;

use crate::{keychain_delete, keychain_write, JoystickBotState};

const JOYSTICK_AUTH_URL: &str = "https://joystick.tv/api/oauth/authorize";
const JOYSTICK_TOKEN_URL: &str = "https://api.joystick.tv/api/oauth/token";
const JOYSTICK_IDENTITY_URL: &str = "https://api.joystick.tv/api/v1/me/identity";
const JOYSTICK_CABLE_URL: &str = "wss://api.joystick.tv/cable";
const CALLBACK_PORT: u16 = 53737;
const CALLBACK_REDIRECT_URI: &str = "http://127.0.0.1:53737/callback";
const SCOPES: &str = "stream:read stream:manage identity:read chat:read chat:write";

#[derive(Debug, Clone, Default)]
pub struct PkceState {
    pub verifier: String,
    pub state: String,
}

fn generate_code_verifier() -> String {
    let mut bytes = vec![0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(&bytes)
}

fn generate_code_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

// ═══════════════════════════════════════════════════════════════════════════
// Connect (opens the system browser)
// ═══════════════════════════════════════════════════════════════════════════

pub async fn start_connect(
    app: tauri::AppHandle,
    state: Arc<JoystickBotState>,
    client_id: String,
) -> Result<String, String> {
    let verifier = generate_code_verifier();
    let challenge = generate_code_challenge(&verifier);
    let state_token = generate_code_verifier();

    *state.pending_pkce.lock().unwrap() = Some(PkceState {
        verifier,
        state: state_token.clone(),
    });

    let url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
        JOYSTICK_AUTH_URL,
        urlencoding::encode(&client_id),
        urlencoding::encode(CALLBACK_REDIRECT_URI),
        urlencoding::encode(SCOPES),
        urlencoding::encode(&state_token),
        urlencoding::encode(&challenge),
    );

    #[allow(deprecated)]
    {
        use tauri_plugin_shell::ShellExt;
        app.shell()
            .open(&url, None)
            .map_err(|e| format!("Failed to open browser: {}", e))?;
    }

    Ok("Opened browser — waiting for Joystick.tv login".to_string())
}

// ═══════════════════════════════════════════════════════════════════════════
// Local callback listener — runs for the app's whole lifetime on its own
// port (53737), separate from StatusForge's own local server (53735) and
// Blipy's UDP ports, so all three can run at once with no collisions.
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

#[derive(Clone)]
struct CallbackAppState {
    app: tauri::AppHandle,
    state: Arc<JoystickBotState>,
}

pub fn start_callback_server(app: tauri::AppHandle, state: Arc<JoystickBotState>) {
    let shared = CallbackAppState { app, state };
    tauri::async_runtime::spawn(async move {
        let router = axum::Router::new()
            .route("/callback", get(callback_handler))
            .with_state(shared);
        let addr = format!("127.0.0.1:{}", CALLBACK_PORT);
        match tokio::net::TcpListener::bind(&addr).await {
            Ok(listener) => {
                log::info!("[JOYSTICK-BOT] OAuth callback listening on {}", addr);
                if let Err(e) = axum::serve(listener, router).await {
                    log::error!("[JOYSTICK-BOT] Callback server error: {}", e);
                }
            }
            Err(e) => log::error!("[JOYSTICK-BOT] Failed to bind {}: {}", addr, e),
        }
    });
}

async fn callback_handler(
    Query(params): Query<CallbackQuery>,
    State(shared): State<CallbackAppState>,
) -> Html<String> {
    let result = handle_callback(&params, &shared.state).await;
    let (title, msg) = match &result {
        Ok(username) => (
            "Connected!".to_string(),
            format!(
                "Connected to Joystick.tv{}. You can close this window.",
                if username.is_empty() {
                    String::new()
                } else {
                    format!(" as {}", username)
                }
            ),
        ),
        Err(e) => ("Connection failed".to_string(), e.clone()),
    };
    let _ = shared
        .app
        .emit("oauth-result", serde_json::json!({ "ok": result.is_ok() }));
    Html(format!(
        r#"<!DOCTYPE html><html><head><meta charset="utf-8"><title>Joystick Bot</title>
<style>body{{background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif}}
.card{{text-align:center;max-width:360px;padding:32px}}h1{{font-size:18px;margin:0 0 8px}}p{{color:rgba(255,255,255,.5);font-size:13px}}</style>
</head><body><div class="card"><h1>{}</h1><p>{}</p></div>
<script>setTimeout(function(){{window.close()}},1500);</script></body></html>"#,
        title, msg
    ))
}

async fn handle_callback(
    params: &CallbackQuery,
    state: &Arc<JoystickBotState>,
) -> Result<String, String> {
    if let Some(err) = &params.error {
        return Err(err.clone());
    }
    let code = params
        .code
        .clone()
        .filter(|c| !c.is_empty())
        .ok_or("No authorization code received")?;

    let pending = state
        .pending_pkce
        .lock()
        .unwrap()
        .take()
        .ok_or("No pending request — possible CSRF")?;
    if params.state.as_ref() != Some(&pending.state) {
        return Err("State mismatch — possible CSRF".to_string());
    }

    let client_id = state.config.lock().unwrap().client_id.clone();
    let token_resp = exchange_token(&code, &client_id, &pending.verifier).await?;

    keychain_write("access_token", &token_resp.access_token);
    if let Some(refresh) = &token_resp.refresh_token {
        keychain_write("refresh_token", refresh);
    }
    *state.access_token.lock().unwrap() = Some(token_resp.access_token.clone());
    if token_resp.refresh_token.is_some() {
        *state.refresh_token.lock().unwrap() = token_resp.refresh_token.clone();
    }

    let username = fetch_identity(&token_resp.access_token)
        .await
        .unwrap_or_default();
    if !username.is_empty() {
        keychain_write("username", &username);
        *state.username.lock().unwrap() = username.clone();
    }

    Ok(username)
}

// ═══════════════════════════════════════════════════════════════════════════
// Token exchange / refresh / identity
// ═══════════════════════════════════════════════════════════════════════════

struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
}

async fn exchange_token(
    code: &str,
    client_id: &str,
    code_verifier: &str,
) -> Result<TokenResponse, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(JOYSTICK_TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", client_id),
            ("redirect_uri", CALLBACK_REDIRECT_URI),
            ("code", code),
            ("code_verifier", code_verifier),
        ])
        .send()
        .await
        .map_err(|e| format!("Token exchange failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Token exchange: {}",
            resp.text().await.unwrap_or_default()
        ));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Token parse error: {}", e))?;
    Ok(TokenResponse {
        access_token: json["access_token"].as_str().unwrap_or("").to_string(),
        refresh_token: json["refresh_token"].as_str().map(|s| s.to_string()),
    })
}

/// Refreshes the access token and persists the result (keychain + state).
/// Called by `with_token_retry` in lib.rs on a 401.
pub async fn refresh_and_store(state: &JoystickBotState) -> Result<String, String> {
    let (client_id, refresh_token) = {
        let config = state.config.lock().unwrap();
        let refresh = state.refresh_token.lock().unwrap().clone();
        (config.client_id.clone(), refresh)
    };
    let refresh_token = refresh_token.ok_or("No refresh token available")?;
    if client_id.is_empty() {
        return Err("No client ID configured".to_string());
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(JOYSTICK_TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id.as_str()),
            ("refresh_token", refresh_token.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("Refresh failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Refresh: {}",
            resp.text().await.unwrap_or_default()
        ));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Refresh parse error: {}", e))?;
    let new_access = json["access_token"].as_str().unwrap_or("").to_string();
    if new_access.is_empty() {
        return Err("Refresh response had no access_token".to_string());
    }
    keychain_write("access_token", &new_access);
    *state.access_token.lock().unwrap() = Some(new_access.clone());
    if let Some(new_refresh) = json["refresh_token"].as_str() {
        keychain_write("refresh_token", new_refresh);
        *state.refresh_token.lock().unwrap() = Some(new_refresh.to_string());
    }
    Ok(new_access)
}

async fn fetch_identity(access_token: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(JOYSTICK_IDENTITY_URL)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Identity request failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Identity request returned {}", resp.status()));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Identity parse error: {}", e))?;
    // Field name unconfirmed against a live account (see module docs) — try
    // the common candidates in order.
    Ok(json["username"]
        .as_str()
        .or_else(|| json["name"].as_str())
        .or_else(|| json["display_name"].as_str())
        .unwrap_or("")
        .to_string())
}

/// Called by `disconnect` (lib.rs) — kept here so callers don't need to know
/// which keychain entries exist.
pub fn forget_credentials() {
    keychain_delete("access_token");
    keychain_delete("refresh_token");
    keychain_delete("username");
}

// ═══════════════════════════════════════════════════════════════════════════
// Chat gateway (WebSocket) — read chat, respond to "!game" with the current
// title. Message envelope confirmed against developer_support.md at a
// structural level (type/channel_id/text/data fields, GatewayChannel,
// event_version v2) but not tested against a live stream from this sandbox
// (network egress here can't reach api.joystick.tv) — if the trigger doesn't
// fire on a real account, check the actual payload shape and adjust
// `extract_chat_text` below.
// ═══════════════════════════════════════════════════════════════════════════

fn extract_chat_text(value: &serde_json::Value) -> Option<String> {
    value["message"]["text"]
        .as_str()
        .or_else(|| value["data"]["text"].as_str())
        .or_else(|| value["text"].as_str())
        .map(|s| s.to_string())
}

pub async fn run_chat_gateway(state: &Arc<JoystickBotState>, token: &str) -> Result<(), String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::Message;

    let url = format!(
        "{}?token={}",
        JOYSTICK_CABLE_URL,
        urlencoding::encode(token)
    );
    let mut request = url
        .into_client_request()
        .map_err(|e| format!("Invalid gateway URL: {}", e))?;
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        "actioncable-v1-json"
            .parse()
            .map_err(|e| format!("Header error: {}", e))?,
    );

    let (ws_stream, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| format!("Connect failed: {}", e))?;
    let (mut write, mut read) = ws_stream.split();

    let subscribe = serde_json::json!({
        "command": "subscribe",
        "identifier": serde_json::to_string(&serde_json::json!({
            "channel": "GatewayChannel",
            "event_version": "v2",
        })).unwrap_or_default(),
    });
    write
        .send(Message::Text(subscribe.to_string()))
        .await
        .map_err(|e| format!("Subscribe failed: {}", e))?;

    log::info!("[JOYSTICK-BOT] Chat gateway connected");

    while let Some(msg) = read.next().await {
        let msg = msg.map_err(|e| format!("Gateway read error: {}", e))?;
        let Message::Text(text) = msg else { continue };
        // Logged unconditionally — if `extract_chat_text` is parsing the
        // wrong fields for the real gateway payload shape, this is what
        // shows what it actually looks like.
        log::debug!("[JOYSTICK-BOT] Gateway message: {}", text);
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let Some(chat_text) = extract_chat_text(&value) else {
            continue;
        };
        if chat_text.trim().eq_ignore_ascii_case("!game") {
            let title = state
                .current_title
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| "nothing right now".to_string());
            let templates = state.config.lock().unwrap().game_reply_templates.clone();
            let reply = crate::render_template(&templates, &title);
            if let Err(e) = crate::send_chat_message(state, &reply).await {
                log::warn!("[JOYSTICK-BOT] Failed to reply in chat: {}", e);
            }
        }
    }

    Ok(())
}
