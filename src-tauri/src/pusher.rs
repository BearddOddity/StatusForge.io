//! Native category push — updates the Twitch/Kick channel category when the
//! engine detects a new game (or falls back to the idle category).
//!
//! Blocking reqwest on purpose: called from the engine loop's std::thread.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::auth;
use crate::config::{AppConfig, ForgeDatabase, RoutingMode};

const TWITCH_GAMES_URL: &str = "https://api.twitch.tv/helix/games";
const TWITCH_CHANNELS_URL: &str = "https://api.twitch.tv/helix/channels";
const KICK_CHANNELS_URL: &str = "https://api.kick.com/public/v1/channels";
const KICK_CATEGORIES_URL: &str = "https://api.kick.com/public/v2/categories";

/// Neither Twitch nor Kick publish a specific numeric limit for category
/// changes (Twitch: general points-bucket per app/user per minute; Kick:
/// public docs don't list numbers at all) — so this isn't sized against a
/// documented threshold. It's a floor independent of `grace_period`: rapid
/// detection flapping (grace_period can be set to 0, so a quick alt-tab can
/// cause NEW GAME → drop → NEW GAME within seconds) would otherwise fire a
/// real API call to both platforms on every flap.
const PUSH_COOLDOWN_SECS: u64 = 15;

static LAST_TWITCH_PUSH_SECS: AtomicU64 = AtomicU64::new(0);
static LAST_KICK_PUSH_SECS: AtomicU64 = AtomicU64::new(0);

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// True (and records the attempt) if the cooldown for this platform has
/// elapsed. Engine loop is single-threaded so plain atomics are enough —
/// no lock needed, nothing to poison.
fn cooldown_elapsed(last: &AtomicU64) -> bool {
    let now = now_secs();
    if now.saturating_sub(last.load(Ordering::Relaxed)) < PUSH_COOLDOWN_SECS {
        return false;
    }
    last.store(now, Ordering::Relaxed);
    true
}

/// One attempt's outcome — Unauthorized triggers a single refresh+retry;
/// Transient (connection failure / 5xx) marks the platform down so the
/// health monitor takes over retrying.
enum Outcome {
    Done,
    Unauthorized,
    Transient(String),
}

// ═══════════════════════════════════════════════════════════════════════════
// Platform health / API downtime tracking
// ═══════════════════════════════════════════════════════════════════════════

/// Emitted by push_category/retry_pending when a platform's reachability
/// changes; the caller (which owns an AppHandle) forwards these to the
/// frontend as platform-down / platform-recovered toast events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HealthEvent {
    /// Display name: "Twitch" or "Kick".
    pub platform: &'static str,
    pub recovered: bool,
}

#[derive(Default)]
struct PlatformState {
    down_since: Option<u64>,
    /// The title to broadcast once the API recovers — kept up to date so
    /// recovery pushes whatever the user's playing now, not a stale title.
    pending: Option<String>,
}

/// Per-platform outage state. Pure so the transition rules are unit-testable;
/// the process-wide instance lives in `HEALTH` below.
#[derive(Default)]
struct HealthTracker {
    twitch: PlatformState,
    kick: PlatformState,
}

impl HealthTracker {
    fn state(&mut self, platform: &str) -> &mut PlatformState {
        match platform {
            "Twitch" => &mut self.twitch,
            _ => &mut self.kick,
        }
    }

    fn state_ref(&self, platform: &str) -> &PlatformState {
        match platform {
            "Twitch" => &self.twitch,
            _ => &self.kick,
        }
    }

    /// Record a transient push failure. Returns true when this is a NEW
    /// outage (was up before) — the caller emits the "down" toast only then.
    fn record_failure(&mut self, platform: &str, title: &str, now: u64) -> bool {
        let s = self.state(platform);
        s.pending = Some(title.to_string());
        if s.down_since.is_none() {
            s.down_since = Some(now);
            true
        } else {
            false
        }
    }

    /// Record a successful (or API-reachable) push. Returns true when this
    /// ends an outage — the caller emits the "recovered" toast only then.
    fn record_success(&mut self, platform: &str) -> bool {
        let s = self.state(platform);
        s.pending = None;
        s.down_since.take().is_some()
    }

    fn is_down(&self, platform: &str) -> bool {
        self.state_ref(platform).down_since.is_some()
    }

    /// Latest title waiting to broadcast on this platform, if it's down.
    fn pending(&self, platform: &str) -> Option<String> {
        self.state_ref(platform).pending.clone()
    }
}

