//! Typed configuration structures with validation for StatusForge.io
//!
//! Replaces the untyped `serde_json::Value` approach with proper Rust structs
//! that validate all fields on import/export.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Top-level configuration container
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppConfig {
    #[serde(default)]
    pub api_keys: ApiKeys,
    #[serde(default)]
    pub engine_settings: EngineSettings,
    #[serde(default)]
    pub broadcaster: BroadcasterConfig,
    #[serde(default)]
    pub detection: DetectionConfig,
}

/// API keys for external services
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApiKeys {
    #[serde(default)]
    pub steamgrid: String,
    #[serde(default)]
    pub rawg: String,
    #[serde(default)]
    pub igdb_client: String,
    #[serde(default)]
    pub igdb_secret: String,
    #[serde(default)]
    pub igdb_token: String,
}

/// Engine/runtime settings
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineSettings {
    #[serde(default = "default_idle_category")]
    pub idle_category: String,
    #[serde(default = "default_sb_port")]
    pub sb_port: u16,
    #[serde(default = "default_scan_interval")]
    pub scan_interval: u64,
    #[serde(default = "default_grace_period")]
    pub grace_period: u64,
    #[serde(default = "default_widget_poll_rate")]
    pub widget_poll_rate: u64,
    #[serde(default)]
    pub safe_mode: bool,
    #[serde(default)]
    pub auto_push: bool,
    #[serde(default = "default_widget_fade_timer")]
    pub widget_fade_timer: u64,
    #[serde(default)]
    pub strict_forge_mode: bool,
    #[serde(default = "default_sb_action_name")]
    pub sb_action_name: String,
    #[serde(default = "default_widget_token")]
    pub widget_token: String,
    #[serde(default = "default_detection_mode")]
    pub detection_mode: DetectionMode,
    #[serde(default = "default_spark_pin")]
    pub spark_pin: String,
    #[serde(default = "default_emulator_detection")]
    pub emulator_detection: bool,
    #[serde(default = "default_ram_threshold")]
    pub ram_threshold: u64,
    #[serde(default)]
    pub process_filter_bypass: bool,
    #[serde(default = "default_confidence_threshold")]
    pub confidence_threshold: f64,
    #[serde(default = "default_trap_chromium")]
    pub trap_chromium: bool,
    #[serde(default = "default_trap_cmdline")]
    pub trap_cmdline: bool,
    #[serde(default = "default_trap_ui_framework")]
    pub trap_ui_framework: bool,
    #[serde(default = "default_trap_geometry")]
    pub trap_geometry: bool,
    #[serde(default = "default_score_engine_dna")]
    pub score_engine_dna: bool,
    #[serde(default = "default_score_fullscreen")]
    pub score_fullscreen: bool,
    #[serde(default = "default_score_window_title")]
    pub score_window_title: bool,
    #[serde(default = "default_score_ram")]
    pub score_ram: bool,
}

impl Default for EngineSettings {
    fn default() -> Self {
        Self {
            idle_category: default_idle_category(),
            sb_port: default_sb_port(),
            scan_interval: default_scan_interval(),
            grace_period: default_grace_period(),
            widget_poll_rate: default_widget_poll_rate(),
            safe_mode: false,
            auto_push: false,
            widget_fade_timer: default_widget_fade_timer(),
            strict_forge_mode: false,
            sb_action_name: default_sb_action_name(),
            widget_token: default_widget_token(),
            detection_mode: default_detection_mode(),
            spark_pin: default_spark_pin(),
            emulator_detection: default_emulator_detection(),
            ram_threshold: default_ram_threshold(),
            process_filter_bypass: false,
            confidence_threshold: default_confidence_threshold(),
            trap_chromium: default_trap_chromium(),
            trap_cmdline: default_trap_cmdline(),
            trap_ui_framework: default_trap_ui_framework(),
            trap_geometry: default_trap_geometry(),
            score_engine_dna: default_score_engine_dna(),
            score_fullscreen: default_score_fullscreen(),
            score_window_title: default_score_window_title(),
            score_ram: default_score_ram(),
        }
    }
}

/// Detection mode: Python (legacy), Native (Rust), or Spark (dual-PC)
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum DetectionMode {
    #[default]
    Python,
    Native,
    Spark,
}

