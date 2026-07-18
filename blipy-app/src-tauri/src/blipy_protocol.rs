//! Blipy ⇄ Hub LAN wire protocol (UDP).
//!
//! NOTE: an identical copy of this file lives in `blipy-app/src-tauri/src/`.
//! Keep the two in sync when bumping `PROTOCOL_VERSION`.
//!
//! Ports:
//! - **53735/udp** — Blipy → Hub heartbeats (broadcast)
//! - **53736/udp** — Hub → Blipy discovery announcements (broadcast)
//!
//! v1 (legacy Python prototype, spark.py — predates the Blipy rename):
//! `{app, hostname, game, process, pin, command}`
//! v2 (current): adds `version`, `timestamp`, and an HMAC-SHA256 signature so
//! nobody on the LAN can spoof a fake game onto the overlay. Fields are
//! additive — a v2 Hub logs-and-rejects v1 packets instead of misbehaving.
//! The `app` identifier changed from "StatusForge_Spark" to
//! "StatusForge_Blipy" with the rename; both are still recognized as valid
//! heartbeats so a genuinely old v1 client gets a clear version-mismatch
//! error instead of being treated as garbage.

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

/// Current LAN protocol version.
pub const PROTOCOL_VERSION: u32 = 2;

/// Blipy → Hub heartbeat port.
pub const HEARTBEAT_PORT: u16 = 53735;
/// Hub → Blipy discovery port.
pub const DISCOVERY_PORT: u16 = 53736;

/// Blipy → Hub heartbeat packet.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Heartbeat {
    pub app: String,
    #[serde(default)]
    pub version: Option<u32>,
    pub hostname: String,
    /// Detected game title (None when idle)
    pub game: Option<String>,
    /// Detected process name (None when idle)
    pub process: Option<String>,
    pub pin: String,
    pub command: String,
    #[serde(default)]
    pub timestamp: Option<f64>,
    /// hex(HMAC-SHA256(secret, canonical_string()))
    #[serde(default)]
    pub hmac: Option<String>,
}

/// Hub → Blipy discovery packet.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubAnnounce {
    pub app: String,
    pub hub_name: String,
    #[serde(default)]
    pub version: Option<u32>,
}

#[derive(Debug, PartialEq)]
pub enum HeartbeatError {
    NotAHeartbeat,
    VersionMismatch(u32),
    WrongPin,
    MissingSignature,
    BadSignature,
}

impl std::fmt::Display for HeartbeatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAHeartbeat => write!(f, "not a Blipy heartbeat"),
            Self::VersionMismatch(v) => write!(f, "protocol version {} not supported", v),
            Self::WrongPin => write!(f, "wrong PIN"),
            Self::MissingSignature => write!(f, "missing HMAC signature"),
            Self::BadSignature => write!(f, "invalid HMAC signature"),
        }
    }
}

/// Shared secret for the pairing: the 4-digit PIN plus an optional user-set
/// pairing key. Both sides must configure the same values.
pub fn shared_secret(pin: &str, pairing_key: &str) -> String {
    format!("{}:{}", pin, pairing_key)
}

/// Deterministic string the HMAC is computed over (field order is fixed;
/// never reorder without bumping PROTOCOL_VERSION).
fn canonical_string(hb: &Heartbeat) -> String {
    format!(
        "{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
        hb.app,
        hb.version.unwrap_or(0),
        hb.hostname,
        hb.game.as_deref().unwrap_or(""),
        hb.process.as_deref().unwrap_or(""),
        hb.pin,
        hb.command,
        hb.timestamp
            .map(|t| format!("{:.3}", t))
            .unwrap_or_default(),
    )
}

fn compute_hmac(hb: &Heartbeat, secret: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(canonical_string(hb).as_bytes());
    hex_encode(&mac.finalize().into_bytes())
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Build a signed v2 heartbeat (used by Blipy).
pub fn build_heartbeat(
    hostname: &str,
    game: Option<&str>,
    process: Option<&str>,
    pin: &str,
    pairing_key: &str,
) -> Heartbeat {
    let mut hb = Heartbeat {
        app: "StatusForge_Blipy".to_string(),
        version: Some(PROTOCOL_VERSION),
        hostname: hostname.to_string(),
        game: game.map(|s| s.to_string()),
        process: process.map(|s| s.to_string()),
        pin: pin.to_string(),
        command: "heartbeat".to_string(),
        timestamp: Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64(),
        ),
        hmac: None,
    };
    hb.hmac = Some(compute_hmac(&hb, &shared_secret(pin, pairing_key)));
    hb
}

