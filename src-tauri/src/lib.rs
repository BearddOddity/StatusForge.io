mod auth;
pub mod config;
pub mod feedback;
pub mod pusher;
pub use forge_detection as scanner;
pub mod blipy_protocol;
pub mod hub;
pub mod metadata;
pub mod server;
use config::{AppConfig, EngineStatus};

use serde::Deserialize;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Emitter, Manager};

static APP_BASE_DIR: OnceLock<std::path::PathBuf> = OnceLock::new();

/// Initialize the app base directory from the Tauri resource dir.
/// Must be called from `setup()` so we have an AppHandle.
fn init_app_base_dir(app: &tauri::AppHandle) {
    // resource_dir() returns the platform-specific resource directory.
    // On Windows installed: next to the exe (e.g. C:\Program Files\StatusForge.io\)
    // In dev: the src-tauri/ directory (where Cargo.toml lives)
    // Bundled resources via ../ in tauri.conf.json land in _up_/ subdir of resource_dir.
    let resource_dir = app
        .path()
        .resource_dir()
        .expect("Failed to resolve resource dir");

    // In dev mode, resource_dir is src-tauri/ but our data files (Config.json,
    // widgets/, etc.) live in the workspace root (parent of src-tauri/).
    // In production, resources are bundled directly into resource_dir.
    let base = if resource_dir.join("Config.json").exists() {
        resource_dir.to_path_buf()
    } else if resource_dir
        .parent()
        .is_some_and(|p| p.join("Config.json").exists())
    {
        resource_dir.parent().unwrap().to_path_buf()
    } else {
        resource_dir.to_path_buf()
    };

    // First run: bootstrap Config.json from the bundled template.
    //
    // Parsed through AppConfig and re-serialized rather than a raw file copy:
    // ApiKeys/BroadcasterConfig fields use skip_serializing_if = "String::is_empty"
    // specifically so an unset credential is *absent* from the JSON (which is
    // what the frontend's "is this integration active" checks key off of) —
    // a byte-for-byte copy would bypass that entirely and ship whatever the
    // template's raw text happens to contain (e.g. a literal "" or leftover
    // placeholder value) as if the key were already present.
    let config_path = base.join("Config.json");
    if !config_path.exists() {
        let template = base.join("Config.json.template");
        if template.exists() {
            let bootstrapped = std::fs::read_to_string(&template)
                .map_err(|e| format!("read template: {}", e))
                .and_then(|content| {
                    serde_json::from_str::<AppConfig>(&content)
                        .map_err(|e| format!("parse template: {}", e))
                })
                .and_then(|config| {
                    serde_json::to_string_pretty(&config)
                        .map_err(|e| format!("serialize config: {}", e))
                })
                .and_then(|json| {
                    std::fs::write(&config_path, json)
                        .map_err(|e| format!("write Config.json: {}", e))
                });
            match bootstrapped {
                Ok(()) => {
                    log::info!("Bootstrapped Config.json from template");
                    // The template ships a placeholder widget token; give each fresh
                    // install a unique one so overlay widgets authenticate.
                    if let Err(e) = auth::rotate_widget_token(&base) {
                        log::warn!("Failed to generate initial widget token: {}", e);
                    }
                }
                Err(e) => log::warn!("Failed to bootstrap Config.json from template: {}", e),
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
    let exe_path = std::env::current_exe().map_err(|e| format!("Failed to get exe path: {}", e))?;
    let base = exe_path
        .parent()
        .ok_or_else(|| "Failed to get exe parent directory".to_string())?;
    let canonical = std::fs::canonicalize(base)
        .map_err(|e| format!("Failed to canonicalize base dir: {}", e))?;
    Ok(canonical)
}

/// Validates that `path` is canonicalized and lives under `base`.
/// Prevents path traversal attacks.
fn assert_path_in_base(path: &std::path::Path, base: &std::path::Path) -> Result<(), String> {
    let canonical = std::fs::canonicalize(path).or_else(|_| {
        // Path may not yet exist (e.g. writing new file). Canonicalize parent, then join filename.
        let parent = path
            .parent()
            .ok_or_else(|| format!("Path has no parent: {:?}", path))?;
        let file_name = path
            .file_name()
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

/// Export config payload — now a thin wrapper, actual validation in config.rs
#[derive(Deserialize, Default)]
struct ConfigExportPayload {
    path: Option<String>,
}

/// Import config payload — uses typed AppConfig with validation
#[derive(Deserialize)]
struct ConfigImportPayload {
    config: AppConfig,
    path: Option<String>,
    /// When true, copy the prior Config.json to Config.json.bak before writing
    /// (driven by the frontend "Automatic Backups" system pref).
    #[serde(default)]
    backup: Option<bool>,
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
    {
        "windows".to_string()
    }
    #[cfg(target_os = "linux")]
    {
        "linux".to_string()
    }
    #[cfg(target_os = "macos")]
    {
        "macos".to_string()
    }
}

/// How often we'll actually ask sysinfo to recompute CPU usage. sysinfo's
/// `cpu_usage()` is a delta since the PID's last refresh — polling it again
/// too soon (e.g. the frontend's immediate on-mount call, moments after
/// setup() primed the baseline) divides a small-but-real chunk of CPU time
/// by a tiny elapsed window, producing spurious spikes well over 100%
/// (sysinfo reports per-core, so 2 busy threads alone reads as ~200%).
/// Below this threshold we just return the last cached reading instead.
const CPU_REFRESH_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_millis(900);

struct SystemMonitorInner {
    sys: sysinfo::System,
    last_refresh: Option<std::time::Instant>,
    last_stats: SystemStats,
}

/// Shared, debounced `sysinfo::System` for the System Performance panel.
pub struct SystemMonitor(Mutex<SystemMonitorInner>);

impl Default for SystemMonitor {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemMonitor {
    pub fn new() -> Self {
        Self(Mutex::new(SystemMonitorInner {
            sys: sysinfo::System::new(),
            last_refresh: None,
            last_stats: SystemStats {
                cpu_percent: 0.0,
                memory_mb: 0,
            },
        }))
    }

    /// Refreshes now regardless of `CPU_REFRESH_MIN_INTERVAL` — used once at
    /// startup to move the CPU-usage baseline from "process exec()" to
    /// "app finished initializing," so the frontend's first real poll isn't
    /// diffed against the whole cold-start burst.
    fn prime(&self) {
        if let Ok(pid) = sysinfo::get_current_pid() {
            let mut inner = self.0.lock().unwrap();
            inner.sys.refresh_processes_specifics(
                sysinfo::ProcessesToUpdate::Some(&[pid]),
                true,
                sysinfo::ProcessRefreshKind::nothing().with_cpu(),
            );
            inner.last_refresh = Some(std::time::Instant::now());
        }
    }
}

#[derive(serde::Serialize, Clone)]
struct SystemStats {
    cpu_percent: f32,
    memory_mb: u64,
}

/// Live CPU/memory usage of the StatusForge process itself, for the Status
/// Room's System Performance panel.
#[tauri::command]
fn get_system_stats(monitor: tauri::State<SystemMonitor>) -> Result<SystemStats, String> {
    let pid = sysinfo::get_current_pid().map_err(|e| e.to_string())?;
    let mut inner = monitor.0.lock().unwrap();

    let should_refresh = match inner.last_refresh {
        Some(t) => t.elapsed() >= CPU_REFRESH_MIN_INTERVAL,
        None => true,
    };

    if should_refresh {
        inner.sys.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::Some(&[pid]),
            true,
            sysinfo::ProcessRefreshKind::nothing()
                .with_cpu()
                .with_memory(),
        );
        inner.last_refresh = Some(std::time::Instant::now());
        let proc = inner.sys.process(pid).ok_or("process not found")?;
        inner.last_stats = SystemStats {
            cpu_percent: proc.cpu_usage(),
            memory_mb: proc.memory() / (1024 * 1024),
        };
    }

    Ok(inner.last_stats.clone())
}

/// Engine status for the frontend, built directly from in-process engine
/// state (no HTTP round-trip).
#[tauri::command]
fn get_engine_status(state: tauri::State<Arc<EngineState>>) -> Result<EngineStatus, String> {
    let status = server::build_status(&state);
    let s = |k: &str| {
        status
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    Ok(EngineStatus {
        running: state.running.load(Ordering::Relaxed),
        game_title: s("game_title"),
        process_name: s("process_name"),
        is_playing: status
            .get("is_playing")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
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
        let config: serde_json::Value =
            serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))?;
        Ok(config
            .get("engine_settings")
            .and_then(|v| v.get("widget_token"))
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown")
            .to_string())
    } else {
        Ok("Unknown".to_string())
    }
}

#[tauri::command]
fn export_config(payload: Option<ConfigExportPayload>) -> Result<serde_json::Value, String> {
    let payload = payload.unwrap_or_default();
    let base = app_base_dir()?;

    // Explicit path override (backup/import file, not the live Config.json):
    // read it raw, exactly as written — no keychain involvement.
    if let Some(ref p) = payload.path {
        let p = std::path::PathBuf::from(p);
        assert_path_in_base(&p, &base)?;
        return if p.exists() {
            let content =
                std::fs::read_to_string(&p).map_err(|e| format!("Failed to read config: {}", e))?;
            let config: AppConfig = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse config: {}", e))?;
            Ok(serde_json::json!(config))
        } else {
            Ok(serde_json::json!({}))
        };
    }

    // Live Config.json: go through auth::load_config_at so tokens already
    // migrated to the OS keychain are backfilled into the returned config —
    // otherwise Settings would show Twitch/Kick as disconnected the moment
    // migrate_tokens_to_keychain blanks them out of the file, even though
    // the engine (which does load through this path) is broadcasting fine.
    if base.join("Config.json").exists() {
        let config = auth::load_config_at(&base)?;
        Ok(serde_json::json!(config))
    } else {
        Ok(serde_json::json!({}))
    }
}

#[tauri::command]
fn import_config(payload: ConfigImportPayload) -> Result<String, String> {
    // Sanitize (clamp/repair transient UI values like a half-typed PIN or a
    // cleared number field), then validate what remains.
    let mut config = payload.config;
    config.sanitize();
    config
        .validate()
        .map_err(|e| format!("Config validation failed: {}", e))?;

    let base = app_base_dir()?;
    let config_path = if let Some(ref p) = payload.path {
        let p = std::path::PathBuf::from(p);
        assert_path_in_base(&p, &base)?;
        p
    } else {
        base.join("Config.json")
    };

    // ponytail: one rolling .bak (not the 5-deep history) — add rotation if
    // anyone ever actually needs older generations.
    if payload.backup.unwrap_or(false) && config_path.exists() {
        if let Err(e) = std::fs::copy(&config_path, config_path.with_extension("json.bak")) {
            log::warn!("Config backup failed: {}", e);
        }
    }

    // Saving the live Config.json (no explicit override path): export_config
    // backfills keychain-migrated secrets into what the frontend edits, so
    // saving an unrelated setting must not let that backfilled value round-trip
    // back into plaintext on disk — re-sync it into the keychain and blank it
    // here first, same as auth::save_config_at does for every other writer.
    if payload.path.is_none() {
        auth::redact_migrated_secrets(&mut config);
    }

    // Write with atomic temp-file-then-rename
    let raw = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    let tmp = config_path.with_extension("tmp");
    std::fs::write(&tmp, raw).map_err(|e| format!("Failed to write temp config: {}", e))?;
    std::fs::rename(&tmp, &config_path).map_err(|e| format!("Failed to rename config: {}", e))?;

    Ok("Config saved successfully".to_string())
}

/// Start the detection engine.
#[tauri::command]
fn start_engine(
    state: tauri::State<Arc<EngineState>>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    spawn_engine_loop(Arc::clone(&state), app_handle)
}

#[tauri::command]
fn stop_engine(state: tauri::State<Arc<EngineState>>) -> Result<String, String> {
    state.running.store(false, Ordering::Relaxed);
    Ok("Engine stopped".to_string())
}

#[tauri::command]
fn is_engine_running(state: tauri::State<Arc<EngineState>>) -> bool {
    state.running.load(Ordering::Relaxed)
}

// ═══════════════════════════════════════════════════════════════════════════════
// GAME DETECTION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

use scanner::waterfall::{GameDetector, LogFn};
use scanner::{GameDetection, ScannerConfig};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Shared state for the detection engine.
pub struct EngineState {
    /// Whether the engine loop is running
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
    /// Manual override: (title, expires-at unix-epoch-seconds). While this
    /// is set and hasn't expired, spawn_engine_loop skips normal detection
    /// so the waterfall doesn't immediately overwrite what the user forced.
    pub override_until: Mutex<Option<(String, f64)>>,
    /// Live status feed for WebSocket widget subscribers
    pub status_tx: tokio::sync::watch::Sender<serde_json::Value>,
}

impl Default for EngineState {
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
            override_until: Mutex::new(None),
            status_tx,
        }
    }
}

impl EngineState {
    /// Marks a game as detected/playing.
    ///
    /// Each lock is taken and released within its own statement (a temporary
    /// `MutexGuard` from `.lock().unwrap()` drops at the end of the
    /// statement it's created in, per Rust's temporary-lifetime rules) —
    /// deliberately NOT `let guard = ...; *guard = ...;`, which extends the
    /// guard's lifetime to the end of the enclosing block. That was the
    /// exact shape of a real bug: holding guards across a later call to
    /// `push_status()`, which re-locks these same mutexes via
    /// `server::build_status`. `std::sync::Mutex` isn't reentrant, so that
    /// self-deadlocked the engine thread the moment a game was detected,
    /// then wedged every Tauri command touching engine state and froze the
    /// whole app (Windows reported it as "Not Responding" after ~10 minutes,
    /// not as an obvious deadlock). See `deadlock_regression` in this
    /// module's tests for a regression guard.
    pub fn set_playing(&self, game: &GameDetection) {
        *self.current_game.lock().unwrap() = Some(game.clone());
        *self.current_process.lock().unwrap() = game.process.clone();
        *self.is_playing.lock().unwrap() = true;
        *self.start_time.lock().unwrap() = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();
    }

    /// Clears playing state (game closed / grace period expired). Same
    /// per-statement locking discipline as `set_playing` — see its doc
    /// comment for why that matters.
    pub fn clear_playing(&self) {
        *self.current_game.lock().unwrap() = None;
        *self.current_process.lock().unwrap() = String::new();
        *self.is_playing.lock().unwrap() = false;
        *self.start_time.lock().unwrap() = 0.0;
    }

    /// Recompute the widget status payload and push it to WS subscribers.
    /// Re-locks current_game/current_process/is_playing/start_time — must
    /// never be called while this thread already holds one of those guards.
    pub fn push_status(&self) {
        let _ = self.status_tx.send(server::build_status(self));
    }
}

#[cfg(test)]
mod engine_state_tests {
    use super::*;
    use std::sync::mpsc;

    /// Regression guard for a real bug (fixed 2026-07-03): set_playing() and
    /// clear_playing() must never leave a mutex guard held when push_status()
    /// runs right after (it re-locks the same mutexes via build_status).
    /// std::sync::Mutex isn't reentrant, so that self-deadlocked the engine
    /// thread in production — Windows reported the app as "Not Responding"
    /// after ~10 minutes, not as an obvious deadlock. Runs the exact
    /// set/push/clear/push sequence spawn_engine_loop uses on its own thread
    /// with a timeout: if the locking discipline regresses, this test hangs
    /// (and fails on timeout) instead of the whole app doing so for real users.
    #[test]
    fn state_update_then_push_status_never_deadlocks() {
        let state = Arc::new(EngineState::default());
        let (tx, rx) = mpsc::channel();

        let worker_state = state.clone();
        std::thread::spawn(move || {
            let game = GameDetection {
                title: "Test Game".to_string(),
                process: "test.exe".to_string(),
                platform: "Test".to_string(),
            };
            worker_state.set_playing(&game);
            worker_state.push_status();
            worker_state.clear_playing();
            worker_state.push_status();
            let _ = tx.send(());
        });

        rx.recv_timeout(Duration::from_secs(2)).expect(
            "state update + push_status sequence hung — a mutex guard is \
             likely being held across a call that re-locks the same mutex",
        );
    }
}

/// Ensures the current idle category (e.g. "Just Chatting") has a Library
/// entry, so it's editable (custom cover, etc.) the same way a detected
/// game is. Bare-inserts on first run only — `find_library_key` means an
/// existing entry (whatever case/whitespace it was created with) is left
/// completely untouched, so this never clobbers a cover a user already set.
fn ensure_idle_library_entry(base: &std::path::Path) {
    let Ok(config) = auth::load_config_at(base) else {
        return;
    };
    let idle_category = config.engine_settings.idle_category.trim();
    if idle_category.is_empty() {
        return;
    }
    let Ok(mut db) = server::load_db() else {
        return;
    };
    if config::find_library_key(&db, idle_category).is_some() {
        return;
    }
    db.library.insert(
        idle_category.to_string(),
        config::ForgeLibraryEntry {
            title: idle_category.to_string(),
            ..Default::default()
        },
    );
    if let Err(e) = server::save_db(&db) {
        log::warn!(
            "[STARTUP] Failed to create idle category library entry: {}",
            e
        );
    }
}

/// Forward pusher health transitions to the frontend as toastable events.
/// "platform-down" fires once when a platform's API stops answering (the
/// pusher then queues detections instead of pushing); "platform-recovered"
/// fires once when the 30s health probe gets through again.
pub(crate) fn emit_health_events(app: &tauri::AppHandle, events: &[pusher::HealthEvent]) {
    for e in events {
        let name = if e.recovered {
            "platform-recovered"
        } else {
            "platform-down"
        };
        let _ = app.emit(name, e.platform);
    }
}

/// Runs one weekly library sync pass and emits a "library-item-synced" event
/// per changed category id, so the frontend can toast it. Shared by the
/// periodic background loop and the manual `sync_library_now` command.
async fn run_weekly_library_sync(app: &tauri::AppHandle) {
    let Ok(base_dir) = app_base_dir() else { return };
    let Ok(config) = auth::load_config_at(&base_dir) else {
        return;
    };
    let Ok(mut db) = server::load_db() else {
        return;
    };

    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let changes = metadata::weekly_library_sync(&mut db, &config.broadcaster, now_secs).await;

    if let Err(e) = server::save_db(&db) {
        log::warn!("[SYNC] Failed to save library after weekly sync: {}", e);
        return;
    }

    for change in &changes {
        log::info!(
            "[SYNC] {} category id changed on {}: {} -> {}",
            change.title,
            change.platform,
            change.old_id,
            change.new_id
        );
        let _ = app.emit(
            "library-item-synced",
            serde_json::json!({
                "title": change.title,
                "platform": change.platform,
                "old_id": change.old_id,
                "new_id": change.new_id,
            }),
        );
    }
}

/// Shared by the engine loop and the LAN Hub (hub.rs): whichever
/// detects a new game — this PC's own scanner or a paired Blipy agent on a
/// second PC — funnels through here for the exact same treatment. Blipy
/// itself never touches metadata or platform pushes (detect-and-forward
/// only); this app is what finds metadata and pushes categories, regardless
/// of which PC the detection came from.
///
/// Upserts a bare Library entry if this title has never been seen, pushes
/// the category to configured platforms, and — if the entry still lacks
/// basic info — fires a background metadata scan that saves + re-pushes
/// status once it resolves, same as a local detection already does.
pub fn on_game_detected(
    base: &std::path::Path,
    config: &AppConfig,
    game_title: &str,
    process: &str,
    state_arc: &Arc<EngineState>,
    app_handle: &tauri::AppHandle,
) {
    let forge_db_path = base.join("Forge_Database.json");
    let forge_db: config::ForgeDatabase = std::fs::read_to_string(&forge_db_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default();

    let health_events = pusher::push_category(base, config, &forge_db, game_title);
    emit_health_events(app_handle, &health_events);

    // Reload fresh rather than reusing the snapshot above, to avoid
    // clobbering a concurrent write from the axum server. Resolve through
    // find_library_key so a title that only differs from an existing entry
    // by case/whitespace (raw OS window titles from the scanner or a paired
    // Blipy agent vary run to run) updates that entry instead of minting a
    // second one.
    let (title, needs_metadata) = match server::load_db() {
        Ok(mut db) => match config::find_library_key(&db, game_title) {
            Some(key) => {
                let needs = db
                    .library
                    .get(&key)
                    .map(|e| e.genre.is_empty() && e.developer.is_empty() && e.cover_url.is_empty())
                    .unwrap_or(false);
                (key, needs)
            }
            None => {
                let title = game_title.trim().to_string();
                db.library.insert(
                    title.clone(),
                    config::ForgeLibraryEntry {
                        title: title.clone(),
                        executables: process.to_string(),
                        ..Default::default()
                    },
                );
                if let Err(e) = server::save_db(&db) {
                    log::warn!("[DETECT] Failed to save new library entry: {}", e);
                }
                (title, true)
            }
        },
        Err(e) => {
            log::warn!("[DETECT] Failed to load Forge DB for library upsert: {}", e);
            (game_title.trim().to_string(), false)
        }
    };

    if !needs_metadata {
        return;
    }

    let keys = config.api_keys.clone();
    let broadcaster = config.broadcaster.clone();
    let state_for_scan = state_arc.clone();
    let app_for_scan = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let (key, existing) = match server::load_db() {
            Ok(db) => match config::find_library_key(&db, &title) {
                Some(key) => {
                    let entry = db.library.get(&key).cloned().unwrap_or_default();
                    (key, entry)
                }
                None => (
                    title.clone(),
                    config::ForgeLibraryEntry {
                        title: title.clone(),
                        ..Default::default()
                    },
                ),
            },
            Err(_) => (
                title.clone(),
                config::ForgeLibraryEntry {
                    title: title.clone(),
                    ..Default::default()
                },
            ),
        };
        let merged = metadata::scan(&title, &keys, &broadcaster, existing).await;
        match server::load_db() {
            Ok(mut db) => {
                db.library.insert(key.clone(), merged);
                if let Err(e) = server::save_db(&db) {
                    log::warn!("[DETECT] Failed to save scanned metadata: {}", e);
                } else {
                    state_for_scan.push_status();
                    let _ = app_for_scan.emit("library-updated", &key);
                }
            }
            Err(e) => log::warn!(
                "[DETECT] Failed to reload Forge DB after metadata scan: {}",
                e
            ),
        }
    });
}

/// Force a game, bypassing the detection waterfall entirely: broadcasts it
/// to Twitch/Kick immediately (via the same `on_game_detected` path normal
/// detection uses — library upsert + metadata scan included), and holds it
/// for 5 minutes so the next detection tick can't immediately overwrite it.
/// Calling this again while an override is already active just resets the
/// 5-minute window against the new title.
#[tauri::command]
fn override_game(
    title: String,
    state: tauri::State<Arc<EngineState>>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("Game name cannot be empty".to_string());
    }
    // Stage 0 alias resolution — typing "DS3" into the override box should
    // land on the same canonical title detection would.
    let title = server::load_db()
        .ok()
        .and_then(|db| config::resolve_title_alias(&db, &title))
        .unwrap_or(title);

    let base = app_base_dir()?;
    let config = auth::load_config_at(&base)?;

    let game = GameDetection {
        title: title.clone(),
        process: "manual-override".to_string(),
        platform: "Manual Override".to_string(),
    };
    state.set_playing(&game);
    let _ = app_handle.emit("game-detected", &game);
    state.push_status();

    on_game_detected(
        &base,
        &config,
        &title,
        &game.process,
        state.inner(),
        &app_handle,
    );

    let expires_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        + 300.0;
    *state.override_until.lock().unwrap() = Some((title.clone(), expires_at));

    Ok(format!(
        "Broadcasting \"{}\" — override active for 5 minutes",
        title
    ))
}

/// Cancel an active manual override early so normal detection resumes on
/// the next tick, instead of waiting out the full 5 minutes.
#[tauri::command]
fn clear_override_game(state: tauri::State<Arc<EngineState>>) -> Result<String, String> {
    *state.override_until.lock().unwrap() = None;
    Ok("Override cleared".to_string())
}

/// Post-broadcast feedback ("Is this detection correct?"). `actual_title`
/// is None for a confirmation; Some(actual game) for a correction. A
/// correction also teaches the alias system — the misdetected title becomes
/// a Detection Alias of the actual game, so the same raw title resolves
/// correctly on every future detection pass. The caller (frontend) follows
/// a correction up with `override_game(actual)` to fix the live broadcast.
#[tauri::command]
fn log_detection_feedback(
    detected_title: String,
    method: String,
    actual_title: Option<String>,
) -> Result<String, String> {
    let base = app_base_dir()?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let detected = detected_title.trim();
    if detected.is_empty() {
        return Err("Detected title cannot be empty".to_string());
    }
    let actual = actual_title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case(detected));

    let mut store = feedback::load(&base);
    store.record(detected, method.trim(), actual, now);
    feedback::save(&base, &store)?;

    if let Some(actual) = actual {
        // Teach the alias system: append the misdetected title to the actual
        // game's Detection Aliases (upsert_library_entry creates the entry if
        // it's new, validates shadowing, and dedupes repeats).
        let mut db = server::load_db()?;
        let existing_names: Vec<String> = config::find_library_key(&db, actual)
            .and_then(|k| db.library.get(&k))
            .map(|e| e.aliases.iter().map(|a| a.name.clone()).collect())
            .unwrap_or_default();
        let alias_csv = existing_names
            .iter()
            .map(String::as_str)
            .chain(std::iter::once(detected))
            .collect::<Vec<_>>()
            .join(", ");
        let body = serde_json::json!({ "title": actual, "aliases": alias_csv });
        match server::upsert_library_entry(&mut db, body.as_object().unwrap()) {
            Ok(_) => server::save_db(&db)?,
            // e.g. the misdetected title IS another real game's title —
            // alias would shadow it, so skip teaching but keep the tally.
            Err(e) => log::warn!("[FEEDBACK] Correction alias not saved: {}", e),
        }
        Ok(format!(
            "Correction saved — \"{}\" will now resolve to \"{}\"",
            detected, actual
        ))
    } else {
        Ok("Detection confirmed".to_string())
    }
}

/// Per-method detection accuracy tallies + recent corrections, for Dev Tools.
#[tauri::command]
fn get_detection_feedback_stats() -> Result<serde_json::Value, String> {
    let base = app_base_dir()?;
    let store = feedback::load(&base);
    serde_json::to_value(&store).map_err(|e| format!("Failed to serialize stats: {}", e))
}

/// Shared implementation behind the `start_engine` command.
fn spawn_engine_loop(
    state_arc: Arc<EngineState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    if state_arc.running.load(Ordering::Relaxed) {
        return Ok("Engine loop already running".to_string());
    }

    state_arc.running.store(true, Ordering::Relaxed);
    let running = state_arc.running.clone();

    std::thread::spawn(move || {
        let log: LogFn = Box::new(|msg: &str, level: &str, _cd: u64| {
            log::info!("[ENGINE] {} {}", level, msg);
        });

        let mut scout = GameDetector::new(log);

        // macOS: window titles need Screen Recording permission. Surface it
        // loudly (the status payload also carries `permission_error`).
        if let Some(err) = scout.permission_error() {
            log::warn!("[ENGINE] {}", err);
        }

        let mut current_game: Option<String> = None;
        let mut lost_focus_time: Option<f64> = None;

        // Load initial config
        let (grace_period, scan_interval, _idle_category) = {
            let base = app_base_dir().unwrap_or_default();
            let config: Option<AppConfig> = std::fs::read_to_string(base.join("Config.json"))
                .ok()
                .and_then(|content| serde_json::from_str(&content).ok());
            (
                config
                    .as_ref()
                    .map(|c| c.engine_settings.grace_period)
                    .unwrap_or(15),
                config
                    .as_ref()
                    .map(|c| c.engine_settings.scan_interval)
                    .unwrap_or(5),
                config
                    .map(|c| c.engine_settings.idle_category)
                    .unwrap_or_else(|| "Just Chatting".to_string()),
            )
        };

        // Initialize status
        {
            let mut game = state_arc.current_game.lock().unwrap();
            *game = None;
            let mut playing = state_arc.is_playing.lock().unwrap();
            *playing = false;
        }

        log::info!(
            "[ENGINE] Engine loop started. Grace: {}s, Interval: {}s",
            grace_period,
            scan_interval
        );

        while running.load(Ordering::Relaxed) {
            // Reload config each iteration. Goes through auth::load_config_at
            // (not a raw file read) so tokens migrated to the OS keychain
            // (migrate_tokens_to_keychain) get backfilled here too — this
            // config is what pusher::push_category/on_game_detected use for
            // the actual Twitch/Kick routing pushes.
            let config = {
                let base = app_base_dir().unwrap_or_default();
                auth::load_config_at(&base).ok()
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

            // Blipy Dual-PC Link active: this PC defers entirely to the
            // paired Blipy agent (see hub.rs) so the two sources never
            // crosswire. Drop any local detection still held and skip
            // scanning this iteration.
            let blipy_link_active = config
                .as_ref()
                .map(|c| c.engine_settings.blipy_link_active)
                .unwrap_or(false);
            if blipy_link_active {
                if current_game.is_some() {
                    log::info!("[ENGINE] Blipy Dual-PC Link active — pausing local detection.");
                    current_game = None;
                    lost_focus_time = None;
                    state_arc.clear_playing();
                    let _ = app_handle.emit("game-cleared", &idle_category);
                    state_arc.push_status();
                }
                std::thread::sleep(Duration::from_secs(scan_interval));
                continue;
            }

            // Active manual override: hold its title and skip detection this
            // tick so the waterfall doesn't overwrite it. Keep current_game
            // in sync so once it expires, detection resumes cleanly.
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64();
            let override_snapshot = state_arc.override_until.lock().unwrap().clone();
            if let Some((override_title, expires_at)) = override_snapshot {
                if now < expires_at {
                    current_game = Some(override_title);
                    lost_focus_time = None;
                    std::thread::sleep(Duration::from_secs(scan_interval));
                    continue;
                } else {
                    *state_arc.override_until.lock().unwrap() = None;
                    log::info!("[ENGINE] Manual override expired: {}", override_title);
                    let _ = app_handle.emit("override-cleared", &override_title);
                }
            }

            // Load full forge DB (listed/delisted for the scanner, library for category push)
            let base = app_base_dir().unwrap_or_default();
            let forge_db_path = base.join("Forge_Database.json");
            let forge_db: config::ForgeDatabase = std::fs::read_to_string(&forge_db_path)
                .ok()
                .and_then(|c| serde_json::from_str(&c).ok())
                .unwrap_or_default();
            let strict = config
                .as_ref()
                .map(|c| c.engine_settings.strict_forge_mode)
                .unwrap_or(false);
            let (listed, delisted) = (forge_db.listed_apps.clone(), forge_db.delisted_apps.clone());

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

            // Stage 0: user-created aliases map a raw detected title to its
            // canonical library title before it reaches state, broadcasting,
            // or the library upsert — so "ダークソウルズ3" or "DS3" becomes
            // "Dark Souls III" everywhere downstream.
            let detected = detected.map(|mut game| {
                if let Some(canonical) = config::resolve_title_alias(&forge_db, &game.title) {
                    log::info!("[ENGINE] Alias: \"{}\" → \"{}\"", game.title, canonical);
                    game.title = canonical;
                }
                game
            });

            if let Some(game) = detected {
                lost_focus_time = None;

                let game_title = game.title.clone();
                if current_game.as_ref() != Some(&game_title) {
                    current_game = Some(game_title.clone());
                    log::info!("[ENGINE] NEW GAME: {} ({})", game_title, game.platform);

                    state_arc.set_playing(&game);

                    // Emit event to frontend + push to WS widgets
                    let _ = app_handle.emit("game-detected", &game);
                    state_arc.push_status();

                    // Category push, Library upsert, and metadata scan —
                    // shared with the LAN Hub so a Blipy-detected game on a
                    // second PC gets identical treatment.
                    if let Some(cfg) = config.as_ref() {
                        on_game_detected(
                            &base,
                            cfg,
                            &game_title,
                            &game.process,
                            &state_arc,
                            &app_handle,
                        );
                    }
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
                        log::info!(
                            "[ENGINE] Grace period expired. Dropping: {}",
                            current_game.as_deref().unwrap_or("?")
                        );
                        current_game = None;
                        lost_focus_time = None;

                        state_arc.clear_playing();

                        let _ = app_handle.emit("game-cleared", &idle_category);
                        state_arc.push_status();

                        // Push the idle category back (no-op unless routing_mode is Native)
                        if let Some(cfg) = config.as_ref() {
                            let health_events =
                                pusher::push_category(&base, cfg, &forge_db, &idle_category);
                            emit_health_events(&app_handle, &health_events);
                        }
                    }
                }
            }

            std::thread::sleep(Duration::from_secs(scan_interval));
        }

        log::info!("[ENGINE] Engine loop stopped.");
    });

    Ok("Engine loop started".to_string())
}

// --- OS Keychain Token Storage ---

pub(crate) const KEYRING_SERVICE: &str = "statusforge.io";

/// Store a secret token in the OS keychain (Windows Credential Manager / macOS Keychain / Linux Secret Service).
#[tauri::command]
fn store_secret_token(service_name: String, token: String) -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &service_name)
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
    entry
        .set_password(&token)
        .map_err(|e| format!("Failed to store token in keychain: {}", e))?;
    Ok(format!("Token '{}' stored in OS keychain", service_name))
}

