//! LAN Hub — the StatusForge side of the dual-PC link.
//!
//! - **Announce**: broadcasts `{"app":"StatusForge_Hub","hub_name":…}` on UDP
//!   53736 so Blipy agents can show which hub they're broadcasting to.
//! - **Receive**: listens on UDP 53735 for Blipy heartbeats, validates the
//!   4-digit PIN + HMAC signature (see `blipy_protocol`), and feeds the
//!   detected `{game, process}` into the same status/broadcast path the local
//!   engine uses — overlays update identically for 1-PC and 2-PC users.

use std::net::UdpSocket;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::Emitter;

use crate::blipy_protocol::{
    self, HeartbeatError, HubAnnounce, DISCOVERY_PORT, HEARTBEAT_PORT, PROTOCOL_VERSION,
};
use crate::scanner::GameDetection;
use crate::EngineState;

/// A Blipy heartbeat is considered stale after this many seconds
/// (Blipy sends roughly every 10s).
const BLIPY_STALE_SECS: f64 = 30.0;

#[derive(Debug, Clone, Serialize, Default)]
pub struct PairedBlipy {
    pub hostname: String,
    pub last_seen: f64,
    pub game: Option<String>,
    pub process: Option<String>,
}

pub struct HubState {
    pub hub_name: String,
    pub paired: Mutex<Option<PairedBlipy>>,
    /// Count of rejected packets (wrong PIN / bad signature), for diagnostics.
    pub rejected: Mutex<u64>,
}

impl Default for HubState {
    fn default() -> Self {
        Self::new()
    }
}

impl HubState {
    pub fn new() -> Self {
        let hub_name = hostname::get()
            .ok()
            .and_then(|h| h.into_string().ok())
            .unwrap_or_else(|| "StatusForge-Hub".to_string());
        Self {
            hub_name,
            paired: Mutex::new(None),
            rejected: Mutex::new(0),
        }
    }
}

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

/// Read (pin, pairing_key) from Config.json.
fn read_pairing() -> (String, String) {
    let config = crate::app_base_dir()
        .ok()
        .and_then(|base| crate::auth::load_config_at(&base).ok());
    match config {
        Some(c) => (
            c.engine_settings.blipy_pin,
            c.engine_settings.blipy_pairing_key,
        ),
        None => ("0000".to_string(), String::new()),
    }
}

/// Best-effort: load config + Forge DB and push the idle category. Used
/// when a Blipy-sourced game clears, mirroring the engine loop's
/// grace-period-expired path. Never errors — logs and gives up quietly,
/// same as every other pusher call site.
fn push_idle_category(base: &std::path::Path, app_handle: Option<&tauri::AppHandle>) {
    let Ok(config) = crate::auth::load_config_at(base) else {
        return;
    };
    let forge_db: crate::config::ForgeDatabase =
        std::fs::read_to_string(base.join("Forge_Database.json"))
            .ok()
            .and_then(|c| serde_json::from_str(&c).ok())
            .unwrap_or_default();
    let health_events = crate::pusher::push_category(
        base,
        &config,
        &forge_db,
        &config.engine_settings.idle_category,
    );
    if let Some(app) = app_handle {
        crate::emit_health_events(app, &health_events);
    }
}

