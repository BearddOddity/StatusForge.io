use std::process::Command;
mod config;
mod auth;
mod scanner;
use config::{AppConfig, DetectionMode, EngineStatus};

use std::sync::{Arc, Mutex, OnceLock};
use serde::{Deserialize, Serialize};
use tauri::Manager;

static ENGINE_PROCESS: OnceLock<Mutex<Option<std::process::Child>>> = OnceLock::new();

fn engine_process() -> &'static Mutex<Option<std::process::Child>> {
    ENGINE_PROCESS.get_or_init(|| Mutex::new(None))
}

/// Returns the canonical base directory for the application (where the exe resides).
/// All config/data files MUST live under this directory.
fn app_base_dir() -> Result<std::path::PathBuf, String> {
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Failed to get exe path: {}", e))?;
    let base = exe_path.parent()
        .ok_or_else(|| "Failed to get exe parent directory".to_string())?;
    let canonical = std::fs::canonicalize(base)
        .map_err(|e| format!("Failed to canonicalize base dir: {}", e))?;
    Ok(canonical)
}

/// Validates that `path` is canonicalized and lives under `base`.
/// Prevents path traversal attacks.
fn assert_path_in_base(path: &std::path::Path, base: &std::path::Path) -> Result<(), String> {
    let canonical = std::fs::canonicalize(path)
        .or_else(|_| {
            // Path may not yet exist (e.g. writing new file). Canonicalize parent, then join filename.
            let parent = path.parent()
                .ok_or_else(|| format!("Path has no parent: {:?}", path))?;
            let file_name = path.file_name()
                .ok_or_else(|| format!("Path has no file name: {:?}", path))?;
            let canonical_parent = std::fs::canonicalize(parent)
                .map_err(|e| format!("Failed to canonicalize parent: {}", e))?;
            Ok::<_, String>(canonical_parent.join(file_name))
        })?;
    if !canonical.starts_with(base) {
        return Err(format!(
            "Path traversal detected: {:?} is outside base {:?}",
            canonical, base
        ));
    }
    Ok(())
}

// --- Input validation structs ---

#[derive(Deserialize)]
struct EnginePayload {
    _unused: Option<String>,
}

/// Export config payload — now a thin wrapper, actual validation in config.rs
#[derive(Deserialize)]
struct ConfigExportPayload {
    path: Option<String>,
}

/// Import config payload — uses typed AppConfig with validation
#[derive(Deserialize)]
struct ConfigImportPayload {
    config: AppConfig,
    path: Option<String>,
}



#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Returns the current platform: "windows", "linux", or "macos".
/// Used by the frontend to grey out platform-incompatible options.
#[tauri::command]
fn get_platform() -> String {
    #[cfg(target_os = "windows")]
    { "windows".to_string() }
    #[cfg(target_os = "linux")]
    { "linux".to_string() }
    #[cfg(target_os = "macos")]
    { "macos".to_string() }
}

/// Read the widget token from Config.json to authenticate with the Python sidecar.
fn read_widget_token() -> Option<String> {
    let base = app_base_dir().ok()?;
    let config_path = base.join("Config.json");
    if !config_path.exists() { return None; }
    let content = std::fs::read_to_string(&config_path).ok()?;
    let config: serde_json::Value = serde_json::from_str(&content).ok()?;
    config.get("engine_settings")?.get("widget_token")?.as_str().map(|s| s.to_string())
}

#[tauri::command]
async fn get_engine_status() -> Result<EngineStatus, String> {
    let token = read_widget_token();
    // Use a shared client to avoid re-creating connection pool on every call
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let client = CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .expect("Failed to build HTTP client")
    });

    let mut request = client.get("http://127.0.0.1:53735/status");
    if let Some(t) = token {
        request = request.header("X-Forge-Token", t);
    }

    match request.send().await {
        Ok(response) => {
            if response.status().is_success() {
                let data: serde_json::Value = response.json()
                    .await
                    .map_err(|e| format!("Failed to parse status: {}", e))?;
                Ok(EngineStatus {
                    running: true,
                    game_title: data.get("game_title").and_then(|v| v.as_str()).unwrap_or("Unknown").to_string(),
                    process_name: data.get("process_name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    is_playing: data.get("is_playing").and_then(|v| v.as_bool()).unwrap_or(false),
                    ..Default::default()
                })
            } else if response.status().as_u16() == 401 {
                Ok(EngineStatus { running: true, game_title: "Auth Error".to_string(), process_name: String::new(), is_playing: false, ..Default::default() })
            } else {
                Ok(EngineStatus { running: false, game_title: String::new(), process_name: String::new(), is_playing: false, ..Default::default() })
            }
        }
        Err(_) => Ok(EngineStatus { running: false, game_title: String::new(), process_name: String::new(), is_playing: false, ..Default::default() }),
    }
}

#[tauri::command]
async fn get_widget_token() -> Result<String, String> {
    let base = app_base_dir()?;
    let config_path = base.join("Config.json");

    if config_path.exists() {
        let content = tokio::fs::read_to_string(&config_path)
            .await
            .map_err(|e| format!("Failed to read config: {}", e))?;
        let config: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse config: {}", e))?;
        Ok(config.get("engine_settings")
            .and_then(|v| v.get("widget_token"))
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown")
            .to_string())
    } else {
        Ok("Unknown".to_string())
    }
}

