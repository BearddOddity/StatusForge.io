# StatusForge — Detection / Push / Auth Technical Reference

Generated from a direct read of the source (not the shipped docs). File:line
references are current as of branch `claude/statusforge-mcp-audit-2w1gxv`.
Where a prior "interview summary" of this pipeline turned out to be wrong or
oversimplified, the correction is called out inline as **CORRECTION**.

## Overview

StatusForge is a Tauri desktop app that watches the foreground window/process,
decides whether the user is "playing a game," and (a) shows that on local
overlay widgets and (b) optionally pushes a category change to Twitch/Kick.
It also acts as a "Hub" for a second, lighter companion app called SPARK that
can run on a second PC and forward detections over the LAN.

Two crates matter:

- `forge-detection` (workspace crate, no Tauri/axum/keyring deps) — the pure
  detection engine (`ForgeWaterfall`), shared by StatusForge, SPARK, and
  StreamerSuite. Entry point: `forge_detection::waterfall::ForgeWaterfall`.
- `src-tauri` — the host app: config, OAuth, HTTP push, local widget server,
  LAN hub, metadata scraping, and the engine loop that drives the detector.

## Detection Pipeline (the waterfall)

Core logic: `forge-detection/src/waterfall.rs`, function
`ForgeWaterfall::evaluate()` (line 265), called from
`ForgeWaterfall::scout_active_session()` (line 216) once per scan tick. The
scan tick itself lives in the host app: `spawn_engine_loop()` in
`src-tauri/src/lib.rs` (line 688), which sleeps `scan_interval` seconds
(default 5s, config-validated floor of 2s — `config.rs:400-406`) between
calls to `scout.scout_active_session()`.

`scout_active_session()` first grabs the OS foreground window via
`platform::get_active_window()` (platform.rs, OS-specific: Win32
`GetForegroundWindow`/`GetWindowTextW` on Windows, `_NET_ACTIVE_WINDOW` via
X11 on Linux, `NSWorkspace`/`CGWindowList` on macOS — Screen Recording
permission required there, see `platform::permission_error()`), refreshes
just that one PID's `sysinfo` process record (memory + exe + cmdline), reads
the parent process name, and builds a `ProcessSnapshot` (waterfall.rs:166).
That snapshot + the `ActiveWindow` are fed into the pure, unit-tested
`evaluate()` function.

**CORRECTION to prior summary**: the pipeline is not cleanly "5 stages" in
the code — there's an extra branch (the Xbox/UWP piercer) wedged between
Stage 1 and Stage 2 that isn't part of either. The stage boundaries below
follow the code's own `// ── Stage N` comments (waterfall.rs:271, 316, 339,
344, 395); the UWP piercer at waterfall.rs:298 is documented here as its own
step since it sits between Stage 1 and Stage 2 and behaves differently from
both (a `return None`/`return Some` early-out, not a filter).

### Stage 1 — Listed apps + built-in aliases (waterfall.rs:271-296)

