import sys, subprocess, platform, os, io

# === CORE ENCODING FIX ===
if sys.platform == 'win32':
    if sys.stdout is not None:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    if sys.stderr is not None:
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# === STATUSFORGE AUTO-BOOTLOADER ===
def forge_bootstrap():
    if getattr(sys, 'frozen', False):
        return
        
    required_libs = ["flask", "flask-cors", "requests", "psutil"]
    try:
        import flask, flask_cors, requests, psutil
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

# === CORE PATHING ===
if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

LAYOUTS_DIR = os.path.join(BASE_DIR, 'layouts') 
CURRENT_OS = platform.system()

# === LOGGING ===
LOG_PATH = os.path.join(BASE_DIR, 'debug.log')
log_handler = RotatingFileHandler(LOG_PATH, maxBytes=1024 * 1024, backupCount=1)
logging.basicConfig(handlers=[log_handler], level=logging.INFO, format='%(asctime)s | %(message)s', datefmt='%H:%M:%S')

app = Flask(__name__)
# SECURED: Only allow local origins to interact with the API
CORS(app, resources={r"/*": {"origins": ["http://127.0.0.1:5050", "http://localhost:5050"]}})

class NoSpamFilter(logging.Filter):
    def filter(self, record):
        msg = record.getMessage()
        if ('GET /status' in msg or 'GET /logs' in msg) and ' 200 ' in msg: return False
        return True
logging.getLogger('werkzeug').addFilter(NoSpamFilter())
logging.getLogger('werkzeug').setLevel(logging.ERROR)

# === CONFIG & STATE ===
status_data = {"is_playing": False, "game_title": "System Initializing...", "process_name": "", "start_time": 0, "cover_url": "", "release_date": "", "genre": "", "publisher": "", "developer": "", "last_pulse": 0, "pending_bundle": False, "bundle_options": []}
broadcast_status = {"twitch": "STANDBY", "kick": "STANDBY", "streamer_bot": "STANDBY"}
pkce_vault = {} 
meta_lock = threading.Lock() 

VAULT_PATH = os.path.join(BASE_DIR, "vault.json")
CUSTOM_META_PATH = os.path.join(BASE_DIR, "Custom_Meta.json")
TOKEN_PATH = os.path.join(BASE_DIR, "Widget_Token.txt")
CONFIG_PATH = os.path.join(BASE_DIR, "Config.json") # FIX: Keeps settings safely inside the folder
KICK_DB_PATH = os.path.join(BASE_DIR, "kick_db.json")

# === OAUTH2 ENDPOINTS ===
KICK_AUTH_URL, KICK_TOKEN_URL, KICK_REDIRECT_URI = "https://id.kick.com/oauth/authorize", "https://id.kick.com/oauth/token", "http://localhost:5050/kick/callback"
TWITCH_AUTH_URL, TWITCH_TOKEN_URL, TWITCH_REDIRECT_URI = "https://id.twitch.tv/oauth2/authorize", "https://id.twitch.tv/oauth2/token", "http://localhost:5050/twitch/callback"

if not os.path.exists(TOKEN_PATH):
    with open(TOKEN_PATH, 'w') as f: f.write(secrets.token_urlsafe(16))
with open(TOKEN_PATH, 'r') as f: WIDGET_TOKEN = f.read().strip()

