# BearO's Joystick Companion

A standalone addon for StatusForge.io — pushes the currently detected game to
Joystick.tv as a stream category update, with an optional chat announcement
and a small chat bot. Runs as its own app, separate from StatusForge itself,
on purpose: Joystick.tv has a 2.0 API reportedly coming, and keeping this
decoupled means only this small app needs rewriting when that lands.

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

## Testing without waiting for a real game change

Once connected, a **Test Push Now** button appears. It fires a category push
and a chat message immediately (using whatever title StatusForge currently
reports, or "Test Category" if none), and shows a one-line OK/FAILED result
for each — no need to actually launch a game to see whether the integration
works end to end.

## If something doesn't work

Two things in this addon are genuinely unverified against a live Joystick.tv
account (this was built somewhere without network access to
`api.joystick.tv`):

- The exact field Joystick expects on `PUT /me/stream` for the category —
  handled defensively (`GET` first, overwrite whichever key already looks
  like a category), but the guessed key names
  (`category`/`game`/`game_name`/`genre`) might not match.
- The chat gateway's exact message envelope — the `!game` command handler
  parses `message.text` / `data.text` / `text` in that order, which might not
  match what Joystick actually sends.

Both paths log the **raw response/message bodies** at debug level, so if
something fails (or the chat bot doesn't respond to `!game`), check the log
file:

- Windows: `%APPDATA%\com.bearddoddity.joystickbot\logs\joystick-bot.log`
- macOS: `~/Library/Logs/com.bearddoddity.joystickbot/joystick-bot.log`
- Linux: `~/.local/share/com.bearddoddity.joystickbot/logs/joystick-bot.log`

(or just watch the terminal if running via `npx tauri dev` — logs also go to
stdout.)

Paste the relevant log lines back and the field-name lists in
`src-tauri/src/lib.rs` (`CATEGORY_KEY_CANDIDATES`) and `src-tauri/src/oauth.rs`
(`extract_chat_text`) are one-line fixes once the real shape is known.

## What's deliberately not here yet

- Not wired into StatusForge's `release.yml` — no official installer builds
  yet.
- No automated tests.
- Icons are placeholders reused from `blipy-app`.
