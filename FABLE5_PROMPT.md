# Fable 5 Task — Finalize the native StatusForge Presence Engine (Windows / macOS / Linux)

## Your role
You are finishing a Tauri v2 desktop app, **StatusForge.io (Tauri V2)** (Rust backend +
Vite/React frontend, version 0.5.0). Work in this repository. Read the code before changing
it; mirror existing patterns. Ship compiling, verified code — not sketches.

## Background: two engines, one is being retired
The "presence engine" detects the game the user is currently playing (foreground window +
process), scores it, and broadcasts status to overlay widgets over a local HTTP/WebSocket
server. It exists in two forms:

1. **Native (Rust)** — the keeper. Lives in `src-tauri/src/`:
   - `scanner/mod.rs` — data model (`GameDetection`, `ScannerConfig`, `ForgeKnowledge`) and
     the pipeline description.
   - `scanner/waterfall.rs` — `ForgeWaterfall`, the actual multi-stage detection
     (`scout_active_session`): active-window → sysinfo process → Forge DB lookup →
     exile/banned-path filter → browser/Discord title filter → behavioral "great filter"
     traps (RAM floor, cmdline, UI framework, geometry) → Steam golden ticket →
     confidence scoring.
   - `lib.rs` — Tauri commands, the `NativeEngineState`, the detection loop
     (`start_native_engine_loop` / `stop_native_engine_loop` / `get_native_engine_status`),
     the axum server, config import/export, keyring token commands.
   - `auth.rs` — OAuth. `config.rs` — Config.json handling.
   - Works today on **Windows** (`windows` + `winreg` crates) and **Linux** (`x11rb`).

2. **Python sidecar (Flask + PyInstaller)** — being deleted. `presence.py`, `forge_scanner.py`,
   `spark.py`, a `presence/` package, `tests/`, `pytest.ini`, `run_memory_tests.bat`, plus the
   sibling folder `../Presence Engine/`. It is selected via `detection_mode = "python"` and was
   only ever needed on **macOS**, because native macOS detection was never written. It is
   currently **broken** anyway: `presence.py` and the tests import a `presence/` package that no
   longer exists on disk.

## The mission
Make the app **fully native on all three platforms**, remove Python entirely, and make the
detection engine reusable across StatusForge, SPARK, and StreamerSuite. Concretely:

1. Implement native **macOS** game detection so the Rust engine runs on macOS (Part 1).
2. Delete the Python sidecar and every code path, dependency, build step, and UI control that
   references it (Part 2).
3. Produce **one installable build per OS** — Windows, macOS, Linux — for both apps (Part 3).
4. Extract the detection engine into a standalone, reusable Rust crate (Part 4).
5. Finish **SPARK** as a separate tiny Rust app: the dual-PC gaming-side agent that detects
   locally and broadcasts presence over the LAN (Part 5). SPARK is NOT part of StatusForge.
6. Keep only the **LAN Hub connector** inside StatusForge — it receives SPARK's presence over the
   LAN and also does its own local detection for single-PC users (Part 6).
7. After the engine is finalized, produce a **copy of the detection crate for StreamerSuite**, the
   user's separate all-in-one app (Part 7).
8. Cross-cutting completeness (Part 8): preserve the overlay/widget server + game DB, harden the LAN
   link (versioned + HMAC-authenticated), wire GitHub-Releases auto-update, add an autostart settings
   toggle, keep SPARK featherweight, and add firewall rules. See Part 8 for the full list.

**Context — why SPARK exists:** some streamers use two PCs, one to game and one to stream. SPARK
runs on the gaming PC (where the game actually is), detects the game, and sends it over the LAN to
StatusForge on the streaming PC. Single-PC users don't need SPARK — StatusForge detects locally.

---

## Part 1 — Native macOS detection
The scanner is macOS-blocked in exactly these ways; fix each:

- `scanner/waterfall.rs`: `get_active_window(&self) -> Option<(u32 pid, String title, bool
  is_fullscreen, usize os_window_id)>` has `#[cfg(target_os = "windows")]` and
  `#[cfg(target_os = "linux")]` arms but **no macOS arm**. Add one.
- `scanner/mod.rs` header and comments say the module is "not compiled on macOS." Make it
  compile and run on macOS.
