#!/usr/bin/env node
// Guards against the class of bug where a new Tauri plugin gets registered
// in lib.rs (`.plugin(tauri_plugin_x::...)`) but nobody adds its permissions
// to capabilities/default.json — the app still compiles fine, and the
// failure only shows up at runtime as a silent IPC permission-denied error
// (the same "looks fine until you click it" shape as the earlier
// payload-mismatch and key-removal bugs). Static text parsing is enough
// here; this isn't validating full ACL semantics, just "did anyone forget."

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libRsPath = path.join(rootDir, "src-tauri", "src", "lib.rs");
const capabilitiesPath = path.join(rootDir, "src-tauri", "capabilities", "default.json");

// Plugins that are only ever driven from Rust (no direct frontend
// `invoke("plugin:x|...")` calls), so they don't need a capability entry.
const PLUGINS_WITHOUT_JS_SURFACE = new Set(["autostart"]);

const libRs = readFileSync(libRsPath, "utf-8");
const capabilities = JSON.parse(readFileSync(capabilitiesPath, "utf-8"));
const grantedPrefixes = new Set(
  capabilities.permissions.map((p) => p.split(":")[0])
);

const pluginPattern = /\.plugin\(tauri_plugin_(\w+)::/g;
const registeredPlugins = new Set();
for (const match of libRs.matchAll(pluginPattern)) {
  registeredPlugins.add(match[1].replace(/_/g, "-"));
}

if (registeredPlugins.size === 0) {
  console.error("Found zero plugin registrations in lib.rs — check regex/parsing, this looks wrong.");
  process.exit(1);
}

const missing = [...registeredPlugins].filter(
  (name) => !PLUGINS_WITHOUT_JS_SURFACE.has(name) && !grantedPrefixes.has(name)
);

if (missing.length > 0) {
  console.error("Plugins registered in lib.rs with no matching capability in default.json:");
  for (const name of missing) {
    console.error(`  - ${name}`);
  }
  console.error(
    "\nEither add a permission entry (e.g. \"" +
      missing[0] +
      ":default\") to src-tauri/capabilities/default.json, or if this plugin " +
      "is Rust-only (no frontend invoke() calls), add it to " +
      "PLUGINS_WITHOUT_JS_SURFACE in scripts/check-capabilities.mjs."
  );
  process.exit(1);
}

console.log(`OK — all ${registeredPlugins.size} registered plugins have matching capability entries.`);
