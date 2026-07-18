//! Stage-0 alias resolution: takes whatever title got detected — a raw
//! window title, an exe-name guess, something Blipy forwarded, a manual
//! entry — and maps it to the canonical library title the user actually set
//! an alias up for. This runs before broadcasting or the library upsert
//! ever see the title.
//!
//! Aliases live on the canonical library entry itself (flattened into
//! [`AliasRecord`]s here), so an alias can only ever point at a real
//! canonical title. Aliasing to another alias isn't representable — which
//! happens to be exactly the "no chaining" rule v1.0 wants.
//!
//! When more than one record matches the same raw title, ties break in this
//! order:
//! 1. **priority** — lower number wins (1 = highest)
//! 2. **language** — the user's system language, then "en", then whatever's left
//! 3. **preferred** — the alias the user explicitly flagged
//! 4. **added_at** — oldest wins
//!
//! One wrinkle: the spec's numbered list puts chronological order ahead of
//! preferred, but its own worked example resolves through the preferred flag
//! between two aliases that would already differ chronologically. If
//! chronological order really came first, a unique timestamp would settle
//! every tie and `preferred` would never get a chance to matter — so this
//! file follows the worked example instead of the numbered list.

/// One alias, flattened together with the canonical title it points to.
#[derive(Debug, Clone, PartialEq)]
pub struct AliasRecord {
    /// The canonical library title this alias resolves to.
    pub canonical: String,
    /// The alias text matched against raw detected titles.
    pub name: String,
    /// 1 = highest. Ties fall through to language/preferred/added_at.
    pub priority: u8,
    /// BCP-47-ish language tag ("en", "ja", ...). Compared case-insensitively.
    pub language: String,
    /// Sortable creation timestamp (any fixed-format string — RFC3339 or
    /// zero-padded unix seconds); oldest wins as the final tie-breaker.
    pub added_at: String,
    /// User-flagged preferred alias.
    pub preferred: bool,
}

/// Trim + casefold, so "  DS3 " matches "ds3". Mirrors the whitespace/case
/// tolerance the host app's library keys already use (`find_library_key`).
pub fn normalize_alias_name(name: &str) -> String {
    name.trim().to_lowercase()
}

/// Rank a record's language against the user's system language:
/// exact match beats "en" beats anything else.
fn language_rank(record_language: &str, system_language: &str) -> u8 {
    let lang = record_language.trim().to_lowercase();
    if lang == system_language.trim().to_lowercase() {
        0
    } else if lang == "en" {
        1
    } else {
        2
    }
}

/// Resolve `raw_title` against `records`. Returns the canonical title of the
/// winning alias, or `None` when no alias matches (callers then treat the
/// raw title itself as canonical). Matching is trim/case-insensitive.
pub fn resolve_alias(
    raw_title: &str,
    records: &[AliasRecord],
    system_language: &str,
) -> Option<String> {
    let needle = normalize_alias_name(raw_title);
    if needle.is_empty() {
        return None;
    }
    records
        .iter()
        .filter(|r| normalize_alias_name(&r.name) == needle)
        .min_by(|a, b| {
            a.priority
                .cmp(&b.priority)
                .then_with(|| {
                    language_rank(&a.language, system_language)
                        .cmp(&language_rank(&b.language, system_language))
                })
                // preferred=true should sort first → compare inverted
                .then_with(|| b.preferred.cmp(&a.preferred))
                .then_with(|| a.added_at.cmp(&b.added_at))
                // full determinism even for identical metadata
                .then_with(|| a.canonical.cmp(&b.canonical))
        })
        .map(|r| r.canonical.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(
        canonical: &str,
        name: &str,
        priority: u8,
        language: &str,
        added_at: &str,
        preferred: bool,
    ) -> AliasRecord {
        AliasRecord {
            canonical: canonical.to_string(),
            name: name.to_string(),
            priority,
            language: language.to_string(),
            added_at: added_at.to_string(),
            preferred,
        }
    }

    #[test]
    fn no_match_returns_none() {
        let records = [rec(
            "Dark Souls III",
            "DS3",
            1,
            "en",
            "2026-07-10T00:00:00Z",
            false,
        )];
        assert_eq!(resolve_alias("Elden Ring", &records, "en"), None);
        assert_eq!(resolve_alias("", &records, "en"), None);
        assert_eq!(resolve_alias("   ", &records, "en"), None);
    }

    #[test]
    fn match_is_case_and_whitespace_insensitive() {
        let records = [rec(
            "Dark Souls III",
            "DS3",
            1,
            "en",
            "2026-07-10T00:00:00Z",
            false,
        )];
        assert_eq!(
            resolve_alias("  ds3 ", &records, "en"),
            Some("Dark Souls III".to_string())
        );
    }

    #[test]
    fn lower_priority_number_wins() {
        let records = [
            rec("Wrong Game", "souls", 2, "en", "2026-07-01T00:00:00Z", true),
            rec(
                "Dark Souls III",
                "souls",
                1,
                "en",
                "2026-07-10T00:00:00Z",
                false,
            ),
        ];
        assert_eq!(
            resolve_alias("souls", &records, "en"),
            Some("Dark Souls III".to_string())
        );
    }

    #[test]
    fn system_language_beats_english_beats_other() {
        let records = [
            rec(
                "English Entry",
                "共通",
                1,
                "en",
                "2026-07-01T00:00:00Z",
                false,
            ),
            rec(
                "Japanese Entry",
                "共通",
                1,
                "ja",
                "2026-07-02T00:00:00Z",
                false,
            ),
            rec(
                "German Entry",
                "共通",
                1,
                "de",
                "2026-07-03T00:00:00Z",
                false,
            ),
        ];
        assert_eq!(
            resolve_alias("共通", &records, "ja"),
            Some("Japanese Entry".to_string())
        );
        // System language with no matching record falls back to "en".
        assert_eq!(
            resolve_alias("共通", &records, "fr"),
            Some("English Entry".to_string())
        );
    }

    #[test]
    fn preferred_flag_breaks_language_ties() {
        // Spec's worked example: same priority + language, preferred wins
        // even though the non-preferred alias is older.
        let records = [
            rec(
                "Dark Souls III",
                "twin",
                1,
                "en",
                "2026-07-01T00:00:00Z",
                false,
            ),
            rec(
                "Dark Souls III: Remaster",
                "twin",
                1,
                "en",
                "2026-07-09T00:00:00Z",
                true,
            ),
        ];
        assert_eq!(
            resolve_alias("twin", &records, "en"),
            Some("Dark Souls III: Remaster".to_string())
        );
    }

    #[test]
    fn oldest_wins_when_all_else_ties() {
        let records = [
            rec("Newer", "same", 1, "en", "2026-07-11T00:00:00Z", false),
            rec("Older", "same", 1, "en", "2026-07-02T00:00:00Z", false),
        ];
        assert_eq!(
            resolve_alias("same", &records, "en"),
            Some("Older".to_string())
        );
    }

    #[test]
    fn single_match_wins_regardless_of_metadata() {
        let records = [
            rec(
                "Dark Souls III",
                "DS3",
                1,
                "en",
                "2026-07-10T00:00:00Z",
                true,
            ),
            rec(
                "Dark Souls III",
                "Souls III",
                2,
                "en",
                "2026-07-10T00:00:00Z",
                false,
            ),
        ];
        assert_eq!(
            resolve_alias("Souls III", &records, "en"),
            Some("Dark Souls III".to_string())
        );
    }
}
