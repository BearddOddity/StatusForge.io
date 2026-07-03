//! Local widget/status server — native replacement for the Python Flask server.
//!
//! One listener on 127.0.0.1:53735 serves BOTH protocols by peeking the first
//! byte of each connection:
//! - TLS  (0x16 handshake) → Twitch OAuth callback (`https://127.0.0.1:53735/...`)
//! - plain HTTP            → widget overlays (`/status`, `/settings`, `/widgets/*`,
//!   `/ws` WebSocket) and the Kick OAuth callback (`http://localhost:53735/...`)
//!
//! Widget endpoints accept an optional `X-Forge-Token` header or `?token=`
//! query parameter; when present it must match `engine_settings.widget_token`
//! (401 otherwise). The server only ever binds loopback.

use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket},
        Query, State, WebSocketUpgrade,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Redirect},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use tokio::sync::watch;

use crate::auth::SharedOAuthState;
use crate::config::{AppConfig, ForgeDatabase};
use crate::NativeEngineState;

pub const SERVER_ADDR: &str = "127.0.0.1:53735";

/// Shared state for the widget/status server.
#[derive(Clone)]
pub struct ServerState {
    pub engine: Arc<NativeEngineState>,
    pub oauth: SharedOAuthState,
}

/// Lets the OAuth callback handler keep extracting `State<SharedOAuthState>`.
impl axum::extract::FromRef<ServerState> for SharedOAuthState {
    fn from_ref(s: &ServerState) -> Self {
        s.oauth.clone()
    }
}

#[derive(Deserialize)]
pub struct TokenQuery {
    token: Option<String>,
}

/// Validate the widget token when one is supplied. Absent token → allowed
/// (overlays don't send one; the server is loopback-only). Wrong token → 401.
fn check_token(headers: &HeaderMap, query_token: Option<&str>) -> Result<(), StatusCode> {
    let provided = headers
        .get("X-Forge-Token")
        .and_then(|v| v.to_str().ok())
        .or(query_token);
    let Some(provided) = provided else {
        return Ok(());
    };
    let expected = crate::app_base_dir()
        .ok()
        .and_then(|base| crate::auth::load_config_at(&base).ok())
        .map(|c| c.engine_settings.widget_token)
        .unwrap_or_default();
    if !expected.is_empty() && provided == expected {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

fn load_config() -> Option<AppConfig> {
    let base = crate::app_base_dir().ok()?;
    crate::auth::load_config_at(&base).ok()
}

fn internal(e: String) -> StatusCode {
    log::warn!("[SERVER] {}", e);
    StatusCode::INTERNAL_SERVER_ERROR
}

// ═══════════════════════════════════════════════════════════════════════════════
// Forge_Database.json helpers + Library routes
// ═══════════════════════════════════════════════════════════════════════════════

pub fn load_db() -> Result<ForgeDatabase, String> {
    let path = crate::app_base_dir()?.join("Forge_Database.json");
    if !path.exists() {
        return Ok(ForgeDatabase::default());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read Forge_Database.json: {}", e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse Forge_Database.json: {}", e))
}

/// Atomic write (temp + rename), same as the Config.json save path.
pub fn save_db(db: &ForgeDatabase) -> Result<(), String> {
    let path = crate::app_base_dir()?.join("Forge_Database.json");
    let raw = serde_json::to_string_pretty(db)
        .map_err(|e| format!("Failed to serialize Forge_Database.json: {}", e))?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, raw).map_err(|e| format!("Failed to write temp db: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Failed to rename db: {}", e))?;
    Ok(())
}

