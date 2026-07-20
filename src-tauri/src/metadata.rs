//! External game-metadata scan for `/api/scan-metadata`.
//!
//! Sources, queried in this order (each skipped on any network failure or
//! missing key — a scan never hard-fails):
//! - RAWG: year, genre, developer, publisher, cover, rawg_id (needs key)
//! - IGDB: same via apicalypse (Twitch app token fetched if needed), igdb_id
//!   (needs key)
//! - Steam: year, genre, developer, publisher, cover, steam_id — public
//!   storefront endpoints (store.steampowered.com), no key needed
//! - GOG: same via the public catalog.gog.com search, gog_id, no key needed
//! - SteamGridDB: preferred 600x900 cover, sgdb_id (needs key; overrides the
//!   cover_url from every other source once fetched, since it's a
//!   purpose-built cover-art database)
//! - TheGamesDB: queried last among the metadata sources above — a
//!   community-run database with much stronger coverage of older/retro
//!   console games than RAWG or IGDB, so it only fills in what they missed
//!   (needs key), thegamesdb_id
//! - Twitch/Kick: category IDs looked up live by title (needs an active
//!   connection to that platform — Client ID + token), not fetched from a
//!   metadata database at all
//!
//! Merge strategy: only EMPTY fields of the existing entry are filled, so
//! user-set/custom values always win.

use std::time::Duration;

use crate::config::{
    ApiKeys, BroadcasterConfig, ForgeDatabase, ForgeLibraryEntry, SyncHistoryEntry,
};

/// Fill empty fields of `existing` from `fetched` — except fields the user
/// has locked (see ForgeLibraryEntry::locked_fields), which are never
/// touched even if currently empty. A plain "only if empty" check can't
/// distinguish "never scanned yet" from "user intentionally cleared this";
/// locking is what actually makes a manual edit stick. Pure — unit tested
/// below.
pub fn merge_entry(
    mut existing: ForgeLibraryEntry,
    fetched: &ForgeLibraryEntry,
) -> ForgeLibraryEntry {
    macro_rules! fill {
        ($($f:ident),*) => {$(
            if existing.$f.is_empty()
                && !fetched.$f.is_empty()
                && !existing.locked_fields.iter().any(|f| f == stringify!($f))
            {
                existing.$f = fetched.$f.clone();
            }
        )*};
    }
    fill!(
        genre,
        release_year,
        developer,
        publisher,
        cover_url,
        logo_url,
        igdb_id,
        rawg_id,
        sgdb_id,
        steam_id,
        gog_id,
        thegamesdb_id,
        twitch_id,
        kick_id
    );
    existing
}

/// Like `merge_entry`, but for metadata that's been cryptographically
/// verified as coming from BearddOddity's curated database (see
/// `metadata_signing` and the signed-import paths in `lib.rs`): a
/// signature-checked field is trusted enough to overwrite a value that's
/// already there, not just fill in a blank one. Still respects
/// `locked_fields` — a user's own manual lock is "don't touch this on my
/// machine," independent of how much the source is trusted. Covers every
/// shareable metadata field, including the three (`discord_app_id`,
/// `xbox_title_id`, `epic_id`) that regular scans don't fill in.
pub fn overwrite_entry(
    mut existing: ForgeLibraryEntry,
    fetched: &ForgeLibraryEntry,
) -> ForgeLibraryEntry {
    macro_rules! fill {
        ($($f:ident),*) => {$(
            if !fetched.$f.is_empty()
                && !existing.locked_fields.iter().any(|f| f == stringify!($f))
            {
                existing.$f = fetched.$f.clone();
            }
        )*};
    }
    fill!(
        genre,
        release_year,
        developer,
        publisher,
        cover_url,
        logo_url,
        igdb_id,
        rawg_id,
        sgdb_id,
        steam_id,
        gog_id,
        thegamesdb_id,
        twitch_id,
        kick_id,
        discord_app_id,
        xbox_title_id,
        epic_id
    );
    existing
}

