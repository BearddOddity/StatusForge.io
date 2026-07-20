//! GameDetector — the core detection orchestrator.
//!
//! Staged detection pipeline:
//!
//! 1. Active window / foreground process identification (OS-specific)
//! 2. listed_apps VIP lookup (instant match)
//! 3. delisted apps, system exiles, banned paths, browser titles
//! 4. behavioral traps (RAM floor, Chromium/Electron,
//!    cmdline flags, desktop UI frameworks, window geometry)
//! 5. Steam running-app id, wrapper/launcher parent process
//! 6. Confidence scoring for DRM-free / indie games
//!
//! The `LogFn` type alias is also used by the engine loop in the host app.

use std::collections::HashMap;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use crate::platform::{self, ActiveWindow};
use crate::{ForgeKnowledge, GameDetection, ScannerConfig};

/// Logging callback used by the engine loop. (message, level, cooldown_secs)
pub type LogFn = Box<dyn Fn(&str, &str, u64) + Send + Sync>;

const SYSTEM_EXILES: &[&str] = &[
    "explorer.exe",
    // Web browsers — we don't detect websites, only real game processes.
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "brave.exe",
    "opera.exe",
    "opera_gx.exe",
    "vivaldi.exe",
    "iexplore.exe",
    "chromium.exe",
    "safari.exe",
    "discord.exe",
    "obs64.exe",
    "obs32.exe",
    "taskmgr.exe",
    "systemsettings.exe",
    "spotify.exe",
    "code.exe",
    "cmd.exe",
    "powershell.exe",
    "steam.exe",
    "epicgameslauncher.exe",
    "bash",
    "zsh",
    "gnome-shell",
    "plasma-desktop",
    "finder",
    "dock",
];

const BANNED_PATHS: &[&str] = &["c:\\windows", "system32", "/usr/bin", "/usr/sbin", "/sbin"];

/// Window titles of built-in Windows UWP apps that also run under
/// ApplicationFrameHost.exe (same host process as real Xbox Game Pass
/// titles, which is why we pierce through it at all — see the Xbox Game
/// Pass / UWP piercer below). Without this exclusion list, opening any of
/// these gets misdetected as "a running game" and the user has to manually
/// exile it after the fact; matching ignores case since Windows doesn't
/// guarantee title casing across versions/locales.
const UWP_SYSTEM_APP_TITLES: &[&str] = &[
    "settings",
    "microsoft store",
    "store",
    "mail",
    "calendar",
    "calculator",
    "photos",
    "maps",
    "weather",
    "news",
    "xbox console companion",
    "xbox",
    "feedback hub",
    "clock",
    "alarms & clock",
    "movies & tv",
    "groove music",
    "people",
    "voice recorder",
    "tips",
    "get help",
    "phone link",
    "your phone",
    "snip & sketch",
    "sticky notes",
    "paint 3d",
    "film & tv",
    "solitaire collection",
];

const ENGINE_DNA: &[&str] = &[
    // Unity
    "unityplayer.dll",
    "globalgamemanagers",
    // Godot
    "project.godot",
    "data.pck",
    // GameMaker
    "data.win",
    "audiogroup1.dat",
    // Ren'Py
    "archive.rpa",
    "scripts.rpa",
    // RPG Maker
    "game.rgss3a",
    "game.rgss2a",
    "game.rxdata",
    "rpg_core.js",
    // Java
    "lwjgl.dll",
    "lwjgl64.dll",
    "liblwjgl.so",
    // Lua / LÖVE
    "love.dll",
    "game.love",
    // Construct / HTML5
    "c3runtime.js",
    "package.nw",
    // Proprietary AAA
    "bink2w64.dll",
    "oo2core_",
    "steam_api64.dll",
    "fmodstudio.dll",
];

const EMULATOR_TAGS: &[&str] = &[
    "retroarch",
    "yuzu",
    "ryujinx",
    "pcsx2",
    "rpcs3",
    "dolphin",
    "cemu",
    "citra",
    "ppsspp",
];

/// Built-in exe-name → canonical-title corrections for games whose process
/// name or raw window title is misleading (slang/abbreviated exe names,
/// missing spacing, etc.). Checked as an always-on extension of the user's
/// `listed_apps`, so these get an instant Stage-1 match — the confidence
/// traps and window-title guessing never see them.
const KNOWN_EXE_TITLE_ALIASES: &[(&str, &str)] = &[
    ("gtaiv.exe", "Grand Theft Auto IV"),
    ("funkofusion.exe", "Funko Fusion"),
    ("falloutnv.exe", "Fallout New Vegas"),
    ("3dat.exe", "3D Aim Trainer"),
    ("aimlab_tb.exe", "Aimlabs"),
];

fn known_exe_title_alias(exe_name: &str) -> Option<&'static str> {
    KNOWN_EXE_TITLE_ALIASES
        .iter()
        .find(|(exe, _)| *exe == exe_name)
        .map(|(_, title)| *title)
}

/// Built-in window-title corrections for games that append a build/version
/// tag or a trademark glyph to their window title, matched case-insensitively
/// against the full (trimmed) title.
const KNOWN_WINDOW_TITLE_ALIASES: &[(&str, &str)] = &[
    ("alan wake - v1.07.33.72514", "Alan Wake"),
    ("apb reloaded (64-bit, pc-d3d-sm3)", "APB Reloaded"),
    (
        "call of duty® infinite warfare",
        "Call of Duty: Infinite Warfare",
    ),
];

fn known_window_title_alias(window_title: &str) -> Option<&'static str> {
    let normalized = window_title.trim().to_lowercase();
    KNOWN_WINDOW_TITLE_ALIASES
        .iter()
        .find(|(raw, _)| *raw == normalized)
        .map(|(_, title)| *title)
}

/// Windows appends " (Not Responding)" to a window's title while it's hung.
/// Left as-is, a hung game would get scanned/cover-cached under a distinct
/// title and create a duplicate library entry alongside the real one, so
/// this is stripped before the title is used anywhere else.
fn strip_not_responding_suffix(title: &str) -> &str {
    const SUFFIX: &str = " (not responding)";
    let trimmed = title.trim_end();
    if trimmed.len() >= SUFFIX.len()
        && trimmed[trimmed.len() - SUFFIX.len()..].eq_ignore_ascii_case(SUFFIX)
    {
        trimmed[..trimmed.len() - SUFFIX.len()].trim_end()
    } else {
        trimmed
    }
}

