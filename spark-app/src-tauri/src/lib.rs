use serde::{Deserialize, Serialize};
use std::net::UdpSocket;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

// ─── Config ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SparkConfig {
    pub pin: String,
    pub hub_port: u16,
    pub scan_interval_secs: u64,
    pub auto_push: bool,
}

impl Default for SparkConfig {
    fn default() -> Self {
        Self {
            pin: "0000".to_string(),
            hub_port: 53735,
            scan_interval_secs: 5,
            auto_push: true,
        }
    }
}

// ─── Runtime State ───────────────────────────────────────────────────────────

pub struct SparkState {
    pub config: Mutex<SparkConfig>,
    pub current_game: Mutex<Option<GameInfo>>,
    pub connected: Mutex<bool>,
    pub hostname: String,
    pub running: Arc<AtomicBool>,
}

pub fn init_state() -> SparkState {
    let hostname = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "Unknown-PC".to_string());

    SparkState {
        config: Mutex::new(SparkConfig::default()),
        current_game: Mutex::new(None),
        connected: Mutex::new(false),
        hostname,
        running: Arc::new(AtomicBool::new(true)),
    }
}

// ─── Game Detection (no storage — just scan & forward) ───────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameInfo {
    pub process: String,
}

fn detect_running_game() -> Option<GameInfo> {
    use sysinfo::ProcessesToUpdate;
    use sysinfo::System;

    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);

    // Known game executables — bare minimum heuristic, no DB storage
    // StatusForge handles all metadata matching
    let known_games: &[&str] = &[
        "eldenring.exe", "witcher3.exe", "cyberpunk2077.exe", "gta5.exe",
        "rdr2.exe", "minecraft.exe", "valorant.exe", "cs2.exe",
        "dota2.exe", "lol.exe", "fortnite.exe", "apex.exe",
        "overwatch.exe", "destiny2.exe", "warzone.exe", "cod.exe",
        "battlefield.exe", "starfield.exe", "baldursgate3.exe",
        "hogwarts.exe", "palworld.exe", "helldivers2.exe", "satisfactory.exe",
        "rust.exe", "ark.exe", "terraria.exe", "stardewvalley.exe",
        "hollow_knight.exe", "celeste.exe", "hades.exe", "riskofrain2.exe",
        "deeprockgalactic.exe", "left4dead2.exe", "portal2.exe",
        "half-life.exe", "skyrim.exe", "fallout4.exe", "oblivion.exe",
        "morrowind.exe", "eso.exe", "ffxiv.exe", "wow.exe",
        "diablo.exe", "diablo4.exe", "pathofexile.exe", "grimdawn.exe",
        "torchlight.exe", "borderlands.exe", "borderlands3.exe",
        "division.exe", "division2.exe", "far cry.exe", "farcry5.exe",
        "assassinscreed.exe", "watch_dogs.exe", "ghostrecon.exe",
        "splintercell.exe", "justcause.exe", "madmax.exe",
        "metalgear.exe", "deathstranding.exe", "silenthill.exe",
        "residentevil.exe", "re4.exe", "deadspace.exe",
        "bioshock.exe", "prey.exe", "dishonored.exe",
        "doom.exe", "eternal.exe", "quake.exe", "unreal.exe",
        "rocketleague.exe", "fallguys.exe", "amongus.exe",
        "phasmophobia.exe", "gtav.exe", "fivem.exe",
        "spotify.exe", "discord.exe", "obs.exe", "streamlabs.exe",
    ];

    for process in sys.processes().values() {
        let exe_name = process
            .name()
            .to_str()
            .unwrap_or("")
            .to_lowercase();

        let exe_key = exe_name.trim_end_matches(".exe");

        if known_games.iter().any(|g| g.trim_end_matches(".exe") == exe_key) {
            return Some(GameInfo { process: exe_name });
        }
    }

    None
}

// ─── UDP Heartbeat ───────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct HeartbeatMessage {
    app: String,
    version: String,
    hostname: String,
    pin: String,
    timestamp: f64,
    game: HeartbeatGame,
    command: String,
}

#[derive(Serialize, Deserialize)]
struct HeartbeatGame {
    process: Option<String>,
    is_playing: bool,
}

fn send_heartbeat(
    state: &SparkState,
    game: Option<&GameInfo>,
) -> Result<(), Box<dyn std::error::Error>> {
    let config = state.config.lock().unwrap();

    let msg = HeartbeatMessage {
        app: "StatusForge_Spark".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        hostname: state.hostname.clone(),
        pin: config.pin.clone(),
        timestamp: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64(),
        game: HeartbeatGame {
            process: game.map(|g| g.process.clone()),
            is_playing: game.is_some(),
        },
        command: "heartbeat".to_string(),
    };

    let payload = serde_json::to_string(&msg)?;

    let socket = UdpSocket::bind("0.0.0.0:0")?;
    socket.set_broadcast(true)?;
    socket.set_nonblocking(false)?;
    socket.set_write_timeout(Some(Duration::from_millis(500)))?;

    let target = format!("255.255.255.255:{}", config.hub_port);
    socket.send_to(payload.as_bytes(), &target)?;

    Ok(())
}