static HEALTH: std::sync::Mutex<HealthTracker> = std::sync::Mutex::new(HealthTracker {
    twitch: PlatformState {
        down_since: None,
        pending: None,
    },
    kick: PlatformState {
        down_since: None,
        pending: None,
    },
});

/// Cheap check for the health monitor loop: anything currently marked down?
pub fn any_platform_down() -> bool {
    let h = HEALTH.lock().unwrap();
    h.is_down("Twitch") || h.is_down("Kick")
}

fn http() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))
}

// ═══════════════════════════════════════════════════════════════════════════
// Pure id resolution (unit-tested below)
// ═══════════════════════════════════════════════════════════════════════════

/// Library-preferred Twitch game id for a title (None if absent/empty).
fn library_twitch_id(db: &ForgeDatabase, title: &str) -> Option<String> {
    db.library
        .get(title)
        .map(|e| e.twitch_id.trim().to_string())
        .filter(|id| !id.is_empty())
}

/// Kick category id: prefer library[title].kick_id, else the kick_db name→id
/// map (case-insensitive). Kick's PATCH body wants an integer.
fn resolve_kick_id(
    db: &ForgeDatabase,
    kick_map: &HashMap<String, String>,
    title: &str,
) -> Option<i64> {
    let from_lib = db
        .library
        .get(title)
        .map(|e| e.kick_id.trim().to_string())
        .filter(|id| !id.is_empty());
    let raw = from_lib.or_else(|| {
        kick_map
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(title))
            .map(|(_, id)| id.clone())
    })?;
    raw.parse::<i64>().ok()
}

fn load_kick_map(base_dir: &Path) -> HashMap<String, String> {
    std::fs::read_to_string(base_dir.join("kick_db.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Live fallback when the library and the periodically-synced kick_db.json
/// both come up empty: search Kick's own category catalog by name directly,
/// same endpoint/parsing metadata.rs's scan uses. This is the same gap
/// Twitch's push path already covers via a live Get Games call when the
/// library has no id — Kick's category list drifts (renamed/added/removed)
/// more than kick_db.json's periodic re-sync can always keep up with, so
/// without this a game not yet in that cache just never gets pushed at all.
fn live_kick_category_search(title: &str, token: &str) -> Option<i64> {
    let client = http().ok()?;
    let resp = client
        .get(KICK_CATEGORIES_URL)
        .query(&[("name", title), ("limit", "1")])
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let json: serde_json::Value = resp.json().ok()?;
    json["data"][0]["id"].as_i64()
}

// ═══════════════════════════════════════════════════════════════════════════
// Twitch
// ═══════════════════════════════════════════════════════════════════════════

fn twitch_push_once(
    config: &AppConfig,
    db: &ForgeDatabase,
    title: &str,
    token: &str,
) -> Result<Outcome, String> {
    let b = &config.broadcaster;
    let client = http()?;

    // Resolve game_id: library first, else helix search by exact name.
    let game_id = match library_twitch_id(db, title) {
        Some(id) => id,
        None => {
            let resp = match client
                .get(TWITCH_GAMES_URL)
                .query(&[("name", title)])
                .header("Client-Id", &b.twitch_client)
                .header("Authorization", format!("Bearer {}", token))
                .send()
            {
                Ok(r) => r,
                // Connection-level failure (timeout, DNS, refused) — the API
                // is unreachable, not rejecting us. Transient.
                Err(e) => return Ok(Outcome::Transient(format!("Twitch game lookup: {}", e))),
            };
            if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
                return Ok(Outcome::Unauthorized);
            }
            if resp.status().is_server_error() {
                return Ok(Outcome::Transient(format!(
                    "Twitch game lookup returned {}",
                    resp.status()
                )));
            }
            if !resp.status().is_success() {
                return Err(format!("Twitch game lookup returned {}", resp.status()));
            }
            let json: serde_json::Value = resp
                .json()
                .map_err(|e| format!("Twitch game lookup parse error: {}", e))?;
            match json["data"][0]["id"].as_str() {
                Some(id) if !id.is_empty() => id.to_string(),
                _ => {
                    log::info!("[PUSH] Twitch: no game id for \"{}\" — skipping", title);
                    return Ok(Outcome::Done);
                }
            }
        }
    };

    let resp = match client
        .patch(TWITCH_CHANNELS_URL)
        .query(&[("broadcaster_id", &b.twitch_broadcaster_id)])
        .header("Client-Id", &b.twitch_client)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "game_id": game_id }))
        .send()
    {
        Ok(r) => r,
        Err(e) => return Ok(Outcome::Transient(format!("Twitch channel update: {}", e))),
    };

    match resp.status() {
        reqwest::StatusCode::UNAUTHORIZED => Ok(Outcome::Unauthorized),
        reqwest::StatusCode::TOO_MANY_REQUESTS => {
            // Not a token problem — don't refresh-and-retry, that only makes
            // it worse. Just skip this push; the cooldown in push_category
            // already keeps our own request rate well below anything Twitch
            // would reasonably throttle.
            log::warn!("[PUSH] Twitch rate-limited (429) — skipping this push");
            Ok(Outcome::Done)
        }
        s if s.is_server_error() => Ok(Outcome::Transient(format!(
            "Twitch channel update returned {}",
            s
        ))),
        s if s.is_success() => {
            log::info!("[PUSH] Twitch category set to \"{}\" ({})", title, game_id);
            Ok(Outcome::Done)
        }
        s => Err(format!(
            "Twitch channel update returned {}: {}",
            s,
            resp.text().unwrap_or_default()
        )),
    }
}