/// Scan all configured sources for `title` and merge the results into `existing`.
pub async fn scan(
    title: &str,
    keys: &ApiKeys,
    broadcaster: &BroadcasterConfig,
    existing: ForgeLibraryEntry,
) -> ForgeLibraryEntry {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[META] HTTP client build failed: {}", e);
            return existing;
        }
    };

    // Accumulate fetched data source by source; SGDB cover overrides the rest.
    let mut fetched = ForgeLibraryEntry::default();

    if !keys.rawg.is_empty() {
        match fetch_rawg(&client, title, &keys.rawg).await {
            Ok(e) => fetched = merge_entry(fetched, &e),
            Err(e) => log::warn!("[META] RAWG failed: {}", e),
        }
    }

    if !keys.igdb_client.is_empty() && (!keys.igdb_token.is_empty() || !keys.igdb_secret.is_empty())
    {
        match fetch_igdb(&client, title, keys).await {
            Ok(e) => fetched = merge_entry(fetched, &e),
            Err(e) => log::warn!("[META] IGDB failed: {}", e),
        }
    }

    // Steam and GOG use each store's own public storefront/catalog endpoints —
    // no API key required, so these always run (unlike RAWG/IGDB/SGDB above).
    match fetch_steam(&client, title).await {
        Ok(e) => fetched = merge_entry(fetched, &e),
        Err(e) => log::warn!("[META] Steam failed: {}", e),
    }

    match fetch_gog(&client, title).await {
        Ok(e) => fetched = merge_entry(fetched, &e),
        Err(e) => log::warn!("[META] GOG failed: {}", e),
    }

    if !keys.thegamesdb.is_empty() {
        match fetch_thegamesdb(&client, title, &keys.thegamesdb).await {
            Ok(e) => fetched = merge_entry(fetched, &e),
            Err(e) => log::warn!("[META] TheGamesDB failed: {}", e),
        }
    }

    if !keys.steamgrid.is_empty() {
        match fetch_sgdb(&client, title, &keys.steamgrid).await {
            Ok((id, cover, logo)) => {
                fetched.sgdb_id = id;
                if !cover.is_empty() {
                    fetched.cover_url = cover; // SGDB cover preferred over RAWG/IGDB
                }
                fetched.logo_url = logo;
            }
            Err(e) => log::warn!("[META] SteamGridDB failed: {}", e),
        }
    }

    // Not metadata sources — these look up each platform's *category* ID by
    // title, which only works while actually connected to that platform.
    if !broadcaster.twitch_client.is_empty() && !broadcaster.twitch_token.is_empty() {
        match fetch_twitch_id(
            &client,
            title,
            &broadcaster.twitch_client,
            &broadcaster.twitch_token,
        )
        .await
        {
            Ok(id) => fetched.twitch_id = id,
            Err(e) => log::warn!("[META] Twitch category lookup failed: {}", e),
        }
    }

    if !broadcaster.kick_token.is_empty() {
        match fetch_kick_id(&client, title, &broadcaster.kick_token).await {
            Ok(id) => fetched.kick_id = id,
            Err(e) => log::warn!("[META] Kick category lookup failed: {}", e),
        }
    }

    merge_entry(existing, &fetched)
}