#[tauri::command]
fn export_config(payload: ConfigExportPayload) -> Result<serde_json::Value, String> {
    let base = app_base_dir()?;
    let config_path = if let Some(ref p) = payload.path {
        let p = std::path::PathBuf::from(p);
        assert_path_in_base(&p, &base)?;
        p
    } else {
        base.join("Config.json")
    };

    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config: {}", e))?;
        let config: AppConfig = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse config: {}", e))?;
        // Return config with secrets redacted (Security Audit #10)
        Ok(serde_json::json!({
            "api_keys": { "steamgrid": "***", "rawg": "***", "igdb_client": "***", "igdb_secret": "***", "igdb_token": "***" },
            "engine_settings": config.engine_settings,
            "broadcaster": { "routing_mode": config.broadcaster.routing_mode, "twitch_client": "***", "twitch_secret": "***", "twitch_token": "***", "twitch_refresh": "***", "twitch_broadcaster_id": config.broadcaster.twitch_broadcaster_id, "kick_client": "***", "kick_secret": "***", "kick_token": "***", "kick_refresh": "***", "kick_channel_id": config.broadcaster.kick_channel_id },
            "detection": config.detection,
        }))
    } else {
        Ok(serde_json::json!({}))
    }
}

#[tauri::command]
fn import_config(payload: ConfigImportPayload) -> Result<String, String> {
    // Validate config with typed struct
    payload.config.validate()
        .map_err(|e| format!("Config validation failed: {}", e))?;

    let base = app_base_dir()?;
    let config_path = if let Some(ref p) = payload.path {
        let p = std::path::PathBuf::from(p);
        assert_path_in_base(&p, &base)?;
        p
    } else {
        base.join("Config.json")
    };

    // Write with atomic temp-file-then-rename
    let raw = serde_json::to_string_pretty(&payload.config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    let tmp = config_path.with_extension("tmp");
    std::fs::write(&tmp, raw)
        .map_err(|e| format!("Failed to write temp config: {}", e))?;
    std::fs::rename(&tmp, &config_path)
        .map_err(|e| format!("Failed to rename config: {}", e))?;

    Ok("Config saved successfully".to_string())
}

/// Read detection mode from Config.json
fn read_detection_mode() -> DetectionMode {
    let base = match app_base_dir() { Ok(b) => b, Err(_) => return DetectionMode::Python };
    let config_path = base.join("Config.json");
    if !config_path.exists() { return DetectionMode::Python; }
    let content = std::fs::read_to_string(&config_path).unwrap_or_default();
    if let Ok(config) = serde_json::from_str::<AppConfig>(&content) {
        config.detection.mode
    } else {
        // Legacy: check for old detection_mode field in engine_settings
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(mode) = v.get("engine_settings").and_then(|e| e.get("detection_mode")).and_then(|m| m.as_str()) {
                match mode {
                    "spark" => return DetectionMode::Spark,
                    "native" => return DetectionMode::Native,
                    _ => return DetectionMode::Python,
                }
            }
        }
        DetectionMode::Python
    }
}

#[tauri::command]
fn start_engine(_payload: EnginePayload) -> Result<String, String> {
    let mode = read_detection_mode();

    // Native engine requires both dev_tools_enabled and closed_beta_channel
    if mode == DetectionMode::Native {
        let base = app_base_dir().map_err(|e| e)?;
        let config_path = base.join("Config.json");
        if config_path.exists() {
            let content = std::fs::read_to_string(&config_path).unwrap_or_default();
            if let Ok(config) = serde_json::from_str::<AppConfig>(&content) {
                if !config.detection.dev_tools_enabled || !config.detection.closed_beta_channel {
                    return Err("Native engine requires Dev Tools mode and Closed Beta Channel to be enabled. Set detection.dev_tools_enabled and detection.closed_beta_channel to true in Config.json and restart.".to_string());
                }
            }
        }
    }

    match mode {
        DetectionMode::Python => start_python_engine(),
        DetectionMode::Native => start_native_engine(),
        DetectionMode::Spark => {
            // Spark mode doesn't start a local engine — it receives UDP heartbeats
            Ok("Spark mode active — listening for UDP heartbeats. No local engine needed.".to_string())
        }
    }
}

