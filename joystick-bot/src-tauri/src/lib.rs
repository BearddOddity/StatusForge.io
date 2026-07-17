//! BearO's Joystick Companion — a standalone addon, not part of the main app.
//!
//! Runs alongside StatusForge, polls its existing `/status` HTTP endpoint to
//! learn the currently detected game, and pushes that to Joystick.tv (stream
//! category + an optional chat announcement), plus a small chat bot over
//! Joystick's WebSocket gateway. Kept fully separate on purpose: Joystick.tv
//! has a 2.0 API reportedly coming, and a standalone addon means only this
//! small app needs rewriting when that lands, not the main app.
//!
//! Endpoints below are confirmed against joysticktv/joysticktv.github.io's
//! developer_support.md. Two things are NOT independently verified against a
//! live account (this sandbox's network egress can't reach api.joystick.tv):
//! the exact `PUT /me/stream` body shape (handled defensively — see
//! `push_category`), and the chat gateway's exact message envelope.

mod oauth;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

const KEYRING_SERVICE: &str = "statusforge-joystick-bot";
const STATUSFORGE_STATUS_URL: &str = "http://127.0.0.1:53735/status";
const JOYSTICK_STREAM_URL: &str = "https://api.joystick.tv/api/v1/me/stream";
const JOYSTICK_CHAT_URL: &str = "https://api.joystick.tv/api/v1/chat/messages";

// ═══════════════════════════════════════════════════════════════════════════
// Config (persisted, non-secret)
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct JoystickBotConfig {
    pub client_id: String,
    /// StatusForge's own "Overlay Token" (Settings > Control Panel) — its
    /// `/status` endpoint rejects unauthenticated requests, so this addon
    /// needs the same token an overlay URL would carry.
    pub statusforge_token: String,
    pub category_push_enabled: bool,
    pub chat_announce_enabled: bool,
    pub chat_bot_enabled: bool,
    pub poll_interval_secs: u64,
    /// One is picked at random each time a game-change announcement fires,
    /// so it's not the exact same line every time. `{title}` is replaced
    /// with the detected game.
    pub announce_templates: Vec<String>,
    /// Same idea, for the `!game` chat command's reply.
    pub game_reply_templates: Vec<String>,
}

// Genre/developer/release_year come from StatusForge's own library lookup —
// blank if it doesn't have a match for the title, which can leave an awkward
// gap in a template that uses them (e.g. "a  game" with genre missing).
// Kept to one or two default templates rather than all of them for that
// reason; edit freely once you know your library data is filled in.
fn default_announce_templates() -> Vec<String> {
    vec![
        "🎮 Now playing: {title}".to_string(),
        "Switched it up — {title} time!".to_string(),
        "Currently vibing to {title}".to_string(),
        "New game alert: {title} ({release_year})".to_string(),
        "On the menu now: {title}, a {genre} game by {developer}".to_string(),
    ]
}

fn default_game_reply_templates() -> Vec<String> {
    vec![
        "Currently playing: {title}".to_string(),
        "Right now? {title}.".to_string(),
        "{title}, obviously.".to_string(),
        "We're deep in {title} ({genre}) right now".to_string(),
    ]
}

impl Default for JoystickBotConfig {
    fn default() -> Self {
        Self {
            client_id: String::new(),
            statusforge_token: String::new(),
            // Off by default — Joystick.tv doesn't support stream categories
            // yet, so this would just fail every time until they add it.
            category_push_enabled: false,
            chat_announce_enabled: true,
            chat_bot_enabled: false,
            poll_interval_secs: 10,
            announce_templates: default_announce_templates(),
            game_reply_templates: default_game_reply_templates(),
        }
    }
}

/// Metadata for whatever StatusForge currently reports as the detected game.
/// Genre/developer/release_year come from StatusForge's own library lookup
/// (via `/status`) — empty string if it doesn't have a match for the title.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GameMeta {
    pub title: String,
    pub genre: String,
    pub developer: String,
    pub release_year: String,
}

