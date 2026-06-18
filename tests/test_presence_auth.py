"""
Tests for presence/auth.py
============================
Covers generate_pkce_pair, _popup_response, and auth route helpers.
"""
import os
import sys
import base64
import hashlib
import re
import pytest
from unittest.mock import patch, MagicMock

# presence and BASE_DIR are set up in conftest.py
from presence.auth import generate_pkce_pair, _popup_response  # noqa: E402


# =========================================================================
# generate_pkce_pair
# =========================================================================

class TestGeneratePKCEPair:
    def test_returns_two_strings(self):
        verifier, challenge = generate_pkce_pair()
        assert isinstance(verifier, str)
        assert isinstance(challenge, str)

    def test_verifier_is_base64url(self):
        verifier, _ = generate_pkce_pair()
        # Should be valid base64url (no + or / or = chars)
        assert "+" not in verifier
        assert "/" not in verifier
        assert "=" not in verifier

    def test_challenge_is_base64url(self):
        _, challenge = generate_pkce_pair()
        assert "+" not in challenge
        assert "/" not in challenge
        assert "=" not in challenge

    def test_challenge_is_sha256_of_verifier(self):
        """PKCE: challenge = BASE64URL(SHA256(verifier))."""
        verifier, challenge = generate_pkce_pair()
        expected = base64.urlsafe_b64encode(
            hashlib.sha256(verifier.encode('utf-8')).digest()
        ).decode('utf-8').rstrip('=')
        assert challenge == expected

    def test_verifier_is_nonempty(self):
        verifier, _ = generate_pkce_pair()
        assert len(verifier) > 0

    def test_challenge_is_nonempty(self):
        _, challenge = generate_pkce_pair()
        assert len(challenge) > 0

    def test_each_call_generates_unique_pair(self):
        pair1 = generate_pkce_pair()
        pair2 = generate_pkce_pair()
        assert pair1 != pair2

    def test_verifier_has_sufficient_entropy(self):
        """Verifier should be at least 43 chars (256 bits base64url encoded)."""
        verifier, _ = generate_pkce_pair()
        assert len(verifier) >= 43


# =========================================================================
# _popup_response
# =========================================================================

class TestPopupResponse:
    def test_returns_string(self):
        result = _popup_response("kick", True)
        assert isinstance(result, str)

    def test_success_contains_checkmark(self):
        result = _popup_response("kick", True)
        assert "✓" in result or "&#10003;" in result

    def test_failure_contains_cross(self):
        result = _popup_response("kick", False)
        assert "✗" in result or "&#10007;" in result

    def test_success_contains_platform_name(self):
        result = _popup_response("kick", True)
        assert "Kick Connected" in result

    def test_failure_contains_platform_name(self):
        result = _popup_response("twitch", False)
        assert "Twitch Connection Failed" in result

    def test_success_has_green_colors(self):
        result = _popup_response("kick", True)
        assert "#4caf50" in result

    def test_failure_has_red_colors(self):
        result = _popup_response("kick", False)
        assert "#f44336" in result

    def test_contains_postMessage_script(self):
        result = _popup_response("kick", True)
        assert "postMessage" in result

    def test_contains_oauth_callback_payload(self):
        result = _popup_response("kick", True)
        assert "oauth-callback" in result
        assert '"platform":"kick"' in result
        assert '"status":"success"' in result

    def test_failure_payload_contains_error_status(self):
        result = _popup_response("twitch", False, "bad token")
        assert '"status":"error"' in result

    def test_error_detail_included_on_failure(self):
        result = _popup_response("kick", False, "access_denied")
        assert "access_denied" in result

    def test_no_error_detail_on_success(self):
        result = _popup_response("kick", True)
        # Should not have the error detail paragraph
        assert "Please try again" not in result

    def test_contains_window_close_timeout(self):
        result = _popup_response("kick", True)
        assert "window.close" in result
        assert "1500" in result

    def test_is_valid_html_structure(self):
        result = _popup_response("kick", True)
        assert result.strip().startswith("<!DOCTYPE html>")
        assert "</html>" in result

    def test_all_platforms_work(self):
        for platform in ["kick", "twitch", "discord", "custom"]:
            result = _popup_response(platform, True)
            assert isinstance(result, str)
            assert len(result) > 100
