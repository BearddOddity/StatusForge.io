//! Blipy — the dual-PC gaming-side agent.
//!
//! Runs on the gaming PC, detects the current game with the shared
//! `forge-detection` crate, and broadcasts signed v2 heartbeats over the LAN
//! to the StatusForge Hub (see `blipy_protocol`). Detect & forward only — no
//! game database, no storage.

// Identical copy of the main app's blipy_protocol.rs — Blipy only builds
// heartbeats; the Hub-side validate path is exercised by this module's tests.
#[allow(dead_code)]
mod blipy_protocol;

use forge_detection::waterfall::{GameDetector, LogFn};
use serde::{Deserialize, Serialize};
use std::net::UdpSocket;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

use blipy_protocol::{HubAnnounce, DISCOVERY_PORT, HEARTBEAT_PORT};

/// A discovered Hub goes stale after this many seconds without an announce
/// (the Hub announces every 5s).
const HUB_STALE_SECS: f64 = 30.0;

// ─── Config (persisted) ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct BlipyConfig {
    pub pin: String,
    /// Optional user-set pairing key mixed into the HMAC secret.
    pub pairing_key: String,
    pub scan_interval_secs: u64,
    pub auto_push: bool,
}

impl Default for BlipyConfig {
    fn default() -> Self {
        Self {
            pin: "0000".to_string(),
            pairing_key: String::new(),
            scan_interval_secs: 5,
            auto_push: true,
        }
    }
}

fn config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("StatusForge Blipy").join("config.json"))
}

/// Old installs kept their config under "StatusForge Spark" before the
/// rename -- checked as a one-time fallback so an upgrade doesn't force
/// re-pairing. The next save_config() call writes to the new location.
fn legacy_config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("StatusForge Spark").join("config.json"))
}

fn load_config() -> BlipyConfig {
    config_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .or_else(|| {
            legacy_config_path()
                .and_then(|p| std::fs::read_to_string(p).ok())
                .and_then(|s| serde_json::from_str(&s).ok())
        })
        .unwrap_or_default()
}

fn save_config(config: &BlipyConfig) {
    if let Some(path) = config_path() {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        match serde_json::to_string_pretty(config) {
            Ok(json) => {
                if let Err(e) = std::fs::write(&path, json) {
                    log::warn!("[BLIPY] Failed to save config: {}", e);
                }
            }
            Err(e) => log::warn!("[BLIPY] Failed to serialize config: {}", e),
        }
    }
}

// ─── Runtime State ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct GameInfo {
    pub title: String,
    pub process: String,
    pub is_playing: bool,
}

pub struct BlipyState {
    pub config: Mutex<BlipyConfig>,
    pub current_game: Mutex<Option<GameInfo>>,
    /// (hub_name, last_seen_secs) of the most recently discovered Hub.
    pub hub: Mutex<Option<(String, f64)>>,
    pub last_scan: Mutex<u64>,
    pub hostname: String,
    pub running: Arc<AtomicBool>,
}

pub fn init_state() -> BlipyState {
    let hostname = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "Unknown-PC".to_string());

    BlipyState {
        config: Mutex::new(load_config()),
        current_game: Mutex::new(None),
        hub: Mutex::new(None),
        last_scan: Mutex::new(0),
        hostname,
        running: Arc::new(AtomicBool::new(true)),
    }
}

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

impl BlipyState {
    /// Hub name if one announced itself recently.
    fn live_hub(&self) -> Option<String> {
        self.hub
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(_, seen)| now_secs() - seen < HUB_STALE_SECS)
            .map(|(name, _)| name.clone())
    }

    fn status_json(&self) -> serde_json::Value {
        let hub = self.live_hub();
        let config = self.config.lock().unwrap();
        serde_json::json!({
            "hostname": self.hostname,
            "connected": hub.is_some(),
            "hub_name": hub,
            "current_game": *self.current_game.lock().unwrap(),
            "pin": config.pin,
            "hub_port": HEARTBEAT_PORT,
            "scan_interval": config.scan_interval_secs,
            "auto_push": config.auto_push,
            "last_scan": *self.last_scan.lock().unwrap(),
        })
    }
}

// ─── UDP Heartbeat (Blipy → Hub, signed v2) ──────────────────────────────────