- `lib.rs`: five `#[cfg(target_os = "macos")]` guards return errors like *"Native engine is not
  supported on macOS."* (around the platform string, `start_native_engine`,
  `start_native_engine_loop`, `stop_native_engine_loop`, `get_native_engine_status`). Remove the
  macOS special-casing so macOS uses the same native path as Windows/Linux.
- `read_steam_running_app_id()` is Windows-registry-only. Add the macOS equivalent (read the
  running Steam app id from `~/Library/Application Support/Steam/registry.vdf`, key
  `RunningAppID`).

macOS implementation notes:
- Foreground app pid: `NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier`.
- Active window title + bounds (for `is_fullscreen`): `CGWindowListCopyWindowInfo` with
  `kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements`, filtered to that pid
  and the frontmost on-screen window; compute fullscreen by comparing window bounds to the
  active display frame.
- Use maintained crates — prefer `objc2`, `objc2-app-kit`, `objc2-foundation`,
  `core-graphics`, `core-foundation` — added under a
  `[target.'cfg(target_os = "macos")'.dependencies]` block in `src-tauri/Cargo.toml`, matching
  how the Windows/Linux blocks are structured.
- **Permissions gotcha:** on modern macOS, reading window titles via `CGWindowListCopyWindowInfo`
  requires the **Screen Recording** permission, and some approaches need **Accessibility**.
  Detect when the permission is missing and surface a clear, actionable status to the frontend
  (do not silently fail or crash). Document the required permissions in the README and, if
  applicable, the app entitlements / `Info.plist` usage strings.
- Keep behavior parity with the Windows/Linux pipeline. `forge_scanner.py` is the original
  reference spec for detection semantics if any stage is ambiguous — match its intent, then
  delete it.

## Part 2 — Remove the Python sidecar completely
- Delete files: `presence.py`, `forge_scanner.py`, `spark.py` (its behavior is reimplemented by
  the Rust SPARK app in Part 5 — do **not** delete the `spark-app/` folder, that is the keeper),
  the `presence/` package (if present), `pytest.ini`, `run_memory_tests.bat`, the Python `tests/`
  suite, and the sibling `../Presence Engine/` folder (unless you repurpose it per Part 4). Remove
  any PyInstaller spec/build config and any Python steps in `.github/` workflows.
- In `lib.rs`, remove the Python path: `start_python_engine`, `find_python`, `is_bad_python`,
  `DetectionMode::Python` (make detection always native), `read_widget_token`/sidecar-token env
  plumbing that only served Python, `get_detection_mode` (or make it constant-native), and any
  child-process management that only existed to run the sidecar. Drop the `which` crate if it was
  only used to locate Python.
- Frontend: remove the Python-vs-native detection-mode toggle and any "install Python" UI, and
  default everything to native. Update `Config.json.template` and `config.rs` to drop
  `detection_mode`/Python fields (or hardwire native) without breaking existing configs — migrate
  gracefully.
- Grep the whole repo for `python`, `sidecar`, `flask`, `pyinstaller`, `presence.py`,
  `detection_mode` afterward and confirm nothing live remains.

## Part 3 — Build one installer per OS (via GitHub Actions)
- **All builds run in GitHub Actions — this is the canonical build path for every OS, not a
  fallback.** Do not rely on local cross-compilation; Tauri bundles must be produced on their own
  OS runner. Author/extend `.github/workflows/` with a matrix using `tauri-apps/tauri-action`
  across `windows-latest`, `macos-latest`, and `ubuntu-latest`, and cover **both** apps
  (StatusForge and SPARK) — either one workflow with an app axis or one workflow per app.
- Targets per OS: **Windows** (NSIS + MSI), **macOS** (.app + .dmg), **Linux** (AppImage + .deb).
- The workflow should trigger on tag/release (and support manual `workflow_dispatch`), build the
  frontend, build the Tauri bundles, and upload the installers as release assets/artifacts.
- Locally, you only need `cargo build`/`cargo test` to pass per platform for correctness; the
  actual installers come from CI. Verify the workflow is valid and complete.
- macOS signing: **no Apple account or certs — build UNSIGNED and un-notarized; this is the
  expected outcome, not a failure.** The macOS job must succeed and emit an unsigned `.dmg`/`.app`
  without signing steps that fail on missing secrets. Still set the entitlements / `Info.plist`
  usage strings for Screen Recording / Accessibility (required regardless of signing). Leave a
  commented-out signing/notarization block in the workflow (the secrets to enable it later are in
  *GitHub repo setup* below). In the README, cover how to open an unsigned app
  (`xattr -dr com.apple.quarantine <App>.app`, or right-click → Open) and how to grant Screen
  Recording in System Settings → Privacy & Security.