/// Apply a validated heartbeat to the shared engine state so overlays and the
/// frontend update exactly as with local detection.
///
/// Blipy only detects and forwards — no game database, no metadata, no
/// platform pushes on its side. This app is what finds metadata and pushes
/// categories, so a Blipy-sourced detection gets funneled through the same
/// `on_game_detected` a local detection uses (needs a real AppHandle, so
/// this is skipped in the unit tests that pass `None`).
pub fn apply_heartbeat(
    hub: &HubState,
    engine: &Arc<EngineState>,
    hb: &blipy_protocol::Heartbeat,
    app_handle: Option<&tauri::AppHandle>,
) {
    let mut changed = false;
    {
        let mut paired = hub.paired.lock().unwrap();
        let prev_game = paired.as_ref().and_then(|p| p.game.clone());
        if prev_game != hb.game {
            changed = true;
        }
        *paired = Some(PairedBlipy {
            hostname: hb.hostname.clone(),
            last_seen: now_secs(),
            game: hb.game.clone(),
            process: hb.process.clone(),
        });
    }

    if !changed {
        return;
    }

    match (&hb.game, &hb.process) {
        (Some(game), process) => {
            // Stage 0 alias resolution, same as the local engine loop —
            // Blipy forwards raw titles and this app owns the library, so
            // a Blipy-sourced "DS3" must land as "Dark Souls III" too.
            let title = crate::server::load_db()
                .ok()
                .and_then(|db| crate::config::resolve_title_alias(&db, game))
                .unwrap_or_else(|| game.clone());
            let detection = GameDetection {
                title,
                process: process.clone().unwrap_or_default(),
                platform: format!("Blipy ({})", hb.hostname),
            };
            *engine.current_game.lock().unwrap() = Some(detection.clone());
            *engine.current_process.lock().unwrap() = detection.process.clone();
            *engine.is_playing.lock().unwrap() = true;
            *engine.start_time.lock().unwrap() = now_secs();
            if let Some(app) = app_handle {
                let _ = app.emit("game-detected", &detection);

                if let Ok(base) = crate::app_base_dir() {
                    if let Ok(config) = crate::auth::load_config_at(&base) {
                        crate::on_game_detected(
                            &base,
                            &config,
                            &detection.title,
                            &detection.process,
                            engine,
                            app,
                        );
                    }
                }
            }
        }
        (None, _) => {
            // Blipy reports idle — clear only if the current game came from Blipy.
            let from_blipy = engine
                .current_game
                .lock()
                .unwrap()
                .as_ref()
                .map(|g| g.platform.starts_with("Blipy"))
                .unwrap_or(false);
            if from_blipy {
                *engine.current_game.lock().unwrap() = None;
                *engine.current_process.lock().unwrap() = String::new();
                *engine.is_playing.lock().unwrap() = false;
                *engine.start_time.lock().unwrap() = 0.0;
                if let Some(app) = app_handle {
                    let _ = app.emit("game-cleared", "Blipy idle");
                }
                if let Ok(base) = crate::app_base_dir() {
                    push_idle_category(&base, app_handle);
                }
            }
        }
    }
    engine.push_status();
}

/// Handle one raw UDP datagram. Returns Ok(heartbeat) when accepted.
/// Pure enough for the in-process dual-PC integration test.
pub fn handle_packet(
    hub: &HubState,
    engine: &Arc<EngineState>,
    data: &[u8],
    pin: &str,
    pairing_key: &str,
    app_handle: Option<&tauri::AppHandle>,
) -> Result<blipy_protocol::Heartbeat, HeartbeatError> {
    match blipy_protocol::validate_heartbeat(data, pin, pairing_key) {
        Ok(hb) => {
            apply_heartbeat(hub, engine, &hb, app_handle);
            Ok(hb)
        }
        Err(e) => {
            if !matches!(e, HeartbeatError::NotAHeartbeat) {
                *hub.rejected.lock().unwrap() += 1;
                log::warn!("[HUB] Rejected Blipy packet: {}", e);
            }
            Err(e)
        }
    }
}

