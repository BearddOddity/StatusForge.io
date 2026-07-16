//! Dual-PC LAN path test without two machines: runs the Hub packet handler
//! against a real SPARK-style sender over localhost UDP.
//!
//! Asserts that a signed, correct-PIN heartbeat updates Hub status, and that
//! wrong-PIN / bad-signature / legacy-unsigned packets are rejected.

use std::net::UdpSocket;
use std::sync::Arc;
use std::time::Duration;

use app_lib::hub::{handle_packet, HubState};
use app_lib::spark_protocol::{build_heartbeat, Heartbeat, HeartbeatError};
use app_lib::EngineState;

const PIN: &str = "4242";
const KEY: &str = "pairing-key";

/// Send `payload` over a real localhost UDP socket pair and return the bytes
/// the "Hub" socket received.
fn udp_roundtrip(payload: &[u8]) -> Vec<u8> {
    let hub_socket = UdpSocket::bind("127.0.0.1:0").expect("bind hub socket");
    hub_socket
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let hub_addr = hub_socket.local_addr().unwrap();

    let spark_socket = UdpSocket::bind("127.0.0.1:0").expect("bind spark socket");
    spark_socket
        .send_to(payload, hub_addr)
        .expect("send heartbeat");

    let mut buf = [0u8; 2048];
    let (len, _) = hub_socket.recv_from(&mut buf).expect("receive heartbeat");
    buf[..len].to_vec()
}

#[test]
fn valid_heartbeat_updates_hub_status_over_udp() {
    let hub = HubState::new();
    let engine = Arc::new(EngineState::default());

    let hb = build_heartbeat(
        "GAMING-PC",
        Some("ELDEN RING"),
        Some("eldenring.exe"),
        PIN,
        KEY,
    );
    let wire = serde_json::to_vec(&hb).unwrap();
    let received = udp_roundtrip(&wire);

    let accepted: Heartbeat =
        handle_packet(&hub, &engine, &received, PIN, KEY, None).expect("valid heartbeat accepted");
    assert_eq!(accepted.hostname, "GAMING-PC");

    // Hub pairing state updated
    let paired = hub.paired.lock().unwrap().clone().expect("paired");
    assert_eq!(paired.hostname, "GAMING-PC");
    assert_eq!(paired.game.as_deref(), Some("ELDEN RING"));

    // Fed into the same status path the local native engine uses
    let game = engine
        .current_game
        .lock()
        .unwrap()
        .clone()
        .expect("game set");
    assert_eq!(game.title, "ELDEN RING");
    assert_eq!(game.process, "eldenring.exe");
    assert!(game.platform.starts_with("SPARK"));
    assert!(*engine.is_playing.lock().unwrap());

    // Idle heartbeat clears the SPARK-sourced game
    let idle = build_heartbeat("GAMING-PC", None, None, PIN, KEY);
    let wire = serde_json::to_vec(&idle).unwrap();
    handle_packet(&hub, &engine, &udp_roundtrip(&wire), PIN, KEY, None).expect("idle accepted");
    assert!(engine.current_game.lock().unwrap().is_none());
    assert!(!*engine.is_playing.lock().unwrap());
}

#[test]
fn wrong_pin_heartbeat_is_rejected() {
    let hub = HubState::new();
    let engine = Arc::new(EngineState::default());

    let hb = build_heartbeat(
        "EVIL-PC",
        Some("Spoofed Game"),
        Some("evil.exe"),
        "9999",
        KEY,
    );
    let wire = serde_json::to_vec(&hb).unwrap();

    let err = handle_packet(&hub, &engine, &udp_roundtrip(&wire), PIN, KEY, None).unwrap_err();
    assert_eq!(err, HeartbeatError::WrongPin);
    assert!(hub.paired.lock().unwrap().is_none());
    assert!(engine.current_game.lock().unwrap().is_none());
    assert_eq!(*hub.rejected.lock().unwrap(), 1);
}

#[test]
fn bad_signature_heartbeat_is_rejected() {
    let hub = HubState::new();
    let engine = Arc::new(EngineState::default());

    // Correct PIN but signed with the wrong pairing key, then tampered game.
    let mut hb = build_heartbeat("EVIL-PC", Some("Real Game"), Some("g.exe"), PIN, KEY);
    hb.game = Some("Spoofed Game".to_string());
    let wire = serde_json::to_vec(&hb).unwrap();

    let err = handle_packet(&hub, &engine, &udp_roundtrip(&wire), PIN, KEY, None).unwrap_err();
    assert_eq!(err, HeartbeatError::BadSignature);
    assert!(hub.paired.lock().unwrap().is_none());
    assert!(engine.current_game.lock().unwrap().is_none());
}

#[test]
fn legacy_unsigned_v1_packet_is_rejected_gracefully() {
    let hub = HubState::new();
    let engine = Arc::new(EngineState::default());

    let legacy = br#"{"app":"StatusForge_Spark","hostname":"OLD-PC","game":"X","process":"x.exe","pin":"4242","command":"heartbeat"}"#;
    let err = handle_packet(&hub, &engine, &udp_roundtrip(legacy), PIN, KEY, None).unwrap_err();
    assert_eq!(err, HeartbeatError::VersionMismatch(1));
}
