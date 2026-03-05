# ⚒️ StatusForge.io
**The Ultimate Rich Presence Engine for Content Creators**

StatusForge is a secure, local-first desktop application that automatically detects the game or software you are currently running and instantly pushes high-quality metadata to your live stream and OBS overlays. 

Built for content creators who frequently switch games or play obscure indie titles, StatusForge pulls dynamic data (cover art, developer, release year, and genre) and routes it directly to Twitch, Kick, or your local Streamer.bot instance.

---

## ✨ Core Features
* 🎮 **Auto-Detection:** Silently monitors system processes to detect when a game launches or closes.
* 📡 **Automated Category Sync:** Pushes game updates directly to your Twitch and Kick channels the moment you launch a game.
* 🎨 **Dynamic OBS Widgets:** Generates sleek, real-time web overlays displaying your current game's title, cover art, and session time.
* ⚒️ **The Forge (Custom Database):** Manually override missing API data or upload custom cover art for unlisted/indie games.
* ☁️ **Over-The-Air Updates:** Built-in cloud updater ensures you always have the latest engine features.

---

## 🚀 The Setup Guide

### 1. Installation
1. Head over to the **[Releases](../../releases/latest)** page on the right side of this repository.
2. Download the installer for your system:
   * **Windows:** `StatusForge.io Setup.exe` *(Note: Windows Defender may flag this as an unrecognized app since it is new. Click "More Info" -> "Run Anyway" to bypass).*
   * **Mac:** `StatusForge.io.dmg`
   * **Linux:** `StatusForge.io.AppImage`
3. Launch the app. The engine will ignite and open the Status Room dashboard.

### 2. Setting Up Your API Keys (The Brains)
To pull high-quality cover art and game data, StatusForge uses a waterfall system of APIs.
1. Navigate to the **🗝️ API Keys** tab.
2. Enter a **RAWG API Key** (You can get one for free at rawg.io). This is the primary engine used to pull cover art and release dates.
3. Click **Save API Config**. *(Note: Steam, GOG, and IGDB fallback engines are already built-in and will activate automatically if RAWG misses a game!)*

### 3. Routing (Connecting to Your Stream)
Navigate to the **♾️ Routing** tab. This tells StatusForge where to send your game updates. You have two choices:

* **Option A: StatusForge Native (Recommended)**
  * *Best for:* Creators who want a direct, secure connection to Twitch and Kick.
  * *Setup:* Enter your Twitch and Kick Developer App credentials (Client ID and Secret). Click **Save Broadcast Config**, and then click the **CONNECT** buttons to securely authorize your accounts via OAuth2. 
* **Option B: Streamer.bot (Advanced)**
  * *Best for:* Power users who want to trigger local OBS scene changes or complex macros when a game changes.
  * *Setup:* Ensure your Streamer.bot HTTP Server is running. Enter the port (default is `8080`) and StatusForge will route all category updates directly into your local bot.

### 4. The Forge (Customizing Your Games)
Sometimes you play a game before it exists on public databases, or you want to hide a specific application. That is what **⚒️ The Forge** is for.

* **To Override a Game:** Type the exact name of the application process. You can then paste a custom image URL for the cover art, change the genre, or manually link the exact Twitch/Kick Category IDs. Click **LOCK INTO THE FORGE** to permanently save this to your local Listed Apps database.
* **To Hide an Application:** If StatusForge keeps detecting a background program you don't want on stream, type its name and click **💀 EXILE APPLICATION**. It will be sent to your Delisted Apps and never be tracked again.

### 5. Adding the OBS Overlay
1. Go to the **⏳ Status Room**.
2. Under "Overlay Generator", select your preferred layout (Horizontal or Vertical).
3. Click **GET URL**. 
4. Copy the secure local URL, open OBS, and add a new **Browser Source**. Paste the URL, set the dimensions to match your layout, and your overlay is live!

---

## 🛑 Safe Mode & Manual Controls
Need to test a game off-stream? Go to the **Routing** tab and toggle **Testing Mode / Off-Stream Gaming** to `ON`. StatusForge will continue to generate your OBS overlays and track your session, but it will physically block the API from pushing the category to your live Twitch/Kick channels.

---

## 🧠 Under the Hood: The API Waterfall
StatusForge taps into a massive web of public and private APIs to keep your stream updated. If you are a developer looking to understand how the engine pulls and pushes data, here is the breakdown:

### 🟢 Kick API (Public Frontend Routes)
Because Kick's official developer portal requires a registered App, StatusForge uses their public website endpoints to silently pull live data.
* **Official Developer Portal:** `https://dev.kick.com/`
* **The Core Endpoint:** `GET https://kick.com/api/v1/channels/{username}`
  * *What we look for:* Returns a massive JSON payload. We extract the `"id"` (the numeric Channel ID required by the backend to push updates), the `"user_id"`, the direct `"playback_url"` (.m3u8), and `"recent_livestream.categories.category_id"` to silently check the current category.
* **Secondary Endpoint:** `GET https://api.kick.com/public/v1/categories?q={game_title}`
  * *What we look for:* Used to fuzzy-search the numeric ID of a game so we can push it to the channel.

### 🟣 Twitch API (Helix)
Twitch has the most heavily documented and strictly enforced API. You absolutely must have an OAuth2 Bearer token to talk to it.
* **API Documentation:** `https://dev.twitch.tv/docs/api/reference`
* **The Metadata Endpoint:** `GET https://api.twitch.tv/helix/search/categories?query={game_title}`
  * *What we look for:* Extracts the `"id"` (e.g., `509658` for Just Chatting) and the official `"name"`. Twitch rejects updates if you send a text string instead of the exact numeric ID.
* **The Pushing Endpoint:** `PATCH https://api.twitch.tv/helix/channels?broadcaster_id={broadcaster_id}`

### 🟠 RAWG Video Games Database API
RAWG is the ultimate open-source database for pulling rich metadata and is the backbone of StatusForge's visual flair.
* **API Documentation:** `https://rawg.io/apidocs`
* **The Core Endpoint:** `GET https://api.rawg.io/api/games?key={your_key}&search={game_title}`
  * *What we look for:* Extracts `"background_image"` for stunning 16:9 cinematic wallpapers (used in the OBS widgets), `"released"` (to slice off the release year), `"genres[0].name"`, and `"developers[0].name"`.

### 🔵 SteamGridDB API
While RAWG is great for 16:9 wallpapers, SteamGridDB is the absolute king of finding 600x900 vertical "Box Art" (the standard poster size used on Twitch).
* **API Documentation:** `https://www.steamgriddb.com/api/v2`
* **The Core Endpoints:** 1. `GET /api/v2/search/autocomplete/{game_title}` (Finds the game's internal GridDB ID).
  2. `GET /api/v2/grids/game/{game_id}` (Pulls the actual artwork).
  * *What we look for:* Extracts `"data[0].url"` to pull the direct image URL of the highest-voted vertical cover art submitted by the community, ensuring perfect fit for vertical OBS layouts.

---
*Forged by BearddOddity*
