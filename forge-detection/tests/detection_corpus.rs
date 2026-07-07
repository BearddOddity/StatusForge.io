//! Data-driven regression corpus for the detection waterfall.
//!
//! Each entry in `fixtures/detection_corpus.json` is a real-world-shaped
//! exe-name/window-title/path combination with the detection outcome it
//! must keep producing. Add a case here whenever a previously-working
//! title is found to have silently stopped matching — that's exactly the
//! class of bug unit tests on individual helpers don't catch, because the
//! break happens in how stages compose, not inside a single function.

use forge_detection::platform::ActiveWindow;
use forge_detection::waterfall::{ForgeWaterfall, ProcessSnapshot};
use forge_detection::ScannerConfig;
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize)]
struct Fixture {
    name: String,
    #[serde(default)]
    listed_apps: Vec<(String, String)>,
    #[serde(default)]
    delisted_apps: Vec<String>,
    #[serde(default)]
    strict_mode: bool,
    window_title: String,
    #[serde(default)]
    is_fullscreen: bool,
    #[serde(default = "default_rect")]
    rect: (i32, i32, i32, i32),
    exe_name: String,
    #[serde(default)]
    exe_path: String,
    #[serde(default = "default_memory_mb")]
    memory_mb: u64,
    #[serde(default)]
    cmdline: String,
    #[serde(default)]
    parent_name: String,
    expected: Option<ExpectedDetection>,
}

#[derive(Deserialize)]
struct ExpectedDetection {
    title: String,
    platform: String,
}

fn default_rect() -> (i32, i32, i32, i32) {
    (0, 0, 1920, 1080)
}

fn default_memory_mb() -> u64 {
    900
}

#[test]
fn detection_corpus_matches_expected_output() {
    let raw = include_str!("fixtures/detection_corpus.json");
    let fixtures: Vec<Fixture> =
        serde_json::from_str(raw).expect("fixtures/detection_corpus.json is not valid JSON");
    assert!(!fixtures.is_empty(), "detection corpus fixture is empty");

    let mut failures = Vec::new();
    for fx in &fixtures {
        let mut engine = ForgeWaterfall::new(Box::new(|_, _, _| {}));
        engine.update_forge_knowledge(
            fx.listed_apps.iter().cloned().collect::<HashMap<_, _>>(),
            fx.delisted_apps.clone(),
            fx.strict_mode,
            ScannerConfig::default(),
        );

        let window = ActiveWindow {
            pid: 4242,
            title: fx.window_title.clone(),
            is_fullscreen: fx.is_fullscreen,
            os_window_id: 1,
            rect: Some(fx.rect),
        };
        let proc = ProcessSnapshot {
            exe_name: fx.exe_name.clone(),
            exe_path: fx.exe_path.clone(),
            memory_mb: fx.memory_mb,
            cmdline: fx.cmdline.clone(),
            parent_name: fx.parent_name.clone(),
        };

        let got = engine.evaluate(&window, &proc);
        let matches = match (&got, &fx.expected) {
            (None, None) => true,
            (Some(d), Some(exp)) => d.title == exp.title && d.platform == exp.platform,
            _ => false,
        };

        if !matches {
            failures.push(format!(
                "{}: expected {:?}, got {:?}",
                fx.name,
                fx.expected
                    .as_ref()
                    .map(|e| (e.title.as_str(), e.platform.as_str())),
                got.map(|d| (d.title, d.platform))
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "detection regressions found ({} of {}):\n{}",
        failures.len(),
        fixtures.len(),
        failures.join("\n")
    );
}