fn start_python_engine() -> Result<String, String> {
    let mut process_guard = engine_process().lock().unwrap();
    if process_guard.is_some() {
        return Ok("Engine already running".to_string());
    }
    let app_dir = std::env::current_exe()
        .map(|p| p.parent().unwrap().to_owned())
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    let python_path = which::which("python")
        .or_else(|_| which::which("python3"))
        .map_err(|e| format!("Python not found: {}", e))?;
    let presence_py = app_dir.join("presence.py");
    if !presence_py.exists() {
        return Err(format!("presence.py not found at {:?}", presence_py));
    }

    let mut cmd = Command::new(python_path);
    cmd.arg(&presence_py).current_dir(&app_dir);

    // Pass keychain tokens to Python via environment variables so it never
    // reads secrets from Config.json.
    let token_entries = [
        ("twitch_token", "SF_TWITCH_TOKEN"),
        ("twitch_refresh", "SF_TWITCH_REFRESH"),
        ("twitch_secret", "SF_TWITCH_SECRET"),
        ("twitch_client_id", "SF_TWITCH_CLIENT_ID"),
        ("kick_token", "SF_KICK_TOKEN"),
        ("kick_refresh", "SF_KICK_REFRESH"),
        ("kick_secret", "SF_KICK_SECRET"),
        ("kick_client_id", "SF_KICK_CLIENT_ID"),
        ("igdb_token", "SF_IGDB_TOKEN"),
        ("igdb_secret", "SF_IGDB_SECRET"),
        ("rawg", "SF_RAWG_KEY"),
        ("steamgrid", "SF_STEAMGRID_KEY"),
    ];
    for (keychain_name, env_var) in &token_entries {
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, *keychain_name) {
            if let Ok(val) = entry.get_password() {
                if !val.is_empty() {
                    cmd.env(env_var, val);
                }
            }
        }
    }

    let child = cmd.spawn()
        .map_err(|e| format!("Failed to start engine: {}", e))?;
    let pid = child.id();
    *process_guard = Some(child);
    Ok(format!("Engine started with PID {}", pid))
}

/// Get current detection mode from config
#[tauri::command]
fn get_detection_mode() -> String {
    match read_detection_mode() {
        DetectionMode::Python => "python".to_string(),
        DetectionMode::Native => "native".to_string(),
        DetectionMode::Spark => "spark".to_string(),
    }
}

#[tauri::command]
fn stop_engine(_payload: EnginePayload) -> Result<String, String> {
    let mut process_guard = engine_process().lock().unwrap();
    
    if let Some(mut child) = process_guard.take() {
        let pid = child.id();
        child.kill().map_err(|e| format!("Failed to kill engine: {}", e))?;
        child.wait().map_err(|e| format!("Failed to wait for engine: {}", e))?;
        Ok(format!("Engine stopped (PID {})", pid))
    } else {
        Ok("Engine not running".to_string())
    }
}

#[tauri::command]
fn is_engine_running(_payload: EnginePayload) -> bool {
    engine_process().lock().unwrap().is_some()
}

// ═══════════════════════════════════════════════════════════════════════════════
// NATIVE ENGINE — Phase 3: Rust Game Detection Loop
// ═══════════════════════════════════════════════════════════════════════════════

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use scanner::waterfall::{ForgeWaterfall, LogFn};
use scanner::{GameDetection, ScannerConfig};

/// Shared state for the native detection engine.
pub struct NativeEngineState {
    /// Whether the native engine loop is running
    pub running: Arc<AtomicBool>,
    /// Last detected game
    pub current_game: Mutex<Option<GameDetection>>,
    /// Current process name
    pub current_process: Mutex<String>,
    /// Whether we are in "playing" state
    pub is_playing: Mutex<bool>,
    /// Engine start time
    pub start_time: Mutex<f64>,
    /// Grace period tracker
    pub lost_focus_time: Mutex<Option<f64>>,
}

impl Default for NativeEngineState {
    fn default() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            current_game: Mutex::new(None),
            current_process: Mutex::new(String::new()),
            is_playing: Mutex::new(false),
            start_time: Mutex::new(0.0),
            lost_focus_time: Mutex::new(None),
        }
    }
}

fn start_native_engine() -> Result<String, String> {
    // Native engine is only supported on Windows and Linux.
    // macOS should use the Python sidecar (detection_mode = "python").
    #[cfg(target_os = "macos")]
    {
        return Err("Native engine is not supported on macOS. Set detection_mode to \"python\" in Config.json and restart.".to_string());
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok("Native engine detection module loaded. Use start_native_engine_loop to begin scanning.".to_string())
    }
}

