// ─── Shared theme preferences: storage + CSS variable application ───────────
// Used by both App.tsx (apply on boot) and SettingsView's Theme tab (apply on
// change), so every theme setting persists and takes effect after reload.

export interface ThemePrefs {
  accentColor: string;
  bgColor: string;
  bgOpacity: number;
  bgBlur: number;
  bgImage: string;
  panelOpacity: number;
  borderRadius: "sharp" | "soft" | "rounded";
  fontScale: number;
  density: "compact" | "default" | "spacious";
  sidebarIconOnly: boolean;
  animationsEnabled: boolean;
  reducedMotion: boolean;
  transitionSpeed: "instant" | "fast" | "normal" | "slow";
  coverBreathe: boolean;
  coverGlint: boolean;
  cardHoverLift: boolean;
  cardGlint: boolean;
  holoEffects: boolean;
  statusPulse: boolean;
  toastAnimations: boolean;
  modalAnimations: boolean;
  progressBarAnimation: boolean;
  buttonHoverEffects: boolean;
}

export const defaultThemePrefs: ThemePrefs = {
  accentColor: "#9146FF",
  bgColor: "#050505",
  bgOpacity: 100,
  bgBlur: 0,
  bgImage: "",
  panelOpacity: 30,
  borderRadius: "rounded",
  fontScale: 100,
  density: "default",
  sidebarIconOnly: false,
  animationsEnabled: true,
  reducedMotion: false,
  transitionSpeed: "normal",
  coverBreathe: true,
  coverGlint: true,
  cardHoverLift: true,
  cardGlint: true,
  holoEffects: true,
  statusPulse: true,
  toastAnimations: true,
  modalAnimations: true,
  progressBarAnimation: true,
  buttonHoverEffects: true,
};

export const THEME_PREFS_KEY = "statusforge_theme_prefs";
/** Fired on window after theme prefs are written (storage events don't fire in the same window). */
export const THEME_PREFS_EVENT = "sf-theme-prefs-changed";

export function loadThemePrefs(): ThemePrefs {
  try {
    const stored = localStorage.getItem(THEME_PREFS_KEY);
    return stored ? { ...defaultThemePrefs, ...JSON.parse(stored) } : defaultThemePrefs;
  } catch {
    return defaultThemePrefs;
  }
}

export function saveThemePrefs(prefs: ThemePrefs) {
  localStorage.setItem(THEME_PREFS_KEY, JSON.stringify(prefs));
  window.dispatchEvent(new Event(THEME_PREFS_EVENT));
}

export function applyThemePrefs(prefs: ThemePrefs) {
  const root = document.documentElement;
  root.style.setProperty("--user-accent", prefs.accentColor);
  root.style.setProperty("--user-bg", prefs.bgColor);
  root.style.setProperty("--user-bg-opacity", String(prefs.bgOpacity / 100));
  root.style.setProperty("--user-bg-blur", `${prefs.bgBlur}px`);
  root.style.setProperty("--user-bg-image", prefs.bgImage ? `url(${prefs.bgImage})` : "none");
  root.style.setProperty("--user-panel-opacity", String(prefs.panelOpacity / 100));
  root.style.setProperty("--user-font-scale", String(prefs.fontScale / 100));
  root.style.setProperty("--user-radius", prefs.borderRadius === "sharp" ? "2px" : prefs.borderRadius === "soft" ? "8px" : "16px");
  root.style.setProperty("--user-density", prefs.density === "compact" ? "0.75rem" : prefs.density === "spacious" ? "1.5rem" : "1rem");
  const animOff = !prefs.animationsEnabled || prefs.reducedMotion;
  root.style.setProperty("--user-anim-duration", animOff ? "0s" : "unset");
  root.style.setProperty("--user-reduced-motion", prefs.reducedMotion ? "true" : "false");
  root.style.setProperty("--user-transition-speed", animOff ? "0s" : { instant: "0s", fast: "0.1s", normal: "0.2s", slow: "0.4s" }[prefs.transitionSpeed]);
  root.style.setProperty("--user-cover-breathe", prefs.coverBreathe && !animOff ? "unset" : "none");
  root.style.setProperty("--user-cover-glint", prefs.coverGlint && !animOff ? "unset" : "none");
  root.style.setProperty("--user-card-lift", prefs.cardHoverLift && !animOff ? "unset" : "none");
  root.style.setProperty("--user-card-glint", prefs.cardGlint && !animOff ? "unset" : "none");
  root.style.setProperty("--user-holo-opacity", prefs.holoEffects && !animOff ? "1" : "0");
  root.style.setProperty("--user-status-pulse", prefs.statusPulse && !animOff ? "unset" : "none");
  root.style.setProperty("--user-toast-anim", prefs.toastAnimations && !animOff ? "unset" : "none");
  root.style.setProperty("--user-modal-anim", prefs.modalAnimations && !animOff ? "unset" : "none");
  root.style.setProperty("--user-progress-anim", prefs.progressBarAnimation && !animOff ? "unset" : "none");
  root.style.setProperty("--user-btn-hover", prefs.buttonHoverEffects && !animOff ? "unset" : "none");
}
