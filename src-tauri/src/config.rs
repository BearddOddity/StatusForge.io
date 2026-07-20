//! Typed configuration structures with validation for StatusForge.io
//!
//! Replaces the untyped `serde_json::Value` approach with proper Rust structs
//! that validate all fields on import/export.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Top-level configuration container
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct AppConfig {
    #[serde(default)]
    pub api_keys: ApiKeys,
    #[serde(default)]
    pub engine_settings: EngineSettings,
    #[serde(default)]
    pub broadcaster: BroadcasterConfig,
}

/// API keys for external services.
///
/// Every field omits itself from serialized output when empty
/// (`skip_serializing_if`). Without this, a key the user "removes" in the UI
/// (which just clears the JS object's property locally) would round-trip
/// through export_config as `{ "steamgrid": "" }` — present, just empty —
/// and the frontend's active-key check (`Object.keys(...)`) would see it as
/// still configured, making the removal silently not stick across a reload.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct ApiKeys {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub steamgrid: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub rawg: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub igdb_client: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub igdb_secret: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub igdb_token: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub thegamesdb: String,
}

/// Engine/runtime settings
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(default)]
pub struct EngineSettings {
    #[serde(default = "default_idle_category")]
    pub idle_category: String,
    #[serde(default = "default_sb_port")]
    pub sb_port: u16,
    #[serde(default = "default_scan_interval")]
    pub scan_interval: u64,
    #[serde(default = "default_grace_period")]
    pub grace_period: u64,
    #[serde(default = "default_overlay_poll_rate", alias = "widget_poll_rate")]
    pub overlay_poll_rate: u64,
    #[serde(default)]
    pub safe_mode: bool,
    #[serde(default)]
    pub auto_push: bool,
    /// Master switch for pushing detected game state to Twitch/Kick (category
    /// updates, stream info). Defaults true so upgrading existing configs
    /// doesn't silently stop routing that was already working.
    #[serde(default = "default_platform_push_enabled")]
    pub platform_push_enabled: bool,
    #[serde(default = "default_overlay_fade_timer", alias = "widget_fade_timer")]
    pub overlay_fade_timer: u64,
    #[serde(default)]
    pub strict_forge_mode: bool,
    #[serde(default = "default_sb_action_name")]
    pub sb_action_name: String,
    #[serde(default = "default_overlay_token", alias = "widget_token")]
    pub overlay_token: String,
    /// Old configs saved before the SPARK → Blipy rename still load fine —
    /// `alias` accepts the old JSON key, new saves write the new one.
    #[serde(default = "default_blipy_pin", alias = "spark_pin")]
    pub blipy_pin: String,
    /// Optional user-set pairing key mixed into the Blipy heartbeat HMAC secret.
    #[serde(default, alias = "spark_pairing_key")]
    pub blipy_pairing_key: String,
    /// When true, this PC's local scanner stops reporting detections —
    /// only the paired Blipy agent drives the game state. Prevents the two
    /// detection sources from crosswiring when a dual-PC link is in use.
    #[serde(default, alias = "spark_link_active")]
    pub blipy_link_active: bool,
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
            overlay_poll_rate: default_overlay_poll_rate(),
            safe_mode: false,
            auto_push: false,
            platform_push_enabled: default_platform_push_enabled(),
            overlay_fade_timer: default_overlay_fade_timer(),
            strict_forge_mode: false,
            sb_action_name: default_sb_action_name(),
            overlay_token: default_overlay_token(),
            blipy_pin: default_blipy_pin(),
            blipy_pairing_key: String::new(),
            blipy_link_active: false,
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

// An old config containing a `detection` section or an
// `engine_settings.detection_mode` field still parses fine: unknown keys
// are ignored.

/// Broadcaster/platform configuration. Same skip-empty-on-serialize reasoning
/// as `ApiKeys` — removing a routing integration must actually make it
/// disappear from the exported config, not just report an empty string.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct BroadcasterConfig {
    #[serde(default = "default_routing_mode")]
    pub routing_mode: RoutingMode,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub twitch_client: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub twitch_secret: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub twitch_token: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub twitch_refresh: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub twitch_broadcaster_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kick_client: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kick_secret: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kick_channel_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kick_token: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kick_refresh: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RoutingMode {
    #[default]
    StreamerBot,
    Native,
}

/// A user-created alternative name for a game (language variant,
/// abbreviation, misleading window title, ...). Stored on the canonical
/// library entry itself, so an alias can only point at a canonical title —
/// alias→alias chaining is unrepresentable by construction.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(default)]
pub struct GameAlias {
    pub name: String,
    /// 1 = highest; resolution tie-breaker #1.
    #[serde(default = "default_alias_priority")]
    pub priority: u8,
    /// Language tag ("en", "ja", ...); resolution tie-breaker #2.
    #[serde(default = "default_alias_language")]
    pub language: String,
    /// Sortable creation timestamp (zero-padded unix seconds — no chrono
    /// dep here); final resolution tie-breaker (oldest wins, string order).
    pub added_at: String,
    /// User-flagged preferred alias; resolution tie-breaker #3.
    pub preferred: bool,
}

/// One weekly-sync check-in against Twitch/Kick's live category list for a
/// single library entry — logged so a user can see what changed (or that
/// nothing did), not just that a background sync ran at some point.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(default)]
pub struct SyncHistoryEntry {
    /// Zero-padded unix seconds (matches GameAlias::added_at).
    pub timestamp: String,
    /// "weekly_sync" today; room for other check-in types later.
    pub action: String,
    /// e.g. "twitch: 12345 -> 67890", or "none" when nothing changed.
    pub changes: String,
}

fn default_alias_priority() -> u8 {
    1
}
fn default_alias_language() -> String {
    "en".to_string()
}

/// Forge database entry
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
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
    /// Transparent PNG game logo (SteamGridDB /logos), distinct from the
    /// portrait/landscape cover art in cover_url — meant for overlaying on
    /// top of other art, not as a standalone thumbnail.
    #[serde(default)]
    pub logo_url: String,
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
    pub thegamesdb_id: String,
    #[serde(default)]
    pub xbox_title_id: String,
    #[serde(default)]
    pub epic_id: String,
    #[serde(default)]
    pub executables: String,
    /// Field names the user has explicitly saved by hand via the Library
    /// editor. metadata::scan()'s merge never touches a locked field again —
    /// not "only if non-empty" (that alone can't tell "never scanned yet"
    /// apart from "user intentionally cleared this"), a real lock. Scanned
    /// data is meant to help fill in the gaps, not override what someone
    /// chose to set themselves — a personal cover/logo/genre/etc. sticks
    /// until they edit that field again.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub locked_fields: Vec<String>,
    /// Alternative names the user set up for this game, resolved during
    /// detection (Stage 0) before anything gets broadcast or upserted.
    /// Skipped when empty so a Forge_Database.json from before this feature
    /// existed still round-trips byte-for-byte.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<GameAlias>,
    /// Weekly Twitch/Kick category-id check-ins, newest last, pruned to the
    /// last 7 days — see `metadata::weekly_library_sync`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sync_history: Vec<SyncHistoryEntry>,
}

