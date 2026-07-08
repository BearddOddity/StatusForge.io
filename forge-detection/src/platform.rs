//! OS-specific primitives for the detection waterfall.
//!
//! Each platform implements:
//! - `get_active_window()` — foreground window pid / title / fullscreen / bounds
//! - `read_steam_running_app_id()` — the Steam "RunningAppID" value
//! - `permission_error()` — Some(message) when the OS blocks window inspection
//!   (macOS Screen Recording permission), None when everything is accessible.

/// Foreground window snapshot, normalized across platforms.
#[derive(Debug, Clone, Default)]
pub struct ActiveWindow {
    pub pid: u32,
    pub title: String,
    pub is_fullscreen: bool,
    #[allow(dead_code)]
    pub os_window_id: usize,
    /// (x, y, width, height) when the platform can report it.
    pub rect: Option<(i32, i32, i32, i32)>,
}

// ═══════════════════════════════════════════════════════════════════════════
// Windows
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
pub fn get_active_window() -> Option<ActiveWindow> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowLongW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsWindowVisible, GWL_STYLE, WS_BORDER, WS_CAPTION,
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
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));

        let len = GetWindowTextLengthW(hwnd);
        let mut buf = vec![0u16; (len + 1) as usize];
        GetWindowTextW(hwnd, &mut buf);
        let title = String::from_utf16_lossy(&buf)
            .trim_end_matches('\0')
            .trim()
            .to_string();

        let style = GetWindowLongW(hwnd, GWL_STYLE);
        let is_fullscreen = (style & (WS_BORDER.0 as i32 | WS_CAPTION.0 as i32)) == 0;

        let mut rect = RECT::default();
        let bounds = if GetWindowRect(hwnd, &mut rect).is_ok() {
            Some((
                rect.left,
                rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top,
            ))
        } else {
            None
        };

        Some(ActiveWindow {
            pid,
            title,
            is_fullscreen,
            os_window_id: hwnd.0 as usize,
            rect: bounds,
        })
    }
}

#[cfg(target_os = "windows")]
pub fn read_steam_running_app_id() -> Option<u32> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let steam = hkcu.open_subkey("Software\\Valve\\Steam").ok()?;
    steam.get_value::<u32, _>("RunningAppId").ok()
}

#[cfg(target_os = "windows")]
pub fn permission_error() -> Option<String> {
    None
}

// ═══════════════════════════════════════════════════════════════════════════
// Linux (X11 via x11rb)
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "linux")]
pub fn get_active_window() -> Option<ActiveWindow> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{AtomEnum, ConnectionExt, Window};

    let (conn, screen_num) = x11rb::rust_connection::RustConnection::connect(None).ok()?;
    let screen = &conn.setup().roots[screen_num];
    let root = screen.root;

    let intern = |name: &[u8]| -> Option<u32> {
        Some(conn.intern_atom(false, name).ok()?.reply().ok()?.atom)
    };

    let net_active_window = intern(b"_NET_ACTIVE_WINDOW")?;
    let net_wm_pid = intern(b"_NET_WM_PID")?;
    let net_wm_name = intern(b"_NET_WM_NAME")?;
    let utf8_string = intern(b"UTF8_STRING")?;
    let net_wm_state = intern(b"_NET_WM_STATE")?;
    let net_wm_state_fullscreen = intern(b"_NET_WM_STATE_FULLSCREEN")?;

    // Active window id
    let reply = conn
        .get_property(false, root, net_active_window, AtomEnum::WINDOW, 0, 1)
        .ok()?
        .reply()
        .ok()?;
    let window: Window = reply.value32()?.next()?;
    if window == 0 {
        return None;
    }

    // _NET_WM_PID
    let pid = conn
        .get_property(false, window, net_wm_pid, AtomEnum::CARDINAL, 0, 1)
        .ok()
        .and_then(|c| c.reply().ok())
        .and_then(|r| r.value32().and_then(|mut v| v.next()))
        .unwrap_or(0);
    if pid == 0 {
        return None;
    }

    // Title: _NET_WM_NAME (UTF-8), fall back to WM_NAME
    let title = conn
        .get_property(false, window, net_wm_name, utf8_string, 0, 1024)
        .ok()
        .and_then(|c| c.reply().ok())
        .filter(|r| !r.value.is_empty())
        .map(|r| String::from_utf8_lossy(&r.value).trim().to_string())
        .or_else(|| {
            conn.get_property(false, window, AtomEnum::WM_NAME, AtomEnum::STRING, 0, 1024)
                .ok()
                .and_then(|c| c.reply().ok())
                .map(|r| String::from_utf8_lossy(&r.value).trim().to_string())
        })
        .unwrap_or_default();

    // Fullscreen: _NET_WM_STATE contains _NET_WM_STATE_FULLSCREEN
    let is_fullscreen = conn
        .get_property(false, window, net_wm_state, AtomEnum::ATOM, 0, 64)
        .ok()
        .and_then(|c| c.reply().ok())
        .and_then(|r| r.value32().map(|v| v.collect::<Vec<u32>>()))
        .map(|atoms| atoms.contains(&net_wm_state_fullscreen))
        .unwrap_or(false);

    // Geometry
    let rect = conn
        .get_geometry(window)
        .ok()
        .and_then(|c| c.reply().ok())
        .map(|g| (g.x as i32, g.y as i32, g.width as i32, g.height as i32));

    Some(ActiveWindow {
        pid,
        title,
        is_fullscreen,
        os_window_id: window as usize,
        rect,
    })
}

