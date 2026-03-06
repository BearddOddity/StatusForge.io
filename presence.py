import sys, subprocess, platform, os, io, re

# === CORE ENCODING FIX ===
if sys.platform == 'win32':
    if sys.stdout is not None: sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    if sys.stderr is not None: sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# === STATUSFORGE AUTO-BOOTLOADER ===
def forge_bootstrap():
    if getattr(sys, 'frozen', False): return
    required_libs = ["flask", "flask-cors", "requests", "psutil"]
    try: import flask, flask_cors, requests, psutil
    except ImportError as e:
        print(f"\n[StatusForge] ⚠️ Missing dependency detected: {e.name}")
        print("[StatusForge] 🛠️ Auto-repair initiated. Forging components...")
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install"] + required_libs)
            print("[StatusForge] ✅ Components forged successfully. Rebooting Engine...\n")
            os.execv(sys.executable, [sys.executable] + sys.argv)
        except Exception as repair_err:
            print(f"\n[StatusForge] 💀 FATAL: Auto-repair failed. Error: {repair_err}")
            sys.exit(1)
forge_bootstrap()

# === CORE SETUP & GLOBALS ===
import psutil, time, threading, json, logging, secrets, ctypes, webbrowser, difflib, hashlib, base64
import urllib.request, urllib.parse, urllib.error, requests
from logging.handlers import RotatingFileHandler
from flask import Flask, jsonify, request, send_from_directory, redirect
from flask_cors import CORS
from functools import wraps

if getattr(sys, 'frozen', False): BASE_DIR = os.path.dirname(sys.executable)
else: BASE_DIR = os.path.dirname(os.path.abspath(__file__))

LAYOUTS_DIR = os.path.join(BASE_DIR, 'layouts') 
CURRENT_OS = platform.system()

# === SMART LOGGING & ANTI-SPAM ===
LOG_PATH = os.path.join(BASE_DIR, 'debug.log')
log_handler = RotatingFileHandler(LOG_PATH, maxBytes=1024 * 1024, backupCount=1)
logging.basicConfig(handlers=[log_handler], level=logging.INFO, format='%(asctime)s | %(message)s', datefmt='%H:%M:%S')

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": ["http://127.0.0.1:5050", "http://localhost:5050"]}})

class NoSpamFilter(logging.Filter):
    def filter(self, record):
        msg = record.getMessage()
        if ('GET /status' in msg or 'GET /logs' in msg) and ' 200 ' in msg: return False
        return True
logging.getLogger('werkzeug').addFilter(NoSpamFilter())
logging.getLogger('werkzeug').setLevel(logging.ERROR)

error_cooldowns = {}
def log_smart(message, level="info", cooldown=60):
    current_time = time.time()
    if cooldown > 0:
        if message in error_cooldowns and (current_time - error_cooldowns[message]) < cooldown: return 
        error_cooldowns[message] = current_time
    if level == "warning": logging.warning(message)
    elif level == "error": logging.error(message)
    elif level == "info": logging.info(message)

# === CONFIG & STATE ===
status_data = {"is_playing": False, "game_title": "System Initializing...", "process_name": "", "start_time": 0, "cover_url": "", "release_date": "", "genre": "", "publisher": "", "developer": "", "last_pulse": 0, "pending_bundle": False, "bundle_options": []}
broadcast_status = {"twitch": "STANDBY", "kick": "STANDBY", "streamer_bot": "STANDBY"}
pkce_vault = {} 
meta_lock = threading.Lock() 

FORGE_DB_PATH = os.path.join(BASE_DIR, "Forge_Database.json")
CONFIG_PATH = os.path.join(BASE_DIR, "Config.json") 
KICK_DB_PATH = os.path.join(BASE_DIR, "kick_db.json")
TOKEN_PATH = os.path.join(BASE_DIR, "Widget_Token.txt")

KICK_AUTH_URL, KICK_TOKEN_URL, KICK_REDIRECT_URI = "https://id.kick.com/oauth/authorize", "https://id.kick.com/oauth/token", "http://localhost:5050/kick/callback"
TWITCH_AUTH_URL, TWITCH_TOKEN_URL, TWITCH_REDIRECT_URI = "https://id.twitch.tv/oauth2/authorize", "https://id.twitch.tv/oauth2/token", "http://localhost:5050/twitch/callback"

if not os.path.exists(TOKEN_PATH):
    with open(TOKEN_PATH, 'w') as f: f.write(secrets.token_urlsafe(16))
with open(TOKEN_PATH, 'r') as f: WIDGET_TOKEN = f.read().strip()

