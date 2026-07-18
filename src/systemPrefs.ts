// ─── Shared system preferences: storage + application ───────────────────────
// Mirrors theme.ts. Used by App.tsx (apply/act on boot), SettingsView's System
// tab (edit + save), and useWebSocket (reconnect gating).

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

export const SYSTEM_PREFS_KEY = "statusforge_system_prefs";
export const SYSTEM_PREFS_EVENT = "sf-system-prefs-changed";

export function loadSystemPrefs(): SystemPrefs {
  try {
    const stored = localStorage.getItem(SYSTEM_PREFS_KEY);
    return stored ? { ...defaultSystemPrefs, ...JSON.parse(stored) } : defaultSystemPrefs;
  } catch {
    return defaultSystemPrefs;
  }
}

export function saveSystemPrefs(prefs: SystemPrefs) {
  try {
    localStorage.setItem(SYSTEM_PREFS_KEY, JSON.stringify(prefs));
  } catch {}
  applySystemPrefs(prefs);
  window.dispatchEvent(new Event(SYSTEM_PREFS_EVENT));
}

// Hardware accel can't be toggled on a live WebView2 process, so "off" honestly
// means: kill the heavy CSS animations/transitions (see .no-hwaccel in index.css).
export function applySystemPrefs(prefs: SystemPrefs) {
  document.documentElement.classList.toggle("no-hwaccel", !prefs.hardwareAccel);
}
