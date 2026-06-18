"""
Tests for presence/scanner.py
===============================
Covers fetch_verified_variants and deploy_public_layouts.
"""
import os
import sys
import json
import tempfile
import shutil
import pytest
from unittest.mock import patch, MagicMock, mock_open

# presence and BASE_DIR are set up in conftest.py
from presence.scanner import fetch_verified_variants, deploy_public_layouts  # noqa: E402


# =========================================================================
# fetch_verified_variants
# =========================================================================

class TestFetchVerifiedVariants:
    def test_returns_empty_list_when_no_steam_id(self):
        result = fetch_verified_variants("Some Game", steam_id=None)
        assert result == []

    def test_returns_empty_list_for_empty_steam_id(self):
        result = fetch_verified_variants("Some Game", steam_id="")
        assert result == []

    @patch("presence.scanner.log_smart")
    def test_handles_network_failure_gracefully(self, mock_log):
        """Should return empty list on network error, not raise."""
        with patch("urllib.request.urlopen", side_effect=Exception("Network down")):
            result = fetch_verified_variants("Test Game", steam_id="12345")
        assert result == []

    @patch("presence.scanner.log_smart")
    def test_handles_timeout_gracefully(self, mock_log):
        with patch("urllib.request.urlopen", side_effect=TimeoutError("Timed out")):
            result = fetch_verified_variants("Test Game", steam_id="12345")
        assert result == []

    @patch("presence.scanner.log_smart")
    def test_handles_malformed_json_response(self, mock_log):
        mock_response = MagicMock()
        mock_response.read.return_value = b"not json"
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)
        with patch("urllib.request.urlopen", return_value=mock_response):
            result = fetch_verified_variants("Test Game", steam_id="12345")
        assert result == []

    def _mock_response(self, data_dict):
        """Create a mock urllib response that supports with-statement and .read().decode()."""
        raw = json.dumps(data_dict).encode("utf-8")
        mock_resp = MagicMock()
        mock_resp.read.return_value = raw
        # Support "with urlopen(...) as res" context manager protocol
        mock_resp.__enter__ = MagicMock(return_value=mock_resp)
        mock_resp.__exit__ = MagicMock(return_value=False)
        return mock_resp

    @patch("presence.scanner.log_smart")
    def test_extracts_executables_from_launch_config(self, mock_log):
        """Parses SteamCMD response and extracts executable names."""
        response_data = {
            "data": {
                "12345": {
                    "config": {
                        "launch": {
                            "0": {"executable": "game.exe", "type": "launch"},
                            "1": {"executable": "binaries/win64/game.exe", "type": "launch"}
                        }
                    }
                }
            }
        }
        with patch("urllib.request.urlopen", return_value=self._mock_response(response_data)):
            result = fetch_verified_variants("Test Game", steam_id="12345")

        assert "game.exe" in result

    @patch("presence.scanner.log_smart")
    def test_deduplicates_executables(self, mock_log):
        """Same executable from different launch entries should appear once."""
        response_data = {
            "data": {
                "12345": {
                    "config": {
                        "launch": {
                            "0": {"executable": "game.exe"},
                            "1": {"executable": "game.exe"}
                        }
                    }
                }
            }
        }
        with patch("urllib.request.urlopen", return_value=self._mock_response(response_data)):
            result = fetch_verified_variants("Test Game", steam_id="12345")

        assert result.count("game.exe") == 1

    @patch("presence.scanner.log_smart")
    def test_handles_missing_launch_data(self, mock_log):
        """Response with no launch config should return empty list."""
        response_data = {"data": {"12345": {"config": {}}}}
        with patch("urllib.request.urlopen", return_value=self._mock_response(response_data)):
            result = fetch_verified_variants("Test Game", steam_id="12345")

        assert result == []

    @patch("presence.scanner.log_smart")
    def test_handles_empty_data_response(self, mock_log):
        """Empty data dict should return empty list."""
        response_data = {"data": {}}
        with patch("urllib.request.urlopen", return_value=self._mock_response(response_data)):
            result = fetch_verified_variants("Test Game", steam_id="12345")

        assert result == []

    @patch("presence.scanner.log_smart")
    def test_lowercases_executable_names(self, mock_log):
        """Executable names should be lowercased."""
        response_data = {
            "data": {
                "12345": {
                    "config": {
                        "launch": {
                            "0": {"executable": "MyGame.EXE"}
                        }
                    }
                }
            }
        }
        with patch("urllib.request.urlopen", return_value=self._mock_response(response_data)):
            result = fetch_verified_variants("Test Game", steam_id="12345")

        assert "mygame.exe" in result


# =========================================================================
# deploy_public_layouts
# =========================================================================

class TestDeployPublicLayouts:
    def test_creates_target_dir_when_missing(self, tmp_path, monkeypatch):
        """Should create the Public/StatusForge/widgets directory."""
        public_dir = tmp_path / "Public"
        public_dir.mkdir()
        monkeypatch.setenv("PUBLIC", str(public_dir))

        widgets_src = tmp_path / "widgets"
        widgets_src.mkdir()
        (widgets_src / "test.html").write_text("<html>test</html>")

        # Patch the source path
        with patch("presence.scanner.os.path.dirname") as mock_dirname:
            mock_dirname.side_effect = [
                str(tmp_path / "presence"),  # __file__ dirname
                str(tmp_path),               # parent of presence
            ]
            deploy_public_layouts()

        target = public_dir / "StatusForge" / "widgets"
        assert target.exists()
        assert (target / "test.html").exists()

    def test_copies_widget_files(self, tmp_path, monkeypatch):
        """Widget files from source should appear in target."""
        public_dir = tmp_path / "Public"
        public_dir.mkdir()
        monkeypatch.setenv("PUBLIC", str(public_dir))

        widgets_src = tmp_path / "widgets"
        widgets_src.mkdir()
        (widgets_src / "widget1.html").write_text("widget1")
        (widgets_src / "widget2.css").write_text("widget2")

        with patch("presence.scanner.os.path.dirname") as mock_dirname:
            mock_dirname.side_effect = [
                str(tmp_path / "presence"),
                str(tmp_path),
            ]
            deploy_public_layouts()

        target = public_dir / "StatusForge" / "widgets"
        assert (target / "widget1.html").read_text() == "widget1"
        assert (target / "widget2.css").read_text() == "widget2"

    def test_handles_missing_source_gracefully(self, tmp_path, monkeypatch):
        """If source widgets dir doesn't exist, should not raise."""
        public_dir = tmp_path / "Public"
        public_dir.mkdir()
        monkeypatch.setenv("PUBLIC", str(public_dir))

        # Source doesn't exist — should not raise
        with patch("presence.scanner.os.path.dirname") as mock_dirname:
            mock_dirname.side_effect = [
                str(tmp_path / "presence"),
                str(tmp_path),
            ]
            deploy_public_layouts()  # Should not raise

    def test_overwrites_existing_target(self, tmp_path, monkeypatch):
        """Re-deploying should update existing files."""
        public_dir = tmp_path / "Public"
        public_dir.mkdir()
        monkeypatch.setenv("PUBLIC", str(public_dir))

        target = public_dir / "StatusForge" / "widgets"
        target.mkdir(parents=True)
        (target / "old.html").write_text("old content")

        widgets_src = tmp_path / "widgets"
        widgets_src.mkdir()
        (widgets_src / "old.html").write_text("new content")

        with patch("presence.scanner.os.path.dirname") as mock_dirname:
            mock_dirname.side_effect = [
                str(tmp_path / "presence"),
                str(tmp_path),
            ]
            deploy_public_layouts()

        assert (target / "old.html").read_text() == "new content"