/// Upsert a library entry from an arbitrary `/list` JSON body. Requires `title`.
/// Maps `custom_release_year`/`custom_developer`/`custom_publisher` onto the
/// real fields, overlays any ForgeLibraryEntry fields present, preserves the rest.
pub fn upsert_library_entry(
    db: &mut ForgeDatabase,
    body: &serde_json::Map<String, serde_json::Value>,
) -> Result<String, String> {
    let title = body
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "title required".to_string())?
        .to_string();

    let existing = db.library.get(&title).cloned().unwrap_or_default();
    // Overlay on the serialized existing entry — serde ignores unknown keys,
    // so arbitrary extra body fields are dropped and known ones merge in.
    let mut obj = match serde_json::to_value(&existing) {
        Ok(serde_json::Value::Object(o)) => o,
        _ => return Err("entry serialize failed".to_string()),
    };
    for (k, v) in body {
        let key = match k.as_str() {
            "custom_release_year" => "release_year",
            "custom_developer" => "developer",
            "custom_publisher" => "publisher",
            other => other,
        };
        obj.insert(key.to_string(), v.clone());
    }
    obj.insert(
        "title".to_string(),
        serde_json::Value::String(title.clone()),
    );
    let entry: crate::config::ForgeLibraryEntry =
        serde_json::from_value(serde_json::Value::Object(obj))
            .map_err(|e| format!("invalid entry fields: {}", e))?;
    db.library.insert(title.clone(), entry);
    Ok(title)
}

/// Remove a process (case-insensitive) from the delisted list.
pub fn unexile(db: &mut ForgeDatabase, process: &str) {
    let p = process.to_lowercase();
    db.delisted_apps.retain(|x| x != &p);
}

async fn forge_full_handler(
    Query(q): Query<TokenQuery>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    check_token(&headers, q.token.as_deref())?;
    let db = load_db().map_err(internal)?;
    Ok(Json(
        serde_json::to_value(db.library).map_err(|e| internal(e.to_string()))?,
    ))
}

async fn exiled_apps_handler(
    Query(q): Query<TokenQuery>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    check_token(&headers, q.token.as_deref())?;
    let db = load_db().map_err(internal)?;
    Ok(Json(serde_json::json!(db.delisted_apps)))
}

async fn list_handler(
    Query(q): Query<TokenQuery>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    check_token(&headers, q.token.as_deref())?;
    let obj = body.as_object().ok_or(StatusCode::BAD_REQUEST)?;
    let mut db = load_db().map_err(internal)?;
    let title = upsert_library_entry(&mut db, obj).map_err(|e| {
        log::warn!("[SERVER] /list rejected: {}", e);
        StatusCode::BAD_REQUEST
    })?;
    save_db(&db).map_err(internal)?;
    Ok(Json(serde_json::json!({ "status": "ok", "title": title })))
}

#[derive(Deserialize)]
struct UnexileBody {
    process: String,
}