#[cfg(target_os = "linux")]
pub fn read_steam_running_app_id() -> Option<u32> {
    let home = std::env::var_os("HOME")?;
    let path = std::path::Path::new(&home).join(".steam/registry.vdf");
    parse_registry_vdf_running_app_id(&std::fs::read_to_string(path).ok()?)
}

#[cfg(target_os = "linux")]
pub fn permission_error() -> Option<String> {
    None
}

// ═══════════════════════════════════════════════════════════════════════════
// macOS (NSWorkspace + CGWindowList)
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "macos")]
mod macos {
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use core_graphics::display::CGDisplay;
    use core_graphics::geometry::CGRect;
    use core_graphics::window::{
        copy_window_info, kCGNullWindowID, kCGWindowListExcludeDesktopElements,
        kCGWindowListOptionOnScreenOnly,
    };

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRectMakeWithDictionaryRepresentation(dict: CFDictionaryRef, rect: *mut CGRect)
            -> bool;
    }

    /// True when the app has the Screen Recording permission (required to read
    /// window titles via CGWindowListCopyWindowInfo on macOS 10.15+).
    pub fn has_screen_recording_permission() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() }
    }

    /// pid of the frontmost (foreground) application via NSWorkspace.
    pub fn frontmost_app_pid() -> Option<u32> {
        use objc2_app_kit::NSWorkspace;
        unsafe {
            let workspace = NSWorkspace::sharedWorkspace();
            let app = workspace.frontmostApplication()?;
            let pid = app.processIdentifier();
            if pid <= 0 {
                None
            } else {
                Some(pid as u32)
            }
        }
    }

    /// Title + bounds of the frontmost on-screen window owned by `pid`.
    /// Returns (title, rect). Title is empty without Screen Recording permission.
    pub fn front_window_for_pid(pid: u32) -> Option<(String, CGRect)> {
        let info = copy_window_info(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID,
        )?;
        let info: CFArray<CFType> =
            unsafe { CFArray::wrap_under_get_rule(info.as_concrete_TypeRef()) };

        let key_pid = CFString::from_static_string("kCGWindowOwnerPID");
        let key_name = CFString::from_static_string("kCGWindowName");
        let key_bounds = CFString::from_static_string("kCGWindowBounds");
        let key_layer = CFString::from_static_string("kCGWindowLayer");

        // The window list is front-to-back; take the first layer-0 window for our pid.
        for item in info.iter() {
            let dict: CFDictionary<CFString, CFType> = unsafe {
                CFDictionary::wrap_under_get_rule(item.as_CFTypeRef() as CFDictionaryRef)
            };

            let owner_pid = dict
                .find(&key_pid)
                .and_then(|v| v.downcast::<CFNumber>())
                .and_then(|n| n.to_i64())
                .unwrap_or(-1);
            if owner_pid != pid as i64 {
                continue;
            }

            // Skip non-normal layers (menu bar, dock, overlays)
            let layer = dict
                .find(&key_layer)
                .and_then(|v| v.downcast::<CFNumber>())
                .and_then(|n| n.to_i64())
                .unwrap_or(0);
            if layer != 0 {
                continue;
            }

            let title = dict
                .find(&key_name)
                .and_then(|v| v.downcast::<CFString>())
                .map(|s| s.to_string())
                .unwrap_or_default();

            let mut rect = CGRect::default();
            let got_rect = dict
                .find(&key_bounds)
                .map(|v| unsafe {
                    CGRectMakeWithDictionaryRepresentation(
                        v.as_CFTypeRef() as CFDictionaryRef,
                        &mut rect,
                    )
                })
                .unwrap_or(false);
            if !got_rect {
                rect = CGRect::default();
            }

            return Some((title.trim().to_string(), rect));
        }
        None
    }

    /// Main display bounds, for fullscreen comparison.
    pub fn main_display_size() -> (f64, f64) {
        let display = CGDisplay::main();
        (display.pixels_wide() as f64, display.pixels_high() as f64)
    }
}

