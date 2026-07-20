#!/usr/bin/env node
// Rewrites the download links + version badge in a BearddOddity.github.io
// download-style page (statusforge/download.html, blipy/index.html,
// joystick/index.html) to match a published release. Run by
// .github/workflows/update-download-page.yml on every `release: published`
// event (StatusForge only — Blipy/Joystick Companion are always
// prerelease and filtered out at the workflow level for that trigger), or
// manually via workflow_dispatch.
import { readFileSync, writeFileSync } from "node:fs";

const filePath = process.argv[2];
const releaseJsonPath = process.argv[3];
if (!filePath || !releaseJsonPath) {
  console.error("usage: update-download-page.mjs <path-to-page.html> <path-to-release.json>");
  process.exit(1);
}

const release = JSON.parse(readFileSync(releaseJsonPath, "utf8") || "{}");
const assets = release.assets || [];

// StatusForge's tag IS its version (v1.0.0), but Blipy/Joystick Companion
// publish to a moving "blipy-latest"/"joystick-latest" tag — the real
// version only shows up in the release name ("Blipy v1.0.0"). Preferring
// that match keeps the badge showing an actual version number either way,
// falling back to the tag only if the name doesn't parse.
const versionMatch = (release.name || "").match(/v[\d.]+/);
const version = versionMatch ? versionMatch[0] : release.tag_name;

if (!version || !assets.length) {
  console.error("RELEASE_JSON missing tag_name/name/assets — nothing to update");
  process.exit(1);
}

// Update artifacts (.sig, .app.tar.gz, latest.json) are for the Tauri
// updater, not for humans clicking a download button, so they're excluded.
function categorize(name) {
  if (/\.sig$/i.test(name)) return null;
  if (/\.app\.tar\.gz$/i.test(name)) return null;
  if (/^latest\.json$/i.test(name)) return null;
  if (/portable-windows.*\.zip$/i.test(name)) return "win-portable";
  if (/portable-macos.*\.zip$/i.test(name)) return "mac-portable";
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

html = html.replace(/(id="sf-version"[^>]*>)[^<]*(<\/span>)/, `$1${version}$2`);

// A category missing from this release (e.g. a platform build failed) is
// left pointing at whatever it last had, rather than broken/blank.
for (const [key, url] of Object.entries(assetMap)) {
  const re = new RegExp(`(data-asset="${key}"[^>]*href=")[^"]*(")`);
  html = html.replace(re, `$1${url}$2`);
}

writeFileSync(filePath, html);

console.log(`Updated ${filePath} to ${version}`);
for (const [key, url] of Object.entries(assetMap)) {
  console.log(`  ${key}: ${url}`);
}
