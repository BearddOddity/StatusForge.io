//! Native category push — updates the Twitch/Kick channel category when the
//! engine detects a new game (or falls back to the idle category).
//!
//! Blocking reqwest on purpose: called from the engine loop's std::thread.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use crate::auth;
use crate::config::{AppConfig, ForgeDatabase, RoutingMode};

const TWITCH_GAMES_URL: &str = "https://api.twitch.tv/helix/games";
const TWITCH_CHANNELS_URL: &str = "https://api.twitch.tv/helix/channels";
const KICK_CHANNELS_URL: &str = "https://api.kick.com/public/v1/channels";

/// One attempt's outcome — Unauthorized triggers a single refresh+retry.
enum Outcome {
    Done,
    Unauthorized,
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
fn resolve_kick_id(db: &ForgeDatabase, kick_map: &HashMap<String, String>, title: &str) -> Option<i64> {
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
            let resp = client
                .get(TWITCH_GAMES_URL)
                .query(&[("name", title)])
                .header("Client-Id", &b.twitch_client)
                .header("Authorization", format!("Bearer {}", token))
                .send()
                .map_err(|e| format!("Twitch game lookup failed: {}", e))?;
            if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
                return Ok(Outcome::Unauthorized);
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

    let resp = client
        .patch(TWITCH_CHANNELS_URL)
        .query(&[("broadcaster_id", &b.twitch_broadcaster_id)])
        .header("Client-Id", &b.twitch_client)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "game_id": game_id }))
        .send()
        .map_err(|e| format!("Twitch channel update failed: {}", e))?;

    match resp.status() {
        reqwest::StatusCode::UNAUTHORIZED => Ok(Outcome::Unauthorized),
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

fn push_twitch(base_dir: &Path, config: &AppConfig, db: &ForgeDatabase, title: &str) {
    match twitch_push_once(config, db, title, &config.broadcaster.twitch_token) {
        Ok(Outcome::Done) => {}
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
                        Ok(Outcome::Done) => {}
                        Ok(Outcome::Unauthorized) => {
                            log::warn!("[PUSH] Twitch retry still unauthorized")
                        }
                        Err(e) => log::warn!("[PUSH] Twitch retry failed: {}", e),
                    }
                }
                Err(e) => log::warn!("[PUSH] Twitch token refresh failed: {}", e),
            }
        }
        Err(e) => log::warn!("[PUSH] {}", e),
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Kick
// ═══════════════════════════════════════════════════════════════════════════

fn kick_push_once(category_id: i64, token: &str) -> Result<Outcome, String> {
    // Confirmed against Kick public API docs: PATCH /public/v1/channels,
    // body {"category_id": <int>}, scope channel:write, 204 on success.
    let client = http()?;
    let resp = client
        .patch(KICK_CHANNELS_URL)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "category_id": category_id }))
        .send()
        .map_err(|e| format!("Kick channel update failed: {}", e))?;

    match resp.status() {
        reqwest::StatusCode::UNAUTHORIZED => Ok(Outcome::Unauthorized),
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

fn push_kick(base_dir: &Path, config: &AppConfig, db: &ForgeDatabase, title: &str) {
    let kick_map = load_kick_map(base_dir);
    let Some(category_id) = resolve_kick_id(db, &kick_map, title) else {
        log::info!("[PUSH] Kick: no category id for \"{}\" — skipping", title);
        return;
    };

    match kick_push_once(category_id, &config.broadcaster.kick_token) {
        Ok(Outcome::Done) => {}
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
                        Ok(Outcome::Done) => {}
                        Ok(Outcome::Unauthorized) => {
                            log::warn!("[PUSH] Kick retry still unauthorized")
                        }
                        Err(e) => log::warn!("[PUSH] Kick retry failed: {}", e),
                    }
                }
                Err(e) => log::warn!("[PUSH] Kick token refresh failed: {}", e),
            }
        }
        Err(e) => log::warn!("[PUSH] {}", e),
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Public entry point
// ═══════════════════════════════════════════════════════════════════════════

/// Push `title` as the live category to every configured platform.
/// No-op unless routing_mode is Native. Never errors — failures are logged so
/// the engine loop keeps running.
pub fn push_category(base_dir: &Path, config: &AppConfig, db: &ForgeDatabase, title: &str) {
    if config.broadcaster.routing_mode != RoutingMode::Native {
        return;
    }
    let b = &config.broadcaster;
    if !b.twitch_token.is_empty() && !b.twitch_broadcaster_id.is_empty() {
        push_twitch(base_dir, config, db, title);
    }
    if !b.kick_token.is_empty() {
        push_kick(base_dir, config, db, title);
    }
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
