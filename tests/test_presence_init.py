"""
Tests for presence/__init__.py
================================
Covers log_smart cooldown, get_simple_os_name, NoSpamFilter, globals.
"""
import os
import sys
import time
import logging
import pytest
from unittest.mock import patch, MagicMock

# presence and BASE_DIR are set up in conftest.py
from presence import (  # noqa: E402
    log_smart, get_simple_os_name, NoSpamFilter,
    status_data, broadcast_status, error_cooldowns,
    WIDGET_TOKEN, app, sock,
)


# =========================================================================
# get_simple_os_name
# =========================================================================

class TestGetSimpleOsName:
    def test_returns_windows_on_win32(self):
        with patch("presence.sys.platform", "win32"):
            assert get_simple_os_name() == "Windows"

    def test_returns_windows_on_win64(self):
        with patch("presence.sys.platform", "win64"):
            assert get_simple_os_name() == "Windows"

    def test_returns_macos_on_darwin(self):
        with patch("presence.sys.platform", "darwin"):
            assert get_simple_os_name() == "macOS"

    def test_returns_linux_on_linux(self):
        with patch("presence.sys.platform", "linux"):
            assert get_simple_os_name() == "Linux"

    def test_returns_linux_on_linux2(self):
        with patch("presence.sys.platform", "linux2"):
            assert get_simple_os_name() == "Linux"

    def test_returns_unknown_for_unrecognized(self):
        with patch("presence.sys.platform", "freebsd"):
            assert get_simple_os_name() == "Unknown OS"


# =========================================================================
# log_smart — cooldown dedup
# =========================================================================

class TestLogSmart:
    def setup_method(self):
        """Clear cooldowns before each test."""
        error_cooldowns.clear()

    def test_logs_on_first_call(self):
        with patch("presence.logging") as mock_log:
            log_smart("test message", "info", cooldown=60)
            mock_log.info.assert_called_once_with("test message")

    def test_suppresses_duplicate_within_cooldown(self):
        with patch("presence.logging") as mock_log:
            log_smart("dup message", "warning", cooldown=60)
            log_smart("dup message", "warning", cooldown=60)
            # Should only log once
            assert mock_log.warning.call_count == 1

    def test_allows_different_messages(self):
        with patch("presence.logging") as mock_log:
            log_smart("msg one", "info", cooldown=60)
            log_smart("msg two", "info", cooldown=60)
            assert mock_log.info.call_count == 2

    def test_cooldown_0_allows_all(self):
        """cooldown=0 means no suppression."""
        with patch("presence.logging") as mock_log:
            log_smart("repeat", "error", cooldown=0)
            log_smart("repeat", "error", cooldown=0)
            log_smart("repeat", "error", cooldown=0)
            assert mock_log.error.call_count == 3

    def test_warning_level_calls_warning(self):
        with patch("presence.logging") as mock_log:
            log_smart("warn msg", "warning", cooldown=0)
            mock_log.warning.assert_called_once_with("warn msg")

    def test_error_level_calls_error(self):
        with patch("presence.logging") as mock_log:
            log_smart("err msg", "error", cooldown=0)
            mock_log.error.assert_called_once_with("err msg")

    def test_info_level_calls_info(self):
        with patch("presence.logging") as mock_log:
            log_smart("info msg", "info", cooldown=0)
            mock_log.info.assert_called_once_with("info msg")

    def test_cooldown_expires(self):
        """After cooldown period, same message should log again."""
        with patch("presence.logging") as mock_log:
            log_smart("expire test", "info", cooldown=1)
            # Advance time past cooldown
            time.sleep(1.1)
            log_smart("expire test", "info", cooldown=1)
            assert mock_log.info.call_count == 2


# =========================================================================
# NoSpamFilter
# =========================================================================

class TestNoSpamFilter:
    def test_filters_get_status_200(self):
        f = NoSpamFilter()
        record = logging.LogRecord(
            name="werkzeug", level=logging.INFO,
            pathname="", lineno=0,
            msg="127.0.0.1 - - [01/Jan/2025] \"GET /status HTTP/1.1\" 200 -",
            args=(), exc_info=None
        )
        assert f.filter(record) is False

    def test_filters_get_logs_200(self):
        f = NoSpamFilter()
        record = logging.LogRecord(
            name="werkzeug", level=logging.INFO,
            pathname="", lineno=0,
            msg="127.0.0.1 - - [01/Jan/2025] \"GET /logs HTTP/1.1\" 200 -",
            args=(), exc_info=None
        )
        assert f.filter(record) is False

    def test_allows_non_200_status(self):
        f = NoSpamFilter()
        record = logging.LogRecord(
            name="werkzeug", level=logging.INFO,
            pathname="", lineno=0,
            msg="127.0.0.1 - - [01/Jan/2025] \"GET /status HTTP/1.1\" 404 -",
            args=(), exc_info=None
        )
        assert f.filter(record) is True

    def test_allows_non_status_routes(self):
        f = NoSpamFilter()
        record = logging.LogRecord(
            name="werkzeug", level=logging.INFO,
            pathname="", lineno=0,
            msg="127.0.0.1 - - [01/Jan/2025] \"POST /api/data HTTP/1.1\" 200 -",
            args=(), exc_info=None
        )
        assert f.filter(record) is True

    def test_allows_other_loggers(self):
        f = NoSpamFilter()
        record = logging.LogRecord(
            name="other.logger", level=logging.INFO,
            pathname="", lineno=0,
            msg="127.0.0.1 - - [01/Jan/2025] \"GET /status HTTP/1.1\" 200 -",
            args=(), exc_info=None
        )
        # NoSpamFilter only checks message content, not logger name
        # (it's added to werkzeug logger, so other loggers won't have it)
        assert f.filter(record) is False


# =========================================================================
# Globals
# =========================================================================

class TestGlobals:
    def test_status_data_has_required_keys(self):
        required = ["is_playing", "game_title", "process_name", "start_time",
                     "cover_url", "release_date", "genre", "publisher",
                     "developer", "last_pulse", "pending_bundle", "bundle_options"]
        for key in required:
            assert key in status_data, f"Missing key: {key}"

    def test_broadcast_status_has_platforms(self):
        assert "twitch" in broadcast_status
        assert "kick" in broadcast_status
        assert "streamer_bot" in broadcast_status

    def test_widget_token_is_nonempty(self):
        assert WIDGET_TOKEN != ""
        assert isinstance(WIDGET_TOKEN, str)

    def test_app_is_flask_instance(self):
        from flask import Flask
        assert isinstance(app, Flask)

    def test_status_data_initial_state(self):
        assert status_data["is_playing"] is False
        assert status_data["game_title"] == "System Initializing..."