/// Start the native engine detection loop in a background thread.
/// Only available on Windows and Linux.
#[tauri::command]
fn start_native_engine_loop(
    state: tauri::State<Arc<NativeEngineState>>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        return Err("Native engine loop is not supported on macOS. Use the Python sidecar.".to_string());
    }
    #[cfg(not(target_os = "macos"))]
    {
    if state.running.load(Ordering::Relaxed) {
        return Ok("Native engine loop already running".to_string());
    }

    state.running.store(true, Ordering::Relaxed);
    let running = state.running.clone();
    // Clone the Arc so the thread owns its own reference
    let state_arc: Arc<NativeEngineState> = Arc::clone(&state);

    std::thread::spawn(move || {
        let log: LogFn = Box::new(|msg: &str, level: &str, _cd: u64| {
            log::info!("[NATIVE] {} {}", level, msg);
        });

        let mut scout = ForgeWaterfall::new(log);
        let mut current_game: Option<String> = None;
        let mut lost_focus_time: Option<f64> = None;

        // Load initial config
        let (grace_period, scan_interval, _idle_category) = {
            let base = app_base_dir().unwrap_or_default();
            let config_path = base.join("Config.json");
            if config_path.exists() {
                if let Ok(content) = std::fs::read_to_string(&config_path) {
                    if let Ok(config) = serde_json::from_str::<AppConfig>(&content) {
                        (
                            config.engine_settings.grace_period,
                            config.engine_settings.scan_interval,
                            config.engine_settings.idle_category,
                        )
                    } else {
                        (15, 5, "Just Chatting".to_string())
                    }
                } else {
                    (15, 5, "Just Chatting".to_string())
                }
            } else {
                (15, 5, "Just Chatting".to_string())
            }
        };

        // Initialize status
        {
            let mut game = state_arc.current_game.lock().unwrap();
            *game = None;
            let mut playing = state_arc.is_playing.lock().unwrap();
            *playing = false;
        }

        log::info!(
            "[NATIVE] Engine loop started. Grace: {}s, Interval: {}s",
            grace_period,
            scan_interval
        );

        while running.load(Ordering::Relaxed) {
            // Reload config each iteration
            let config = {
                let base = app_base_dir().unwrap_or_default();
                let config_path = base.join("Config.json");
                if let Ok(content) = std::fs::read_to_string(&config_path) {
                    serde_json::from_str::<AppConfig>(&content).ok()
                } else {
                    None
                }
            };

            let scan_interval = config
                .as_ref()
                .map(|c| c.engine_settings.scan_interval)
                .unwrap_or(5);
            let grace_period = config
                .as_ref()
                .map(|c| c.engine_settings.grace_period)
                .unwrap_or(15);
            let idle_category = config
                .as_ref()
                .map(|c| c.engine_settings.idle_category.clone())
                .unwrap_or_else(|| "Just Chatting".to_string());

            // Load forge DB
            let base = app_base_dir().unwrap_or_default();
            let forge_db_path = base.join("Forge_Database.json");
            let (listed, delisted, strict) = if let Ok(content) = std::fs::read_to_string(&forge_db_path) {
                if let Ok(db) = serde_json::from_str::<serde_json::Value>(&content) {
                    let listed: std::collections::HashMap<String, String> = db
                        .get("listed_apps")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();
                    let delisted: Vec<String> = db
                        .get("delisted_apps")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();
                    let strict = config
                        .as_ref()
                        .map(|c| c.engine_settings.strict_forge_mode)
                        .unwrap_or(false);
                    (listed, delisted, strict)
                } else {
                    (std::collections::HashMap::new(), vec![], false)
                }
            } else {
                (std::collections::HashMap::new(), vec![], false)
            };

            let scanner_config = config
                .as_ref()
                .map(|c| ScannerConfig {
                    ram_threshold_mb: c.engine_settings.ram_threshold,
                    confidence_threshold: c.engine_settings.confidence_threshold,
                    emulator_detection: c.engine_settings.emulator_detection,
                    process_filter_bypass: c.engine_settings.process_filter_bypass,
                    trap_chromium: c.engine_settings.trap_chromium,
                    trap_cmdline: c.engine_settings.trap_cmdline,
                    trap_ui_framework: c.engine_settings.trap_ui_framework,
                    trap_geometry: c.engine_settings.trap_geometry,
                    score_engine_dna: c.engine_settings.score_engine_dna,
                    score_fullscreen: c.engine_settings.score_fullscreen,
                    score_window_title: c.engine_settings.score_window_title,
                    score_ram: c.engine_settings.score_ram,
                })
                .unwrap_or_default();

            scout.update_forge_knowledge(listed, delisted, strict, scanner_config);

            let detected = scout.scout_active_session();

            if let Some(game) = detected {
                lost_focus_time = None;

                let game_title = game.title.clone();
                if current_game.as_ref() != Some(&game_title) {
                    current_game = Some(game_title.clone());
                    log::info!(
                        "[NATIVE] NEW GAME: {} ({})",
                        game_title,
                        game.platform
                    );

                    let mut cg = state_arc.current_game.lock().unwrap();
                    *cg = Some(game.clone());
                    let mut proc = state_arc.current_process.lock().unwrap();
                    *proc = game.process.clone();
                    let mut playing = state_arc.is_playing.lock().unwrap();
                    *playing = true;
                    let mut st = state_arc.start_time.lock().unwrap();
                    *st = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs_f64();

                    // Emit event to frontend
                    let _ = app_handle.emit("game-detected", &game);
                }
            } else {
                if current_game.is_some() {
                    if lost_focus_time.is_none() {
                        lost_focus_time = Some(
                            SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs_f64(),
                        );
                    }
                    let time_away = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs_f64()
                        - lost_focus_time.unwrap_or(0.0);
                    if time_away > grace_period as f64 {
                        log::info!("[NATIVE] Grace period expired. Dropping: {}", current_game.as_deref().unwrap_or("?"));
                        current_game = None;
                        lost_focus_time = None;

                        let mut cg = state_arc.current_game.lock().unwrap();
                        *cg = None;
                        let mut proc = state_arc.current_process.lock().unwrap();
                        *proc = String::new();
                        let mut playing = state_arc.is_playing.lock().unwrap();
                        *playing = false;
                        let mut st = state_arc.start_time.lock().unwrap();
                        *st = 0.0;

                        let _ = app_handle.emit("game-cleared", &idle_category);
                    }
                }
            }

            std::thread::sleep(Duration::from_secs(scan_interval));
        }

        log::info!("[NATIVE] Engine loop stopped.");
    });

    Ok("Native engine loop started".to_string())
    } // end #[cfg(not(target_os = "macos"))]
}