/// Retrieve a secret token from the OS keychain.
#[tauri::command]
fn get_secret_token(service_name: String) -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &service_name)
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
    let token = entry
        .get_password()
        .map_err(|e| format!("Failed to retrieve token from keychain: {}", e))?;
    Ok(token)
}

/// Delete a secret token from the OS keychain.
#[tauri::command]
fn delete_secret_token(service_name: String) -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &service_name)
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
    entry
        .delete_credential()
        .map_err(|e| format!("Failed to delete token from keychain: {}", e))?;
    Ok(format!("Token '{}' deleted from OS keychain", service_name))
}

/// Disconnect a platform: delete its OAuth secrets from the OS keychain and
/// clear them from Config.json. The old "Remove" button only cleared the
/// config fields, so the keychain still had the token and load_config_at
/// just backfilled it right back in on next launch. This actually deletes it.
#[tauri::command]
fn disconnect_platform(platform: String) -> Result<String, String> {
    let keychain_names: &[&str] = match platform.as_str() {
        "twitch" => &[
            "twitch_access_token",
            "twitch_refresh_token",
            "twitch_client_secret",
        ],
        "kick" => &[
            "kick_access_token",
            "kick_refresh_token",
            "kick_client_secret",
        ],
        _ => return Err(format!("Unknown platform: {}", platform)),
    };
    for name in keychain_names {
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, name) {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(e) => log::warn!("[KEYCHAIN] Failed to delete {} on disconnect: {}", name, e),
            }
        }
    }

    let base = app_base_dir()?;
    let mut config = auth::load_config_at(&base).unwrap_or_default();
    match platform.as_str() {
        "twitch" => {
            config.broadcaster.twitch_token.clear();
            config.broadcaster.twitch_refresh.clear();
            config.broadcaster.twitch_secret.clear();
        }
        "kick" => {
            config.broadcaster.kick_token.clear();
            config.broadcaster.kick_refresh.clear();
            config.broadcaster.kick_secret.clear();
        }
        _ => unreachable!("validated above"),
    }
    auth::save_config_at(&base, &config)?;

    Ok(format!("{} disconnected", platform))
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
    let mut config: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))?;

    let broadcaster = config
        .get_mut("broadcaster")
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
                let entry = keyring::Entry::new(KEYRING_SERVICE, keychain_name).map_err(|e| {
                    format!(
                        "Failed to create keyring entry for {}: {}",
                        keychain_name, e
                    )
                })?;
                entry
                    .set_password(val)
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
                    let entry =
                        keyring::Entry::new(KEYRING_SERVICE, keychain_name).map_err(|e| {
                            format!(
                                "Failed to create keyring entry for {}: {}",
                                keychain_name, e
                            )
                        })?;
                    entry
                        .set_password(val)
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
    std::fs::write(
        &config_path,
        serde_json::to_string_pretty(&config)
            .map_err(|e| format!("Failed to serialize config: {}", e))?,
    )
    .map_err(|e| format!("Failed to write config: {}", e))?;

    Ok(migrated)
}