/// Picks one template at random and substitutes `{title}`, `{genre}`,
/// `{developer}`, `{release_year}`. Falls back to a plain "Now playing:
/// {title}" if the list is empty (e.g. a user cleared the textarea
/// entirely) rather than sending a blank message.
fn render_template(templates: &[String], game: &GameMeta) -> String {
    use rand::seq::SliceRandom;
    let chosen = templates
        .choose(&mut rand::thread_rng())
        .cloned()
        .unwrap_or_else(|| "Now playing: {title}".to_string());
    chosen
        .replace("{title}", &game.title)
        .replace("{genre}", &game.genre)
        .replace("{developer}", &game.developer)
        .replace("{release_year}", &game.release_year)
}

fn config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("BearO's Joystick Companion").join("config.json"))
}

fn load_config() -> JoystickBotConfig {
    config_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(config: &JoystickBotConfig) {
    let Some(path) = config_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match serde_json::to_string_pretty(config) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&path, json) {
                log::warn!("[JOYSTICK-BOT] Failed to save config: {}", e);
            }
        }
        Err(e) => log::warn!("[JOYSTICK-BOT] Failed to serialize config: {}", e),
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Keychain-backed secrets (tokens only — everything else is in config.json)
// ═══════════════════════════════════════════════════════════════════════════

fn keychain_read(name: &str) -> Option<String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, name).ok()?;
    entry.get_password().ok()
}

fn keychain_write(name: &str, value: &str) {
    if value.is_empty() {
        return;
    }
    match keyring::Entry::new(KEYRING_SERVICE, name) {
        Ok(entry) => {
            if let Err(e) = entry.set_password(value) {
                log::warn!("[JOYSTICK-BOT] Failed to store {} in keychain: {}", name, e);
            }
        }
        Err(e) => log::warn!(
            "[JOYSTICK-BOT] Failed to open keychain entry {}: {}",
            name,
            e
        ),
    }
}

