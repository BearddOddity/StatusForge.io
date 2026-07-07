# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

StatusForge.io is a Tauri (Rust + React/TS) desktop app that detects what game a
user is playing and pushes a "rich presence" status to Twitch/Kick (category
updates) plus local browser-source overlay widgets for streaming software. It
is the native rewrite of an earlier Python/Flask app (`presence.py`, `spark.py`
etc. — see comments referencing "Rust port of presence/auth.py").

The repo contains **three cooperating apps/crates**, not one:
- **StatusForge** (root `src/`, `src-tauri/`) — the main single-PC app.
- **SPARK** (`spark-app/`) — a lightweight companion app for the "gaming PC"
  in a dual-PC streaming setup; it detects the game locally and reports it
  over LAN to the StatusForge "Hub" on the streaming PC.
- **forge-detection** (`forge-detection/`) — a standalone Rust crate with no
  Tauri/axum/keyring/OAuth deps, shared by StatusForge, SPARK, **and the
  separate StreamerSuite repo**. It owns the actual game-detection pipeline;
  the host app only feeds it a game database and handles I/O/logging.

## Common commands

Frontend (root app):
```
npm run dev              # vite dev server
npm run build             # tsc + vite build
npm test                  # vitest run (jsdom)
npx vitest run path/to/file.test.ts    # single test file
npm run format             # prettier --write
npm run format:check       # prettier --check (CI-enforced)
npm run check:capabilities  # verifies every Tauri plugin registered in lib.rs has a matching capabilities/default.json entry
```

Tauri/desktop:
```
npm run tauri dev
npm run tauri build
```

Rust (run with `--manifest-path`, there's no single cargo workspace):
```
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path forge-detection/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo deny check   # run from within src-tauri/ or forge-detection/ (per deny.toml)
```

SPARK app (`spark-app/`) has its own `package.json`/`src-tauri` and is built
the same way (`npm run dev` / `npm run build` from inside `spark-app/`).

CI (`.github/workflows/ci.yml`) runs, in order: typecheck, format check, unit
tests, build, `npm audit --audit-level=high`, capabilities coverage check,
then for Rust: fmt check, `cargo test`, a **startup smoke test** (launches the
built debug binary and confirms it survives 5s — catches setup()-time
panics unit tests can't), clippy, and `cargo deny check`. Match this locally
before pushing since CI runs on all three OSes for the Rust job.

## Architecture

### Rust backend (`src-tauri/src/`)
- `lib.rs` — Tauri entrypoint/setup. Resolves `APP_BASE_DIR` (differs between
  dev and bundled installs — see the resource_dir fallback logic), bootstraps
  `Config.json` from `Config.json.template` on first run (parsed through
  `AppConfig` rather than copied byte-for-byte, so unset credentials stay
  *absent* from the JSON — the frontend's "is this integration connected"
  checks key off of field presence, not emptiness).
- `config.rs` — typed `AppConfig`/`EngineStatus` structs (replaced an untyped
  `serde_json::Value` approach).
- `auth.rs` — OAuth 2.0/2.1 for Kick (PKCE, S256) and Twitch, token refresh,
  Kick category DB sync, widget token rotation. Loopback-only callback server.
- `server.rs` — single listener on `127.0.0.1:53735` that serves **two
  protocols on one port**, disambiguated by peeking the first byte of each
  connection: TLS handshake → Twitch OAuth callback, plain HTTP → widget
  overlays (`/status`, `/settings`, `/widgets/*`, `/ws`) and Kick OAuth
  callback. Widget endpoints require `X-Forge-Token` header or `?token=` query
  param matching `engine_settings.widget_token`.
- `pusher.rs` — pushes category updates to Twitch/Kick when the engine detects
  a game change (blocking reqwest by design — called from the engine loop's
  own `std::thread`, not async).
- `metadata.rs` — enriches detected games from RAWG, IGDB, Steam, GOG,
  SteamGridDB (cover art override), and live Twitch/Kick category lookup —
  each source is best-effort and skipped on failure/missing key.
- `hub.rs` — the dual-PC LAN link: UDP 53736 broadcasts hub presence, UDP
  53735 receives SPARK heartbeats (PIN + HMAC validated via
  `spark_protocol.rs`), feeding detections into the same status/broadcast
  path as local detection so overlays behave identically either way.
- `spark_protocol.rs` — the SPARK↔Hub UDP wire format. **A duplicate copy
  lives in `spark-app/src-tauri/src/spark_protocol.rs` — keep both in sync
  when bumping `PROTOCOL_VERSION`.**

### forge-detection crate (`forge-detection/src/`)
Multi-stage detection pipeline (see `lib.rs` module doc): active
window/foreground process ID (OS-specific, `platform.rs`) → forge database
lookup → system-exile/banned-path filter → behavioral traps (RAM floor,
Chromium/Electron detection, cmdline, UI framework, geometry) → golden
tickets (Steam registry, process tree) → confidence scoring for DRM-free/indie
titles. `waterfall.rs` holds the `ForgeWaterfall` pipeline itself.

### Frontend (`src/`)
React + TypeScript, Tailwind v4. `App.tsx` is the shell; feature views live in
`src/views/` (Dashboard, ApiKeys, EngineConfig, Routing) and `src/components/`.
`hooks/useTauriApi.ts` wraps `invoke()` calls to the Rust backend;
`hooks/useWebSocket.ts` talks to the `/ws` endpoint in `server.rs` for live
status. `src/dev/DevView.tsx` is a dev-only view.

### Widgets (`widgets/`)
Static HTML/JS browser-source overlays (OBS etc.) served by `server.rs`'s
`/widgets/*` route — not part of the Vite build.

### Config
`Config.json.template` is the shape bootstrapped into a user's real
`Config.json` on first run (gitignored — contains live API keys/tokens).
Three sections: `api_keys` (IGDB/RAWG/SteamGridDB), `broadcaster` (Kick/Twitch
OAuth state + `routing_mode`), `engine_settings` (scan interval, grace period,
widget token/poll rate, Streamer.bot action name, etc.).

### Packaging
`flatpak/` holds Flatpak manifests for both StatusForge and SPARK ("spark").
`src-tauri/tauri.conf.json` configures the updater (GitHub Releases
`latest.json`), bundle resources (`widgets/`, `Config.json.template`,
`public/`), and a strict CSP scoped to the loopback server origin.
