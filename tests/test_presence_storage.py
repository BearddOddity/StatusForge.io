"""
Tests for presence/storage.py
================================
Covers resolve_token, load_json, save_json, atomic writes, file locking.
"""
import os
import sys
import json
import tempfile
import threading
import time
import pytest

# presence and BASE_DIR are set up in conftest.py
from presence.storage import (
    resolve_token, load_json, save_json,
    _TOKEN_ENV_MAP, _get_file_lock, _file_locks,
    DEFAULT_CONFIG, DEFAULT_FORGE_DB,
)


# =========================================================================
# resolve_token
# =========================================================================

class TestResolveToken:
    def test_returns_env_var_when_set(self, monkeypatch):
        monkeypatch.setenv("SF_TWITCH_TOKEN", "env_token_123")
        config = {"twitch_token": "config_token_456"}
        assert resolve_token(config, "twitch_token") == "env_token_123"

    def test_falls_back_to_config_when_env_not_set(self, monkeypatch):
        monkeypatch.delenv("SF_TWITCH_TOKEN", raising=False)
        config = {"twitch_token": "config_token_456"}
        assert resolve_token(config, "twitch_token") == "config_token_456"

    def test_returns_empty_when_neither_set(self, monkeypatch):
        monkeypatch.delenv("SF_TWITCH_TOKEN", raising=False)
        config = {}
        assert resolve_token(config, "twitch_token") == ""

    def test_returns_empty_for_unknown_key(self):
        config = {"some_key": "val"}
        assert resolve_token(config, "nonexistent_key") == ""

    def test_all_mapped_keys_resolve_from_env(self, monkeypatch):
        """Every key in _TOKEN_ENV_MAP should prefer its env var."""
        for cfg_key, env_var in _TOKEN_ENV_MAP.items():
            monkeypatch.setenv(env_var, f"env_{cfg_key}")
            result = resolve_token({cfg_key: f"cfg_{cfg_key}"}, cfg_key)
            assert result == f"env_{cfg_key}", f"Failed for {cfg_key}"

    def test_numeric_values_converted_to_string_in_config(self, monkeypatch):
        monkeypatch.delenv("SF_RAWG_KEY", raising=False)
        config = {"rawg": 12345}
        result = resolve_token(config, "rawg")
        assert result == "12345"

    def test_empty_string_env_var_treated_as_missing(self, monkeypatch):
        """Empty env var should fall through to config."""
        monkeypatch.setenv("SF_TWITCH_TOKEN", "")
        config = {"twitch_token": "fallback"}
        assert resolve_token(config, "twitch_token") == "fallback"


# =========================================================================
# load_json / save_json
# =========================================================================

class TestLoadJson:
    def test_returns_default_when_file_missing(self, tmp_path):
        missing = tmp_path / "nonexistent.json"
        result = load_json(str(missing), {"key": "default"})
        assert result == {"key": "default"}

    def test_creates_file_with_default_when_missing(self, tmp_path):
        missing = tmp_path / "nonexistent.json"
        load_json(str(missing), {"created": True})
        assert missing.exists()

    def test_loads_existing_file(self, tmp_path):
        path = tmp_path / "data.json"
        path.write_text(json.dumps({"loaded": True, "count": 42}))
        result = load_json(str(path), {"loaded": False})
        assert result == {"loaded": True, "count": 42}

    def test_returns_default_on_corrupt_json(self, tmp_path):
        path = tmp_path / "corrupt.json"
        path.write_text("not{{{json")
        result = load_json(str(path), {"fallback": True})
        assert result == {"fallback": True}

    def test_default_config_structure(self):
        """DEFAULT_CONFIG should have all required top-level keys."""
        assert "api_keys" in DEFAULT_CONFIG
        assert "engine_settings" in DEFAULT_CONFIG
        assert "broadcaster" in DEFAULT_CONFIG

    def test_default_forge_db_structure(self):
        """DEFAULT_FORGE_DB should have listed_apps, delisted_apps, library."""
        assert "listed_apps" in DEFAULT_FORGE_DB
        assert "delisted_apps" in DEFAULT_FORGE_DB
        assert "library" in DEFAULT_FORGE_DB


class TestSaveJson:
    def test_writes_data_to_file(self, tmp_path):
        path = tmp_path / "out.json"
        save_json(str(path), {"hello": "world"})
        data = json.loads(path.read_text())
        assert data == {"hello": "world"}

    def test_creates_file_in_existing_dir(self, tmp_path):
        path = tmp_path / "out.json"
        save_json(str(path), {"nested": True})
        assert path.exists()

    def test_overwrites_existing_file(self, tmp_path):
        path = tmp_path / "existing.json"
        path.write_text(json.dumps({"old": True}))
        save_json(str(path), {"new": True})
        data = json.loads(path.read_text())
        assert data == {"new": True}

    def test_writes_sorted_keys(self, tmp_path):
        path = tmp_path / "sorted.json"
        save_json(str(path), {"z": 1, "a": 2, "m": 3})
        raw = path.read_text()
        # Keys should appear in sorted order
        assert raw.index('"a"') < raw.index('"m"') < raw.index('"z"')

    def test_roundtrip_load_save(self, tmp_path):
        path = tmp_path / "roundtrip.json"
        original = {"key": "value", "nested": {"a": 1}, "list": [1, 2, 3]}
        save_json(path, original)
        loaded = load_json(path, {})
        assert loaded == original


# =========================================================================
# Atomic write (temp file + rename)
# =========================================================================

class TestAtomicWrite:
    def test_no_tmp_file_left_after_save(self, tmp_path):
        path = tmp_path / "atomic.json"
        save_json(str(path), {"clean": True})
        tmp_file = path.with_suffix('.tmp')
        assert not tmp_file.exists()

    def test_no_tmp_file_on_corrupt_path(self, tmp_path):
        """Even on failure, temp file should be cleaned up."""
        path = tmp_path / "readonly" / "file.json"
        # Don't create parent dir — save should handle gracefully
        try:
            save_json(str(path), {"data": True})
        except Exception:
            pass
        # No .tmp file should be left in tmp_path
        tmp_files = list(tmp_path.rglob("*.tmp"))
        assert len(tmp_files) == 0


# =========================================================================
# File locking
# =========================================================================

class TestFileLocking:
    def test_same_path_returns_same_lock(self, tmp_path):
        path = tmp_path / "locked.json"
        lock1 = _get_file_lock(path)
        lock2 = _get_file_lock(path)
        assert lock1 is lock2

    def test_different_paths_return_different_locks(self, tmp_path):
        path_a = tmp_path / "a.json"
        path_b = tmp_path / "b.json"
        lock_a = _get_file_lock(path_a)
        lock_b = _get_file_lock(path_b)
        assert lock_a is not lock_b

    def test_concurrent_writes_dont_corrupt(self, tmp_path):
        """Multiple threads writing to the same file should not corrupt it."""
        path = tmp_path / "concurrent.json"
        errors = []

        def writer(thread_id):
            try:
                for i in range(50):
                    save_json(str(path), {"thread": thread_id, "iter": i})
                    data = load_json(str(path), {})
                    assert "thread" in data
                    assert "iter" in data
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=writer, args=(i,)) for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        assert not errors, f"Errors during concurrent writes: {errors}"
        # File should be valid JSON after all threads complete
        final = load_json(str(path), {})
        assert "thread" in final
        assert "iter" in final