/// Detection configuration with experimental toggle
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DetectionConfig {
    #[serde(default)]
    pub mode: DetectionMode,
    #[serde(default = "default_python_fallback")]
    pub python_fallback: bool,
    #[serde(default = "default_scan_interval")]
    pub scan_interval_secs: u64,
    #[serde(default)]
    pub dev_tools_enabled: bool,
    #[serde(default)]
    pub closed_beta_channel: bool,
}

impl Default for DetectionConfig {
    fn default() -> Self {
        Self {
            mode: DetectionMode::default(),
            python_fallback: default_python_fallback(),
            scan_interval_secs: default_scan_interval(),
            dev_tools_enabled: false,
            closed_beta_channel: false,
        }
    }
}

/// Broadcaster/platform configuration
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BroadcasterConfig {
    #[serde(default = "default_routing_mode")]
    pub routing_mode: RoutingMode,
    #[serde(default)]
    pub twitch_client: String,
    #[serde(default)]
    pub twitch_secret: String,
    #[serde(default)]
    pub twitch_token: String,
    #[serde(default)]
    pub twitch_refresh: String,
    #[serde(default)]
    pub twitch_broadcaster_id: String,
    #[serde(default)]
    pub kick_client: String,
    #[serde(default)]
    pub kick_secret: String,
    #[serde(default)]
    pub kick_channel_id: String,
    #[serde(default)]
    pub kick_token: String,
    #[serde(default)]
    pub kick_refresh: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RoutingMode {
    #[default]
    StreamerBot,
    Native,
}

/// Forge database entry
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForgeLibraryEntry {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub genre: String,
    #[serde(default)]
    pub release_year: String,
    #[serde(default)]
    pub developer: String,
    #[serde(default)]
    pub publisher: String,
    #[serde(default)]
    pub cover_url: String,
    #[serde(default)]
    pub twitch_id: String,
    #[serde(default)]
    pub kick_id: String,
    #[serde(default)]
    pub igdb_id: String,
    #[serde(default)]
    pub steam_id: String,
    #[serde(default)]
    pub rawg_id: String,
    #[serde(default)]
    pub discord_app_id: String,
    #[serde(default)]
    pub gog_id: String,
    #[serde(default)]
    pub itch_id: String,
    #[serde(default)]
    pub sgdb_id: String,
    #[serde(default)]
    pub xbox_title_id: String,
    #[serde(default)]
    pub epic_id: String,
    #[serde(default)]
    pub executables: String,
}

/// Forge database
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForgeDatabase {
    #[serde(default)]
    pub delisted_apps: Vec<String>,
    #[serde(default)]
    pub listed_apps: HashMap<String, String>,
    #[serde(default)]
    pub library: HashMap<String, ForgeLibraryEntry>,
}

/// Engine status returned to frontend
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub running: bool,
    pub game_title: String,
    pub process_name: String,
    pub is_playing: bool,
    #[serde(default)]
    pub genre: String,
    #[serde(default)]
    pub developer: String,
    #[serde(default)]
    pub publisher: String,
    #[serde(default)]
    pub release_date: String,
    #[serde(default)]
    pub cover_url: String,
    #[serde(default)]
    pub widget_token: String,
}

// ============================================================================
// Default value functions (required for serde default = "fn")
// ============================================================================

fn default_idle_category() -> String {
    "Just Chatting".to_string()
}
fn default_sb_port() -> u16 {
    8080
}
fn default_scan_interval() -> u64 {
    5
}
fn default_grace_period() -> u64 {
    15
}
fn default_widget_poll_rate() -> u64 {
    3
}
fn default_widget_fade_timer() -> u64 {
    15
}
fn default_sb_action_name() -> String {
    "UpdateCategory".to_string()
}
fn default_widget_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..16).map(|_| {
        const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        CHARSET[rng.gen_range(0..CHARSET.len())] as char
    }).collect()
}
fn default_detection_mode() -> DetectionMode {
    DetectionMode::Python // Safe default
}
fn default_spark_pin() -> String {
    "0000".to_string()
}
fn default_emulator_detection() -> bool {
    true
}
fn default_ram_threshold() -> u64 {
    80
}
fn default_confidence_threshold() -> f64 {
    0.5
}
fn default_trap_chromium() -> bool {
    true
}
fn default_trap_cmdline() -> bool {
    true
}
fn default_trap_ui_framework() -> bool {
    true
}
fn default_trap_geometry() -> bool {
    true
}
fn default_score_engine_dna() -> bool {
    true
}
fn default_score_fullscreen() -> bool {
    true
}
fn default_score_window_title() -> bool {
    true
}
fn default_score_ram() -> bool {
    true
}
fn default_python_fallback() -> bool {
    true
}
fn default_routing_mode() -> RoutingMode {
    RoutingMode::StreamerBot
}

