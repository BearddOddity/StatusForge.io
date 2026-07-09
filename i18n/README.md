# StatusForge community translations

This is prep infrastructure for the multi-language UI work described in
`status-forge-mcp.md`'s "Alias System, Genre Cycling & Multi-Language
Support" section (Phase 3 / v1.3, not yet built). **The app does not read
any of these files yet** — there's no i18n framework wired into the React
frontend. What's here now is a template format + a build script so
translation work can start (and be validated) ahead of that UI landing,
instead of blocking on it.

## How it works

- `templates/en.template.lang` is the **canonical** template — the source
  of truth for which strings exist and what their keys are. Don't translate
  this file directly.
- To add a language: copy `templates/en.template.lang` to
  `templates/<lang-code>.lang` (e.g. `templates/ja.lang` for Japanese,
  `templates/de.lang` for German — use the codes from `status-forge-mcp.md`'s
  target list: `en`, `ja`, `de`, `fr`, `es`), then translate the text on the
  right-hand side of each `=`. **Never change the key on the left.**
- Run `npm run i18n:validate i18n/templates/<lang-code>.lang` to check your
  work without producing an output file — it reports missing keys, empty
  translations, and broken `{placeholder}` tokens with the file and line
  number.
- Run `npm run i18n:build` to validate and convert every translated
  `*.lang` file in `templates/` into `i18n/<lang-code>.json` — the flat
  `{ "key.path": "text" }` shape the eventual UI layer is expected to load.

## The `.lang` format

```
# Comments start with "#" and are for translator context, not parsed.
nav.dashboard = "Dashboard"
```

- One `key.path = "text"` entry per line. Keys use dots to group by where
  the string shows up in the app (`nav.*`, `library.*`, `settings.*`, etc.)
  — this mirrors the grouping already used in `en.template.lang`.
- Only edit the text between the quotes. The key must stay byte-for-byte
  identical to the canonical file, or the build script will flag it as an
  unknown/stale key.
- Some strings contain `{placeholder}` tokens (e.g. `{version}` in the
  update-banner string) that get substituted with a real value at runtime.
  **Keep the placeholder token exactly as-is** — translate the surrounding
  text, not the token itself. The build script rejects a translation whose
  placeholder set doesn't exactly match the English original, since a
  dropped or renamed placeholder would crash the substitution at runtime.
- Plain quotes/backslashes inside a translated string need escaping the
  same way `JSON.stringify` does it: `\"` for a literal quote, `\\` for a
  literal backslash.

## Why a custom format instead of YAML/JSON/gettext (.po)

Kept deliberately dumb on purpose:

- No new npm dependency (no `js-yaml`, no `.po` parser) — the whole format
  parses with one regex line-by-line.
- JSON as the contributor-facing format is easy to break with a stray
  trailing comma or an unescaped quote, and gives no room for the `# `
  context comments translators actually need.
- A translator copying `en.template.lang` and editing only the quoted text
  is close to impossible to get structurally wrong — the worst realistic
  mistake is leaving a line untranslated, which the build script warns
  about (not an error, since a partial translation should still build) or
  breaking a `{placeholder}`, which the build script does hard-error on.

## Current coverage

`en.template.lang` is a **starter set** (~50 keys) pulled from the real
frontend — `App.tsx` (sidebar/nav), `LibraryView.tsx`, `DashboardView.tsx`,
`views/*.tsx`, and a handful of shared components (`ui.tsx`, `Toast.tsx`,
`UpdateBanner.tsx`, `Overlays.tsx`). It is **not** every user-facing string
in the app — `SettingsView.tsx` alone is ~150KB and hasn't been swept yet.
Extend `en.template.lang` with more real keys as coverage grows (grep the
`src/` tree for JSX text, not invented strings), and re-run
`npm run i18n:build` — every existing translated file will immediately
report the new keys as missing until translators catch up, which is the
intended signal.

## Validation rules, in full

Running `npm run i18n:validate i18n/templates/<file>.lang` checks:

| Check | Error or warning? |
|---|---|
| Key present in your file but not in `en.template.lang` | error (typo, or a stale key from an older copy of the template) |
| Key in `en.template.lang` missing from your file | error |
| Translated value is empty (`""`) | error |
| `{placeholder}` tokens don't exactly match the English original | error |
| Translated value is byte-identical to the English original | warning (not blocking — sometimes a word genuinely doesn't change, e.g. a proper noun like "StatusForge") |
| Duplicate key defined twice in the same file | error, build refuses to run |
| A line that isn't a comment, blank, or `key = "text"` | error, build refuses to run |