const GENERIC_EXE_NAMES: &[&str] = &[
    "game.exe",
    "win64-shipping",
    "start.exe",
    "play.exe",
    "application.exe",
    "runner",
    "binaries",
];

/// Snapshot of the foreground process, decoupled from `sysinfo` for testability.
#[derive(Debug, Clone, Default)]
pub struct ProcessSnapshot {
    /// Lowercased executable name, e.g. "eldenring.exe"
    pub exe_name: String,
    /// Lowercased full executable path (may be empty)
    pub exe_path: String,
    /// Resident memory in MiB
    pub memory_mb: u64,
    /// Lowercased joined command line (may be empty)
    pub cmdline: String,
    /// Lowercased parent process name (may be empty)
    pub parent_name: String,
}

pub struct GameDetector {
    log: LogFn,
    knowledge: Option<ForgeKnowledge>,
    sys: System,
}

impl GameDetector {
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

    /// Some(message) when the OS denies window inspection (macOS Screen
    /// Recording permission). The host app should surface this to the user.
    pub fn permission_error(&self) -> Option<String> {
        platform::permission_error()
    }

    /// Run one full detection pass against the current foreground window.
    pub fn scout_active_session(&mut self) -> Option<GameDetection> {
        self.knowledge.as_ref()?;

        let window = platform::get_active_window()?;
        if window.pid == 0 {
            return None;
        }

        // Targeted refresh: only the foreground pid, only the fields we need.
        let pid = sysinfo::Pid::from_u32(window.pid);
        self.sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing()
                .with_memory()
                .with_exe(UpdateKind::Always)
                .with_cmd(UpdateKind::Always),
        );
        let process = self.sys.process(pid)?;

        let parent_name = process
            .parent()
            .and_then(|ppid| self.sys.process(ppid))
            .and_then(|p| p.name().to_str())
            .unwrap_or("")
            .to_lowercase();

        let snapshot = ProcessSnapshot {
            exe_name: process.name().to_str()?.to_lowercase(),
            exe_path: process
                .exe()
                .and_then(|p| p.to_str())
                .unwrap_or("")
                .to_lowercase(),
            memory_mb: process.memory() / (1024 * 1024),
            cmdline: process
                .cmd()
                .iter()
                .filter_map(|s| s.to_str())
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase(),
            parent_name,
        };

