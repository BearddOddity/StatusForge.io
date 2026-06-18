"""
Tests for presence/websocket.py
=================================
Covers broadcast_to_widgets and widget_websocket dead-socket cleanup.
"""
import os
import sys
import json
import pytest
from unittest.mock import MagicMock, patch

# presence and BASE_DIR are set up in conftest.py
from presence.websocket import broadcast_to_widgets  # noqa: E402
from presence import connected_widgets, status_data  # noqa: E402


# =========================================================================
# broadcast_to_widgets
# =========================================================================

class TestBroadcastToWidgets:
    def setup_method(self):
        connected_widgets.clear()

    def test_sends_to_all_connected(self):
        ws1 = MagicMock()
        ws2 = MagicMock()
        connected_widgets.add(ws1)
        connected_widgets.add(ws2)

        broadcast_to_widgets()

        ws1.send.assert_called_once()
        ws2.send.assert_called_once()

    def test_payload_is_valid_json(self):
        ws = MagicMock()
        connected_widgets.add(ws)

        broadcast_to_widgets()

        sent = ws.send.call_args[0][0]
        data = json.loads(sent)
        assert "event" in data
        assert data["event"] == "update"
        assert "payload" in data

    def test_payload_contains_status_data(self):
        ws = MagicMock()
        connected_widgets.add(ws)

        broadcast_to_widgets()

        sent = ws.send.call_args[0][0]
        data = json.loads(sent)
        assert data["payload"]["game_title"] == status_data["game_title"]

    def test_removes_dead_sockets(self):
        """Sockets that raise on send should be removed."""
        dead_ws = MagicMock()
        dead_ws.send.side_effect = Exception("Connection lost")
        alive_ws = MagicMock()
        connected_widgets.add(dead_ws)
        connected_widgets.add(alive_ws)

        broadcast_to_widgets()

        assert dead_ws not in connected_widgets
        assert alive_ws in connected_widgets

    def test_handles_empty_widget_set(self):
        """No widgets connected — should not raise."""
        connected_widgets.clear()
        broadcast_to_widgets()  # Should not raise

    def test_handles_all_dead_sockets(self):
        dead1 = MagicMock()
        dead1.send.side_effect = Exception("dead")
        dead2 = MagicMock()
        dead2.send.side_effect = Exception("dead")
        connected_widgets.add(dead1)
        connected_widgets.add(dead2)

        broadcast_to_widgets()

        assert len(connected_widgets) == 0

    def test_sends_current_status_snapshot(self):
        """Each widget should receive the same current status."""
        status_data["game_title"] = "Test Game"
        ws1 = MagicMock()
        ws2 = MagicMock()
        connected_widgets.add(ws1)
        connected_widgets.add(ws2)

        broadcast_to_widgets()

        sent1 = json.loads(ws1.send.call_args[0][0])
        sent2 = json.loads(ws2.send.call_args[0][0])
        assert sent1["payload"]["game_title"] == "Test Game"
        assert sent2["payload"]["game_title"] == "Test Game"
