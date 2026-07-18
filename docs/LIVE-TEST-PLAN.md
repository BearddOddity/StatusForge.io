# Live Test Plan — branch `claude/status-forge-setup-5d7pcs`

CI already covers the compile, the unit tests on all three OSes, and a
startup smoke test. What it can't cover is anything that needs an actual
human, an actual Twitch/Kick account, and an actual keychain — that's what
this plan is for.

**Time**: ~30 minutes. **Best on**: Windows 10/11 (the primary target).

---

## 0. Setup

```
git fetch origin claude/status-forge-setup-5d7pcs
git checkout claude/status-forge-setup-5d7pcs
npm install
npm run tauri dev
```

Before starting, note your current state so you can verify nothing regressed:

- [ ] App launches, dashboard loads, no console errors
- [ ] Engine starts and detects a running game like before
- [ ] Twitch/Kick show connected in Settings → API & Routing (if previously connected)

Heads up: several of these push real category changes to Twitch/Kick. Do
this offline or somewhere your viewers won't mind the category flapping a
few times.

---

## 1. Keychain round-trip fix

Settings used to read and write Config.json directly, skipping the
keychain entirely — migrated tokens looked disconnected in the UI and
could end up back on disk in plaintext.

- [ ] With tokens migrated to the keychain (Settings → run "Migrate Tokens" if you haven't), open Settings → API & Routing: Twitch/Kick must show **"Connected via OAuth"**, not empty fields
- [ ] Change any unrelated setting (e.g. widget fade timer), save, then open `Config.json` in a text editor: `twitch_token` / `kick_token` must **not** appear as plaintext values
- [ ] Restart the app: still connected, engine still pushes categories

## 2. Disconnect button

- [ ] Settings → API & Routing → a connected platform now shows **"Disconnect"** (not "Remove") on OAuth-backed entries
- [ ] Click it: success toast, entry disappears immediately (no "save to confirm" step)
- [ ] Restart the app: platform **stays** disconnected (old bug: token resurrected from keychain)
- [ ] Windows Credential Manager (`Win+R` → `control keymgr.dll` → Windows Credentials): the `statusforge.io` entries for that platform are gone
- [ ] Reconnect via OAuth: works as before

## 3. Auto-update toggle

- [ ] Settings → System → Logs & Updates: new **"Automatically Check for Updates"** toggle, on by default
- [ ] Turn it off, restart: no update banner appears (with a newer release published, on = banner shows once per launch)

## 4. Manual Override

- [ ] Dashboard → Now Playing card: **"🎮 Override Game"** button always visible
- [ ] Click, type a real game (e.g. `Hades`), press Enter or "Broadcast":
  - success toast "override active for 5 minutes"
  - Now Playing shows the game; Twitch/Kick category updates within seconds
  - if it wasn't in your Library, it appears there with metadata scanned in
- [ ] While the override is active, launch/focus a different game: detection must **not** replace the override
- [ ] After 5 minutes: "Override cleared" toast, normal detection resumes
- [ ] Escape/Cancel closes the input without broadcasting

## 5. Detection Aliases

- [ ] Library → any game → edit: new **"Detection Aliases"** field in Basic Info
- [ ] Add e.g. `TestAlias123`, save; re-open the editor: alias still there
- [ ] Dashboard → Override Game → type `testalias123` (lowercase): it broadcasts the **canonical** game, not "testalias123"
- [ ] Try saving an alias that equals another library game's title: save is rejected with a clear error
- [ ] (Deeper) Rename a game's `executables` mapping to a wrong-title scenario you know, alias the wrong title to the right game, relaunch the game: detection lands on the right title

## 6. API downtime handling

Simulate an outage without touching your router: add to
`C:\Windows\System32\drivers\etc\hosts` (as admin):

```
127.0.0.1 api.twitch.tv
```

- [ ] Switch games (or use Override): within seconds a toast — **"⚠️ Twitch API unreachable — broadcasting paused, retrying automatically"** — exactly once, not repeating
- [ ] Detection keeps working locally (Now Playing updates; app stays responsive)
- [ ] Switch games again while "down": no new toast, no freeze
- [ ] Remove the hosts line (and `ipconfig /flushdns`): within ~30s — **"✅ Twitch API recovered — broadcasting resumed"** — and your Twitch category updates to the game you're playing **now** (the latest one, not the first one that failed)
- [ ] Kick kept pushing normally the whole time (independent tracking)

## 7. Feedback loop

- [ ] Launch a game so detection fires: dashboard shows **"Detected “X” — is that right? [Yes] [No]"**
- [ ] Click **Yes**: prompt closes quietly
- [ ] Trigger another detection, click **No**, type the "actual" game, "Fix & Broadcast":
  - toast: correction saved, `"X" will now resolve to "Y"`
  - broadcast switches to Y (override path, 5-min hold)
  - Library → Y → Detection Aliases now contains X
- [ ] Manual overrides do **not** show the prompt
- [ ] `detection_feedback.json` (next to Config.json) contains your confirmed/corrected tallies per method

## 8. Cover/logo URL fix

- [ ] Library → any game → Cover URL → paste a SteamGridDB page link (e.g.
      `https://www.steamgriddb.com/grid/805055`) → save: the actual cover
      shows up, not a broken image. Needs a SteamGridDB key set in Settings —
      without one, save fails with a clear message telling you to add one
- [ ] Try the same for Logo URL with a `/logo/{id}` page link
- [ ] Paste a plain direct image URL (e.g. straight from an image host):
      still works as before
- [ ] Paste a local file path (an image on your own disk): it renders

## 9. Regression sweep (10 min)

- [ ] Overlays/widgets still render and update on game change
- [ ] Blipy dual-PC link (if you use it) still forwards detections
- [ ] Library editor: add/edit/delete, metadata scan, cover art — all unchanged
- [ ] Exile to Apps still works
- [ ] Settings import/export config backup still works
- [ ] Leave the app idle 15 min: CPU/RAM normal, no toast spam, no log flooding (Dev Tools → log tail)

---

## If something breaks

Note the step number and grab `debug.log` (app base dir, Dev Tools → log
tail shows the location). Rolling back is safe — all changes are additive
and data-compatible:

```
git checkout main
```

Existing `Config.json` / `Forge_Database.json` files are untouched by the
new code paths until you use the new features (aliases/feedback add new
JSON keys only when used; old builds ignore them).