        self.evaluate(&window, &snapshot)
    }

    /// Pure(ish) pipeline evaluation — separated from OS collection for tests.
    pub fn evaluate(&self, window: &ActiveWindow, proc: &ProcessSnapshot) -> Option<GameDetection> {
        let kw = self.knowledge.as_ref()?;
        let exe_name = &proc.exe_name;
        let exe_path = &proc.exe_path;
        let window_title = strip_not_responding_suffix(window.title.as_str());

        // ── Stage 1: (listed_apps + built-in title corrections) ────────
        // Built-in aliases are checked alongside the user's own listed_apps
        // so well-known games whose exe name or window title is misleading
        // (slang exe names, trademark glyphs, build-version suffixes) get an
        // instant, confident match instead of falling through to
        // window-title guessing or being trapped by the confidence traps.
        if let Some(title) = kw
            .listed_apps
            .get(exe_name)
            .map(|s| s.as_str())
            .or_else(|| known_exe_title_alias(exe_name))
        {
            (self.log)(
                &format!(
                    "[MATCH] Stage 1 listed_apps/alias: \"{}\" -> \"{}\"",
                    exe_name, title
                ),
                "debug",
                60,
            );
            return Some(format_game_output(
                exe_name,
                exe_path,
                title,
                "The Forge",
                kw.config.emulator_detection,
            ));
        }

        // Strict forge-only mode kills the scan immediately if not listed.
        if kw.strict_mode {
            return None;
        }

        // ── Xbox Game Pass / UWP piercer ───────────────────────────────────
        if exe_name == "applicationframehost.exe" && !window_title.is_empty() {
            // Built-in Windows apps (Settings, Calculator, Mail, the Store,
            // ...) are also hosted by ApplicationFrameHost.exe — without this
            // exclusion, opening any of them gets pierced straight through as
            // a running game instead of falling through to the browser/system
            // exile checks below.
            let title_norm = window_title.trim().to_lowercase();
            if UWP_SYSTEM_APP_TITLES
                .iter()
                .any(|t| title_norm == *t)
            {
                return None;
            }
            (self.log)(
                &format!("[MATCH] Xbox Game Pass piercer: \"{}\"", window_title),
                "debug",
                60,
            );
            return Some(format_game_output(
                exe_name,
                exe_path,
                window_title,
                "Xbox Game Pass",
                kw.config.emulator_detection,
            ));
        }

        // ── Stage 2:(hard kills) ─────────────────────────────
        if !kw.config.process_filter_bypass {
            if kw.delisted_apps.contains(exe_name) || SYSTEM_EXILES.contains(&exe_name.as_str()) {
                (self.log)(
                    &format!("[FILTER] \"{}\" is delisted or a system exile", exe_name),
                    "debug",
                    300,
                );
                return None;
            }
            if BANNED_PATHS.iter().any(|b| exe_path.contains(b)) {
                (self.log)(
                    &format!("[FILTER] \"{}\" is a banned path", exe_path),
                    "debug",
                    300,
                );
                return None;
            }
        }
        let title_lower = window_title.to_lowercase();
        if [
            " - google chrome",
            " - discord",
            " - firefox",
            " - edge",
            " - youtube",
            " - brave",
            " - opera",
            " - vivaldi",
        ]
        .iter()
        .any(|s| title_lower.contains(s))
        {
            (self.log)(
                &format!("[FILTER] Browser/chat window title: \"{}\"", window_title),
                "debug",
                300,
            );
            return None;
        }

        // ── Known emulator passthrough ─────────────────────────────────────
        // Most emulator UIs are built on Qt or wxWidgets — exactly what the
        // UI-framework trap below exists to filter out. Recognizing the
        // process by name here, before that trap runs, means PCSX2/Dolphin/
        // RPCS3/etc. don't get silently dropped as if they were some generic
        // desktop utility.
        if kw.config.emulator_detection && EMULATOR_TAGS.iter().any(|emu| exe_name.contains(emu)) {
            // Window title usually has the loaded game once one's running;
            // if it's empty (menu screen, or a build/config that never sets
            // one), fall back to the emulator's own log file (e.g. PCSX2's
            // emulog.txt logs the disc name on load), then to its launch
            // arguments — still just files/metadata the OS and the emulator
            // itself already produce, nothing reaching into the emulator or
            // the game.
            let rom_title = window_title
                .is_empty()
                .then(|| {
                    crate::emulator_logs::title_from_emulator_log(exe_name, exe_path)
                        .or_else(|| extract_rom_name_from_cmdline(&proc.cmdline))
                })
                .flatten();
            let effective_title = rom_title.as_deref().unwrap_or(window_title);
            (self.log)(
                &format!(
                    "[MATCH] Known emulator \"{}\": title=\"{}\"",
                    exe_name, effective_title
                ),
                "debug",
                60,
            );
            return Some(format_game_output(
                exe_name,
                exe_path,
                effective_title,
                "Emulator",
                kw.config.emulator_detection,
            ));
        }

        // ── Stage 3: (behavioral traps) ───────────────────
        if !self.survives_behavioral_traps(window, proc, &kw.config) {
            return None;
        }

        // ── Stage 4: (authoritative proof) ──────────────────
        if exe_path.contains("steamapps") {
            if let Some(app_id) = platform::read_steam_running_app_id() {
                if app_id > 0 {
                    (self.log)(
                        &format!("[MATCH] Steam Registry app_id={}: \"{}\"", app_id, exe_name),
                        "debug",
                        60,
                    );
                    return Some(format_game_output(
                        exe_name,
                        exe_path,
                        window_title,
                        "Steam Registry",
                        kw.config.emulator_detection,
                    ));
                }
            }
        }

        #[cfg(target_os = "linux")]
        {
            if let Some(platform_tag) = linux_launch_context(window.pid) {
                (self.log)(
                    &format!(
                        "[MATCH] Linux launch context ({}): \"{}\"",
                        platform_tag, exe_name
                    ),
                    "debug",
                    60,
                );
                return Some(format_game_output(
                    exe_name,
                    exe_path,
                    window_title,
                    &platform_tag,
                    kw.config.emulator_detection,
                ));
            }
        }

        // Process-tree parent check: Proton/Wine wrappers and official launchers
        if !proc.parent_name.is_empty() {
            let parent = proc.parent_name.as_str();
            if ["wine64-preloader", "proton", "wine"].contains(&parent) || parent.ends_with(".sh") {
                (self.log)(
                    &format!(
                        "[MATCH] Proton/Wine wrapper (parent={}): \"{}\"",
                        parent, exe_name
                    ),
                    "debug",
                    60,
                );
                return Some(format_game_output(
                    exe_name,
                    exe_path,
                    window_title,
                    "Shell Wrapper/Proton",
                    kw.config.emulator_detection,
                ));
            }
            if ["epicgameslauncher.exe", "eadesktop.exe", "upc.exe"].contains(&parent) {
                (self.log)(
                    &format!(
                        "[MATCH] Official launcher (parent={}): \"{}\"",
                        parent, exe_name
                    ),
                    "debug",
                    60,
                );
                return Some(format_game_output(
                    exe_name,
                    exe_path,
                    window_title,
                    "Official Launcher",
                    kw.config.emulator_detection,
                ));
            }
        }

        // ── Stage 5: Confidence scoring (indies / DRM-free) ────────────────
        let mut confidence: f64 = 0.0;
        let mut factors: Vec<&str> = Vec::new();
        if kw.config.score_engine_dna && has_engine_dna(exe_path) {
            confidence += 0.4;
            factors.push("engine_dna=+0.4");
        }
        if kw.config.score_fullscreen && window.is_fullscreen {
            confidence += 0.3;
            factors.push("fullscreen=+0.3");
        }
        if kw.config.score_window_title && !window_title.is_empty() && title_lower != *exe_name {
            confidence += 0.2;
            factors.push("window_title=+0.2");
        }
        if kw.config.score_ram && proc.memory_mb > kw.config.ram_threshold_mb {
            confidence += 0.1;
            factors.push("ram=+0.1");
        }
        (self.log)(
            &format!(
                "[SCORE] \"{}\": {} (total {:.1} / threshold {:.1})",
                exe_name,
                if factors.is_empty() {
                    "no factors matched".to_string()
                } else {
                    factors.join(", ")
                },
                confidence,
                kw.config.confidence_threshold
            ),
            "debug",
            60,
        );

        if confidence >= kw.config.confidence_threshold {
            (self.log)(
                &format!("[MATCH] Stage 5 confidence pass: \"{}\"", exe_name),
                "debug",
                60,
            );
            return Some(format_game_output(
                exe_name,
                exe_path,
                window_title,
                "Standalone/DRM-Free",
                kw.config.emulator_detection,
            ));
        }

        (self.log)(
            &format!(
                "[FILTER] Stage 5 confidence below threshold: \"{}\"",
                exe_name
            ),
            "debug",
            60,
        );
        None
    }

    // ── Behavioral traps ───────────────────────────────────────────────────

    fn survives_behavioral_traps(
        &self,
        window: &ActiveWindow,
        proc: &ProcessSnapshot,
        config: &ScannerConfig,
    ) -> bool {
        // 1. RAM floor
        if proc.memory_mb < config.ram_threshold_mb {
            (self.log)("[FILTER] RAM floor not met", "debug", 300);
            return false;
        }

        let dir_contents = list_dir_lower(&proc.exe_path);

        // 2. Chromium / Electron trap
        if config.trap_chromium {
            if let Some(files) = &dir_contents {
                let chromium_files = [
                    "v8_context_snapshot.bin",
                    "libcef.dll",
                    "libcef.so",
                    "chromium framework.framework",
                ];
                let is_chromium = chromium_files
                    .iter()
                    .any(|cf| files.iter().any(|f| f.contains(cf)));
                if is_chromium && !files.iter().any(|f| f == "www") {
                    (self.log)("[FILTER] Chromium/Electron shell trapped", "debug", 300);
                    return false;
                }
            }
        }

        // 3. Command line trap
        if config.trap_cmdline && !proc.cmdline.is_empty() {
            let bad_flags = [
                "--type=renderer",
                "--type=crashpad",
                "-embedding",
                "--background",
                "--hidden",
                "--silent",
            ];
            if bad_flags.iter().any(|f| proc.cmdline.contains(f)) {
                (self.log)("[FILTER] Background/helper cmdline trapped", "debug", 300);
                return false;
            }
        }

        // 4. Desktop UI framework trap
        if config.trap_ui_framework {
            if let Some(files) = &dir_contents {
                let ui_frameworks = [
                    "qt5core",
                    "qt6core",
                    "mfc140.dll",
                    "wxbase",
                    "libgtk-3.so",
                    "qtgui.framework",
                ];
                if ui_frameworks
                    .iter()
                    .any(|ui| files.iter().any(|f| f.contains(ui)))
                {
                    (self.log)("[FILTER] Desktop UI framework trapped", "debug", 300);
                    return false;
                }
            }
        }

        // 5. Geometry & visibility trap
        if config.trap_geometry {
            if let Some((x, y, w, h)) = window.rect {
                if w > 0 && h > 0 && (w < 640 || h < 480) {
                    (self.log)("[FILTER] Window too small", "debug", 300);
                    return false;
                }
                if x <= -30000 || y <= -30000 {
                    (self.log)("[FILTER] Window parked off-screen", "debug", 300);
                    return false;
                }
            }
        }

        true
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Free helpers (unit-testable)
// ═══════════════════════════════════════════════════════════════════════════

/// Lowercased file names in the executable's directory, or None.
fn list_dir_lower(exe_path: &str) -> Option<Vec<String>> {
    if exe_path.is_empty() {
        return None;
    }
    let dir = std::path::Path::new(exe_path).parent()?;
    let entries = std::fs::read_dir(dir).ok()?;
    Some(
        entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().to_str().map(|s| s.to_lowercase()))
            .collect(),
    )
}