/// Stop the native engine detection loop.
#[tauri::command]
fn stop_native_engine_loop(state: tauri::State<Arc<NativeEngineState>>) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        return Err("Native engine loop is not supported on macOS.".to_string());
    }
    #[cfg(not(target_os = "macos"))]
    {
    state.running.store(false, Ordering::Relaxed);
    Ok("Native engine loop stopped".to_string())
    }
}

/// Get current native engine detection status.
#[tauri::command]
fn get_native_engine_status(state: tauri::State<Arc<NativeEngineState>>) -> serde_json::Value {
    #[cfg(target_os = "macos")]
    {
        return serde_json::json!({
            "running": false,
            "current_game": null,
            "process": "",
            "is_playing": false,
            "start_time": 0,
            "error": "Native engine not available on macOS",
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
    let game = state.current_game.lock().unwrap().clone();
    let process = state.current_process.lock().unwrap().clone();
    let is_playing = *state.is_playing.lock().unwrap();
    let start_time = *state.start_time.lock().unwrap();

    serde_json::json!({
        "running": state.running.load(Ordering::Relaxed),
        "current_game": game,
        "process": process,
        "is_playing": is_playing,
        "start_time": start_time,
    })
    }
}

// --- OS Keychain Token Storage ---

const KEYRING_SERVICE: &str = "statusforge.io";

/// Store a secret token in the OS keychain (Windows Credential Manager / macOS Keychain / Linux Secret Service).
#[tauri::command]
fn store_secret_token(service_name: String, token: String) -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &service_name)
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
    entry.set_password(&token)
        .map_err(|e| format!("Failed to store token in keychain: {}", e))?;
    Ok(format!("Token '{}' stored in OS keychain", service_name))
}

/// Retrieve a secret token from the OS keychain.
#[tauri::command]
fn get_secret_token(service_name: String) -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &service_name)
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
    let token = entry.get_password()
        .map_err(|e| format!("Failed to retrieve token from keychain: {}", e))?;
    Ok(token)
}

/// Delete a secret token from the OS keychain.
#[tauri::command]
fn delete_secret_token(service_name: String) -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &service_name)
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
    entry.delete_credential()
        .map_err(|e| format!("Failed to delete token from keychain: {}", e))?;
    Ok(format!("Token '{}' deleted from OS keychain", service_name))
}

/// Migrate all OAuth tokens from Config.json to OS keychain.
/// Reads plaintext tokens from Config.json, stores them in keychain, and blanks them in the file.
#[tauri::command]
fn migrate_tokens_to_keychain() -> Result<Vec<String>, String> {
    let base = app_base_dir()?;
    let config_path = base.join("Config.json");
    assert_path_in_base(&config_path, &base)?;

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {}", e))?;
    let mut config: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse config: {}", e))?;

    let broadcaster = config.get_mut("broadcaster")
        .ok_or_else(|| "No broadcaster section in config".to_string())?;

    let token_fields = [
        ("twitch_token", "twitch_access_token"),
        ("twitch_refresh", "twitch_refresh_token"),
        ("kick_token", "kick_access_token"),
        ("kick_refresh", "kick_refresh_token"),
        ("twitch_secret", "twitch_client_secret"),
        ("kick_secret", "kick_client_secret"),
    ];

    let mut migrated = Vec::new();
    for (json_key, keychain_name) in &token_fields {
        if let Some(val) = broadcaster.get(*json_key).and_then(|v| v.as_str()) {
            if !val.is_empty() {
                let entry = keyring::Entry::new(KEYRING_SERVICE, keychain_name)
                    .map_err(|e| format!("Failed to create keyring entry for {}: {}", keychain_name, e))?;
                entry.set_password(val)
                    .map_err(|e| format!("Failed to store {}: {}", keychain_name, e))?;
                // Blank the token in config
                if let Some(obj) = broadcaster.as_object_mut() {
                    obj.insert(json_key.to_string(), serde_json::json!(""));
                }
                migrated.push(json_key.to_string());
            }
        }
    }

    // Also handle API keys
    if let Some(api_keys) = config.get_mut("api_keys") {
        let api_fields = [
            ("igdb_token", "igdb_api_token"),
            ("igdb_secret", "igdb_api_secret"),
            ("rawg", "rawg_api_key"),
            ("steamgrid", "steamgrid_api_key"),
        ];
        for (json_key, keychain_name) in &api_fields {
            if let Some(val) = api_keys.get(*json_key).and_then(|v| v.as_str()) {
                if !val.is_empty() {
                    let entry = keyring::Entry::new(KEYRING_SERVICE, keychain_name)
                        .map_err(|e| format!("Failed to create keyring entry for {}: {}", keychain_name, e))?;
                    entry.set_password(val)
                        .map_err(|e| format!("Failed to store {}: {}", keychain_name, e))?;
                    if let Some(obj) = api_keys.as_object_mut() {
                        obj.insert(json_key.to_string(), serde_json::json!(""));
                    }
                    migrated.push(json_key.to_string());
                }
            }
        }
    }

    // Write updated config
    std::fs::write(&config_path, serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?)
        .map_err(|e| format!("Failed to write config: {}", e))?;

    Ok(migrated)
}