fn keychain_delete(name: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, name) {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => log::warn!("[JOYSTICK-BOT] Failed to delete {}: {}", name, e),
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Runtime state
// ═══════════════════════════════════════════════════════════════════════════

pub struct JoystickBotState {
    pub config: Mutex<JoystickBotConfig>,
    pub access_token: Mutex<Option<String>>,
    pub refresh_token: Mutex<Option<String>>,
    pub username: Mutex<String>,
    pub current_game: Mutex<Option<GameMeta>>,
    pub main_app_reachable: AtomicBool,
    pub running: Arc<AtomicBool>,
    pub pending_pkce: Mutex<Option<oauth::PkceState>>,
}

pub fn init_state() -> JoystickBotState {
    JoystickBotState {
        config: Mutex::new(load_config()),
        access_token: Mutex::new(keychain_read("access_token")),
        refresh_token: Mutex::new(keychain_read("refresh_token")),
        username: Mutex::new(keychain_read("username").unwrap_or_default()),
        current_game: Mutex::new(None),
        main_app_reachable: AtomicBool::new(false),
        running: Arc::new(AtomicBool::new(true)),
        pending_pkce: Mutex::new(None),
    }
}

impl JoystickBotState {
    fn status_json(&self) -> serde_json::Value {
        let config = self.config.lock().unwrap();
        let game = self.current_game.lock().unwrap();
        serde_json::json!({
            "connected": self.access_token.lock().unwrap().is_some(),
            "username": *self.username.lock().unwrap(),
            "client_id": config.client_id,
            "statusforge_token": config.statusforge_token,
            "current_title": game.as_ref().map(|g| g.title.clone()),
            "current_genre": game.as_ref().map(|g| g.genre.clone()).unwrap_or_default(),
            "current_developer": game.as_ref().map(|g| g.developer.clone()).unwrap_or_default(),
            "current_release_year": game.as_ref().map(|g| g.release_year.clone()).unwrap_or_default(),
            "main_app_reachable": self.main_app_reachable.load(Ordering::Relaxed),
            "category_push_enabled": config.category_push_enabled,
            "chat_announce_enabled": config.chat_announce_enabled,
            "chat_bot_enabled": config.chat_bot_enabled,
            "poll_interval_secs": config.poll_interval_secs,
            "announce_templates": config.announce_templates,
            "game_reply_templates": config.game_reply_templates,
        })
    }
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("reqwest client build")
}

// ═══════════════════════════════════════════════════════════════════════════
// Category push — same defensive GET-then-PUT approach as the main app would
// have used: Joystick's PUT /me/stream body isn't in their public docs, so
// this fetches the current object and overwrites whichever key already looks
// like a category, instead of guessing a shape and clobbering other fields.
// ═══════════════════════════════════════════════════════════════════════════

const CATEGORY_KEY_CANDIDATES: &[&str] = &["category", "game", "game_name", "genre"];

/// Current access token, refreshing (and persisting the refresh) once first
/// if the caller reports a 401. `attempt` is retried at most twice: once
/// with whatever token is on hand, once more after a refresh.
async fn with_token_retry<F, Fut>(state: &JoystickBotState, attempt: F) -> Result<(), String>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<reqwest::StatusCode, String>>,
{
    let token = state
        .access_token
        .lock()
        .unwrap()
        .clone()
        .ok_or("not connected")?;
    match attempt(token).await? {
        s if s.as_u16() == 401 => {
            let new_token = oauth::refresh_and_store(state).await?;
            match attempt(new_token).await? {
                s if s.is_success() => Ok(()),
                s => Err(format!("still failing after refresh: {}", s)),
            }
        }
        s if s.is_success() => Ok(()),
        s => Err(format!("request failed: {}", s)),
    }
}

async fn push_category(state: &JoystickBotState, title: &str) -> Result<(), String> {
    let client = http_client();
    with_token_retry(state, |token| {
        let client = client.clone();
        let title = title.to_string();
        async move {
            let get_resp = client
                .get(JOYSTICK_STREAM_URL)
                .bearer_auth(&token)
                .send()
                .await
                .map_err(|e| format!("stream lookup failed: {}", e))?;
            let get_status = get_resp.status();
            if get_status.as_u16() == 401 {
                return Ok(get_status);
            }
            let raw = get_resp
                .text()
                .await
                .map_err(|e| format!("stream lookup body read error: {}", e))?;
            // Logged unconditionally (not just on failure) so a `GET /me/stream`
            // shape mismatch — the whole reason this lookup exists instead of
            // guessing a PUT body — is visible in the log file for whoever
            // reports it back, without needing to reproduce a failure first.
            log::debug!("[JOYSTICK-BOT] GET /me/stream ({}): {}", get_status, raw);
            if !get_status.is_success() {
                return Err(format!("stream lookup returned {}: {}", get_status, raw));
            }
            let mut body: serde_json::Value = serde_json::from_str(&raw)
                .map_err(|e| format!("stream lookup parse error: {}", e))?;
            let obj = body
                .as_object_mut()
                .ok_or("stream response wasn't a JSON object")?;
            let key = CATEGORY_KEY_CANDIDATES
                .iter()
                .find(|k| obj.contains_key(**k))
                .copied()
                .unwrap_or("category");
            obj.insert(key.to_string(), serde_json::json!(title));

            let put_resp = client
                .put(JOYSTICK_STREAM_URL)
                .bearer_auth(&token)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("stream update failed: {}", e))?;
            let put_status = put_resp.status();
            if put_status.is_success() {
                log::info!(
                    "[JOYSTICK-BOT] Category set to \"{}\" (key: {})",
                    title,
                    key
                );
            } else if put_status.as_u16() != 401 {
                let raw = put_resp.text().await.unwrap_or_default();
                log::warn!("[JOYSTICK-BOT] PUT /me/stream ({}): {}", put_status, raw);
            }
            Ok(put_status)
        }
    })
    .await
}

async fn send_chat_message(state: &JoystickBotState, text: &str) -> Result<(), String> {
    let client = http_client();
    with_token_retry(state, |token| {
        let client = client.clone();
        let text = text.to_string();
        async move {
            let resp = client
                .post(JOYSTICK_CHAT_URL)
                .bearer_auth(&token)
                .json(&serde_json::json!({ "text": text }))
                .send()
                .await
                .map_err(|e| format!("chat message failed: {}", e))?;
            let status = resp.status();
            if !status.is_success() && status.as_u16() != 401 {
                let raw = resp.text().await.unwrap_or_default();
                log::warn!("[JOYSTICK-BOT] POST /chat/messages ({}): {}", status, raw);
            }
            Ok(status)
        }
    })
    .await
}