# === SECURITY CHECKPOINT ===
def require_local_auth(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # 1. Allow CORS preflight requests to pass unchallenged
        if request.method == 'OPTIONS':
            return jsonify({"status": "success"}), 200
            
        # 2. Check the token for all actual data requests
        token = request.headers.get('X-Forge-Token')
        if not token or token != WIDGET_TOKEN:
            logging.warning(f"[SECURITY] Blocked unauthorized access attempt to {request.path}")
            return jsonify({
                "status": "error",
                "error_code": "ENGINE_LOCKOUT",
                "message": "Access Denied. Invalid or missing security token."
            }), 401 
        return f(*args, **kwargs)
    return decorated_function

# === DATABASE & FILE MANAGEMENT ===
def load_json(path, default):
    if not os.path.exists(path):
        with open(path, 'w') as f: json.dump(default, f, indent=4)
    with open(path, 'r') as f: return json.load(f)

def save_json(path, data):
    with open(path, 'w') as f: json.dump(data, f, indent=4)

def update_meta_field(game_title, field, value):
    with meta_lock:
        db = load_json(CUSTOM_META_PATH, {})
        vault_key = game_title.lower().strip()
        if vault_key not in db: 
            db[vault_key] = {"title": game_title, "genre": "", "release_year": "", "developer": "", "publisher": "", "twitch_id": "", "kick_id": "", "cover_url": "", "igdb_id": ""}
        db[vault_key][field] = value
        save_json(CUSTOM_META_PATH, db)

DEFAULT_VAULT = {"listed_apps": {}, "delisted_apps": ["chrome.exe", "obs64.exe", "pythonw.exe", "finder", "explorer.exe"]}
load_json(VAULT_PATH, DEFAULT_VAULT)

DEFAULT_CONFIG = {
    "api_keys": {"rawg": "", "steamgrid": "", "igdb_client": "", "igdb_secret": "", "igdb_token": ""},
    "engine_settings": {"idle_category": "Just Chatting", "sb_port": 8080, "scan_interval": 5, "widget_poll_rate": 3, "safe_mode": False, "auto_push": False, "widget_fade_timer": 15},
    "broadcaster": {"routing_mode": "streamer_bot", "twitch_client": "", "twitch_secret": "", "twitch_token": "", "twitch_refresh": "", "twitch_broadcaster_id": "", "kick_client": "", "kick_secret": "", "kick_channel_id": "", "kick_token": "", "kick_refresh": ""}
}
load_json(CONFIG_PATH, DEFAULT_CONFIG)

# === BACKUP ENDPOINTS ===
@app.route('/export-config', methods=['GET', 'OPTIONS'])
@require_local_auth
def export_config():
    config = load_json(CONFIG_PATH, DEFAULT_CONFIG)
    return jsonify(config)

@app.route('/import-config', methods=['POST', 'OPTIONS'])
@require_local_auth
def import_config():
    try:
        raw_data = request.json
        
        # 1. Ensure it's actually a dictionary payload
        if not isinstance(raw_data, dict):
            return jsonify({"status": "error", "message": "Payload must be a JSON object."}), 400
            
        # 2. Ensure the core framework exists
        if "engine_settings" not in raw_data or "broadcaster" not in raw_data:
            return jsonify({"status": "error", "message": "Missing core config sections."}), 400

        # 🛡️ ANTI-TAMPER SANITIZATION
        # We completely ignore the uploaded file structure. We build a fresh, clean dictionary 
        # and strictly force the data types (str, int, bool) to prevent injection crashes.
        safe_config = {
            "api_keys": {
                "rawg": str(raw_data.get("api_keys", {}).get("rawg", "")),
                "steamgrid": str(raw_data.get("api_keys", {}).get("steamgrid", "")),
                "igdb_client": str(raw_data.get("api_keys", {}).get("igdb_client", "")),
                "igdb_secret": str(raw_data.get("api_keys", {}).get("igdb_secret", "")),
                "igdb_token": str(raw_data.get("api_keys", {}).get("igdb_token", ""))
            },
            "engine_settings": {
                "idle_category": str(raw_data["engine_settings"].get("idle_category", "Just Chatting"))[:100], # Cap length to 100 chars
                "sb_port": int(raw_data["engine_settings"].get("sb_port", 8080)),
                "scan_interval": int(raw_data["engine_settings"].get("scan_interval", 5)),
                "widget_poll_rate": int(raw_data["engine_settings"].get("widget_poll_rate", 3)),
                "safe_mode": bool(raw_data["engine_settings"].get("safe_mode", False)),
                "auto_push": bool(raw_data["engine_settings"].get("auto_push", False)),
                "widget_fade_timer": int(raw_data["engine_settings"].get("widget_fade_timer", 15))
            },
            "broadcaster": {
                "routing_mode": str(raw_data["broadcaster"].get("routing_mode", "streamer_bot")),
                "twitch_client": str(raw_data["broadcaster"].get("twitch_client", "")),
                "twitch_secret": str(raw_data["broadcaster"].get("twitch_secret", "")),
                "twitch_token": str(raw_data["broadcaster"].get("twitch_token", "")),
                "twitch_refresh": str(raw_data["broadcaster"].get("twitch_refresh", "")),
                "twitch_broadcaster_id": str(raw_data["broadcaster"].get("twitch_broadcaster_id", "")),
                "kick_client": str(raw_data["broadcaster"].get("kick_client", "")),
                "kick_secret": str(raw_data["broadcaster"].get("kick_secret", "")),
                "kick_channel_id": str(raw_data["broadcaster"].get("kick_channel_id", "")),
                "kick_token": str(raw_data["broadcaster"].get("kick_token", "")),
                "kick_refresh": str(raw_data["broadcaster"].get("kick_refresh", ""))
            }
        }
        
        # Save the freshly sanitized dictionary to the hard drive
        save_json(CONFIG_PATH, safe_config)
        return jsonify({"status": "success"})
        
    except ValueError:
        # If they tried to pass a string where an integer belongs (like sb_port = "hello"), it fails safely here
        return jsonify({"status": "error", "message": "Type mismatch. Config file is corrupted."}), 400
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

# === MASTER CATEGORY SYNCING ===
def sync_kick_database():
    config = load_json(CONFIG_PATH, DEFAULT_CONFIG)
    token = config.get("broadcaster", {}).get("kick_token", "")
    if not token: return
    try:
        logging.info("[KICK SYNC] Downloading Kick V2 Category Database...")
        res = requests.get("https://api.kick.com/public/v2/categories?limit=1000", headers={"Authorization": f"Bearer {token}", "Accept": "application/json"}, timeout=10)
        if res.status_code == 200:
            data = res.json()
            categories = data.get('data', []) if isinstance(data, dict) else (data if isinstance(data, list) else [])
            kick_map = {cat['name']: cat['id'] for cat in categories if 'name' in cat and 'id' in cat}
            if kick_map:
                save_json(KICK_DB_PATH, kick_map)
                logging.info(f"[KICK SYNC] Master Database forged with {len(kick_map)} categories.")
        elif res.status_code in [401, 403]:
            logging.warning(f"[AUTH ALERT] Kick database sync rejected ({res.status_code}). Token expired or invalid.")
    except Exception as e: 
        logging.error(f"[KICK SYNC] Error: {e}")

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
            logging.info("[OAUTH] Kick tokens successfully refreshed.")
            return data["access_token"]
        else:
            logging.warning(f"[AUTH ALERT] Kick token refresh rejected ({res.status_code}). Please reconnect your Kick App via Dashboard.")
    except Exception as e:
        logging.warning(f"[AUTH ALERT] Kick token refresh connection failed: {e}")
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
            logging.info("[OAUTH] Twitch tokens successfully refreshed.")
            return data["access_token"]
        else:
            logging.warning(f"[AUTH ALERT] Twitch token refresh rejected ({res.status_code}). Please reconnect your Twitch App via Dashboard.")
    except Exception as e:
        logging.warning(f"[AUTH ALERT] Twitch token refresh connection failed: {e}")
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
    auth_url = f"{KICK_AUTH_URL}?response_type=code&client_id={client_id}&redirect_uri={urllib.parse.quote(KICK_REDIRECT_URI)}&state={state_token}&code_challenge={challenge}&code_challenge_method=S256&scope={scopes}"
    return redirect(auth_url)

@app.route('/kick/callback')
def kick_callback():
    config = load_json(CONFIG_PATH, DEFAULT_CONFIG)
    bc = config.get("broadcaster", {})
    if request.args.get('state') != pkce_vault.get('state'): return "Security Error.", 403
    payload = {
        "grant_type": "authorization_code", "client_id": bc.get("kick_client", ""), "client_secret": bc.get("kick_secret", ""),
        "redirect_uri": KICK_REDIRECT_URI, "code": request.args.get('code'), "code_verifier": pkce_vault.get('verifier', '')
    }
    res = requests.post(KICK_TOKEN_URL, data=payload)
    if res.status_code == 200:
        data = res.json()
        config["broadcaster"]["kick_token"], config["broadcaster"]["kick_refresh"] = data["access_token"], data.get("refresh_token", "")
        save_json(CONFIG_PATH, config)
        threading.Thread(target=sync_kick_database, daemon=True).start()
        return "<script>alert('Kick Connected Successfully! Tokens saved to vault.'); window.location.href='/';</script>"
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
        return "<script>alert('Twitch Connected! Numeric ID Auto-grabbed.'); window.location.href='/';</script>"
    return f"Twitch Auth Failed: {res.text}"

# === METADATA WATERFALL & ID SCANNERS ===
def fetch_metadata(title):
    global status_data
    config = load_json(CONFIG_PATH, DEFAULT_CONFIG)
    keys = config.get("api_keys", {})
    bc = config.get("broadcaster", {})
    
    vault_key = title.lower().strip()
    meta = load_json(CUSTOM_META_PATH, {}).get(vault_key, {})
    entry = {
        "title": title, "genre": meta.get("genre", ""), "release_year": meta.get("release_year", ""), 
        "developer": meta.get("developer", ""), "publisher": meta.get("publisher", ""), 
        "twitch_id": meta.get("twitch_id", ""), "kick_id": meta.get("kick_id", ""), "cover_url": meta.get("cover_url", ""),
        "igdb_id": meta.get("igdb_id", "")
    }
    safe_title = urllib.parse.quote(title)

    # 1. RAWG API
    if keys.get("rawg") and (not entry.get("cover_url") or not entry.get("release_year")):
        try:
            req = urllib.request.Request(f"https://api.rawg.io/api/games?key={keys['rawg']}&search={safe_title}&page_size=1")
            with urllib.request.urlopen(req, timeout=3) as res:
                game = json.loads(res.read().decode())["results"][0]
                if not entry.get("cover_url"): entry["cover_url"] = game.get("background_image", "")
                if not entry.get("release_year"): entry["release_year"] = game.get("released", "").split('-')[0]
                if not entry.get("genre") and game.get("genres"): entry["genre"] = game["genres"][0]["name"].upper()
        except urllib.error.HTTPError as e:
            if e.code in [401, 403]:
                logging.warning(f"[AUTH ALERT] RAWG API Key rejected ({e.code}). Please verify your key in Dashboard settings.")
        except Exception as err:
            logging.warning(f"[METADATA] RAWG API fetch failed for '{title}': {err}")

    # 2. IGDB API
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
                        logging.info(f"[BUNDLE BREAKER] Compilation detected: {title}. Fetching sub-games...")
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
                                    options.append({
                                        "title": sub_g.get("name", "Unknown Game"),
                                        "cover_url": f"https:{sub_g['cover']['url'].replace('t_thumb', 't_1080p')}" if sub_g.get("cover") else ""
                                    })
                                if options:
                                    status_data["pending_bundle"] = True
                                    status_data["bundle_options"] = options
                                    is_bundle_flagged = True
                                    return 
                        except Exception as sub_err:
                            logging.warning(f"[BUNDLE BREAKER] Sub-fetch error: {sub_err}")

                    if not entry.get("igdb_id"): entry["igdb_id"] = str(parent_id)
                    if not entry.get("cover_url") and g.get("cover"): entry["cover_url"] = f"https:{g['cover']['url'].replace('t_thumb', 't_1080p')}"
                    if not entry.get("release_year") and g.get("first_release_date"): entry["release_year"] = time.strftime('%Y', time.gmtime(g["first_release_date"]))
                    if not entry.get("genre") and g.get("genres"): entry["genre"] = g["genres"][0]["name"].upper()
                    if g.get("involved_companies"):
                        for comp in g["involved_companies"]:
                            if comp.get("developer") and not entry.get("developer"): entry["developer"] = comp["company"]["name"].upper()
                            if comp.get("publisher") and not entry.get("publisher"): entry["publisher"] = comp["company"]["name"].upper()

        try:
            if not igdb_t: raise ValueError("No IGDB Token found.")
            do_igdb_fetch(igdb_t)
        except Exception as api_err:
            logging.warning(f"[IGDB MANAGER] Initial fetch failed, attempting token refresh. (Error: {api_err})")
            try:
                tok_req = urllib.request.Request("https://id.twitch.tv/oauth2/token", data=urllib.parse.urlencode({'client_id': igdb_c, 'client_secret': igdb_s, 'grant_type': 'client_credentials'}).encode('utf-8'), method='POST')
                with urllib.request.urlopen(tok_req, timeout=5) as tok_res:
                    new_token = json.loads(tok_res.read().decode()).get('access_token')
                    if new_token:
                        config["api_keys"]["igdb_token"] = new_token
                        save_json(CONFIG_PATH, config) 
                        do_igdb_fetch(new_token) 
            except Exception as ref_err: 
                logging.error(f"[AUTH ALERT] IGDB Authentication Failed. Please verify your Twitch Client ID/Secret in settings. (Error: {ref_err})")

    if is_bundle_flagged: return

    # 3. STEAM PUBLIC STOREFRONT API
    if not entry.get("cover_url") or not entry.get("developer") or not entry.get("release_year"):
        logging.info(f"[METADATA] Primary APIs missed data. Querying Steam API for: {title}...")
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
                                if len(date_str) >= 4:
                                    entry["release_year"] = date_str[-4:]
                                rescued = True
                            if not entry.get("genre") and game_info.get('genres'): 
                                entry["genre"] = game_info['genres'][0]['description'].upper()
                            
                            if rescued: logging.info(f"[METADATA] Steam API successfully provided missing data for: {title}")
        except Exception as err:
            logging.warning(f"[METADATA] Steam API fetch failed for '{title}': {err}")

    # 4. GOG CATALOG API
    if not entry.get("cover_url") or not entry.get("developer") or not entry.get("release_year"):
        logging.info(f"[METADATA] Steam missed data. Querying GOG API for: {title}...")
        try:
            gog_req = urllib.request.Request(f"https://embed.gog.com/games/ajax/filtered?mediaType=game&search={safe_title}")
            with urllib.request.urlopen(gog_req, timeout=3) as g_res:
                g_data = json.loads(g_res.read().decode())
                if g_data.get("products") and len(g_data["products"]) > 0:
                    p = g_data["products"][0]
                    rescued = False
                    
                    if not entry.get("cover_url") and p.get("image"):
                        entry["cover_url"] = f"https:{p['image']}_formatted_1080.jpg"
                        rescued = True
                    if not entry.get("developer") and p.get("developer"):
                        entry["developer"] = p["developer"].upper()
                        rescued = True
                    if not entry.get("publisher") and p.get("publisher"):
                        entry["publisher"] = p["publisher"].upper()
                        rescued = True
                    if not entry.get("release_year") and p.get("globalReleaseDate"):
                        entry["release_year"] = time.strftime('%Y', time.gmtime(p["globalReleaseDate"]))
                        rescued = True
                    
                    if rescued: logging.info(f"[METADATA] GOG API successfully provided missing data for: {title}")
        except Exception as err:
            logging.warning(f"[METADATA] GOG API fetch failed for '{title}': {err}")

    # 5. TWITCH ID CATALOGING
    if bc.get("twitch_client") and bc.get("twitch_token") and not entry.get("twitch_id"):
        headers = {'Client-Id': bc.get("twitch_client"), 'Authorization': f'Bearer {bc.get("twitch_token")}'}
        try:
            if entry.get("igdb_id"):
                t_res = requests.get(f'https://api.twitch.tv/helix/games?igdb_id={entry["igdb_id"]}', headers=headers, timeout=3)
                if t_res.status_code == 200 and t_res.json().get('data'):
                    entry["twitch_id"] = str(t_res.json()['data'][0]['id']) # FIX: Ensuring ID is saved as string
                    t_name = t_res.json()['data'][0]['name']
                    logging.info(f"[DB MANAGER] Cataloged Twitch Category via IGDB Bridge: {t_name} [ID: {entry['twitch_id']}]")
                elif t_res.status_code in [401, 403]:
                    logging.warning(f"[AUTH ALERT] Twitch API rejected token during background cataloging. Token expired.")

            if not entry.get("twitch_id"):
                t_res = requests.get(f'https://api.twitch.tv/helix/search/categories?query={safe_title}', headers=headers, timeout=3)
                if t_res.status_code == 200 and t_res.json().get('data') and len(t_res.json()['data']) > 0:
                    entry["twitch_id"] = str(t_res.json()['data'][0]['id']) # FIX: Ensuring ID is saved as string
                    t_name = t_res.json()['data'][0]['name']
                    logging.info(f"[DB MANAGER] Cataloged Twitch Category via Fuzzy Search: {t_name} [ID: {entry['twitch_id']}]")
        except Exception as e:
            logging.warning(f"[DB MANAGER] Twitch ID background lookup failed: {e}")

    # 6. KICK ID CATALOGING
    if not entry.get("kick_id"):
        kick_db = load_json(KICK_DB_PATH, {})
        if kick_db:
            if title in kick_db:
                entry["kick_id"] = str(kick_db[title])
            else:
                matches = difflib.get_close_matches(title, kick_db.keys(), n=1, cutoff=0.8)
                if matches: entry["kick_id"] = str(kick_db[matches[0]])
            if entry.get("kick_id"): logging.info(f"[DB MANAGER] Cataloged Kick ID for '{title}': {entry['kick_id']}")

    status_data.update({"cover_url": entry.get("cover_url", ""), "release_date": entry.get("release_year", "UNKNOWN"), "genre": entry.get("genre", "GAMING"), "publisher": entry.get("publisher", "INDIE"), "developer": entry.get("developer", "INDIE")})
    
    with meta_lock:
        db = load_json(CUSTOM_META_PATH, {})
        if vault_key not in db: db[vault_key] = {"title": title, "genre": "", "release_year": "", "developer": "", "publisher": "", "twitch_id": "", "kick_id": "", "cover_url": "", "igdb_id": ""}
        for k, v in entry.items():
            if v: db[vault_key][k] = v
        save_json(CUSTOM_META_PATH, db)


    if load_json(CONFIG_PATH, DEFAULT_CONFIG).get("engine_settings", {}).get("auto_push", False):
        time.sleep(2)
        trigger_category_update(title)

# === STANDALONE ROUTING & API UPDATERS ===
def get_readable_error(status_code):
    errors = { 400: "BAD SETTINGS", 401: "INVALID TOKEN", 403: "NO PERMISSION", 404: "NOT FOUND", 429: "RATE LIMITED", 500: "SERVER CRASH", 502: "PLATFORM DOWN", 503: "PLATFORM DOWN" }
    return errors.get(status_code, f"API ERROR ({status_code})")

def update_twitch_category(game_title, client_id, token, broadcaster_id, retry=True):
    global broadcast_status
    if not all([client_id, token, broadcaster_id]): 
        broadcast_status["twitch"] = "MISSING KEYS"
        return
    
    broadcast_status["twitch"] = "PUSHING..."
    headers = {'Client-Id': client_id, 'Authorization': f'Bearer {token}'}
    meta = load_json(CUSTOM_META_PATH, {}).get(game_title.lower().strip(), {})
    game_id = meta.get("twitch_id")
    target_name = game_title 
    
    try:
        if not game_id:
            logging.info(f"[NATIVE] Twitch ID missing from vault. Doing quick fallback search for: '{game_title}'...")
            res = requests.get(f'https://api.twitch.tv/helix/search/categories?query={urllib.parse.quote(game_title)}', headers=headers, timeout=3)
            if res.status_code == 401 and retry:
                new_token = refresh_twitch_token()
                if new_token: return update_twitch_category(game_title, client_id, new_token, broadcaster_id, retry=False)
            if res.status_code == 200 and res.json().get('data') and len(res.json()['data']) > 0:
                game_id = str(res.json()['data'][0]['id'])
                target_name = res.json()['data'][0]['name']

        if game_id:
            patch_res = requests.patch(f'https://api.twitch.tv/helix/channels?broadcaster_id={broadcaster_id}', json={'game_id': game_id}, headers=headers, timeout=3)
            
            if patch_res.status_code == 204: 
                logging.info(f"[NATIVE] Twitch successfully updated to: {target_name} [ID: {game_id}]")
                broadcast_status["twitch"] = "LIVE"
                if not meta.get("twitch_id"): update_meta_field(game_title, "twitch_id", game_id)
            elif patch_res.status_code == 401 and retry:
                new_token = refresh_twitch_token()
                if new_token: return update_twitch_category(game_title, client_id, new_token, broadcaster_id, retry=False)
            else: 
                logging.warning(f"[NATIVE] Twitch API rejected ID {game_id}. Error: {patch_res.status_code}")
                broadcast_status["twitch"] = get_readable_error(patch_res.status_code)
        else:
            logging.warning(f"[NATIVE] Twitch database could not resolve title: '{game_title}'.")
            broadcast_status["twitch"] = "GAME NOT FOUND"
            
    except Exception as e: 
        logging.error(f"[NATIVE] Twitch Network Error: {e}")
        broadcast_status["twitch"] = "OFFLINE"

def update_kick_category(game_title, token, channel_id, retry=True):
    global broadcast_status
    if not all([token, channel_id]): 
        broadcast_status["kick"] = "MISSING KEYS"
        return
        
    broadcast_status["kick"] = "PUSHING..."
    headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/json', 'Content-Type': 'application/json'}
    target_name = game_title
    meta = load_json(CUSTOM_META_PATH, {}).get(game_title.lower().strip(), {})
    category_id = meta.get("kick_id")

    api_error = ""

    try:
        if not category_id:
            logging.info(f"[NATIVE] Kick ID missing. Querying V2 API for: '{game_title}'...")
            res_v2 = requests.get(f'https://api.kick.com/public/v2/categories?name={urllib.parse.quote(game_title)}', headers=headers, timeout=5)
            
            if res_v2.status_code == 401 and retry:
                new_token = refresh_kick_token()
                if new_token: return update_kick_category(game_title, new_token, channel_id, retry=False)
            
            if res_v2.status_code == 200:
                raw_res = res_v2.json()
                cat_list = raw_res.get('data', [])
                if cat_list and len(cat_list) > 0:
                    category_id, target_name = str(cat_list[0]['id']), cat_list[0]['name']
                    logging.info(f"[NATIVE] Kick V2 resolved title to ID: {category_id}")

            if not category_id:
                logging.info(f"[NATIVE] V2 missed. Falling back to V1 API for: '{game_title}'...")
                res_v1 = requests.get(f'https://api.kick.com/public/v1/categories?q={urllib.parse.quote(game_title)}', headers=headers, timeout=5)
                if res_v1.status_code == 200:
                    raw_res = res_v1.json()
                    cat_list = raw_res.get('data', []) if isinstance(raw_res, dict) else (raw_res if isinstance(raw_res, list) else [])
                    if cat_list and len(cat_list) > 0:
                        category_id, target_name = str(cat_list[0]['id']), cat_list[0]['name']
                        logging.info(f"[NATIVE] Kick V1 resolved title to ID: {category_id}")

        if category_id:
            patch_res = requests.patch('https://api.kick.com/public/v1/channels', json={'category_id': int(category_id)}, headers=headers, timeout=5)
            if patch_res.status_code in [200, 204]: 
                logging.info(f"[NATIVE] Kick successfully updated to: {target_name} [ID: {category_id}]")
                broadcast_status["kick"] = "LIVE"
                if not meta.get("kick_id"): update_meta_field(game_title, "kick_id", category_id)
                return
            elif patch_res.status_code == 401 and retry:
                new_token = refresh_kick_token()
                if new_token: return update_kick_category(game_title, new_token, channel_id, retry=False)
            else: 
                api_error = get_readable_error(patch_res.status_code)
                logging.warning(f"[NATIVE] Kick API rejected ID {category_id}. Error: {patch_res.status_code}")
                
        broadcast_status["kick"] = api_error if api_error else "GAME NOT FOUND"
                
    except Exception as e: 
        logging.error(f"[NATIVE] Kick Network Error: {e}")
        broadcast_status["kick"] = "OFFLINE"

def trigger_category_update(category):
    global broadcast_status
    config = load_json(CONFIG_PATH, DEFAULT_CONFIG)
    settings = config.get("engine_settings", {})
    broadcaster = config.get("broadcaster", {})
    routing_mode = broadcaster.get("routing_mode", "streamer_bot")
    
    if settings.get("safe_mode", False):
        broadcast_status["twitch"] = "SAFE MODE"
        broadcast_status["kick"] = "SAFE MODE"
        return {"status": "success"}
        
    if routing_mode == "streamer_bot":
        broadcast_status["streamer_bot"] = "PUSHING..."
        try:
            requests.post(f'http://127.0.0.1:{settings.get("sb_port", 8080)}/DoAction', json={ "action": { "name": "UpdateCategory" }, "args": { "category": category } }, timeout=2)
            broadcast_status["streamer_bot"] = "PING SENT"
        except: broadcast_status["streamer_bot"] = "UNREACHABLE"
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
    except: return None, None
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
        status_data["game_title"] = selected_title
        status_data["pending_bundle"] = False
        status_data["bundle_options"] = []
        logging.info(f"[BUNDLE BREAKER] User locked in selection: {selected_title}")
        
        vault = load_json(VAULT_PATH, DEFAULT_VAULT)
        if status_data["process_name"].lower() not in vault["delisted_apps"]:
            vault["listed_apps"][status_data["process_name"].lower()] = selected_title
            save_json(VAULT_PATH, vault)
        
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
def serve_kick_db():
    return jsonify(list(load_json(KICK_DB_PATH, {}).keys()))

@app.route('/list', methods=['POST', 'OPTIONS'])
@require_local_auth
def list_app():
    data = request.json
    title = data['title']
    vault = load_json(VAULT_PATH, DEFAULT_VAULT)
    if data.get('process'):
        vault["listed_apps"][data['process'].lower()] = title
        save_json(VAULT_PATH, vault)
        
    vault_key = title.lower().strip()
    with meta_lock:
        meta_vault = load_json(CUSTOM_META_PATH, {})
        if vault_key not in meta_vault: meta_vault[vault_key] = {"title": title, "genre": "", "release_year": "", "developer": "", "publisher": "", "twitch_id": "", "kick_id": "", "cover_url": "", "igdb_id": ""}
        
        if data.get('custom_url'): meta_vault[vault_key]['cover_url'] = data['custom_url']
        if data.get('custom_release'): meta_vault[vault_key]['release_year'] = data['custom_release']
        if data.get('custom_genre'): meta_vault[vault_key]['genre'] = data['custom_genre']
        if data.get('custom_publisher'): meta_vault[vault_key]['publisher'] = data['custom_publisher']
        if data.get('custom_developer'): meta_vault[vault_key]['developer'] = data['custom_developer']
        if data.get('custom_twitch_id'): meta_vault[vault_key]['twitch_id'] = data['custom_twitch_id']
        if data.get('custom_kick_id'): meta_vault[vault_key]['kick_id'] = data['custom_kick_id']
        save_json(CUSTOM_META_PATH, meta_vault)
        
    if status_data.get("game_title", "").lower().strip() == vault_key:
        threading.Thread(target=fetch_metadata, args=(status_data["game_title"],), daemon=True).start()
    return jsonify({"status": "success"})

@app.route('/delist', methods=['POST', 'OPTIONS'])
@require_local_auth
def delist_app():
    proc_name = request.json.get('process')
    if proc_name:
        vault = load_json(VAULT_PATH, DEFAULT_VAULT)
        clean_proc = proc_name.lower().strip()
        if clean_proc not in vault["delisted_apps"]:
            vault["delisted_apps"].append(clean_proc)
            save_json(VAULT_PATH, vault)
    return jsonify({"status": "success"})

@app.route('/logs')
def get_logs():
    try:
        with open(LOG_PATH, 'r') as f: return jsonify({"logs": f.readlines()[-20:]})
    except: return jsonify({"logs": []})

@app.route('/clear-logs', methods=['POST', 'OPTIONS'])
@require_local_auth
def clear_logs():
    with open(LOG_PATH, 'w') as f: f.write("System logs purged.\n")
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
        
        current_config["api_keys"]["rawg"] = data.get("rawg_key", "")
        current_config["api_keys"]["steamgrid"] = data.get("sgdb_key", "")
        current_config["api_keys"]["igdb_client"] = data.get("igdb_client", "")
        current_config["api_keys"]["igdb_secret"] = data.get("igdb_secret", "")
        
        current_config["broadcaster"]["routing_mode"] = data.get("routing_mode", "streamer_bot")
        current_config["broadcaster"]["twitch_client"] = data.get("twitch_client", "")
        current_config["broadcaster"]["twitch_secret"] = data.get("twitch_secret", "")
        
        current_config["broadcaster"]["kick_client"] = data.get("kick_client", "")
        current_config["broadcaster"]["kick_secret"] = data.get("kick_secret", "")
        current_config["broadcaster"]["kick_channel_id"] = data.get("kick_channel_id", "")
        
        save_json(CONFIG_PATH, current_config)
        return jsonify({"status": "success"})
    
    flat_data = {**current_config["engine_settings"]}
    flat_data["rawg_key"] = current_config["api_keys"].get("rawg", "")
    flat_data["sgdb_key"] = current_config["api_keys"].get("steamgrid", "")
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
    result = trigger_category_update(category)
    return jsonify(result or {"status": "success"})

@app.route('/shutdown', methods=['POST', 'OPTIONS'])
@require_local_auth
def shutdown_engine():
    threading.Timer(1.0, lambda: os._exit(0)).start()
    return jsonify({"status": "success"})

@app.route('/repair-engine', methods=['POST', 'OPTIONS'])
@require_local_auth
def repair_engine():
    def run_repair():
        py_deps = [sys.executable, "-m", "pip", "install", "flask", "flask-cors", "requests", "pillow", "psutil", "pyyaml"]
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "--upgrade", "pip"])
            subprocess.check_call(py_deps)
            if CURRENT_OS == "Windows": subprocess.check_call([sys.executable, "-m", "pip", "install", "pywin32"])
        except Exception as e: 
            logging.error(f"[SYSTEM] Engine auto-repair failed: {e}")
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
        if status_data.get("pending_bundle"):
            time.sleep(1)
            continue
            
        vault = load_json(VAULT_PATH, DEFAULT_VAULT)
        listed_lower_map = vault.get("listed_apps", {})
        delisted = vault.get("delisted_apps", [])
        
        window_title, active_exe = get_active_window_info()
        if window_title and active_exe:
            active_lower = active_exe.lower()
            core_ignores = ['explorer.exe', 'cmd.exe', 'terminal', 'iterm2', 'finder', 'dock', 'systemsettings', 'taskmgr.exe']
            if active_lower not in delisted and active_lower not in core_ignores and active_lower not in listed_lower_map:
                vault["listed_apps"][active_lower] = window_title
                save_json(VAULT_PATH, vault)
                listed_lower_map[active_lower] = window_title 
                logging.info(f"[AUTO-FORGE] Scout: {window_title} ({active_exe})")

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
                        logging.info(f"[SCANNER] Found: {game_title}")
                        threading.Thread(target=fetch_metadata, args=(game_title,), daemon=True).start()
                    break
            except: continue
        
        if not found and status_data["is_playing"]:
            missed_scans += 1
            if missed_scans >= 8:
                status_data.update({"is_playing": False, "game_title": idle_cat, "process_name": "", "start_time": 0})
                logging.info(f"[SCANNER] Reverting: {idle_cat}")
                
                if load_json(CONFIG_PATH, DEFAULT_CONFIG).get("engine_settings", {}).get("auto_push", False):
                    trigger_category_update(idle_cat)
        
        time.sleep(load_json(CONFIG_PATH, DEFAULT_CONFIG).get("engine_settings", {}).get("scan_interval", 5))

# === SYSTEM IGNITION ===
if __name__ == '__main__':
    threading.Thread(target=keep_kick_db_synced, daemon=True).start()
    threading.Thread(target=monitor_games, daemon=True).start()
    app.run(host='127.0.0.1', port=5050)