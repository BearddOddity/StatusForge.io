import os, sys, subprocess

# We only import psutil if it's available; otherwise, the bootloader in presence.py will install it.
try:
    import psutil
except ImportError:
    psutil = None

class ForgeWaterfall:
    def __init__(self, logger_callback):
        self.log = logger_callback
        self.system_exiles = {
            "explorer.exe", "chrome.exe", "msedge.exe", "firefox.exe", "discord.exe", 
            "obs64.exe", "obs32.exe", "taskmgr.exe", "spotify.exe", "code.exe", 
            "cmd.exe", "powershell.exe", "steam.exe", "epicgameslauncher.exe",
            "bash", "zsh", "gnome-shell", "plasma-desktop", "finder", "dock"
        }
        self.banned_paths = [r"c:\windows", r"system32", "/usr/bin", "/usr/sbin", "/sbin"]
        self.engine_dna = {
            "Unity": ["unityplayer.dll", "globalgamemanagers"],
            "Godot": ["project.godot", "data.pck"],
            "GameMaker": ["data.win", "audiogroup1.dat"],
            "Ren'Py": ["archive.rpa", "scripts.rpa"],
            "RPG Maker": ["game.rgss3a", "game.rgss2a", "game.rxdata", "rpg_core.js"],
            "Java": ["lwjgl.dll", "lwjgl64.dll", "liblwjgl.so"],
            "Lua_Love2D": ["love.dll", "game.love"],
            "Construct_HTML5": ["c3runtime.js", "package.nw"],
            "Proprietary_AAA": ["bink2w64.dll", "oo2core_", "steam_api64.dll", "fmodstudio.dll"]
        }
        self.listed_apps = {}
        self.delisted_apps = []
        self.strict_mode = False
        self.ram_threshold = 80
        self.confidence_threshold = 0.5
        self.emulator_detection = True
        self.process_filter_bypass = False

    def update_forge_knowledge(self, listed, delisted, strict_mode=False, config=None):
        """Syncs the Left Brain with the local database vault."""
        self.listed_apps = listed
        self.delisted_apps = delisted
        self.strict_mode = strict_mode
        if config:
            es = config.get("engine_settings", {})
            self.ram_threshold = es.get("ram_threshold", 80)
            self.confidence_threshold = es.get("confidence_threshold", 0.5)
            self.emulator_detection = es.get("emulator_detection", True)
            self.process_filter_bypass = es.get("process_filter_bypass", False)
            self.trap_chromium = es.get("trap_chromium", True)
            self.trap_cmdline = es.get("trap_cmdline", True)
            self.trap_ui_framework = es.get("trap_ui_framework", True)
            self.trap_geometry = es.get("trap_geometry", True)
            self.score_engine_dna = es.get("score_engine_dna", True)
            self.score_fullscreen = es.get("score_fullscreen", True)
            self.score_window_title = es.get("score_window_title", True)
            self.score_ram = es.get("score_ram", True)

    def scout_active_session(self):
        if not psutil: return None
        pid, window_title, is_fullscreen, os_window_id = self._get_active_os_window()
        if not pid: return None
        
        try:
            proc = psutil.Process(pid)
            exe_name = proc.name().lower()
            exe_path = proc.exe().lower() if proc.exe() else ""
            
            # === STAGE 1: THE VIP FORGE (Immunity) ===
            if exe_name in self.listed_apps:
                return self._format_game_output(exe_name, exe_path, self.listed_apps[exe_name], "The Forge")

            # === STRICT FORGE-ONLY CHECK ===
            if getattr(self, 'strict_mode', False):
                return None # Kills the scan immediately if not in Listed Apps

            # === XBOX GAME PASS / UWP PIERCER ===
            if exe_name == "applicationframehost.exe" and window_title:
                return self._format_game_output(exe_name, exe_path, window_title, "Xbox Game Pass")

            # === STAGE 2: THE GAUNTLET (Hard Kills) ===
            if not getattr(self, 'process_filter_bypass', False):
                if exe_name in self.delisted_apps or exe_name in self.system_exiles: return None
                if any(banned in exe_path for banned in self.banned_paths): return None
            if window_title and any(s in window_title.lower() for s in [" - google chrome", " - discord", " - firefox", " - edge"]): return None

            # === STAGE 3: THE GREAT FILTER (Behavioral Traps) ===
            if not self._survives_great_filter(proc, os_window_id, exe_path):
                return None

            # === STAGE 4: GOLDEN TICKETS (Authoritative Proof) ===
            discord_game = self._sniff_discord_ipc()
            if discord_game: return self._format_game_output(exe_name, exe_path, discord_game, "Discord IPC")
                
            if sys.platform == "win32" and "steamapps" in exe_path:
                import winreg
                try:
                    reg_key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam")
                    app_id, _ = winreg.QueryValueEx(reg_key, "RunningAppId")
                    if app_id > 0: return self._format_game_output(exe_name, exe_path, window_title, "Steam Registry")
                except Exception as e:
                    self.log(f"[SCOUT DEBUG] Steam Registry read failed: {str(e)}", "warning", 300)

            if sys.platform.startswith("linux"):
                try:
                    if "active" in subprocess.check_output(['gamemoded', '-s']).decode('utf-8'): 
                        return self._format_game_output(exe_name, exe_path, window_title, "Linux GameMode")
                except Exception as e:
                    self.log(f"[SCOUT DEBUG] Feral GameMode check failed: {str(e)}", "warning", 300)
                
                try: # Flatpak Sandbox Hook
                    flatpak_ps = subprocess.check_output(['flatpak', 'ps', '--columns=application,pid']).decode('utf-8')
                    for line in flatpak_ps.splitlines():
                        if str(pid) in line:
                            app_id = line.split()[0]
                            return self._format_game_output(exe_name, exe_path, window_title, f"Flatpak ({app_id})")
                except Exception as e:
                    self.log(f"[SCOUT DEBUG] Flatpak sandbox check failed: {str(e)}", "warning", 300)

            try: # Process Tree Parent Checking
                parent = proc.parent()
                if parent:
                    parent_name = parent.name().lower()
                    if parent_name in ["wine64-preloader", "proton", "wine"] or parent_name.endswith(".sh"):
                        return self._format_game_output(exe_name, exe_path, window_title, "Shell Wrapper/Proton")
                    if parent_name in ["epicgameslauncher.exe", "eadesktop.exe", "upc.exe"]:
                        return self._format_game_output(exe_name, exe_path, window_title, "Official Launcher")
            except Exception as e:
                self.log(f"[SCOUT DEBUG] Process tree parent check failed: {str(e)}", "warning", 300)

            # === STAGE 5: THE CONFIDENCE SCORE (For Indies/DRM-Free) ===
            confidence = 0.0
            if self._has_engine_dna(exe_path): confidence += 0.4
            if is_fullscreen: confidence += 0.3
            if window_title and window_title.lower() != exe_name: confidence += 0.2
            proc_mem_mb = 0
            try:
                proc_mem_mb = proc.memory_info().rss / (1024 * 1024)
            except Exception:
                pass
            if proc_mem_mb > self.ram_threshold: confidence += 0.1

            if confidence >= self.confidence_threshold:
                return self._format_game_output(exe_name, exe_path, window_title, "Standalone/DRM-Free")
                
            return None

        except (psutil.NoSuchProcess, psutil.AccessDenied): return None
        except Exception as e:
            self.log(f"[SCOUT ERROR] Critical failure in active session scout: {str(e)}", "error", 60)
            return None

    def _survives_great_filter(self, proc, os_window_id, exe_path):
        try: # 1. RAM Floor
            mem_mb = proc.memory_info().rss / (1024 * 1024)
            if mem_mb < self.ram_threshold: return False
        except Exception as e:
            self.log(f"[FILTER DEBUG] Memory trap read failed: {str(e)}", "warning", 300)

        if exe_path and os.path.exists(exe_path):
            try: # 2. Chromium / Electron Trap
                app_dir = os.path.dirname(exe_path)
                dir_contents = [f.lower() for f in os.listdir(app_dir)]
                chromium_files = ["v8_context_snapshot.bin", "libcef.dll", "libcef.so", "chromium framework.framework"]
                if any(any(cf in f for f in dir_contents) for cf in chromium_files):
                    if "www" not in dir_contents: return False
            except Exception as e:
                self.log(f"[FILTER DEBUG] Chromium file trap failed: {str(e)}", "warning", 300)

        try: # 3. Command Line Trap
            cmdline = proc.cmdline()
            if cmdline:
                cmd_str = " ".join(cmdline).lower()
                bad_flags = ["--type=renderer", "--type=crashpad", "-embedding", "--background", "--hidden", "--silent"]
                if any(flag in cmd_str for flag in bad_flags): return False
        except Exception as e:
            self.log(f"[FILTER DEBUG] Command line trap failed: {str(e)}", "warning", 300)

        if exe_path and os.path.exists(exe_path):
            try: # 4. Desktop UI Framework Trap
                app_dir = os.path.dirname(exe_path)
                dir_contents = [f.lower() for f in os.listdir(app_dir)]
                ui_frameworks = ["qt5core", "qt6core", "mfc140.dll", "wxbase", "libgtk-3.so", "qtgui.framework"]
                if any(any(ui in f for f in dir_contents) for ui in ui_frameworks): return False
            except Exception as e:
                self.log(f"[FILTER DEBUG] UI Framework trap failed: {str(e)}", "warning", 300)

        # 5. OS-Native Geometry & Visibility Traps
        if sys.platform == "win32" and os_window_id:
            import ctypes
            from ctypes import wintypes
            try:
                if not ctypes.windll.user32.IsWindowVisible(os_window_id): return False
                rect = wintypes.RECT()
                ctypes.windll.user32.GetWindowRect(os_window_id, ctypes.byref(rect))
                width, height = (rect.right - rect.left), (rect.bottom - rect.top)
                if width < 640 or height < 480: return False
                if rect.left <= -30000 or rect.top <= -30000: return False
            except Exception as e:
                self.log(f"[FILTER DEBUG] Windows OS geometry check failed: {str(e)}", "warning", 300)

        elif sys.platform == "darwin":
            try:
                script = 'tell application "System Events" to get {size, position} of first window of (first application process whose frontmost is true)'
                res = subprocess.check_output(['osascript', '-e', script]).decode('utf-8').strip()
                parts = [int(x) for x in res.replace(',', '').split()]
                if len(parts) == 4:
                    width, height, x, y = parts
                    if width < 640 or height < 480: return False
                    if x < -10000 or y < -10000: return False
            except Exception as e:
                self.log(f"[FILTER DEBUG] macOS geometry check failed: {str(e)}", "warning", 300)

        elif sys.platform.startswith("linux") and os_window_id:
            try:
                geom = subprocess.check_output(['xdotool', 'getwindowgeometry', str(os_window_id)]).decode('utf-8')
                if "Geometry:" in geom:
                    size_str = geom.split("Geometry:")[1].strip().split()[0]
                    width, height = map(int, size_str.split('x'))
                    if width < 640 or height < 480: return False
            except Exception as e:
                self.log(f"[FILTER DEBUG] Linux xdotool geometry check failed: {str(e)}", "warning", 300)

        return True

    def _get_active_os_window(self):
        pid = None; window_title = ""; is_fullscreen = False; os_window_id = None
        if sys.platform == "win32":
            import ctypes
            import win32process
            try:
                hwnd = ctypes.windll.user32.GetForegroundWindow()
                if not hwnd: return None, "", False, None 
                
                os_window_id = hwnd
                _, pid = win32process.GetWindowThreadProcessId(hwnd)
                length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
                buf = ctypes.create_unicode_buffer(length + 1)
                ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
                window_title = buf.value.strip()
                style = ctypes.windll.user32.GetWindowLongW(hwnd, -16)
                is_fullscreen = (style & 0x00C00000) != 0x00C00000
            except Exception as e:
                self.log(f"[SCOUT ERROR] ctypes active window hook failed: {str(e)}", "warning", 60)
        elif sys.platform == "darwin":
            try:
                script = 'tell application "System Events" to get {unix id, name} of first application process whose frontmost is true'
                res = subprocess.check_output(['osascript', '-e', script]).decode('utf-8').strip()
                if ", " in res:
                    pid_str, window_title = res.split(', ', 1)
                    pid = int(pid_str)
                    os_window_id = pid
            except Exception as e:
                self.log(f"[SCOUT ERROR] AppleScript active window hook failed: {str(e)}", "warning", 60)
        elif sys.platform.startswith("linux"):
            try:
                win_id = subprocess.check_output(['xdotool', 'getactivewindow']).decode('utf-8').strip()
                pid = int(subprocess.check_output(['xdotool', 'getwindowpid', win_id]).decode('utf-8').strip())
                window_title = subprocess.check_output(['xdotool', 'getwindowname', win_id]).decode('utf-8').strip()
                os_window_id = win_id
            except Exception as e:
                self.log(f"[SCOUT ERROR] xdotool active window hook failed: {str(e)}", "warning", 60)
        return pid, window_title, is_fullscreen, os_window_id

    def _sniff_discord_ipc(self):
        """Placeholder for future IPC Named Pipe integration."""
        return None 

    def _has_engine_dna(self, exe_path):
        if not exe_path or not os.path.exists(exe_path): return False
        try:
            game_dir = os.path.dirname(exe_path)
            dir_contents = [f.lower() for f in os.listdir(game_dir)]
            all_signatures = [sig.lower() for signatures in self.engine_dna.values() for sig in signatures]
            return any(any(dna in file_name for dna in all_signatures) for file_name in dir_contents)
        except Exception as e:
            self.log(f"[DNA SCANNER ERROR] Directory signature read failed: {str(e)}", "warning", 300)
            return False

    def _extract_true_game_name(self, exe_path):
        """Extracts the actual game folder name, ignoring generic Unreal/Unity engine folders."""
        path_parts = exe_path.replace('\\', '/').split('/')
        
        # 1. The Ultimate Steam Override: Grab the folder directly after 'common'
        lower_parts = [p.lower() for p in path_parts]
        if 'common' in lower_parts:
            idx = lower_parts.index('common')
            if len(path_parts) > idx + 1:
                return path_parts[idx + 1]

        # 2. Generic Engine Fallback: Skip known junk folders
        ignore_list = ['binaries', 'win64', 'win32', 'shipping', 'x64', 'x86', 'bin', 'release', 'windowsnoeditor']
        
        for part in reversed(path_parts[:-1]): 
            if part.lower() not in ignore_list and part.strip() != "":
                return part
                
        return path_parts[-2] if len(path_parts) > 1 else "Unknown Game"

    def _format_game_output(self, exe_name, exe_path, window_title, platform_tag):
        generic_names = ["game.exe", "win64-shipping", "start.exe", "play.exe", "application.exe", "runner", "binaries"]
        
        # === EMULATOR SPLITTER ===
        if getattr(self, 'emulator_detection', True):
            emulator_tags = ["retroarch", "yuzu", "ryujinx", "pcsx2", "rpcs3", "dolphin", "cemu", "citra", "ppsspp"]
            if any(emu in exe_name for emu in emulator_tags) and window_title:
                try:
                    clean_title = window_title.split(' - ')[0].split(' | ')[-1].strip()
                    return {"title": clean_title, "process": exe_name, "platform": "Emulator"}
                except Exception as e:
                    self.log(f"[FORMATTER DEBUG] Emulator string split failed: {str(e)}", "warning", 300)

        # === MAC PLIST PARSER ===
        if sys.platform == "darwin" and ".app/Contents/MacOS" in exe_path:
            import plistlib
            try:
                plist_path = exe_path.split("Contents/MacOS")[0] + "Contents/Info.plist"
                with open(plist_path, 'rb') as f:
                    plist = plistlib.load(f)
                    if plist.get("CFBundleDisplayName"):
                        return {"title": plist["CFBundleDisplayName"], "process": exe_name, "platform": "macOS App"}
            except Exception as e:
                self.log(f"[FORMATTER DEBUG] macOS Plist read failed: {str(e)}", "warning", 300)

        # === THE NEW UNREAL ENGINE / GENERIC FOLDER FIX ===
        if (any(gn in exe_name for gn in generic_names) or not window_title) and exe_path:
            clean_title = self._extract_true_game_name(exe_path).replace("_", " ").title()
        else:
            clean_title = window_title if window_title else exe_name.replace(".exe", "").title()
            
        return {"title": clean_title, "process": exe_name, "platform": platform_tag}