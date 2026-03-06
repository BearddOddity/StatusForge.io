# ⚒️ StatusForge.io
**The Ultimate Rich Presence Engine for Content Creators**

StatusForge is a secure, local-first desktop application that automatically detects the game or software you are currently running and instantly pushes high-quality metadata to your live stream and OBS overlays. 

Built for content creators who frequently switch games or play obscure indie titles, StatusForge pulls dynamic data (cover art, developer, release year, and genre) and routes it directly to Twitch, Kick, or your local Streamer.bot instance.

---

## ✨ Core Features
* 🎮 **Auto-Detection:** Silently monitors system processes to detect when a game launches or closes.
* 📡 **Automated Category Sync:** Pushes game updates directly to your Twitch and Kick channels the moment you launch a game.
* 🎨 **Dynamic OBS Widgets:** Generates sleek, real-time web overlays displaying your current game's title, cover art, and session time.
* ⚒️ **The Forge (Custom Database):** Manually override missing API data, exile apps from tracking, and save it all to a single, unified `Forge_Database.json` file.
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
StatusForge uses a 6-tier waterfall system of APIs. Most of them (Steam, IGDB, GOG, Itch.io) are completely free and require no setup!
1. Navigate to the **🗝️ API Keys** tab.
2. Enter a **SteamGridDB API Key** (Primary Cover Art Engine). 
3. *(Optional)* Enter a **RAWG API Key** as a deep fallback for incredibly obscure titles.
4. Click **Save API Config**. 

### 3. Routing (Connecting to Your Stream)
Navigate to the **♾️ Routing** tab. This tells StatusForge where to send your game updates. You have two choices:

* **Option A: StatusForge Native (Recommended)**
  * *Best for:* Creators who want a direct, secure connection to Twitch and Kick.
  * *Setup:* Generate your App credentials at the **[Twitch Console](https://dev.twitch.tv/console)** and **[Kick Developer Portal](https://kick.com/settings/developer)**. Enter your Client ID and Secret in StatusForge. 
  * *(Note: Kick also requires your numeric Channel ID. To find it, visit `https://kick.com/api/v1/channels/YOUR_USERNAME` in your browser and copy the first `"id"` number).*
  * Click **Save Broadcast Config**, and then click the **CONNECT** buttons to securely authorize your accounts via OAuth2. 
* **Option B: Streamer.bot (Advanced)**
  * *Best for:* Power users who want to trigger local OBS scene changes or complex macros when a game changes.
  * *Setup:* Ensure your Streamer.bot HTTP Server is running. Enter the port (default is `8080`) and StatusForge will route all category updates directly into your local bot.

### 4. The Forge (Customizing Your Games)
Sometimes you play a game before it exists on public databases, or you want to hide a specific application. That is what **⚒️ The Forge** is for.

* **To Override a Game:** Type the exact name of the application process. You can then paste a custom image URL for the cover art, change the genre, or manually link the exact Twitch/Kick Category IDs. Click **LOCK INTO THE FORGE** to save this to your `Forge_Database.json`.
* **To Hide an Application:** Type the process name and click **💀 EXILE APPLICATION**. It will never be tracked again.

### 5. Adding the OBS Overlay
1. Go to the **⏳ Status Room**.
2. Under "Overlay Generator", select your preferred layout.
3. Click **GET URL** and copy the secure local link.
4. Open OBS, add a new **Browser Source**, paste the URL, and your overlay is live!

---

## 🧠 Under the Hood: The 6-Tier API Waterfall
StatusForge taps into a massive web of public and private APIs to keep your stream updated. To ensure maximum accuracy and preserve API rate limits, the Engine cascades through this exact sequence:

1. **Steam Storefront:** The primary scraper for core game metadata (Developer, Publisher, Release Year).
2. **SteamGridDB API:** The absolute king of vertical "Box Art." Overrides the cover image with community-voted 600x900 high-fidelity posters.
3. **IGDB API (Twitch):** Fills in any missing metadata and runs a custom **Bundle Breaker** to allow users to select specific games from Trilogies and Compilations.
4. **GOG Catalog:** Secondary PC fallback for DRM-free titles.
5. **Itch.io Web Scraper:** A custom silent scraper that hunts down cover art and developer names specifically for obscure indie games.
6. **RAWG API:** The "Deep Fallback" safety net used only if the previous 5 engines fail.
7. **Twitch & Kick Resolvers:** Finally, the engine maps the perfected metadata to the exact numeric IDs required to update your live stream categories.

---
*Forged by BearddOddity*