/// Engine DNA: known engine/runtime files sitting next to the executable.
pub fn has_engine_dna(exe_path: &str) -> bool {
    let Some(files) = list_dir_lower(exe_path) else {
        return false;
    };
    ENGINE_DNA
        .iter()
        .any(|sig| files.iter().any(|f| f.contains(sig)))
}

/// Extract the actual game folder name from a path, ignoring generic
/// engine folders (Unreal `Binaries/Win64/...`) and preferring the Steam
/// `common/<Game>` folder when present.
pub fn extract_true_game_name(exe_path: &str) -> String {
    let normalized = exe_path.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').collect();
    let lower_parts: Vec<String> = parts.iter().map(|p| p.to_lowercase()).collect();

    // Steam override: grab the folder directly after "common"
    if let Some(idx) = lower_parts.iter().position(|p| p == "common") {
        if parts.len() > idx + 1 {
            return parts[idx + 1].to_string();
        }
    }

    let ignore = [
        "binaries",
        "win64",
        "win32",
        "shipping",
        "x64",
        "x86",
        "bin",
        "release",
        "windowsnoeditor",
    ];
    for part in parts.iter().rev().skip(1) {
        if !ignore.contains(&part.to_lowercase().as_str()) && !part.trim().is_empty() {
            return part.to_string();
        }
    }
    if parts.len() > 1 {
        parts[parts.len() - 2].to_string()
    } else {
        "Unknown Game".to_string()
    }
}

