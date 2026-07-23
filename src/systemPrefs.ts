// ─── Shared system preferences: storage + application ───────────────────────
// Mirrors theme.ts. Used by App.tsx (apply/act on boot), SettingsView's System
// tab (edit + save), and useWebSocket (reconnect gating).
//
// Storage: this used to own a private "statusforge_system_prefs" localStorage
// key, completely separate from StreamerSuite's Settings -> General tab — so
// the two screens' overlapping fields (auto-start engine, minimize to tray,
// notifications, hardware accel, language, webhook, ws reconnect, update
// channel, log level, config backup) could silently diverge depending on
// which screen was edited last. It now reads/writes the SAME unified
// settings key (SharedSettingsContext's STORAGE_KEY, under its .system
// section) and notifies that context of external writes via
// SETTINGS_CHANGED_EVENT, exactly like theme.ts. The StatusForge-only extra
// fields (autoUpdateCheckEnabled, showDevTools, showAccessTokens,
// onboardingComplete, setupBannerDismissed) live in SystemConfig too, but
// are only ever surfaced in StatusForge's own Settings -> System sub-tab.

import { STORAGE_KEY, SETTINGS_CHANGED_EVENT, defaultSharedSettings } from "@/settings";
import type { SystemConfig } from "@/settings";

export interface SystemPrefs {
  autoStartEngine: boolean;
  minimizeToTray: boolean;
  launchOnLogin: boolean;
  hardwareAccel: boolean;
  showNotifications: boolean;
  notifyOnGameDetect: boolean;
  notifyOnStreamEvents: boolean;
  logLevel: "error" | "warn" | "info" | "debug";
  // ponytail: only "en" exists — persisted selector, no i18n until a second
  // language actually ships.
  language: string;
  configBackupEnabled: boolean;
  customWebhookEnabled: boolean;
  customWebhookUrl: string;
  wsAutoReconnect: boolean;
  // ponytail: persisted only — the updater has a single channel-less endpoint
  // (latest.json). Feed this into per-channel manifests once signing/releases
  // publish them.
  updateChannel: "stable" | "beta" | "closed-beta";
  autoUpdateCheckEnabled: boolean;
  showDevTools: boolean;
  // Reveals the OAuth-managed token previews in Settings > API & Routing
  // (Access/Refresh Token). Off by default — those values stay masked.
  showAccessTokens: boolean;
  // First-launch setup wizard. Set once it's finished/skipped; a "Replay
  // Setup Guide" button in Settings > System flips it back to false.
  onboardingComplete: boolean;
  // Dashboard's "Struggling to get set up?" banner. Defaults to showing (a
  // fresh install has no stored prefs, so this key is absent and falls back
  // to the default below) and stays dismissed permanently once closed — it
  // only comes back on an actual fresh install, not a page reload.
  setupBannerDismissed: boolean;
}

export const defaultSystemPrefs: SystemPrefs = {
  autoStartEngine: false,
  minimizeToTray: true,
  launchOnLogin: false,
  hardwareAccel: true,
  showNotifications: true,
  notifyOnGameDetect: true,
  notifyOnStreamEvents: false,
  logLevel: "info",
  language: "en",
  configBackupEnabled: true,
  customWebhookEnabled: false,
  customWebhookUrl: "",
  wsAutoReconnect: true,
  updateChannel: "stable",
  autoUpdateCheckEnabled: true,
  showDevTools: false,
  showAccessTokens: false,
  onboardingComplete: false,
  setupBannerDismissed: false,
};

/** Fired after system prefs are written — same event SharedSettingsContext
 *  listens for and dispatches, so a save from either screen reaches both. */
export const SYSTEM_PREFS_EVENT = SETTINGS_CHANGED_EVENT;

