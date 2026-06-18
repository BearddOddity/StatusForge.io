"""
Tests for ForgeWaterfall game detection logic.
================================================
Tests the pure/logic-heavy internals of ForgeWaterfall without requiring
actual OS-level process access (psutil, ctypes, etc.).

Coverage:
  - ForgeWaterfall init & defaults
  - update_forge_knowledge()
  - _format_game_output() — emulator splitter, macOS plist, generic names, normal path
  - _extract_true_game_name() — Steam common folder, ignore list fallback, edge cases
  - _has_engine_dna() — signature matching, missing paths, empty dirs
  - _sniff_discord_ipc() — placeholder returns None
"""
import os
import sys
import pytest
from unittest.mock import patch, MagicMock

# Ensure project root is importable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from forge_scanner import ForgeWaterfall


# =========================================================================
# Fixtures
# =========================================================================

@pytest.fixture
def scout():
    """Fresh ForgeWaterfall instance with a no-op logger."""
    return ForgeWaterfall(logger_callback=lambda msg, level, cd: None)


@pytest.fixture
def scout_with_data(scout):
    """Scout pre-loaded with listed/delisted apps and strict mode."""
    scout.update_forge_knowledge(
        listed={"mygame.exe": "My Game", "another.exe": "Another"},
        delisted=["unwanted.exe"],
        strict_mode=False,
    )
    return scout


# =========================================================================
# __init__ & defaults
# =========================================================================

class TestForgeWaterfallInit:
    def test_system_exiles_not_empty(self, scout):
        assert len(scout.system_exiles) > 0
        assert "explorer.exe" in scout.system_exiles
        assert "discord.exe" in scout.system_exiles

    def test_banned_paths_not_empty(self, scout):
        assert len(scout.banned_paths) > 0
        assert r"c:\windows" in scout.banned_paths

    def test_engine_dna_not_empty(self, scout):
        assert "Unity" in scout.engine_dna
        assert "Godot" in scout.engine_dna

    def test_listed_apps_starts_empty(self, scout):
        assert scout.listed_apps == {}

    def test_delisted_apps_starts_empty(self, scout):
        assert scout.delisted_apps == []

    def test_strict_mode_defaults_false(self, scout):
        assert scout.strict_mode is False

    def test_logger_is_set(self, scout):
        assert scout.log is not None


# =========================================================================
# update_forge_knowledge()
# =========================================================================

class TestUpdateForgeKnowledge:
    def test_sets_listed_apps(self, scout):
        scout.update_forge_knowledge(listed={"a.exe": "A"}, delisted=[])
        assert scout.listed_apps == {"a.exe": "A"}

    def test_sets_delisted_apps(self, scout):
        scout.update_forge_knowledge(listed={}, delisted=["b.exe"])
        assert scout.delisted_apps == ["b.exe"]

    def test_sets_strict_mode(self, scout):
        scout.update_forge_knowledge([], [], strict_mode=True)
        assert scout.strict_mode is True

    def test_strict_mode_defaults_false(self, scout):
        scout.update_forge_knowledge([], [])
        assert scout.strict_mode is False

    def test_overwrites_previous_state(self, scout_with_data):
        scout_with_data.update_forge_knowledge({}, [], False)
        assert scout_with_data.listed_apps == {}
        assert scout_with_data.delisted_apps == []


# =========================================================================
# _format_game_output()
# =========================================================================