Instant, unconditional match. Checks `exe_name` against two sources merged
at lookup time:
- `kw.listed_apps: HashMap<String, String>` — the user's Forge database
  (`Forge_Database.json`'s `listed_apps`), synced in via
  `update_forge_knowledge()` (waterfall.rs:194).
- `KNOWN_EXE_TITLE_ALIASES` (waterfall.rs:103) — a small built-in table for
  games whose exe name is misleading (`gtaiv.exe` → "Grand Theft Auto IV",
  `funkofusion.exe` → "Funko Fusion", `falloutnv.exe` → "Fallout New Vegas",
  `3dat.exe` → "3D Aim Trainer", `aimlab_tb.exe` → "Aimlabs").

A hit returns immediately with platform tag `"The Forge"` via
`format_game_output()`. This runs *before* strict-mode is checked, so even
`strict_forge_mode` + tiny RAM footprint can't block a known-alias exe
(covered by test `known_exe_aliases_win_instantly_even_with_low_ram_and_strict_mode`,
waterfall.rs:1186).

If `kw.strict_mode` is on (`engine_settings.strict_forge_mode`,
config.rs:70) and there's no Stage-1 hit, detection stops here — nothing
below Stage 1 runs (waterfall.rs:293).

### UWP / Xbox Game Pass piercer (waterfall.rs:298-314)

Not one of the numbered stages, but runs before Stage 2. Windows hosts every
UWP/Game Pass game (and the Settings app) under a single generic process,
`ApplicationFrameHost.exe`. If the foreground exe is that host and the window
title isn't empty, it's reported as a game with platform `"Xbox Game Pass"`
and the raw window title as the game title — *except* when the title is
exactly "Settings" (case-insensitive), which is explicitly excluded so
opening Windows Settings isn't reported as playing a game
(waterfall.rs:304). Note `systemsettings.exe` (the *native* Settings app, not
hosted by ApplicationFrameHost) is killed separately, by the Stage 2 system
exile list.

### Stage 2 — Hard kills (waterfall.rs:316-337)

Two independent kill lists plus a title-substring check, all bypassable via
`process_filter_bypass` (config.rs:90, off by default):

1. `kw.delisted_apps` (user's own kill-list) or `SYSTEM_EXILES` (built-in,
   waterfall.rs:25 — browsers, Discord, OBS, Task Manager, shells, desktop
   shells, Steam client itself, Epic launcher, etc.) → `exe_name` match kills
   detection outright.
2. `BANNED_PATHS` (waterfall.rs:49: `c:\windows`, `system32`, `/usr/bin`,
   `/usr/sbin`, `/sbin`) — substring match against the lowercased exe path.
3. Window-title substring kill, independent of `process_filter_bypass`:
   titles containing `" - google chrome"`, `" - discord"`, `" - firefox"`,
   `" - edge"`, or `" - youtube"` (waterfall.rs:326-337) are killed — this is
   how a maximized YouTube/Discord *tab* running under a whitelisted-looking
   process still gets rejected.

### Stage 3 — Behavioral traps (`survives_great_filter`, waterfall.rs:425-510)

All traps are individually toggleable via `ScannerConfig`
(`trap_chromium`, `trap_cmdline`, `trap_ui_framework`, `trap_geometry`, all
default `true` — `lib.rs` default impl / `config.rs:352-363`). Order:

1. **RAM floor** — `proc.memory_mb < ram_threshold_mb` (default 80 MB,
   `config.rs:346-348`) kills the scan. This check is *not* behind a toggle —
   it always runs.
2. **Chromium/Electron trap** — lists the exe's own directory
   (`list_dir_lower`, waterfall.rs:518) and looks for
   `v8_context_snapshot.bin`, `libcef.dll`/`.so`, or
   `Chromium Framework.framework`. Killed unless a `www` folder sits next to
   it (an allowance for Electron apps that are legitimately games, e.g. some
   HTML5-wrapped indies).
3. **Command-line trap** — kills if `cmdline` contains `--type=renderer`,
   `--type=crashpad`, `-embedding`, `--background`, `--hidden`, or
   `--silent` (helper/renderer subprocesses of another app, not the app
   itself).
4. **Desktop UI framework trap** — kills on `qt5core`, `qt6core`,
   `mfc140.dll`, `wxbase`, `libgtk-3.so`, or `QtGui.framework` sitting next to
   the exe (i.e., it's a native desktop app, not a game engine).
5. **Geometry/visibility trap** — kills if the window is smaller than
   640×480, or parked off-screen (`x <= -30000 || y <= -30000`).

### Stage 4 — Authoritative proof (waterfall.rs:344-393)

Checked in this order — first match wins:

1. **Steam Registry** — only attempted if `exe_path` contains `"steamapps"`.
   Reads the live `RunningAppId`/`RunningAppID` value: Windows via
   `HKCU\Software\Valve\Steam` (`platform.rs:79-85`), macOS/Linux via
   Valve's `registry.vdf` file (`platform.rs:179-183`,
   `~/.steam/registry.vdf` or `~/Library/Application Support/Steam/registry.vdf`,
   parsed by `parse_registry_vdf_running_app_id`, `platform.rs:365`). A
   nonzero id → platform tag `"Steam Registry"`.
2. **Linux golden ticket** (`#[cfg(target_os = "linux")]` only,
   `linux_golden_ticket`, waterfall.rs:686) — shells out to `gamemoded -s`
   (Feral GameMode active) or `flatpak ps` (pid present in the sandboxed app
   list) → tag `"Linux GameMode"` or `"Flatpak (<app-id>)"`.
3. **Process-tree parent check** (waterfall.rs:373-393) — looks at
   `proc.parent_name`:
   - Parent is `wine64-preloader`, `proton`, `wine`, or ends with `.sh` →
     `"Shell Wrapper/Proton"`.
   - Parent is `epicgameslauncher.exe`, `eadesktop.exe`, or `upc.exe` →
     `"Official Launcher"`.

**CORRECTION to prior summary**: "Steam registry is primary; launcher
parents 2nd" is directionally right but incomplete — the actual order in
code is Steam registry → Linux GameMode/Flatpak → Proton/Wine wrapper parent
→ official-launcher parent. Wrapper/Proton is checked *before* the launcher
list, both within the same "Stage 4" step, not as a separate later stage.

### Stage 5 — Confidence scoring (waterfall.rs:395-420)

Only reached if nothing above matched or killed the process. Weighted score,
each term individually toggleable and all on by default:

| Signal | Weight | Config flag | Condition |
|---|---|---|---|
| Engine DNA | 0.4 | `score_engine_dna` | `has_engine_dna(exe_path)` — a known engine/runtime file (Unity, Godot, GameMaker, Ren'Py, RPG Maker, LWJGL, LÖVE, Construct, Bink/Oodle/Steamworks/FMOD DLLs — full list `ENGINE_DNA`, waterfall.rs:51) sits next to the exe |
| Fullscreen | 0.3 | `score_fullscreen` | `window.is_fullscreen` |
| Distinct title | 0.2 | `score_window_title` | window title non-empty and not literally equal to the lowercased exe name |
| RAM | 0.1 | `score_ram` | `memory_mb > ram_threshold_mb` |

Threshold default `0.5` (`confidence_threshold`, config.rs:349-351,
validated to stay in `[0.0, 1.0]`, config.rs:416-419). A pass returns
platform tag `"Standalone/DRM-Free"`.

### Title formatting (`format_game_output`, waterfall.rs:597-662)

Applied to every match above (not just Stage 5). Priority order:
1. `KNOWN_WINDOW_TITLE_ALIASES` (waterfall.rs:121) — strips known
   build/version suffixes and trademark glyphs (e.g. "Alan Wake -
   v1.07.33.72514" → "Alan Wake", "Call of Duty® Infinite Warfare" → "Call of
   Duty: Infinite Warfare").
2. Emulator splitter (if `emulator_detection` on and exe name contains one of
   `EMULATOR_TAGS` — retroarch, yuzu, ryujinx, pcsx2, rpcs3, dolphin, cemu,
   citra, ppsspp): splits the window title on `" - "` then `" | "` to pull
   the actual game name out from the emulator chrome, tags platform
   `"Emulator"`.
3. macOS bundle display name (`CFBundleDisplayName`/`CFBundleName` from
   `Info.plist`) when the exe path is inside a `.app/Contents/MacOS` bundle.
4. Generic-exe-name / missing-title fallback: if the exe is one of
   `GENERIC_EXE_NAMES` (waterfall.rs:154 — `game.exe`, `Win64-Shipping`,
   `start.exe`, `play.exe`, `application.exe`, `runner`, `binaries`) or the
   window title is empty, extract the real game name from the *path*
   (`extract_true_game_name`, waterfall.rs:545 — prefers the Steam
   `common/<Game>` folder, otherwise walks the path backwards skipping
   generic Unreal/build folder names like `Binaries`, `Win64`, `Shipping`).
5. Otherwise the raw window title is used as-is.

Also: `strip_not_responding_suffix()` (waterfall.rs:142) strips a trailing
" (Not Responding)" Windows appends to a hung window's title before any of
the above runs, so a hung game doesn't get a second, distinct library entry.

## Auto-Push / Broadcast Flow

**CORRECTION to prior summary**: "Auto-Push — confirmed working as expected"
is only half true. There are *two* separate config flags with overlapping
names and only one of them is wired up in this app:

- `engine_settings.platform_push_enabled` (config.rs:66, default `true`) —
  this is the real gate. Read directly in `pusher::push_category()`
  (`pusher.rs:310`): if false, the function returns immediately and nothing
  is ever pushed. Bound to a working UI toggle
  (`src/SettingsView.tsx:1745-1752`).
- `engine_settings.auto_push` (config.rs:61, default `false`) — **this field
  is never read anywhere in `src-tauri`.** Confirmed by grep: no reference
  to `.auto_push` outside its own declaration/default in `config.rs` and its
  (unused-by-backend) presence in `src/types/index.ts` /
  `src/SettingsView.tsx:1012`. It appears to be a copy-paste leftover from
  the separate `spark-app` companion, which *does* have a working
  `auto_push` toggle gating its own heartbeat loop
  (`spark-app/src-tauri/src/lib.rs:206-211`). In the main StatusForge app
  this field is dead: push behavior is unconditional (subject only to
  `platform_push_enabled` and routing mode) whenever a new game is detected.
  Flagged in the audit doc as a likely UI/config bug — if a "Auto Push"
  toggle is ever surfaced in Settings bound to this field, it silently does
  nothing.

Given that correction, the actual flow when detection changes (new game or
grace-period-expired idle) is:

1. `spawn_engine_loop()` (`lib.rs:688`) detects a title change
   (`current_game.as_ref() != Some(&game_title)`, `lib.rs:834`), immediately:
   - updates `NativeEngineState` (`state_arc.set_playing`/`clear_playing`,
     `push_status()` which fans out to local overlay WebSocket clients via
     `server.rs`),
   - emits a Tauri `game-detected`/`game-cleared` event to the frontend,
   - calls `on_game_detected()` (`lib.rs:573`) for a new game, or
     `pusher::push_category(&base, cfg, &forge_db, &idle_category)`
     (`lib.rs:888`) directly when the grace period expires.
2. `on_game_detected()` calls `pusher::push_category()` synchronously (push
   happens before the metadata scan, which is spawned async), then upserts a
   bare Library entry if the title is new, and — only if the entry still
   lacks genre/developer/cover — spawns a background `metadata::scan()` that
   re-saves and calls `state_for_scan.push_status()` again once metadata
   resolves.
3. `pusher::push_category()` (`pusher.rs:309-331`) is the actual broadcast:
   no-ops unless `platform_push_enabled` is true and
   `routing_mode == RoutingMode::Native` (the alternative, `StreamerBot`,
   routes through an external Streamer.bot HTTP action instead — not read by
   this file). Twitch push requires both `twitch_token` and
   `twitch_broadcaster_id` non-empty; Kick push requires `kick_token`
   non-empty. Each platform is pushed independently and gated by its own
   cooldown.

**Cooldown — confirmed 15 seconds**, matching the prior summary:
`PUSH_COOLDOWN_SECS: u64 = 15` (`pusher.rs:26`), enforced per-platform via
two separate `AtomicU64` timestamps (`LAST_TWITCH_PUSH_SECS`,
`LAST_KICK_PUSH_SECS`, `pusher.rs:28-29`) and `cooldown_elapsed()`
(`pusher.rs:41-48`, records the attempt time as a side effect of checking
it). This is a floor independent of `grace_period` — comment at
`pusher.rs:19-26` explains it exists because `grace_period` can be set to 0,
so rapid alt-tabbing could otherwise fire a real API call on every flap. Not
sized against any documented Twitch/Kick rate limit — it's a self-imposed
floor.

This app never pushes on its own detection loop's *SPARK* path without going
through the same code: `hub::apply_heartbeat()` (`hub.rs:112`) — triggered
when a paired SPARK agent's heartbeat changes game state — calls the same
`crate::on_game_detected()` (`hub.rs:153`) or
`crate::pusher::push_category()` for idle (`hub.rs:96-101`, via
`push_idle_category`), so a SPARK-sourced detection on a second PC gets
identical category-push/metadata-scan treatment to a local detection.

## Error Handling

**CORRECTION to prior summary**: 401/429 handling does *not* live in
`hub.rs`. `hub.rs` is the LAN UDP hub for the SPARK dual-PC companion
(listens on UDP 53735 for signed SPARK heartbeats, announces on UDP 53736)
and has nothing to do with Twitch/Kick HTTP calls. There is in fact no
`src-tauri/src/hub.rs` "HTTP client to the hub" as the prior summary implied
— the real HTTP client + status-code handling lives entirely in
`pusher.rs`, split by platform.

### 401 Unauthorized → refresh + retry once (pusher.rs)

- `twitch_push_once()` (`pusher.rs:129`) returns `Outcome::Unauthorized` on
  a 401 from either the game-id lookup or the channel-update PATCH.
  `push_twitch()` (`pusher.rs:200`) catches that, calls
  `auth::refresh_twitch_token()` (`auth.rs:549`), saves the refreshed token
  via `auth::save_config_at()`, and retries **once** with the new token
  (`pusher.rs:212`). A second 401 on retry is logged and given up on — no
  further retry loop.
- Same pattern for Kick: `kick_push_once()` (`pusher.rs:231`) →
  `push_kick()` (`pusher.rs:263`) → `auth::refresh_kick_token()`
  (`auth.rs:513`) → one retry (`pusher.rs:287`).
- `auth::refresh_twitch_token`/`refresh_kick_token` (auth.rs:513-586) POST a
  `grant_type=refresh_token` request; on failure they return `Err`, which the
  pusher just logs (`"[PUSH] {} token refresh failed"`) — no exponential
  backoff, no marking the connection as broken in the UI. A permanently
  revoked refresh token will fail silently on every detection until the user
  manually reconnects.

### 429 Too Many Requests → skip, no retry (pusher.rs)

Both `twitch_push_once` (`pusher.rs:180-187`) and `kick_push_once`
(`pusher.rs:245-250`) treat 429 as `Outcome::Done` (not an error, not
Unauthorized) — explicitly *not* refresh-and-retried, since a 429 isn't a
token problem and retrying would make it worse. Comment at
`pusher.rs:181-184` notes the 15s cooldown already keeps StatusForge's own
request rate low, so 429 here is expected to be rare/defensive rather than a
normal occurrence.

### HTTP timeouts

Every `reqwest` client in this codebase is built with an explicit timeout —
**not uniformly 10 seconds** as the prior summary claimed:
- 10s: all OAuth exchange/refresh/validation calls in `auth.rs`
  (`exchange_kick_token`, `exchange_twitch_token`,
  `fetch_twitch_broadcaster_id`, `refresh_kick_token`,
  `refresh_twitch_token`, `validate_kick_token`, `validate_twitch_token` —
  all `Duration::from_secs(10)`), and all pusher/category calls
  (`pusher.rs:56-61`, the shared `http()` helper used by every push/search
  call).
- 15s: `auth::sync_kick_database()` (`auth.rs:702`, fetching up to 1000 Kick
  categories) and both HTTP clients in `metadata.rs` (`metadata.rs:71,498`,
  the RAWG/IGDB/Steam/GOG/SteamGridDB scan pipeline) — these are longer
  because they're either larger payloads or several chained lookups, and
  they're not on any push-latency-sensitive path.

None of these paths implement retry-with-backoff on timeout — a timeout is
just treated as a generic request failure (`Err(format!("... failed: {}",
e))`), logged, and the call gives up for this cycle.

### Stale-cache fallback for Kick categories — confirmed

Matches the prior summary. `pusher::push_kick()` (`pusher.rs:263-274`)
resolves the Kick category id in this order:
1. `db.library[title].kick_id` (an explicit id the user set in the Library
   editor) — `resolve_kick_id()`, `pusher.rs:77`.
2. `kick_db.json`'s name→id map (case-insensitive), synced periodically by
   `auth::sync_kick_database()` after every successful Kick OAuth connect
   (`auth.rs:296-303`).
3. **Live fallback**: `live_kick_category_search()` (`pusher.rs:110-123`) —
   a direct `GET /public/v2/categories?name=<title>&limit=1` call — used only
   if both the library and the cached `kick_db.json` come up empty. Comment
   at `pusher.rs:103-109` explains why: Kick's category catalog drifts
   (renamed/added categories) faster than the periodic cache resync, so
   without this a brand-new/renamed category would never get pushed.
   Twitch's push path has an equivalent live fallback built directly into
   `twitch_push_once()` (`pusher.rs:139-165`, a Helix "Get Games" call by
   exact name) when the library has no id — there's no separate cache file
   for Twitch since Helix search is fast/cheap enough to call live every
   time.

## Token Storage — Keychain vs Config.json

**CORRECTION to prior summary**: the summary described this as an unresolved
"keychain/config conflict: no single source of truth... need to pick one."
Reading the actual code, this looks like it has *already* been fixed with a
deliberate, documented precedence rule — not a leftover conflict. See the
Audit doc for residual risk, but the design itself is coherent:

### The rule

**Config.json field wins if non-empty; the OS keychain only ever fills a
gap, never overrides.** Implemented in two places that must be read
together:

1. **Read path** — `auth::backfill_from_keychain()` (`auth.rs:780-852`),
   called at the end of every `auth::load_config_at()` (`auth.rs:761-769`,
   the canonical config loader used by the engine loop, pusher, hub,
   metadata scans, and OAuth callback handlers). For each of the 10 secret
   fields (Twitch/Kick access+refresh tokens, Twitch/Kick client secrets,
   IGDB token+secret, RAWG key, SteamGridDB key): *only if the in-memory
   field loaded from Config.json is empty*, it tries
   `keyring::Entry::new("statusforge.io", <keychain_name>).get_password()`
   and fills the field from there. A `NoEntry` result (never migrated) is
   silent; any other keychain error (locked, no Secret Service daemon,
   permission denied) is logged as a warning so it's distinguishable from
   "never connected."
2. **Write path** — `auth::save_config_at()` (`auth.rs:854-872`) always
   calls `redact_migrated_secrets()` (`auth.rs:880-922`) on a *clone* of the
   config being saved before serializing. For each of the same 10 fields: if
   the field is non-empty **and** a keychain entry for it already exists
   (i.e., this install has been migrated), the current value — which could
   be a freshly refreshed token — is written into the keychain and the
   Config.json copy is blanked. If the keychain write itself fails, the
   plaintext is left on disk rather than silently discarded from both
   places. A field with no existing keychain entry (never migrated)
   round-trips through `save_config_at` unchanged (still plaintext on disk).

### Migration entry point

`migrate_tokens_to_keychain()` (`lib.rs:970-1054`, a Tauri command, presumably
user-triggered from a Settings "Move to OS keychain" action) is a one-shot,
one-way move: reads Config.json as raw `serde_json::Value` (not through
`AppConfig`, so it works even on partially-malformed configs), copies each
non-empty of the 6 broadcaster secret fields + 4 API-key fields into the
keychain under fixed names (e.g. `twitch_token` on disk → `twitch_access_token`
in the keychain), blanks them in the JSON, and writes the file back. After
this runs once, `backfill_from_keychain`/`redact_migrated_secrets` keep the
two stores in sync going forward per the rule above (as long as the keychain
stays reachable).

### Where a real conflict *could* still surface

The precedence rule assumes `save_config_at` is always the write path. Two
places bypass it or interact with it in ways that can produce
inconsistency — see `status-forge-audit.md` for the concrete fix
recommendation:
- **Read-modify-write races**: multiple call sites (`hub_set_pin`,
  `hub_set_pairing_key` in `hub.rs:333-355`, the pusher's own
  refresh-then-save in `pusher.rs:207-209`/`283-285`, plus every Settings
  save from the frontend) each do `load_config_at()` → mutate one or two
  fields → `save_config_at()` on the *whole* struct, with no lock around the
  cycle. Two of these racing (e.g. a token refresh mid-flight while the user
  hits Save on the Settings screen with an in-memory `AppConfig` snapshot
  loaded before the refresh) is a classic lost-update: whichever
  `save_config_at` call lands last silently reverts the other's field
  change. The keychain redaction rule limits the *plaintext-leak* half of
  this (a stale in-memory token gets re-blanked and re-synced to keychain
  on save, since the keychain entry already exists), but it does not stop a
  stale *value* (e.g. a since-revoked or since-refreshed token) from being
  written back into the keychain, overwriting the actually-current one.
- **`migrate_tokens_to_keychain`** writes the config file directly (raw
  `serde_json::Value`, bypassing `save_config_at`/`redact_migrated_secrets`)
  — fine for the migration itself, but means it doesn't share the same
  audit/logging path as every other config write.

## Architecture Map

| File | Owns |
|---|---|
| `forge-detection/src/waterfall.rs` | The detection pipeline (`ForgeWaterfall::evaluate`), all stage logic, title formatting, engine-DNA/emulator/alias tables. Pure/unit-testable — no I/O except reading the exe's own directory listing and (Linux) shelling out to `gamemoded`/`flatpak`. |
| `forge-detection/src/platform.rs` | OS-specific primitives: foreground window (title/pid/fullscreen/rect), Steam `RunningAppId` (registry on Windows, `registry.vdf` on macOS/Linux), macOS Screen Recording permission check. |
| `forge-detection/src/lib.rs` | `GameDetection`, `ScannerConfig` (+ defaults), `ForgeKnowledge` — the shared types/config the waterfall consumes. |
| `src-tauri/src/lib.rs` | App bootstrap (`init_app_base_dir`, Config.json template bootstrap), `NativeEngineState`, the engine loop (`spawn_engine_loop`) that drives the waterfall on a timer and reacts to detections (`on_game_detected`), OS keychain Tauri commands + `migrate_tokens_to_keychain`. |
| `src-tauri/src/config.rs` | `AppConfig`/`EngineSettings`/`BroadcasterConfig`/`ApiKeys`/`ForgeDatabase`/`ForgeLibraryEntry` structs, defaults, `validate()`/`sanitize()`. Plain data — no I/O. |
| `src-tauri/src/auth.rs` | OAuth 2.0/2.1 (PKCE) for Kick + Twitch, token refresh, manual-token validation, Kick category DB sync, **the config load/save + keychain backfill/redact functions** (`load_config_at`, `save_config_at`, `backfill_from_keychain`, `redact_migrated_secrets`), self-signed TLS cert generation for the local OAuth callback, widget-token rotation. |
| `src-tauri/src/pusher.rs` | The actual Twitch/Kick category-push HTTP calls, 401/429 handling, refresh-and-retry, per-platform cooldown, Kick live-category-search fallback. The real "hub" of the push pipeline despite the name similarity to `hub.rs`. |
| `src-tauri/src/hub.rs` | The LAN "Hub" side of the SPARK dual-PC link: UDP heartbeat listener (53735) + discovery announcer (53736), heartbeat validation delegation to `spark_protocol`, funnels a SPARK-sourced detection through the same `on_game_detected`/`push_category` path as local detection. Not related to Twitch/Kick HTTP. |
| `src-tauri/src/spark_protocol.rs` | Wire format + HMAC-signed heartbeat validation for the SPARK LAN protocol (v2; v1 legacy packets logged-and-rejected). A byte-identical copy lives in `spark-app/src-tauri/src/`. |
| `src-tauri/src/server.rs` | Local axum server on `127.0.0.1:53735`, multiplexing TLS (Twitch OAuth callback) and plain HTTP (widget overlays, `/status`, `/ws` WebSocket, Kick OAuth callback) on one port by peeking the first byte. Widget endpoints require `X-Forge-Token`/`?token=` matching `engine_settings.widget_token` (401 otherwise). |
| `src-tauri/src/metadata.rs` | `/api/scan-metadata` — RAWG → IGDB → Steam → GOG → SteamGridDB → Twitch/Kick category-id lookup, in that order, each independently skip-on-failure. Merge-only-empty-fields, respects per-field `locked_fields`. |
| `spark-app/` | Separate, smaller Tauri app — the "SPARK" companion meant to run on a second gaming PC with no game database/metadata/platform-push responsibilities; only detects and forwards heartbeats to a Hub. Has its own working `auto_push` toggle (unrelated to StatusForge's dead field of the same name). |

## Config Defaults Worth Knowing

From `config.rs` (`Default for EngineSettings`, `default_*` functions):

| Setting | Default | Notes |
|---|---|---|
| `scan_interval` | 5s | Validated floor of 2s (`config.rs:400-406`) |
| `grace_period` | 15s | Validated ceiling of 300s |
| `ram_threshold` | 80 MB | Stage 3 floor + Stage 5 signal |
| `confidence_threshold` | 0.5 | Stage 5 pass/fail line |
| `emulator_detection` | true | |
| `process_filter_bypass` | false | Skips Stage 2 hard kills (not Stage 3 traps) |
| `platform_push_enabled` | true | The real auto-push gate (see above) |
| `auto_push` | false | **Dead field in this app** — never read |
| `strict_forge_mode` | false | Kills detection at Stage 1 if not in `listed_apps`/built-in aliases |
| All Stage 3/5 toggles (`trap_*`, `score_*`) | true | |
| `spark_pin` | "0000" | Validated to exactly 4 digits |
| `widget_fade_timer` / `widget_poll_rate` | 15s / 3s | Overlay-side, not detection |