// SystemPrefs.launchOnLogin is this UI's own name for the unified
// SystemConfig.launchOnStartup field — every other field already shares the
// same name and type between the two.
function toSystemPrefs(system: SystemConfig): SystemPrefs {
  return {
    autoStartEngine: system.autoStartEngine,
    minimizeToTray: system.minimizeToTray,
    launchOnLogin: system.launchOnStartup,
    hardwareAccel: system.hardwareAccel,
    showNotifications: system.showNotifications,
    notifyOnGameDetect: system.notifyOnGameDetect,
    notifyOnStreamEvents: system.notifyOnStreamEvents,
    logLevel: system.logLevel,
    language: system.language,
    configBackupEnabled: system.configBackupEnabled,
    customWebhookEnabled: system.customWebhookEnabled,
    customWebhookUrl: system.customWebhookUrl,
    wsAutoReconnect: system.wsAutoReconnect,
    updateChannel: system.updateChannel,
    autoUpdateCheckEnabled: system.autoUpdateCheckEnabled,
    showDevTools: system.showDevTools,
    showAccessTokens: system.showAccessTokens,
    onboardingComplete: system.onboardingComplete,
    setupBannerDismissed: system.setupBannerDismissed,
  };
}

const LEGACY_SYSTEM_PREFS_KEY = "statusforge_system_prefs";

// One-time backfill: SharedSettingsContext's own legacy migration only runs
// on a completely fresh profile (STORAGE_KEY absent) — but every existing
// install already has STORAGE_KEY from the earlier theme.ts migration, so
// that path never fires for system prefs. Without this, switching storage
// backends here would silently reset every existing user's autostart/
// notification/onboarding-complete state back to defaults on next launch,
// even though their real values are still sitting in the legacy key.
// Runs once: after merging, the legacy key is deleted so this is a no-op on
// every subsequent load.
function migrateLegacySystemPrefsOnce(): void {
  let legacyRaw: string | null;
  try {
    legacyRaw = localStorage.getItem(LEGACY_SYSTEM_PREFS_KEY);
  } catch {
    return;
  }
  if (!legacyRaw) return;

  try {
    const legacy = JSON.parse(legacyRaw) as Partial<SystemPrefs>;
    let unified: Record<string, unknown> = {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) unified = JSON.parse(raw);
    const currentSystem: SystemConfig = {
      ...defaultSharedSettings.system,
      ...((unified.system as Partial<SystemConfig>) ?? {}),
    };
    const mergedSystem: SystemConfig = {
      ...currentSystem,
      ...legacy,
      launchOnStartup: legacy.launchOnLogin ?? currentSystem.launchOnStartup,
    };
    delete (mergedSystem as Partial<SystemPrefs>).launchOnLogin;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...unified, system: mergedSystem }));
  } catch (err) {
    console.error("Failed to migrate legacy system prefs:", err);
  } finally {
    try {
      localStorage.removeItem(LEGACY_SYSTEM_PREFS_KEY);
    } catch {
      /* ignore */
    }
  }
}
migrateLegacySystemPrefsOnce();

function readUnifiedSystem(): SystemConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.system) return { ...defaultSharedSettings.system, ...parsed.system };
    }
  } catch {
    /* ignore */
  }
  return defaultSharedSettings.system;
}

export function loadSystemPrefs(): SystemPrefs {
  return toSystemPrefs(readUnifiedSystem());
}

export function saveSystemPrefs(prefs: SystemPrefs) {
  let unified: Record<string, unknown> = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) unified = JSON.parse(raw);
  } catch {
    /* ignore */
  }
  const nextSystem: SystemConfig = {
    ...defaultSharedSettings.system,
    ...readUnifiedSystem(),
    ...prefs,
    launchOnStartup: prefs.launchOnLogin,
  };
  const next = { ...unified, system: nextSystem };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    console.error("Failed to persist system prefs:", err);
  }
  applySystemPrefs(prefs);
  window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
}

// Hardware accel can't be toggled on a live WebView2 process, so "off" honestly
// means: kill the heavy CSS animations/transitions (see .no-hwaccel in index.css).
export function applySystemPrefs(prefs: SystemPrefs) {
  document.documentElement.classList.toggle("no-hwaccel", !prefs.hardwareAccel);
}