fn send_heartbeat(socket: &UdpSocket, state: &BlipyState) -> Result<(), String> {
    let (pin, pairing_key) = {
        let config = state.config.lock().unwrap();
        (config.pin.clone(), config.pairing_key.clone())
    };
    let game = state.current_game.lock().unwrap().clone();
    let hb = blipy_protocol::build_heartbeat(
        &state.hostname,
        game.as_ref().map(|g| g.title.as_str()),
        game.as_ref().map(|g| g.process.as_str()),
        &pin,
        &pairing_key,
    );
    let payload = serde_json::to_vec(&hb).map_err(|e| e.to_string())?;
    socket
        .send_to(&payload, ("255.255.255.255", HEARTBEAT_PORT))
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn broadcast_socket() -> Result<UdpSocket, String> {
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    socket.set_broadcast(true).map_err(|e| e.to_string())?;
    socket
        .set_write_timeout(Some(Duration::from_millis(500)))
        .map_err(|e| e.to_string())?;
    Ok(socket)
}

// ─── Background loops ────────────────────────────────────────────────────────

/// Scanner + heartbeat loop: detect with GameDetector, broadcast signed
/// heartbeats. Blipy is featherweight — the waterfall only refreshes the
/// processes it actually inspects.
fn start_scanner_loop(state: Arc<BlipyState>, app_handle: tauri::AppHandle) {
    let running = state.running.clone();
    std::thread::spawn(move || {
        let log: LogFn = Box::new(|msg: &str, level: &str, _cd: u64| {
            log::info!("[BLIPY] {} {}", level, msg);
        });
        let mut scout = GameDetector::new(log);
        if let Some(err) = scout.permission_error() {
            log::warn!("[BLIPY] {}", err);
        }

        let socket = match broadcast_socket() {
            Ok(s) => Some(s),
            Err(e) => {
                log::error!("[BLIPY] Failed to open broadcast socket: {}", e);
                None
            }
        };

        while running.load(Ordering::Relaxed) {
            let (scan_interval, auto_push) = {
                let config = state.config.lock().unwrap();
                (config.scan_interval_secs.clamp(1, 60), config.auto_push)
            };

            if auto_push {
                let detected = scout.scout_active_session();
                *state.current_game.lock().unwrap() = detected.map(|d| GameInfo {
                    title: d.title,
                    process: d.process,
                    is_playing: true,
                });
                *state.last_scan.lock().unwrap() = now_secs() as u64;

                if let Some(socket) = &socket {
                    if let Err(e) = send_heartbeat(socket, &state) {
                        log::warn!("[BLIPY] Heartbeat failed: {}", e);
                    }
                }
            }

            let _ = app_handle.emit("status-update", state.status_json());
            std::thread::sleep(Duration::from_secs(scan_interval));
        }
        log::info!("[BLIPY] Scanner loop stopped");
    });
}

/// Discovery listener: Hub announces on UDP 53736; remember who is out there
/// so the UI can show "BROADCASTING TO <hub>".
fn start_discovery_loop(state: Arc<BlipyState>) {
    let running = state.running.clone();
    std::thread::spawn(move || {
        let socket = match UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT)) {
            Ok(s) => s,
            Err(e) => {
                log::error!("[BLIPY] Failed to bind UDP {}: {}", DISCOVERY_PORT, e);
                return;
            }
        };
        let _ = socket.set_read_timeout(Some(Duration::from_secs(2)));
        log::info!(
            "[BLIPY] Listening for Hub announcements on udp/{}",
            DISCOVERY_PORT
        );
        let mut buf = [0u8; 1024];
        while running.load(Ordering::Relaxed) {
            // recv errors are read-timeouts — loop to re-check `running`
            if let Ok((len, _addr)) = socket.recv_from(&mut buf) {
                if let Ok(announce) = serde_json::from_slice::<HubAnnounce>(&buf[..len]) {
                    if announce.app == "StatusForge_Hub" && !announce.hub_name.is_empty() {
                        let mut hub = state.hub.lock().unwrap();
                        let is_new = hub
                            .as_ref()
                            .map(|(n, _)| n != &announce.hub_name)
                            .unwrap_or(true);
                        if is_new {
                            log::info!("[BLIPY] Discovered Hub '{}'", announce.hub_name);
                        }
                        *hub = Some((announce.hub_name, now_secs()));
                    }
                }
            }
        }
    });
}

// ─── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
fn get_status(state: tauri::State<Arc<BlipyState>>) -> serde_json::Value {
    state.status_json()
}

#[tauri::command]
fn set_pin(state: tauri::State<Arc<BlipyState>>, pin: String) -> Result<String, String> {
    if pin.len() != 4 || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err("PIN must be exactly 4 digits".to_string());
    }
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.pin = pin;
    save_config(&config);
    Ok("PIN updated".to_string())
}

#[tauri::command]
fn set_pairing_key(state: tauri::State<Arc<BlipyState>>, key: String) -> Result<String, String> {
    if key.len() > 128 {
        return Err("Pairing key too long (max 128 chars)".to_string());
    }
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.pairing_key = key;
    save_config(&config);
    Ok("Pairing key updated".to_string())
}

#[tauri::command]
fn set_scan_interval(state: tauri::State<Arc<BlipyState>>, secs: u64) -> Result<String, String> {
    let secs = secs.clamp(1, 60);
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.scan_interval_secs = secs;
    save_config(&config);
    Ok(format!("Scan interval set to {}s", secs))
}

#[tauri::command]
fn toggle_auto_push(state: tauri::State<Arc<BlipyState>>) -> Result<bool, String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.auto_push = !config.auto_push;
    save_config(&config);
    Ok(config.auto_push)
}

/// Force an immediate heartbeat with the latest detection.
#[tauri::command]
fn manual_push(state: tauri::State<Arc<BlipyState>>) -> Result<String, String> {
    let socket = broadcast_socket()?;
    send_heartbeat(&socket, &state)?;
    match state.live_hub() {
        Some(hub) => Ok(format!("Pushed to {}", hub)),
        None => Ok("Pushed (no Hub discovered yet)".to_string()),
    }
}

#[tauri::command]
fn shutdown_scanner(state: tauri::State<Arc<BlipyState>>) -> Result<String, String> {
    state.running.store(false, Ordering::Relaxed);
    Ok("Scanner stopped".to_string())
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

// ─── Tray ────────────────────────────────────────────────────────────────────

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let stow = MenuItem::with_id(app, "stow", "Stow", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Kill", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &stow, &quit])?;

    let mut builder = TrayIconBuilder::with_id("blipy-tray")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("StatusForge Blipy")
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
                if let Some(state) = app.try_state::<Arc<BlipyState>>() {
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

// ─── Entry Point ─────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = Arc::new(init_state());

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("blipy".to_string()),
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(state.clone())
        .setup(move |app| {
            setup_tray(app)?;
            let handle = app.handle().clone();
            start_scanner_loop(state.clone(), handle);
            start_discovery_loop(state.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            set_pin,
            set_pairing_key,
            set_scan_interval,
            manual_push,
            toggle_auto_push,
            shutdown_scanner,
            get_autostart,
            set_autostart,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Blipy")
}
