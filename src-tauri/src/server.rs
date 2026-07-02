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
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use tokio::sync::watch;

use crate::auth::SharedOAuthState;
use crate::config::AppConfig;
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
                            entry.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string()
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