# === SECURITY CHECKPOINT ===
def require_local_auth(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if request.method == 'OPTIONS': return jsonify({"status": "success"}), 200
        token = request.headers.get('X-Forge-Token')
        if not token or token != WIDGET_TOKEN:
            log_smart(f"[SECURITY] Blocked unauthorized request to {request.path}. (If using OBS, right-click the Browser Source and select 'Refresh cache of current page')", "warning", 30)
            return jsonify({"status": "error", "error_code": "ENGINE_LOCKOUT", "message": "Access Denied."}), 401 
        return f(*args, **kwargs)
    return decorated_function

# === DATABASE MIGRATION & FILE MANAGEMENT ===
def load_json(path, default):
    try:
        if not os.path.exists(path):
            with open(path, 'w') as f: json.dump(default, f, indent=4)
        with open(path, 'r') as f: return json.load(f)
    except Exception as e:
        log_smart(f"[DATABASE ERROR] Failed to read {os.path.basename(path)}: {str(e)}", "error", 60)
        return default

def save_json(path, data):
    try:
        # sort_keys=True ensures the JSON is perfectly ordered for GitHub diffing!
        with open(path, 'w') as f: json.dump(data, f, indent=4, sort_keys=True)
    except Exception as e: log_smart(f"[DATABASE ERROR] Failed to save {os.path.basename(path)}: {str(e)}", "error", 60)

# Auto-migrate legacy files to new single unified Forge Database
LEGACY_VAULT = os.path.join(BASE_DIR, "vault.json")
LEGACY_META = os.path.join(BASE_DIR, "Custom_Meta.json")
if os.path.exists(LEGACY_VAULT) or os.path.exists(LEGACY_META):
    log_smart("[SYSTEM] Legacy databases detected. Auto-migrating to unified Forge_Database.json...", "info", 0)
    old_vault = load_json(LEGACY_VAULT, {"listed_apps": {}, "delisted_apps": []})
    old_meta = load_json(LEGACY_META, {})
    migrated_db = {
        "exiled_apps": old_vault.get("delisted_apps", []),
        "process_map": old_vault.get("listed_apps", {}),
        "library": old_meta
    }
    save_json(FORGE_DB_PATH, migrated_db)
    try:
        if os.path.exists(LEGACY_VAULT): os.remove(LEGACY_VAULT)
        if os.path.exists(LEGACY_META): os.remove(LEGACY_META)
        log_smart("[SYSTEM] Migration complete. Legacy fragments cleaned up.", "info", 0)
    except: pass

DEFAULT_FORGE_DB = {"exiled_apps": [], "process_map": {}, "library": {}}
load_json(FORGE_DB_PATH, DEFAULT_FORGE_DB)

DEFAULT_CONFIG = {
    "api_keys": {"steamgrid": "", "rawg": "", "igdb_client": "", "igdb_secret": "", "igdb_token": ""},
    "engine_settings": {"idle_category": "Just Chatting", "sb_port": 8080, "scan_interval": 5, "widget_poll_rate": 3, "safe_mode": False, "auto_push": False, "widget_fade_timer": 15},
    "broadcaster": {"routing_mode": "streamer_bot", "twitch_client": "", "twitch_secret": "", "twitch_token": "", "twitch_refresh": "", "twitch_broadcaster_id": "", "kick_client": "", "kick_secret": "", "kick_channel_id": "", "kick_token": "", "kick_refresh": ""}
}
load_json(CONFIG_PATH, DEFAULT_CONFIG)

def update_meta_field(game_title, field, value):
    with meta_lock:
        db = load_json(FORGE_DB_PATH, DEFAULT_FORGE_DB)
        vault_key = game_title.lower().strip()
        if vault_key not in db["library"]: db["library"][vault_key] = {"title": game_title, "genre": "", "release_year": "", "developer": "", "publisher": "", "twitch_id": "", "kick_id": "", "cover_url": "", "igdb_id": ""}
        db["library"][vault_key][field] = value
        save_json(FORGE_DB_PATH, db)

# === BACKUP ENDPOINTS ===
@app.route('/export-config', methods=['GET', 'OPTIONS'])
@require_local_auth
def export_config():
    log_smart("[SYSTEM] User exported Engine Configuration Backup.", "info", 0)
    return jsonify(load_json(CONFIG_PATH, DEFAULT_CONFIG))

@app.route('/import-config', methods=['POST', 'OPTIONS'])
@require_local_auth
def import_config():
    try:
        raw_data = request.json
        if not isinstance(raw_data, dict): return jsonify({"status": "error", "message": "Payload must be a JSON object."}), 400
        if "engine_settings" not in raw_data or "broadcaster" not in raw_data: return jsonify({"status": "error", "message": "Missing core config sections."}), 400

        safe_config = {
            "api_keys": {
                "steamgrid": str(raw_data.get("api_keys", {}).get("steamgrid", "")),
                "rawg": str(raw_data.get("api_keys", {}).get("rawg", "")),
                "igdb_client": str(raw_data.get("api_keys", {}).get("igdb_client", "")),
                "igdb_secret": str(raw_data.get("api_keys", {}).get("igdb_secret", "")),
                "igdb_token": str(raw_data.get("api_keys", {}).get("igdb_token", ""))
            },
            "engine_settings": {
                "idle_category": str(raw_data["engine_settings"].get("idle_category", "Just Chatting"))[:100],
                "sb_port": int(raw_data["engine_settings"].get("sb_port", 8080)),
                "scan_interval": int(raw_data["engine_settings"].get("scan_interval", 5)),
                "widget_poll_rate": int(raw_data["engine_settings"].get("widget_poll_rate", 3)),
                "safe_mode": bool(raw_data["engine_settings"].get("safe_mode", False)),
                "auto_push": bool(raw_data["engine_settings"].get("auto_push", False)),
                "widget_fade_timer": int(raw_data["engine_settings"].get("widget_fade_timer", 15))
            },
            "broadcaster": {
                "routing_mode": str(raw_data["broadcaster"].get("routing_mode", "streamer_bot")),
                "twitch_client": str(raw_data["broadcaster"].get("twitch_client", "")), "twitch_secret": str(raw_data["broadcaster"].get("twitch_secret", "")),
                "twitch_token": str(raw_data["broadcaster"].get("twitch_token", "")), "twitch_refresh": str(raw_data["broadcaster"].get("twitch_refresh", "")),
                "twitch_broadcaster_id": str(raw_data["broadcaster"].get("twitch_broadcaster_id", "")),
                "kick_client": str(raw_data["broadcaster"].get("kick_client", "")), "kick_secret": str(raw_data["broadcaster"].get("kick_secret", "")),
                "kick_channel_id": str(raw_data["broadcaster"].get("kick_channel_id", "")),
                "kick_token": str(raw_data["broadcaster"].get("kick_token", "")), "kick_refresh": str(raw_data["broadcaster"].get("kick_refresh", ""))
            }
        }
        save_json(CONFIG_PATH, safe_config)
        log_smart("[SYSTEM] Engine configuration securely restored from backup file.", "info", 0)
        return jsonify({"status": "success"})
    except Exception as e: return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/export-meta', methods=['GET', 'OPTIONS'])
@require_local_auth
def export_meta():
    log_smart("[SYSTEM] User exported Unified Forge Database Backup.", "info", 0)
    return jsonify(load_json(FORGE_DB_PATH, DEFAULT_FORGE_DB))

@app.route('/import-meta', methods=['POST', 'OPTIONS'])
@require_local_auth
def import_meta():
    try:
        raw_data = request.json
        if not isinstance(raw_data, dict) or "library" not in raw_data:
            return jsonify({"status": "error", "message": "Invalid database format."}), 400
        
        safe_db = {
            "exiled_apps": [str(x)[:150] for x in raw_data.get("exiled_apps", [])],
            "process_map": {str(k)[:150]: str(v)[:150] for k, v in raw_data.get("process_map", {}).items()},
            "library": {}
        }
        
        for k, v in raw_data["library"].items():
            if isinstance(v, dict):
                safe_db["library"][str(k)] = {
                    "title": str(v.get("title", ""))[:150], "genre": str(v.get("genre", ""))[:100], "release_year": str(v.get("release_year", ""))[:10],
                    "developer": str(v.get("developer", ""))[:100], "publisher": str(v.get("publisher", ""))[:100], "twitch_id": str(v.get("twitch_id", ""))[:50],
                    "kick_id": str(v.get("kick_id", ""))[:50], "cover_url": str(v.get("cover_url", "")), "igdb_id": str(v.get("igdb_id", ""))[:50]
                }

        with meta_lock: save_json(FORGE_DB_PATH, safe_db)
        log_smart("[SYSTEM] The Forge database securely restored from unified backup file.", "info", 0)
        return jsonify({"status": "success"})
    except Exception as e: return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/download-logs', methods=['GET', 'OPTIONS'])
@require_local_auth
def download_logs():
    try:
        log_smart("[SYSTEM] User downloaded terminal log history.", "info", 0)
        with open(LOG_PATH, 'r', encoding='utf-8') as f: return jsonify({"logs": f.read()})
    except Exception as e: return jsonify({"status": "error", "message": str(e)}), 500

# === MASTER CATEGORY SYNCING ===
def sync_kick_database():
    config = load_json(CONFIG_PATH, DEFAULT_CONFIG)
    token = config.get("broadcaster", {}).get("kick_token", "")
    if not token: return
    try:
        log_smart("[KICK SYNC] Downloading Kick V2 Category Database...", "info", 3600)
        res = requests.get("https://api.kick.com/public/v2/categories?limit=1000", headers={"Authorization": f"Bearer {token}", "Accept": "application/json"}, timeout=10)
        if res.status_code == 200:
            data = res.json()
            categories = data.get('data', []) if isinstance(data, dict) else (data if isinstance(data, list) else [])
            kick_map = {cat['name']: cat['id'] for cat in categories if 'name' in cat and 'id' in cat}
            if kick_map: save_json(KICK_DB_PATH, kick_map); log_smart(f"[KICK SYNC] Master Database successfully forged with {len(kick_map)} categories.", "info", 3600)
    except Exception as e: log_smart(f"[KICK SYNC ERROR] Network failure downloading master database: {str(e)}", "warning", 300)

def keep_kick_db_synced():
    while True:
        sync_kick_database()
        time.sleep(43200)

# === SMART TOKEN MANAGEMENT (OAUTH2) === 
def generate_pkce_pair():
    verifier = base64.urlsafe_b64encode(os.urandom(40)).decode('utf-8').rstrip('=')
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode('utf-8')).digest()).decode('utf-8').rstrip('=')
    return verifier, challenge

