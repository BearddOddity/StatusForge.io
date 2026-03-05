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

* **To Override a Game:** Type the exact name of the application process. You can then paste a custom image URL for the cover art, change the genre, or manually link the exact Twitch/Kick Category IDs. Click **LOCK INTO THE FORGE** to permanently save this to your local database.
* **To Hide an Application:** If StatusForge keeps detecting a background program you don't want on stream, type its name and click **💀 EXILE APPLICATION**. It will never be tracked again.

### 5. Adding the OBS Overlay
1. Go to the **⏳ Status Room**.
2. Under "Overlay Generator", select your preferred layout (Horizontal or Vertical).
3. Click **GET URL**. 
4. Copy the secure local URL, open OBS, and add a new **Browser Source**. Paste the URL, set the dimensions to match your layout, and your overlay is live!

---

### 🛑 Safe Mode & Manual Controls
Need to test a game off-stream? Go to the **Routing** tab and toggle **Testing Mode / Off-Stream Gaming** to `ON`. StatusForge will continue to generate your OBS overlays and track your session, but it will physically block the API from pushing the category to your live Twitch/Kick channels.

---
*Forged by BearddOddity*