**Do Parts 1–3 first and verify them before starting Part 4.** Parts 4–7 build on a finished,
working native engine.

---

## Part 4 — Extract the detection engine into a reusable crate
The detection engine must be shared by three apps: StatusForge (single-PC local detection), SPARK
(the dual-PC gaming agent, Part 5), and later StreamerSuite (Part 7). Do not leave it welded
inside StatusForge.

- Extract `src-tauri/src/scanner/` (`mod.rs` + `waterfall.rs`, i.e. `ForgeWaterfall`,
  `GameDetection`, `ScannerConfig`, `ForgeKnowledge`, and all OS detection code including the new
  macOS support from Part 1) into a **standalone library crate** — no Tauri, StatusForge, axum,
  keyring, or OAuth dependencies. It should depend only on what detection needs (`serde`,
  `sysinfo`, and the per-OS crates `windows`/`winreg`, `x11rb`, and the macOS crates). Keep the
  existing `LogFn` callback so the host app controls logging.
- Suggested home: a crate named `forge-detection` (you may repurpose the emptied
  `../Presence Engine/` folder as this crate's directory since the name fits, or create a fresh
  one — your call, state which). Give it its own `Cargo.toml`, a clear `lib.rs` public API, and
  its own unit tests.
- StatusForge consumes it as a path dependency; `src-tauri/src/lib.rs` keeps only orchestration
  (the detection loop, Tauri commands, axum server) and calls into the crate.
- Acceptance: StatusForge still builds and detects on all three OSes using the extracted crate;
  the crate builds and tests independently (`cargo test` inside it) with no app-specific deps.

## Part 5 — SPARK as a standalone tiny Rust app (dual-PC agent)
SPARK runs on the **gaming PC**. It detects the current game locally and broadcasts it over the
LAN to the streaming PC's StatusForge (the "Hub"). It is a separate application and must not live
inside StatusForge. A scaffold already exists at `spark-app/` (Tauri v2, crate name `spark`) —
finish it; reimplement `spark.py`'s behavior in Rust. Keep it tiny.

Reference behavior from the old `spark.py`:
- **Detect**: run the `forge-detection` crate's `ForgeWaterfall::scout_active_session()` on a
  scan interval (default 5s) to get `{title, process}`.
- **Broadcast (SPARK → Hub)**: UDP broadcast to port **53735**, ~every 10s, JSON:
  `{"app":"StatusForge_Spark","hostname":<host>,"game":<title|null>,"process":<proc|null>,"pin":<4-digit>,"command":"heartbeat"}`.
- **Discovery (Hub → SPARK)**: listen on UDP port **53736** for
  `{"app":"StatusForge_Hub","hub_name":<name>}` and show which hub it is broadcasting to.
