# StatusForge — Positioning & Market Research

Web-researched, not assumed. Every factual claim below is either (a) sourced
to a URL in the Sources section, or (b) sourced to file:line references
already established in `status-forge-mcp.md` / `status-forge-audit.md`. Where
I could not confirm something after a real search, it's marked
**unconfirmed** rather than filled in with a plausible-sounding number —
see the note at the top of this repo's other two docs about a prior pass
that fabricated defaults (`idle_category`, `confidence_threshold: 0.0`,
"~120 requests/min" for Twitch). None of those fabricated numbers appear in
this document. This document does not restate config defaults at all —
for those, see `status-forge-mcp.md`'s "Config Defaults Worth Knowing"
table, which is code-verified (`config.rs` file:line citations).

Research date: 2026-07-09. All URLs were live-fetched or searched on this
date; software projects change, so treat feature lists as a snapshot.

---

## 1. Competitive Analysis

**Bottom line up front**: this is a genuinely narrow niche. I found a
handful of real, working open-source tools that do "detect running game →
push Twitch category," all Windows-first, all single-platform (Twitch-only,
with one exception that also supports Trovo), and none of them advertise
StatusForge's specific detection techniques (Steam registry read, Proton/Wine
process-tree walk, confidence-scored fallback for indie/DRM-free games) or
simultaneous multi-platform (Twitch **and** Kick) push. I did not find any
commercial/SaaS product doing this — everything found is free, open-source,
and community-maintained (OBS forum resources, GitHub repos, or plugins for
the general-purpose bot framework Streamer.bot). I did not find a tool that
also does local overlay widgets, a metadata-enrichment pipeline (RAWG/IGDB/
Steam/GOG/SteamGridDB), or a LAN companion app (StatusForge's SPARK) in the
same space — but I can't rule out that a smaller/less-discoverable project
exists that I didn't surface in search; treat "no one else does X" claims
below as "not found in this search pass," not as an exhaustive market survey.

### Direct/near-direct competitors found

**Game Detector** (OBS Studio plugin, native/compiled)
- Detects games by scanning Steam, Epic Games, GOG, and Ubisoft Connect
  library folders (library-scan approach, not live process/window
  inspection) and updates Twitch **or Trovo** category automatically.
- Claims <5s detection time, "zero performance impact."
- Distribution: OBS Forums resource page (the page itself 403'd on direct
  fetch during this research pass, so feature claims here come from search
  result snippets, not a first-hand read of the full listing — treat as
  **medium confidence**, worth a manual check before quoting in marketing).
- No Kick support found/claimed.

**TwitchAutoCategoryManager** (Troyo26, GitHub, OBS plugin)
- Detects the running process, checks the user's custom exe→game mappings
  first, then falls back to Discord's public "detectable applications"
  database for identification.
- Twitch-only. Windows-only (OBS + Twitch dev app credentials, OAuth2 via
  browser).
- Free, open-source, GPLv3.
- No confidence scoring, no Proton/Wine/launcher-parent detection, no
  metadata enrichment, no Kick support, no local overlay widgets.

**ActionBot** (BOLL7708, GitHub)
- A broader Twitch bot; one of its many features is "update the Twitch
  category from the currently running Steam game automatically" — i.e.,
  Steam-only detection (no non-Steam/DRM-free fallback found).
- Twitch-only. TypeScript + PHP, self-hosted (requires a local webserver,
  PHP 8.2+). Free, open-source, AGPL-3.0.

**obs-twitch-auto-category-lua** (Sno0t, GitHub) and **"Auto Twitch
Category"** (Misiphear, OBS Forums)
- Both are OBS Lua scripts that watch running processes/Task Manager and
  swap the Twitch category on a match. Twitch-only, Windows-only, no
  confidence scoring or multi-platform push found.

**Streamer.bot** (general-purpose streaming automation platform, not a
dedicated detector)
- Not itself an auto-detector — it's a scripting/automation framework.
  It ships a "Process Started" trigger (Core → Processes) and a "Set
  Channel Game" sub-action, plus Kick "Channel Update" triggers via its
  Kick integration, so a user *can* wire up their own Twitch/Kick category
  automation manually, per-game, inside Streamer.bot. This requires the
  user to build the automation themselves (create an if/else or a trigger
  per game they want auto-detected) rather than getting an out-of-the-box
  waterfall/confidence system. Worth naming because it's the most
  "multi-platform-capable" alternative found (it does support both Twitch
  and Kick as platforms), but it is a DIY toolkit, not a turnkey detector —
  its own community has an open feature request ("Native automatic Twitch
  Category") asking Streamer.bot itself to build this natively, which as of
  this research had not shipped.

### What I did not find

- No commercial/paid SaaS competitor.
- No tool advertising a confidence-scored fallback stage for indie/DRM-free
  games (StatusForge's Stage 5 — Engine DNA/fullscreen/window-title/RAM
  weighted scoring, `waterfall.rs:395-420`).
- No tool advertising Proton/Wine process-tree detection for Linux (Stage 4,
  `waterfall.rs:373-393`) or Linux GameMode/Flatpak detection
  (`waterfall.rs:686`).
- No tool advertising simultaneous Twitch + Kick push as a built-in,
  configured-once feature (as opposed to something a user scripts
  themselves in Streamer.bot).
- No tool combining detection + local OBS overlay widgets + a
  multi-source metadata enrichment pipeline in one app.

---

## 2. Platform API Research — Native Category/Game API Matrix

| Platform | Native category/game API? | Evidence / source | Recommended approach for StatusForge |
|---|---|---|---|
| **Twitch** | **Yes** (already implemented — see `pusher.rs`) | Code-verified: `pusher.rs` PATCHes the channel and looks up game IDs via Helix "Get Games"/search. Not re-researched here since it's already shipped and covered in `status-forge-mcp.md`. | Already done. |
| **Kick** | **Yes** (already implemented — see `pusher.rs`) | Code-verified: `pusher.rs` calls `GET /public/v2/categories` for live category search, plus a category-id resolution chain (library → cached `kick_db.json` → live search). Already covered in `status-forge-mcp.md`. | Already done. |
| **YouTube** | **No specific-game field.** YouTube's `videoCategoryId` (via the Data API v3 `videos`/`liveBroadcasts` resources) is a small, fixed set of *broad* content categories — "Gaming" is category ID 20 — not a per-game field comparable to Twitch/Kick's category system. I could not confirm (WebFetch to `developers.google.com` returned 403 in this environment both times attempted) exact update semantics for `liveBroadcasts.update`/`videos.update` while a broadcast is already live — **unconfirmed** whether the broad category or the title/description can be edited mid-broadcast via API; search snippets suggest broadcast *settings* have state-dependent update restrictions but didn't confirm title/category specifically. | Realistic workaround is what the user's own interview material already concluded: a chat-bot announcement of the specific game (YouTube doesn't have a slot to put it in), and/or a stream **title** edit if that is confirmed to work mid-broadcast (would need direct confirmation against Google's docs, which this pass could not fetch directly). |
| **JoystickTV** | **No category-update API found.** I found an official chatbot API (OAuth client-id/secret + WebSocket, with example bots in Ruby/Crystal/JavaScript in the `joysticktv` GitHub org) used for chat messages, and a live-streaming setup guide (RTMP ingest, OBS/Streamlabs instructions, Lovense toy integration) — no mention anywhere of a category/game-metadata write endpoint. | Confirms the user's own ground truth: chat-bot relay is the only integration path found. Matches plan already in `status-forge-mcp.md`/roadmap docs. |
| **Rumble** | **Read-only API; no write/category-update endpoint found.** Rumble's official Live Stream API (`rumble.support/help/how-to-use-rumble-s-live-stream-api`) exposes livestream stats — title, `is_live`, primary/secondary categories, likes, watching-now count, recent chat/rants — as **GET** data for a given user ID + stream key. No POST/PATCH endpoint for setting category or title was found in official docs or the (early-stage, low-adoption) unofficial `rumble-news/rumble-api` GitHub project. | No native push path confirmed. Realistic workaround, if wanted, is the same chat-bot-announcement pattern used for YouTube/JoystickTV — not confirmed as officially documented for Rumble chat, so would need its own small research pass before committing engineering time. Given the interview material already flagged Rumble as "TBD, cap research at 1 week," this finding supports treating it as low-confidence/exploratory rather than a committed near-term platform. |
| **TikTok** | **No official public API for live-stream control at all** (not just category — TikTok has no first-party developer API for live events/chat/metadata; the TikTok Business API covers ads/shop analytics only). The in-app "game category" picker in TikTok LIVE Studio is a manual, UI-only selector. Third-party unofficial libraries (`tiktok-live-connector`, `TikTokLive`, commercial wrappers like Tik.Tools/Euler Stream) exist, but they consume live *events* (chat, gifts, viewer counts) via reverse-engineered WebSocket protocols — none were found offering a way to *set* the category, and building on an unofficial/reverse-engineered protocol carries platform-ToS and stability risk. | No native or even semi-official write path found. A chat-bot approach would itself require building on an unofficial protocol (real risk: TikTok can break or ban this). This is the weakest platform for any automated integration of the four. |

---

## 3. Differentiation / Positioning

**Positioning statement**: StatusForge is a free, open-source desktop app
for solo streamers with no moderators who want their Twitch and Kick
category to always match what they're actually playing — without opening a
dashboard, typing a game name, or delegating it to someone else. It runs
entirely on the streamer's own PC.

### Differentiators (each grounded in code or in the competitive research above)

1. **Multi-source, layered detection — not a single library scan or a
   single Discord-database lookup.** Verified in code: StatusForge's
   detection is a 5-stage-plus-piercer waterfall (listed apps/aliases →
   Xbox/UWP piercer → hard kills → behavioral traps → Steam
   registry/Linux GameMode/Flatpak/Proton-Wine/launcher-parent →
   confidence-weighted fallback scoring) (`forge-detection/src/waterfall.rs`,
   see `status-forge-mcp.md` Detection Pipeline section for full citations).
   By contrast, every comparable tool found in the competitive research uses
   exactly one detection method — a library-folder scan (Game Detector), a
   custom-mapping + Discord-detectable-apps lookup (TwitchAutoCategoryManager),
   or a Steam-only running-process check (ActionBot). None combine multiple
   fallback layers, and none were found to have a scored-confidence path for
   games that are neither in Steam nor in a known-apps database (StatusForge's
   Stage 5, Engine DNA/fullscreen/window-title/RAM weighting — the mechanism
   built specifically for indie and DRM-free games that don't show up in any
   commercial-launcher database).
2. **Linux support with real platform-specific logic, not an afterthought.**
   Verified in code: Steam `registry.vdf` parsing, Feral GameMode detection
   (`gamemoded -s`), Flatpak sandboxed-app detection (`flatpak ps`), and
   Proton/Wine process-tree parent detection all exist as first-class Stage 4
   paths (`waterfall.rs:373-393`, `linux_golden_ticket` at `waterfall.rs:686`).
   None of the competing tools found in this research mention Linux at all —
   every one of them is described as an OBS plugin or Windows-targeted script.
   (Caveat, already flagged in `status-forge-audit.md`: this pass did not
   verify real-world Linux detection *accuracy*, only that the code paths
   exist — don't oversell this until that verification happens.)
3. **Twitch and Kick, both natively, out of the box.** Verified in code:
   `pusher.rs` pushes to both platforms independently with per-platform
   cooldowns, 401 refresh-and-retry, and 429 handling
   (`status-forge-mcp.md` Auto-Push/Broadcast Flow + Error Handling
   sections). Of the competing tools found, all single-purpose detectors are
   Twitch-only (one also does Trovo); the only alternative offering both
   Twitch and Kick automation is Streamer.bot, and only because the user
   hand-builds it themselves with triggers/sub-actions — it is not a
   packaged, configure-once feature there the way it is in StatusForge.
4. **Platform-agnostic chat-bot fallback as a deliberate design, not a gap.**
   The platform matrix in section 2 shows YouTube, JoystickTV, Rumble, and
   TikTok all lack (or, for TikTok, entirely lack any official) a
   programmatic category-write path. A chat-bot announcement is therefore
   not a workaround StatusForge is forced into for lack of trying — it's
   the only mechanism that will work on several of these platforms at all,
   including ones with no official developer API whatsoever (TikTok). Being
   built to operate "wherever a native category API doesn't exist" (per the
   user's own confirmed positioning) is a coherent story precisely because
   the API landscape across non-Twitch/Kick platforms is this fragmented —
   that fragmentation is itself the evidence for the strategy, not asserted
   without support.
5. **A local companion (SPARK) for dual-PC streaming setups.** Verified in
   code: `hub.rs`/`spark_protocol.rs` implement a signed UDP heartbeat
   protocol so a lightweight companion app on a second gaming PC can forward
   detections to the main StatusForge/broadcast PC (`status-forge-mcp.md`
   Architecture Map). None of the competing tools found mention any
   equivalent dual-PC/LAN capability — most assume the game and the OBS/
   broadcast software run on the same machine.

**What I will not claim as a differentiator, and why**: I found no data —
from competitors or otherwise — on detection *accuracy* (false-positive/
false-negative rates) for any tool in this space, including StatusForge
itself. "More accurate" or "more reliable" is not substantiated by anything
found in this research and should not be used in marketing copy unless
StatusForge runs its own accuracy benchmark against at least one named
competitor. Similarly, "privacy-respecting local operation" is a real,
code-verifiable architectural fact (no telemetry/cloud dependency was
identified in the source read underlying `status-forge-mcp.md`), but none of
the competing tools found were confirmed to behave differently on this axis
either — most of them are also local scripts/plugins that don't appear to
phone home. Treat "privacy" as a shared trait among open-source local tools
in this niche, not a unique StatusForge advantage, unless a specific
competitor is confirmed to collect telemetry.

---

## 4. Post-MVP Platform Priority Recommendation

This is a recommendation based on the effort/impact signal in section 2, not
a guarantee — actual priority should still weigh streamer-community demand
signals that this research pass didn't have access to (e.g. Discord/GitHub
issue requests).

**Recommended order: JoystickTV → YouTube → Rumble → TikTok**

1. **JoystickTV first.** Confirmed by the user's own ground truth and
   corroborated here: no category-update API exists, but a well-documented,
   *official*, first-party chatbot API does (OAuth client-id/secret +
   WebSocket, with maintained example bots in three languages in the
   `joysticktv` GitHub org). This is the lowest-risk chat-bot integration to
   build — official support with working reference implementations — and it
   is confirmed needed per the user's stated ground truth, so it directly
   resolves a known requirement rather than a hypothetical one.
2. **YouTube second.** Largest potential audience of the four, and while
   this pass could not fully confirm liveBroadcast update semantics
   (Google's docs 403'd on direct fetch), the existence of a mature,
   official, OAuth-based Data API v3 for the platform is well established,
   and at minimum a title-edit and/or chat-bot relay path is very likely
   buildable. Recommend a short, targeted follow-up research/spike (get
   direct access to `developers.google.com/youtube/v3/live/docs` and test
   against a real broadcast) before committing full engineering time, to
   nail down exactly what "title only" vs. "title + coarse category" the
   API will actually allow live.
3. **Rumble third.** The official API found is read-only (stream stats,
   chat, categories as GET data) with no write endpoint identified in
   official docs or the community wrapper projects. This matches the
   interview material's own framing of Rumble as "TBD, cap research at 1
   week" — nothing in this pass changes that; if a chat-write endpoint
   exists it wasn't surfaced by search, so it would need direct outreach to
   Rumble or a deeper doc dive to even confirm a chat-bot path is possible,
   let alone a category push.
4. **TikTok last / lowest priority.** No official developer API for live
   events at all — every existing integration path in the wider ecosystem
   is an unofficial, reverse-engineered protocol (used by tools like
   `tiktok-live-connector`/`TikTokLive`/Tik.Tools) with attendant ToS and
   stability risk. Recommend not building on this until/unless TikTok ships
   an official live API, or the team is comfortable accepting the
   maintenance and platform-risk burden of an unofficial integration.

---

## Sources

- [Current Game Toggle | Streamer.bot Docs](https://docs.streamer.bot/faq/current-game-toggle)
- [Automatically Change Game Category On Twitch! - YouTube](https://www.youtube.com/watch?v=qGp5mp4BAHA)
- [Stream Update | Streamer.bot Wiki](https://wiki.streamer.bot/en/Platforms/Twitch/Events/Stream-Update)
- [Stream Update | Streamer.bot Docs](https://docs.streamer.bot/api/triggers/twitch/general/stream-update)
- [Native automatic Twitch Category · Streamer.bot Ideas and Suggestions](https://ideas.streamer.bot/posts/977/native-automatic-twitch-category)
- [Set Channel Game | Streamer.bot Docs](https://docs.streamer.bot/api/sub-actions/twitch/channel/set-channel-game)
- [Robus Twitch Category Changer - Streamer.bot Extensions](https://extensions.streamer.bot/t/robus-twitch-category-changer/1804)
- [Auto Twitch Category 4 - OBS Forums](https://obsproject.com/forum/threads/auto-twitch-category.184094/)
- [GitHub - Troyo26/TwitchAutoCategoryManager](https://github.com/Troyo26/TwitchAutoCategoryManager)
- [Twitch Auto Category Manager | OBS Forums](https://obsproject.com/forum/threads/twitch-auto-category-manager.191535/)
- [Game Detector | OBS Forums](https://obsproject.com/forum/resources/game-detector.2260/) (search-snippet only; direct fetch 403'd — medium confidence)
- [OBS Python - Twitch Auto Category Manager | OBS Forums](https://obsproject.com/forum/resources/twitch-auto-category-manager.2244/)
- [GitHub - Sno0t/obs-twitch-auto-category-lua](https://github.com/Sno0t/obs-twitch-auto-category-lua)
- [GitHub - BOLL7708/ActionBot](https://github.com/BOLL7708/ActionBot)
- [Kick | Streamer.bot Docs — Channel Update trigger](https://docs.streamer.bot/api/triggers/kick/general/channel-update)
- [GitHub - Sehelitar/Kick.bot](https://github.com/Sehelitar/Kick.bot)
- [YouTube Live Streaming API Overview | Google for Developers](https://developers.google.com/youtube/v3/live/getting-started)
- [API Reference | YouTube Live Streaming API | Google for Developers](https://developers.google.com/youtube/v3/live/docs) (403'd on direct fetch in this environment; content via search snippets only)
- [youtube api video category id list · GitHub Gist](https://gist.github.com/dgp/1b24bf2961521bd75d6c)
- [Rumble's Live Stream API — official docs](https://rumble.support/help/how-to-use-rumble-s-live-stream-api) (403'd on direct fetch; content via search snippets only)
- [GitHub - rumble-news/rumble-api](https://github.com/rumble-news/rumble-api)
- [GitHub - thelabcat/rumble-api-wrapper-py (cocorum)](https://github.com/thelabcat/rumble-api-wrapper-py)
- [joysticktv.github.io/live_streaming.md](https://github.com/joysticktv/joysticktv.github.io/blob/main/live_streaming.md)
- [GitHub - joysticktv/bot-example-ruby](https://github.com/joysticktv/bot-example-ruby)
- [GitHub - joysticktv/bot-example-crystal](https://github.com/joysticktv/bot-example-crystal)
- [GitHub - joysticktv/bot-example-javascript](https://github.com/joysticktv/bot-example-javascript)
- [GitHub - joysticktv/chatterbot](https://github.com/joysticktv/chatterbot)
- [Joystick.tv Platform Support · Streamer.bot Ideas and Suggestions](https://ideas.streamer.bot/posts/939/joystick-tv-platform-support)
- [TikTok Live API landscape — tik.tools](https://tik.tools/)
- [Explore TikTok's Developer Solutions and Integrations](https://developers.tiktok.com/)
- [GitHub - tiktool/tiktok-live-api](https://github.com/tiktool/tiktok-live-api)
- [GitHub - zerodytrash/TikTok-Live-Connector](https://github.com/zerodytrash/TikTok-Live-Connector)
- [GitHub - isaackogan/TikTokLive](https://github.com/isaackogan/TikTokLive)
- [How to Pick What Game You Are Playing on TikTok Live | TikTok Help](https://www.tiktok.com/discover/how-to-pick-what-game-you-are-playing-on-tiktok-live)

---

## Confidence & Gaps

**Solid / high confidence:**
- The list of Twitch-only auto-category tools (TwitchAutoCategoryManager,
  ActionBot, the Lua/script variants) and their single-platform,
  single-detection-method nature — corroborated across multiple independent
  sources (GitHub READMEs, OBS forum listings).
- JoystickTV has an official chatbot API but no category-write API found —
  corroborated by both the official live-streaming guide (no API mentioned)
  and the separate, official `joysticktv` GitHub org's chatbot examples
  (API exists, scoped to chat only).
- TikTok has no official live-streaming developer API at all — corroborated
  by multiple independent sources describing every existing integration as
  unofficial/reverse-engineered.
- Rumble's official API is documented as read-only stream data — corroborated
  by the official support article's described field list (title, is_live,
  categories, chat) with no write/update endpoint appearing anywhere in
  search results or the unofficial wrapper projects.
- StatusForge's own capabilities cited here (detection waterfall stages,
  Twitch/Kick push, Linux-specific logic, SPARK companion) — all previously
  code-verified with file:line citations in `status-forge-mcp.md`, not
  re-derived here.

**Medium confidence / worth a follow-up pass:**
- The Game Detector OBS plugin's exact feature list — the forum page 403'd
  on direct fetch, so its description here comes from search-engine
  snippets, not a first-hand read of the listing. Confirm directly before
  quoting specifics (e.g. the "<5s detection" claim) in any external-facing
  material.
- YouTube's exact liveBroadcast/video update semantics while a stream is
  already live (which fields can change mid-broadcast) — Google's developer
  docs pages 403'd on every direct-fetch attempt in this environment. What's
  confirmed is that `videoCategoryId` is a broad content-category enum
  (Gaming = category 20) rather than a per-game field; what's **not**
  confirmed is whether even the coarse category or the stream title can be
  edited via API after a broadcast has gone live. This should be re-verified
  against Google's docs directly (or empirically, against a real test
  broadcast) before committing to a specific YouTube integration design.

**Explicitly not attempted / out of scope for this pass, flagged rather than guessed:**
- No accuracy/reliability data was gathered for any competitor or for
  StatusForge itself — see the explicit non-claim in section 3.
- No pricing research was needed/found since every competitor identified is
  free and open-source; if a paid competitor exists it was not surfaced by
  this search.
- This is not an exhaustive market survey — absence of a competitor in this
  document means "not found by this search pass," not "confirmed not to
  exist."