def refresh_kick_token():
    config = load_json(CONFIG_PATH, DEFAULT_CONFIG)
    bc = config.get("broadcaster", {})
    client_id, client_secret, refresh_token = bc.get("kick_client"), bc.get("kick_secret"), bc.get("kick_refresh")
    if not all([client_id, client_secret, refresh_token]): return False
    try:
        res = requests.post(KICK_TOKEN_URL, data={"grant_type": "refresh_token", "client_id": client_id, "client_secret": client_secret, "refresh_token": refresh_token}, timeout=5)
        if res.status_code == 200:
            data = res.json()
            config["broadcaster"]["kick_token"], config["broadcaster"]["kick_refresh"] = data["access_token"], data.get("refresh_token", refresh_token)
            save_json(CONFIG_PATH, config)
            log_smart("[OAUTH] Kick connection tokens successfully refreshed.", "info", 0)
            return data["access_token"]
        else: log_smart(f"[AUTH ALERT] Kick token refresh rejected (HTTP {res.status_code}). Please reconnect your Kick App.", "error", 300)
    except Exception as e: log_smart(f"[AUTH ALERT] Kick token refresh connection failed: {str(e)}", "warning", 60)
    return False

def refresh_twitch_token():
    config = load_json(CONFIG_PATH, DEFAULT_CONFIG)
    bc = config.get("broadcaster", {})
    client_id, client_secret, refresh_token = bc.get("twitch_client"), bc.get("twitch_secret"), bc.get("twitch_refresh")
    if not all([client_id, client_secret, refresh_token]): return False
    try:
        res = requests.post(TWITCH_TOKEN_URL, data={"grant_type": "refresh_token", "client_id": client_id, "client_secret": client_secret, "refresh_token": refresh_token}, timeout=5)
        if res.status_code == 200:
            data = res.json()
            config["broadcaster"]["twitch_token"], config["broadcaster"]["twitch_refresh"] = data["access_token"], data.get("refresh_token", refresh_token)
            save_json(CONFIG_PATH, config)
            log_smart("[OAUTH] Twitch connection tokens successfully refreshed.", "info", 0)
            return data["access_token"]
        else: log_smart(f"[AUTH ALERT] Twitch token refresh rejected (HTTP {res.status_code}). Please reconnect your Twitch App.", "error", 300)
    except Exception as e: log_smart(f"[AUTH ALERT] Twitch token refresh connection failed: {str(e)}", "warning", 60)
    return False

# === OAUTH ROUTES ===
@app.route('/kick/login')
def kick_login():
    config = load_json(CONFIG_PATH, DEFAULT_CONFIG)
    client_id = config.get("broadcaster", {}).get("kick_client", "")
    if not client_id: return "Error: Save Kick Client ID in dashboard first.", 400
    verifier, challenge = generate_pkce_pair()
    state_token = secrets.token_urlsafe(16)
    pkce_vault['verifier'] = verifier
    pkce_vault['state'] = state_token
    scopes = urllib.parse.quote("user:read channel:write")
    return redirect(f"{KICK_AUTH_URL}?response_type=code&client_id={client_id}&redirect_uri={urllib.parse.quote(KICK_REDIRECT_URI)}&state={state_token}&code_challenge={challenge}&code_challenge_method=S256&scope={scopes}")

@app.route('/kick/callback')
def kick_callback():
    config = load_json(CONFIG_PATH, DEFAULT_CONFIG)
    bc = config.get("broadcaster", {})
    if request.args.get('state') != pkce_vault.get('state'): return "Security Error.", 403
    payload = {"grant_type": "authorization_code", "client_id": bc.get("kick_client", ""), "client_secret": bc.get("kick_secret", ""), "redirect_uri": KICK_REDIRECT_URI, "code": request.args.get('code'), "code_verifier": pkce_vault.get('verifier', '')}
    res = requests.post(KICK_TOKEN_URL, data=payload)
    if res.status_code == 200:
        data = res.json()
        config["broadcaster"]["kick_token"], config["broadcaster"]["kick_refresh"] = data["access_token"], data.get("refresh_token", "")
        save_json(CONFIG_PATH, config)
        log_smart("[OAUTH] Native Kick connection established and locked into vault.", "info", 0)
        threading.Thread(target=sync_kick_database, daemon=True).start()
        return "<script>alert('Kick Connected Successfully!'); window.location.href='/';</script>"
    return f"Kick Auth Failed: {res.text}"

@app.route('/twitch/login')
def twitch_login():
    config = load_json(CONFIG_PATH, DEFAULT_CONFIG)
    client_id = config.get("broadcaster", {}).get("twitch_client", "")
    if not client_id: return "Error: Save Twitch Client ID in dashboard first.", 400
    scopes = urllib.parse.quote("channel:manage:broadcast")
    return redirect(f"{TWITCH_AUTH_URL}?response_type=code&client_id={client_id}&redirect_uri={urllib.parse.quote(TWITCH_REDIRECT_URI)}&scope={scopes}")

@app.route('/twitch/callback')
def twitch_callback():
    config = load_json(CONFIG_PATH, DEFAULT_CONFIG)
    bc = config.get("broadcaster", {})
    client_id = bc.get("twitch_client", "")
    payload = {"grant_type": "authorization_code", "client_id": client_id, "client_secret": bc.get("twitch_secret", ""), "redirect_uri": TWITCH_REDIRECT_URI, "code": request.args.get('code')}
    res = requests.post(TWITCH_TOKEN_URL, data=payload)
    if res.status_code == 200:
        data = res.json()
        access_token = data["access_token"]
        config["broadcaster"]["twitch_token"], config["broadcaster"]["twitch_refresh"] = access_token, data.get("refresh_token", "")
        user_res = requests.get("https://api.twitch.tv/helix/users", headers={"Authorization": f"Bearer {access_token}", "Client-Id": client_id})
        if user_res.status_code == 200: config["broadcaster"]["twitch_broadcaster_id"] = user_res.json()["data"][0]["id"]
        save_json(CONFIG_PATH, config)
        log_smart("[OAUTH] Native Twitch connection established and numeric ID grabbed.", "info", 0)
        return "<script>alert('Twitch Connected!'); window.location.href='/';</script>"
    return f"Twitch Auth Failed: {res.text}"

