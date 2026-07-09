# StatusForge — Audit Summary

Companion to `status-forge-mcp.md` (full technical reference, with
file:line citations). This doc is the action-oriented punch list. Findings
below were reached by reading the actual source, not by re-reading the
prior interview summary — several of its claims were wrong or incomplete;
corrections are marked.

## Confirmed working as-is

- **Detection waterfall** (`forge-detection/src/waterfall.rs`) — the 5-stage
  design (listed apps → hard kills → behavioral traps → authoritative proof
  → confidence scoring) is real, unit-tested (30+ tests in the same file),
  and matches the ported-from-Python design docs at the top of the file.
- **Push cooldown is 15 seconds**, per-platform, independently tracked for
  Twitch/Kick (`pusher.rs:26-48`). Matches what was claimed.
- **429 handling** — both Twitch and Kick pushes correctly treat 429 as
  "skip, don't retry, don't refresh" (`pusher.rs:180-187`, `245-250`).
- **401 handling** — both platforms do a refresh-token exchange and one
  retry on 401 (`pusher.rs:200-225`, `263-300`). Retry is capped at one
  attempt; a second 401 just logs and gives up (no crash, no infinite loop).
- **Kick stale-cache fallback** — confirmed: library id → `kick_db.json`
  cache → live category search, in that order (`pusher.rs:263-274`).
- **Keychain vs Config.json precedence** — contrary to the prior interview
  summary calling this an open bug, the code already implements a coherent,
  documented rule: Config.json wins if non-empty, keychain only fills gaps
  on read (`auth::backfill_from_keychain`, `auth.rs:780-852`), and any
  already-migrated field gets re-synced to keychain and re-blanked on every
  save (`auth::redact_migrated_secrets`, `auth.rs:880-922`). This looks like
  a previously-identified issue that has already been fixed with real
  thought (see the extensive comments at those functions explaining exactly
  why each check exists).

## Found broken / risky

### 1. `engine_settings.auto_push` is dead code in the main app (medium)
- **What**: `AppConfig.engine_settings.auto_push` (`config.rs:61`, default
  `false`) is never read anywhere in `src-tauri` — grep confirms zero
  references outside its own declaration. The field that actually gates
  pushing is a *different* one, `platform_push_enabled` (`config.rs:66`,
  default `true`), which is the one wired to a working UI toggle
  (`src/SettingsView.tsx:1745-1752`).
- **Root cause**: `auto_push` appears to be a copy-paste leftover from the
  separate `spark-app` companion, which has its own, functioning
  `auto_push` flag gating its heartbeat loop
  (`spark-app/src-tauri/src/lib.rs:206-211`). The two apps share a naming
  convention but not an implementation.
- **Risk**: if a future UI change binds a "Auto Push" toggle to this field
  (a very easy mistake to make given the name and that it's already in
  `AppConfig`/`src/types/index.ts:52`), it will silently do nothing — pushes
  will keep firing regardless of the toggle's state.
- **Fix recommendation**: either wire `auto_push` into `pusher::push_category()`
  as an actual second gate (if the intent is a genuinely separate on/off
  switch from `platform_push_enabled`), or remove the field entirely from
  `AppConfig`/`src/types/index.ts` to stop it from looking load-bearing.

### 2. No locking around the config load-modify-save cycle (medium, latent)
- **What**: every call site that changes one or two config fields —
  `hub_set_pin`/`hub_set_pairing_key` (`hub.rs:333-355`), the pusher's own
  refresh-then-save (`pusher.rs:207-209`, `283-285`), and the Settings-save
  path from the frontend — does `load_config_at()` → mutate → `save_config_at()`
  on the *entire* struct, with no lock spanning the read-modify-write. Two
  of these racing (e.g. a background token refresh completing while the
  user hits Save on Settings with an `AppConfig` snapshot loaded before that
  refresh) is a classic lost-update: whichever `save_config_at` call lands
  last silently reverts the other's change.