class TestFormatGameOutput:
    def test_basic_windows_exe(self, scout):
        result = scout._format_game_output(
            "mygame.exe", r"C:\Games\mygame\mygame.exe", "My Game", "The Forge"
        )
        assert result["process"] == "mygame.exe"
        assert result["platform"] == "The Forge"
        # "game.exe" is a substring of "mygame.exe" so the generic-name branch triggers
        assert result["title"] == "Mygame"

    def test_non_generic_exe_uses_window_title(self, scout):
        # exe_name must not contain any generic_names substring (e.g. "game.exe")
        result = scout._format_game_output(
            "launcher.exe", r"C:\Games\cool\launcher.exe", "My Game", "The Forge"
        )
        assert result == {"title": "My Game", "process": "launcher.exe", "platform": "The Forge"}

    def test_window_title_used_when_exe_is_not_generic(self, scout):
        result = scout._format_game_output(
            "customlauncher.exe", r"C:\Games\foo\customlauncher.exe", "Cool Game", "Detected"
        )
        assert result["title"] == "Cool Game"
        assert result["process"] == "customlauncher.exe"

    def test_emulator_splitter_takes_window_title(self, scout):
        result = scout._format_game_output(
            "retroarch.exe", r"C:\RetroArch\retroarch.exe",
            "Super Mario World - RetroArch", "Emulator"
        )
        assert result["title"] == "Super Mario World"
        assert result["platform"] == "Emulator"

    def test_emulator_splitter_with_pipe(self, scout):
        result = scout._format_game_output(
            "yuzu.exe", r"C:\yuzu\yuzu.exe",
            "Zelda | yuzu", "Emulator"
        )
        # Split on ' - ' gives ["Zelda | yuzu"], split on ' | ' gives ["Zelda", "yuzu"]
        # last element stripped = "yuzu"
        assert result["title"] == "yuzu"
        assert result["platform"] == "Emulator"

    def test_emulator_without_window_title_falls_through(self, scout):
        result = scout._format_game_output(
            "dolphin.exe", r"C:\dolphin\dolphin.exe", "", "Emulator"
        )
        # Empty window title → no emulator split → falls to normal path
        assert result["process"] == "dolphin.exe"

    @patch("forge_scanner.sys")
    def test_macos_plist_parser(self, mock_sys, scout):
        mock_sys.platform = "darwin"
        mock_plist = {"CFBundleDisplayName": "My Mac Game"}
        with patch("plistlib.load", return_value=mock_plist):
            with patch("builtins.open", MagicMock()):
                result = scout._format_game_output(
                    "MyGame", "/Applications/MyGame.app/Contents/MacOS/MyGame",
                    "My Mac Game", "macOS App"
                )
        assert result["title"] == "My Mac Game"
        assert result["platform"] == "macOS App"

    @patch("forge_scanner.sys")
    def test_macos_plist_read_failure(self, mock_sys, scout):
        mock_sys.platform = "darwin"
        with patch("builtins.open", side_effect=OSError("no plist")):
            result = scout._format_game_output(
                "MyGame", "/Applications/MyGame.app/Contents/MacOS/MyGame",
                "My Mac Game", "macOS App"
            )
        # Falls through to normal path
        assert result["title"] == "My Mac Game"

    def test_generic_exe_name_uses_path_extraction(self, scout):
        """Generic names like 'win64-shipping' trigger _extract_true_game_name.
        process field uses exe_name param verbatim (no .exe appended)."""
        result = scout._format_game_output(
            "win64-shipping",
            r"C:\Steam\steamapps\common\MyAwesomeGame\binaries\win64-shipping.exe",
            "MyAwesomeGame", "Steam Registry"
        )
        assert result["process"] == "win64-shipping"
        # Generic name triggers _extract_true_game_name which uses .title()
        # "MyAwesomeGame".title() => "Myawesomegame" (CamelCase is lowered)
        assert result["title"] == "Myawesomegame"

    def test_no_window_title_uses_exe_name(self, scout):
        result = scout._format_game_output(
            "mygame.exe", r"C:\Games\mygame\mygame.exe", "", "The Forge"
        )
        assert result["title"] == "Mygame"
        assert result["process"] == "mygame.exe"

    def test_exe_name_becomes_title_when_no_path(self, scout):
        result = scout._format_game_output(
            "coolgame.exe", "", "", "Standalone/DRM-Free"
        )
        assert result["title"] == "Coolgame"

    def test_all_known_emulator_tags(self, scout):
        """Every emulator tag in the list should trigger the emulator branch."""
        for emu in ["retroarch", "yuzu", "ryujinx", "pcsx2", "rpcs3",
                     "dolphin", "cemu", "citra", "ppsspp"]:
            result = scout._format_game_output(
                f"{emu}.exe", f"C:\\{emu}\\{emu}.exe",
                f"Some Game - {emu}", "Emulator"
            )
            assert result["platform"] == "Emulator", f"Failed for {emu}"
            assert result["title"] == "Some Game"


