# StatusForge.io

[Website](https://bearddoddity.github.io/statusforge/) · [Download](https://bearddoddity.github.io/statusforge/download.html)

StatusForge watches what game you're playing and keeps your stream's category up to date automatically — no more forgetting to switch your Twitch/Kick category, no more doing it by hand between rounds.

## What it does

- **Detects games automatically.** A native detection engine (Windows, with community macOS/Linux builds) figures out what you're playing and updates your Twitch and Kick category live.
- **Learns your library.** Every detected game gets a library entry with cover art, genre, developer, and release year pulled from Steam, IGDB, RAWG, GOG, SteamGridDB, and TheGamesDB.
- **Handles the edge cases.** Detection aliases teach it that "DS3" and "Dark Souls III" are the same game. A manual override lets you force a category when detection guesses wrong. If Twitch or Kick's API goes down, it keeps detecting locally and catches back up automatically once the API's back.
- **Asks when it's not sure.** After a detection, you can confirm it or correct it — corrections teach the alias system so the same mistake doesn't happen twice.
- **Works across two PCs.** The optional Blipy companion agent runs on a separate gaming PC and forwards detections to StatusForge on your streaming PC.
- **Ships overlays.** Browser-source overlays for your streaming software, driven by the same detection engine.

## Repository layout

This repo holds StatusForge itself plus its companion apps and shared code:

- **`src/`, `src-tauri/`** — StatusForge, the main app (React + Rust/Tauri). `npm run tauri dev` at the repo root runs this.
- **`forge-detection/`** — the Rust game-detection engine, shared as a crate by StatusForge and Blipy.
- **`blipy-app/`** — Blipy, the optional dual-PC companion agent (its own Tauri app, own `package.json`/`src-tauri/`).
- **`joystick-bot/`** — the optional Joystick.tv chat bot companion (own Tauri app; see [`joystick-bot/README.md`](joystick-bot/README.md)).
- **`docs/`** — test plans and other project docs.
- **`scripts/`** — repo maintenance scripts (capability checks, the Pages download-page sync).
- **`widgets/`, `public/`, `icons/`** — overlay assets and app icons bundled into releases.

Each app folder builds independently (`cd blipy-app && npm install && npm run tauri dev`, etc.) — they don't share a build step, only the `forge-detection` crate and this repo.

## Platform support

Windows 10/11 is the primary, tested target. macOS and Linux builds exist and are community-supported — file an issue if something's broken there.

## Running it yourself

You'll need [Node.js](https://nodejs.org) and the [Rust toolchain](https://rustup.rs) installed.

```
npm install
npm run tauri dev
```

That builds the Rust backend and launches the app in dev mode. `npm run tauri build` produces a release build.

## Privacy

StatusForge runs entirely on your machine. To detect games, it reads process names, window titles, launch arguments, and — for some emulators — their own log files; these are passive, OS-level reads, and it never touches a game's or emulator's memory, injects code, or reads save data. It talks to Twitch, Kick, Steam, IGDB, RAWG, GOG, SteamGridDB, and TheGamesDB only when you've connected them, and only to look up the game you're currently playing or push your category. Nothing else leaves your computer.

## Maintainer

StatusForge is built and maintained solo. Bug reports are welcome via GitHub Issues — if something's broken, let me know and I'll take a look.

## License

MIT.
