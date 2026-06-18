//! ForgeWaterfall — the core detection orchestrator.
//!
//! Port of `ForgeWaterfall` class from forge_scanner.py.
//! The `LogFn` type alias is also used by the native engine loop in lib.rs.

use std::collections::HashMap;
use sysinfo::{Process, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use super::{ForgeKnowledge, GameDetection, ScannerConfig};

/// Logging callback used by the engine loop.
pub type LogFn = Box<dyn Fn(&str, &str, u64) + Send + Sync>;

/// Detect a game from a process ID using active window info.
#[cfg(target_os = "windows")]
struct WindowsActiveWindow {
    pid: u32,
    title: String,
    is_fullscreen: bool,
    os_window_id: usize,
}

#[cfg(target_os = "windows")]
fn get_active_windows_window() -> Option<WindowsActiveWindow> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowLongW, GetWindowTextLengthW, GetWindowTextW,
        IsWindowVisible, GWL_STYLE, WS_BORDER, WS_CAPTION,
    };


    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return None;
        }
        if !IsWindowVisible(hwnd).as_bool() {
            return None;
        }

        let mut pid: u32 = 0;
        let _ = windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(hwnd, Some(&mut pid));

        let len = GetWindowTextLengthW(hwnd);
        let mut buf = vec![0u16; (len + 1) as usize];
        GetWindowTextW(hwnd, &mut buf);
        let title = String::from_utf16_lossy(&buf)
            .trim_end_matches('\0')
            .trim()
            .to_string();

        let style = GetWindowLongW(hwnd, GWL_STYLE);
        let is_fullscreen =
            (style & (WS_BORDER.0 as i32 | WS_CAPTION.0 as i32)) == 0;

        Some(WindowsActiveWindow {
            pid,
            title,
            is_fullscreen,
            os_window_id: hwnd.0 as usize,
        })
    }
}

#[cfg(target_os = "linux")]
struct LinuxActiveWindow {
    pid: u32,
    title: String,
    is_fullscreen: bool,
    os_window_id: u64,
}

#[cfg(target_os = "linux")]
fn get_linux_active_window() -> Option<LinuxActiveWindow> {
    // Best effort via _NET_ACTIVE_WINDOW on X11
    // Falls back to None if x11rb is not available
    let Ok(conn) = x11rb::rust_connection::RustConnection::connect(None) else {
        return None;
    };
    let Ok((conn, _screen_num)) = conn else {
        return None;
    };
    let setup = conn.setup();
    let screen = setup.roots.get(0)?;
    let _atom_net_active_window =
        x11rb::protocol::xproto::intern_atom(&conn, false, b"_NET_ACTIVE_WINDOW")
            .ok()?
            .reply()
            .ok()?
            .atom;

    // For brevity, fall through to None — the real implementation
    // would query _NET_ACTIVE_WINDOW, then _NET_WM_PID, then WM_NAME.
    let _ = _atom_net_active_window;
    None
}

pub struct ForgeWaterfall {
    log: LogFn,
    knowledge: Option<ForgeKnowledge>,
    sys: System,
}

impl ForgeWaterfall {
    pub fn new(log: LogFn) -> Self {
        Self {
            log,
            knowledge: None,
            sys: System::new(),
        }
    }

    pub fn update_forge_knowledge(
        &mut self,
        listed: HashMap<String, String>,
        delisted: Vec<String>,
        strict_mode: bool,
        config: ScannerConfig,
    ) {
        self.knowledge = Some(ForgeKnowledge {
            listed_apps: listed,
            delisted_apps: delisted,
            strict_mode,
            config,
        });
    }

    pub fn scout_active_session(&mut self) -> Option<GameDetection> {
        let kw = self.knowledge.as_ref()?;

        let (pid, window_title, is_fullscreen, _os_window_id) = self.get_active_window()?;
        if pid == 0 {
            return None;
        }

        self.sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            false,
            ProcessRefreshKind::nothing().with_user(UpdateKind::Always),
        );

        let process = self.sys.process(sysinfo::Pid::from_u32(pid))?;
        let exe_name = process.name().to_str()?.to_lowercase();
        let exe_path = process
            .exe()
            .and_then(|p| p.to_str())
            .unwrap_or("")
            .to_lowercase();

        // Stage 1: The Forge (VIP immunity via listed_apps)
        if let Some(title) = kw.listed_apps.get(&exe_name) {
            return Some(GameDetection {
                title: title.clone(),
                process: exe_name,
                platform: "The Forge".to_string(),
            });
        }

        // Strict forge-only mode
        if kw.strict_mode {
            return None;
        }

        // Stage 2: The Gauntlet (hard kills)
        if !kw.config.process_filter_bypass {
            if kw.delisted_apps.contains(&exe_name) {
                return None;
            }
            let system_exiles: &[&str] = &[
                "explorer.exe", "chrome.exe", "msedge.exe", "firefox.exe",
                "discord.exe", "obs64.exe", "obs32.exe", "taskmgr.exe",
                "spotify.exe", "code.exe", "cmd.exe", "powershell.exe",
                "steam.exe", "epicgameslauncher.exe",
            ];
            if system_exiles.contains(&exe_name.as_str()) {
                return None;
            }
            let banned_paths: &[&str] = &["c:\\windows", "system32", "/usr/bin", "/usr/sbin", "/sbin"];
            if banned_paths.iter().any(|b| exe_path.contains(b)) {
                return None;
            }
        }