- **Why it's not purely theoretical**: the token-refresh path and the
  Settings-save path run on different threads (engine loop / std::thread vs
  Tauri command handler) and there is no `Mutex` guarding `Config.json`
  access anywhere in `auth.rs` or `lib.rs`.
- **Note**: the keychain redaction rule limits the *plaintext-leak* half of
  this — a stale in-memory token that gets saved will still be correctly
  re-synced to keychain and re-blanked on disk (since the keychain entry
  already exists post-migration) — but it does not stop a stale *value*
  (an old, already-refreshed-away token) from overwriting the current one
  in the keychain.
- **Fix recommendation**: serialize all `load_config_at`/`save_config_at`
  pairs behind a single process-wide `Mutex`/`RwLock` (or move to a
  read-modify-write helper that takes a closure and holds the lock for the
  whole operation), so a refresh-and-save can't be clobbered by a concurrent
  settings save using a stale snapshot.

### 3. No exponential backoff / permanent-failure signal on refresh failure (low)
- **What**: `auth::refresh_twitch_token`/`refresh_kick_token` failures
  (e.g., permanently revoked refresh token) are logged
  (`"[PUSH] {} token refresh failed"`) and nothing else happens —
  `pusher.rs:220`, `295`. Every subsequent detection will retry the same
  doomed refresh call, hit the same 10s-timeout HTTP round trip, and fail
  again, forever, with no UI signal that the connection needs to be
  re-authorized.
- **Fix recommendation**: on a refresh failure that looks permanent (e.g.
  `invalid_grant`), clear the stored token/refresh pair and surface a
  "reconnect Twitch/Kick" state to the frontend instead of retrying silently
  on every game-change event.

### 4. Prior "Steam registry primary, launcher parents 2nd" description was imprecise
- Not a bug, just worth fixing in documentation/mental model: the real order
  inside Stage 4 is Steam registry → Linux GameMode/Flatpak (Linux-only) →
  Proton/Wine wrapper parent → official-launcher parent, all as one
  "authoritative proof" step, not two separate stages. See
  `status-forge-mcp.md` for the corrected breakdown.

### 5. HTTP timeouts are not uniformly 10s
- Push/auth calls are 10s; `metadata.rs` scans and `auth::sync_kick_database`
  are 15s. Not a bug, but worth knowing before tuning any of them — they are
  not all the same knob.

## Prioritized pre-1.0 punch list

1. **Fix or remove `engine_settings.auto_push`** (Finding 1) — cheap, low
   risk, prevents a near-certain future UI bug.
2. **Add locking around config read-modify-write** (Finding 2) — moderate
   effort, addresses a real (if narrow-window) data-loss/stale-secret race
   affecting both settings and OAuth tokens. **This is the actual fix target
   behind the interview material's "token storage has no single source of
   truth" framing** — see Reconciliation Note below; the precedence rule
   itself already exists and works, the race condition is the real residual
   risk.
3. **Surface permanent auth failures to the UI instead of silent infinite
   retry** (Finding 3) — moderate effort, meaningfully improves the
   experience for the (likely common) case of a user revoking app access on
   Twitch/Kick's side.
4. Consider whether `process_filter_bypass` bypassing only Stage 2 (not
   Stage 3's behavioral traps) is the intended scope — not investigated here
   as a bug, but worth a deliberate sign-off before 1.0 since it's a subtle
   distinction a support conversation could hinge on.
5. Nice-to-have: `migrate_tokens_to_keychain` bypasses `save_config_at`
   entirely (writes raw `serde_json::Value`, `lib.rs:1046-1051`) — functions
   correctly today but means it doesn't benefit from any future
   centralized-locking fix to Finding 2 unless updated alongside it.

### Reconciliation Note: "token storage source-of-truth" vs. the race condition

Interview material (all four supplied planning docs) frames token storage
as an unresolved config.json-vs-keychain conflict with "no clear runtime
precedence," and lists it as the single critical pre-MVP blocker. The
code-verified finding above is different: a precedence rule already exists
and is implemented deliberately (config.json wins if non-empty, keychain
only fills gaps — `auth.rs:780-852`, `auth.rs:880-922`). The real bug is
Finding 2's unlocked read-modify-write race, not a missing precedence rule.
**Recommendation: point the interview's "critical, allocate time this
week" urgency at Finding 2 (add a mutex/serialize config
load-mutate-save), not at redesigning a precedence rule that isn't
actually broken.** Writing tests for "both keychain-primary and
config-primary" strategies, as one interview doc suggests, is unnecessary
extra work if the existing config-wins/keychain-backfills rule is kept —
tests should instead target the race (concurrent refresh-and-save vs.
Settings-save) and confirm the last-write-wins failure mode is closed by
the added lock.