/// Retrieve all keychain-stored tokens as a JSON object, keyed by the same
/// app-facing names the frontend/config use (`twitch_token`, `kick_token`,
/// …). The actual OS keyring entries are stored under different names
/// (`twitch_access_token`, `kick_access_token`, …) — see
/// `migrate_tokens_to_keychain` and `auth::backfill_from_keychain`, which
/// this must stay in sync with. Called by the frontend so API keys never
/// need to live in Config.json.
#[tauri::command]
fn get_all_keychain_tokens() -> Result<serde_json::Value, String> {
    // (app-facing key, actual keyring entry name)
    let broadcaster_keys = [
        ("twitch_token", "twitch_access_token"),
        ("twitch_refresh", "twitch_refresh_token"),
        ("kick_token", "kick_access_token"),
        ("kick_refresh", "kick_refresh_token"),
        ("twitch_secret", "twitch_client_secret"),
        ("kick_secret", "kick_client_secret"),
    ];
    let api_keys = [
        ("igdb_token", "igdb_api_token"),
        ("igdb_secret", "igdb_api_secret"),
        ("rawg", "rawg_api_key"),
        ("steamgrid", "steamgrid_api_key"),
    ];

    let mut map = serde_json::Map::new();
    for (app_key, keychain_name) in broadcaster_keys.iter().chain(api_keys.iter()) {
        let entry = keyring::Entry::new(KEYRING_SERVICE, keychain_name);
        if let Ok(e) = entry {
            if let Ok(val) = e.get_password() {
                if !val.is_empty() {
                    map.insert(app_key.to_string(), serde_json::json!(val));
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
    let config: AppConfig =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))?;

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

    // Open system browser. tauri-plugin-shell's open() is deprecated in favor
    // of tauri-plugin-opener; deferring that migration (new dependency +
    // capability/permission changes) rather than folding it into this change.
    #[allow(deprecated)]
    {
        use tauri_plugin_shell::ShellExt;
        app.shell()
            .open(&url, None)
            .map_err(|e| format!("Failed to open browser: {}", e))?;
    }

    Ok("Kick OAuth flow initiated — check your browser".to_string())
}

/// Initiate Twitch OAuth login.
/// Opens the system browser, waits for the callback.
#[tauri::command]
async fn twitch_login(
    app: tauri::AppHandle,
    state: tauri::State<'_, auth::SharedOAuthState>,
) -> Result<String, String> {
    let base_dir = app_base_dir()?;
    let config_path = base_dir.join("Config.json");
    let content = tokio::fs::read_to_string(&config_path)
        .await
        .map_err(|e| format!("Failed to read config: {}", e))?;
    let config: AppConfig =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))?;

    let client_id = &config.broadcaster.twitch_client;
    if client_id.is_empty() {
        return Err("Twitch client ID not configured".to_string());
    }

    let verifier = auth::generate_code_verifier();
    let challenge = auth::generate_code_challenge(&verifier);
    let state_token = auth::generate_code_verifier(); // reuse CSPRNG for state
    {
        let mut pkce = state.pkce.lock().unwrap();
        pkce.insert(
            "twitch".to_string(),
            auth::PkceState {
                verifier,
                state: state_token.clone(),
            },
        );
    }

    let url = auth::build_twitch_auth_url(client_id, &state_token, &challenge);

    #[allow(deprecated)]
    {
        use tauri_plugin_shell::ShellExt;
        app.shell()
            .open(&url, None)
            .map_err(|e| format!("Failed to open browser: {}", e))?;
    }

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

/// Validates a manually-pasted Kick access token (the "alternate to Connect
/// Kick" path) and backfills kick_channel_id from the connected channel's
/// slug. Returns the connected user's display name for a success toast.
#[tauri::command]
async fn kick_validate_token() -> Result<String, String> {
    let base_dir = app_base_dir()?;
    let config = auth::load_config_at(&base_dir)?;
    let token = config.broadcaster.kick_token.clone();
    if token.is_empty() {
        return Err("No Kick access token to validate".to_string());
    }
    let (name, slug) = auth::validate_kick_token(&token).await?;
    if !slug.is_empty() {
        let mut updated = config;
        updated.broadcaster.kick_channel_id = slug;
        auth::save_config_at(&base_dir, &updated)?;
    }
    Ok(name)
}

/// Validates a manually-pasted Twitch access token (the "alternate to
/// Connect Twitch" path) and backfills twitch_broadcaster_id, which
/// pusher.rs requires alongside the token for category pushes to work.
/// Returns the connected user's display name for a success toast.
#[tauri::command]
async fn twitch_validate_token() -> Result<String, String> {
    let base_dir = app_base_dir()?;
    let config = auth::load_config_at(&base_dir)?;
    let token = config.broadcaster.twitch_token.clone();
    let client_id = config.broadcaster.twitch_client.clone();
    if token.is_empty() {
        return Err("No Twitch access token to validate".to_string());
    }
    if client_id.is_empty() {
        return Err("Twitch Client ID is required to validate a token".to_string());
    }
    let (name, broadcaster_id) = auth::validate_twitch_token(&token, &client_id).await?;
    let mut updated = config;
    updated.broadcaster.twitch_broadcaster_id = broadcaster_id;
    auth::save_config_at(&base_dir, &updated)?;
    Ok(name)
}

const REAUTH_ATTEMPT_COOLDOWN_SECS: u64 = 300;
static LAST_TWITCH_REAUTH_ATTEMPT_SECS: AtomicU64 = AtomicU64::new(0);
static LAST_KICK_REAUTH_ATTEMPT_SECS: AtomicU64 = AtomicU64::new(0);
static TWITCH_NEEDS_REAUTH: AtomicBool = AtomicBool::new(false);
static KICK_NEEDS_REAUTH: AtomicBool = AtomicBool::new(false);

/// True (and records the attempt) once per cooldown window — a genuinely
/// dead refresh token shouldn't get hammered on every 10s Dashboard poll.
fn reauth_cooldown_elapsed(last: &AtomicU64) -> bool {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if now.saturating_sub(last.load(Ordering::Relaxed)) < REAUTH_ATTEMPT_COOLDOWN_SECS {
        return false;
    }
    last.store(now, Ordering::Relaxed);
    true
}

/// Validates the stored Twitch token; on failure, tries one silent refresh
/// (same recovery pusher.rs already does on a 401 during a push) before
/// giving up. Returns (live, needs_reauth). needs_reauth latches true once a
/// refresh attempt has actually been made and failed — meaning the refresh
/// token itself is dead, not just the short-lived access token — and stays
/// true across cooldown-gated polls until either a refresh succeeds or the
/// user reconnects (whichever happens first makes a live check succeed,
/// which always clears it immediately).
async fn check_twitch_live(base_dir: &std::path::Path, config: &AppConfig) -> (bool, bool) {
    if config.broadcaster.twitch_token.is_empty() || config.broadcaster.twitch_client.is_empty() {
        TWITCH_NEEDS_REAUTH.store(false, Ordering::Relaxed);
        return (false, false);
    }
    if auth::validate_twitch_token(
        &config.broadcaster.twitch_token,
        &config.broadcaster.twitch_client,
    )
    .await
    .is_ok()
    {
        TWITCH_NEEDS_REAUTH.store(false, Ordering::Relaxed);
        return (true, false);
    }
    if reauth_cooldown_elapsed(&LAST_TWITCH_REAUTH_ATTEMPT_SECS) {
        let cfg = config.clone();
        let refreshed = tokio::task::spawn_blocking(move || auth::refresh_twitch_token(&cfg)).await;
        if let Ok(Ok(new_token)) = refreshed {
            let mut updated = config.clone();
            updated.broadcaster.twitch_token = new_token.clone();
            if let Err(e) = auth::save_config_at(base_dir, &updated) {
                log::warn!(
                    "[LIVE-CHECK] Failed to persist refreshed Twitch token: {}",
                    e
                );
            }
            let live = auth::validate_twitch_token(&new_token, &config.broadcaster.twitch_client)
                .await
                .is_ok();
            TWITCH_NEEDS_REAUTH.store(!live, Ordering::Relaxed);
            return (live, !live);
        }
        TWITCH_NEEDS_REAUTH.store(true, Ordering::Relaxed);
        return (false, true);
    }
    (false, TWITCH_NEEDS_REAUTH.load(Ordering::Relaxed))
}

/// Kick counterpart of `check_twitch_live` — same refresh-then-latch shape.
async fn check_kick_live(base_dir: &std::path::Path, config: &AppConfig) -> (bool, bool) {
    if config.broadcaster.kick_token.is_empty() {
        KICK_NEEDS_REAUTH.store(false, Ordering::Relaxed);
        return (false, false);
    }
    if auth::validate_kick_token(&config.broadcaster.kick_token)
        .await
        .is_ok()
    {
        KICK_NEEDS_REAUTH.store(false, Ordering::Relaxed);
        return (true, false);
    }
    if reauth_cooldown_elapsed(&LAST_KICK_REAUTH_ATTEMPT_SECS) {
        let cfg = config.clone();
        let refreshed = tokio::task::spawn_blocking(move || auth::refresh_kick_token(&cfg)).await;
        if let Ok(Ok(new_token)) = refreshed {
            let mut updated = config.clone();
            updated.broadcaster.kick_token = new_token.clone();
            if let Err(e) = auth::save_config_at(base_dir, &updated) {
                log::warn!("[LIVE-CHECK] Failed to persist refreshed Kick token: {}", e);
            }
            let live = auth::validate_kick_token(&new_token).await.is_ok();
            KICK_NEEDS_REAUTH.store(!live, Ordering::Relaxed);
            return (live, !live);
        }
        KICK_NEEDS_REAUTH.store(true, Ordering::Relaxed);
        return (false, true);
    }
    (false, KICK_NEEDS_REAUTH.load(Ordering::Relaxed))
}

/// Checks whether the stored Twitch/Kick tokens still actually work, trying
/// a silent refresh first if not (see `check_twitch_live`/`check_kick_live`)
/// — so a merely-expired access token self-heals with no user action, and
/// `*_needs_reauth` only fires once that recovery has genuinely failed. Safe
/// to poll from the Dashboard's "Platform Connections" panel: refresh
/// attempts are cooldown-limited, and a successful refresh is the only case
/// that writes back to Config.json.
#[tauri::command]
async fn check_platform_live_status() -> serde_json::Value {
    let empty = || {
        serde_json::json!({
            "twitch": false, "twitch_needs_reauth": false,
            "kick": false, "kick_needs_reauth": false,
            "sbot": false,
        })
    };
    let Ok(base_dir) = app_base_dir() else {
        return empty();
    };
    let Ok(config) = auth::load_config_at(&base_dir) else {
        return empty();
    };

    let (twitch_live, twitch_needs_reauth) = check_twitch_live(&base_dir, &config).await;
    let (kick_live, kick_needs_reauth) = check_kick_live(&base_dir, &config).await;

    // Streamer.bot isn't pushed to directly — push_category no-ops in this
    // routing mode, since Streamer.bot is expected to pull game state from
    // StatusForge itself rather than receive a push — so there's no
    // request/response to validate like Twitch/Kick get. The best available
    // signal is whether anything is listening on the configured local port.
    let sbot_live = if config.broadcaster.routing_mode == config::RoutingMode::StreamerBot {
        let addr = format!("127.0.0.1:{}", config.engine_settings.sb_port);
        tokio::time::timeout(
            std::time::Duration::from_millis(500),
            tokio::net::TcpStream::connect(&addr),
        )
        .await
        .map(|r| r.is_ok())
        .unwrap_or(false)
    } else {
        false
    };

    serde_json::json!({
        "twitch": twitch_live, "twitch_needs_reauth": twitch_needs_reauth,
        "kick": kick_live, "kick_needs_reauth": kick_needs_reauth,
        "sbot": sbot_live,
    })
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

/// Manually trigger the weekly library sync (Twitch/Kick category id
/// re-check + sync_history pruning) instead of waiting for the periodic loop.
#[tauri::command]
async fn sync_library_now(app_handle: tauri::AppHandle) -> Result<String, String> {
    run_weekly_library_sync(&app_handle).await;
    Ok("Library synced".to_string())
}

/// Rotate widget token (Security Audit #5). Returns the new token.
#[tauri::command]
fn rotate_widget_token() -> Result<String, String> {
    let base_dir = app_base_dir()?;
    auth::rotate_widget_token(&base_dir)
}

/// Exile a game: drop it from the library and delist its lowercase title so
/// the scanner ignores it. Used by the Dashboard "Exile to Apps" button.
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

/// Mirror a frontend toast into the debug log so the Dev Tools terminal shows
/// exactly what the user saw on screen (same success/info/error text), instead
/// of toasts vanishing after their 3.5s on-screen lifetime with no record.
#[tauri::command]
fn log_frontend_toast(message: String, level: String) -> Result<(), String> {
    match level.as_str() {
        "error" => log::error!("[TOAST] {}", message),
        "success" => log::info!("[TOAST] ✓ {}", message),
        _ => log::info!("[TOAST] {}", message),
    }
    Ok(())
}

/// Write the Dev Tools "Export Errors" content to a fixed, discoverable
/// location (`Documents/StatusForge Logs/`) instead of leaving it to whatever
/// the browser-style download default happens to be. Returns the full path
/// written so the UI can show the user exactly where it landed.
#[tauri::command]
fn dev_export_error_log(app: tauri::AppHandle, content: String) -> Result<String, String> {
    let docs = app
        .path()
        .document_dir()
        .map_err(|e| format!("Failed to resolve Documents folder: {}", e))?;
    let dir = docs.join("StatusForge Logs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create log folder: {}", e))?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let path = dir.join(format!("statusforge_errors_{}.log", timestamp));
    std::fs::write(&path, content).map_err(|e| format!("Failed to write log file: {}", e))?;

    Ok(path.to_string_lossy().to_string())
}

/// Write the full Forge_Database.json (scraped game metadata) to
/// `Documents/StatusForge Logs/` as a timestamped, pretty-printed copy.
/// Returns the full path written so the UI can show the user where it landed.
#[tauri::command]
fn export_game_database(app: tauri::AppHandle) -> Result<String, String> {
    let db = server::load_db()?;
    let docs = app
        .path()
        .document_dir()
        .map_err(|e| format!("Failed to resolve Documents folder: {}", e))?;
    let dir = docs.join("StatusForge Logs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create export folder: {}", e))?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let path = dir.join(format!("statusforge_database_{}.json", timestamp));
    let raw = serde_json::to_string_pretty(&db)
        .map_err(|e| format!("Failed to serialize database: {}", e))?;
    std::fs::write(&path, raw).map_err(|e| format!("Failed to write export file: {}", e))?;

    Ok(path.to_string_lossy().to_string())
}