# === METADATA WATERFALL & ID SCANNERS ===
def fetch_metadata(title):
    global status_data
    config = load_json(CONFIG_PATH, DEFAULT_CONFIG)
    keys = config.get("api_keys", {})
    bc = config.get("broadcaster", {})
    
    db = load_json(FORGE_DB_PATH, DEFAULT_FORGE_DB)
    vault_key = title.lower().strip()
    meta = db["library"].get(vault_key, {})
    
    entry = {
        "title": title, "genre": meta.get("genre", ""), "release_year": meta.get("release_year", ""), 
        "developer": meta.get("developer", ""), "publisher": meta.get("publisher", ""), 
        "twitch_id": meta.get("twitch_id", ""), "kick_id": meta.get("kick_id", ""), "cover_url": meta.get("cover_url", ""),
        "igdb_id": meta.get("igdb_id", "")
    }
    safe_title = urllib.parse.quote(title)

    # 1. STEAM PUBLIC STOREFRONT API (Primary Metadata)
    if not entry.get("developer") or not entry.get("release_year"):
        log_smart(f"[METADATA] Querying primary engine (Steam) for metadata: {title}...", "info", 60)
        try:
            steam_req = urllib.request.Request(f"https://store.steampowered.com/api/storesearch/?term={safe_title}&l=english&cc=US")
            with urllib.request.urlopen(steam_req, timeout=3) as s_res:
                s_data = json.loads(s_res.read().decode())
                if s_data.get('total', 0) > 0:
                    app_id = s_data['items'][0]['id']
                    details_req = urllib.request.Request(f"https://store.steampowered.com/api/appdetails?appids={app_id}")
                    with urllib.request.urlopen(details_req, timeout=3) as d_res:
                        d_data = json.loads(d_res.read().decode())
                        if d_data.get(str(app_id), {}).get('success'):
                            game_info = d_data[str(app_id)]['data']
                            rescued = False
                            if not entry.get("cover_url") and game_info.get('header_image'): 
                                entry["cover_url"] = game_info['header_image']
                                rescued = True
                            if not entry.get("developer") and game_info.get('developers'): 
                                entry["developer"] = game_info['developers'][0].upper()
                                rescued = True
                            if not entry.get("publisher") and game_info.get('publishers'): 
                                entry["publisher"] = game_info['publishers'][0].upper()
                                rescued = True
                            if not entry.get("release_year") and game_info.get('release_date', {}).get('date'): 
                                date_str = game_info['release_date']['date']
                                if len(date_str) >= 4: entry["release_year"] = date_str[-4:]
                                rescued = True
                            if not entry.get("genre") and game_info.get('genres'): 
                                entry["genre"] = game_info['genres'][0]['description'].upper()
                            if rescued: log_smart(f"[METADATA] Steam API successfully locked core metadata for: {title}", "info", 60)
        except Exception as err: log_smart(f"[METADATA ERROR] Steam API Network Failure for '{title}': {str(err)}", "warning", 60)

    # 2. STEAMGRIDDB API (Primary Cover Art Engine)
    sgdb_key = keys.get("steamgrid", "")
    if sgdb_key:
        log_smart(f"[METADATA] Querying SteamGridDB for high-fidelity cover art: {title}...", "info", 60)
        try:
            search_req = urllib.request.Request(f"https://www.steamgriddb.com/api/v2/search/autocomplete/{safe_title}", headers={"Authorization": f"Bearer {sgdb_key}"})
            with urllib.request.urlopen(search_req, timeout=3) as search_res:
                search_data = json.loads(search_res.read().decode())
                if search_data.get('success') and len(search_data.get('data', [])) > 0:
                    game_id = search_data['data'][0]['id']
                    grid_req = urllib.request.Request(f"https://www.steamgriddb.com/api/v2/grids/game/{game_id}?dimensions=600x900", headers={"Authorization": f"Bearer {sgdb_key}"})
                    with urllib.request.urlopen(grid_req, timeout=3) as grid_res:
                        grid_data = json.loads(grid_res.read().decode())
                        if grid_data.get('success') and len(grid_data.get('data', [])) > 0:
                            entry["cover_url"] = grid_data['data'][0]['url']
                            log_smart(f"[METADATA] SteamGridDB successfully forged vertical cover art for: {title}", "info", 60)
        except urllib.error.HTTPError as e:
            if e.code in [401, 403]: log_smart(f"[AUTH ALERT] SteamGridDB API Key rejected (HTTP {e.code}). Please verify your key.", "error", 300)
        except Exception as err: log_smart(f"[METADATA ERROR] SteamGridDB Network Failure for '{title}': {str(err)}", "warning", 60)

    # 3. IGDB API (Fallback Metadata & Bundle Breaker)
    igdb_c = bc.get("twitch_client", "")
    igdb_s = bc.get("twitch_secret", "")
    igdb_t = keys.get("igdb_token", "")
    is_bundle_flagged = False
    
    if igdb_c and igdb_s and (not entry.get("cover_url") or not entry.get("developer") or not entry.get("igdb_id")):
        def do_igdb_fetch(token):
            nonlocal is_bundle_flagged
            body = f'search "{title}"; fields id,name,category,bundles,collection,cover.url,first_release_date,genres.name,involved_companies.company.name,involved_companies.developer,involved_companies.publisher; limit 1;'.encode('utf-8')
            req = urllib.request.Request("https://api.igdb.com/v4/games", data=body, headers={'Client-ID': igdb_c, 'Authorization': f'Bearer {token}', 'Accept': 'application/json'}, method='POST')
            with urllib.request.urlopen(req, timeout=5) as res:
                data = json.loads(res.read().decode())
                if data:
                    g = data[0]
                    parent_id = g.get("id")
                    is_bundle = g.get("category") in [3, 5] or any(word in title.lower() for word in ["collection", "trilogy", "remastered"])
                    if is_bundle:
                        log_smart(f"[BUNDLE BREAKER] Compilation detected: '{title}'. Pausing automation to ask user for specific game...", "info", 60)
                        options = []
                        if g.get("bundles"):
                            b_ids = ",".join(map(str, g["bundles"]))
                            sub_body = f'fields id,name,cover.url; where id = ({b_ids}); limit 10;'.encode('utf-8')
                        elif g.get("collection"):
                            c_id = g.get("collection")
                            sub_body = f'fields id,name,cover.url; where collection = {c_id} & category = 0; limit 15; sort first_release_date asc;'.encode('utf-8')
                        else:
                            clean_title = title.lower().replace("collection", "").replace("remastered", "").replace("trilogy", "").strip()
                            sub_body = f'search "{clean_title}"; fields id,name,cover.url; where category = 0; limit 10;'.encode('utf-8')
                        try:
                            sub_req = urllib.request.Request("https://api.igdb.com/v4/games", data=sub_body, headers={'Client-ID': igdb_c, 'Authorization': f'Bearer {token}', 'Accept': 'application/json'}, method='POST')
                            with urllib.request.urlopen(sub_req, timeout=5) as sub_res:
                                sub_data = json.loads(sub_res.read().decode())
                                for sub_g in sub_data:
                                    options.append({"title": sub_g.get("name", "Unknown Game"), "cover_url": f"https:{sub_g['cover']['url'].replace('t_thumb', 't_1080p')}" if sub_g.get("cover") else ""})
                                if options:
                                    status_data["pending_bundle"] = True; status_data["bundle_options"] = options; is_bundle_flagged = True
                                    return 
                        except Exception as sub_err: log_smart(f"[BUNDLE BREAKER ERROR] Failed to fetch sub-games: {str(sub_err)}", "warning", 60)

                    if not entry.get("igdb_id"): entry["igdb_id"] = str(parent_id)
                    if not entry.get("cover_url") and g.get("cover"): entry["cover_url"] = f"https:{g['cover']['url'].replace('t_thumb', 't_1080p')}"
                    if not entry.get("release_year") and g.get("first_release_date"): entry["release_year"] = time.strftime('%Y', time.gmtime(g["first_release_date"]))
                    if not entry.get("genre") and g.get("genres"): entry["genre"] = g["genres"][0]["name"].upper()
                    if g.get("involved_companies"):
                        for comp in g["involved_companies"]:
                            if comp.get("developer") and not entry.get("developer"): entry["developer"] = comp["company"]["name"].upper()
                            if comp.get("publisher") and not entry.get("publisher"): entry["publisher"] = comp["company"]["name"].upper()
                    log_smart(f"[METADATA] IGDB API successfully pulled fallback data for: {title}", "info", 60)

        try:
            if not igdb_t: raise ValueError("No IGDB Token found.")
            do_igdb_fetch(igdb_t)
        except Exception as api_err:
            try:
                tok_req = urllib.request.Request("https://id.twitch.tv/oauth2/token", data=urllib.parse.urlencode({'client_id': igdb_c, 'client_secret': igdb_s, 'grant_type': 'client_credentials'}).encode('utf-8'), method='POST')
                with urllib.request.urlopen(tok_req, timeout=5) as tok_res:
                    new_token = json.loads(tok_res.read().decode()).get('access_token')
                    if new_token: config["api_keys"]["igdb_token"] = new_token; save_json(CONFIG_PATH, config); do_igdb_fetch(new_token) 
            except Exception as ref_err: log_smart(f"[AUTH ALERT] IGDB Authentication Failed. Verify Twitch App Client ID/Secret.", "error", 300)

    if is_bundle_flagged: return

    # 4. GOG CATALOG API (Fallback Metadata)
    if not entry.get("cover_url") or not entry.get("developer") or not entry.get("release_year"):
        log_smart(f"[METADATA] Steam missed data. Querying GOG Catalog for: {title}...", "info", 60)
        try:
            gog_req = urllib.request.Request(f"https://embed.gog.com/games/ajax/filtered?mediaType=game&search={safe_title}")
            with urllib.request.urlopen(gog_req, timeout=3) as g_res:
                g_data = json.loads(g_res.read().decode())
                if g_data.get("products") and len(g_data["products"]) > 0:
                    p = g_data["products"][0]
                    rescued = False
                    if not entry.get("cover_url") and p.get("image"): entry["cover_url"] = f"https:{p['image']}_formatted_1080.jpg"; rescued = True
                    if not entry.get("developer") and p.get("developer"): entry["developer"] = p["developer"].upper(); rescued = True
                    if not entry.get("publisher") and p.get("publisher"): entry["publisher"] = p["publisher"].upper(); rescued = True
                    if not entry.get("release_year") and p.get("globalReleaseDate"): entry["release_year"] = time.strftime('%Y', time.gmtime(p["globalReleaseDate"])); rescued = True
                    if rescued: log_smart(f"[METADATA] GOG API successfully provided missing data for: {title}", "info", 60)
        except Exception as err: log_smart(f"[METADATA ERROR] GOG API Network Failure for '{title}': {str(err)}", "warning", 60)

    # 5. ITCH.IO WEB SCRAPER (Indie Metadata Fallback - No Key Required)
    if not entry.get("cover_url") or not entry.get("developer"):
        log_smart(f"[METADATA] Querying Itch.io open directory for indie fallback data: {title}...", "info", 60)
        try:
            itch_req = urllib.request.Request(f"https://itch.io/search?q={safe_title}", headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(itch_req, timeout=3) as i_res:
                html = i_res.read().decode('utf-8')
                img_match = re.search(r'data-background_image="([^"]+)"', html)
                author_match = re.search(r'class="game_author"[^>]*><a[^>]*>([^<]+)</a>', html)
                rescued = False
                if not entry.get("cover_url") and img_match: entry["cover_url"] = img_match.group(1); rescued = True
                if not entry.get("developer") and author_match: entry["developer"] = author_match.group(1).upper(); rescued = True
                if rescued: log_smart(f"[METADATA] Itch.io successfully rescued indie metadata for: {title}", "info", 60)
        except Exception as err: log_smart(f"[METADATA ERROR] Itch.io fallback search failed for '{title}': {str(err)}", "warning", 60)

    # 6. RAWG API (Deep Fallback)
    if keys.get("rawg") and (not entry.get("cover_url") or not entry.get("release_year") or not entry.get("developer")):
        log_smart(f"[METADATA] Querying RAWG deep fallback for missing data: {title}...", "info", 60)
        try:
            req = urllib.request.Request(f"https://api.rawg.io/api/games?key={keys['rawg']}&search={safe_title}&page_size=1")
            with urllib.request.urlopen(req, timeout=3) as res:
                game_results = json.loads(res.read().decode()).get("results", [])
                if game_results:
                    game = game_results[0]
                    rescued = False
                    if not entry.get("cover_url") and game.get("background_image"): entry["cover_url"] = game.get("background_image"); rescued = True
                    if not entry.get("release_year") and game.get("released"): entry["release_year"] = game.get("released").split('-')[0]; rescued = True
                    if not entry.get("genre") and game.get("genres"): entry["genre"] = game["genres"][0]["name"].upper(); rescued = True
                    if rescued: log_smart(f"[METADATA] RAWG API successfully rescued fallback data for: {title}", "info", 60)
        except urllib.error.HTTPError as e:
            if e.code in [401, 403]: log_smart(f"[AUTH ALERT] RAWG API Key rejected (HTTP {e.code}). Please verify your key.", "error", 300)
            else: log_smart(f"[METADATA ERROR] RAWG API rejected request for '{title}' (HTTP {e.code}).", "warning", 60)
        except Exception as err:
            log_smart(f"[METADATA ERROR] RAWG Network Failure for '{title}': {str(err)}", "warning", 60)

    # 7. TWITCH ID CATALOGING
    if bc.get("twitch_client") and bc.get("twitch_token") and not entry.get("twitch_id"):
        headers = {'Client-Id': bc.get("twitch_client"), 'Authorization': f'Bearer {bc.get("twitch_token")}'}
        try:
            if entry.get("igdb_id"):
                t_res = requests.get(f'https://api.twitch.tv/helix/games?igdb_id={entry["igdb_id"]}', headers=headers, timeout=3)
                if t_res.status_code == 200 and t_res.json().get('data'):
                    entry["twitch_id"] = str(t_res.json()['data'][0]['id']); t_name = t_res.json()['data'][0]['name']
                    log_smart(f"[DB MANAGER] Cataloged Twitch Category via IGDB Bridge: {t_name} [ID: {entry['twitch_id']}]", "info", 60)
                elif t_res.status_code in [401, 403]: log_smart(f"[AUTH ALERT] Twitch API rejected token during background cataloging.", "warning", 300)
            if not entry.get("twitch_id"):
                t_res = requests.get(f'https://api.twitch.tv/helix/search/categories?query={safe_title}', headers=headers, timeout=3)
                if t_res.status_code == 200 and t_res.json().get('data') and len(t_res.json()['data']) > 0:
                    entry["twitch_id"] = str(t_res.json()['data'][0]['id']); t_name = t_res.json()['data'][0]['name']
                    log_smart(f"[DB MANAGER] Cataloged Twitch Category via Fuzzy Search: {t_name} [ID: {entry['twitch_id']}]", "info", 60)
        except Exception as e: log_smart(f"[DB MANAGER ERROR] Twitch ID background lookup failed: {str(e)}", "warning", 60)

    # 8. KICK ID CATALOGING
    if not entry.get("kick_id"):
        kick_db = load_json(KICK_DB_PATH, {})
        if kick_db:
            if title in kick_db: entry["kick_id"] = str(kick_db[title])
            else:
                matches = difflib.get_close_matches(title, kick_db.keys(), n=1, cutoff=0.8)
                if matches: entry["kick_id"] = str(kick_db[matches[0]])
            if entry.get("kick_id"): log_smart(f"[DB MANAGER] Cataloged Kick ID for '{title}': {entry['kick_id']}", "info", 60)

    status_data.update({"cover_url": entry.get("cover_url", ""), "release_date": entry.get("release_year", "UNKNOWN"), "genre": entry.get("genre", "GAMING"), "publisher": entry.get("publisher", "INDIE"), "developer": entry.get("developer", "INDIE")})
    
    with meta_lock:
        db = load_json(FORGE_DB_PATH, DEFAULT_FORGE_DB)
        if vault_key not in db["library"]: db["library"][vault_key] = {"title": title, "genre": "", "release_year": "", "developer": "", "publisher": "", "twitch_id": "", "kick_id": "", "cover_url": "", "igdb_id": ""}
        for k, v in entry.items():
            if v: db["library"][vault_key][k] = v
        save_json(FORGE_DB_PATH, db)

    if load_json(CONFIG_PATH, DEFAULT_CONFIG).get("engine_settings", {}).get("auto_push", False):
        time.sleep(2)
        trigger_category_update(title)

# === STANDALONE ROUTING & API UPDATERS ===
def get_readable_error(status_code):
    errors = { 400: "BAD SETTINGS", 401: "INVALID TOKEN", 403: "NO PERMISSION", 404: "NOT FOUND", 429: "RATE LIMITED", 500: "SERVER CRASH", 502: "PLATFORM DOWN", 503: "PLATFORM DOWN" }
    return errors.get(status_code, f"API ERROR ({status_code})")

def update_twitch_category(game_title, client_id, token, broadcaster_id, retry=True):
    global broadcast_status
    if not all([client_id, token, broadcaster_id]): broadcast_status["twitch"] = "MISSING KEYS"; return
    broadcast_status["twitch"] = "PUSHING..."
    headers = {'Client-Id': client_id, 'Authorization': f'Bearer {token}'}
    
    db = load_json(FORGE_DB_PATH, DEFAULT_FORGE_DB)
    meta = db["library"].get(game_title.lower().strip(), {})
    game_id = meta.get("twitch_id")
    target_name = game_title 
    
    try:
        if not game_id:
            log_smart(f"[NATIVE] Twitch ID missing from vault. Running fallback search for: '{game_title}'...", "info", 60)
            res = requests.get(f'https://api.twitch.tv/helix/search/categories?query={urllib.parse.quote(game_title)}', headers=headers, timeout=3)
            if res.status_code == 401 and retry:
                new_token = refresh_twitch_token()
                if new_token: return update_twitch_category(game_title, client_id, new_token, broadcaster_id, retry=False)
            if res.status_code == 200 and res.json().get('data') and len(res.json()['data']) > 0:
                game_id = str(res.json()['data'][0]['id']); target_name = res.json()['data'][0]['name']

        if game_id:
            patch_res = requests.patch(f'https://api.twitch.tv/helix/channels?broadcaster_id={broadcaster_id}', json={'game_id': game_id}, headers=headers, timeout=3)
            if patch_res.status_code == 204: 
                log_smart(f"[NATIVE ROUTER] Twitch Channel successfully updated to: {target_name} [ID: {game_id}]", "info", 60)
                broadcast_status["twitch"] = "LIVE"
                if not meta.get("twitch_id"): update_meta_field(game_title, "twitch_id", game_id)
            elif patch_res.status_code == 401 and retry:
                new_token = refresh_twitch_token()
                if new_token: return update_twitch_category(game_title, client_id, new_token, broadcaster_id, retry=False)
            else: 
                log_smart(f"[NATIVE ERROR] Twitch API rejected Category ID {game_id} (HTTP {patch_res.status_code}).", "error", 60)
                broadcast_status["twitch"] = get_readable_error(patch_res.status_code)
        else:
            log_smart(f"[NATIVE WARNING] Twitch database could not resolve title: '{game_title}'.", "warning", 60)
            broadcast_status["twitch"] = "GAME NOT FOUND"
    except Exception as e: 
        log_smart(f"[NATIVE ERROR] Twitch Network Connection Failed: {str(e)}", "error", 60)
        broadcast_status["twitch"] = "OFFLINE"

def update_kick_category(game_title, token, channel_id, retry=True):
    global broadcast_status
    if not all([token, channel_id]): broadcast_status["kick"] = "MISSING KEYS"; return
    broadcast_status["kick"] = "PUSHING..."
    headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/json', 'Content-Type': 'application/json'}
    target_name = game_title
    
    db = load_json(FORGE_DB_PATH, DEFAULT_FORGE_DB)
    meta = db["library"].get(game_title.lower().strip(), {})
    category_id = meta.get("kick_id")
    api_error = ""

    try:
        if not category_id:
            log_smart(f"[NATIVE] Kick ID missing. Querying V2 Directory for: '{game_title}'...", "info", 60)
            res_v2 = requests.get(f'https://api.kick.com/public/v2/categories?name={urllib.parse.quote(game_title)}', headers=headers, timeout=5)
            if res_v2.status_code == 401 and retry:
                new_token = refresh_kick_token()
                if new_token: return update_kick_category(game_title, new_token, channel_id, retry=False)
            if res_v2.status_code == 200:
                raw_res = res_v2.json()
                cat_list = raw_res.get('data', [])
                if cat_list and len(cat_list) > 0:
                    category_id, target_name = str(cat_list[0]['id']), cat_list[0]['name']

            if not category_id:
                log_smart(f"[NATIVE] V2 Directory missed. Falling back to V1 Directory for: '{game_title}'...", "info", 60)
                res_v1 = requests.get(f'https://api.kick.com/public/v1/categories?q={urllib.parse.quote(game_title)}', headers=headers, timeout=5)
                if res_v1.status_code == 200:
                    raw_res = res_v1.json()
                    cat_list = raw_res.get('data', []) if isinstance(raw_res, dict) else (raw_res if isinstance(raw_res, list) else [])
                    if cat_list and len(cat_list) > 0:
                        category_id, target_name = str(cat_list[0]['id']), cat_list[0]['name']

        if category_id:
            patch_res = requests.patch('https://api.kick.com/public/v1/channels', json={'category_id': int(category_id)}, headers=headers, timeout=5)
            if patch_res.status_code in [200, 204]: 
                log_smart(f"[NATIVE ROUTER] Kick Channel successfully updated to: {target_name} [ID: {category_id}]", "info", 60)
                broadcast_status["kick"] = "LIVE"
                if not meta.get("kick_id"): update_meta_field(game_title, "kick_id", category_id)
                return
            elif patch_res.status_code == 401 and retry:
                new_token = refresh_kick_token()
                if new_token: return update_kick_category(game_title, new_token, channel_id, retry=False)
            else: 
                api_error = get_readable_error(patch_res.status_code)
                log_smart(f"[NATIVE ERROR] Kick API rejected Category ID {category_id} (HTTP {patch_res.status_code}).", "error", 60)
                
        broadcast_status["kick"] = api_error if api_error else "GAME NOT FOUND"
                
    except Exception as e: 
        log_smart(f"[NATIVE ERROR] Kick Network Connection Failed: {str(e)}", "error", 60)
        broadcast_status["kick"] = "OFFLINE"

def trigger_category_update(category):
    global broadcast_status
    config = load_json(CONFIG_PATH, DEFAULT_CONFIG)
    settings = config.get("engine_settings", {})
    broadcaster = config.get("broadcaster", {})
    routing_mode = broadcaster.get("routing_mode", "streamer_bot")
    
    if settings.get("safe_mode", False):
        broadcast_status["twitch"] = "SAFE MODE"; broadcast_status["kick"] = "SAFE MODE"; return {"status": "success"}
        
    if routing_mode == "streamer_bot":
        broadcast_status["streamer_bot"] = "PUSHING..."
        try:
            requests.post(f'http://127.0.0.1:{settings.get("sb_port", 8080)}/DoAction', json={ "action": { "name": "UpdateCategory" }, "args": { "category": category } }, timeout=2)
            broadcast_status["streamer_bot"] = "PING SENT"
            log_smart(f"[ROUTER] Streamer.bot HTTP Category push sent for: {category}", "info", 60)
        except requests.exceptions.RequestException:
            broadcast_status["streamer_bot"] = "UNREACHABLE"
            log_smart(f"[ROUTING ERROR] Cannot reach Streamer.bot HTTP Server on port {settings.get('sb_port', 8080)}. Is it running?", "warning", 60)
        except Exception as e:
            broadcast_status["streamer_bot"] = "ERROR"
            log_smart(f"[ROUTING ERROR] Streamer.bot push failed unexpectedly: {str(e)}", "error", 60)
        return {"status": "success"}
        
    elif routing_mode == "native":
        threading.Thread(target=update_twitch_category, args=(category, broadcaster.get("twitch_client"), broadcaster.get("twitch_token"), broadcaster.get("twitch_broadcaster_id")), daemon=True).start()
        threading.Thread(target=update_kick_category, args=(category, broadcaster.get("kick_token"), broadcaster.get("kick_channel_id")), daemon=True).start()
        return {"status": "success"}

# === CROSS-PLATFORM SCOUT ===
def get_active_window_info():
    try:
        if CURRENT_OS == "Windows":
            hwnd = ctypes.windll.user32.GetForegroundWindow()
            if not hwnd: return None, None
            length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
            buff = ctypes.create_unicode_buffer(length + 1)
            ctypes.windll.user32.GetWindowTextW(hwnd, buff, length + 1)
            window_title = buff.value.strip()
            pid = ctypes.c_ulong()
            ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value > 0: return window_title, psutil.Process(pid.value).name()
    except Exception as e: log_smart(f"[SCOUT ERROR] Failed to read active window title via ctypes: {str(e)}", "warning", 60)
    return None, None

# === SCANNER & WEB ROUTES ===
@app.route('/')
@app.route('/dashboard')
@app.route('/forge-dashboard') 
def serve_dashboard(): return send_from_directory(BASE_DIR, 'Dashboard.html')

@app.route('/layouts/<path:filename>')
def serve_layout(filename): return send_from_directory(LAYOUTS_DIR, filename)

@app.route('/Logic.js')
def serve_logic(): return send_from_directory(BASE_DIR, 'Logic.js')

@app.route('/forge-widget/<token>/<path:filename>')
def serve_secure_widget(token, filename):
    if token != WIDGET_TOKEN: return "Unauthorized Token", 401
    return send_from_directory(LAYOUTS_DIR, filename)
    
@app.route('/status')
def get_status():
    config = load_json(CONFIG_PATH, DEFAULT_CONFIG)
    payload = status_data.copy()
    payload["system_info"] = {"os": CURRENT_OS, "active_path": BASE_DIR.replace("\\", "/"), "missing_deps": []}
    payload["fade_timer"] = config.get("engine_settings", {}).get("widget_fade_timer", 15) 
    payload["widget_poll_rate"] = config.get("engine_settings", {}).get("widget_poll_rate", 3)
    payload["broadcast_status"] = broadcast_status 
    return jsonify(payload)

@app.route('/resolve-bundle', methods=['POST', 'OPTIONS'])
@require_local_auth
def resolve_bundle():
    global status_data
    data = request.json
    selected_title = data.get('title')
    
    if selected_title:
        status_data["game_title"] = selected_title; status_data["pending_bundle"] = False; status_data["bundle_options"] = []
        log_smart(f"[BUNDLE BREAKER] User manually locked in specific collection game: '{selected_title}'", "info", 0)
        
        db = load_json(FORGE_DB_PATH, DEFAULT_FORGE_DB)
        if status_data["process_name"].lower() not in db["exiled_apps"]:
            db["process_map"][status_data["process_name"].lower()] = selected_title
            save_json(FORGE_DB_PATH, db)
            
        threading.Thread(target=fetch_metadata, args=(selected_title,), daemon=True).start()
        return jsonify({"status": "success"})
    return jsonify({"status": "error"})

@app.route('/pulse', methods=['GET', 'POST'])
def trigger_pulse():
    global status_data
    status_data["last_pulse"] = time.time()
    return jsonify({"status": "Pulse triggered"})

@app.route('/get-token')
def get_token(): return jsonify({"token": WIDGET_TOKEN})

@app.route('/api/kick-db')
def serve_kick_db(): return jsonify(list(load_json(KICK_DB_PATH, {}).keys()))

@app.route('/list', methods=['POST', 'OPTIONS'])
@require_local_auth
def list_app():
    data = request.json; title = data['title']
    db = load_json(FORGE_DB_PATH, DEFAULT_FORGE_DB)
    
    if data.get('process'): db["process_map"][data['process'].lower()] = title
        
    vault_key = title.lower().strip()
    with meta_lock:
        if vault_key not in db["library"]: db["library"][vault_key] = {"title": title, "genre": "", "release_year": "", "developer": "", "publisher": "", "twitch_id": "", "kick_id": "", "cover_url": "", "igdb_id": ""}
        if data.get('custom_url'): db["library"][vault_key]['cover_url'] = data['custom_url']
        if data.get('custom_release'): db["library"][vault_key]['release_year'] = data['custom_release']
        if data.get('custom_genre'): db["library"][vault_key]['genre'] = data['custom_genre']
        if data.get('custom_publisher'): db["library"][vault_key]['publisher'] = data['custom_publisher']
        if data.get('custom_developer'): db["library"][vault_key]['developer'] = data['custom_developer']
        if data.get('custom_twitch_id'): db["library"][vault_key]['twitch_id'] = data['custom_twitch_id']
        if data.get('custom_kick_id'): db["library"][vault_key]['kick_id'] = data['custom_kick_id']
        save_json(FORGE_DB_PATH, db)
        
    log_smart(f"[THE FORGE] User locked '{title}' and its custom metadata into the database.", "info", 0)
    if status_data.get("game_title", "").lower().strip() == vault_key: threading.Thread(target=fetch_metadata, args=(status_data["game_title"],), daemon=True).start()
    return jsonify({"status": "success"})

@app.route('/delist', methods=['POST', 'OPTIONS'])
@require_local_auth
def delist_app():
    proc_name = request.json.get('process')
    if proc_name:
        db = load_json(FORGE_DB_PATH, DEFAULT_FORGE_DB); clean_proc = proc_name.lower().strip()
        if clean_proc not in db["exiled_apps"]:
            db["exiled_apps"].append(clean_proc); save_json(FORGE_DB_PATH, db)
            log_smart(f"[THE FORGE] User exiled application '{clean_proc}' from tracking.", "info", 0)
    return jsonify({"status": "success"})

@app.route('/logs')
def get_logs():
    try:
        with open(LOG_PATH, 'r') as f: return jsonify({"logs": f.readlines()[-30:]})
    except: return jsonify({"logs": []})

@app.route('/clear-logs', methods=['POST', 'OPTIONS'])
@require_local_auth
def clear_logs():
    with open(LOG_PATH, 'w') as f: f.write("System logs purged by user.\n")
    log_smart("[SYSTEM] Terminal logs purged by user.", "info", 0)
    return jsonify({"status": "success"})

@app.route('/settings', methods=['GET', 'POST', 'OPTIONS'])
@require_local_auth
def manage_settings():
    current_config = load_json(CONFIG_PATH, DEFAULT_CONFIG)
    if "engine_settings" not in current_config: current_config["engine_settings"] = {}
    if "api_keys" not in current_config: current_config["api_keys"] = {}
    if "broadcaster" not in current_config: current_config["broadcaster"] = {}
    
    if request.method == 'POST':
        data = request.json
        current_config["engine_settings"]["auto_push"] = data.get("auto_push", False)
        current_config["engine_settings"]["safe_mode"] = data.get("safe_mode", False)
        current_config["engine_settings"]["idle_category"] = data.get("idle_category", "Just Chatting")
        current_config["engine_settings"]["sb_port"] = data.get("sb_port", 8080)
        current_config["engine_settings"]["widget_poll_rate"] = data.get("widget_poll_rate", 3)
        current_config["engine_settings"]["widget_fade_timer"] = data.get("widget_fade_timer", 15)
        
        current_config["api_keys"]["steamgrid"] = data.get("sgdb_key", "")
        current_config["api_keys"]["rawg"] = data.get("rawg_key", "")
        current_config["api_keys"]["igdb_client"] = data.get("igdb_client", "")
        current_config["api_keys"]["igdb_secret"] = data.get("igdb_secret", "")
        
        current_config["broadcaster"]["routing_mode"] = data.get("routing_mode", "streamer_bot")
        current_config["broadcaster"]["twitch_client"] = data.get("twitch_client", "")
        current_config["broadcaster"]["twitch_secret"] = data.get("twitch_secret", "")
        
        current_config["broadcaster"]["kick_client"] = data.get("kick_client", "")
        current_config["broadcaster"]["kick_secret"] = data.get("kick_secret", "")
        current_config["broadcaster"]["kick_channel_id"] = data.get("kick_channel_id", "")
        
        save_json(CONFIG_PATH, current_config)
        log_smart("[SYSTEM] User saved Engine / Routing configuration to the vault.", "info", 0)
        return jsonify({"status": "success"})
    
    flat_data = {**current_config["engine_settings"]}
    flat_data["sgdb_key"] = current_config["api_keys"].get("steamgrid", "")
    flat_data["rawg_key"] = current_config["api_keys"].get("rawg", "")
    flat_data["igdb_client"] = current_config["api_keys"].get("igdb_client", "")
    flat_data["igdb_secret"] = current_config["api_keys"].get("igdb_secret", "")
    
    broadcaster = current_config.get("broadcaster", {})
    flat_data["routing_mode"] = broadcaster.get("routing_mode", "streamer_bot")
    flat_data["twitch_client"] = broadcaster.get("twitch_client", "")
    flat_data["twitch_secret"] = broadcaster.get("twitch_secret", "")
    flat_data["kick_client"] = broadcaster.get("kick_client", "")
    flat_data["kick_secret"] = broadcaster.get("kick_secret", "")
    flat_data["kick_channel_id"] = broadcaster.get("kick_channel_id", "")
    return jsonify(flat_data)

@app.route('/push-stream', methods=['POST', 'OPTIONS'])
@require_local_auth
def push_stream():
    data = request.json
    config = load_json(CONFIG_PATH, DEFAULT_CONFIG)
    category = data.get('category') or status_data.get('game_title', config.get("engine_settings", {}).get("idle_category", "Just Chatting"))
    log_smart(f"[MANUAL OVERRIDE] User forced a manual category push for: '{category}'", "info", 0)
    result = trigger_category_update(category)
    return jsonify(result or {"status": "success"})

@app.route('/shutdown', methods=['POST', 'OPTIONS'])
@require_local_auth
def shutdown_engine():
    log_smart("[SYSTEM] Powering down StatusForge Engine...", "info", 0)
    threading.Timer(1.0, lambda: os._exit(0)).start()
    return jsonify({"status": "success"})

@app.route('/repair-engine', methods=['POST', 'OPTIONS'])
@require_local_auth
def repair_engine():
    def run_repair():
        py_deps = [sys.executable, "-m", "pip", "install", "flask", "flask-cors", "requests", "pillow", "psutil", "pyyaml"]
        try: subprocess.check_call([sys.executable, "-m", "pip", "install", "--upgrade", "pip"]); subprocess.check_call(py_deps)
        except Exception as e: log_smart(f"[SYSTEM ERROR] Engine auto-repair failed: {str(e)}", "error", 0)
    threading.Thread(target=run_repair, daemon=True).start()
    return jsonify({"status": "Repair initiated"})

def monitor_games():
    global status_data
    config = load_json(CONFIG_PATH, DEFAULT_CONFIG)
    settings = config.get("engine_settings", {})
    idle_cat = settings.get("idle_category", "Just Chatting")
    
    status_data.update({"game_title": idle_cat, "is_playing": False})
    missed_scans = 0 
    
    while True:
        if status_data.get("pending_bundle"): time.sleep(1); continue
            
        db = load_json(FORGE_DB_PATH, DEFAULT_FORGE_DB)
        listed_lower_map = db.get("process_map", {})
        delisted = db.get("exiled_apps", [])
        
        window_title, active_exe = get_active_window_info()
        if window_title and active_exe:
            active_lower = active_exe.lower()
            core_ignores = ['explorer.exe', 'cmd.exe', 'terminal', 'iterm2', 'finder', 'dock', 'systemsettings', 'taskmgr.exe']
            if active_lower not in delisted and active_lower not in core_ignores and active_lower not in listed_lower_map:
                db["process_map"][active_lower] = window_title
                save_json(FORGE_DB_PATH, db)
                listed_lower_map[active_lower] = window_title 
                log_smart(f"[AUTO-FORGE] Scout discovered new process and temporarily listed it: {window_title} ({active_exe})", "info", 300)

        found = False
        for proc in psutil.process_iter(['name']):
            try:
                name_lower = proc.info['name'].lower()
                if name_lower in delisted: continue
                if name_lower in listed_lower_map:
                    found = True
                    missed_scans = 0
                    if not status_data["is_playing"] or status_data["process_name"] != proc.info['name']:
                        game_title = listed_lower_map[name_lower]
                        status_data.update({"is_playing": True, "game_title": game_title, "process_name": proc.info['name'], "start_time": time.time()})
                        log_smart(f"[SCANNER] Found active game: {game_title}", "info", 0)
                        threading.Thread(target=fetch_metadata, args=(game_title,), daemon=True).start()
                    break
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess): continue 
            except Exception as e: log_smart(f"[SCANNER ERROR] Failed reading system process: {str(e)}", "warning", 60); continue
        
        if not found and status_data["is_playing"]:
            missed_scans += 1
            if missed_scans >= 8:
                status_data.update({"is_playing": False, "game_title": idle_cat, "process_name": "", "start_time": 0})
                log_smart(f"[SCANNER] Game closed. Reverting to Idle Category: {idle_cat}", "info", 0)
                if load_json(CONFIG_PATH, DEFAULT_CONFIG).get("engine_settings", {}).get("auto_push", False):
                    trigger_category_update(idle_cat)
        
        time.sleep(load_json(CONFIG_PATH, DEFAULT_CONFIG).get("engine_settings", {}).get("scan_interval", 5))

# === SYSTEM IGNITION ===
if __name__ == '__main__':
    threading.Thread(target=keep_kick_db_synced, daemon=True).start()
    threading.Thread(target=monitor_games, daemon=True).start()
    app.run(host='127.0.0.1', port=5050)