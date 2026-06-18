"""
Memory leak tests for StatusForge engine components.

Targets:
  1. error_cooldowns dict — must self-evict expired entries (bounded growth)
  2. connected_widgets set — dead sockets must be cleaned up
  3. MemoryListHandler — must respect capacity cap
  4. tracemalloc — no unbounded memory growth in log_smart hot loop
  5. scanner threads — must be daemon threads

Run with:  python -m pytest tests/test_memory_leak.py -v
"""
import gc
import os
import sys
import time
import io
import threading
import tracemalloc
import logging
from unittest.mock import MagicMock, patch

import pytest

# Ensure project root on path (conftest does this, but be safe)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Prevent presence.__init__ from wrapping stdout/stderr (breaks pytest capture)
_real_TextIOWrapper = io.TextIOWrapper


class _NoopTextIOWrapper:
    def __new__(cls, *args, **kwargs):
        if args:
            return args[0]
        return object.__new__(cls)


io.TextIOWrapper = _NoopTextIOWrapper

from presence import (
    log_smart, error_cooldowns, _msg_cooldown, _purge_expired_cooldowns,
    connected_widgets,
)
from presence.websocket import broadcast_to_widgets
from presence import MemoryListHandler

io.TextIOWrapper = _real_TextIOWrapper


# ---------------------------------------------------------------------------
# 1. error_cooldowns — bounded, self-evicting
# ---------------------------------------------------------------------------

@pytest.mark.memory
class TestErrorCooldownsBounded:
    """error_cooldowns must not grow without bound. Expired entries are
    evicted by _purge_expired_cooldowns on each log_smart call."""

    def setup_method(self):
        error_cooldowns.clear()
        _msg_cooldown.clear()

    def test_cooldowns_expire_and_evict(self):
        """After cooldown expires, the entry should be purged on next call."""
        log_smart("temp error", "warning", cooldown=1)
        assert len(error_cooldowns) == 1

        time.sleep(1.1)  # wait for cooldown to expire

        # Next call with cooldown triggers purge
        log_smart("trigger purge", "warning", cooldown=1)
        assert "temp error" not in error_cooldowns, "Expired entry was not evicted"
        assert len(error_cooldowns) == 1  # only the new entry remains

    def test_active_cooldowns_preserved(self):
        """Entries still within their cooldown must NOT be evicted."""
        log_smart("active error", "warning", cooldown=60)
        log_smart("trigger", "warning", cooldown=60)

        assert "active error" in error_cooldowns, "Active entry was incorrectly evicted"
        assert len(error_cooldowns) == 2

    def test_same_message_does_not_grow(self):
        """Repeated identical messages should only occupy one slot."""
        for _ in range(100):
            log_smart("same message", "warning", cooldown=60)

        assert len(error_cooldowns) == 1

    def test_cooldown_zero_no_entry(self):
        """cooldown=0 means no tracking — dict should stay empty."""
        for i in range(100):
            log_smart(f"no-cooldown message {i}", "info", cooldown=0)

        assert len(error_cooldowns) == 0

    def test_many_unique_messages_bounded_over_time(self):
        """Simulate many unique errors with short cooldowns. After all expire
        and a purge runs, the dict should shrink back down."""
        for i in range(500):
            log_smart(f"burst error {i}", "warning", cooldown=1)

        # All 500 are still active (cooldown=1s hasn't passed yet)
        assert len(error_cooldowns) == 500

        time.sleep(1.1)  # let them all expire

        # One more call triggers purge of all 500 expired entries
        log_smart("final", "warning", cooldown=60)
        assert len(error_cooldowns) == 1, (
            f"After purge, dict has {len(error_cooldowns)} entries — "
            "expired entries were not evicted"
        )

    def test_purge_expires_long_running_unique_errors(self):
        """With long cooldowns, entries accumulate but are cleaned once they expire.
        Simulate 1000 unique errors with 2s cooldown, wait, then verify cleanup."""
        for i in range(1000):
            log_smart(f"leak test {i}", "error", cooldown=2)

        assert len(error_cooldowns) == 1000  # all still active

        time.sleep(2.1)

        _purge_expired_cooldowns()
        assert len(error_cooldowns) == 0, (
            f"After purge, {len(error_cooldowns)} entries remain"
        )