// ============================================================================
// Validation
// ============================================================================

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("Validation failed: {0}")]
    Validation(String),
    #[error("Serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

impl AppConfig {
    /// Validate all fields, returning a list of errors
    pub fn validate(&self) -> Result<(), ConfigError> {
        let mut errors = Vec::new();

        // Engine settings validation
        if self.engine_settings.scan_interval == 0 {
            errors.push("scan_interval must be > 0".to_string());
        }
        if self.engine_settings.grace_period > 300 {
            errors.push("grace_period must be <= 300".to_string());
        }
        if self.engine_settings.widget_poll_rate == 0 {
            errors.push("widget_poll_rate must be > 0".to_string());
        }
        if self.engine_settings.widget_fade_timer == 0 {
            errors.push("widget_fade_timer must be > 0".to_string());
        }
        if self.engine_settings.confidence_threshold < 0.0 || self.engine_settings.confidence_threshold > 1.0 {
            errors.push("confidence_threshold must be between 0.0 and 1.0".to_string());
        }
        if self.engine_settings.ram_threshold > 100 {
            errors.push("ram_threshold must be <= 100".to_string());
        }
        if self.engine_settings.idle_category.len() > 100 {
            errors.push("idle_category too long (max 100 chars)".to_string());
        }
        if self.engine_settings.sb_action_name.len() > 100 {
            errors.push("sb_action_name too long (max 100 chars)".to_string());
        }
        if self.engine_settings.spark_pin.len() != 4 || !self.engine_settings.spark_pin.chars().all(|c| c.is_ascii_digit()) {
            errors.push("spark_pin must be 4 digits".to_string());
        }

        // Broadcaster validation
        if self.broadcaster.routing_mode == RoutingMode::Native {
            if self.broadcaster.twitch_client.is_empty() {
                errors.push("twitch_client required for native routing".to_string());
            }
            if self.broadcaster.kick_client.is_empty() {
                errors.push("kick_client required for native routing".to_string());
            }
        }

        // API keys - just length checks
        if self.api_keys.steamgrid.len() > 200 {
            errors.push("steamgrid key too long".to_string());
        }
        if self.api_keys.rawg.len() > 200 {
            errors.push("rawg key too long".to_string());
        }
        if self.api_keys.igdb_client.len() > 100 {
            errors.push("igdb_client too long".to_string());
        }
        if self.api_keys.igdb_secret.len() > 200 {
            errors.push("igdb_secret too long".to_string());
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(ConfigError::Validation(errors.join("; ")))
        }
    }

    /// Sanitize config by clamping/truncating values
    pub fn sanitize(&mut self) {
        // Clamp numeric values
        self.engine_settings.scan_interval = self.engine_settings.scan_interval.clamp(1, 300);
        self.engine_settings.grace_period = self.engine_settings.grace_period.clamp(0, 300);
        self.engine_settings.widget_poll_rate = self.engine_settings.widget_poll_rate.clamp(1, 60);
        self.engine_settings.widget_fade_timer = self.engine_settings.widget_fade_timer.clamp(1, 300);
        self.engine_settings.confidence_threshold = self.engine_settings.confidence_threshold.clamp(0.0, 1.0);
        self.engine_settings.ram_threshold = self.engine_settings.ram_threshold.clamp(0, 100);

        // Truncate strings
        self.engine_settings.idle_category.truncate(100);
        self.engine_settings.sb_action_name.truncate(100);
        if self.engine_settings.spark_pin.len() != 4 {
            self.engine_settings.spark_pin = "0000".to_string();
        }

        // Truncate API keys
        self.api_keys.steamgrid.truncate(200);
        self.api_keys.rawg.truncate(200);
        self.api_keys.igdb_client.truncate(100);
        self.api_keys.igdb_secret.truncate(200);
        self.api_keys.igdb_token.truncate(200);
    }
}

/// Payload for import_config command (validated before write)
#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct ImportConfigPayload {
    pub config: AppConfig,
    #[serde(default)]
    pub path: Option<String>,
}

/// Payload for export_config command
#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct ExportConfigPayload {
    #[serde(default)]
    pub path: Option<String>,
}