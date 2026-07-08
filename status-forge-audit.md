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
   affecting both settings and OAuth tokens.
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