/// Forge database
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct ForgeDatabase {
    #[serde(default)]
    pub delisted_apps: Vec<String>,
    #[serde(default)]
    pub listed_apps: HashMap<String, String>,
    #[serde(default)]
    pub library: HashMap<String, ForgeLibraryEntry>,
}

/// Finds the existing `library` key for `title`, tolerating the whitespace/
/// casing drift that different sources (raw OS window titles from the
/// native scanner and a paired Blipy agent, vs. hand-typed titles in the
/// Library editor) can introduce for what a human would call the same
/// game. Every insertion site should resolve through this first instead of
/// keying on the raw title directly — otherwise "Half-Life" and "half-life "
/// silently become two separate library entries.
///
/// Exact match (post-trim) wins first so a title that's already the stored
/// key never pays for a full scan; only falls back to a case-insensitive
/// scan over existing keys when there's no exact hit.
pub fn find_library_key(db: &ForgeDatabase, title: &str) -> Option<String> {
    let needle = title.trim();
    if db.library.contains_key(needle) {
        return Some(needle.to_string());
    }
    let needle_lower = needle.to_lowercase();
    db.library
        .keys()
        .find(|k| k.trim().to_lowercase() == needle_lower)
        .cloned()
}

/// Stage 0 of detection: resolves a raw title through the library's aliases.
/// Returns `None` if nothing matches, or if `raw_title` is already a real
/// library entry (a canonical title always wins over an alias).
///
/// Language tie-breaking is hardcoded to "en" until more UI languages ship.
pub fn resolve_title_alias(db: &ForgeDatabase, raw_title: &str) -> Option<String> {
    if find_library_key(db, raw_title).is_some() {
        return None;
    }
    let records: Vec<forge_detection::alias::AliasRecord> = db
        .library
        .values()
        .flat_map(|entry| {
            entry
                .aliases
                .iter()
                .map(|a| forge_detection::alias::AliasRecord {
                    canonical: entry.title.clone(),
                    name: a.name.clone(),
                    priority: a.priority,
                    language: a.language.clone(),
                    added_at: a.added_at.clone(),
                    preferred: a.preferred,
                })
        })
        .collect();
    forge_detection::alias::resolve_alias(raw_title, &records, "en")
}