// ═══════════════════════════════════════════════════════════════════════════
// Poll loop — learns the current game from StatusForge's own /status
// endpoint (already exposed by the main app; nothing there needs to change
// for this addon to work) and reacts to changes.
// ═══════════════════════════════════════════════════════════════════════════

/// StatusForge's `/status` JSON already carries genre/developer/release_year
/// (from its own library lookup) alongside the title — nothing extra to add
/// on the StatusForge side for this addon to use them.
fn parse_game_meta(status: &serde_json::Value) -> Option<GameMeta> {
    if !status["running"].as_bool().unwrap_or(false) {
        return None;
    }
    let title = status["game_title"].as_str().unwrap_or("").trim();
    let title = if title.is_empty() {
        "Just Chatting".to_string()
    } else {
        title.to_string()
    };
    Some(GameMeta {
        title,
        genre: status["genre"].as_str().unwrap_or("").to_string(),
        developer: status["developer"].as_str().unwrap_or("").to_string(),
        // StatusForge's own JSON key is "release_date" even though it holds
        // just the year (see server.rs's build_status).
        release_year: status["release_date"].as_str().unwrap_or("").to_string(),
    })
}

fn start_poll_loop(state: Arc<JoystickBotState>, app_handle: tauri::AppHandle) {
    let running = state.running.clone();
    tauri::async_runtime::spawn(async move {
        let client = http_client();
        while running.load(Ordering::Relaxed) {
            let interval = state
                .config
                .lock()
                .unwrap()
                .poll_interval_secs
                .clamp(3, 120);

            let token = state.config.lock().unwrap().statusforge_token.clone();
            let status = client
                .get(STATUSFORGE_STATUS_URL)
                .query(&[("token", token.as_str())])
                .send()
                .await;
            let new_game = match status {
                Ok(resp) if resp.status().is_success() => {
                    state.main_app_reachable.store(true, Ordering::Relaxed);
                    match resp.json::<serde_json::Value>().await {
                        Ok(json) => parse_game_meta(&json),
                        Err(_) => None,
                    }
                }
                _ => {
                    state.main_app_reachable.store(false, Ordering::Relaxed);
                    None
                }
            };

            let changed = {
                let mut current = state.current_game.lock().unwrap();
                if *current != new_game {
                    *current = new_game.clone();
                    true
                } else {
                    false
                }
            };

            if changed {
                if let Some(game) = &new_game {
                    let connected = state.access_token.lock().unwrap().is_some();
                    log::info!(
                        "[JOYSTICK-BOT] Game change detected: \"{}\" (connected to Joystick: {})",
                        game.title,
                        connected
                    );
                    if connected {
                        let (push_on, announce_on) = {
                            let cfg = state.config.lock().unwrap();
                            (cfg.category_push_enabled, cfg.chat_announce_enabled)
                        };
                        if push_on {
                            if let Err(e) = push_category(&state, &game.title).await {
                                log::warn!("[JOYSTICK-BOT] Category push failed: {}", e);
                            }
                        }
                        if announce_on {
                            let templates = state.config.lock().unwrap().announce_templates.clone();
                            let msg = render_template(&templates, game);
                            log::info!("[JOYSTICK-BOT] Sending chat announce: \"{}\"", msg);
                            match send_chat_message(&state, &msg).await {
                                Ok(()) => log::info!("[JOYSTICK-BOT] Chat announce sent"),
                                Err(e) => log::warn!("[JOYSTICK-BOT] Chat announce failed: {}", e),
                            }
                        } else {
                            log::info!("[JOYSTICK-BOT] Chat announce is off — not sending");
                        }
                    } else {
                        log::info!(
                            "[JOYSTICK-BOT] Not connected to Joystick — skipping announce/category push"
                        );
                    }
                }
            }

            let _ = app_handle.emit("status-update", state.status_json());
            tokio::time::sleep(Duration::from_secs(interval)).await;
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// Chat bot — WebSocket gateway, responds to "!game" with the current title.
// Reconnects with a fixed backoff; stays idle (just polling the toggle) when
// chat_bot_enabled is off or there's no token yet.
// ═══════════════════════════════════════════════════════════════════════════

fn start_chat_bot_loop(state: Arc<JoystickBotState>) {
    let running = state.running.clone();
    tauri::async_runtime::spawn(async move {
        // Only logged on change, not every 5s tick — otherwise this would
        // flood the log exactly like the poll loop already does.
        let mut last_idle_reason: Option<&'static str> = None;
        while running.load(Ordering::Relaxed) {
            let enabled = state.config.lock().unwrap().chat_bot_enabled;
            let token = state.access_token.lock().unwrap().clone();
            match (enabled, token) {
                (true, Some(token)) => {
                    last_idle_reason = None;
                    if let Err(e) = oauth::run_chat_gateway(&state, &token).await {
                        log::warn!("[JOYSTICK-BOT] Chat gateway dropped: {} — reconnecting", e);
                    }
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
                (false, _) => {
                    if last_idle_reason != Some("disabled") {
                        log::info!("[JOYSTICK-BOT] Chat bot toggle is off — gateway not started");
                        last_idle_reason = Some("disabled");
                    }
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
                (true, None) => {
                    if last_idle_reason != Some("no_token") {
                        log::info!(
                            "[JOYSTICK-BOT] Chat bot is on but not connected to Joystick — gateway not started"
                        );
                        last_idle_reason = Some("no_token");
                    }
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// Tauri commands
// ═══════════════════════════════════════════════════════════════════════════

#[tauri::command]
fn get_status(state: tauri::State<Arc<JoystickBotState>>) -> serde_json::Value {
    state.status_json()
}

/// Manual trigger for testing: pushes the given title (or "Test Category" if
/// none supplied) right now, without waiting for a real game-change from the
/// poll loop. Runs both category push and chat announce regardless of their
/// individual toggles, so a single click tells you which of the two (if
/// either) actually works against a real account. Full request/response
/// bodies land in the log file either way — see README.md for where to find it.
#[tauri::command]
async fn test_push(
    state: tauri::State<'_, Arc<JoystickBotState>>,
    title: Option<String>,
) -> Result<String, String> {
    if state.access_token.lock().unwrap().is_none() {
        return Err("Not connected".to_string());
    }
    let title = title
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "Test Category".to_string());
    // Real genre/developer/release_year come from StatusForge's own library
    // lookup — fake values here so a template using those placeholders can
    // still be test-fired without a live detected game.
    let test_game = GameMeta {
        title,
        genre: "Test Genre".to_string(),
        developer: "Test Developer".to_string(),
        release_year: "2024".to_string(),
    };
    let templates = state.config.lock().unwrap().announce_templates.clone();
    let test_message = format!("[Test] {}", render_template(&templates, &test_game));

    // Category push is skipped here on purpose — Joystick.tv doesn't support
    // stream categories yet, so testing it would just always report FAILED
    // and look like a bug in this app rather than a platform limitation.
    let chat_result = match send_chat_message(&state, &test_message).await {
        Ok(()) => "Chat message: OK".to_string(),
        Err(e) => format!("Chat message: FAILED — {}", e),
    };
    Ok(format!(
        "Category push: skipped (not supported by Joystick.tv yet)\n{}",
        chat_result
    ))
}

#[tauri::command]
fn set_client_id(
    state: tauri::State<Arc<JoystickBotState>>,
    client_id: String,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.client_id = client_id;
    save_config(&config);
    Ok(())
}

#[tauri::command]
fn set_statusforge_token(
    state: tauri::State<Arc<JoystickBotState>>,
    token: String,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.statusforge_token = token;
    save_config(&config);
    Ok(())
}

#[tauri::command]
fn toggle_category_push(state: tauri::State<Arc<JoystickBotState>>) -> Result<bool, String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.category_push_enabled = !config.category_push_enabled;
    save_config(&config);
    Ok(config.category_push_enabled)
}

#[tauri::command]
fn toggle_chat_announce(state: tauri::State<Arc<JoystickBotState>>) -> Result<bool, String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.chat_announce_enabled = !config.chat_announce_enabled;
    save_config(&config);
    Ok(config.chat_announce_enabled)
}

#[tauri::command]
fn toggle_chat_bot(state: tauri::State<Arc<JoystickBotState>>) -> Result<bool, String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.chat_bot_enabled = !config.chat_bot_enabled;
    save_config(&config);
    Ok(config.chat_bot_enabled)
}

/// Replaces the announce-message variants. Empty lines are dropped; an
/// empty result just means `render_template` falls back to a plain default
/// rather than sending a blank chat message.
#[tauri::command]
fn set_announce_templates(
    state: tauri::State<Arc<JoystickBotState>>,
    templates: Vec<String>,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.announce_templates = templates
        .into_iter()
        .filter(|t| !t.trim().is_empty())
        .collect();
    save_config(&config);
    Ok(())
}

#[tauri::command]
fn set_game_reply_templates(
    state: tauri::State<Arc<JoystickBotState>>,
    templates: Vec<String>,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.game_reply_templates = templates
        .into_iter()
        .filter(|t| !t.trim().is_empty())
        .collect();
    save_config(&config);
    Ok(())
}

#[tauri::command]
async fn connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<JoystickBotState>>,
) -> Result<String, String> {
    let client_id = state.config.lock().unwrap().client_id.clone();
    if client_id.is_empty() {
        return Err("Client ID not set".to_string());
    }
    oauth::start_connect(app, state.inner().clone(), client_id).await
}

#[tauri::command]
fn disconnect(state: tauri::State<Arc<JoystickBotState>>) -> Result<(), String> {
    oauth::forget_credentials();
    *state.access_token.lock().unwrap() = None;
    *state.refresh_token.lock().unwrap() = None;
    *state.username.lock().unwrap() = String::new();
    Ok(())
}

#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch.enable().map_err(|e| e.to_string())?;
    } else {
        autolaunch.disable().map_err(|e| e.to_string())?;
    }
    Ok(enabled)
}

#[tauri::command]
fn shutdown_bot(state: tauri::State<Arc<JoystickBotState>>) -> Result<(), String> {
    state.running.store(false, Ordering::Relaxed);
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Tray
// ═══════════════════════════════════════════════════════════════════════════

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let stow = MenuItem::with_id(app, "stow", "Stow", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &stow, &quit])?;

    let mut builder = TrayIconBuilder::with_id("joystick-bot-tray")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("BearO's Joystick Companion")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "stow" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            "quit" => {
                if let Some(state) = app.try_state::<Arc<JoystickBotState>>() {
                    state.running.store(false, Ordering::Relaxed);
                }
                app.exit(0);
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Entry point
// ═══════════════════════════════════════════════════════════════════════════

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = Arc::new(init_state());

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                // Debug level on purpose while this addon is still being
                // tested against a real account — the raw API bodies logged
                // at debug (GET /me/stream, gateway messages) are the whole
                // point of testing this early.
                .level(log::LevelFilter::Debug)
                // hyper/reqwest's own debug output (connection pool churn on
                // every 10s poll) drowns out this addon's own log lines
                // otherwise — keep it at Warn while everything else stays
                // at Debug.
                .level_for("hyper_util", log::LevelFilter::Warn)
                .level_for("reqwest", log::LevelFilter::Warn)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("joystick-bot".to_string()),
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(state.clone())
        .setup(move |app| {
            setup_tray(app)?;
            let handle = app.handle().clone();
            oauth::start_callback_server(handle.clone(), state.clone());
            start_poll_loop(state.clone(), handle);
            start_chat_bot_loop(state.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            test_push,
            set_client_id,
            set_statusforge_token,
            toggle_category_push,
            toggle_chat_announce,
            toggle_chat_bot,
            set_announce_templates,
            set_game_reply_templates,
            connect,
            disconnect,
            get_autostart,
            set_autostart,
            shutdown_bot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running BearO's Joystick Companion")
}
