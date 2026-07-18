//! Post-broadcast detection feedback: "Is this detection correct? Yes / No".
//!
//! Confirmations and corrections get logged per detection method (the
//! source in `GameDetection.platform`, e.g. "Steam", "Blipy (host)") into
//! `detection_feedback.json`, so per-method accuracy shows up in Dev Tools.
//! A correction also teaches the alias system — the misdetected title
//! becomes an alias of the actual game, so it resolves correctly next time.
//!
//! Not auto-tuning the engine's score_* weights from this data yet — those
//! are user-visible settings, and silently rewriting them from a few clicks
//! seems worse than just showing the accuracy numbers.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Running accuracy tally for one detection method.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(default)]
pub struct MethodStats {
    pub confirmed: u64,
    pub corrected: u64,
}

impl MethodStats {
    /// 0.0–1.0 accuracy, or None with no data yet.
    pub fn accuracy(&self) -> Option<f64> {
        let total = self.confirmed + self.corrected;
        if total == 0 {
            return None;
        }
        Some(self.confirmed as f64 / total as f64)
    }
}

/// One logged correction — kept (bounded) so Dev Tools can show what was
/// misdetected as what, not just the counts.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(default)]
pub struct Correction {
    pub detected: String,
    pub actual: String,
    pub method: String,
    /// Zero-padded unix seconds (matches GameAlias::added_at).
    pub at: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(default)]
pub struct FeedbackStore {
    /// method name → tally
    pub methods: HashMap<String, MethodStats>,
    /// Most recent corrections, newest last, capped at MAX_CORRECTIONS.
    pub corrections: Vec<Correction>,
}

const MAX_CORRECTIONS: usize = 100;
const FEEDBACK_FILE: &str = "detection_feedback.json";

impl FeedbackStore {
    /// Apply one piece of feedback. `actual` is Some only for corrections.
    pub fn record(&mut self, detected: &str, method: &str, actual: Option<&str>, now_secs: u64) {
        let stats = self.methods.entry(method.to_string()).or_default();
        match actual {
            None => stats.confirmed += 1,
            Some(actual) => {
                stats.corrected += 1;
                self.corrections.push(Correction {
                    detected: detected.to_string(),
                    actual: actual.to_string(),
                    method: method.to_string(),
                    at: format!("{:010}", now_secs),
                });
                if self.corrections.len() > MAX_CORRECTIONS {
                    let excess = self.corrections.len() - MAX_CORRECTIONS;
                    self.corrections.drain(..excess);
                }
            }
        }
    }
}

pub fn load(base_dir: &Path) -> FeedbackStore {
    std::fs::read_to_string(base_dir.join(FEEDBACK_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(base_dir: &Path, store: &FeedbackStore) -> Result<(), String> {
    let path = base_dir.join(FEEDBACK_FILE);
    let raw = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize feedback: {}", e))?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, raw).map_err(|e| format!("Failed to write feedback temp: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Failed to rename feedback file: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirmations_and_corrections_tally_per_method() {
        let mut s = FeedbackStore::default();
        s.record("Hades", "Steam", None, 100);
        s.record("Hades", "Steam", None, 110);
        s.record("HadesII.exe", "Window Title", Some("Hades II"), 120);

        assert_eq!(s.methods["Steam"].confirmed, 2);
        assert_eq!(s.methods["Steam"].corrected, 0);
        assert_eq!(s.methods["Steam"].accuracy(), Some(1.0));
        assert_eq!(s.methods["Window Title"].corrected, 1);
        assert_eq!(s.methods["Window Title"].accuracy(), Some(0.0));
        assert_eq!(s.corrections.len(), 1);
        assert_eq!(s.corrections[0].actual, "Hades II");
    }

    #[test]
    fn accuracy_is_none_without_data() {
        assert_eq!(MethodStats::default().accuracy(), None);
    }

    #[test]
    fn corrections_are_capped() {
        let mut s = FeedbackStore::default();
        for i in 0..(MAX_CORRECTIONS + 25) {
            s.record(&format!("wrong{}", i), "m", Some("right"), i as u64);
        }
        assert_eq!(s.corrections.len(), MAX_CORRECTIONS);
        // Oldest entries were dropped, newest kept.
        assert_eq!(s.corrections.last().unwrap().detected, "wrong124");
        assert_eq!(s.corrections[0].detected, "wrong25");
    }

    #[test]
    fn store_roundtrips_through_json() {
        let mut s = FeedbackStore::default();
        s.record("A", "Steam", None, 1);
        s.record("B", "RAM", Some("C"), 2);
        let json = serde_json::to_string(&s).unwrap();
        let back: FeedbackStore = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
    }
}