/// Re-push the currently active game's category. Toggling Platform Detection
/// off leaves the last-pushed category on Twitch/Kick untouched (no revert)
/// so viewers don't see it flicker; toggling back on doesn't wait for the
/// player to switch games again — call this right after flipping the toggle
/// so the platform picks up the in-progress session immediately.
#[tauri::command]
fn refresh_platform_push(
    state: tauri::State<Arc<EngineState>>,
    app_handle: tauri::AppHandle,
) -> Result<bool, String> {
    let game = state.current_game.lock().unwrap().clone();
    let Some(game) = game else {
        return Ok(false);
    };
    let base = app_base_dir()?;
    let config = auth::load_config_at(&base)?;
    if !config.engine_settings.platform_push_enabled {
        return Ok(false);
    }
    let forge_db = server::load_db()?;
    let health_events = pusher::push_category(&base, &config, &forge_db, &game.title);
    emit_health_events(&app_handle, &health_events);
    Ok(true)
}

/// Generate a Markdown table listing every scraped game's metadata, suitable
/// for pasting into a GitHub repo's README as a public library index. Written
/// locally only — no git credentials touch this, the user pushes it
/// themselves.
#[tauri::command]
fn export_metadata_readme(app: tauri::AppHandle) -> Result<String, String> {
    let db = server::load_db()?;
    let mut entries: Vec<&config::ForgeLibraryEntry> = db.library.values().collect();
    entries.sort_by_key(|e| e.title.to_lowercase());

    let mut md = String::new();
    md.push_str("# StatusForge Game Library\n\n");
    md.push_str(&format!(
        "Scraped metadata for {} game{} tracked by StatusForge.\n\n",
        entries.len(),
        if entries.len() == 1 { "" } else { "s" }
    ));
    md.push_str("| Cover | Title | Genre | Year | Developer | Publisher |\n");
    md.push_str("|---|---|---|---|---|---|\n");
    for e in &entries {
        let cover = if e.cover_url.is_empty() {
            String::new()
        } else {
            format!("![]({})", e.cover_url)
        };
        md.push_str(&format!(
            "| {} | {} | {} | {} | {} | {} |\n",
            cover,
            md_escape(&e.title),
            md_escape(&e.genre),
            md_escape(&e.release_year),
            md_escape(&e.developer),
            md_escape(&e.publisher),
        ));
    }

    let docs = app
        .path()
        .document_dir()
        .map_err(|e| format!("Failed to resolve Documents folder: {}", e))?;
    let dir = docs.join("StatusForge Logs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create export folder: {}", e))?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let path = dir.join(format!("statusforge_library_{}.md", timestamp));
    std::fs::write(&path, md).map_err(|e| format!("Failed to write README file: {}", e))?;

    Ok(path.to_string_lossy().to_string())
}

