pub mod config;
mod auth;
pub use forge_detection as scanner;
pub mod metadata;
pub mod server;
pub mod hub;
pub mod spark_protocol;
use config::{AppConfig, EngineStatus};

use std::sync::{Arc, Mutex, OnceLock};
use serde::Deserialize;
use tauri::{Emitter, Manager};

static APP_BASE_DIR: OnceLock<std::path::PathBuf> = OnceLock::new();

/// Initialize the app base directory from the Tauri resource dir.
/// Must be called from `setup()` so we have an AppHandle.
fn init_app_base_dir(app: &tauri::AppHandle) {
    // resource_dir() returns the platform-specific resource directory.
    // On Windows installed: next to the exe (e.g. C:\Program Files\StatusForge.io\)
    // In dev: the src-tauri/ directory (where Cargo.toml lives)
    // Bundled resources via ../ in tauri.conf.json land in _up_/ subdir of resource_dir.
    let resource_dir = app.path().resource_dir()
        .expect("Failed to resolve resource dir");

    // In dev mode, resource_dir is src-tauri/ but our data files (Config.json,
    // widgets/, etc.) live in the workspace root (parent of src-tauri/).
    // In production, resources are bundled directly into resource_dir.
    let base = if resource_dir.join("Config.json").exists() {
        resource_dir.to_path_buf()
    } else if resource_dir.parent().is_some_and(|p| p.join("Config.json").exists()) {
        resource_dir.parent().unwrap().to_path_buf()
    } else {
        resource_dir.to_path_buf()
    };

    // First run: bootstrap Config.json from the bundled template.
    let config_path = base.join("Config.json");
    if !config_path.exists() {
        let template = base.join("Config.json.template");
        if template.exists() {
            if let Err(e) = std::fs::copy(&template, &config_path) {
                log::warn!("Failed to bootstrap Config.json from template: {}", e);
            } else {
                log::info!("Bootstrapped Config.json from template");
            }
        }
    }

    let _ = APP_BASE_DIR.set(base.to_path_buf());
}

/// Returns the canonical base directory for the application.
/// All config/data files MUST live under this directory.
fn app_base_dir() -> Result<std::path::PathBuf, String> {
    if let Some(dir) = APP_BASE_DIR.get() {
        return Ok(dir.clone());
    }
    // Fallback if init hasn't been called yet (shouldn't happen in practice)
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

/// Engine status for the frontend — built directly from the in-process native
/// engine state (no HTTP round-trip; the Python sidecar is gone).
#[tauri::command]
fn get_engine_status(state: tauri::State<Arc<NativeEngineState>>) -> Result<EngineStatus, String> {
    let status = server::build_status(&state);
    let s = |k: &str| status.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    Ok(EngineStatus {
        running: state.running.load(Ordering::Relaxed),
        game_title: s("game_title"),
        process_name: s("process_name"),
        is_playing: status.get("is_playing").and_then(|v| v.as_bool()).unwrap_or(false),
        genre: s("genre"),
        developer: s("developer"),
        publisher: s("publisher"),
        release_date: s("release_date"),
        cover_url: s("cover_url"),
        ..Default::default()
    })
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
        // Return full config — this is a local Tauri app, no need to redact
        Ok(serde_json::json!(config))
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

/// Start the detection engine. Detection is always native (Rust) — the
/// Python sidecar has been removed.
#[tauri::command]
fn start_engine(
    _payload: EnginePayload,
    state: tauri::State<Arc<NativeEngineState>>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    spawn_engine_loop(Arc::clone(&state), app_handle)
}

/// Detection mode is always "native" now. Kept for frontend compatibility.
#[tauri::command]
fn get_detection_mode() -> String {
    "native".to_string()
}

#[tauri::command]
fn stop_engine(
    _payload: EnginePayload,
    state: tauri::State<Arc<NativeEngineState>>,
) -> Result<String, String> {
    state.running.store(false, Ordering::Relaxed);
    Ok("Engine stopped".to_string())
}

#[tauri::command]
fn is_engine_running(
    _payload: EnginePayload,
    state: tauri::State<Arc<NativeEngineState>>,
) -> bool {
    state.running.load(Ordering::Relaxed)
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
    /// Live status feed for WebSocket widget subscribers
    pub status_tx: tokio::sync::watch::Sender<serde_json::Value>,
}

impl Default for NativeEngineState {
    fn default() -> Self {
        let (status_tx, _rx) = tokio::sync::watch::channel(serde_json::json!({
            "running": false,
            "game_title": "",
            "is_playing": false,
        }));
        Self {
            running: Arc::new(AtomicBool::new(false)),
            current_game: Mutex::new(None),
            current_process: Mutex::new(String::new()),
            is_playing: Mutex::new(false),
            start_time: Mutex::new(0.0),
            lost_focus_time: Mutex::new(None),
            status_tx,
        }
    }
}

impl NativeEngineState {
    /// Recompute the widget status payload and push it to WS subscribers.
    pub fn push_status(&self) {
        let _ = self.status_tx.send(server::build_status(self));
    }
}

/// Start the native engine detection loop in a background thread.
/// Runs natively on Windows, macOS, and Linux.
#[tauri::command]
fn start_native_engine_loop(
    state: tauri::State<Arc<NativeEngineState>>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    spawn_engine_loop(Arc::clone(&state), app_handle)
}

/// Shared implementation for `start_engine` / `start_native_engine_loop`.
fn spawn_engine_loop(
    state_arc: Arc<NativeEngineState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    if state_arc.running.load(Ordering::Relaxed) {
        return Ok("Native engine loop already running".to_string());
    }

    state_arc.running.store(true, Ordering::Relaxed);
    let running = state_arc.running.clone();

    std::thread::spawn(move || {
        let log: LogFn = Box::new(|msg: &str, level: &str, _cd: u64| {
            log::info!("[NATIVE] {} {}", level, msg);
        });

        let mut scout = ForgeWaterfall::new(log);

        // macOS: window titles need Screen Recording permission. Surface it
        // loudly (the status payload also carries `permission_error`).
        if let Some(err) = scout.permission_error() {
            log::warn!("[NATIVE] {}", err);
        }

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

                    // Emit event to frontend + push to WS widgets
                    let _ = app_handle.emit("game-detected", &game);
                    state_arc.push_status();
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
                        state_arc.push_status();
                    }
                }
            }

            std::thread::sleep(Duration::from_secs(scan_interval));
        }

        log::info!("[NATIVE] Engine loop stopped.");
    });

    Ok("Native engine loop started".to_string())
}

