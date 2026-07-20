#!/usr/bin/env node
// Keeps the Blipy / Joystick Companion version badges in
// BearddOddity.github.io's statusforge/index.html Addons section in sync
// with whatever's actually published on their moving release tags
// (blipy-latest, joystick-latest). Each addon also has its own full page
// (blipy/index.html, joystick/index.html) with a download grid — those are
// synced by the existing update-download-page.mjs (same id="sf-version"/
// data-asset conventions), not by this script.
import { readFileSync, writeFileSync } from "node:fs";

const [, , filePath, blipyJsonPath, joystickJsonPath] = process.argv;
if (!filePath || !blipyJsonPath || !joystickJsonPath) {
  console.error(
    "usage: update-addons-section.mjs <path-to-index.html> <blipy-release.json> <joystick-release.json>"
  );
  process.exit(1);
}

// The release name is "Blipy v1.0.0" / "Joystick Companion v0.1.0" — the
// tag itself is a moving "*-latest" string, not a real version number.
function versionFromRelease(release) {
  const match = (release.name || "").match(/v[\d.]+/);
  return match ? match[0] : release.tag_name || "—";
}

function applyAddon(html, idPrefix, releaseJsonPath) {
  const release = JSON.parse(readFileSync(releaseJsonPath, "utf8") || "{}");
  const version = versionFromRelease(release);

  html = html.replace(
    new RegExp(`(id="${idPrefix}-version"[^>]*>)[^<]*(</span>)`),
    `$1${version}$2`
  );
  return { html, version };
}

let html = readFileSync(filePath, "utf8");

const blipy = applyAddon(html, "blipy", blipyJsonPath);
html = blipy.html;
const joystick = applyAddon(html, "joystick", joystickJsonPath);
html = joystick.html;

writeFileSync(filePath, html);

console.log(`Updated ${filePath}`);
console.log(`  blipy: ${blipy.version}`);
console.log(`  joystick: ${joystick.version}`);
