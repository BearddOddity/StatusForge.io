# Migration — native engine finalization (v0.5.0)

## Removed

- **The entire Python sidecar**: `presence.py`, `forge_scanner.py`,
  `spark.py`, the `presence/` package, `pytest.ini`,
  `run_memory_tests.bat`, the Python `tests/` suite, and the sibling
  `../Presence Engine/` folder. PyInstaller configs and Python CI steps.
- `lib.rs` Python paths: `start_python_engine`, `find_python`,
  `is_bad_python`, `DetectionMode::Python`, sidecar token env plumbing,
  sidecar child-process management. `get_detection_mode` now always
  returns `"native"`. The `which` crate (only located Python).
- Frontend Python/native detection-mode toggle and "install Python" UI.
- The old macOS "not supported" guards — macOS now runs the same native
  engine as Windows/Linux.

## Changed / added

- **`forge-detection/`** — the scanner (`ForgeWaterfall`, `GameDetection`,
  `ScannerConfig`, `ForgeKnowledge`, all per-OS window/process code)
  extracted into a standalone crate. No Tauri/axum/keyring deps; the host
  loads `Forge_Database.json` and injects it via `update_forge_knowledge`;
  logging via the `LogFn` callback. 34 unit tests. Consumed as a path dep
  by StatusForge and SPARK; a portable copy ships at
  `../StreamerSuite/forge-detection/` with `INTEGRATION.md`.
- **Native macOS detection** (NSWorkspace + CGWindowListCopyWindowInfo,
  Steam `registry.vdf` RunningAppID, Screen Recording permission surfaced
  to the frontend) and real Linux X11 (`_NET_ACTIVE_WINDOW`).
- **Widget server**: native axum HTTP + WebSocket (tcp/127.0.0.1:53735),
  `widget_token` auth and bundled `widgets/` preserved.
- **LAN protocol v2** (`spark_protocol.rs`, identical copy in both apps):
  versioned packets + HMAC-SHA256-signed heartbeats derived from
  PIN + optional pairing key. Hub rejects wrong-PIN / unsigned / tampered /
  v1 packets. Ports unchanged: udp/53735 heartbeats, udp/53736 discovery.
  In-process dual-PC test: `src-tauri/tests/hub_integration.rs`.
- **SPARK rewritten in Rust** (`spark-app/`): forge-detection based,
  detect-and-forward only, tray (Show/Stow/Kill), persisted config,
  discovery listener showing the paired Hub.
- **CI**: `.github/workflows/release.yml` — tag/dispatch-triggered matrix,
  both apps × three OSes, updater artifacts signed via
  `TAURI_SIGNING_PRIVATE_KEY(+_PASSWORD)` secrets.
- **Auto-update** (GitHub Releases, minisign), **autostart toggle**
  (off by default, both apps), **Windows firewall rules** in the NSIS
  installers, per-app log files. See README.

## Left to do

- macOS builds are **unsigned/un-notarized** (expected — no Apple
  account). Enable later via `APPLE_*` secrets + uncommenting the env
  block in `release.yml`.
- Dual-PC LAN path is unit/integration-tested over localhost UDP, not
  hardware-tested across two machines.
- macOS/Linux CI bundles produced by runners; only Windows was built
  locally during development.