## Additional Findings — Interview-Sourced, Not Yet Investigated Against Code

These items come from the newly-supplied product-interview docs. Unlike
everything above, they were not independently checked against source in
this pass (either because they describe roadmap/future work with no
existing implementation to check, or because checking them was out of
scope for this merge). They are recorded here as-reported so they aren't
lost, clearly marked as unverified.

- **Launcher support gaps (interview-reported)**: only Epic/EA/Ubisoft
  launcher-parent detection is claimed to exist today (matches the
  verified Stage 4 process-tree parent check — `waterfall.rs:373-393` lists
  `epicgameslauncher.exe`, `eadesktop.exe`, `upc.exe`). GOG, itch.io, and
  Microsoft Store launcher-parent support is requested as a high-priority
  pre-1.0 addition — not present in the verified parent-name list.
- **No persistent metadata cache (interview-reported)**: `metadata.rs`'s
  RAWG/IGDB/Steam/GOG/SteamGridDB chain (verified) appears to re-run its
  lookup chain per scan rather than reading from a TTL'd cache; a SQLite
  metadata cache with a 24h TTL is requested. Not independently confirmed
  in this pass whether any caching already exists in `metadata.rs` beyond
  "merge only empty fields" / `locked_fields` — worth a follow-up read of
  `metadata.rs` before starting this work.
- **Emulator detection accuracy** (interview-reported, matches known
  limitation) — the emulator title-splitter (waterfall.rs, title
  formatting step 2, `EMULATOR_TAGS`) is a fixed list; broader/community
  emulator detection improvement is requested but scope not defined.
- **Confidence scoring false negatives for indie games / tuning feedback
  loop** (interview-reported) — Stage 5's fixed weights (Engine DNA 0.4,
  Fullscreen 0.3, Distinct title 0.2, RAM 0.1, threshold 0.5) are
  code-verified as-is; a user-facing feedback loop to tune these per-user
  is roadmap only, no code found.
- **Crate extraction design (generic vs. StatusForge-specific)** — open
  product/architecture decision, not a code question; see Business/Product
  Context section of `status-forge-mcp.md`.
- **IGDB/Steam "integration"** — per the mcp.md reconciliation, IGDB and
  Steam are already two of the five sources in the existing `metadata.rs`
  chain; what's actually missing is a persistent cache layer, not the API
  integrations themselves. Scope any "IGDB/Steam integration" roadmap item
  accordingly.
- **YouTube/JoystickTV chat-bot workaround, Rumble platform research** —
  no code exists for any of these three platforms; pure roadmap.
- **Manual override UI** — confirmed absent from `src/components/` and
  `src-tauri/src/` in this pass, consistent with interview's own "not yet
  implemented" framing (no conflict, just confirming the negative).
- **Linux detection maturity** — interview docs flag this as an open
  unknown requiring verification before public launch; the waterfall does
  have Linux-specific code (`linux_golden_ticket`, `gamemoded`/`flatpak`
  checks, `registry.vdf` parsing — see Stage 4 above), but this pass did
  not attempt to assess real-world detection accuracy on Linux, only that
  the code paths exist and compile under `#[cfg(target_os = "linux")]`.

## Roadmap / Next Steps (from interview material — product priorities, not code findings)

