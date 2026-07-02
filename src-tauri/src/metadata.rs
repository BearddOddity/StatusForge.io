//! External game-metadata scan for `/api/scan-metadata`.
//!
//! Sources (each skipped unless its API key is configured, and skipped on any
//! network failure — a scan never hard-fails):
//! - RAWG        → year, genre, developer, publisher, cover, rawg_id
//! - IGDB        → same via apicalypse (Twitch app token fetched if needed), igdb_id
//! - SteamGridDB → preferred 600x900 cover, sgdb_id
//!
//! Merge strategy: only EMPTY fields of the existing entry are filled, so
//! user-set/custom values always win.

use std::time::Duration;

use crate::config::{ApiKeys, ForgeLibraryEntry};

/// Fill empty fields of `existing` from `fetched`. Pure — unit tested below.
pub fn merge_entry(mut existing: ForgeLibraryEntry, fetched: &ForgeLibraryEntry) -> ForgeLibraryEntry {
    macro_rules! fill {
        ($($f:ident),*) => {$(
            if existing.$f.is_empty() && !fetched.$f.is_empty() {
                existing.$f = fetched.$f.clone();
            }
        )*};
    }
    fill!(genre, release_year, developer, publisher, cover_url, igdb_id, rawg_id, sgdb_id);
    existing
}

/// Scan all configured sources for `title` and merge the results into `existing`.
pub async fn scan(title: &str, keys: &ApiKeys, existing: ForgeLibraryEntry) -> ForgeLibraryEntry {
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

    if !keys.igdb_client.is_empty() && (!keys.igdb_token.is_empty() || !keys.igdb_secret.is_empty()) {
        match fetch_igdb(&client, title, keys).await {
            Ok(e) => fetched = merge_entry(fetched, &e),
            Err(e) => log::warn!("[META] IGDB failed: {}", e),
        }
    }

    if !keys.steamgrid.is_empty() {
        match fetch_sgdb(&client, title, &keys.steamgrid).await {
            Ok((id, cover)) => {
                fetched.sgdb_id = id;
                if !cover.is_empty() {
                    fetched.cover_url = cover; // SGDB cover preferred over RAWG/IGDB
                }
            }
            Err(e) => log::warn!("[META] SteamGridDB failed: {}", e),
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
        release_year: g["released"].as_str().unwrap_or("").chars().take(4).collect(),
        genre: g["genres"][0]["name"].as_str().unwrap_or("").to_string(),
        developer: g["developers"][0]["name"].as_str().unwrap_or("").to_string(),
        publisher: g["publishers"][0]["name"].as_str().unwrap_or("").to_string(),
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
        .map(|id| format!("https://images.igdb.com/igdb/image/upload/t_cover_big/{}.jpg", id))
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

/// Returns (sgdb_id, cover_url) — cover may be empty if no 600x900 grid exists.
async fn fetch_sgdb(
    client: &reqwest::Client,
    title: &str,
    key: &str,
) -> Result<(String, String), String> {
    let search_url = format!(
        "https://www.steamgriddb.com/api/v2/search/autocomplete/{}",
        urlencoding::encode(title)
    );
    let json = get_json(client.get(&search_url).bearer_auth(key)).await?;
    let id = json["data"][0]["id"].as_u64().ok_or("no SteamGridDB results")?;

    let grids_url = format!(
        "https://www.steamgriddb.com/api/v2/grids/game/{}?dimensions=600x900",
        id
    );
    let grids = get_json(client.get(&grids_url).bearer_auth(key)).await?;
    let cover = grids["data"][0]["url"].as_str().unwrap_or("").to_string();
    Ok((id.to_string(), cover))
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