/// Engine status returned to frontend
#[derive(Serialize, Deserialize, Debug, Clone, Default)]

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
fn default_overlay_poll_rate() -> u64 {
    3
}
fn default_overlay_fade_timer() -> u64 {
    15
}
fn default_sb_action_name() -> String {
    "UpdateCategory".to_string()
}
fn default_overlay_token() -> String {
    use rand::Rng;
    let mut rng = rand::rng();
    (0..16)
        .map(|_| {
            const CHARSET: &[u8] =
                b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
            CHARSET[rng.random_range(0..CHARSET.len())] as char
        })
        .collect()
}
fn default_blipy_pin() -> String {
    "0000".to_string()
}
fn default_emulator_detection() -> bool {
    true
}

fn default_platform_push_enabled() -> bool {
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
        if self.engine_settings.scan_interval < 2 {
            // A floor, not just > 0: below this the loop's per-tick disk reads
            // (Config.json + Forge_Database.json) and log volume both scale
            // roughly 1:1 with scan frequency — 1s was cheap to set from the
            // UI but expensive to actually run at for a whole session.
            errors.push("scan_interval must be >= 2".to_string());
        }
        if self.engine_settings.grace_period > 300 {
            errors.push("grace_period must be <= 300".to_string());
        }
        if self.engine_settings.overlay_poll_rate == 0 {
            errors.push("overlay_poll_rate must be > 0".to_string());
        }
        // overlay_fade_timer has no lower-bound check — 0 is valid and
        // means "never fade."
        if self.engine_settings.confidence_threshold < 0.0
            || self.engine_settings.confidence_threshold > 1.0
        {
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
        if self.engine_settings.blipy_pin.len() != 4
            || !self
                .engine_settings
                .blipy_pin
                .chars()
                .all(|c| c.is_ascii_digit())
        {
            errors.push("blipy_pin must be 4 digits".to_string());
        }

        // No "at least one platform client" rule here on purpose: pusher.rs's
        // push_category already no-ops safely when both tokens are empty, so
        // this isn't protecting anything at runtime — it was actively
        // rejecting the save when a user removed their last integration,
        // making the removal silently fail and the old data reappear next
        // session.

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
        self.engine_settings.scan_interval = self.engine_settings.scan_interval.clamp(2, 300);
        self.engine_settings.grace_period = self.engine_settings.grace_period.clamp(0, 300);
        self.engine_settings.overlay_poll_rate =
            self.engine_settings.overlay_poll_rate.clamp(1, 60);
        // 0 is a valid, intentional value here — "never fade" — not
        // something to clamp away like the other numeric settings.
        self.engine_settings.overlay_fade_timer =
            self.engine_settings.overlay_fade_timer.clamp(0, 120);
        self.engine_settings.confidence_threshold =
            self.engine_settings.confidence_threshold.clamp(0.0, 1.0);
        self.engine_settings.ram_threshold = self.engine_settings.ram_threshold.clamp(0, 100);

        // Truncate strings
        self.engine_settings.idle_category.truncate(100);
        self.engine_settings.sb_action_name.truncate(100);
        if self.engine_settings.blipy_pin.len() != 4
            || !self
                .engine_settings
                .blipy_pin
                .chars()
                .all(|c| c.is_ascii_digit())
        {
            self.engine_settings.blipy_pin = "0000".to_string();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_then_validate_accepts_out_of_range_ui_input() {
        // Values a user can transiently produce in the UI (half-typed PIN,
        // cleared number fields) must be repaired by sanitize(), not fail the
        // whole config save.
        let mut c = AppConfig::default();
        c.engine_settings.blipy_pin = "12".into();
        c.engine_settings.overlay_poll_rate = 0;
        c.engine_settings.scan_interval = 0;
        c.engine_settings.confidence_threshold = 5.0;
        c.engine_settings.ram_threshold = 900;
        c.sanitize();
        assert_eq!(c.engine_settings.blipy_pin, "0000");
        assert_eq!(c.engine_settings.overlay_poll_rate, 1);
        assert_eq!(c.engine_settings.scan_interval, 2);
        assert_eq!(c.engine_settings.confidence_threshold, 1.0);
        assert_eq!(c.engine_settings.ram_threshold, 100);
        assert!(c.validate().is_ok());
    }

    #[test]
    fn overlay_fade_timer_zero_means_never_fade_and_survives_sanitize() {
        let mut c = AppConfig::default();
        c.engine_settings.overlay_fade_timer = 0;
        c.sanitize();
        assert_eq!(c.engine_settings.overlay_fade_timer, 0);
        assert!(c.validate().is_ok());
    }

    #[test]
    fn sanitize_resets_non_numeric_pin() {
        let mut c = AppConfig::default();
        c.engine_settings.blipy_pin = "abcd".into();
        c.sanitize();
        assert_eq!(c.engine_settings.blipy_pin, "0000");
    }

    #[test]
    fn native_routing_allows_any_number_of_clients() {
        // Removing your last configured platform (leaving native routing with
        // zero clients) must be a valid, savable state — pusher.rs already
        // no-ops safely at runtime, so this isn't a real invariant to enforce.
        let mut c = AppConfig::default();
        c.broadcaster.routing_mode = RoutingMode::Native;
        assert!(c.validate().is_ok(), "zero clients should pass");
        c.broadcaster.twitch_client = "abc".into();
        assert!(c.validate().is_ok(), "twitch-only should pass");
        c.broadcaster.twitch_client.clear();
        c.broadcaster.kick_client = "xyz".into();
        assert!(c.validate().is_ok(), "kick-only should pass");
    }

    #[test]
    fn config_survives_json_round_trip() {
        let mut c = AppConfig::default();
        c.engine_settings.blipy_pairing_key = "pair-key".into();
        c.engine_settings.idle_category = "Art".into();
        c.api_keys.steamgrid = "sg".into();
        c.broadcaster.twitch_client = "tc".into();
        let json = serde_json::to_string(&c).unwrap();
        let back: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(
            serde_json::to_value(&back).unwrap(),
            serde_json::to_value(&c).unwrap()
        );
    }

    /// A Config.json saved before the SPARK → Blipy rename still has to load
    /// correctly — old installs shouldn't need to re-pair just because the
    /// field got renamed.
    #[test]
    fn old_spark_keys_still_load_into_renamed_blipy_fields() {
        let json = r#"{
            "engine_settings": {
                "spark_pin": "4242",
                "spark_pairing_key": "old-key",
                "spark_link_active": true
            }
        }"#;
        let c: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(c.engine_settings.blipy_pin, "4242");
        assert_eq!(c.engine_settings.blipy_pairing_key, "old-key");
        assert!(c.engine_settings.blipy_link_active);
    }

    /// Same guarantee as above, for the widget->overlay rename: a
    /// Config.json saved before the rename still loads correctly.
    #[test]
    fn old_widget_keys_still_load_into_renamed_overlay_fields() {
        let json = r#"{
            "engine_settings": {
                "widget_poll_rate": 8,
                "widget_fade_timer": 0,
                "widget_token": "OLD_TOKEN_VALUE"
            }
        }"#;
        let c: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(c.engine_settings.overlay_poll_rate, 8);
        assert_eq!(c.engine_settings.overlay_fade_timer, 0);
        assert_eq!(c.engine_settings.overlay_token, "OLD_TOKEN_VALUE");
    }

    /// Regression guard against Config.json.template silently drifting out
    /// of sync with AppConfig — e.g. a field gets renamed/removed in Rust but
    /// the shipped template (what a fresh install actually bootstraps from,
    /// see init_app_base_dir in lib.rs) never gets updated to match, or vice
    /// versa. Also checks the resulting config passes validate(), since a
    /// template that deserializes but fails validation would still break a
    /// fresh install.
    #[test]
    fn config_template_matches_app_config() {
        let template_path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../Config.json.template");
        let content = std::fs::read_to_string(&template_path)
            .unwrap_or_else(|e| panic!("failed to read {:?}: {}", template_path, e));
        let config: AppConfig = serde_json::from_str(&content)
            .unwrap_or_else(|e| panic!("Config.json.template no longer deserializes into AppConfig — did a field get renamed/removed? {}", e));
        config
            .validate()
            .unwrap_or_else(|e| panic!("Config.json.template fails validate(): {}", e));
    }

    /// Regression guard for a real bug: the template previously shipped
    /// literal placeholder text ("YOUR_IGDB_CLIENT_ID", etc.) for every
    /// credential field. Those are non-empty strings, so the frontend's
    /// "is this integration configured" checks (which key off presence/
    /// truthiness, not literal validity) treated every API key and routing
    /// integration as already active on a fresh install — before the user
    /// had touched the "+ Add" flow at all. Credential fields must bootstrap
    /// empty so skip_serializing_if keeps them absent until the user adds one.
    #[test]
    fn config_template_credentials_are_empty() {
        let template_path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../Config.json.template");
        let content = std::fs::read_to_string(&template_path).unwrap();
        let config: AppConfig = serde_json::from_str(&content).unwrap();

        assert_eq!(config.api_keys.steamgrid, "");
        assert_eq!(config.api_keys.rawg, "");
        assert_eq!(config.api_keys.igdb_client, "");
        assert_eq!(config.api_keys.igdb_secret, "");
        assert_eq!(config.api_keys.igdb_token, "");

        assert_eq!(config.broadcaster.twitch_client, "");
        assert_eq!(config.broadcaster.twitch_secret, "");
        assert_eq!(config.broadcaster.twitch_token, "");
        assert_eq!(config.broadcaster.twitch_refresh, "");
        assert_eq!(config.broadcaster.twitch_broadcaster_id, "");
        assert_eq!(config.broadcaster.kick_client, "");
        assert_eq!(config.broadcaster.kick_secret, "");
        assert_eq!(config.broadcaster.kick_channel_id, "");
        assert_eq!(config.broadcaster.kick_token, "");
        assert_eq!(config.broadcaster.kick_refresh, "");
    }
}
