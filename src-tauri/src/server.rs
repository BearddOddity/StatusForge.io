//! Local overlay/status server.
//!
//! One listener on 127.0.0.1:53735 serves BOTH protocols by peeking the first
//! byte of each connection:
//! - TLS  (0x16 handshake) → Twitch OAuth callback (`https://127.0.0.1:53735/...`)
//! - plain HTTP            → overlays (`/status`, `/settings`, `/widgets/*`,
//!   `/ws` WebSocket) and the Kick OAuth callback (`http://localhost:53735/...`)
//!
//! Overlay endpoints accept an optional `X-Forge-Token` header or `?token=`
//! query parameter; when present it must match `engine_settings.overlay_token`
//! (401 otherwise). The server only ever binds loopback.

use std::sync::atomic::Ordering;
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
use crate::EngineState;

pub const SERVER_ADDR: &str = "127.0.0.1:53735";

/// Shared state for the widget/status server.
#[derive(Clone)]
pub struct ServerState {
    pub engine: Arc<EngineState>,
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

/// Byte-for-byte equal without short-circuiting on the first mismatching
/// byte, so response timing doesn't leak how many leading bytes of a guess
/// were correct. Only the length check exits early — token length isn't
/// secret (it's a fixed-size base64 encoding of 16 random bytes).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Validate the widget token. A request must supply the correct token via
/// `X-Forge-Token` header or `?token=` query param — missing or wrong token
/// is always rejected.
///
/// Binding to loopback only keeps *other machines* out; it does nothing
/// against a malicious webpage the user has open in their own browser,
/// which can reach `127.0.0.1` just fine and — with permissive CORS — read
/// the response too. The token is the actual access control here, so it
/// can't be optional.
fn check_token(headers: &HeaderMap, query_token: Option<&str>) -> Result<(), StatusCode> {
    let provided = headers
        .get("X-Forge-Token")
        .and_then(|v| v.to_str().ok())
        .or(query_token);
    let Some(provided) = provided else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let expected = crate::app_base_dir()
        .ok()
        .and_then(|base| crate::auth::load_config_at(&base).ok())
        .map(|c| c.engine_settings.overlay_token)
        .unwrap_or_default();
    if !expected.is_empty() && constant_time_eq(provided.as_bytes(), expected.as_bytes()) {
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

/// Fields metadata::scan() can fill in — the only ones eligible to be
/// locked by a manual save (title/ids-that-aren't-scan-sourced/executables
/// don't need locking; nothing auto-overwrites them).
const SCANNABLE_FIELDS: &[&str] = &[
    "genre",
    "release_year",
    "developer",
    "publisher",
    "cover_url",
    "logo_url",
    "igdb_id",
    "rawg_id",
    "sgdb_id",
    "steam_id",
    "gog_id",
    "twitch_id",
    "kick_id",
];

/// Upsert a library entry from an arbitrary `/list` JSON body. Requires `title`.
/// Maps `custom_release_year`/`custom_developer`/`custom_publisher` onto the
/// real fields, overlays any ForgeLibraryEntry fields present, preserves the rest.
///
/// Every scannable field present in the body gets locked (see
/// ForgeLibraryEntry::locked_fields) — this is the *manual* save path (the
/// Library editor's Save Changes / Add Game), so every field the user
/// reviewed and saved is treated as their call from here on, not something
/// a later automatic scan should quietly change out from under them.
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

    // Resolve to any existing entry that only differs by case/whitespace
    // (see find_library_key) so Add Game / Save Changes never mints a
    // second key for a game the scanner — or an earlier manual save —
    // already stored under slightly different casing/padding. The old key
    // is removed and re-inserted under `title` so the key always tracks
    // whatever title was most recently saved, keeping key == entry.title.
    //
    // A title edit is a rename, not a fresh entry: the editor sends the
    // pre-edit title as `old_title` precisely so a correction like
    // "ONCE_HUMAN" -> "Once Human" (which differs by more than
    // case/whitespace, so find_library_key alone can't bridge it) still
    // resolves to the same row instead of forking a blank duplicate that
    // loses the executables/aliases already saved on the original.
    let old_title = body
        .get("old_title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let existing_key = old_title
        .and_then(|old| crate::config::find_library_key(db, old))
        .or_else(|| crate::config::find_library_key(db, &title));
    let mut existing = existing_key
        .as_ref()
        .and_then(|k| db.library.remove(k))
        .unwrap_or_default();

    // Keep the pre-rename title reachable as a Detection Alias so a raw
    // scanner/window-title hit under the old (often garbled) name still
    // resolves to this entry rather than re-forking a duplicate the next
    // time the game launches.
    if let Some(old) = old_title {
        let old_norm = forge_detection::alias::normalize_alias_name(old);
        let new_norm = forge_detection::alias::normalize_alias_name(&title);
        if old_norm != new_norm
            && !existing
                .aliases
                .iter()
                .any(|a| forge_detection::alias::normalize_alias_name(&a.name) == old_norm)
        {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            existing.aliases.push(crate::config::GameAlias {
                name: old.to_string(),
                priority: 1,
                language: "en".to_string(),
                added_at: format!("{:010}", now),
                preferred: false,
            });
        }
    }

    // The editor sends `aliases` as a comma-separated string (same shape as
    // `executables`); resolve it into structured GameAlias values BEFORE the
    // serde overlay below, which would reject a bare string where the entry
    // expects a Vec. An array body (future richer editor / import) passes
    // through the overlay untouched.
    let parsed_aliases = match body.get("aliases") {
        Some(serde_json::Value::String(s)) => {
            Some(parse_alias_names(db, &title, s, &existing.aliases)?)
        }
        _ => None,
    };

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
    if let Some(aliases) = parsed_aliases {
        obj.insert(
            "aliases".to_string(),
            serde_json::to_value(aliases).map_err(|e| format!("alias serialize failed: {}", e))?,
        );
    }
    obj.insert(
        "title".to_string(),
        serde_json::Value::String(title.clone()),
    );
    let mut entry: crate::config::ForgeLibraryEntry =
        serde_json::from_value(serde_json::Value::Object(obj))
            .map_err(|e| format!("invalid entry fields: {}", e))?;

    for field in SCANNABLE_FIELDS {
        if body.contains_key(*field) && !entry.locked_fields.iter().any(|f| f == field) {
            entry.locked_fields.push(field.to_string());
        }
    }

    // A user-edited `executables` field is the whole point of exposing it in
    // the metadata editor: it lets someone fix a game the scanner mis-titles
    // (or misses entirely) by telling the engine exactly which exe maps to
    // this title, without waiting on a hardcoded alias. Mirror any change
    // into `listed_apps` — the same Stage-1 "instant match" map the built-in
    // aliases use — so it actually takes effect on the next detection pass,
    // not just sit in the entry as inert metadata.
    if body.contains_key("executables") {
        for exe in split_executables(&existing.executables) {
            if db
                .listed_apps
                .get(&exe)
                .map(|t| t == &title)
                .unwrap_or(false)
            {
                db.listed_apps.remove(&exe);
            }
        }
        let new_execs = split_executables(&entry.executables);
        for exe in &new_execs {
            db.listed_apps.insert(exe.clone(), title.clone());
        }
        entry.executables = new_execs.join(", ");
    }

    db.library.insert(title.clone(), entry);
    Ok(title)
}

/// Split a user-entered `executables` field ("FalloutNV.exe, other.exe")
/// into normalized (trimmed, lowercased) individual exe names.
///
/// Detection matches on the bare process name only (never a full path), so
/// if an entry looks like a path — someone pasted
/// `D:\SteamLibrary\...\FalloutNV.exe` instead of just `FalloutNV.exe` — the
/// path is stripped down to its final component. Without this, a pasted
/// path would silently never match anything.
fn split_executables(s: &str) -> Vec<String> {
    s.split(',')
        .map(|p| {
            let normalized = p.trim().replace('\\', "/");
            normalized
                .rsplit('/')
                .next()
                .unwrap_or(&normalized)
                .to_lowercase()
        })
        .filter(|p| !p.is_empty())
        .collect()
}

/// Parses the editor's comma-separated alias text into `GameAlias` values
/// for the entry being saved (`entry_title`).
///
/// - An existing name keeps its old priority/language/added_at/preferred.
/// - A new name gets defaults and a fresh timestamp.
/// - The entry's own title, and duplicates, are dropped quietly.
/// - A name that matches a DIFFERENT entry's title is rejected — canonical
///   titles always beat aliases, so it could never actually resolve.
fn parse_alias_names(
    db: &ForgeDatabase,
    entry_title: &str,
    raw: &str,
    existing: &[crate::config::GameAlias],
) -> Result<Vec<crate::config::GameAlias>, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let entry_title_norm = forge_detection::alias::normalize_alias_name(entry_title);

    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<crate::config::GameAlias> = Vec::new();
    for part in raw.split(',') {
        let name = part.trim();
        if name.is_empty() {
            continue;
        }
        let norm = forge_detection::alias::normalize_alias_name(name);
        if norm == entry_title_norm || seen.contains(&norm) {
            continue;
        }
        if let Some(other) = crate::config::find_library_key(db, name) {
            if forge_detection::alias::normalize_alias_name(&other) != entry_title_norm {
                return Err(format!(
                    "\"{}\" is already a game in your library — an alias can't shadow another game's title",
                    name
                ));
            }
        }
        seen.push(norm.clone());
        out.push(
            existing
                .iter()
                .find(|a| forge_detection::alias::normalize_alias_name(&a.name) == norm)
                .cloned()
                .unwrap_or_else(|| crate::config::GameAlias {
                    name: name.to_string(),
                    priority: 1,
                    language: "en".to_string(),
                    added_at: format!("{:010}", now),
                    preferred: false,
                }),
        );
    }
    Ok(out)
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
    let config = load_config().unwrap_or_default();
    let mut db = load_db().map_err(internal)?;
    // Resolve through find_library_key (same as upsert_library_entry) so a
    // re-scan of a title that only differs by case/whitespace from an
    // existing entry updates that entry instead of minting a duplicate.
    let key = crate::config::find_library_key(&db, &title).unwrap_or_else(|| title.clone());
    let mut existing = db.library.remove(&key).unwrap_or_default();
    existing.title = title.clone();
    let merged =
        crate::metadata::scan(&title, &config.api_keys, &config.broadcaster, existing).await;
    db.library.insert(title, merged.clone());
    save_db(&db).map_err(internal)?;
    Ok(Json(
        serde_json::to_value(merged).map_err(|e| internal(e.to_string()))?,
    ))
}

#[derive(Deserialize)]
struct ResolveCoverBody {
    url: String,
}

/// Resolves a pasted cover/logo value that isn't actually an image link.
/// Right now that means a SteamGridDB asset *page* URL, like
/// steamgriddb.com/grid/805055 — that's an HTML page, not the image itself.
/// Anything else (a real direct URL, a local file path) comes back
/// unchanged; local paths get handled on the frontend via Tauri's asset
/// protocol instead.
async fn resolve_cover_handler(
    Query(q): Query<TokenQuery>,
    headers: HeaderMap,
    Json(body): Json<ResolveCoverBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    check_token(&headers, q.token.as_deref()).map_err(|s| (s, String::new()))?;
    let config = load_config().unwrap_or_default();
    let resolved = crate::metadata::resolve_cover_field(&body.url, &config.api_keys.steamgrid)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    Ok(Json(serde_json::json!({ "url": resolved })))
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

async fn twitch_login_handler(State(state): State<ServerState>) -> Result<Redirect, StatusCode> {
    let config = load_config().ok_or_else(|| internal("Config.json unavailable".into()))?;
    let client_id = config.broadcaster.twitch_client;
    if client_id.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let verifier = crate::auth::generate_code_verifier();
    let challenge = crate::auth::generate_code_challenge(&verifier);
    let state_token = crate::auth::generate_code_verifier();
    state.oauth.pkce.lock().unwrap().insert(
        "twitch".to_string(),
        crate::auth::PkceState {
            verifier,
            state: state_token.clone(),
        },
    );
    Ok(Redirect::temporary(&crate::auth::build_twitch_auth_url(
        &client_id,
        &state_token,
        &challenge,
    )))
}

/// Build the status payload the overlays consume — game info from the
/// engine (or LAN Hub), enriched with Forge_Database library metadata.
pub fn build_status(engine: &EngineState) -> serde_json::Value {
    let running = engine.running.load(Ordering::Relaxed);
    let game = engine.current_game.lock().unwrap().clone();
    let process = engine.current_process.lock().unwrap().clone();
    let is_playing = *engine.is_playing.lock().unwrap();
    let start_time = *engine.start_time.lock().unwrap();

    let config = load_config();
    let fade_timer = config
        .as_ref()
        .map(|c| c.engine_settings.overlay_fade_timer)
        .unwrap_or(15);

    let game_title = game.as_ref().map(|g| g.title.clone()).unwrap_or_default();

    // Enrich with Forge_Database.json library metadata when we have a match.
    // While idle (but running), fall back to the idle category's own
    // library entry (e.g. "Just Chatting") so a custom cover set for it via
    // the Library editor shows up here too, instead of always falling
    // through to the app's built-in placeholder image. Skipped entirely
    // while the engine isn't running — there's no live idle session to
    // reflect, so the widget/Dashboard should show truly offline, not the
    // idle category's cover.
    let mut genre = String::new();
    let mut developer = String::new();
    let mut publisher = String::new();
    let mut release_date = String::new();
    let mut cover_url = String::new();
    let mut logo_url = String::new();
    let lookup_title = if !game_title.is_empty() {
        Some(game_title.clone())
    } else if running {
        config
            .as_ref()
            .map(|c| c.engine_settings.idle_category.clone())
    } else {
        None
    };
    if let Some(lookup_title) = lookup_title {
        if let Ok(db) = load_db() {
            if let Some(key) = crate::config::find_library_key(&db, &lookup_title) {
                if let Some(entry) = db.library.get(&key) {
                    genre = entry.genre.clone();
                    developer = entry.developer.clone();
                    publisher = entry.publisher.clone();
                    release_date = entry.release_year.clone();
                    cover_url = entry.cover_url.clone();
                    logo_url = entry.logo_url.clone();
                }
            }
        }
    }

    serde_json::json!({
        "running": running,
        "game_title": game_title,
        "process_name": process,
        "is_playing": is_playing,
        "start_time": start_time,
        "genre": genre,
        "developer": developer,
        "publisher": publisher,
        "release_date": release_date,
        "cover_url": cover_url,
        "logo_url": logo_url,
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
        "overlay_poll_rate": es.as_ref().map(|e| e.overlay_poll_rate).unwrap_or(3),
        "overlay_fade_timer": es.as_ref().map(|e| e.overlay_fade_timer).unwrap_or(15),
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

/// Serves an overlay file (HTML + its assets) gated by the real
/// `overlay_token`, at the URL the frontend's Overlay Generator hands out
/// (`/forge-overlay/{token}/{file}`). `/forge-widget/...` routes here too —
/// the old path from before the widget→overlay rename — so a URL already
/// pasted into an OBS Browser Source keeps working forever; only newly
/// generated URLs use the new path. Unlike `check_token`, a missing/wrong
/// token is always rejected here — an OBS browser-source URL is the one
/// overlay surface meant to leave the machine (pasted into streaming
/// software, screen-shared, etc.), so it doesn't get the loopback-implies-
/// trusted pass that `/status`/`/settings` get.
async fn forge_overlay_handler(
    axum::extract::Path((token, file)): axum::extract::Path<(String, String)>,
) -> Result<axum::response::Response, StatusCode> {
    let expected = load_config()
        .map(|c| c.engine_settings.overlay_token)
        .unwrap_or_default();
    if expected.is_empty() || !constant_time_eq(token.as_bytes(), expected.as_bytes()) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    if file.contains('/') || file.contains('\\') || file.contains("..") {
        return Err(StatusCode::BAD_REQUEST);
    }

    let widgets_dir = crate::app_base_dir()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .join("widgets");
    let path = widgets_dir.join(&file);
    crate::assert_path_in_base(&path, &widgets_dir).map_err(|_| StatusCode::BAD_REQUEST)?;

    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let mime = match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("svg") => "image/svg+xml",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        _ => "application/octet-stream",
    };
    Ok(([(axum::http::header::CONTENT_TYPE, mime)], bytes).into_response())
}

fn build_router(state: ServerState) -> Router {
    Router::new()
        .route("/status", get(status_handler))
        .route("/settings", get(settings_handler))
        .route("/ws", get(ws_handler))
        .route("/health", get(health_handler))
        .route("/forge-overlay/{token}/{file}", get(forge_overlay_handler))
        // Old route name, kept working for URLs already pasted into an OBS
        // Browser Source before the widget→overlay rename.
        .route("/forge-widget/{token}/{file}", get(forge_overlay_handler))
        .route("/api/forge-full", get(forge_full_handler))
        .route("/api/exiled-apps", get(exiled_apps_handler))
        .route("/list", post(list_handler))
        .route("/unexile", post(unexile_handler))
        .route("/export-meta", get(export_meta_handler))
        .route("/import-meta", post(import_meta_handler))
        .route("/api/scan-metadata", post(scan_metadata_handler))
        .route("/api/resolve-cover", post(resolve_cover_handler))
        .route("/kick/login", get(kick_login_handler))
        .route("/twitch/login", get(twitch_login_handler))
        .route(
            "/oauth/callback/{platform}",
            get(crate::auth::oauth_callback),
        )
        .layer(
            tower_http::cors::CorsLayer::new()
                .allow_origin(allowed_cors_origins())
                .allow_methods(tower_http::cors::Any)
                .allow_headers(tower_http::cors::Any)
                // The webview's origin (tauri://localhost, https://tauri.localhost)
                // isn't itself a loopback address, so Chromium/WebView2 treat every
                // fetch to 127.0.0.1 as a Private Network Access request and send a
                // preflight with Access-Control-Request-Private-Network: true. Without
                // echoing this header back, that preflight is denied and every request
                // from the app's own UI to this server fails outright.
                .allow_private_network(true),
        )
        .with_state(state)
}

/// Origins allowed to make cross-origin requests to the local server.
///
/// Widget overlays (OBS browser sources) load their HTML from this same
/// server, so their fetches are same-origin and need no CORS grant at all.
/// The only legitimate cross-origin caller is the app's own webview, so we
/// allowlist exactly those origins instead of reflecting `Any` — a random
/// webpage in the user's regular browser must not be able to read
/// `/status`/`/api/forge-full` or trigger `/import-meta` even if it somehow
/// obtains a widget token.
fn allowed_cors_origins() -> tower_http::cors::AllowOrigin {
    const ORIGINS: &[&str] = &[
        "http://localhost:5173",   // Vite dev server
        "tauri://localhost",       // production webview (macOS, WebKitGTK custom-scheme builds)
        "http://tauri.localhost",  // production webview (Linux/WebKitGTK, observed in practice)
        "https://tauri.localhost", // production webview (Windows/WebView2)
    ];
    tower_http::cors::AllowOrigin::list(
        ORIGINS
            .iter()
            .map(|o| axum::http::HeaderValue::from_static(o)),
    )
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
    fn renaming_title_updates_in_place_instead_of_forking_a_duplicate() {
        let mut db = ForgeDatabase::default();
        db.library.insert(
            "ONCE_HUMAN".to_string(),
            ForgeLibraryEntry {
                title: "ONCE_HUMAN".to_string(),
                executables: "Once_Human.exe".to_string(),
                ..Default::default()
            },
        );
        db.listed_apps
            .insert("once_human.exe".to_string(), "ONCE_HUMAN".to_string());

        let body = serde_json::json!({
            "old_title": "ONCE_HUMAN",
            "title": "Once Human",
        });
        let title = upsert_library_entry(&mut db, body.as_object().unwrap()).unwrap();

        assert_eq!(title, "Once Human");
        assert_eq!(db.library.len(), 1, "rename must not fork a duplicate entry");
        let e = &db.library["Once Human"];
        assert_eq!(e.executables, "Once_Human.exe", "exe association carries over");
        assert!(
            e.aliases.iter().any(|a| a.name == "ONCE_HUMAN"),
            "the pre-rename title becomes a detection alias so future raw \
             detections under the old name still resolve here"
        );
    }

    #[test]
    fn executables_field_registers_listed_apps() {
        let mut db = ForgeDatabase::default();
        let body = serde_json::json!({
            "title": "Fallout New Vegas",
            "executables": "FalloutNV.exe",
        });
        upsert_library_entry(&mut db, body.as_object().unwrap()).unwrap();
        assert_eq!(
            db.listed_apps.get("falloutnv.exe"),
            Some(&"Fallout New Vegas".to_string())
        );
        assert_eq!(db.library["Fallout New Vegas"].executables, "falloutnv.exe");
    }

    #[test]
    fn executables_field_strips_full_paths_to_the_file_name() {
        let mut db = ForgeDatabase::default();
        let body = serde_json::json!({
            "title": "Fallout New Vegas",
            "executables": r"D:\SteamLibrary\steamapps\common\Fallout New Vegas\FalloutNV.exe",
        });
        upsert_library_entry(&mut db, body.as_object().unwrap()).unwrap();
        assert_eq!(
            db.listed_apps.get("falloutnv.exe"),
            Some(&"Fallout New Vegas".to_string())
        );
        assert!(!db
            .listed_apps
            .contains_key(r"d:\steamlibrary\steamapps\common\fallout new vegas\falloutnv.exe"));
    }

    #[test]
    fn executables_field_supports_multiple_comma_separated() {
        let mut db = ForgeDatabase::default();
        let body = serde_json::json!({
            "title": "APB Reloaded",
            "executables": "APB.exe,  APBLauncher.exe ",
        });
        upsert_library_entry(&mut db, body.as_object().unwrap()).unwrap();
        assert_eq!(
            db.listed_apps.get("apb.exe"),
            Some(&"APB Reloaded".to_string())
        );
        assert_eq!(
            db.listed_apps.get("apblauncher.exe"),
            Some(&"APB Reloaded".to_string())
        );
    }

    #[test]
    fn aliases_string_field_parses_into_structured_aliases() {
        let mut db = ForgeDatabase::default();
        let body = serde_json::json!({
            "title": "Dark Souls III",
            "aliases": "DS3, Dark Souls 3, ",
        });
        upsert_library_entry(&mut db, body.as_object().unwrap()).unwrap();
        let aliases = &db.library["Dark Souls III"].aliases;
        assert_eq!(aliases.len(), 2);
        assert_eq!(aliases[0].name, "DS3");
        assert_eq!(aliases[0].priority, 1);
        assert_eq!(aliases[0].language, "en");
        assert!(!aliases[0].added_at.is_empty());
        assert_eq!(aliases[1].name, "Dark Souls 3");
    }

    #[test]
    fn alias_reedit_preserves_metadata_and_dedupes() {
        let mut db = ForgeDatabase::default();
        let first = serde_json::json!({ "title": "Dark Souls III", "aliases": "DS3" });
        upsert_library_entry(&mut db, first.as_object().unwrap()).unwrap();
        let original_added_at = db.library["Dark Souls III"].aliases[0].added_at.clone();

        // Re-save with the same name (different case), a duplicate, the
        // entry's own title, and one new name.
        let second = serde_json::json!({
            "title": "Dark Souls III",
            "aliases": "ds3, DS3, Dark Souls III, Souls III",
        });
        upsert_library_entry(&mut db, second.as_object().unwrap()).unwrap();
        let aliases = &db.library["Dark Souls III"].aliases;
        assert_eq!(aliases.len(), 2);
        assert_eq!(aliases[0].added_at, original_added_at); // metadata survives
        assert_eq!(aliases[1].name, "Souls III");
    }

    #[test]
    fn alias_shadowing_another_library_title_is_rejected() {
        let mut db = ForgeDatabase::default();
        let other = serde_json::json!({ "title": "Elden Ring" });
        upsert_library_entry(&mut db, other.as_object().unwrap()).unwrap();

        let body = serde_json::json!({
            "title": "Dark Souls III",
            "aliases": "elden ring",
        });
        assert!(upsert_library_entry(&mut db, body.as_object().unwrap()).is_err());
        // The failed save must not have inserted a half-built entry.
        assert!(!db.library.contains_key("Dark Souls III"));
    }

    #[test]
    fn entry_without_aliases_serializes_without_aliases_key() {
        // Backward compat: pre-alias Forge_Database.json round-trips with no
        // new keys appearing on entries that have no aliases.
        let mut db = ForgeDatabase::default();
        let body = serde_json::json!({ "title": "Celeste" });
        upsert_library_entry(&mut db, body.as_object().unwrap()).unwrap();
        let json = serde_json::to_value(&db.library["Celeste"]).unwrap();
        assert!(json.get("aliases").is_none());
    }

    #[test]
    fn resolve_title_alias_prefers_canonical_titles_over_aliases() {
        let mut db = ForgeDatabase::default();
        let a = serde_json::json!({ "title": "Dark Souls III", "aliases": "DS3" });
        upsert_library_entry(&mut db, a.as_object().unwrap()).unwrap();

        // A raw title that IS a library title resolves to itself (None).
        assert_eq!(
            crate::config::resolve_title_alias(&db, "Dark Souls III"),
            None
        );
        assert_eq!(
            crate::config::resolve_title_alias(&db, "dark souls iii "),
            None
        );
        // An alias resolves to the canonical title, case-insensitively.
        assert_eq!(
            crate::config::resolve_title_alias(&db, " ds3"),
            Some("Dark Souls III".to_string())
        );
        // Unknown titles stay unresolved.
        assert_eq!(crate::config::resolve_title_alias(&db, "Elden Ring"), None);
    }

    #[test]
    fn editing_executables_removes_stale_listed_apps_entry() {
        let mut db = ForgeDatabase::default();
        let first = serde_json::json!({
            "title": "Fallout New Vegas",
            "executables": "wrongname.exe",
        });
        upsert_library_entry(&mut db, first.as_object().unwrap()).unwrap();
        assert!(db.listed_apps.contains_key("wrongname.exe"));

        let corrected = serde_json::json!({
            "title": "Fallout New Vegas",
            "executables": "FalloutNV.exe",
        });
        upsert_library_entry(&mut db, corrected.as_object().unwrap()).unwrap();
        assert!(!db.listed_apps.contains_key("wrongname.exe"));
        assert_eq!(
            db.listed_apps.get("falloutnv.exe"),
            Some(&"Fallout New Vegas".to_string())
        );
    }

    #[test]
    fn saving_without_touching_executables_leaves_listed_apps_alone() {
        let mut db = ForgeDatabase::default();
        let first = serde_json::json!({
            "title": "Celeste",
            "executables": "celeste.exe",
        });
        upsert_library_entry(&mut db, first.as_object().unwrap()).unwrap();

        let genre_only = serde_json::json!({
            "title": "Celeste",
            "genre": "Platformer",
        });
        upsert_library_entry(&mut db, genre_only.as_object().unwrap()).unwrap();
        assert_eq!(
            db.listed_apps.get("celeste.exe"),
            Some(&"Celeste".to_string())
        );
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

    #[test]
    fn constant_time_eq_matches_regular_equality() {
        assert!(constant_time_eq(b"same-token", b"same-token"));
        assert!(!constant_time_eq(b"same-token", b"different"));
        assert!(!constant_time_eq(b"short", b"much-longer-value"));
        assert!(constant_time_eq(b"", b""));
    }
}
