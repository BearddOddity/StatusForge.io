//! Best-effort parsing of emulator-owned log files, used to recover the
//! currently loaded game's title when an emulator's window title is empty.
//! Every path and line read here is something the emulator itself writes to
//! its own log file on the user's disk during normal operation — nothing
//! here touches the emulator's memory or the emulated game's state.

use std::path::{Path, PathBuf};

/// Candidate `emulog.txt` locations for a PCSX2 process at `exe_path`.
/// Portable installs keep `logs/emulog.txt` next to the executable; the
/// installed build writes into the user's Documents folder instead. Neither
/// location depends on which drive letter or folder the user installed to.
fn pcsx2_log_paths(exe_path: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Some(exe_dir) = Path::new(exe_path).parent() {
        paths.push(exe_dir.join("logs").join("emulog.txt"));
    }
    if let Some(docs) = documents_dir() {
        paths.push(docs.join("PCSX2").join("logs").join("emulog.txt"));
    }

    paths
}

#[cfg(target_os = "windows")]
fn documents_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")?;
    Some(PathBuf::from(home).join("Documents"))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn documents_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Documents"))
}

/// Strips PCSX2's `[   12.3456] ` timestamp prefix off a log line, if present.
fn strip_log_timestamp(line: &str) -> &str {
    match line.find(']') {
        Some(i) => line[i + 1..].trim_start(),
        None => line.trim_start(),
    }
}

/// Reads the title off the most recent `Name: <title>` line PCSX2 logs when
/// a disc loads. The log accumulates across every game booted in the
/// session, so the last match is the one currently running.
fn extract_pcsx2_title(log_contents: &str) -> Option<String> {
    log_contents.lines().rev().find_map(|line| {
        strip_log_timestamp(line)
            .strip_prefix("Name: ")
            .map(|title| title.trim().to_string())
            .filter(|title| !title.is_empty())
    })
}

/// Best-effort: find and parse the current game's title out of an emulator's
/// own log file. Returns `None` if the emulator isn't recognized, no log file
/// exists at any known location, or nothing matched — callers should treat
/// this purely as an extra fallback, never a hard dependency.
pub fn title_from_emulator_log(exe_name: &str, exe_path: &str) -> Option<String> {
    if !exe_name.contains("pcsx2") {
        return None;
    }
    pcsx2_log_paths(exe_path)
        .into_iter()
        .find_map(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| extract_pcsx2_title(&contents))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_LOG: &str = r#"[    0.0209] PCSX2 v2.6.3
[    0.1074] isoFile open ok: D:\PCSX2\games\Def Jam - Fight for NY.iso
[    1.8133] Disc changed to Def Jam - Fight for NY.iso.
[    1.8133]   Name: Def Jam - Fight for NY
[    1.8133]   Serial: SLUS-21004
[    1.8133]   Version: 1.00
[    1.8133]   CRC: 4538436F
[ 1491.6508] Disc changed to ATV Offroad Fury (v3.01).iso.
[ 1491.6508]   Name: ATV Offroad Fury
[ 1491.6508]   Serial: SCUS-97104
[ 1491.6509]   CRC: 70E7AF78
"#;

    #[test]
    fn extracts_most_recent_disc_name() {
        // Two games were loaded in this session; the later one (ATV Offroad
        // Fury) is the one actually running now.
        assert_eq!(
            extract_pcsx2_title(SAMPLE_LOG),
            Some("ATV Offroad Fury".to_string())
        );
    }

    #[test]
    fn no_name_line_returns_none() {
        assert_eq!(extract_pcsx2_title("[    0.0209] PCSX2 v2.6.3\n"), None);
    }

    #[test]
    fn empty_log_returns_none() {
        assert_eq!(extract_pcsx2_title(""), None);
    }

    #[test]
    fn non_pcsx2_exe_short_circuits_without_touching_disk() {
        // A path that doesn't exist would make read_to_string fail anyway,
        // but this confirms non-PCSX2 processes never even try.
        assert_eq!(
            title_from_emulator_log("dolphin.exe", "c:\\emulators\\dolphin.exe"),
            None
        );
    }
}