// ─── Background Scanner Loop ─────────────────────────────────────────────────

fn start_scanner_loop(state: Arc<SparkState>, app_handle: tauri::AppHandle) {
    let running = state.running.clone();
    std::thread::spawn(move || {
        loop {
            if !running.load(Ordering::Relaxed) {
                break;
            }

            let (scan_interval, auto_push) = {
                let config = state.config.lock().unwrap();
                (config.scan_interval_secs, config.auto_push)
            };

            if auto_push {
                // Scan for running game — no storage, just detect
                let game = detect_running_game();

                // Update current game (transient, in-memory only)
                {
                    let mut current = state.current_game.lock().unwrap();
                    *current = game.clone();
                }

                // Send to StatusForge
                let connected = match send_heartbeat(&state, game.as_ref()) {
                    Ok(_) => true,
                    Err(_) => false,
                };

                {
                    let mut conn = state.connected.lock().unwrap();
                    *conn = connected;
                }

                // Emit to frontend
                let config = state.config.lock().unwrap();
                let status = serde_json::json!({
                    "hostname": &state.hostname,
                    "connected": connected,
                    "current_game": game,
                    "pin": config.pin,
                    "hub_port": config.hub_port,
                    "scan_interval": config.scan_interval_secs,
                    "auto_push": config.auto_push,
                    "last_scan": SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs(),
                });

                let _ = app_handle.emit("status-update", status);
            } else {
                // Auto-push disabled — still emit status so frontend knows
                let config = state.config.lock().unwrap();
                let status = serde_json::json!({
                    "hostname": &state.hostname,
                    "connected": false,
                    "current_game": null,
                    "pin": config.pin,
                    "hub_port": config.hub_port,
                    "scan_interval": config.scan_interval_secs,
                    "auto_push": config.auto_push,
                    "last_scan": SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs(),
                });
                let _ = app_handle.emit("status-update", status);
            }

            std::thread::sleep(Duration::from_secs(scan_interval));
        }
    });
}

// ─── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
fn get_status(state: tauri::State<Arc<SparkState>>) -> serde_json::Value {
    let current_game = state.current_game.lock().unwrap().clone();
    let connected = *state.connected.lock().unwrap();
    let config = state.config.lock().unwrap();

    serde_json::json!({
        "hostname": state.hostname,
        "connected": connected,
        "current_game": current_game,
        "pin": config.pin,
        "hub_port": config.hub_port,
        "scan_interval": config.scan_interval_secs,
        "auto_push": config.auto_push,
        "last_scan": SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    })
}

#[tauri::command]
fn set_pin(state: tauri::State<Arc<SparkState>>, pin: String) -> Result<String, String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.pin = pin;
    Ok("PIN updated".to_string())
}

#[tauri::command]
fn set_hub_port(state: tauri::State<Arc<SparkState>>, port: u16) -> Result<String, String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.hub_port = port;
    Ok(format!("Hub port set to {}", port))
}

#[tauri::command]
fn set_scan_interval(state: tauri::State<Arc<SparkState>>, secs: u64) -> Result<String, String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.scan_interval_secs = secs;
    Ok(format!("Scan interval set to {}s", secs))
}

#[tauri::command]
fn toggle_auto_push(state: tauri::State<Arc<SparkState>>) -> Result<bool, String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.auto_push = !config.auto_push;
    Ok(config.auto_push)
}

#[tauri::command]
fn manual_push(state: tauri::State<Arc<SparkState>>) -> Result<String, String> {
    let game = detect_running_game();
    {
        let mut current = state.current_game.lock().map_err(|e| e.to_string())?;
        *current = game.clone();
    }
    match send_heartbeat(&state, game.as_ref()) {
        Ok(_) => Ok("Pushed to StatusForge".to_string()),
        Err(e) => Err(format!("Push failed: {}", e)),
    }
}

#[tauri::command]
fn shutdown_scanner(state: tauri::State<Arc<SparkState>>) -> Result<String, String> {
    state.running.store(false, Ordering::Relaxed);
    Ok("Scanner stopped".to_string())
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = Arc::new(init_state());

    tauri::Builder::default()
        .manage(state.clone())
        .setup(move |app| {
            let handle = app.handle().clone();
            start_scanner_loop(state.clone(), handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            set_pin,
            set_hub_port,
            set_scan_interval,
            manual_push,
            toggle_auto_push,
            shutdown_scanner,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Spark")
}