/// Escape pipe characters so a title/genre/etc. containing `|` doesn't break
/// the Markdown table's column boundaries.
fn md_escape(s: &str) -> String {
    s.replace('|', "\\|")
}

#[derive(serde::Serialize)]
struct LogTail {
    lines: Vec<String>,
    /// Total line count in the file right now. The Dev Tools "Clear" button
    /// records this and only shows lines past it on later fetches — content
    /// matching doesn't work here since the log is full of exact-duplicate
    /// lines (e.g. "RAM floor not met" every scan tick).
    total_lines: usize,
}

/// Read the last N lines of the debug log file, plus the file's total line
/// count (see `LogTail::total_lines`).
#[tauri::command]
fn dev_get_log_tail(lines: usize) -> Result<LogTail, String> {
    let base = app_base_dir()?;
    let log_path = base.join("debug.log");
    if !log_path.exists() {
        return Ok(LogTail {
            lines: vec!["[no log file found]".to_string()],
            total_lines: 0,
        });
    }
    let content =
        std::fs::read_to_string(&log_path).map_err(|e| format!("Failed to read log: {}", e))?;
    let all_lines: Vec<&str> = content.lines().collect();
    let total_lines = all_lines.len();
    let start = total_lines.saturating_sub(lines);
    Ok(LogTail {
        lines: all_lines[start..].iter().map(|l| l.to_string()).collect(),
        total_lines,
    })
}

