# StatusForge — Session Audit (2026-07-02)

Branch: **feature/native-engine** (master kept clean). Nothing pushed. Working tree clean.
Dev run: `export PATH="$HOME/.cargo/bin:$PATH"; npm run tauri dev`. Server + log on `127.0.0.1:53735` / `src-tauri/target/debug/debug.log`.

## What this session fixed (live-testing debug run)

The whole `53735` HTTP/WS server was dead → since the frontend runs almost entirely through it (`fetch`/WS, not `invoke`), Status Room + Library + settings-readback all broke at once. Root-caused and fixed in order:

| Commit | Fix |
|--------|-----|
| `6958e53` | rustls had 2 crypto providers linked (app/rcgen→ring, tauri-plugin-updater→aws-lc-rs) → `ServerConfig::builder()` panicked, server never started. Pinned `ring` via `install_default()` in `server.rs`. |
| `ded4a11` | Library HTTP routes were **never implemented** (not in Python, not Rust). Added `/api/forge-full`, `/api/exiled-apps`, `/list`, `/unexile`, `/export-meta`, `/import-meta`; `/api/scan-metadata` (RAWG/IGDB/SteamGridDB in new `metadata.rs`); `/kick/login`+`/twitch/login`; `exile_app` command. All behind `X-Forge-Token`. |
| `e19ef2b` | Start/Stop engine threw: `start_engine`/`stop_engine`/`is_engine_running` required a dead `EnginePayload` arg the frontend never sent. Removed param + struct. Idle label → "Just Chatting"; idle cover → `/just%20chatting.png`. |
| `fa862c4` | Status Room three-state: playing→game+cover, running&!playing→"Just Chatting"+cover, !running→"Offline"+new `public/offline.svg` (inert). |
| `90eb680` | `import_config` sanitize-then-validate (was validate-only → a half-typed PIN/cleared field/removing one native-routing client failed the ENTIRE save on every keystroke, silently bricking persistence). Relaxed native routing to ≥1 client. +4 tests. |
| `d475f38` | Save errors now surface the real validation reason (was generic "Failed to save"). Added `spark_pairing_key` to TS type. |
| `5ffc116` | Theme: apply full theme prefs on boot (was subset → FX toggles reverted after reload); "Sidebar Icons Only" read wrong localStorage key. New shared `src/theme.ts`. |
| `659e742` | System "Launch on Login" was decorative → wired to `set_autostart`. Guard fresh-install empty config `{}`. Fade-timer UI range aligned to backend 1–300. |
| `5277bfc` | E2E test: real `import_config`/`export_config` round-trip through temp dir. |
| (assets) | Removed orphaned unused cover duplicates. |

Verified: `cargo test --lib` 15/15, `tsc` clean, `npm run build` clean, live `curl /settings` before/after proves persistence, engine loop starts/stops cleanly in debug.log.

## Architecture facts (so next session doesn't re-derive)
- Frontend → backend is mostly the `53735` axum server (`fetch`/WS); only a few `invoke` commands (`useTauriApi.ts`). Server dead = whole UI dead.
- Data: `Forge_Database.json` = `{delisted_apps:[proc], listed_apps:{proc→title}, library:{title→ForgeLibraryEntry}}`; `Config.json` = typed `AppConfig{api_keys,engine_settings,broadcaster}` (`config.rs`).
- Real settings UI is all in `src/SettingsView.tsx`. `EngineConfigView/RoutingView/ApiKeysView.tsx` are dead code.

## OPEN / next steps
1. **Metadata scan** returns sparse until user sets real RAWG/IGDB/SteamGridDB keys (Config had `YOUR_..._KEY` placeholders). External API paths untested against live services.
2. **`exile_app`** unit-tested, not UI click-tested (needs a detected game in Status Room).
3. **UI-only System toggles** that persist but nothing consumes yet: minimizeToTray, notifications, logLevel, updateChannel, webhook, rich presence, wsAutoReconnect, hardwareAccel, configBackupEnabled. Decide: wire to real behavior or leave as stubs.
4. Engine tuning noticed live: `grace_period` 0 (drops game instantly on focus loss), `ram_threshold` 80% filtered a candidate ("RAM floor not met"). Adjust in Settings→Engine if real games don't show.
5. Not pushed. Release CI still needs the two free `TAURI_SIGNING_*` secrets + a `v*` tag (see README). Ship unsigned; SignPath later.