/// Retrieve all keychain-stored tokens as a JSON object.
/// This is called by the Tauri frontend (before starting the engine) to pass
/// tokens to the Python sidecar via environment variables, so the Python sidecar
/// never needs to read tokens from Config.json.
#[tauri::command]
fn get_all_keychain_tokens() -> Result<serde_json::Value, String> {
    let broadcaster_keys = [
        "twitch_token", "twitch_refresh", "kick_token", "kick_refresh",
        "twitch_secret", "kick_secret",
        "twitch_client_id", "kick_client_id",
    ];
    let api_keys = ["igdb_token", "igdb_secret", "rawg", "steamgrid"];

    let mut map = serde_json::Map::new();
    for key in &broadcaster_keys {
        let entry = keyring::Entry::new(KEYRING_SERVICE, *key);
        if let Ok(e) = entry {
            if let Ok(val) = e.get_password() {
                if !val.is_empty() {
                    map.insert(key.to_string(), serde_json::json!(val));
                }
            }
        }
    }
    for key in &api_keys {
        let entry = keyring::Entry::new(KEYRING_SERVICE, *key);
        if let Ok(e) = entry {
            if let Ok(val) = e.get_password() {
                if !val.is_empty() {
                    map.insert(key.to_string(), serde_json::json!(val));
                }
            }
        }
    }
    Ok(serde_json::Value::Object(map))
}

// ═══════════════════════════════════════════════════════════════════════════════
// SPARK — Dual-PC Game Detection Agent
// ═══════════════════════════════════════════════════════════════════════════════

use std::net::UdpSocket;
use tauri::Emitter;

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

pub struct SparkState {
    pub config: Mutex<SparkConfig>,
    pub current_game: Mutex<Option<SparkGameInfo>>,
    pub connected: Mutex<bool>,
    pub hostname: String,
    pub running: Arc<AtomicBool>,
}

pub fn init_spark_state() -> SparkState {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SparkGameInfo {
    pub process: String,
}

fn spark_detect_game() -> Option<SparkGameInfo> {
    use sysinfo::ProcessesToUpdate;
    use sysinfo::System;

    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);

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
        let exe_name = process.name().to_str().unwrap_or("").to_lowercase();
        let exe_key = exe_name.trim_end_matches(".exe");
        if known_games.iter().any(|g| g.trim_end_matches(".exe") == exe_key) {
            return Some(SparkGameInfo { process: exe_name });
        }
    }
    None
}

#[derive(Serialize, Deserialize)]
struct SparkHeartbeat {
    app: String,
    version: String,
    hostname: String,
    pin: String,
    timestamp: f64,
    game: SparkHeartbeatGame,
    command: String,
}

#[derive(Serialize, Deserialize)]
struct SparkHeartbeatGame {
    process: Option<String>,
    is_playing: bool,
}