/// Get dev diagnostics: platform, engine status, hub pairing.
#[tauri::command]
fn dev_get_diagnostics(
    state: tauri::State<Arc<EngineState>>,
    hub: tauri::State<Arc<hub::HubState>>,
) -> serde_json::Value {
    serde_json::json!({
        "platform": get_platform(),
        "engine_running": state.running.load(Ordering::Relaxed),
        "current_game": state.current_game.lock().unwrap().clone(),
        "current_process": state.current_process.lock().unwrap().clone(),
        "is_playing": *state.is_playing.lock().unwrap(),
        "hub_paired_blipy": hub.paired.lock().unwrap().clone(),
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
// System prefs backends — log level, webhook relay (frontend System tab)
// ═══════════════════════════════════════════════════════════════════════════════

/// Runtime log verbosity. The log plugin is built at Debug; this moves the
/// global `log` facade filter, so it applies immediately without a restart.
#[tauri::command]
fn set_log_level(level: String) -> Result<(), String> {
    let filter = match level.as_str() {
        "error" => log::LevelFilter::Error,
        "warn" => log::LevelFilter::Warn,
        "info" => log::LevelFilter::Info,
        "debug" => log::LevelFilter::Debug,
        other => return Err(format!("Unknown log level: {}", other)),
    };
    log::set_max_level(filter);
    Ok(())
}

/// Rejects webhook targets that resolve to loopback, private, or
/// link-local addresses so a malicious/compromised webhook URL (e.g. from
/// an imported config) can't be used to probe the user's LAN or local
/// services (SSRF). Users legitimately configuring `localhost` webhooks for
/// their own tooling are the one case this deliberately still blocks; the
/// security benefit of a strict allowlist outweighs that niche use.
fn is_safe_webhook_host(host: &str) -> bool {
    use std::net::ToSocketAddrs;

    // Bracket bare IPv6 literals so ToSocketAddrs can parse "host:port".
    let lookup = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:0")
    } else {
        format!("{host}:0")
    };

    match lookup.to_socket_addrs() {
        Ok(addrs) => addrs.map(|a| a.ip()).all(|ip| match ip {
            std::net::IpAddr::V4(v4) => {
                !(v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || v4.is_unspecified()
                    || v4.is_broadcast())
            }
            std::net::IpAddr::V6(v6) => {
                !(v6.is_loopback() || v6.is_unspecified() || v6.is_unique_local())
            }
        }),
        // Unresolvable host — fail closed rather than let reqwest attempt it.
        Err(_) => false,
    }
}

/// Relay a small JSON event to a user-configured webhook. Lives in Rust
/// because the webview CSP blocks arbitrary outbound fetches.
#[tauri::command]
async fn post_webhook(
    url: String,
    event: String,
    title: String,
    platform: Option<String>,
) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Webhook URL must be http(s)".to_string());
    }
    let parsed = url::Url::parse(&url).map_err(|e| format!("Invalid webhook URL: {}", e))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "Webhook URL must have a host".to_string())?;
    if !is_safe_webhook_host(host) {
        return Err(
            "Webhook URL must not point to a loopback, private, or link-local address".to_string(),
        );
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    client
        .post(&url)
        .json(&serde_json::json!({
            "event": event,
            "title": title,
            "platform": platform,
        }))
        .send()
        .await
        .map_err(|e| format!("Webhook POST failed: {}", e))?;
    Ok(())
}

