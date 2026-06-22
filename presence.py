#!/usr/bin/env python3
"""
StatusForge Engine - Main Entry Point
======================================
Bootstraps dependencies, imports the presence package, and launches the Flask server.
"""

import sys, os, io, subprocess

# === UTF-8 Fix (Windows) ===
if sys.platform == 'win32':
    if sys.stdout is not None:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    if sys.stderr is not None:
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')


# === Dependency Bootstrap ===
def forge_bootstrap():
    if getattr(sys, 'frozen', False):
        return
    required_libs = ["flask", "flask-cors", "requests", "psutil", "flask-sock"]
    if sys.platform == 'win32':
        required_libs.append("pywin32")
    try:
        import flask, flask_cors, requests, psutil, flask_sock  # noqa: F401
        if sys.platform == 'win32':
            import win32process  # noqa: F401
    except ImportError as e:
        print(f"\n[StatusForge] ⚠️ Missing dependency detected: {e.name}")
        print("[StatusForge] 🛠️ Auto-repair initiated. Forging components...")
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install"] + required_libs)
            print("[StatusForge] ✅ Components forged successfully. Rebooting Engine...\n")
            os.execv(sys.executable, [sys.executable] + sys.argv)
        except Exception as repair_err:
            # Fallback: if current interpreter has no pip (e.g. hermes venv), try python3
            import shutil
            py3 = shutil.which("python3")
            if py3 and py3 != sys.executable:
                print(f"[StatusForge] 🔄 Retrying with system python: {py3}")
                try:
                    subprocess.check_call([py3, "-m", "pip", "install"] + required_libs)
                    print("[StatusForge] ✅ Components forged. Rebooting with system python...\n")
                    os.execv(py3, [py3] + sys.argv)
                except Exception:
                    pass
            print(f"\n[StatusForge] 💀 FATAL: Auto-repair failed. Error: {repair_err}")
            sys.exit(1)


forge_bootstrap()

# === Import Package Modules (triggers decorators & route registration) ===
from presence import app, sock, log_smart, BASE_DIR
from presence import storage  # noqa: F401  # ensures paths/tokens initialized
from presence.websocket import connected_widgets, broadcast_to_widgets  # noqa: F401
from presence.auth import *  # noqa: F401, F403  # registers OAuth routes
from presence.scanner import run_engine, deploy_public_layouts, fetch_verified_variants  # noqa: F401
from presence.metadata import (  # noqa: F401
    fetch_metadata, update_meta_field,
    update_twitch_category, update_kick_category, trigger_category_update,
)
from presence.auth import keep_kick_db_synced  # noqa: F401  # re-export for __main__
# routes MUST be last — it imports from all other modules
import presence.routes  # noqa: E402, F401  # registers all Flask routes


# === Custom WSGI Handler ===
from werkzeug.serving import WSGIRequestHandler


class SafeRequestHandler(WSGIRequestHandler):
    def handle(self):
        try:
            super().handle()
        except MemoryError:
            log_smart(
                "⚠️ [NETWORK] Blocked encrypted HTTPS request. Cloud widgets must connect via plain 'ws://'.",
                "warning", 30
            )
        except Exception:
            pass


if __name__ == '__main__':
    deploy_public_layouts()
    from presence.storage import CONFIG_PATH, DEFAULT_CONFIG

    import threading
    threading.Thread(target=keep_kick_db_synced, daemon=True).start()
    threading.Thread(target=run_engine, daemon=True).start()

    app.run(host='127.0.0.1', port=53735, request_handler=SafeRequestHandler)