Concise summary of the "next steps" planning doc. These are priorities and
decisions, not verified code facts — no line-number citations below.

### Pre-MVP (~1 month)

- **[CRITICAL]** Token storage fix — scope should be the read-modify-write
  race (Finding 2 above), not the precedence rule (already correct). File:
  `src-tauri/src/auth.rs` (and the call sites in `hub.rs`/`pusher.rs` that
  race against it).
- **[MEDIUM, can defer to v1.1]** Manual override UI — Override
  button/modal in the React overlay, library-or-custom title pick, new
  Tauri command, persistence optional. Files: `src/components/`,
  `src-tauri/src/`.
- **[CRITICAL, likely 1-day task]** Verify Linux detection end-to-end on a
  real/VM Linux box — confirm the pipeline runs, platform tag extraction
  works, metadata fallbacks behave. File: `forge-detection/src/waterfall.rs`.
- **[DEFER, low effort]** Rumble platform research — find API docs, cap at
  1 week. File: `src-tauri/src/pusher.rs`.

### Post-MVP (1-3 months)

- Design a generic detection crate interface (`detect_active_game() ->
  GameDetection`) vs. keeping `forge-detection` StatusForge-specific —
  spec both, decide. Files: `forge-detection/`, new `status-forge-core/lib.rs`.
- Wire into StreamerSuite's modular architecture — move detection crate to
  a shared location, expose Tauri commands via a StreamerSuite dispatcher,
  hybrid shared+tool-specific config DB.
- Migrate the library from JSON to SQLite — schema design (games table,
  metadata columns, timestamps, indices), migration code, CRUD updates.
  New/extended file: `src-tauri/src/db.rs`; migrate
  `src-tauri/src/library.rs`-equivalent logic (current library storage is
  inside `config.rs`'s `ForgeLibraryEntry`/JSON, per the verified
  Architecture Map — there is no separate `library.rs` today).
- Add a persistent IGDB/Steam-backed metadata cache with 24h TTL — extend
  `src-tauri/src/metadata.rs` (the API calls already exist; this is the
  caching layer).
- Expand launcher support: GOG, itch.io, Microsoft Store — extend Stage 4's
  parent-process list in `forge-detection/src/waterfall.rs`.
- YouTube/JoystickTV chat-bot relay workaround — design + document. File:
  `src-tauri/src/pusher.rs`.

### Long-term (post-1.0)

Exponential backoff on API failures (ties to audit Finding 3), user
feedback loop for detection accuracy, expanded emulator/community
detection DB, browser game detection, console detection if there's
demand, confidence-tuning UI, metadata-lookup caching (see above), and
event-driven detection (boost scan on window-focus change rather than
pure polling).

### Decision matrix (as reported in the interview)

| Item | Priority | Blocking MVP | Effort | Impact |
|---|---|---|---|---|
| Token storage fix (rescoped to Finding 2) | Critical | Yes | Medium | High |
| Linux verification | Critical | Maybe | Low | High |
| Manual override UI | Defer to v1.1 | No | Medium | Medium |
| Rumble research | Defer | No | Low | Medium |
| Crate extraction design | Post-MVP | No | High | High |
| Library → SQLite | Post-MVP | No | Medium | Medium |
| IGDB/Steam caching layer | Post-MVP | No | High | High |
| Launcher expansion (GOG/itch.io/MS Store) | Post-MVP | No | Medium | Medium |
| Chat-bot integration (YouTube/JoystickTV) | Post-MVP | No | High | Low |

### Success criteria for pre-MVP sign-off (as reported)

- Token storage race closed, no lost-update on concurrent refresh+save.
- Detection verified on Windows (tested) and Linux (needs verification).
- Metadata broadcasts correctly on push.
- Overlay/widget reflects live state in real time.
- 15s cooldown + retry-once-on-401 prevents API hammering (already true
  per code).
- Errors logged gracefully, no crashes on 401/429 (already true per code).
- Library auto-generates and persists (already true per code, JSON-backed).