/// System tray: Show / Quit. Whether closing the window hides to tray is
/// decided in the frontend (minimizeToTray pref) via onCloseRequested.
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    fn show_main(app: &tauri::AppHandle) {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }

    let show = MenuItem::with_id(app, "show", "Show StatusForge", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("StatusForge.io")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════════
// Entry Point
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let oauth_state = Arc::new(auth::OAuthState::new());
    let engine_state = Arc::new(EngineState::default());
    let hub_state = Arc::new(hub::HubState::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
        .manage(oauth_state.clone())
        .manage(engine_state.clone())
        .manage(hub_state.clone())
        .manage(SystemMonitor::new())
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
                    // Debug ceiling; the effective level is the `log` facade
                    // filter, adjusted at runtime by set_log_level (System tab).
                    .level(log::LevelFilter::Debug)
                    // Bound disk usage so debug.log can never grow forever even
                    // if a user never hits "Clear" in Dev Tools — but keep the
                    // cap generous (well past the plugin's tiny 40KB default,
                    // which would silently drop history within an hour or two
                    // of the periodic scan-filter noise). 5MB per file, current
                    // + 2 archived = ~15MB worst case, plenty of history for a
                    // desktop app's debug log.
                    .max_file_size(5 * 1024 * 1024)
                    .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                    .build(),
            ) {
                eprintln!("Failed to init log plugin: {}", e);
            }
            log::set_max_level(log::LevelFilter::Info);

            // System tray (Show / Quit + close-to-tray target)
            if let Err(e) = setup_tray(app) {
                log::warn!("Failed to set up system tray: {}", e);
            }

            // Give the idle category (e.g. "Just Chatting") a real Library
            // entry on first run so it shows up in the Library editor and
            // users can set a custom cover for it, same as any detected
            // game — instead of only ever existing as a config string.
            if let Ok(base) = app_base_dir() {
                ensure_idle_library_entry(&base);
            }

            // LAN Hub: announce on udp/53736, receive Blipy heartbeats on udp/53735
            hub::start_hub(
                hub_state.clone(),
                engine_state.clone(),
                app.handle().clone(),
            );

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

            // Every 30s, retry any platform marked down (pusher's
            // HealthTracker) by re-pushing its queued detection. Plain
            // std::thread since pusher uses blocking reqwest.
            let health_app_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(30));
                if !pusher::any_platform_down() {
                    continue;
                }
                let Ok(base) = app_base_dir() else { continue };
                let Ok(config) = auth::load_config_at(&base) else {
                    continue;
                };
                let db = server::load_db().unwrap_or_default();
                let events = pusher::retry_pending(&base, &config, &db);
                emit_health_events(&health_app_handle, &events);
            });

            // Periodic Kick category database refresh. Kick's category list
            // churns (renamed/added/removed) more than a typical metadata
            // source, so the one-time sync at OAuth-connect time (or a
            // manually-triggered one) goes stale over a long-running
            // session. Runs on a fixed interval for as long as a Kick token
            // is configured; silently skipped otherwise (no error spam for
            // users who don't use Kick).
            tauri::async_runtime::spawn(async move {
                const SYNC_INTERVAL: std::time::Duration =
                    std::time::Duration::from_secs(12 * 60 * 60);
                // Give the app a moment to finish starting before the first sync.
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                loop {
                    if let Ok(base_dir) = app_base_dir() {
                        if let Ok(config) = auth::load_config_at(&base_dir) {
                            let token = config.broadcaster.kick_token;
                            if !token.is_empty() {
                                match auth::sync_kick_database(&token, &base_dir).await {
                                    Ok(()) => {
                                        log::info!(
                                            "[KICK] Periodic category database sync succeeded"
                                        )
                                    }
                                    Err(e) => log::warn!(
                                        "[KICK] Periodic category database sync failed: {}",
                                        e
                                    ),
                                }
                            }
                        }
                    }
                    tokio::time::sleep(SYNC_INTERVAL).await;
                }
            });

            // Weekly library sync: re-checks each library entry's Twitch/Kick
            // category id against the live lookup (a rename/re-issue on
            // their end would otherwise leave a broadcast silently targeting
            // a stale id) and prunes each entry's sync_history down to the
            // last 7 days. See metadata::weekly_library_sync.
            let sync_app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                const SYNC_INTERVAL: std::time::Duration =
                    std::time::Duration::from_secs(7 * 24 * 60 * 60);
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                loop {
                    run_weekly_library_sync(&sync_app_handle).await;
                    tokio::time::sleep(SYNC_INTERVAL).await;
                }
            });

            // Prime the CPU-usage baseline now, not on the frontend's first
            // poll — see SystemMonitor's doc comment for why.
            app.state::<SystemMonitor>().prime();

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
            disconnect_platform,
            migrate_tokens_to_keychain,
            get_all_keychain_tokens,
            hub::hub_get_status,
            hub::hub_set_pin,
            hub::hub_set_pairing_key,
            override_game,
            clear_override_game,
            log_detection_feedback,
            get_detection_feedback_stats,
            kick_login,
            twitch_login,
            kick_refresh_token,
            twitch_refresh_token,
            kick_validate_token,
            twitch_validate_token,
            check_platform_live_status,
            sync_kick_db,
            sync_library_now,
            rotate_widget_token,
            exile_app,
            dev_get_log_tail,
            dev_get_diagnostics,
            get_autostart,
            set_autostart,
            set_log_level,
            post_webhook,
            get_system_stats,
            log_frontend_toast,
            dev_export_error_log,
            export_game_database,
            export_metadata_readme,
            refresh_platform_push,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod config_command_tests {
    use super::*;

    /// End-to-end persistence check through the real Tauri command functions:
    /// import_config sanitizes + validates + writes Config.json atomically,
    /// export_config reads the same values back.
    #[test]
    fn import_then_export_round_trips_settings() {
        let dir = std::env::temp_dir().join(format!("sf-config-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = std::fs::canonicalize(&dir).unwrap();
        let _ = APP_BASE_DIR.set(dir);
        let base = APP_BASE_DIR.get().unwrap().clone();

        let mut config = config::AppConfig::default();
        config.engine_settings.widget_poll_rate = 4;
        config.engine_settings.idle_category = "Art".into();
        config.engine_settings.blipy_pin = "12".into(); // half-typed → sanitized to 0000
        config.api_keys.rawg = "rawg-key".into();
        config.broadcaster.routing_mode = config::RoutingMode::Native;
        config.broadcaster.twitch_client = "twitch-only".into(); // kick empty must still save

        let msg = import_config(ConfigImportPayload {
            config,
            path: None,
            backup: None,
        })
        .unwrap();
        assert_eq!(msg, "Config saved successfully");
        assert!(base.join("Config.json").exists());

        let out = export_config(Some(ConfigExportPayload { path: None })).unwrap();
        let es = &out["engine_settings"];
        assert_eq!(es["widget_poll_rate"], 4);
        assert_eq!(es["idle_category"], "Art");
        assert_eq!(es["blipy_pin"], "0000");
        assert_eq!(out["api_keys"]["rawg"], "rawg-key");
        assert_eq!(out["broadcaster"]["routing_mode"], "native");
        assert_eq!(out["broadcaster"]["twitch_client"], "twitch-only");

        let _ = std::fs::remove_dir_all(&base);
    }
}