/// Parse + authenticate an incoming heartbeat (used by the Hub).
/// Rejects non-heartbeats, protocol mismatches, wrong PINs, and packets
/// with a missing or invalid HMAC.
pub fn validate_heartbeat(
    data: &[u8],
    expected_pin: &str,
    pairing_key: &str,
) -> Result<Heartbeat, HeartbeatError> {
    let hb: Heartbeat = serde_json::from_slice(data).map_err(|_| HeartbeatError::NotAHeartbeat)?;
    let is_known_app = hb.app == "StatusForge_Blipy" || hb.app == "StatusForge_Spark";
    if !is_known_app || hb.command != "heartbeat" {
        return Err(HeartbeatError::NotAHeartbeat);
    }
    match hb.version {
        Some(v) if v == PROTOCOL_VERSION => {}
        Some(v) => return Err(HeartbeatError::VersionMismatch(v)),
        None => return Err(HeartbeatError::VersionMismatch(1)),
    }
    if hb.pin != expected_pin {
        return Err(HeartbeatError::WrongPin);
    }
    let Some(sig) = hb.hmac.as_deref() else {
        return Err(HeartbeatError::MissingSignature);
    };
    // Verify via the hmac crate's constant-time comparison.
    let mut mac =
        Hmac::<Sha256>::new_from_slice(shared_secret(expected_pin, pairing_key).as_bytes())
            .expect("HMAC accepts any key length");
    mac.update(canonical_string(&hb).as_bytes());
    let sig_bytes = hex_decode(sig).ok_or(HeartbeatError::BadSignature)?;
    if mac.verify_slice(&sig_bytes).is_err() {
        return Err(HeartbeatError::BadSignature);
    }
    Ok(hb)
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_heartbeat_roundtrip() {
        let hb = build_heartbeat(
            "GAMING-PC",
            Some("ELDEN RING"),
            Some("eldenring.exe"),
            "4242",
            "key",
        );
        let bytes = serde_json::to_vec(&hb).unwrap();
        let out = validate_heartbeat(&bytes, "4242", "key").unwrap();
        assert_eq!(out.game.as_deref(), Some("ELDEN RING"));
        assert_eq!(out.hostname, "GAMING-PC");
    }

    #[test]
    fn wrong_pin_rejected() {
        let hb = build_heartbeat("PC", None, None, "1111", "");
        let bytes = serde_json::to_vec(&hb).unwrap();
        assert_eq!(
            validate_heartbeat(&bytes, "2222", "").unwrap_err(),
            HeartbeatError::WrongPin
        );
    }

    #[test]
    fn wrong_pairing_key_rejected() {
        let hb = build_heartbeat("PC", Some("Game"), Some("g.exe"), "4242", "alpha");
        let bytes = serde_json::to_vec(&hb).unwrap();
        assert_eq!(
            validate_heartbeat(&bytes, "4242", "beta").unwrap_err(),
            HeartbeatError::BadSignature
        );
    }

    #[test]
    fn tampered_payload_rejected() {
        let mut hb = build_heartbeat("PC", Some("Real Game"), Some("g.exe"), "4242", "");
        hb.game = Some("Spoofed Game".to_string()); // tamper after signing
        let bytes = serde_json::to_vec(&hb).unwrap();
        assert_eq!(
            validate_heartbeat(&bytes, "4242", "").unwrap_err(),
            HeartbeatError::BadSignature
        );
    }

    #[test]
    fn old_branded_v2_client_still_pairs_during_the_rename() {
        // An agent that hasn't updated past the SPARK -> Blipy rename yet
        // still sends a fully valid, signed v2 packet -- just under the old
        // app name. The Hub (already updated) must still accept it.
        let mut hb = build_heartbeat("PC", Some("Celeste"), Some("celeste.exe"), "4242", "");
        hb.app = "StatusForge_Spark".to_string();
        hb.hmac = None;
        hb.hmac = Some(compute_hmac(&hb, &shared_secret("4242", "")));
        let bytes = serde_json::to_vec(&hb).unwrap();
        let out = validate_heartbeat(&bytes, "4242", "").unwrap();
        assert_eq!(out.game.as_deref(), Some("Celeste"));
    }

    #[test]
    fn legacy_v1_packet_rejected_gracefully() {
        let legacy = br#"{"app":"StatusForge_Spark","hostname":"PC","game":"X","process":"x.exe","pin":"4242","command":"heartbeat"}"#;
        assert_eq!(
            validate_heartbeat(legacy, "4242", "").unwrap_err(),
            HeartbeatError::VersionMismatch(1)
        );
    }

    #[test]
    fn unsigned_v2_packet_rejected() {
        let unsigned = br#"{"app":"StatusForge_Spark","version":2,"hostname":"PC","game":"X","process":"x.exe","pin":"4242","command":"heartbeat"}"#;
        assert_eq!(
            validate_heartbeat(unsigned, "4242", "").unwrap_err(),
            HeartbeatError::MissingSignature
        );
    }

    #[test]
    fn garbage_rejected() {
        assert_eq!(
            validate_heartbeat(b"not json", "0000", "").unwrap_err(),
            HeartbeatError::NotAHeartbeat
        );
    }
}