async fn unexile_handler(
    Query(q): Query<TokenQuery>,
    headers: HeaderMap,
    Json(body): Json<UnexileBody>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    check_token(&headers, q.token.as_deref())?;
    if body.process.trim().is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut db = load_db().map_err(internal)?;
    unexile(&mut db, body.process.trim());
    save_db(&db).map_err(internal)?;
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

async fn export_meta_handler(
    Query(q): Query<TokenQuery>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    check_token(&headers, q.token.as_deref())?;
    let db = load_db().map_err(internal)?;
    Ok(Json(
        serde_json::to_value(db).map_err(|e| internal(e.to_string()))?,
    ))
}

async fn import_meta_handler(
    Query(q): Query<TokenQuery>,
    headers: HeaderMap,
    Json(db): Json<ForgeDatabase>, // typed: rejects malformed bodies with 4xx
) -> Result<Json<serde_json::Value>, StatusCode> {
    check_token(&headers, q.token.as_deref())?;
    save_db(&db).map_err(internal)?;
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

#[derive(Deserialize)]
struct ScanBody {
    title: String,
}

/// Full external metadata scan (RAWG / IGDB / SteamGridDB), merged into the
/// existing entry (user-set fields win) and saved back to the DB.
async fn scan_metadata_handler(
    Query(q): Query<TokenQuery>,
    headers: HeaderMap,
    Json(body): Json<ScanBody>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    check_token(&headers, q.token.as_deref())?;
    let title = body.title.trim().to_string();
    if title.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let keys = load_config().map(|c| c.api_keys).unwrap_or_default();
    let mut db = load_db().map_err(internal)?;
    let mut existing = db.library.get(&title).cloned().unwrap_or_default();
    existing.title = title.clone();
    let merged = crate::metadata::scan(&title, &keys, existing).await;
    db.library.insert(title, merged.clone());
    save_db(&db).map_err(internal)?;
    Ok(Json(
        serde_json::to_value(merged).map_err(|e| internal(e.to_string()))?,
    ))
}

// ═══════════════════════════════════════════════════════════════════════════════
// Browser-initiated OAuth logins (mirror the kick_login/twitch_login commands)
// ═══════════════════════════════════════════════════════════════════════════════

async fn kick_login_handler(State(state): State<ServerState>) -> Result<Redirect, StatusCode> {
    let config = load_config().ok_or_else(|| internal("Config.json unavailable".into()))?;
    let client_id = config.broadcaster.kick_client;
    if client_id.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let verifier = crate::auth::generate_code_verifier();
    let challenge = crate::auth::generate_code_challenge(&verifier);
    let state_token = crate::auth::generate_code_verifier();
    state.oauth.pkce.lock().unwrap().insert(
        "kick".to_string(),
        crate::auth::PkceState {
            verifier,
            state: state_token.clone(),
        },
    );
    Ok(Redirect::temporary(&crate::auth::build_kick_auth_url(
        &client_id,
        &state_token,
        &challenge,
    )))
}

async fn twitch_login_handler() -> Result<Redirect, StatusCode> {
    let config = load_config().ok_or_else(|| internal("Config.json unavailable".into()))?;
    let client_id = config.broadcaster.twitch_client;
    if client_id.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(Redirect::temporary(&crate::auth::build_twitch_auth_url(
        &client_id,
    )))
}

/// Build the status payload the overlays consume — game info from the native
/// engine (or LAN Hub), enriched with Forge_Database library metadata.
pub fn build_status(engine: &NativeEngineState) -> serde_json::Value {
    let game = engine.current_game.lock().unwrap().clone();
    let process = engine.current_process.lock().unwrap().clone();
    let is_playing = *engine.is_playing.lock().unwrap();
    let start_time = *engine.start_time.lock().unwrap();

    let config = load_config();
    let fade_timer = config
        .as_ref()
        .map(|c| c.engine_settings.widget_fade_timer)
        .unwrap_or(15);

    let game_title = game.as_ref().map(|g| g.title.clone()).unwrap_or_default();

    // Enrich with Forge_Database.json library metadata when we have a match.
    let mut genre = String::new();
    let mut developer = String::new();
    let mut publisher = String::new();
    let mut release_date = String::new();
    let mut cover_url = String::new();
    if !game_title.is_empty() {
        if let Ok(base) = crate::app_base_dir() {
            if let Ok(content) = std::fs::read_to_string(base.join("Forge_Database.json")) {
                if let Ok(db) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(entry) = db
                        .get("library")
                        .and_then(|l| l.get(&game_title))
                        .and_then(|e| e.as_object())
                    {
                        let s = |k: &str| {
                            entry
                                .get(k)
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string()
                        };
                        genre = s("genre");
                        developer = s("developer");
                        publisher = s("publisher");
                        release_date = s("release_year");
                        cover_url = s("cover_url");
                    }
                }
            }
        }
    }

    serde_json::json!({
        "running": true,
        "game_title": game_title,
        "process_name": process,
        "is_playing": is_playing,
        "start_time": start_time,
        "genre": genre,
        "developer": developer,
        "publisher": publisher,
        "release_date": release_date,
        "cover_url": cover_url,
        "fade_timer": fade_timer,
        "permission_error": crate::scanner::platform::permission_error(),
    })
}

async fn status_handler(
    State(state): State<ServerState>,
    Query(q): Query<TokenQuery>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    check_token(&headers, q.token.as_deref())?;
    Ok(Json(build_status(&state.engine)))
}

async fn settings_handler(
    Query(q): Query<TokenQuery>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    check_token(&headers, q.token.as_deref())?;
    let config = load_config();
    let es = config.map(|c| c.engine_settings);
    Ok(Json(serde_json::json!({
        "widget_poll_rate": es.as_ref().map(|e| e.widget_poll_rate).unwrap_or(3),
        "widget_fade_timer": es.as_ref().map(|e| e.widget_fade_timer).unwrap_or(15),
        "idle_category": es.as_ref().map(|e| e.idle_category.clone()).unwrap_or_else(|| "Just Chatting".to_string()),
    })))
}

async fn ws_handler(
    State(state): State<ServerState>,
    Query(q): Query<TokenQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, StatusCode> {
    check_token(&headers, q.token.as_deref())?;
    let rx = state.engine.status_tx.subscribe();
    Ok(ws.on_upgrade(move |socket| ws_push_loop(socket, rx)))
}

/// Push the current status immediately, then every time it changes.
async fn ws_push_loop(mut socket: WebSocket, mut rx: watch::Receiver<serde_json::Value>) {
    let initial = rx.borrow().clone();
    if socket
        .send(Message::Text(initial.to_string().into()))
        .await
        .is_err()
    {
        return;
    }
    while rx.changed().await.is_ok() {
        let status = rx.borrow_and_update().clone();
        if socket
            .send(Message::Text(status.to_string().into()))
            .await
            .is_err()
        {
            return;
        }
    }
}

async fn health_handler() -> StatusCode {
    StatusCode::OK
}

fn build_router(state: ServerState) -> Router {
    let widgets_dir = crate::app_base_dir()
        .map(|b| b.join("widgets"))
        .unwrap_or_else(|_| std::path::PathBuf::from("widgets"));

    Router::new()
        .route("/status", get(status_handler))
        .route("/settings", get(settings_handler))
        .route("/ws", get(ws_handler))
        .route("/health", get(health_handler))
        .route("/api/forge-full", get(forge_full_handler))
        .route("/api/exiled-apps", get(exiled_apps_handler))
        .route("/list", post(list_handler))
        .route("/unexile", post(unexile_handler))
        .route("/export-meta", get(export_meta_handler))
        .route("/import-meta", post(import_meta_handler))
        .route("/api/scan-metadata", post(scan_metadata_handler))
        .route("/kick/login", get(kick_login_handler))
        .route("/twitch/login", get(twitch_login_handler))
        .route(
            "/oauth/callback/{platform}",
            get(crate::auth::oauth_callback),
        )
        .nest_service("/widgets", tower_http::services::ServeDir::new(widgets_dir))
        .layer(
            tower_http::cors::CorsLayer::new()
                .allow_origin(tower_http::cors::Any)
                .allow_methods(tower_http::cors::Any)
                .allow_headers(tower_http::cors::Any),
        )
        .with_state(state)
}

/// Start the combined plain-HTTP + TLS server on 127.0.0.1:53735.
///
/// Each accepted connection is sniffed: a TLS ClientHello (first byte 0x16)
/// is unwrapped with a self-signed cert (Twitch requires an https:// redirect
/// URI), anything else is served as plain HTTP (widgets, Kick callback).
pub async fn start_server(state: ServerState) -> Result<(), String> {
    use hyper_util::rt::{TokioExecutor, TokioIo};
    use hyper_util::server::conn::auto::Builder as ConnBuilder;
    use hyper_util::service::TowerToHyperService;

    let router = build_router(state.clone());
    // OAuth handlers pull the OAuth state via axum Extension-less crate state;
    // they access ServerState.oauth through the shared router state.

    // rustls 0.23: tauri-plugin-updater links aws-lc-rs while we use ring, so
    // both providers are compiled in and ServerConfig::builder() can't auto-pick
    // (it panics). Pin ring explicitly. Idempotent — Err means already installed.
    let _ = rustls::crypto::ring::default_provider().install_default();

    // Self-signed TLS for the Twitch https:// callback.
    let (cert_pem, key_pem) = crate::auth::generate_self_signed_pem()?;
    let certs = rustls_pemfile::certs(&mut cert_pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to parse self-signed cert: {}", e))?;
    let key = rustls_pemfile::private_key(&mut key_pem.as_bytes())
        .map_err(|e| format!("Failed to parse TLS key: {}", e))?
        .ok_or_else(|| "No TLS private key generated".to_string())?;
    let tls_config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("Failed to build TLS config: {}", e))?;
    let tls_acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls_config));

    let listener = tokio::net::TcpListener::bind(SERVER_ADDR)
        .await
        .map_err(|e| format!("Failed to bind {}: {}", SERVER_ADDR, e))?;

    log::info!(
        "[SERVER] Widget/OAuth server listening on {} (HTTP + TLS)",
        SERVER_ADDR
    );

    tokio::spawn(async move {
        loop {
            let (stream, _peer) = match listener.accept().await {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("[SERVER] accept error: {}", e);
                    continue;
                }
            };

            let router = router.clone();
            let tls_acceptor = tls_acceptor.clone();

            tokio::spawn(async move {
                // Peek the first byte: 0x16 = TLS handshake record.
                let mut first = [0u8; 1];
                let is_tls = match stream.peek(&mut first).await {
                    Ok(1) => first[0] == 0x16,
                    _ => false,
                };

                let service = TowerToHyperService::new(router);
                let builder = ConnBuilder::new(TokioExecutor::new());

                if is_tls {
                    match tls_acceptor.accept(stream).await {
                        Ok(tls_stream) => {
                            let _ = builder
                                .serve_connection_with_upgrades(TokioIo::new(tls_stream), service)
                                .await;
                        }
                        Err(e) => log::debug!("[SERVER] TLS handshake failed: {}", e),
                    }
                } else {
                    let _ = builder
                        .serve_connection_with_upgrades(TokioIo::new(stream), service)
                        .await;
                }
            });
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ForgeLibraryEntry;

    #[test]
    fn list_maps_custom_fields_and_preserves_existing() {
        let mut db = ForgeDatabase::default();
        db.library.insert(
            "Celeste".to_string(),
            ForgeLibraryEntry {
                title: "Celeste".to_string(),
                cover_url: "http://x/cover.jpg".to_string(),
                ..Default::default()
            },
        );

        let body = serde_json::json!({
            "title": "Celeste",
            "custom_release_year": "2018",
            "custom_developer": "Maddy Makes Games",
            "custom_publisher": "Maddy Makes Games",
            "genre": "PLATFORMER",
            "not_a_real_field": "ignored",
        });
        let title = upsert_library_entry(&mut db, body.as_object().unwrap()).unwrap();
        let e = &db.library[&title];
        assert_eq!(e.release_year, "2018");
        assert_eq!(e.developer, "Maddy Makes Games");
        assert_eq!(e.publisher, "Maddy Makes Games");
        assert_eq!(e.genre, "PLATFORMER");
        assert_eq!(e.cover_url, "http://x/cover.jpg"); // untouched field preserved

        // title is required
        let bad = serde_json::json!({ "genre": "X" });
        assert!(upsert_library_entry(&mut db, bad.as_object().unwrap()).is_err());
    }

    #[test]
    fn unexile_removes_case_insensitive() {
        let mut db = ForgeDatabase {
            delisted_apps: vec!["celeste.exe".to_string(), "other.exe".to_string()],
            ..Default::default()
        };
        unexile(&mut db, "Celeste.EXE");
        assert_eq!(db.delisted_apps, vec!["other.exe".to_string()]);
    }
}