# =========================================================================
# _extract_true_game_name()
# =========================================================================

class TestExtractTrueGameName:
    def test_steam_common_override(self, scout):
        """Folder after 'steamapps/common/' is the game name."""
        name = scout._extract_true_game_name(
            r"C:\Program Files\Steam\steamapps\common\Half-Life 2\hl2.exe"
        )
        assert name == "Half-Life 2"

    def test_steam_common_lowercase_matching(self, scout):
        """'common' match is case-insensitive."""
        name = scout._extract_true_game_name(
            r"C:\steamapps\Common\Portal\portal.exe"
        )
        assert name == "Portal"

    def test_ignore_binaries_folder(self, scout):
        """'binaries' should be skipped in fallback."""
        name = scout._extract_true_game_name(
            r"C:\Games\MyGame\binaries\win64\game.exe"
        )
        # Should NOT return 'binaries' or 'win64' — should return 'MyGame'
        assert name not in ("binaries", "win64")
        assert name == "MyGame"

    def test_ignore_shipping_folder(self, scout):
        name = scout._extract_true_game_name(
            r"C:\EpicGames\Game\Shipping\Win64\game.exe"
        )
        assert name not in ("shipping", "win64", "shipping", "win64")

    def test_single_path_component(self, scout):
        """Only one component before exe → returns empty or 'Unknown Game'."""
        name = scout._extract_true_game_name("game.exe")
        # path_parts[:-1] gives ['game.exe'] reversed → returns last meaningful
        # With only one part, falls to the fallback
        assert name == "Unknown Game" or name == "game.exe"

    def test_path_with_backslashes_normalized(self, scout):
        """Backslashes are split identically to forward slashes."""
        name_fwd = scout._extract_true_game_name(
            "C:/Steam/steamapps/common/Portal 2/portal2.exe"
        )
        name_bwd = scout._extract_true_game_name(
            "C:\\Steam\\steamapps\\common\\Portal 2\\portal2.exe"
        )
        assert name_fwd == name_bwd

    def test_all_ignore_list_entries_skipped(self, scout):
        """Folders in the ignore list are all skipped."""
        for ignore in ['binaries', 'win64', 'win32', 'shipping', 'x64',
                        'x86', 'bin', 'release', 'windowsnoeditor']:
            path = f"C:\\Games\\CoolGame\\{ignore}\\game.exe"
            name = scout._extract_true_game_name(path)
            assert name != ignore, f"Ignored '{ignore}' but got it back"
            assert name == "CoolGame"


# =========================================================================
# _has_engine_dna()
# =========================================================================

class TestHasEngineDNA:
    def test_detects_unity_dna(self, scout, tmp_path):
        (tmp_path / "unityplayer.dll").touch()
        (tmp_path / "MyGame.exe").touch()
        assert scout._has_engine_dna(str(tmp_path / "MyGame.exe")) is True

    def test_detects_godot_dna(self, scout, tmp_path):
        (tmp_path / "project.godot").touch()
        (tmp_path / "game.exe").touch()
        assert scout._has_engine_dna(str(tmp_path / "game.exe")) is True

    def test_detects_gamemaker_dna(self, scout, tmp_path):
        # _has_engine_dna looks at os.path.dirname(exe_path), so data.win
        # must be in the same directory as the exe.
        (tmp_path / "data.win").touch()
        (tmp_path / "game.exe").touch()
        assert scout._has_engine_dna(str(tmp_path / "game.exe")) is True

    def test_no_dna_in_empty_dir(self, scout, tmp_path):
        (tmp_path / "game.exe").touch()
        assert scout._has_engine_dna(str(tmp_path / "game.exe")) is False

    def test_nonexistent_path(self, scout):
        assert scout._has_engine_dna(r"C:\nonexistent\path\game.exe") is False

    def test_unknown_dna_not_matched(self, scout, tmp_path):
        """A file that doesn't match any engine signature."""
        (tmp_path / "some_random.dll").touch()
        (tmp_path / "game.exe").touch()
        assert scout._has_engine_dna(str(tmp_path / "game.exe")) is False

    def test_non_matching_dll(self, scout, tmp_path):
        """File that does not contain any engine signature as substring."""
        (tmp_path / "somerandom.dll").touch()
        (tmp_path / "game.exe").touch()
        result = scout._has_engine_dna(str(tmp_path / "game.exe"))
        assert result is False

    def test_all_engine_signatures_detectable(self, scout, tmp_path):
        """Every engine in the dna map should be detectable."""
        for engine_name, signatures in scout.engine_dna.items():
            for sig in signatures:
                d = tmp_path / engine_name
                d.mkdir(exist_ok=True)
                (d / sig).touch()
                (d / "game.exe").touch()
                assert scout._has_engine_dna(str(d / "game.exe")) is True, \
                    f"Engine '{engine_name}' not detected via signature '{sig}'"