/// Title-case each word ("elden ring" → "Elden Ring") for game folder names.
fn title_case(s: &str) -> String {
    s.split_whitespace()
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Disc-image and ROM extensions across emulated platforms, used to spot a
/// launched game file in an emulator's own command-line arguments.
const ROM_EXTENSIONS: &[&str] = &[
    "iso", "bin", "cue", "chd", "cso", "gdi", "cdi", "pbp", "nsp", "xci", "3ds", "cia", "wbfs",
    "rvz", "wux", "z64", "n64", "gba", "gb", "gbc", "nes", "sfc", "smc", "md", "gen",
];

/// Best-effort read of a ROM/game file name out of an emulator's own
/// command-line arguments — e.g. `pcsx2-qt.exe --fullscreen "D:\ROMs\Some
/// Game.iso"` -> `Some("Some Game")`. This is the process's own argument
/// list as reported by the OS, same as `exe_name`/`exe_path` — nothing here
/// reads or writes the emulator's memory or the emulated game's state.
///
/// A ROM path containing spaces isn't handled cleanly — cmdline here is
/// already a flattened, space-joined string with argument boundaries lost,
/// so a path like "Metroid Prime.rvz" only yields "Prime". Real games with
/// spaceless file names (the common case) still come out right.
fn extract_rom_name_from_cmdline(cmdline: &str) -> Option<String> {
    let token = cmdline.split_whitespace().rfind(|tok| {
        let trimmed = tok.trim_matches('"');
        ROM_EXTENSIONS
            .iter()
            .any(|ext| trimmed.ends_with(&format!(".{}", ext)))
    })?;
    let trimmed = token.trim_matches('"').replace('\\', "/");
    let file_name = trimmed.rsplit('/').next().unwrap_or(&trimmed);
    let stem = file_name.rsplit_once('.').map_or(file_name, |(s, _)| s);
    let title = title_case(&stem.replace(['_', '.'], " "));
    (!title.is_empty()).then_some(title)
}

/// Build the final `GameDetection`, applying the emulator splitter, the macOS
/// Info.plist display-name parser, and the generic-exe-name path extraction.
pub fn format_game_output(
    exe_name: &str,
    exe_path: &str,
    window_title: &str,
    platform_tag: &str,
    emulator_detection: bool,
) -> GameDetection {
    // Built-in window-title correction (version/build suffixes, trademark
    // glyphs) — takes priority over every other title source below.
    if let Some(title) = known_window_title_alias(window_title) {
        return GameDetection {
            title: title.to_string(),
            process: exe_name.to_string(),
            platform: platform_tag.to_string(),
        };
    }

    // Emulator splitter: "Game Title - Yuzu 1.0" → "Game Title"
    if emulator_detection
        && EMULATOR_TAGS.iter().any(|emu| exe_name.contains(emu))
        && !window_title.is_empty()
    {
        let first = window_title.split(" - ").next().unwrap_or(window_title);
        let clean = first
            .split(" | ")
            .last()
            .unwrap_or(first)
            .trim()
            .to_string();
        return GameDetection {
            title: clean,
            process: exe_name.to_string(),
            platform: "Emulator".to_string(),
        };
    }

    // macOS: prefer the bundle display name from Info.plist
    #[cfg(target_os = "macos")]
    if exe_path.contains(".app/contents/macos") {
        if let Some(display_name) = macos_bundle_display_name(exe_path) {
            return GameDetection {
                title: display_name,
                process: exe_name.to_string(),
                platform: "macOS App".to_string(),
            };
        }
    }

    // Generic exe names (game.exe, start.exe, Unreal shipping binaries…) or a
    // missing window title: extract the real name from the path instead.
    let is_generic = GENERIC_EXE_NAMES.iter().any(|gn| exe_name.contains(gn));
    let title = if (is_generic || window_title.is_empty()) && !exe_path.is_empty() {
        title_case(&extract_true_game_name(exe_path).replace('_', " "))
    } else if !window_title.is_empty() {
        window_title.to_string()
    } else {
        title_case(&exe_name.replace(".exe", ""))
    };

    GameDetection {
        title,
        process: exe_name.to_string(),
        platform: platform_tag.to_string(),
    }
}

/// macOS: read CFBundleDisplayName from the bundle's Info.plist.
#[cfg(target_os = "macos")]
fn macos_bundle_display_name(exe_path: &str) -> Option<String> {
    let idx = exe_path.find("contents/macos")?;
    // exe_path is lowercased; re-derive the real path casing is impossible, so
    // rely on the case-insensitive default APFS. Build the plist path.
    let plist_path = format!("{}Contents/Info.plist", &exe_path[..idx]);
    let value: plist::Value = plist::from_file(&plist_path).ok()?;
    let dict = value.as_dictionary()?;
    let name = dict
        .get("CFBundleDisplayName")
        .or_else(|| dict.get("CFBundleName"))?
        .as_string()?;
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// Linux: Feral GameMode and Flatpak sandbox membership.
#[cfg(target_os = "linux")]
fn linux_launch_context(pid: u32) -> Option<String> {
    use std::process::Command;

    if let Ok(out) = Command::new("gamemoded").arg("-s").output() {
        if String::from_utf8_lossy(&out.stdout).contains("active") {
            return Some("Linux GameMode".to_string());
        }
    }

    if let Ok(out) = Command::new("flatpak")
        .args(["ps", "--columns=application,pid"])
        .output()
    {
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        for line in text.lines() {
            if line.contains(&pid.to_string()) {
                if let Some(app_id) = line.split_whitespace().next() {
                    return Some(format!("Flatpak ({})", app_id));
                }
            }
        }
    }

    None
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn scout() -> GameDetector {
        GameDetector::new(Box::new(|_, _, _| {}))
    }

    fn scout_with(listed: &[(&str, &str)], delisted: &[&str], strict: bool) -> GameDetector {
        let mut s = scout();
        s.update_forge_knowledge(
            listed
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            delisted.iter().map(|s| s.to_string()).collect(),
            strict,
            ScannerConfig::default(),
        );
        s
    }

    fn win(title: &str, fullscreen: bool) -> ActiveWindow {
        ActiveWindow {
            pid: 1234,
            title: title.to_string(),
            is_fullscreen: fullscreen,
            os_window_id: 1,
            rect: Some((0, 0, 1920, 1080)),
        }
    }

    fn proc(exe: &str, path: &str, mem_mb: u64) -> ProcessSnapshot {
        ProcessSnapshot {
            exe_name: exe.to_string(),
            exe_path: path.to_string(),
            memory_mb: mem_mb,
            cmdline: String::new(),
            parent_name: String::new(),
        }
    }

    // ── update_forge_knowledge ──────────────────────────────────────────

    #[test]
    fn knowledge_updates_overwrite_previous_state() {
        let mut s = scout_with(&[("a.exe", "A")], &["b.exe"], true);
        s.update_forge_knowledge(HashMap::new(), vec![], false, ScannerConfig::default());
        let kw = s.knowledge.as_ref().unwrap();
        assert!(kw.listed_apps.is_empty());
        assert!(kw.delisted_apps.is_empty());
        assert!(!kw.strict_mode);
    }

    // ── Stage 1: listed apps ────────────────────────────────────────────

    #[test]
    fn listed_app_wins_instantly() {
        let s = scout_with(&[("eldenring.exe", "ELDEN RING")], &[], false);
        let d = s
            .evaluate(
                &win("ELDEN RING", true),
                &proc("eldenring.exe", "d:\\games\\eldenring.exe", 4000),
            )
            .unwrap();
        assert_eq!(d.title, "ELDEN RING");
        assert_eq!(d.platform, "The Forge");
    }

    // ── Known emulator passthrough ──────────────────────────────────────

    #[test]
    fn emulator_bypasses_ui_framework_trap() {
        // PCSX2's real Qt build ships qt6core.dll right next to the exe —
        // exactly what trap_ui_framework looks for. Without the passthrough
        // this gets silently dropped before it's ever recognized as PCSX2.
        let tmp = std::env::temp_dir().join(format!("forge_emu_test_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("qt6core.dll"), b"").unwrap();
        let exe = tmp.join("pcsx2-qt.exe");
        std::fs::write(&exe, b"").unwrap();
        let exe_path = exe.to_string_lossy().to_lowercase();

        let s = scout_with(&[], &[], false);
        let d = s
            .evaluate(
                &win("Some Game - PCSX2", false),
                &proc("pcsx2-qt.exe", &exe_path, 10),
            )
            .expect("emulator should still be detected despite the Qt trap");
        assert_eq!(d.platform, "Emulator");
        assert_eq!(d.title, "Some Game");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn emulator_passthrough_still_respects_delisted_apps() {
        let s = scout_with(&[], &["pcsx2-qt.exe"], false);
        assert!(s
            .evaluate(
                &win("Some Game - PCSX2", false),
                &proc("pcsx2-qt.exe", "d:\\emu\\pcsx2-qt.exe", 10)
            )
            .is_none());
    }

    #[test]
    fn emulator_passthrough_disabled_falls_back_to_normal_pipeline() {
        // With emulator_detection off, a low-memory, title-less PCSX2 window
        // gets trapped by the RAM floor like anything else would.
        let mut s = scout_with(&[], &[], false);
        let config = ScannerConfig {
            emulator_detection: false,
            ..Default::default()
        };
        s.update_forge_knowledge(HashMap::new(), vec![], false, config);
        assert!(s
            .evaluate(
                &win("", false),
                &proc("pcsx2-qt.exe", "d:\\emu\\pcsx2-qt.exe", 10)
            )
            .is_none());
    }

    #[test]
    fn strict_mode_kills_unlisted() {
        let s = scout_with(&[("a.exe", "A")], &[], true);
        assert!(s
            .evaluate(
                &win("Some Game", true),
                &proc("game2.exe", "d:\\games\\game2.exe", 4000)
            )
            .is_none());
    }

    // ── UWP piercer ─────────────────────────────────────────────────────

    #[test]
    fn uwp_piercer_uses_window_title() {
        let s = scout_with(&[], &[], false);
        let d = s
            .evaluate(
                &win("Forza Horizon 5", true),
                &proc(
                    "applicationframehost.exe",
                    "c:\\windows\\system32\\applicationframehost.exe",
                    500,
                ),
            )
            .unwrap();
        assert_eq!(d.title, "Forza Horizon 5");
        assert_eq!(d.platform, "Xbox Game Pass");
    }

    #[test]
    fn uwp_piercer_excludes_windows_settings() {
        let s = scout_with(&[], &[], false);
        assert!(s
            .evaluate(
                &win("Settings", true),
                &proc(
                    "applicationframehost.exe",
                    "c:\\windows\\system32\\applicationframehost.exe",
                    500,
                ),
            )
            .is_none());
    }

    #[test]
    fn uwp_piercer_excludes_other_built_in_windows_apps() {
        let s = scout_with(&[], &[], false);
        for title in ["Calculator", "Mail", "Microsoft Store", "PHOTOS", "xbox"] {
            assert!(
                s.evaluate(
                    &win(title, true),
                    &proc(
                        "applicationframehost.exe",
                        "c:\\windows\\system32\\applicationframehost.exe",
                        500,
                    ),
                )
                .is_none(),
                "\"{}\" should be excluded, not detected as a game",
                title
            );
        }
    }

    #[test]
    fn native_settings_app_is_killed() {
        let s = scout_with(&[], &[], false);
        assert!(s
            .evaluate(
                &win("Settings", true),
                &proc(
                    "systemsettings.exe",
                    "c:\\windows\\systemapps\\systemsettings.exe",
                    900,
                ),
            )
            .is_none());
    }

    // ── Stage 2: ───────────────────────────────────────────

    #[test]
    fn system_exiles_are_killed() {
        let s = scout_with(&[], &[], false);
        assert!(s
            .evaluate(
                &win("Steam", false),
                &proc("steam.exe", "c:\\steam\\steam.exe", 900)
            )
            .is_none());
    }

    #[test]
    fn web_browsers_are_never_detected_as_games() {
        let s = scout_with(&[], &[], false);
        for exe in [
            "brave.exe",
            "opera.exe",
            "opera_gx.exe",
            "vivaldi.exe",
            "iexplore.exe",
            "chromium.exe",
        ] {
            let path = format!("d:\\browsers\\{}", exe);
            assert!(
                s.evaluate(&win("Some Game Title", true), &proc(exe, &path, 900))
                    .is_none(),
                "{} should never be detected as a game",
                exe
            );
        }
    }

    #[test]
    fn brave_and_other_browser_titles_are_killed() {
        let s = scout_with(&[], &[], false);
        for suffix in [" - Brave", " - Opera", " - Vivaldi"] {
            let title = format!("Some Website Tab{}", suffix);
            assert!(
                s.evaluate(
                    &win(&title, true),
                    &proc("game.exe", "d:\\g\\game.exe", 900),
                )
                .is_none(),
                "title ending in \"{}\" should be filtered as a browser title",
                suffix
            );
        }
    }

    #[test]
    fn delisted_apps_are_killed() {
        let s = scout_with(&[], &["mygame.exe"], false);
        assert!(s
            .evaluate(
                &win("My Game", true),
                &proc("mygame.exe", "d:\\g\\mygame.exe", 900)
            )
            .is_none());
    }

    #[test]
    fn banned_paths_are_killed() {
        let s = scout_with(&[], &[], false);
        assert!(s
            .evaluate(
                &win("Tool", true),
                &proc("tool.exe", "c:\\windows\\tool.exe", 900)
            )
            .is_none());
    }

    #[test]
    fn youtube_titles_are_killed() {
        let s = scout_with(&[], &[], false);
        // Caught whether the browser appends its own name to the title...
        assert!(s
            .evaluate(
                &win("Some Video - YouTube - Google Chrome", true),
                &proc("chrome.exe", "d:\\g\\chrome.exe", 900),
            )
            .is_none());
        // ...or the tab/PWA window title is just "<video> - YouTube".
        assert!(s
            .evaluate(
                &win("Some Video - YouTube", true),
                &proc("chrome.exe", "d:\\g\\chrome.exe", 900),
            )
            .is_none());
        // YouTube Music too.
        assert!(s
            .evaluate(
                &win("Some Song - YouTube Music", true),
                &proc("chrome.exe", "d:\\g\\chrome.exe", 900),
            )
            .is_none());
    }

    #[test]
    fn browser_titles_are_killed() {
        let s = scout_with(&[], &[], false);
        assert!(s
            .evaluate(
                &win("Cool Game - Google Chrome", true),
                &proc("game.exe", "d:\\g\\game.exe", 900),
            )
            .is_none());
    }

    #[test]
    fn filter_bypass_skips_exiles() {
        let mut s = scout_with(&[], &[], false);
        let cfg = ScannerConfig {
            process_filter_bypass: true,
            ..Default::default()
        };
        s.update_forge_knowledge(HashMap::new(), vec![], false, cfg);
        // steam.exe survives with bypass on, and fullscreen +
        // title + RAM pushes it over the confidence threshold.
        let d = s.evaluate(&win("Steam Big Picture", true), &proc("steam.exe", "", 900));
        assert!(d.is_some());
    }

    // ── Stage 3: ───────────────────────────────────────────

    #[test]
    fn ram_floor_trap() {
        let s = scout_with(&[], &[], false);
        assert!(s
            .evaluate(
                &win("Tiny Tool", true),
                &proc("tiny.exe", "d:\\t\\tiny.exe", 10)
            )
            .is_none());
    }

    #[test]
    fn cmdline_trap_kills_renderers() {
        let s = scout_with(&[], &[], false);
        let mut p = proc("app.exe", "d:\\a\\app.exe", 900);
        p.cmdline = "app.exe --type=renderer".to_string();
        assert!(s.evaluate(&win("App", true), &p).is_none());
    }

    #[test]
    fn geometry_trap_kills_small_windows() {
        let s = scout_with(&[], &[], false);
        let mut w = win("Widget", false);
        w.rect = Some((0, 0, 320, 240));
        assert!(s
            .evaluate(&w, &proc("widget.exe", "d:\\w\\widget.exe", 900))
            .is_none());
    }

    #[test]
    fn geometry_trap_kills_offscreen_windows() {
        let s = scout_with(&[], &[], false);
        let mut w = win("Hidden", true);
        w.rect = Some((-32000, -32000, 1920, 1080));
        assert!(s
            .evaluate(&w, &proc("bg.exe", "d:\\b\\bg.exe", 900))
            .is_none());
    }

    // ── Stage 4: ─────────────────────────────────────────

    #[test]
    fn proton_parent_matches() {
        let s = scout_with(&[], &[], false);
        let mut p = proc("game.exe", "z:\\games\\common\\Elden Ring\\game.exe", 900);
        p.parent_name = "proton".to_string();
        let d = s.evaluate(&win("", false), &p).unwrap();
        assert_eq!(d.platform, "Shell Wrapper/Proton");
        assert_eq!(d.title, "Elden Ring"); // generic name → path extraction
    }

    #[test]
    fn launcher_parent_matches() {
        let s = scout_with(&[], &[], false);
        let mut p = proc("fortnite.exe", "d:\\epic\\fortnite\\fortnite.exe", 2000);
        p.parent_name = "epicgameslauncher.exe".to_string();
        let d = s.evaluate(&win("Fortnite", true), &p).unwrap();
        assert_eq!(d.platform, "Official Launcher");
    }

    // ── Stage 5: confidence scoring ─────────────────────────────────────

    #[test]
    fn indie_game_scores_over_threshold() {
        let s = scout_with(&[], &[], false);
        // fullscreen (0.3) + distinct title (0.2) + RAM (0.1) = 0.6 >= 0.5
        let d = s
            .evaluate(
                &win("Hollow Knight", true),
                &proc("hollow_knight.exe", "", 900),
            )
            .unwrap();
        assert_eq!(d.title, "Hollow Knight");
        assert_eq!(d.platform, "Standalone/DRM-Free");
    }

    #[test]
    fn low_confidence_returns_none() {
        let s = scout_with(&[], &[], false);
        // windowed (0.0) + title matches exe name (0.0) + RAM only (0.1)
        assert!(s
            .evaluate(&win("tool.exe", false), &proc("tool.exe", "", 900))
            .is_none());
    }

    // ── format_game_output (ported from TestFormatGameOutput) ──────────

    #[test]
    fn non_generic_exe_uses_window_title() {
        let d = format_game_output(
            "celeste.exe",
            "d:\\games\\celeste\\celeste.exe",
            "Celeste",
            "Standalone/DRM-Free",
            true,
        );
        assert_eq!(d.title, "Celeste");
        assert_eq!(d.process, "celeste.exe");
    }

    #[test]
    fn emulator_splitter_takes_window_title() {
        let d = format_game_output(
            "yuzu.exe",
            "d:\\emu\\yuzu.exe",
            "The Legend of Zelda - yuzu 1440",
            "Standalone/DRM-Free",
            true,
        );
        assert_eq!(d.title, "The Legend of Zelda");
        assert_eq!(d.platform, "Emulator");
    }

    #[test]
    fn emulator_splitter_with_pipe() {
        let d = format_game_output(
            "retroarch.exe",
            "",
            "RetroArch | Super Mario World",
            "X",
            true,
        );
        assert_eq!(d.title, "Super Mario World");
        assert_eq!(d.platform, "Emulator");
    }

    #[test]
    fn emulator_without_window_title_falls_through() {
        let d = format_game_output(
            "pcsx2.exe",
            "d:\\emu\\pcsx2\\pcsx2.exe",
            "",
            "Standalone/DRM-Free",
            true,
        );
        assert_eq!(d.platform, "Standalone/DRM-Free");
    }

    #[test]
    fn emulator_detection_can_be_disabled() {
        let d = format_game_output("yuzu.exe", "", "Zelda - yuzu", "X", false);
        assert_eq!(d.platform, "X");
        assert_eq!(d.title, "Zelda - yuzu");
    }

    #[test]
    fn all_known_emulator_tags() {
        for emu in EMULATOR_TAGS {
            let exe = format!("{}.exe", emu);
            let d = format_game_output(&exe, "", "Game Title - v1.0", "X", true);
            assert_eq!(d.platform, "Emulator", "{} not split", emu);
            assert_eq!(d.title, "Game Title");
        }
    }

    #[test]
    fn generic_exe_name_uses_path_extraction() {
        let d = format_game_output(
            "game.exe",
            "d:\\steamlibrary\\steamapps\\common\\Hollow_Knight\\game.exe",
            "game.exe",
            "Steam Registry",
            true,
        );
        assert_eq!(d.title, "Hollow Knight");
    }

    #[test]
    fn no_window_title_uses_path() {
        let d = format_game_output(
            "start.exe",
            "d:\\games\\Stardew_Valley\\start.exe",
            "",
            "X",
            true,
        );
        assert_eq!(d.title, "Stardew Valley");
    }

    #[test]
    fn exe_name_becomes_title_when_no_path() {
        let d = format_game_output("celeste.exe", "", "", "X", true);
        assert_eq!(d.title, "Celeste");
    }

    // ── extract_true_game_name (ported from TestExtractTrueGameName) ───

    #[test]
    fn steam_common_override() {
        assert_eq!(
            extract_true_game_name("d:/steam/steamapps/common/Elden Ring/game/eldenring.exe"),
            "Elden Ring"
        );
    }

    #[test]
    fn steam_common_case_insensitive() {
        assert_eq!(
            extract_true_game_name("D:/Steam/steamapps/COMMON/Hades/hades.exe"),
            "Hades"
        );
    }

    #[test]
    fn ignores_binaries_and_shipping_folders() {
        assert_eq!(
            extract_true_game_name("d:/games/MyGame/Binaries/Win64/MyGame-Win64-Shipping.exe"),
            "MyGame"
        );
    }

    #[test]
    fn backslashes_normalized() {
        assert_eq!(
            extract_true_game_name("d:\\games\\Celeste\\celeste.exe"),
            "Celeste"
        );
    }

    #[test]
    fn single_component_path() {
        assert_eq!(extract_true_game_name("game.exe"), "Unknown Game");
    }

    // ── engine DNA (ported from TestHasEngineDna) ───────────────────────

    #[test]
    fn detects_engine_dna_signatures() {
        let tmp = std::env::temp_dir().join(format!("forge_dna_test_{}", std::process::id()));
        for sig in ["unityplayer.dll", "data.pck", "data.win", "steam_api64.dll"] {
            let dir = tmp.join(sig.replace('.', "_"));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(sig), b"").unwrap();
            let exe = dir.join("game.exe");
            std::fs::write(&exe, b"").unwrap();
            assert!(
                has_engine_dna(&exe.to_string_lossy().to_lowercase()),
                "{} not detected",
                sig
            );
        }
        let empty = tmp.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        let exe = empty.join("game.exe");
        std::fs::write(&exe, b"").unwrap();
        assert!(!has_engine_dna(&exe.to_string_lossy().to_lowercase()));
        assert!(!has_engine_dna("z:/does/not/exist/game.exe"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ── ROM name from emulator cmdline ───────────────────────────────────

    #[test]
    fn extracts_rom_name_from_various_extensions() {
        assert_eq!(
            extract_rom_name_from_cmdline(
                r#"pcsx2-qt.exe --fullscreen "d:\roms\ps2\Some_Game.iso""#
            ),
            Some("Some Game".to_string())
        );
        // A path containing a space isn't handled cleanly — the flattened
        // cmdline has already lost the argument boundary, so this only
        // catches the last whitespace-delimited chunk ("Prime.rvz"), not
        // the full "Metroid Prime". Documented limitation, not a crash.
        assert_eq!(
            extract_rom_name_from_cmdline("dolphin.exe -b -e /home/user/roms/Metroid Prime.rvz"),
            Some("Prime".to_string())
        );
        assert_eq!(
            extract_rom_name_from_cmdline("retroarch.exe -L core.dll d:/roms/Chrono.Trigger.sfc"),
            Some("Chrono Trigger".to_string())
        );
    }

    #[test]
    fn no_rom_extension_in_cmdline_returns_none() {
        assert_eq!(
            extract_rom_name_from_cmdline("pcsx2-qt.exe --fullscreen"),
            None
        );
        assert_eq!(extract_rom_name_from_cmdline(""), None);
    }

    #[test]
    fn emulator_with_no_window_title_falls_back_to_cmdline_rom_name() {
        let s = scout_with(&[], &[], false);
        let mut proc = proc("pcsx2-qt.exe", "d:\\emu\\pcsx2-qt.exe", 200);
        proc.cmdline = r#"pcsx2-qt.exe --fullscreen "d:\roms\Some_Game.iso""#.to_string();
        let d = s.evaluate(&win("", false), &proc).unwrap();
        assert_eq!(d.platform, "Emulator");
        assert_eq!(d.title, "Some Game");
    }

    // ── Built-in exe/title aliases ──────────────────────────────────────

    #[test]
    fn known_exe_aliases_win_instantly_even_with_low_ram_and_strict_mode() {
        for (exe, expected_title) in KNOWN_EXE_TITLE_ALIASES {
            // strict_mode = true and a tiny memory footprint would normally
            // kill detection outright; the built-in alias must still win.
            let s = scout_with(&[], &[], true);
            let d = s
                .evaluate(&win(exe, false), &proc(exe, &format!("d:\\g\\{exe}"), 1))
                .unwrap_or_else(|| panic!("{exe} was not detected"));
            assert_eq!(d.title, *expected_title, "wrong title for {exe}");
            assert_eq!(d.platform, "The Forge");
        }
    }

    #[test]
    fn gtaiv_alias() {
        let s = scout_with(&[], &[], false);
        let d = s
            .evaluate(
                &win("GTAIV", true),
                &proc("gtaiv.exe", "d:\\games\\gtaiv\\gtaiv.exe", 4000),
            )
            .unwrap();
        assert_eq!(d.title, "Grand Theft Auto IV");
    }

    #[test]
    fn funko_fusion_alias_adds_missing_space() {
        let s = scout_with(&[], &[], false);
        let d = s
            .evaluate(
                &win("FunkoFusion", true),
                &proc(
                    "funkofusion.exe",
                    "d:\\games\\funkofusion\\funkofusion.exe",
                    4000,
                ),
            )
            .unwrap();
        assert_eq!(d.title, "Funko Fusion");
    }

    #[test]
    fn fallout_nv_alias_ignores_path_extraction() {
        let s = scout_with(&[], &[], false);
        let d = s
            .evaluate(
                &win("FalloutNV", true),
                &proc(
                    "falloutnv.exe",
                    "d:\\steamlibrary\\steamapps\\common\\fallout new vegas\\falloutnv.exe",
                    4000,
                ),
            )
            .unwrap();
        assert_eq!(d.title, "Fallout New Vegas");
    }

    #[test]
    fn known_window_title_aliases_strip_version_and_build_tags() {
        let cases = [
            ("Alan Wake - v1.07.33.72514", "Alan Wake"),
            ("APB Reloaded (64-bit, PC-D3D-SM3)", "APB Reloaded"),
            (
                "Call of Duty® Infinite Warfare",
                "Call of Duty: Infinite Warfare",
            ),
        ];
        for (raw, expected) in cases {
            let d = format_game_output("game.exe", "", raw, "Standalone/DRM-Free", true);
            assert_eq!(d.title, expected, "wrong title for {raw}");
        }
    }

    // ── "Not Responding" dedup ──────────────────────────────────────────

    #[test]
    fn strip_not_responding_suffix_removes_windows_hang_tag() {
        assert_eq!(
            strip_not_responding_suffix("Celeste (Not Responding)"),
            "Celeste"
        );
        assert_eq!(
            strip_not_responding_suffix("Celeste (not responding)"),
            "Celeste"
        );
        assert_eq!(strip_not_responding_suffix("Celeste"), "Celeste");
    }

    #[test]
    fn hung_window_produces_same_title_as_normal_window() {
        let s = scout_with(&[], &[], false);
        let normal = s
            .evaluate(&win("Celeste", true), &proc("celeste.exe", "", 900))
            .unwrap();
        let hung = s
            .evaluate(
                &win("Celeste (Not Responding)", true),
                &proc("celeste.exe", "", 900),
            )
            .unwrap();
        assert_eq!(normal.title, hung.title);
    }
}
