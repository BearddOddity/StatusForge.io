# BearO's Joystick Companion

A standalone addon for StatusForge.io — announces the currently detected game
in your Joystick.tv chat, with a small chat bot (`!game`). Runs as its own
app, separate from StatusForge itself, on purpose: Joystick.tv has a 2.0 API
reportedly coming, and keeping this decoupled means only this small app needs
rewriting when that lands.

**Stream category updates are not currently supported** — Joystick.tv doesn't
have game categories yet, unlike Twitch/Kick. The category-push code
(`push_category`, `CATEGORY_KEY_CANDIDATES`) is still in the codebase and the
toggle exists in the UI (disabled, off by default) so it's ready to switch on
the day Joystick adds categories, but right now it would just fail every
time — this isn't a bug to chase, it's a platform gap.

It is **not** part of StatusForge's build or release process. Build and run
it yourself.

## Setup

1. Register an OAuth application in your Joystick.tv account settings
   (developer/application section) to get a **Client ID**. Choose a
   **public** client — this addon uses PKCE and never asks for a client
   secret. Set the redirect URI to:

   ```
   http://127.0.0.1:53737/callback
   ```

2. Install dependencies and run it:

   ```
   cd joystick-bot
   npm install
   npx tauri dev
   ```

   (or `npx tauri build` for a standalone installer — see
   `src-tauri/tauri.conf.json` for bundle targets).

3. StatusForge.io itself needs to be running at the same time — this addon
   polls its local `/status` endpoint (`http://127.0.0.1:53735/status`) to
   know what game is currently detected. No StatusForge-side setup is
   required for this; that endpoint already exists.

4. Paste your Client ID into the small window, click **Connect**, and finish
   the login in the browser tab that opens.

## Customizing the chat messages

Click **✎ Edit Messages** (visible once connected) to edit the announce and
`!game`-reply lines — one variant per line, one is picked at random each
time so it's not the exact same text every game change. Placeholders:

- `{title}` — the detected game's title
- `{genre}`, `{developer}`, `{release_year}` — pulled from StatusForge's own
  library lookup for that title; blank if StatusForge doesn't have a match,
  which can leave an odd gap in a template that uses them (e.g. a missing
  genre in "a {genre} game") — the defaults lean on `{title}` alone for that
  reason, but feel free to lean harder on the others once your library data
  is filled in.

## Testing without waiting for a real game change

Once connected, a **Test Push Now** button appears. It sends a test chat
message immediately (using whatever title StatusForge currently reports, or
"Test Category" if none) and shows a one-line OK/FAILED result — no need to
actually launch a game to see whether the chat side of the integration works
end to end. Category push is intentionally skipped by this button (see
above).

## If something doesn't work

The chat gateway's exact message envelope is genuinely unverified against a
live Joystick.tv account (this was built somewhere without network access to
`api.joystick.tv`) — the `!game` command handler parses `message.text` /
`data.text` / `text` in that order, which might not match what Joystick
actually sends.

Incoming gateway messages log at debug level, so if the chat bot doesn't
respond to `!game`, check the log file:

- Windows: `%APPDATA%\com.bearddoddity.joystickbot\logs\joystick-bot.log`
- macOS: `~/Library/Logs/com.bearddoddity.joystickbot/joystick-bot.log`
- Linux: `~/.local/share/com.bearddoddity.joystickbot/logs/joystick-bot.log`

(or just watch the terminal if running via `npx tauri dev` — logs also go to
stdout.)

Paste the relevant log lines back and `extract_chat_text` in
`src-tauri/src/oauth.rs` is a one-line fix once the real message shape is
known.

## What's deliberately not here yet

- Not wired into StatusForge's `release.yml` — no official installer builds
  yet.
- No automated tests.
- Icons are placeholders reused from `blipy-app`.