/// Stop the native engine detection loop.
#[tauri::command]
fn stop_native_engine_loop(state: tauri::State<Arc<NativeEngineState>>) -> Result<String, String> {
    state.running.store(false, Ordering::Relaxed);
    Ok("Native engine loop stopped".to_string())
}

/// Get current native engine detection status.
#[tauri::command]
fn get_native_engine_status(state: tauri::State<Arc<NativeEngineState>>) -> serde_json::Value {
    let game = state.current_game.lock().unwrap().clone();
    let process = state.current_process.lock().unwrap().clone();
    let is_playing = *state.is_playing.lock().unwrap();
    let start_time = *state.start_time.lock().unwrap();
    // Some(message) when the OS blocks window inspection (macOS Screen Recording)
    let permission_error = scanner::platform::permission_error();

    serde_json::json!({
        "running": state.running.load(Ordering::Relaxed),
        "current_game": game,
        "process": process,
        "is_playing": is_playing,
        "start_time": start_time,
        "permission_error": permission_error,
    })
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
/// Called by the frontend so API keys never need to live in Config.json.
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
        let entry = keyring::Entry::new(KEYRING_SERVICE, key);
        if let Ok(e) = entry {
            if let Ok(val) = e.get_password() {
                if !val.is_empty() {
                    map.insert(key.to_string(), serde_json::json!(val));
                }
            }
        }
    }
    for key in &api_keys {
        let entry = keyring::Entry::new(KEYRING_SERVICE, key);
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

/// Exile a game: drop it from the library and delist its lowercase title so
/// the scanner ignores it. Used by the Status Room "Exile to Apps" button.
#[tauri::command]
fn exile_app(game: String) -> Result<String, String> {
    let game = game.trim().to_string();
    if game.is_empty() {
        return Err("No game title provided".to_string());
    }
    let mut db = server::load_db()?;
    db.library.remove(&game);
    let lower = game.to_lowercase();
    if !db.delisted_apps.contains(&lower) {
        db.delisted_apps.push(lower);
    }
    server::save_db(&db)?;
    Ok(format!("Exiled \"{}\"", game))
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

/// Get dev diagnostics: platform, detection mode, native engine status.
#[tauri::command]
fn dev_get_diagnostics(
    state: tauri::State<Arc<NativeEngineState>>,
    hub: tauri::State<Arc<hub::HubState>>,
) -> serde_json::Value {
    serde_json::json!({
        "platform": get_platform(),
        "detection_mode": get_detection_mode(),
        "native_engine_running": state.running.load(Ordering::Relaxed),
        "native_current_game": state.current_game.lock().unwrap().clone(),
        "native_process": state.current_process.lock().unwrap().clone(),
        "native_is_playing": *state.is_playing.lock().unwrap(),
        "hub_paired_spark": hub.paired.lock().unwrap().clone(),
        "permission_error": scanner::platform::permission_error(),
    })
}

// ═══════════════════════════════════════════════════════════════════════════════
// Autostart (launch on login) — user-facing toggle, off by default
// ═══════════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════════
// Entry Point
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let oauth_state = Arc::new(auth::OAuthState::new());
    let engine_state = Arc::new(NativeEngineState::default());
    let hub_state = Arc::new(hub::HubState::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(oauth_state.clone())
        .manage(engine_state.clone())
        .manage(hub_state.clone())
        .setup(move |app| {
            init_app_base_dir(app.handle());

            // Log to stdout + <app base dir>/debug.log so `dev_get_log_tail`
            // and cross-platform detection debugging have a findable file.
            // Registered here (not on the Builder) because the base dir is
            // only known after init_app_base_dir().
            let log_dir = app_base_dir().unwrap_or_default();
            if let Err(e) = app.handle().plugin(
                tauri_plugin_log::Builder::new()
                    .targets([
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                            path: log_dir,
                            file_name: Some("debug".to_string()),
                        }),
                    ])
                    .level(log::LevelFilter::Info)
                    .build(),
            ) {
                eprintln!("Failed to init log plugin: {}", e);
            }

            // LAN Hub: announce on udp/53736, receive SPARK heartbeats on udp/53735
            hub::start_hub(hub_state.clone(), engine_state.clone(), app.handle().clone());

            // Widget/status + OAuth server (tcp/127.0.0.1:53735, HTTP + TLS)
            let server_state = server::ServerState {
                engine: engine_state.clone(),
                oauth: oauth_state.clone(),
            };
            tauri::async_runtime::spawn(async move {
                if let Err(e) = server::start_server(server_state).await {
                    log::error!("[SERVER] Failed to start widget/OAuth server: {}", e);
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
            hub::hub_get_status,
            hub::hub_set_pin,
            hub::hub_set_pairing_key,
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
            exile_app,
            dev_get_log_tail,
            dev_get_diagnostics,
            get_autostart,
            set_autostart,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}