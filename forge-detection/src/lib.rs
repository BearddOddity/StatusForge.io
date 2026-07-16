//! forge-detection — game detection engine (`GameDetector`).
//!
//! Standalone library crate shared by StatusForge (single-PC local detection),
//! Blipy (the dual-PC gaming-side agent), and StreamerSuite. No Tauri, axum,
//! keyring, or OAuth dependencies — just `serde`, `sysinfo`, and per-OS crates.
//! The host app owns all I/O: it loads the game database and feeds it in via
//! [`waterfall::GameDetector::update_forge_knowledge`], and it controls
//! logging through the [`waterfall::LogFn`] callback.
//!
//! Multi-stage detection pipeline:
//! 1. Active window / foreground process identification (OS-specific)
//! 2. Forge database lookup (listed apps = instant match)
//! 3. System exiles + banned paths filter
//! 4. Behavioral traps (RAM floor, Chromium/Electron, cmdline, UI framework, geometry)
//! 5. Steam registry / process tree checks
//! 6. Confidence scoring for DRM-free / indie games
//!
//! Platform support: Windows, macOS, and Linux — no sidecar process.
//! On macOS, reading window titles requires the Screen Recording permission;
//! see `platform::permission_error`.

pub mod alias;
pub mod emulator_logs;
pub mod platform;
pub mod waterfall;

pub use waterfall::{GameDetector, LogFn};

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A detected game session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GameDetection {
    pub title: String,
    pub process: String,
    pub platform: String,
}

/// Scanner configuration — mirrors engine_settings from Config.json
#[derive(Debug, Clone)]
pub struct ScannerConfig {
    pub ram_threshold_mb: u64,
    pub confidence_threshold: f64,
    pub emulator_detection: bool,
    pub process_filter_bypass: bool,
    pub trap_chromium: bool,
    pub trap_cmdline: bool,
    pub trap_ui_framework: bool,
    pub trap_geometry: bool,
    pub score_engine_dna: bool,
    pub score_fullscreen: bool,
    pub score_window_title: bool,
    pub score_ram: bool,
}

impl Default for ScannerConfig {
    fn default() -> Self {
        Self {
            ram_threshold_mb: 80,
            confidence_threshold: 0.5,
            emulator_detection: true,
            process_filter_bypass: false,
            trap_chromium: true,
            trap_cmdline: true,
            trap_ui_framework: true,
            trap_geometry: true,
            score_engine_dna: true,
            score_fullscreen: true,
            score_window_title: true,
            score_ram: true,
        }
    }
}

/// Shared knowledge base synced from the Forge database.
pub struct ForgeKnowledge {
    pub listed_apps: HashMap<String, String>,
    pub delisted_apps: Vec<String>,
    pub strict_mode: bool,
    pub config: ScannerConfig,
}
