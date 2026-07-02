# StatusForge.io

Native presence engine for streamers: detects the game you're playing
(Windows / macOS / Linux, pure Rust — no Python) and broadcasts status to
overlay widgets over a local HTTP/WebSocket server.

Two apps live in this repo:

| App | Path | Role |
|---|---|---|
| **StatusForge.io** | `src-tauri/` + `src/` | Main app. Local detection, overlay/widget server, OAuth, LAN **Hub** |
| **SPARK** | `spark-app/` | Tiny dual-PC agent for the *gaming* PC. Detects locally, broadcasts to the Hub over the LAN |

Both consume the shared detection engine crate **`forge-detection/`**
(standalone: `cd forge-detection && cargo test`).

## Build & run (dev)

```sh
npm install && npm run tauri dev            # StatusForge
cd spark-app && npm install && npm run tauri dev   # SPARK
```

`cargo build` / `cargo test` in `src-tauri/`, `spark-app/src-tauri/`, and
`forge-detection/` must pass per platform. Installers are built by CI, not
locally.

## Releases (GitHub Actions)

`.github/workflows/release.yml` builds **both apps on all three OSes**
(Windows NSIS + MSI, macOS .app + .dmg, Linux AppImage + .deb) and attaches
installers to a GitHub Release.

- **Trigger:** push a version tag (`git tag v0.5.0 && git push --tags`) or
  use **Run workflow** (workflow_dispatch) in the Actions tab.
- **Secrets (the only ones needed):**
  - `TAURI_SIGNING_PRIVATE_KEY` — contents of `~/.tauri/statusforge.key`
    (generated with `npx tauri signer generate`)
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — empty string (key has no password)

  These sign the **auto-update** artifacts (minisign — completely independent
  of Apple code signing). OAuth/runtime secrets stay in local `Config.json` /
  keyring and are never needed by CI.
- **Releases:** StatusForge publishes under `v<version>`; SPARK publishes
  under the moving `spark-latest` prerelease tag (so `releases/latest`
  always resolves to StatusForge and each app has its own updater
  `latest.json`).
- **macOS is unsigned and un-notarized by design** (no Apple account). To
  enable signing later: get an Apple Developer account, add the `APPLE_*`
  secrets, and uncomment the env block in `release.yml`. No code changes.

## macOS notes

- **Opening the unsigned app:** right-click the `.app` → **Open**, or run
  `xattr -dr com.apple.quarantine "StatusForge.io.app"`.
- **Screen Recording permission** is required to read window titles
  (System Settings → Privacy & Security → Screen Recording → enable the
  app, then relaunch). The app surfaces a clear status when the permission
  is missing instead of silently failing. Some setups also want
  Accessibility.
- macOS may prompt to allow incoming connections on first network bind —
  click Allow.

## Dual-PC setup (SPARK ↔ Hub)

1. Install **SPARK** on the gaming PC, **StatusForge** on the streaming PC
   (same LAN).
2. Set the same **4-digit PIN** in both (SPARK window / StatusForge →
   Settings → Detection Engine → SPARK Dual-PC Link). Optionally set a
   matching pairing key for a stronger shared secret.
3. SPARK broadcasts HMAC-SHA256-signed heartbeats on **udp/53735**; the Hub
   announces itself on **udp/53736**. Wrong-PIN / unsigned / tampered
   packets are rejected. Overlays update exactly as with local detection.

**Firewall:** the Windows installers add allow rules for the app and the
two UDP ports automatically (removed on uninstall). On Linux, allow them
manually if you run a firewall, e.g.
`sudo ufw allow 53735/udp && sudo ufw allow 53736/udp`. On macOS, accept
the incoming-connection prompt (or add the app under System Settings →
Network → Firewall → Options).

## Logs

- **StatusForge:** `debug.log` in the app's base directory (repo root in
  dev; the install/resource directory when installed). Also viewable via
  the in-app dev diagnostics.
- **SPARK:** `spark.log` in the platform log dir —
  Windows `%LOCALAPPDATA%\com.bearddoddity.spark\logs\`,
  macOS `~/Library/Logs/com.bearddoddity.spark/`,
  Linux `~/.local/share/com.bearddoddity.spark/logs/`.

## Auto-update

Both apps check GitHub Releases via `tauri-plugin-updater`
(endpoints/pubkey in each `tauri.conf.json`). Update artifacts are signed
in CI with the key above; keep `~/.tauri/statusforge.key` safe — losing it
means users must reinstall manually.