async fn get_json(req: reqwest::RequestBuilder) -> Result<serde_json::Value, String> {
    req.send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

async fn fetch_rawg(
    client: &reqwest::Client,
    title: &str,
    key: &str,
) -> Result<ForgeLibraryEntry, String> {
    let url = format!(
        "https://api.rawg.io/api/games?key={}&search={}&page_size=1",
        urlencoding::encode(key),
        urlencoding::encode(title)
    );
    let json = get_json(client.get(&url)).await?;
    let g = json["results"].get(0).ok_or("no RAWG results")?;
    Ok(ForgeLibraryEntry {
        release_year: g["released"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(4)
            .collect(),
        genre: g["genres"][0]["name"].as_str().unwrap_or("").to_string(),
        developer: g["developers"][0]["name"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        publisher: g["publishers"][0]["name"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        cover_url: g["background_image"].as_str().unwrap_or("").to_string(),
        rawg_id: g["id"].as_u64().map(|v| v.to_string()).unwrap_or_default(),
        ..Default::default()
    })
}

async fn igdb_app_token(
    client: &reqwest::Client,
    client_id: &str,
    secret: &str,
) -> Result<String, String> {
    let url = format!(
        "https://id.twitch.tv/oauth2/token?client_id={}&client_secret={}&grant_type=client_credentials",
        urlencoding::encode(client_id),
        urlencoding::encode(secret)
    );
    let json = get_json(client.post(&url)).await?;
    json["access_token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "no IGDB app token in response".to_string())
}

async fn fetch_igdb(
    client: &reqwest::Client,
    title: &str,
    keys: &ApiKeys,
) -> Result<ForgeLibraryEntry, String> {
    let token = if !keys.igdb_token.is_empty() {
        keys.igdb_token.clone()
    } else {
        igdb_app_token(client, &keys.igdb_client, &keys.igdb_secret).await?
    };

    // Strip quote/backslash so the title can't break out of the apicalypse string.
    let safe_title: String = title.chars().filter(|c| *c != '"' && *c != '\\').collect();
    let body = format!(
        "search \"{}\"; fields name,genres.name,involved_companies.company.name,involved_companies.developer,involved_companies.publisher,first_release_date,cover.image_id; limit 1;",
        safe_title
    );

    let json = get_json(
        client
            .post("https://api.igdb.com/v4/games")
            .header("Client-ID", &keys.igdb_client)
            .header("Authorization", format!("Bearer {}", token))
            .body(body),
    )
    .await?;
    let g = json.get(0).ok_or("no IGDB results")?;

    let mut developer = String::new();
    let mut publisher = String::new();
    if let Some(companies) = g["involved_companies"].as_array() {
        for c in companies {
            let name = c["company"]["name"].as_str().unwrap_or("");
            if name.is_empty() {
                continue;
            }
            if c["developer"].as_bool().unwrap_or(false) && developer.is_empty() {
                developer = name.to_string();
            }
            if c["publisher"].as_bool().unwrap_or(false) && publisher.is_empty() {
                publisher = name.to_string();
            }
        }
    }

    // ponytail: year-from-unix-ts via mean tropical year — off only within
    // hours of New Year, plenty for a release *year*.
    let release_year = g["first_release_date"]
        .as_i64()
        .map(|ts| (1970 + ts / 31_556_952).to_string())
        .unwrap_or_default();

    let cover_url = g["cover"]["image_id"]
        .as_str()
        .map(|id| {
            format!(
                "https://images.igdb.com/igdb/image/upload/t_cover_big/{}.jpg",
                id
            )
        })
        .unwrap_or_default();

    Ok(ForgeLibraryEntry {
        genre: g["genres"][0]["name"].as_str().unwrap_or("").to_string(),
        release_year,
        developer,
        publisher,
        cover_url,
        igdb_id: g["id"].as_u64().map(|v| v.to_string()).unwrap_or_default(),
        ..Default::default()
    })
}

/// Steam's own storefront endpoints (store.steampowered.com) — public, no API
/// key. Two calls: an unofficial-but-widely-used search endpoint to resolve
/// the title to an appid, then the appdetails endpoint for the actual data.
async fn fetch_steam(client: &reqwest::Client, title: &str) -> Result<ForgeLibraryEntry, String> {
    let search_url = format!(
        "https://store.steampowered.com/api/storesearch/?term={}&l=english&cc=US",
        urlencoding::encode(title)
    );
    let search_json = get_json(client.get(&search_url)).await?;
    let appid = search_json["items"][0]["id"]
        .as_u64()
        .ok_or("no Steam search results")?;

    let details_url = format!(
        "https://store.steampowered.com/api/appdetails?appids={}",
        appid
    );
    let details_json = get_json(client.get(&details_url)).await?;
    let entry = &details_json[appid.to_string()];
    if !entry["success"].as_bool().unwrap_or(false) {
        return Err(format!(
            "Steam appdetails returned success=false for {}",
            appid
        ));
    }
    let data = &entry["data"];

    // "25 Jan, 2018" -> "2018"; unreleased titles have a non-numeric last
    // token (e.g. "Coming soon"), which correctly falls through to empty.
    let release_year = data["release_date"]["date"]
        .as_str()
        .and_then(|d| d.split(' ').next_back())
        .filter(|y| y.len() == 4 && y.chars().all(|c| c.is_ascii_digit()))
        .unwrap_or("")
        .to_string();

    Ok(ForgeLibraryEntry {
        genre: data["genres"][0]["description"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        release_year,
        developer: data["developers"][0].as_str().unwrap_or("").to_string(),
        publisher: data["publishers"][0].as_str().unwrap_or("").to_string(),
        cover_url: data["header_image"].as_str().unwrap_or("").to_string(),
        steam_id: appid.to_string(),
        ..Default::default()
    })
}

/// GOG's public catalog search (catalog.gog.com) — no API key required.
async fn fetch_gog(client: &reqwest::Client, title: &str) -> Result<ForgeLibraryEntry, String> {
    let url = format!(
        "https://catalog.gog.com/v1/catalog?limit=1&query=like:{}",
        urlencoding::encode(title)
    );
    let json = get_json(client.get(&url)).await?;
    let p = json["products"].get(0).ok_or("no GOG results")?;

    // "2015.05.19" -> "2015"
    let release_year = p["releaseDate"]
        .as_str()
        .filter(|d| d.len() >= 4)
        .map(|d| d[..4].to_string())
        .unwrap_or_default();

    Ok(ForgeLibraryEntry {
        genre: p["genres"][0]["name"].as_str().unwrap_or("").to_string(),
        release_year,
        developer: p["developers"][0].as_str().unwrap_or("").to_string(),
        publisher: p["publishers"][0].as_str().unwrap_or("").to_string(),
        cover_url: p["coverVertical"].as_str().unwrap_or("").to_string(),
        gog_id: p["id"].as_str().unwrap_or("").to_string(),
        ..Default::default()
    })
}

/// TheGamesDB's `/Genres`, `/Developers`, and `/Publishers` endpoints each
/// return a flat id -> name table (the game-search results only carry ids,
/// not names) — this fetches whichever table `endpoint` names and maps it.
async fn thegamesdb_name_table(
    client: &reqwest::Client,
    endpoint: &str,
    data_key: &str,
    key: &str,
) -> Result<std::collections::HashMap<u64, String>, String> {
    let url = format!(
        "https://api.thegamesdb.net/v1/{}?apikey={}",
        endpoint,
        urlencoding::encode(key)
    );
    let json = get_json(client.get(&url)).await?;
    let table = json["data"][data_key]
        .as_object()
        .ok_or_else(|| format!("no {} table in TheGamesDB response", data_key))?;
    Ok(table
        .values()
        .filter_map(|entry| {
            let id = entry["id"].as_u64()?;
            let name = entry["name"].as_str()?.to_string();
            Some((id, name))
        })
        .collect())
}

/// TheGamesDB (api.thegamesdb.net) — a community-run, retro-console-friendly
/// game database. Unlike RAWG/IGDB, its search results carry only numeric
/// genre/developer/publisher ids, so resolving names takes three follow-up
/// lookups against its id -> name tables.
///
/// Written against TheGamesDB's official v1 OpenAPI spec rather than a live
/// response (this session couldn't reach api.thegamesdb.net directly) — the
/// spec's `fields` param is required for `genres`/`developers`/`publishers`
/// to appear at all, which is easy to miss and would otherwise silently
/// leave those fields empty on every real call. Smoke-test with a real key
/// (`thegamesdb_returns_real_data` below) if TheGamesDB ever changes its
/// response envelope.
async fn fetch_thegamesdb(
    client: &reqwest::Client,
    title: &str,
    key: &str,
) -> Result<ForgeLibraryEntry, String> {
    let search_url = format!(
        "https://api.thegamesdb.net/v1/Games/ByGameName?apikey={}&name={}&fields=genres,publishers,developers&include=boxart",
        urlencoding::encode(key),
        urlencoding::encode(title)
    );
    let json = get_json(client.get(&search_url)).await?;
    let g = json["data"]["games"]
        .as_array()
        .and_then(|games| games.first())
        .ok_or("no TheGamesDB results")?;

    let game_id = g["id"].as_u64().ok_or("TheGamesDB result missing id")?;

    let genre_id = g["genres"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|v| v.as_u64());
    let dev_id = g["developers"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|v| v.as_u64());
    let pub_id = g["publishers"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|v| v.as_u64());

    let genre = match genre_id {
        Some(id) => thegamesdb_name_table(client, "Genres", "genres", key)
            .await
            .ok()
            .and_then(|table| table.get(&id).cloned())
            .unwrap_or_default(),
        None => String::new(),
    };
    let developer = match dev_id {
        Some(id) => thegamesdb_name_table(client, "Developers", "developers", key)
            .await
            .ok()
            .and_then(|table| table.get(&id).cloned())
            .unwrap_or_default(),
        None => String::new(),
    };
    let publisher = match pub_id {
        Some(id) => thegamesdb_name_table(client, "Publishers", "publishers", key)
            .await
            .ok()
            .and_then(|table| table.get(&id).cloned())
            .unwrap_or_default(),
        None => String::new(),
    };

    // "2004-11-16" -> "2004"
    let release_year = g["release_date"]
        .as_str()
        .filter(|d| d.len() >= 4)
        .map(|d| d[..4].to_string())
        .unwrap_or_default();

    // Boxart lives in the `include` block, keyed by game id, and needs the
    // matching base_url size prefixed onto its filename — the search result
    // itself never carries a direct image URL.
    let cover_url = json["include"]["boxart"]["data"][game_id.to_string()]
        .as_array()
        .and_then(|arts| arts.iter().find(|a| a["side"].as_str() == Some("front")))
        .and_then(|art| art["filename"].as_str())
        .and_then(|filename| {
            json["include"]["boxart"]["base_url"]["large"]
                .as_str()
                .map(|base| format!("{}{}", base, filename))
        })
        .unwrap_or_default();

    Ok(ForgeLibraryEntry {
        genre,
        release_year,
        developer,
        publisher,
        cover_url,
        thegamesdb_id: game_id.to_string(),
        ..Default::default()
    })
}

/// Twitch category id for `title`, via Helix's Get Games (same lookup
/// pusher.rs falls back to at push-time when the library has no id yet).
async fn fetch_twitch_id(
    client: &reqwest::Client,
    title: &str,
    client_id: &str,
    token: &str,
) -> Result<String, String> {
    let json = get_json(
        client
            .get("https://api.twitch.tv/helix/games")
            .query(&[("name", title)])
            .header("Client-Id", client_id)
            .header("Authorization", format!("Bearer {}", token)),
    )
    .await?;
    let id = json["data"][0]["id"].as_str().unwrap_or("").to_string();
    if id.is_empty() {
        return Err("no Twitch game found for this title".to_string());
    }
    Ok(id)
}

/// Kick category id for `title`, via the public categories search (the
/// `name` filter on /public/v2/categories) — no key needed beyond a valid
/// user token, since this endpoint's security scheme accepts any token type.
async fn fetch_kick_id(
    client: &reqwest::Client,
    title: &str,
    token: &str,
) -> Result<String, String> {
    let json = get_json(
        client
            .get("https://api.kick.com/public/v2/categories")
            .query(&[("name", title), ("limit", "1")])
            .bearer_auth(token),
    )
    .await?;
    let id = json["data"][0]["id"].as_u64();
    match id {
        Some(id) => Ok(id.to_string()),
        None => Err("no Kick category found for this title".to_string()),
    }
}

/// One detected Twitch/Kick category-id drift, surfaced to the frontend so
/// it can toast something like "Dark Souls III category updated on Twitch".
pub struct SyncChange {
    pub title: String,
    pub platform: String,
    pub old_id: String,
    pub new_id: String,
}

const SYNC_HISTORY_MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60;

/// Re-checks every library entry's Twitch/Kick category id against the live
/// platform lookup. Category ids aren't permanently fixed — a rename or
/// re-issue on Twitch/Kick's end would otherwise make broadcasts silently
/// target a stale id until someone happens to re-scan the game by hand.
///
/// Only entries with at least one platform id already set get checked (and
/// get a sync_history record) — nothing to verify for a game that's never
/// been linked to a category. Each entry's sync_history is also pruned down
/// to the last 7 days here, regardless of whether anything changed, since
/// older check-ins aren't useful for troubleshooting and just take up space.
pub async fn weekly_library_sync(
    db: &mut ForgeDatabase,
    broadcaster: &BroadcasterConfig,
    now_secs: u64,
) -> Vec<SyncChange> {
    let mut changes = Vec::new();
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[SYNC] HTTP client build failed: {}", e);
            return changes;
        }
    };

    let twitch_ready =
        !broadcaster.twitch_client.is_empty() && !broadcaster.twitch_token.is_empty();
    let kick_ready = !broadcaster.kick_token.is_empty();

    for (title, entry) in db.library.iter_mut() {
        if entry.twitch_id.is_empty() && entry.kick_id.is_empty() {
            continue;
        }

        let mut entry_changes = Vec::new();

        if twitch_ready && !entry.twitch_id.is_empty() {
            match fetch_twitch_id(
                &client,
                title,
                &broadcaster.twitch_client,
                &broadcaster.twitch_token,
            )
            .await
            {
                Ok(live_id) if !live_id.is_empty() && live_id != entry.twitch_id => {
                    entry_changes.push(format!("twitch: {} -> {}", entry.twitch_id, live_id));
                    changes.push(SyncChange {
                        title: title.clone(),
                        platform: "Twitch".to_string(),
                        old_id: entry.twitch_id.clone(),
                        new_id: live_id.clone(),
                    });
                    entry.twitch_id = live_id;
                }
                Ok(_) => {}
                Err(e) => log::warn!("[SYNC] Twitch category check failed for {}: {}", title, e),
            }
        }

        if kick_ready && !entry.kick_id.is_empty() {
            match fetch_kick_id(&client, title, &broadcaster.kick_token).await {
                Ok(live_id) if !live_id.is_empty() && live_id != entry.kick_id => {
                    entry_changes.push(format!("kick: {} -> {}", entry.kick_id, live_id));
                    changes.push(SyncChange {
                        title: title.clone(),
                        platform: "Kick".to_string(),
                        old_id: entry.kick_id.clone(),
                        new_id: live_id.clone(),
                    });
                    entry.kick_id = live_id;
                }
                Ok(_) => {}
                Err(e) => log::warn!("[SYNC] Kick category check failed for {}: {}", title, e),
            }
        }

        entry.sync_history.push(SyncHistoryEntry {
            timestamp: format!("{:010}", now_secs),
            action: "weekly_sync".to_string(),
            changes: if entry_changes.is_empty() {
                "none".to_string()
            } else {
                entry_changes.join(", ")
            },
        });
        prune_sync_history(&mut entry.sync_history, now_secs);
    }

    changes
}

/// Drops sync_history entries older than 7 days.
fn prune_sync_history(history: &mut Vec<SyncHistoryEntry>, now_secs: u64) {
    history.retain(|h| {
        h.timestamp
            .parse::<u64>()
            .map(|ts| now_secs.saturating_sub(ts) <= SYNC_HISTORY_MAX_AGE_SECS)
            .unwrap_or(false)
    });
}

/// Returns (sgdb_id, cover_url, logo_url) — cover/logo may be empty if
/// SteamGridDB has no 600x900 grid / no logo for this game.
async fn fetch_sgdb(
    client: &reqwest::Client,
    title: &str,
    key: &str,
) -> Result<(String, String, String), String> {
    let search_url = format!(
        "https://www.steamgriddb.com/api/v2/search/autocomplete/{}",
        urlencoding::encode(title)
    );
    let json = get_json(client.get(&search_url).bearer_auth(key)).await?;
    let id = json["data"][0]["id"]
        .as_u64()
        .ok_or("no SteamGridDB results")?;

    let grids_url = format!(
        "https://www.steamgriddb.com/api/v2/grids/game/{}?dimensions=600x900",
        id
    );
    let grids = get_json(client.get(&grids_url).bearer_auth(key)).await?;
    let cover = grids["data"][0]["url"].as_str().unwrap_or("").to_string();

    // Logos (transparent PNG game logos, distinct from grids/covers) —
    // best-effort: a missing logo shouldn't fail the whole SGDB fetch.
    let logos_url = format!("https://www.steamgriddb.com/api/v2/logos/game/{}", id);
    let logo = match get_json(client.get(&logos_url).bearer_auth(key)).await {
        Ok(logos) => logos["data"][0]["url"].as_str().unwrap_or("").to_string(),
        Err(e) => {
            log::warn!("[META] SteamGridDB logo lookup failed: {}", e);
            String::new()
        }
    };

    Ok((id.to_string(), cover, logo))
}

/// Extracts the asset type + numeric id from a SteamGridDB *page* URL, e.g.
/// `https://www.steamgriddb.com/grid/805055` -> `("grids", 805055)`. That
/// page shows the asset in a browser but is HTML, not an image — pasted
/// straight into a cover/logo field, it'd just render as a broken `<img>`.
fn parse_steamgriddb_asset_url(url: &str) -> Option<(&'static str, u64)> {
    let path = url
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("www.")
        .strip_prefix("steamgriddb.com/")?;
    let mut segments = path.trim_end_matches('/').splitn(2, '/');
    let asset_type = match segments.next()? {
        "grid" => "grids",
        "hero" => "heroes",
        "logo" => "logos",
        "icon" => "icons",
        _ => return None,
    };
    let id_segment = segments.next()?;
    // Drop anything after the id (trailing slug/query/fragment).
    let id_str = id_segment.split(['/', '?', '#']).next()?;
    let id = id_str.parse::<u64>().ok()?;
    Some((asset_type, id))
}

/// Resolves a pasted cover/logo value into something an `<img>` can load.
/// A SteamGridDB page URL gets resolved via their API to the real CDN
/// image (needs the user's SteamGridDB key). Everything else — a direct
/// URL, a local file path — passes through unchanged.
pub async fn resolve_cover_field(value: &str, steamgrid_key: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let Some((asset_type, id)) = parse_steamgriddb_asset_url(trimmed) else {
        return Ok(value.to_string());
    };
    if steamgrid_key.is_empty() {
        return Err(
            "That's a SteamGridDB page link, not an image — add a SteamGridDB API key in \
             Settings to resolve it automatically, or right-click the image on that page and \
             copy its direct address instead."
                .to_string(),
        );
    }
    let client = reqwest::Client::new();
    let api_url = format!("https://www.steamgriddb.com/api/v2/{}/{}", asset_type, id);
    let json = get_json(client.get(&api_url).bearer_auth(steamgrid_key)).await?;
    json["data"]["url"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "SteamGridDB didn't return an image for that link".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_sync_history_drops_entries_older_than_7_days() {
        let now = 1_000_000_u64;
        let mut history = vec![
            SyncHistoryEntry {
                timestamp: format!("{:010}", now - 6 * 24 * 60 * 60), // 6 days old
                action: "weekly_sync".to_string(),
                changes: "none".to_string(),
            },
            SyncHistoryEntry {
                timestamp: format!("{:010}", now - 8 * 24 * 60 * 60), // 8 days old
                action: "weekly_sync".to_string(),
                changes: "none".to_string(),
            },
        ];
        prune_sync_history(&mut history, now);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].changes, "none");
    }

    #[test]
    fn prune_sync_history_drops_unparseable_timestamps() {
        let mut history = vec![SyncHistoryEntry {
            timestamp: "not-a-number".to_string(),
            action: "weekly_sync".to_string(),
            changes: "none".to_string(),
        }];
        prune_sync_history(&mut history, 1_000_000);
        assert!(history.is_empty());
    }

    #[test]
    fn parses_steamgriddb_grid_page_url() {
        assert_eq!(
            parse_steamgriddb_asset_url("https://www.steamgriddb.com/grid/805055"),
            Some(("grids", 805055))
        );
        // No scheme/www, trailing slash, and a trailing slug all tolerated.
        assert_eq!(
            parse_steamgriddb_asset_url("steamgriddb.com/grid/805055/"),
            Some(("grids", 805055))
        );
        assert_eq!(
            parse_steamgriddb_asset_url("https://www.steamgriddb.com/hero/12345"),
            Some(("heroes", 12345))
        );
        assert_eq!(
            parse_steamgriddb_asset_url("https://www.steamgriddb.com/logo/999"),
            Some(("logos", 999))
        );
        assert_eq!(
            parse_steamgriddb_asset_url("https://www.steamgriddb.com/icon/1"),
            Some(("icons", 1))
        );
    }

    #[test]
    fn rejects_non_asset_page_urls() {
        // A direct CDN image URL — not a page — should NOT match.
        assert_eq!(
            parse_steamgriddb_asset_url("https://cdn2.steamgriddb.com/grid/abc123.png"),
            None
        );
        assert_eq!(
            parse_steamgriddb_asset_url("https://example.com/grid/1"),
            None
        );
        assert_eq!(parse_steamgriddb_asset_url("not a url at all"), None);
        assert_eq!(
            parse_steamgriddb_asset_url("https://www.steamgriddb.com/game/12345"),
            None
        );
        // Non-numeric id.
        assert_eq!(
            parse_steamgriddb_asset_url("https://www.steamgriddb.com/grid/abc"),
            None
        );
    }

    #[test]
    fn merge_fills_only_empty_fields() {
        let existing = ForgeLibraryEntry {
            title: "Celeste".to_string(),
            developer: "User Set Dev".to_string(),
            cover_url: String::new(),
            ..Default::default()
        };
        let fetched = ForgeLibraryEntry {
            developer: "RAWG Dev".to_string(),
            cover_url: "http://sgdb/cover.jpg".to_string(),
            release_year: "2018".to_string(),
            ..Default::default()
        };
        let merged = merge_entry(existing, &fetched);
        assert_eq!(merged.developer, "User Set Dev"); // user value wins
        assert_eq!(merged.cover_url, "http://sgdb/cover.jpg"); // empty gets filled
        assert_eq!(merged.release_year, "2018");
        assert_eq!(merged.title, "Celeste"); // untouched
    }

    #[test]
    fn merge_never_fills_a_locked_field_even_when_empty() {
        // User cleared cover_url on purpose (e.g. a placeholder image they
        // didn't want) and locked it — a scan finding a real cover_url must
        // not silently bring it back.
        let existing = ForgeLibraryEntry {
            title: "Celeste".to_string(),
            cover_url: String::new(),
            locked_fields: vec!["cover_url".to_string()],
            ..Default::default()
        };
        let fetched = ForgeLibraryEntry {
            cover_url: "http://sgdb/cover.jpg".to_string(),
            developer: "RAWG Dev".to_string(),
            ..Default::default()
        };
        let merged = merge_entry(existing, &fetched);
        assert_eq!(merged.cover_url, ""); // locked — stays empty
        assert_eq!(merged.developer, "RAWG Dev"); // unlocked field still fills normally
    }

    #[test]
    fn overwrite_replaces_already_set_fields_but_still_respects_a_lock() {
        let existing = ForgeLibraryEntry {
            title: "Celeste".to_string(),
            developer: "Stale Dev".to_string(),
            genre: "Wrong Genre".to_string(),
            locked_fields: vec!["genre".to_string()],
            ..Default::default()
        };
        let fetched = ForgeLibraryEntry {
            developer: "Maddy Makes Games".to_string(),
            genre: "Platformer".to_string(),
            discord_app_id: "12345".to_string(),
            ..Default::default()
        };
        let merged = overwrite_entry(existing, &fetched);
        assert_eq!(merged.developer, "Maddy Makes Games"); // verified data wins even though already set
        assert_eq!(merged.genre, "Wrong Genre"); // still locked — even a verified import won't touch it
        assert_eq!(merged.discord_app_id, "12345"); // field merge_entry doesn't cover at all
    }

    /// Hits the real, unofficial Steam/GOG endpoints — not run in CI (no key
    /// needed, but these are undocumented APIs that could change shape).
    /// Run manually with `cargo test -- --ignored` to sanity-check them.
    #[tokio::test]
    #[ignore]
    async fn steam_and_gog_fetch_real_data_for_known_title() {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap();

        let steam = fetch_steam(&client, "Celeste").await.unwrap();
        assert_eq!(steam.developer, "Maddy Makes Games Inc.");
        assert_eq!(steam.release_year, "2018");
        assert!(!steam.steam_id.is_empty());
        assert!(!steam.cover_url.is_empty());

        let gog = fetch_gog(&client, "The Witcher 3").await.unwrap();
        assert_eq!(gog.developer, "CD PROJEKT RED");
        assert_eq!(gog.release_year, "2015");
        assert!(!gog.gog_id.is_empty());
        assert!(!gog.cover_url.is_empty());
    }

    /// Hits the real TheGamesDB API — needs a key, so it's opt-in and not run
    /// in CI. Set THEGAMESDB_API_KEY and run with `cargo test -- --ignored`
    /// to confirm the response shape assumed in `fetch_thegamesdb` still
    /// holds before relying on it in production.
    #[tokio::test]
    #[ignore]
    async fn thegamesdb_returns_real_data() {
        let key =
            std::env::var("THEGAMESDB_API_KEY").expect("set THEGAMESDB_API_KEY to run this test");
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap();

        let result = fetch_thegamesdb(&client, "Half-Life 2", &key)
            .await
            .unwrap();
        assert!(!result.thegamesdb_id.is_empty());
        assert!(!result.release_year.is_empty());
        assert!(!result.cover_url.is_empty());
    }
}