/// Start the Hub: heartbeat listener (UDP 53735) + discovery announcer (UDP 53736).
pub fn start_hub(hub: Arc<HubState>, engine: Arc<EngineState>, app_handle: tauri::AppHandle) {
    // ── Heartbeat listener ─────────────────────────────────────────────
    {
        let hub = hub.clone();
        let engine = engine.clone();
        let app_handle = app_handle.clone();
        std::thread::spawn(move || {
            let socket = match UdpSocket::bind(("0.0.0.0", HEARTBEAT_PORT)) {
                Ok(s) => s,
                Err(e) => {
                    log::error!("[HUB] Failed to bind UDP {}: {}", HEARTBEAT_PORT, e);
                    return;
                }
            };
            log::info!(
                "[HUB] Listening for Blipy heartbeats on udp/{}",
                HEARTBEAT_PORT
            );
            let mut buf = [0u8; 2048];
            loop {
                match socket.recv_from(&mut buf) {
                    Ok((len, _addr)) => {
                        let (pin, pairing_key) = read_pairing();
                        let _ = handle_packet(
                            &hub,
                            &engine,
                            &buf[..len],
                            &pin,
                            &pairing_key,
                            Some(&app_handle),
                        );
                    }
                    Err(e) => {
                        log::warn!("[HUB] UDP recv error: {}", e);
                        std::thread::sleep(Duration::from_secs(1));
                    }
                }
            }
        });
    }

    // ── Discovery announcer ────────────────────────────────────────────
    {
        let hub = hub.clone();
        let engine = engine.clone();
        std::thread::spawn(move || {
            let socket = match UdpSocket::bind("0.0.0.0:0") {
                Ok(s) => s,
                Err(e) => {
                    log::error!("[HUB] Failed to bind announcer socket: {}", e);
                    return;
                }
            };
            let _ = socket.set_broadcast(true);
            let announce = HubAnnounce {
                app: "StatusForge_Hub".to_string(),
                hub_name: hub.hub_name.clone(),
                version: Some(PROTOCOL_VERSION),
            };
            let payload = serde_json::to_vec(&announce).unwrap_or_default();
            loop {
                let _ = socket.send_to(&payload, ("255.255.255.255", DISCOVERY_PORT));

                // Housekeeping: expire a stale Blipy pairing.
                {
                    let mut paired = hub.paired.lock().unwrap();
                    if let Some(p) = paired.as_ref() {
                        if now_secs() - p.last_seen > BLIPY_STALE_SECS {
                            log::info!("[HUB] Blipy '{}' went silent — unpairing", p.hostname);
                            let had_game = p.game.is_some();
                            *paired = None;
                            drop(paired);
                            if had_game {
                                let from_blipy = engine
                                    .current_game
                                    .lock()
                                    .unwrap()
                                    .as_ref()
                                    .map(|g| g.platform.starts_with("Blipy"))
                                    .unwrap_or(false);
                                if from_blipy {
                                    *engine.current_game.lock().unwrap() = None;
                                    *engine.current_process.lock().unwrap() = String::new();
                                    *engine.is_playing.lock().unwrap() = false;
                                    engine.push_status();
                                }
                            }
                        }
                    }
                }

                std::thread::sleep(Duration::from_secs(5));
            }
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tauri commands (registered in lib.rs)
// ═══════════════════════════════════════════════════════════════════════════

#[tauri::command]
pub fn hub_get_status(state: tauri::State<Arc<HubState>>) -> serde_json::Value {
    let paired = state.paired.lock().unwrap().clone();
    let (pin, _) = read_pairing();
    serde_json::json!({
        "hub_name": state.hub_name,
        "pin": pin,
        "paired_blipy": paired,
        "rejected_packets": *state.rejected.lock().unwrap(),
        "protocol_version": PROTOCOL_VERSION,
        "heartbeat_port": HEARTBEAT_PORT,
        "discovery_port": DISCOVERY_PORT,
    })
}

#[tauri::command]
pub fn hub_set_pin(pin: String) -> Result<String, String> {
    if pin.len() != 4 || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err("PIN must be exactly 4 digits".to_string());
    }
    let base = crate::app_base_dir()?;
    let mut config = crate::auth::load_config_at(&base)?;
    config.engine_settings.blipy_pin = pin;
    crate::auth::save_config_at(&base, &config)?;
    Ok("Hub PIN updated".to_string())
}

#[tauri::command]
pub fn hub_set_pairing_key(key: String) -> Result<String, String> {
    if key.len() > 128 {
        return Err("Pairing key too long (max 128 chars)".to_string());
    }
    let base = crate::app_base_dir()?;
    let mut config = crate::auth::load_config_at(&base)?;
    config.engine_settings.blipy_pairing_key = key;
    crate::auth::save_config_at(&base, &config)?;
    Ok("Pairing key updated".to_string())
}
