#!/usr/bin/env node
// Converts a community-filled `.lang` translation template into the flat
// `{ "key.path": "translated text" }` JSON shape the (not-yet-built) i18n
// UI layer is expected to consume. See i18n/README.md for the contributor
// workflow and i18n/templates/en.template.lang for the canonical key set
// and the `.lang` file format this script parses.
//
// Usage:
//   node scripts/i18n-build.mjs validate <path/to/xx.lang>
//   node scripts/i18n-build.mjs build <path/to/xx.lang> [--out <path>]
//   node scripts/i18n-build.mjs build --all
//
// No new npm dependency was added for this — the `.lang` format is
// deliberately just `key = "text"` lines so it parses with a regex, no YAML/
// TOML library needed.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const TEMPLATES_DIR = join(REPO_ROOT, "i18n", "templates");
const CANONICAL_PATH = join(TEMPLATES_DIR, "en.template.lang");
const OUT_DIR = join(REPO_ROOT, "i18n");

const LINE_RE = /^([A-Za-z][A-Za-z0-9_.]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/;
const PLACEHOLDER_RE = /\{[a-zA-Z0-9_]+\}/g;

function unescape(str) {
  return str.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** Parse a `.lang` file into an ordered Map<key, { value, line }>. Throws
 * with a line number on malformed non-comment/non-blank lines, since a
 * silently-skipped typo is worse than a build failure for a translator. */
function parseLangFile(path) {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  const entries = new Map();
  const duplicates = [];

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;

    const m = line.match(LINE_RE);
    if (!m) {
      throw new Error(
        `${path}:${i + 1}: malformed line (expected \`key.path = "text"\`): ${JSON.stringify(raw)}`,
      );
    }
    const [, key, rawValue] = m;
    if (entries.has(key)) duplicates.push({ key, line: i + 1 });
    entries.set(key, { value: unescape(rawValue), line: i + 1 });
  });

  if (duplicates.length > 0) {
    const list = duplicates.map((d) => `  - "${d.key}" redefined at line ${d.line}`).join("\n");
    throw new Error(`${path}: duplicate key(s):\n${list}`);
  }

  return entries;
}

function langCodeFromFilename(path) {
  const name = basename(path).replace(/\.lang$/, "");
  return name.replace(/\.template$/, "");
}

function placeholders(str) {
  return new Set((str.match(PLACEHOLDER_RE) ?? []).sort());
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Validate `translated` against the canonical template. Returns
 * { errors, warnings } — errors block a build, warnings don't. */
function validate(canonical, translated, translatedPath) {
  const errors = [];
  const warnings = [];

  for (const [key, { value: enValue }] of canonical) {
    if (!translated.has(key)) {
      errors.push(`missing key "${key}" (present in en.template.lang, not in this file)`);
      continue;
    }
    const { value: trValue, line } = translated.get(key);

    if (trValue.trim() === "") {
      errors.push(`${translatedPath}:${line}: "${key}" has an empty translation`);
      continue;
    }
    if (trValue === enValue) {
      warnings.push(
        `${translatedPath}:${line}: "${key}" is still the untranslated English text — ` +
          `translate it, or leave a "# TODO" comment above it if intentional`,
      );
    }

    const enPlaceholders = placeholders(enValue);
    const trPlaceholders = placeholders(trValue);
    if (!setsEqual(enPlaceholders, trPlaceholders)) {
      errors.push(
        `${translatedPath}:${line}: "${key}" placeholder mismatch — ` +
          `English has [${[...enPlaceholders].join(", ")}], translation has [${[...trPlaceholders].join(", ")}]. ` +
          `Placeholders like {version} are substituted at runtime and must appear, verbatim, in every translation.`,
      );
    }
  }

  for (const key of translated.keys()) {
    if (!canonical.has(key)) {
      errors.push(`"${key}" is not a known key (not in en.template.lang) — typo, or a stale key from an older template?`);
    }
  }

  return { errors, warnings };
}

function buildOne(path, outPath) {
  const canonical = parseLangFile(CANONICAL_PATH);
  const translated = parseLangFile(path);
  const lang = langCodeFromFilename(path);

  const { errors, warnings } = validate(canonical, translated, path);

  for (const w of warnings) console.warn(`  warning: ${w}`);
  if (errors.length > 0) {
    console.error(`\n${path} (lang: ${lang}) — ${errors.length} error(s):`);
    for (const e of errors) console.error(`  error: ${e}`);
    return false;
  }

  const json = {};
  for (const [key, { value }] of translated) json[key] = value;

  const dest = outPath ?? join(OUT_DIR, `${lang}.json`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(json, null, 2) + "\n", "utf8");
  console.log(`✓ ${path} (lang: ${lang}) -> ${dest} (${translated.size} keys, ${warnings.length} warning(s))`);
  return true;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!existsSync(CANONICAL_PATH)) {
    console.error(`Canonical template not found at ${CANONICAL_PATH}`);
    process.exit(1);
  }

  if (cmd === "validate") {
    const path = rest[0];
    if (!path) {
      console.error("Usage: node scripts/i18n-build.mjs validate <path/to/xx.lang>");
      process.exit(1);
    }
    const canonical = parseLangFile(CANONICAL_PATH);
    const translated = parseLangFile(path);
    const { errors, warnings } = validate(canonical, translated, path);
    for (const w of warnings) console.warn(`  warning: ${w}`);
    if (errors.length > 0) {
      console.error(`\n${path} — ${errors.length} error(s):`);
      for (const e of errors) console.error(`  error: ${e}`);
      process.exit(1);
    }
    console.log(`✓ ${path} is valid (${translated.size} keys, ${warnings.length} warning(s))`);
    return;
  }

  if (cmd === "build") {
    if (rest[0] === "--all") {
      const files = readdirSync(TEMPLATES_DIR)
        .filter((f) => f.endsWith(".lang") && f !== "en.template.lang");
      if (files.length === 0) {
        console.log(`No translated .lang files found in ${TEMPLATES_DIR} yet (looked for anything besides en.template.lang).`);
        return;
      }
      let ok = true;
      for (const f of files) ok = buildOne(join(TEMPLATES_DIR, f)) && ok;
      process.exit(ok ? 0 : 1);
    }

    const path = rest[0];
    if (!path) {
      console.error("Usage: node scripts/i18n-build.mjs build <path/to/xx.lang> [--out <path>] | build --all");
      process.exit(1);
    }
    const outIdx = rest.indexOf("--out");
    const outPath = outIdx !== -1 ? rest[outIdx + 1] : undefined;
    process.exit(buildOne(path, outPath) ? 0 : 1);
  }

  console.error("Usage:\n  node scripts/i18n-build.mjs validate <path/to/xx.lang>\n  node scripts/i18n-build.mjs build <path/to/xx.lang> [--out <path>]\n  node scripts/i18n-build.mjs build --all");
  process.exit(1);
}

try {
  main();
} catch (err) {
  // parseLangFile throws plain Errors with a file:line-prefixed message for
  // malformed/duplicate-key input — print just that, not a Node stack trace,
  // since the person hitting this is often a non-technical translator.
  console.error(`\nerror: ${err.message}`);
  process.exit(1);
}