fn spark_send_heartbeat(state: &SparkState, game: Option<&SparkGameInfo>) -> Result<(), Box<dyn std::error::Error>> {
    let config = state.config.lock().unwrap();
    let msg = SparkHeartbeat {
        app: "StatusForge_Spark".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        hostname: state.hostname.clone(),
        pin: config.pin.clone(),
        timestamp: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64(),
        game: SparkHeartbeatGame {
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
    socket.send_to(payload.as_bytes(), format!("255.255.255.255:{}", config.hub_port))?;
    Ok(())
}

fn start_spark_scanner(state: Arc<SparkState>, app_handle: tauri::AppHandle) {
    let running = state.running.clone();
    std::thread::spawn(move || {
        loop {
            if !running.load(Ordering::Relaxed) { break; }
            let (scan_interval, auto_push) = {
                let c = state.config.lock().unwrap();
                (c.scan_interval_secs, c.auto_push)
            };
            if auto_push {
                let game = spark_detect_game();
                { *state.current_game.lock().unwrap() = game.clone(); }
                let connected = spark_send_heartbeat(&state, game.as_ref()).is_ok();
                { *state.connected.lock().unwrap() = connected; }
                let config = state.config.lock().unwrap();
                let status = serde_json::json!({
                    "hostname": &state.hostname,
                    "connected": connected,
                    "current_game": game,
                    "pin": config.pin,
                    "hub_port": config.hub_port,
                    "scan_interval": config.scan_interval_secs,
                    "auto_push": config.auto_push,
                    "last_scan": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
                });
                let _ = app_handle.emit("spark-status-update", status);
            }
            std::thread::sleep(Duration::from_secs(scan_interval));
        }
    });
}

#[tauri::command]
fn spark_get_status(state: tauri::State<Arc<SparkState>>) -> serde_json::Value {
    let game = state.current_game.lock().unwrap().clone();
    let connected = *state.connected.lock().unwrap();
    let config = state.config.lock().unwrap();
    serde_json::json!({
        "hostname": state.hostname.clone(),
        "connected": connected,
        "current_game": game,
        "pin": config.pin,
        "hub_port": config.hub_port,
        "scan_interval": config.scan_interval_secs,
        "auto_push": config.auto_push,
        "last_scan": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
    })
}

#[tauri::command]
fn spark_set_pin(state: tauri::State<Arc<SparkState>>, pin: String) -> Result<String, String> {
    state.config.lock().map_err(|e| e.to_string())?.pin = pin;
    Ok("PIN updated".to_string())
}

#[tauri::command]
fn spark_set_hub_port(state: tauri::State<Arc<SparkState>>, port: u16) -> Result<String, String> {
    state.config.lock().map_err(|e| e.to_string())?.hub_port = port;
    Ok(format!("Hub port set to {}", port))
}

#[tauri::command]
fn spark_set_scan_interval(state: tauri::State<Arc<SparkState>>, secs: u64) -> Result<String, String> {
    state.config.lock().map_err(|e| e.to_string())?.scan_interval_secs = secs;
    Ok(format!("Scan interval set to {}s", secs))
}

#[tauri::command]
fn spark_toggle_auto_push(state: tauri::State<Arc<SparkState>>) -> Result<bool, String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.auto_push = !config.auto_push;
    Ok(config.auto_push)
}

#[tauri::command]
fn spark_manual_push(state: tauri::State<Arc<SparkState>>) -> Result<String, String> {
    let game = spark_detect_game();
    { *state.current_game.lock().map_err(|e| e.to_string())? = game.clone(); }
    match spark_send_heartbeat(&state, game.as_ref()) {
        Ok(_) => Ok("Pushed to StatusForge".to_string()),
        Err(e) => Err(format!("Push failed: {}", e)),
    }
}

#[tauri::command]
fn spark_shutdown(state: tauri::State<Arc<SparkState>>) -> Result<String, String> {
    state.running.store(false, Ordering::Relaxed);
    Ok("Scanner stopped".to_string())
}

#[tauri::command]
async fn spark_show_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("spark") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn spark_hide_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("spark") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn spark_toggle_window(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("spark") {
        let visible = window.is_visible().map_err(|e| e.to_string())?;
        if visible {
            window.hide().map_err(|e| e.to_string())?;
            Ok(false)
        } else {
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            Ok(true)
        }
    } else {
        Ok(false)
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH — OAuth Commands
// ═══════════════════════════════════════════════════════════════════════════════

/// Initiate Kick OAuth login.
/// Generates PKCE pair, stores state, opens the system browser, waits for the callback.
#[tauri::command]
async fn kick_login(
    app: tauri::AppHandle,
    state: tauri::State<'_, auth::SharedOAuthState>,
) -> Result<String, String> {
    let base_dir = app_base_dir()?;
    let config_path = base_dir.join("Config.json");
    let content = tokio::fs::read_to_string(&config_path)
        .await
        .map_err(|e| format!("Failed to read config: {}", e))?;
    let config: AppConfig = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse config: {}", e))?;

    let client_id = &config.broadcaster.kick_client;
    if client_id.is_empty() {
        return Err("Kick client ID not configured".to_string());
    }

    let verifier = auth::generate_code_verifier();
    let challenge = auth::generate_code_challenge(&verifier);
    let state_token = auth::generate_code_verifier(); // reuse CSPRNG for state

    {
        let mut pkce = state.pkce.lock().unwrap();
        pkce.insert(
            "kick".to_string(),
            auth::PkceState {
                verifier,
                state: state_token.clone(),
            },
        );
    }

    let url = auth::build_kick_auth_url(client_id, &state_token, &challenge);

    // Open system browser
    use tauri_plugin_shell::ShellExt;
    app.shell().open(&url, None)
        .map_err(|e| format!("Failed to open browser: {}", e))?;

    Ok("Kick OAuth flow initiated — check your browser".to_string())
}

/// Initiate Twitch OAuth login.
/// Opens the system browser, waits for the callback.
#[tauri::command]
async fn twitch_login(
    app: tauri::AppHandle,
    _state: tauri::State<'_, auth::SharedOAuthState>,
) -> Result<String, String> {
    let base_dir = app_base_dir()?;
    let config_path = base_dir.join("Config.json");
    let content = tokio::fs::read_to_string(&config_path)
        .await
        .map_err(|e| format!("Failed to read config: {}", e))?;
    let config: AppConfig = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse config: {}", e))?;

    let client_id = &config.broadcaster.twitch_client;
    if client_id.is_empty() {
        return Err("Twitch client ID not configured".to_string());
    }

    let url = auth::build_twitch_auth_url(client_id);

    use tauri_plugin_shell::ShellExt;
    app.shell().open(&url, None)
        .map_err(|e| format!("Failed to open browser: {}", e))?;

    Ok("Twitch OAuth flow initiated — check your browser".to_string())
}

/// Refresh Kick access token. Returns the new access token.
#[tauri::command]
fn kick_refresh_token() -> Result<String, String> {
    let base_dir = app_base_dir()?;
    let config = auth::load_config_at(&base_dir)?;
    let new_token = auth::refresh_kick_token(&config)?;

    // Save new token + refresh token to config
    let mut config = config;
    config.broadcaster.kick_token = new_token.clone();
    // refresh_token response may include a new refresh_token; handled in refresh_kick_token
    auth::save_config_at(&base_dir, &config)?;

    Ok(new_token)
}

/// Refresh Twitch access token. Returns the new access token.
#[tauri::command]
fn twitch_refresh_token() -> Result<String, String> {
    let base_dir = app_base_dir()?;
    let config = auth::load_config_at(&base_dir)?;
    let new_token = auth::refresh_twitch_token(&config)?;

    let mut config = config;
    config.broadcaster.twitch_token = new_token.clone();
    auth::save_config_at(&base_dir, &config)?;

    Ok(new_token)
}

/// Manually trigger Kick category database sync.
#[tauri::command]
async fn sync_kick_db() -> Result<String, String> {
    let base_dir = app_base_dir()?;
    let config = auth::load_config_at(&base_dir)?;

    let token = config.broadcaster.kick_token;
    if token.is_empty() {
        return Err("No Kick access token — authenticate first".to_string());
    }

    auth::sync_kick_database(&token, &base_dir).await?;
    Ok("Kick database synced".to_string())
}

/// Rotate widget token (Security Audit #5). Returns the new token.
#[tauri::command]
fn rotate_widget_token() -> Result<String, String> {
    let base_dir = app_base_dir()?;
    auth::rotate_widget_token(&base_dir)
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEV TOOLS — Hidden developer diagnostics (dev mode only)
// ═══════════════════════════════════════════════════════════════════════════════

/// Read the last N lines of the debug log file.
#[tauri::command]
fn dev_get_log_tail(lines: usize) -> Result<Vec<String>, String> {
    let base = app_base_dir()?;
    let log_path = base.join("debug.log");
    if !log_path.exists() {
        return Ok(vec!["[no log file found]".to_string()]);
    }
    let content = std::fs::read_to_string(&log_path)
        .map_err(|e| format!("Failed to read log: {}", e))?;
    let all_lines: Vec<&str> = content.lines().collect();
    let start = all_lines.len().saturating_sub(lines);
    Ok(all_lines[start..].iter().map(|l| l.to_string()).collect())
}

/// Get dev diagnostics: platform, engine pid, detection mode, native engine status.
#[tauri::command]
fn dev_get_diagnostics(
    state: tauri::State<Arc<NativeEngineState>>,
) -> serde_json::Value {
    let engine_pid = engine_process()
        .lock()
        .unwrap()
        .as_ref()
        .map(|c| c.id())
        .unwrap_or(0);

    serde_json::json!({
        "platform": get_platform(),
        "engine_pid": engine_pid,
        "detection_mode": get_detection_mode(),
        "native_engine_running": state.running.load(Ordering::Relaxed),
        "native_current_game": state.current_game.lock().unwrap().clone(),
        "native_process": state.current_process.lock().unwrap().clone(),
        "native_is_playing": *state.is_playing.lock().unwrap(),
    })
}

// ═══════════════════════════════════════════════════════════════════════════════
// Entry Point — both windows share this process
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let spark_state = Arc::new(init_spark_state());

    let oauth_state = Arc::new(auth::OAuthState::new());

    tauri::Builder::default()
        .manage(spark_state.clone())
        .manage(oauth_state.clone())
        .manage(Arc::new(NativeEngineState::default()))
        .setup(move |app| {
            let handle = app.handle().clone();
            start_spark_scanner(spark_state.clone(), handle);

            // Start OAuth callback server (127.0.0.1:53735)
            let oauth = oauth_state.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = auth::start_oauth_server(oauth).await {
                    log::error!("[AUTH] Failed to start OAuth server: {}", e);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            get_platform,
            get_engine_status,
            get_widget_token,
            export_config,
            import_config,
            start_engine,
            stop_engine,
            is_engine_running,
            store_secret_token,
            get_secret_token,
            delete_secret_token,
            migrate_tokens_to_keychain,
            get_all_keychain_tokens,
            spark_get_status,
            spark_set_pin,
            spark_set_hub_port,
            spark_set_scan_interval,
            spark_toggle_auto_push,
            spark_manual_push,
            spark_shutdown,
            spark_show_window,
            spark_hide_window,
            spark_toggle_window,
            get_detection_mode,
            start_native_engine_loop,
            stop_native_engine_loop,
            get_native_engine_status,
            kick_login,
            twitch_login,
            kick_refresh_token,
            twitch_refresh_token,
            sync_kick_db,
            rotate_widget_token,
            dev_get_log_tail,
            dev_get_diagnostics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}