- **PIN**: a 4-digit network PIN pairs a SPARK to a Hub; include it in every heartbeat.
- **UI**: a tiny always-on-top window + system tray icon (use Tauri's `tray-icon` feature):
  shows "BROADCASTING TO <hub>", the editable PIN, a live status dot, and Stow/Kill actions.
- Use `std::net::UdpSocket` for the LAN I/O (no heavy networking crate needed). Add the per-OS
  detection deps to `spark-app/src-tauri/Cargo.toml` (the same `windows`/`winreg`, `x11rb`, macOS
  crates), since SPARK does real detection on the gaming PC.
- **Preserve the ports and base payload above**, then apply the Part 8 hardening (add a `version`
  field and an HMAC to every heartbeat; Hub rejects wrong-PIN/bad-HMAC). Keep the fields additive so
  SPARK and Hub of adjacent versions still interoperate.
- Build SPARK for all three OSes too (same bundling approach as Part 3).

## Part 6 — StatusForge keeps only the LAN Hub connector (not the agent)
In StatusForge, implement/keep the **Hub** side of the LAN link (this is the "LAN connect to
SPARK" piece that belongs in StatusForge):
- **Announce**: periodically send the discovery packet on UDP **53736**
  (`{"app":"StatusForge_Hub","hub_name":<this machine/hub name>}`).
- **Receive**: listen on UDP **53735** for SPARK heartbeats; validate the 4-digit PIN; when a
  valid SPARK heartbeat arrives, feed its `{game, process}` into the same status/broadcast path
  the local native engine uses, so overlays/widgets update identically whether detection came from
  the local machine (1-PC) or from a paired SPARK (2-PC).
- Surface Hub state to the frontend (paired SPARK hostname, last-seen, PIN) via Tauri commands,
  following the existing command conventions. Do not reintroduce anything Python.

## Part 7 — Copy of the detection engine for StreamerSuite
After Parts 1–4 are finished and verified, produce a **copy of the `forge-detection` crate** that
can be dropped into StreamerSuite (a separate all-in-one app, its own repo). Place the copy where
requested or, by default, at `../StreamerSuite/forge-detection/` (or output it as a self-contained
folder and state the path). It must build standalone (no StatusForge path deps). Add a short note
on how StreamerSuite would add it as a path dependency and call `scout_active_session()`. Do not
wire it into StreamerSuite's code — just deliver the portable copy + integration notes.

## Part 8 — Engine completeness, updates, security & platform integration
These are required, not optional. Several touch code that already exists — reconcile, don't
duplicate.

**Preserve what the engine already does:**
- The overlay/widget server must keep working: the local **axum HTTP + WebSocket server**, the
  **`widget_token` auth** (used across `lib.rs`/`auth.rs`/`config.rs`), and the bundled `widgets/`
  resources (`tauri.conf.json` maps `../widgets/` → `widgets/`). Detection status must broadcast to
  connected widgets exactly as today.
- **Game database:** `Forge_Database.json` loading is already wired (see `lib.rs`). Keep it working
  through the crate extraction — the host app loads the DB and feeds the `forge-detection` crate via
  `ForgeKnowledge` / `update_forge_knowledge`; the crate itself stays I/O-light.
- **Reconcile existing LAN code:** `lib.rs` already contains `UdpSocket` logic and the 53735/53736
  ports. Finish/align the Hub with SPARK from that existing code — do not create a second parallel
  implementation.

**SPARK performance:** SPARK runs on the gaming PC and must be featherweight — no full process-table
refreshes, use targeted `sysinfo` refresh, a modest scan interval, and minimal CPU/RAM so it never
costs the user game FPS.

**Diagnostics:** route `tauri-plugin-log` to a findable per-OS log file (document the paths) for
both apps, so cross-platform detection issues are debuggable.

**Dual-PC test without two machines:** add an integration test that runs the Hub receiver and a
SPARK sender in-process over localhost UDP, asserting a signed, correct-PIN heartbeat updates Hub
status and a wrong-PIN/bad-signature one is rejected.

**LAN wire-protocol hardening (do this on both SPARK and Hub):**
- Add a **protocol `version` field** to every LAN packet so mismatched SPARK/Hub versions degrade
  gracefully instead of misbehaving.
- **Authenticate heartbeats with an HMAC.** Derive a shared secret from the pairing (e.g. the PIN
  plus a user-set pairing key) and attach `hmac = HMAC-SHA256(secret, canonical_payload)` to each
  heartbeat; the Hub must reject packets with a missing/invalid HMAC or wrong PIN. This stops anyone
  on the LAN from spoofing a fake game onto the overlay. Keep the field additive so the change is a
  clean protocol bump.

**Auto-updater (GitHub Releases):** `tauri-plugin-updater` is a dependency but unconfigured. Wire it
up for both apps against GitHub Releases:
- Generate a Tauri updater signing keypair (`tauri signer generate`) — this is **minisign, entirely
  independent of Apple signing**, so it works even though macOS builds are unsigned.
- Configure `tauri.conf.json` (`plugins.updater.endpoints`, `pubkey`) and enable
  `createUpdaterArtifacts` in the release build; the CI workflow signs artifacts using the
  `TAURI_SIGNING_PRIVATE_KEY` (+ password) repo secrets and publishes the update manifest to the
  release. Document the two secrets and the key location.

**Autostart as a settings toggle:** add `tauri-plugin-autostart` to **both** apps, exposed as a
user-facing on/off toggle in settings (persisted; **off by default**). No forced autostart. On
enable, register launch-on-login on all three OSes; on disable, unregister. Surface it via a Tauri
command following existing conventions.

**Firewall:** the UDP LAN (53735/53736) and local server will be blocked/prompted by OS firewalls.
On **Windows**, have the installer add firewall rules automatically (NSIS install hooks for the app +
the two UDP ports), and remove them on uninstall. On **macOS/Linux**, document how to allow the app
(and note macOS may prompt on first bind).

---

## Constraints (do not break these)
- **Preserve the frontend↔backend command API.** The React app calls, among others:
  `get_app_version`, `get_platform`, `get_engine_status`, `get_widget_token`,
  `start_engine`, `stop_engine`, `is_engine_running`, `start_native_engine_loop`,
  `stop_native_engine_loop`, `get_native_engine_status`, `export_config`, `import_config`,
  the keyring token commands, and the OAuth flow in `auth.rs`. Keep names/signatures stable
  unless you also update every caller.
- Keep OAuth (`auth.rs`) and keyring-based token storage intact.
- Tauri v2, Rust edition 2021. Reuse the crates already in `Cargo.toml`; only add what macOS
  genuinely needs.
- Match existing code style, module layout, and the `#[cfg(target_os = ...)]` conventions.

## Acceptance criteria
1. `cargo build`/`clippy`/`test` clean on Windows, macOS, and Linux; the `scanner` code compiles
   and runs on macOS.
2. No Python remains — the Part 2 greps come back clean.
3. Detection parity per OS: a Steam game and a DRM-free/indie game each report correct
   `title` + `process` and broadcast to a connected widget.
4. macOS clearly reports a missing Screen Recording / Accessibility permission and works once granted.
5. Unit tests cover the pipeline plus the macOS active-window/Steam paths (ported from the Python tests).
6. CI matrix builds and uploads installers for both apps on all three OSes; workflow valid/green
   (macOS unsigned is acceptable).
7. `forge-detection` builds and tests standalone with no app-specific deps; StatusForge and SPARK
   both consume it and detect correctly.
8. Dual-PC path works over the LAN, and the in-process test proves valid heartbeats are accepted
   while wrong-PIN/bad-HMAC ones are rejected.
9. A portable `forge-detection` copy for StreamerSuite builds standalone and ships integration notes.
10. Overlay WS/HTTP server + `widget_token` auth + `widgets/` serving still work; `Forge_Database.json`
    still drives detection.
11. Auto-updater configured (GitHub Releases, minisign) for both apps; autostart is a persisted,
    off-by-default settings toggle on all three OSes; Windows installers add/remove firewall rules.

## Deliverables
- The macOS native detection implementation and the fully de-Pythoned codebase.
- The `forge-detection` reusable crate (extracted), consumed by StatusForge and SPARK.
- The finished standalone **SPARK** Rust app (`spark-app/`) with LAN broadcast/discovery, PIN, and
  tray UI; and the **Hub** connector inside StatusForge.
- A portable copy of `forge-detection` for StreamerSuite + integration notes.
- Updated `Cargo.toml`s, `tauri.conf.json`s, `.github/` workflows, and READMEs (build steps +
  macOS permissions + dual-PC LAN setup).
- A short `MIGRATION.md` summarizing what was removed, what changed, the new crate/app layout, and
  any signing/notarization steps left to do.

## GitHub repo setup (put this in the README so releases are one step)
- **Secrets:** macOS ships unsigned (no Apple account) — no Apple secrets needed. The **only**
  secrets required are the updater signing key: `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (from `tauri signer generate`) so auto-update artifacts are
  signed. OAuth/runtime secrets stay in local `Config.json`/keyring and are NOT needed by CI.
- **Triggering a release build:** builds run on pushing a version tag (e.g. `git tag v0.5.0 &&
  git push --tags`) and via manual **Run workflow** (`workflow_dispatch`) in the Actions tab.
- **Artifacts:** installers for both apps × all three OSes attach to the GitHub Release (and are
  downloadable from the workflow run). macOS `.dmg` is unsigned — see the README note on opening it.
- **To enable macOS signing later:** get an Apple Developer account, add the four `APPLE_*` repo
  secrets, and uncomment the signing block in the workflow. No code changes needed.

## Verification before you claim done
Run `cargo build`/`cargo clippy`/`cargo test` for each platform target you can and paste the actual
output. Confirm the GitHub Actions workflow is complete and valid (and, if you can trigger it,
green) — the OS installers are produced by CI, not locally. State plainly what you verified where
and what remains (e.g., "macOS .dmg unsigned — notarization pending Apple secrets"; "dual-PC LAN
path unit-tested but not hardware-tested across two machines"). Do not assert success without
evidence.