/// Whether the API was reachable — Transient means unreachable and feeds the
/// health tracker; everything else (success, skip, auth trouble, 4xx) means
/// the API answered, so the platform counts as up.
enum PushResult {
    Reachable,
    Transient,
}

fn push_twitch(base_dir: &Path, config: &AppConfig, db: &ForgeDatabase, title: &str) -> PushResult {
    match twitch_push_once(config, db, title, &config.broadcaster.twitch_token) {
        Ok(Outcome::Done) => PushResult::Reachable,
        Ok(Outcome::Transient(e)) => {
            log::warn!("[PUSH] Twitch unreachable: {}", e);
            PushResult::Transient
        }
        Ok(Outcome::Unauthorized) => {
            log::info!("[PUSH] Twitch token expired — refreshing");
            match auth::refresh_twitch_token(config) {
                Ok(new_token) => {
                    let mut updated = config.clone();
                    updated.broadcaster.twitch_token = new_token;
                    if let Err(e) = auth::save_config_at(base_dir, &updated) {
                        log::warn!("[PUSH] Failed to save refreshed Twitch token: {}", e);
                    }
                    match twitch_push_once(&updated, db, title, &updated.broadcaster.twitch_token) {
                        Ok(Outcome::Done) => PushResult::Reachable,
                        Ok(Outcome::Transient(e)) => {
                            log::warn!("[PUSH] Twitch unreachable on retry: {}", e);
                            PushResult::Transient
                        }
                        Ok(Outcome::Unauthorized) => {
                            log::warn!("[PUSH] Twitch retry still unauthorized");
                            PushResult::Reachable
                        }
                        Err(e) => {
                            log::warn!("[PUSH] Twitch retry failed: {}", e);
                            PushResult::Reachable
                        }
                    }
                }
                Err(e) => {
                    log::warn!("[PUSH] Twitch token refresh failed: {}", e);
                    PushResult::Reachable
                }
            }
        }
        Err(e) => {
            log::warn!("[PUSH] {}", e);
            PushResult::Reachable
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Kick
// ═══════════════════════════════════════════════════════════════════════════

fn kick_push_once(category_id: i64, token: &str) -> Result<Outcome, String> {
    // Confirmed against Kick public API docs: PATCH /public/v1/channels,
    // body {"category_id": <int>}, scope channel:write, 204 on success.
    let client = http()?;
    let resp = match client
        .patch(KICK_CHANNELS_URL)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "category_id": category_id }))
        .send()
    {
        Ok(r) => r,
        Err(e) => return Ok(Outcome::Transient(format!("Kick channel update: {}", e))),
    };

    match resp.status() {
        reqwest::StatusCode::UNAUTHORIZED => Ok(Outcome::Unauthorized),
        reqwest::StatusCode::TOO_MANY_REQUESTS => {
            // Not a token problem — don't refresh-and-retry. The cooldown in
            // push_category already keeps our own request rate low.
            log::warn!("[PUSH] Kick rate-limited (429) — skipping this push");
            Ok(Outcome::Done)
        }
        s if s.is_server_error() => Ok(Outcome::Transient(format!(
            "Kick channel update returned {}",
            s
        ))),
        s if s.is_success() => {
            log::info!("[PUSH] Kick category set ({})", category_id);
            Ok(Outcome::Done)
        }
        s => Err(format!(
            "Kick channel update returned {}: {}",
            s,
            resp.text().unwrap_or_default()
        )),
    }
}

