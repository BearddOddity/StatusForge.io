"""
conftest.py — Safely import presence modules under pytest on Windows.

presence/__init__.py wraps sys.stdout/stderr with io.TextIOWrapper on Windows,
which replaces the file objects pytest's capture mechanism relies on.
This conftest patches the wrapping to be a no-op during import.
"""
import os
import sys
import io
import tempfile

# Ensure project root is on sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# presence/__init__.py does:
#   sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
# This replaces the stream objects, breaking pytest's capture.
# Monkey-patch TextIOWrapper to return the first arg (the original stream)
# instead of creating a new wrapper.
_real_TextIOWrapper = io.TextIOWrapper

class _NoopTextIOWrapper:
    """Delegates to the original stream to prevent breaking pytest capture."""
    def __new__(cls, *args, **kwargs):
        if args:
            return args[0]  # Return the original stream unchanged
        return object.__new__(cls)

io.TextIOWrapper = _NoopTextIOWrapper

import presence  # noqa: E402

# Restore
io.TextIOWrapper = _real_TextIOWrapper

# Set a clean BASE_DIR for all tests
presence.BASE_DIR = tempfile.mkdtemp(prefix="sf_test_")
