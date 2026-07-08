#!/usr/bin/env node
// Rewrites the download links + version badge in BearddOddity.github.io's
// statusforge/download.html to match a published StatusForge release.
// Run by .github/workflows/update-download-page.yml on every
// `release: published` event (StatusForge releases only — Spark is always
// prerelease and is filtered out at the workflow level).
import { readFileSync, writeFileSync } from "node:fs";

const filePath = process.argv[2];
if (!filePath) {
  console.error("usage: update-download-page.mjs <path-to-download.html>");
  process.exit(1);
}

const release = JSON.parse(process.env.RELEASE_JSON || "{}");
const tag = release.tag_name;
const assets = release.assets || [];

if (!tag || !assets.length) {
  console.error("RELEASE_JSON missing tag_name/assets — nothing to update");
  process.exit(1);
}

// Update artifacts (.sig, .app.tar.gz, latest.json) are for the Tauri
// updater, not for humans clicking a download button, so they're excluded.
function categorize(name) {
  if (/\.sig$/i.test(name)) return null;
  if (/\.app\.tar\.gz$/i.test(name)) return null;
  if (/^latest\.json$/i.test(name)) return null;
  if (/\.exe$/i.test(name)) return "win-exe";
  if (/\.msi$/i.test(name)) return "win-msi";
  if (/\.dmg$/i.test(name)) return "mac-dmg";
  if (/\.appimage$/i.test(name)) return "linux-appimage";
  if (/\.deb$/i.test(name)) return "linux-deb";
  if (/\.rpm$/i.test(name)) return "linux-rpm";
  if (/\.flatpak$/i.test(name)) return "linux-flatpak";
  return null;
}

const assetMap = {};
for (const asset of assets) {
  const key = categorize(asset.name);
  if (key && !assetMap[key]) assetMap[key] = asset.browser_download_url;
}

let html = readFileSync(filePath, "utf8");

html = html.replace(/(id="sf-version"[^>]*>)[^<]*(<\/span>)/, `$1${tag}$2`);

// A category missing from this release (e.g. a platform build failed) is
// left pointing at whatever it last had, rather than broken/blank.
for (const [key, url] of Object.entries(assetMap)) {
  const re = new RegExp(`(data-asset="${key}"[^>]*href=")[^"]*(")`);
  html = html.replace(re, `$1${url}$2`);
}

writeFileSync(filePath, html);

console.log(`Updated ${filePath} to ${tag}`);
for (const [key, url] of Object.entries(assetMap)) {
  console.log(`  ${key}: ${url}`);
}