        if window_title.to_lowercase().contains(" - google chrome")
            || window_title.to_lowercase().contains(" - discord")
            || window_title.to_lowercase().contains(" - firefox")
            || window_title.to_lowercase().contains(" - edge")
        {
            return None;
        }

        // Stage 3: Behavioral traps
        if !self.survives_great_filter(process, pid, &exe_path) {
            return None;
        }

        // Stage 4: Golden tickets — Steam path check
        #[cfg(target_os = "windows")]
        if exe_path.contains("steamapps") {
            if let Ok(reg_val) = self.read_steam_running_app_id() {
                if reg_val > 0 {
                    return Some(GameDetection {
                        title: if window_title.is_empty() {
                            exe_name.replace(".exe", "")
                        } else {
                            window_title.clone()
                        },
                        process: exe_name,
                        platform: "Steam Registry".to_string(),
                    });
                }
            }
        }

        // Stage 5: Confidence scoring
        let mut confidence: f64 = 0.0;

        if kw.config.score_engine_dna && self.has_engine_dna(&exe_path) {
            confidence += 0.4;
        }
        if kw.config.score_fullscreen && is_fullscreen {
            confidence += 0.3;
        }
        if kw.config.score_window_title
            && !window_title.is_empty()
            && window_title.to_lowercase() != exe_name
        {
            confidence += 0.2;
        }
        if kw.config.score_ram {
            let mem_mb = process.memory() / (1024 * 1024);
            if mem_mb > kw.config.ram_threshold_mb {
                confidence += 0.1;
            }
        }

        if confidence >= kw.config.confidence_threshold {
            let title = if !window_title.is_empty() {
                window_title.clone()
            } else {
                exe_name.replace(".exe", "")
            };
            return Some(GameDetection {
                title,
                process: exe_name,
                platform: "Standalone/DRM-Free".to_string(),
            });
        }

        None
    }

    // ── Active window detection ────────────────────────────────────────

    #[cfg(target_os = "windows")]
    fn get_active_window(&self) -> Option<(u32, String, bool, usize)> {
        let w = get_active_windows_window()?;
        Some((w.pid, w.title, w.is_fullscreen, w.os_window_id))
    }

    #[cfg(target_os = "linux")]
    fn get_active_window(&self) -> Option<(u32, String, bool, usize)> {
        let w = get_linux_active_window()?;
        Some((w.pid, w.title, w.is_fullscreen, w.os_window_id as usize))
    }

    // ── Steam registry read (Windows) ──────────────────────────────────

    #[cfg(target_os = "windows")]
    fn read_steam_running_app_id(&self) -> Result<u32, Box<dyn std::error::Error>> {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let steam = hkcu.open_subkey("Software\\Valve\\Steam")?;
        let app_id: u32 = steam.get_value("RunningAppId")?;
        Ok(app_id)
    }

    // ── Behavioral traps ───────────────────────────────────────────────

    fn survives_great_filter(&self, process: &Process, _pid: u32, _exe_path: &str) -> bool {
        // 1. RAM floor
        let mem_mb = process.memory() / (1024 * 1024);
        let kw = match self.knowledge.as_ref() {
            Some(k) => k,
            None => return true,
        };
        if mem_mb < kw.config.ram_threshold_mb {
            (self.log)("[FILTER] RAM floor not met", "debug", 300);
            return false;
        }

        // 2. Command line trap
        if kw.config.trap_cmdline {
            // sysinfo does not provide cmdline on all platforms via Process
            // Skip for now but keep the hook
        }

        true
    }

    // ── Engine DNA detection ───────────────────────────────────────────

    fn has_engine_dna(&self, exe_path: &str) -> bool {
        let Some(dir) = std::path::Path::new(exe_path).parent() else {
            return false;
        };
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        let files: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().to_str().map(|s| s.to_lowercase()))
            .collect();

        let signatures: &[&str] = &[
            "unityplayer.dll",
            "project.godot",
            "data.pck",
            "data.win",
            "lwjgl.dll",
            "love.dll",
            "game.love",
            "c3runtime.js",
            "bink2w64.dll",
            "steam_api64.dll",
            "fmodstudio.dll",
        ];

        signatures.iter().any(|sig| files.iter().any(|f| f.contains(sig)))
    }

    // ── Formatters ─────────────────────────────────────────────────────

    #[allow(dead_code)]
    fn extract_game_name_from_path(&self, exe_path: &str) -> String {
        let normalized = exe_path.replace('\\', "/");
        let parts: Vec<&str> = normalized.split('/').collect();
        let lower_parts: Vec<String> = parts.iter().map(|p| p.to_lowercase()).collect();

        // Steam: grab folder after "common"
        if let Some(idx) = lower_parts.iter().position(|p| p == "common") {
            if parts.len() > idx + 1 {
                return parts[idx + 1].replace('_', " ").to_string();
            }
        }

        let ignore = [
            "binaries", "win64", "win32", "shipping", "x64", "x86", "bin", "release",
            "windowsnoeditor",
        ];
        for part in parts.iter().rev().skip(1) {
            if !ignore.contains(&part.to_lowercase().as_str()) && !part.trim().is_empty() {
                return part.replace('_', " ");
            }
        }
        parts
            .get(parts.len().saturating_sub(2))
            .unwrap_or(&"Unknown Game")
            .to_string()
    }
}