#[cfg(target_os = "macos")]
pub fn get_active_window() -> Option<ActiveWindow> {
    let pid = macos::frontmost_app_pid()?;

    let (title, rect) =
        macos::front_window_for_pid(pid).unwrap_or((String::new(), Default::default()));

    let (disp_w, disp_h) = macos::main_display_size();
    let (x, y, w, h) = (
        rect.origin.x,
        rect.origin.y,
        rect.size.width,
        rect.size.height,
    );
    // Fullscreen when the window covers the active display frame.
    let is_fullscreen = w > 0.0 && h > 0.0 && x <= 0.0 && y <= 0.0 && w >= disp_w && h >= disp_h;

    Some(ActiveWindow {
        pid,
        title,
        is_fullscreen,
        os_window_id: pid as usize,
        rect: if w > 0.0 {
            Some((x as i32, y as i32, w as i32, h as i32))
        } else {
            None
        },
    })
}

#[cfg(target_os = "macos")]
pub fn read_steam_running_app_id() -> Option<u32> {
    let home = std::env::var_os("HOME")?;
    let path = std::path::Path::new(&home).join("Library/Application Support/Steam/registry.vdf");
    parse_registry_vdf_running_app_id(&std::fs::read_to_string(path).ok()?)
}

#[cfg(target_os = "macos")]
pub fn permission_error() -> Option<String> {
    if macos::has_screen_recording_permission() {
        None
    } else {
        Some(
            "macOS Screen Recording permission is required to read window titles. \
             Grant it in System Settings → Privacy & Security → Screen Recording, \
             then restart the app."
                .to_string(),
        )
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════════════════

/// Parse `"RunningAppID"  "12345"` out of Valve's registry.vdf (macOS/Linux).
#[allow(dead_code)]
pub fn parse_registry_vdf_running_app_id(content: &str) -> Option<u32> {
    for line in content.lines() {
        let line = line.trim();
        // Case-insensitive key match: Valve uses "RunningAppID" on macOS/Linux
        // and "RunningAppId" in the Windows registry.
        let lower = line.to_lowercase();
        if lower.starts_with("\"runningappid\"") {
            let value = line.split('"').filter(|s| !s.trim().is_empty()).nth(1)?;
            return value.trim().parse::<u32>().ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_running_app_id_from_vdf() {
        let vdf = r#"
"Registry"
{
    "HKCU"
    {
        "Software"
        {
            "Valve"
            {
                "Steam"
                {
                    "language"      "english"
                    "RunningAppID"  "620"
                }
            }
        }
    }
}
"#;
        assert_eq!(parse_registry_vdf_running_app_id(vdf), Some(620));
    }

    #[test]
    fn vdf_zero_and_missing() {
        assert_eq!(
            parse_registry_vdf_running_app_id("\"RunningAppID\"\t\t\"0\""),
            Some(0)
        );
        assert_eq!(
            parse_registry_vdf_running_app_id("\"language\" \"english\""),
            None
        );
    }
}