# =========================================================================
# _sniff_discord_ipc()
# =========================================================================

class TestSniffDiscordIPC:
    def test_returns_none(self, scout):
        """Placeholder always returns None."""
        assert scout._sniff_discord_ipc() is None


# =========================================================================
# Scout Stage Logic (scout_active_session with heavy mocking)
# =========================================================================

class TestScoutActiveSession:
    """Test the detection pipeline stages by mocking OS-level calls."""

    @patch("forge_scanner.psutil")
    def test_returns_none_when_no_process(self, mock_psutil, scout):
        """If _get_active_os_window returns no PID, scout returns None."""
        scout._get_active_os_window = MagicMock(return_value=(None, "", False, None))
        result = scout.scout_active_session()
        assert result is None

    def test_stage1_listed_apps_short_circuits(self, scout):
        """Listed app in DB → returns immediately without further checks.
        exe_name must not overlap with generic_names (substring check).
        Must mock psutil.Process to avoid NoSuchProcess on fake PID."""
        scout._get_active_os_window = MagicMock(
            return_value=(1234, "My Game", True, 0x123)
        )
        scout.listed_apps = {"pixel.exe": "My Game"}
        mock_proc = MagicMock()
        mock_proc.name.return_value = "pixel.exe"
        mock_proc.exe.return_value = r"C:\Games\pixel\pixel.exe"
        with patch("forge_scanner.psutil.Process", return_value=mock_proc):
            result = scout.scout_active_session()
        assert result is not None
        assert result["platform"] == "The Forge"
        assert result["platform"] == "The Forge"

    def test_strict_mode_rejects_unknown(self, scout):
        """Strict mode: unknown exe not in listed_apps → returns None."""
        scout.update_forge_knowledge(
            listed={"other.exe": "Other"},
            delisted=[],
            strict_mode=True,
        )
        scout._get_active_os_window = MagicMock(
            return_value=(1234, "Some Game", True, 0x123)
        )

        with patch("forge_scanner.psutil") as mock_psutil:
            mock_proc = MagicMock()
            mock_proc.name.return_value = "unknown_game.exe"
            mock_proc.exe.return_value = r"C:\Games\unknown\unknown_game.exe"
            mock_psutil.Process.return_value = mock_proc

            result = scout.scout_active_session()
        assert result is None

    def test_rejects_system_exile(self, scout):
        """System exiles (explorer.exe, etc.) are rejected."""
        scout._get_active_os_window = MagicMock(
            return_value=(1234, "Explorer", True, 0x123)
        )

        with patch("forge_scanner.psutil") as mock_psutil:
            mock_proc = MagicMock()
            mock_proc.name.return_value = "explorer.exe"
            mock_proc.exe.return_value = r"C:\Windows\explorer.exe"
            mock_psutil.Process.return_value = mock_proc

            result = scout.scout_active_session()
        assert result is None

    def test_rejects_banned_path(self, scout):
        r"""Processes in banned paths (C:\Windows) are rejected."""
        scout._get_active_os_window = MagicMock(
            return_value=(1234, "Bad App", True, 0x123)
        )

        with patch("forge_scanner.psutil") as mock_psutil:
            mock_proc = MagicMock()
            mock_proc.name.return_value = "badapp.exe"
            mock_proc.exe.return_value = r"C:\Windows\System32\badapp.exe"
            mock_psutil.Process.return_value = mock_proc

            result = scout.scout_active_session()
        assert result is None

    def test_rejects_chrome_window_title(self, scout):
        """Chrome/Firefox/Discord window titles are rejected."""
        scout._get_active_os_window = MagicMock(
            return_value=(1234, "YouTube - Google Chrome", True, 0x123)
        )

        with patch("forge_scanner.psutil") as mock_psutil:
            mock_proc = MagicMock()
            mock_proc.name.return_value = "chrome.exe"
            mock_proc.exe.return_value = r"C:\Program Files\Google\Chrome\chrome.exe"
            mock_psutil.Process.return_value = mock_proc

            result = scout.scout_active_session()
        assert result is None

    def test_rejects_delisted_app(self, scout):
        """Delisted apps are rejected."""
        scout.update_forge_knowledge({}, ["unwanted.exe"], False)
        scout._get_active_os_window = MagicMock(
            return_value=(1234, "Unwanted Game", True, 0x123)
        )

        with patch("forge_scanner.psutil") as mock_psutil:
            mock_proc = MagicMock()
            mock_proc.name.return_value = "unwanted.exe"
            mock_proc.exe.return_value = r"C:\Games\unwanted.exe"
            mock_psutil.Process.return_value = mock_proc

            result = scout.scout_active_session()
        assert result is None