fn push_kick(base_dir: &Path, config: &AppConfig, db: &ForgeDatabase, title: &str) -> PushResult {
    let kick_map = load_kick_map(base_dir);
    let category_id = match resolve_kick_id(db, &kick_map, title) {
        Some(id) => id,
        None => match live_kick_category_search(title, &config.broadcaster.kick_token) {
            Some(id) => id,
            None => {
                log::info!("[PUSH] Kick: no category id for \"{}\" — skipping", title);
                return PushResult::Reachable;
            }
        },
    };

    match kick_push_once(category_id, &config.broadcaster.kick_token) {
        Ok(Outcome::Done) => PushResult::Reachable,
        Ok(Outcome::Transient(e)) => {
            log::warn!("[PUSH] Kick unreachable: {}", e);
            PushResult::Transient
        }
        Ok(Outcome::Unauthorized) => {
            log::info!("[PUSH] Kick token expired — refreshing");
            match auth::refresh_kick_token(config) {
                Ok(new_token) => {
                    let mut updated = config.clone();
                    updated.broadcaster.kick_token = new_token.clone();
                    if let Err(e) = auth::save_config_at(base_dir, &updated) {
                        log::warn!("[PUSH] Failed to save refreshed Kick token: {}", e);
                    }
                    match kick_push_once(category_id, &new_token) {
                        Ok(Outcome::Done) => PushResult::Reachable,
                        Ok(Outcome::Transient(e)) => {
                            log::warn!("[PUSH] Kick unreachable on retry: {}", e);
                            PushResult::Transient
                        }
                        Ok(Outcome::Unauthorized) => {
                            log::warn!("[PUSH] Kick retry still unauthorized");
                            PushResult::Reachable
                        }
                        Err(e) => {
                            log::warn!("[PUSH] Kick retry failed: {}", e);
                            PushResult::Reachable
                        }
                    }
                }
                Err(e) => {
                    log::warn!("[PUSH] Kick token refresh failed: {}", e);
                    PushResult::Reachable
                }
            }
        }
        Err(e) => {
            log::warn!("[PUSH] {}", e);
            PushResult::Reachable
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Public entry point
// ═══════════════════════════════════════════════════════════════════════════

/// Run one platform's push and translate the result into health-tracker
/// transitions. Returns the toast-worthy event, if this push changed the
/// platform's up/down state.
fn push_and_track(
    platform: &'static str,
    title: &str,
    push: impl FnOnce() -> PushResult,
) -> Option<HealthEvent> {
    let result = push();
    let mut health = HEALTH.lock().unwrap();
    match result {
        PushResult::Reachable => health.record_success(platform).then_some(HealthEvent {
            platform,
            recovered: true,
        }),
        PushResult::Transient => health
            .record_failure(platform, title, now_secs())
            .then_some(HealthEvent {
                platform,
                recovered: false,
            }),
    }
}

/// Push `title` as the live category to every configured platform.
/// No-op unless routing_mode is Native. Never errors — failures are logged so
/// the engine loop keeps running.
///
/// A platform marked down isn't pushed to — the title is just remembered as
/// pending, and `retry_pending` probes it every 30s instead. Otherwise the
/// engine thread would stall on a connect timeout every tick during an
/// outage. Returned events are up/down transitions for the caller to toast.
pub fn push_category(
    base_dir: &Path,
    config: &AppConfig,
    db: &ForgeDatabase,
    title: &str,
) -> Vec<HealthEvent> {
    let mut events = Vec::new();
    if !config.engine_settings.platform_push_enabled {
        return events;
    }
    if config.broadcaster.routing_mode != RoutingMode::Native {
        return events;
    }
    let b = &config.broadcaster;
    if !b.twitch_token.is_empty() && !b.twitch_broadcaster_id.is_empty() {
        if HEALTH.lock().unwrap().is_down("Twitch") {
            HEALTH.lock().unwrap().state("Twitch").pending = Some(title.to_string());
            log::info!("[PUSH] Twitch down — queued \"{}\" for recovery", title);
        } else if cooldown_elapsed(&LAST_TWITCH_PUSH_SECS) {
            events.extend(push_and_track("Twitch", title, || {
                push_twitch(base_dir, config, db, title)
            }));
        } else {
            log::info!("[PUSH] Twitch category push skipped — cooldown active");
        }
    }
    if !b.kick_token.is_empty() {
        if HEALTH.lock().unwrap().is_down("Kick") {
            HEALTH.lock().unwrap().state("Kick").pending = Some(title.to_string());
            log::info!("[PUSH] Kick down — queued \"{}\" for recovery", title);
        } else if cooldown_elapsed(&LAST_KICK_PUSH_SECS) {
            events.extend(push_and_track("Kick", title, || {
                push_kick(base_dir, config, db, title)
            }));
        } else {
            log::info!("[PUSH] Kick category push skipped — cooldown active");
        }
    }
    events
}

/// Health-monitor probe: for each platform currently marked down, re-attempt
/// its pending title (the latest detection that couldn't broadcast). Success
/// clears the outage — the retried push IS the recovery broadcast, so
/// nothing is lost. Called every ~30s from the monitor thread in lib.rs.
pub fn retry_pending(base_dir: &Path, config: &AppConfig, db: &ForgeDatabase) -> Vec<HealthEvent> {
    let mut events = Vec::new();
    if !config.engine_settings.platform_push_enabled {
        return events;
    }
    if config.broadcaster.routing_mode != RoutingMode::Native {
        return events;
    }
    let b = &config.broadcaster;

    let twitch_pending = HEALTH.lock().unwrap().pending("Twitch");
    if let Some(title) = twitch_pending {
        if !b.twitch_token.is_empty() && !b.twitch_broadcaster_id.is_empty() {
            log::info!("[PUSH] Probing Twitch with pending \"{}\"", title);
            events.extend(push_and_track("Twitch", &title, || {
                push_twitch(base_dir, config, db, &title)
            }));
        }
    }
    let kick_pending = HEALTH.lock().unwrap().pending("Kick");
    if let Some(title) = kick_pending {
        if !b.kick_token.is_empty() {
            log::info!("[PUSH] Probing Kick with pending \"{}\"", title);
            events.extend(push_and_track("Kick", &title, || {
                push_kick(base_dir, config, db, &title)
            }));
        }
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ForgeLibraryEntry;

    fn db_with(title: &str, twitch_id: &str, kick_id: &str) -> ForgeDatabase {
        let mut db = ForgeDatabase::default();
        db.library.insert(
            title.to_string(),
            ForgeLibraryEntry {
                title: title.to_string(),
                twitch_id: twitch_id.to_string(),
                kick_id: kick_id.to_string(),
                ..Default::default()
            },
        );
        db
    }

    #[test]
    fn twitch_id_prefers_library_and_skips_empty() {
        let db = db_with("Hades", "12345", "");
        assert_eq!(library_twitch_id(&db, "Hades"), Some("12345".to_string()));
        // Empty library id falls through to API lookup (None here)
        let db = db_with("Hades", "  ", "");
        assert_eq!(library_twitch_id(&db, "Hades"), None);
        assert_eq!(library_twitch_id(&db, "Unknown Game"), None);
    }

    #[test]
    fn health_tracker_reports_transitions_once() {
        let mut h = HealthTracker::default();
        assert!(!h.is_down("Twitch"));

        // First failure = new outage; repeat failures aren't re-announced.
        assert!(h.record_failure("Twitch", "Hades", 100));
        assert!(!h.record_failure("Twitch", "Celeste", 130));
        assert!(h.is_down("Twitch"));
        // Kick is tracked independently.
        assert!(!h.is_down("Kick"));

        // Pending always reflects the LATEST failed title.
        assert_eq!(h.pending("Twitch"), Some("Celeste".to_string()));

        // Recovery announced once, then quiet.
        assert!(h.record_success("Twitch"));
        assert!(!h.record_success("Twitch"));
        assert!(!h.is_down("Twitch"));
        assert_eq!(h.pending("Twitch"), None);
    }

    #[test]
    fn health_tracker_success_while_up_is_silent() {
        let mut h = HealthTracker::default();
        assert!(!h.record_success("Kick"));
        assert_eq!(h.pending("Kick"), None);
    }

    #[test]
    fn kick_id_prefers_library_then_map_case_insensitive() {
        let mut map = HashMap::new();
        map.insert("Just Chatting".to_string(), "15".to_string());
        map.insert("Hades".to_string(), "777".to_string());

        // Library wins over map
        let db = db_with("Hades", "", "42");
        assert_eq!(resolve_kick_id(&db, &map, "Hades"), Some(42));

        // Empty library id falls back to map, case-insensitive
        let db = db_with("Hades", "", "");
        assert_eq!(resolve_kick_id(&db, &map, "hades"), Some(777));
        assert_eq!(resolve_kick_id(&db, &map, "just chatting"), Some(15));

        // Unresolvable → None (caller skips platform)
        assert_eq!(resolve_kick_id(&db, &map, "Obscure Indie"), None);
        // Non-numeric id → None
        let db = db_with("Weird", "", "abc");
        assert_eq!(resolve_kick_id(&db, &map, "Weird"), None);
    }
}