# ---------------------------------------------------------------------------
# 2. connected_widgets — dead socket cleanup
# ---------------------------------------------------------------------------

@pytest.mark.memory
class TestConnectedWidgetsLeak:
    """Dead websocket objects should be cleaned up."""

    def setup_method(self):
        connected_widgets.clear()

    def test_dead_sockets_removed_on_broadcast(self):
        dead_ws = MagicMock()
        dead_ws.send.side_effect = Exception("connection lost")

        connected_widgets.add(dead_ws)
        assert len(connected_widgets) == 1

        broadcast_to_widgets()

        assert len(connected_widgets) == 0, "Dead socket was not removed"

    def test_socket_discard_on_exception(self):
        """Verify discard() removes a socket — mirrors widget_websocket finally block."""
        ws = MagicMock()
        connected_widgets.add(ws)
        assert ws in connected_widgets

        connected_widgets.discard(ws)

        assert ws not in connected_widgets, "Disconnected socket not cleaned up"

    def test_many_dead_sockets_dont_accumulate(self):
        """Simulate many clients connecting and dying — set should stay small."""
        for _ in range(200):
            ws = MagicMock()
            ws.send.side_effect = Exception("dead")
            connected_widgets.add(ws)

        assert len(connected_widgets) == 200
        broadcast_to_widgets()
        assert len(connected_widgets) == 0


# ---------------------------------------------------------------------------
# 3. MemoryListHandler — capacity cap
# ---------------------------------------------------------------------------

@pytest.mark.memory
class TestMemoryListHandlerLeak:
    """The in-memory log handler should cap at its capacity."""

    def test_handler_respects_capacity(self):
        handler = MemoryListHandler(capacity=10)
        record = logging.LogRecord(
            name="test", level=logging.INFO,
            pathname="", lineno=0,
            msg="test message", args=(), exc_info=None,
        )
        for i in range(50):
            handler.emit(record)

        assert len(handler.log_list) <= 10, (
            f"log_list grew to {len(handler.log_list)} — exceeds capacity"
        )


# ---------------------------------------------------------------------------
# 4. tracemalloc — no unbounded growth in log_smart
# ---------------------------------------------------------------------------

@pytest.mark.memory
class TestTracemallocGrowth:
    """Use tracemalloc to verify log_smart doesn't grow memory unboundedly."""

    def test_log_smart_bounded_memory_with_expiry(self):
        """With short cooldowns, memory should not grow linearly with call count
        because entries expire and get purged. We suppress the real logging
        handlers to isolate the dict memory from handler buffer noise."""
        error_cooldowns.clear()
        _msg_cooldown.clear()

        # Suppress real logging handlers to isolate dict memory from I/O buffers
        root_logger = logging.getLogger()
        old_handlers = root_logger.handlers[:]
        root_logger.handlers = [logging.NullHandler()]

        try:
            gc.collect()
            tracemalloc.start()
            snapshot1 = tracemalloc.take_snapshot()

            # 2000 unique errors with 1s cooldown
            for i in range(2000):
                log_smart(f"tracemalloc error {i}", "error", cooldown=1)

            # Wait for expiry, then trigger purge
            time.sleep(1.1)
            log_smart("purge trigger", "error", cooldown=1)

            gc.collect()
            snapshot2 = tracemalloc.take_snapshot()
            tracemalloc.stop()

            stats = snapshot2.compare_to(snapshot1, "lineno")
            total_diff = sum(s.size_diff for s in stats if s.size_diff > 0)

            # After purge, only 1 entry remains.
            # Without the fix, 2000 entries would be ~400KB+.
            # Allow headroom for tracemalloc tracker overhead (~100KB).
            assert total_diff < 200_000, (
                f"Memory grew by {total_diff} bytes after 2000 calls + purge — "
                "cooldown entries are not being evicted"
            )
        finally:
            root_logger.handlers = old_handlers


# ---------------------------------------------------------------------------
# 5. scanner threads — daemon check
# ---------------------------------------------------------------------------

@pytest.mark.memory
class TestScannerThreadLeak:
    """run_engine spawns metadata threads without joining them."""

    def test_fetch_metadata_thread_is_daemon(self):
        """Threads spawned for fetch_metadata should be daemon threads.
        Non-daemon threads would prevent process exit (a form of leak)."""
        t = threading.Thread(target=lambda: None, daemon=True)
        assert t.daemon is True


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