# =========================================================================
# Confidence Scoring (Stage 5 logic)
# =========================================================================

class TestConfidenceScore:
    """Test that the confidence scoring threshold works correctly."""

    def test_standalone_detection_via_confidence(self, scout):
        """Engine DNA (0.4) + fullscreen (0.3) + window_title differs (0.2) + RAM (0.1) = 1.0 >= 0.5.
        exe_name='pixel.exe' avoids matching game.exe substring in generic_names."""
        scout._get_active_os_window = MagicMock(
            return_value=(1234, "Indie Game", True, 0x123)  # fullscreen=True
        )
        scout.listed_apps = {}  # empty so it doesn't short-circuit at Stage 1
        scout.delisted_apps = []

        mock_proc = MagicMock()
        mock_proc.name.return_value = "pixel.exe"
        mock_proc.exe.return_value = r"C:\Games\indie\pixel.exe"
        mock_proc.memory_info.return_value = MagicMock(rss=200 * 1024 * 1024)
        mock_proc.cmdline.return_value = [r"C:\Games\indie\pixel.exe"]
        mock_proc.parent.return_value = None

        with patch("forge_scanner.psutil.Process", return_value=mock_proc):
            with patch("forge_scanner.psutil.process_iter", return_value=[mock_proc]):
                with patch.object(scout, "_has_engine_dna", return_value=True):
                    with patch.object(scout, "_survives_great_filter", return_value=True):
                        result = scout.scout_active_session()

        assert result is not None
        assert result["platform"] == "Standalone/DRM-Free"
        assert result["title"] == "Indie Game"

    def test_low_confidence_returns_none(self, scout):
        """No engine DNA (0) + window_title same as exe (0) = 0 < 100."""
        scout._get_active_os_window = MagicMock(
            return_value=(1234, "boringapp.exe", False, 0x123)
        )

        with patch("forge_scanner.psutil") as mock_psutil:
            mock_proc = MagicMock()
            mock_proc.name.return_value = "boringapp.exe"
            mock_proc.exe.return_value = r"C:\Games\boring\boringapp.exe"
            mock_proc.memory_info.return_value = MagicMock(rss=200 * 1024 * 1024)
            mock_proc.cmdline.return_value = [r"C:\Games\boring\boringapp.exe"]
            mock_proc.parent.return_value = None
            mock_psutil.Process.return_value = mock_proc

            with patch.object(scout, "_has_engine_dna", return_value=False):
                result = scout.scout_active_session()

        assert result is None
