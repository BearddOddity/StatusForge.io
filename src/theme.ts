// ─── Shared theme preferences: storage + CSS variable application ───────────
// Used by both App.tsx (apply on boot) and SettingsView's Theme tab (apply on
// change), so every theme setting persists and takes effect after reload.
//
// Storage: this used to own a private "statusforge_theme_prefs" localStorage
// key, completely separate from the rest of StreamerSuite's Settings ->
// Appearance tab — so opening StatusForge would silently clobber whatever
// accent/background/effects the user had just set elsewhere, and vice
// versa. It now reads/writes the SAME unified settings key
// (SharedSettingsContext's STORAGE_KEY, under its .theme section) and
// notifies that context of external writes via SETTINGS_CHANGED_EVENT, so
// there's exactly one source of truth for theme regardless of which
// screen edited it. The functions below keep their original signatures —
// only their storage backing changed — so nothing in App.tsx or
// SettingsView.tsx needed to change.

import { STORAGE_KEY, SETTINGS_CHANGED_EVENT, defaultSharedSettings, resolveImageSrc } from "@/settings";
import type { ThemeConfig } from "@/settings";

export interface ThemePrefs {
  accentColor: string;
  bgColor: string;
  bgOpacity: number;
  bgBlur: number;
  bgImage: string;
  panelOpacity: number;
  borderRadius: "sharp" | "soft" | "rounded";
  fontScale: number;
  /** Google Fonts family name, or "Montserrat" for the bundled (offline) default. */
  fontFamily: string;
  /** Base body text weight — headings/labels with their own explicit weight
   *  classes are unaffected, same as fontFamily's cascade. */
  fontWeight: 400 | 500 | 600 | 700 | 800 | 900;
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
  fontFamily: "Montserrat",
  fontWeight: 400,
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

/** Fired after theme prefs are written — same event SharedSettingsContext
 *  listens for and dispatches, so a save from either screen reaches both. */
export const THEME_PREFS_EVENT = SETTINGS_CHANGED_EVENT;

// ThemePrefs.fontWeight is a number union (this UI's own dropdown values);
// the unified ThemeConfig.fontWeight is a string (matches the main
// Appearance tab's <select> value type). Every other overlapping field
// already shares the same name and type between the two.
function toThemePrefs(theme: ThemeConfig): ThemePrefs {
  const fontWeight = Number(theme.fontWeight);
  return {
    accentColor: theme.accentColor,
    bgColor: theme.bgColor,
    bgOpacity: theme.bgOpacity,
    bgBlur: theme.bgBlur,
    bgImage: theme.bgImage,
    panelOpacity: theme.panelOpacity,
    borderRadius: theme.borderRadius,
    fontScale: theme.fontScale,
    fontFamily: theme.fontFamily,
    fontWeight: ([400, 500, 600, 700, 800, 900] as const).includes(fontWeight as 400) ? (fontWeight as ThemePrefs["fontWeight"]) : 400,
    sidebarIconOnly: theme.sidebarIconOnly,
    animationsEnabled: theme.animationsEnabled,
    reducedMotion: theme.reducedMotion,
    transitionSpeed: theme.transitionSpeed,
    coverBreathe: theme.coverBreathe,
    coverGlint: theme.coverGlint,
    cardHoverLift: theme.cardHoverLift,
    cardGlint: theme.cardGlint,
    holoEffects: theme.holoEffects,
    statusPulse: theme.statusPulse,
    toastAnimations: theme.toastAnimations,
    modalAnimations: theme.modalAnimations,
    progressBarAnimation: theme.progressBarAnimation,
    buttonHoverEffects: theme.buttonHoverEffects,
  };
}

// See the matching guard (and its size rationale) in
// SharedSettingsContext.tsx's load(): a previously-stored oversized
// wallpaper must be stripped on read too, or every write through this path
// re-inherits it and keeps failing the localStorage quota forever.
const MAX_BG_IMAGE_CHARS = 3_000_000;

function readUnifiedTheme(): ThemeConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.theme) {
        const merged = { ...defaultSharedSettings.theme, ...parsed.theme };
        if (merged.bgImage && merged.bgImage.length > MAX_BG_IMAGE_CHARS) merged.bgImage = "";
        return merged;
      }
    }
  } catch {
    /* ignore */
  }
  return defaultSharedSettings.theme;
}

export function loadThemePrefs(): ThemePrefs {
  return toThemePrefs(readUnifiedTheme());
}

export function saveThemePrefs(prefs: ThemePrefs) {
  let unified: Record<string, unknown> = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) unified = JSON.parse(raw);
  } catch {
    /* ignore */
  }
  const nextTheme: ThemeConfig = {
    ...defaultSharedSettings.theme,
    ...readUnifiedTheme(),
    ...prefs,
    fontWeight: String(prefs.fontWeight),
  };
  const next = { ...unified, theme: nextTheme };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    // Same failure mode as SharedSettingsContext's persist effect: an
    // oversized bgImage data URI can blow the localStorage quota. Drop it
    // and retry once so the rest of the theme still saves.
    console.error("Failed to persist theme prefs, retrying without background image:", err);
    if (nextTheme.bgImage) {
      const fallback = { ...unified, theme: { ...nextTheme, bgImage: "" } };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback));
      } catch {
        /* give up — nothing more we can safely drop */
      }
    }
  }
  window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
}

// Google Fonts <link> element id — reused/updated in place rather than
// re-appended, so switching fonts doesn't leak stylesheet tags.
const GOOGLE_FONT_LINK_ID = "sf-google-font-link";

/**
 * Loads a custom Google Font by family name via a <link> tag. "Montserrat"
 * (the bundled default) skips this entirely — it's always available offline
 * via the @font-face rules in index.css. An invalid/unreachable family name
 * just means Google's stylesheet defines no matching @font-face, so the
 * font-family fallback chain in index.css's `body` rule quietly lands back
 * on Montserrat — no special error handling needed for that case.
 */
function loadGoogleFont(family: string) {
  const trimmed = family.trim();
  const existing = document.getElementById(GOOGLE_FONT_LINK_ID) as HTMLLinkElement | null;

  if (!trimmed || trimmed.toLowerCase() === "montserrat") {
    existing?.remove();
    return;
  }

  const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(trimmed).replace(/%20/g, "+")}:wght@400;500;600;700;800;900&display=swap`;
  if (existing) {
    if (existing.dataset.family === trimmed) return; // already loaded
    existing.href = href;
    existing.dataset.family = trimmed;
  } else {
    const link = document.createElement("link");
    link.id = GOOGLE_FONT_LINK_ID;
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.family = trimmed;
    document.head.appendChild(link);
  }
}

export function applyThemePrefs(prefs: ThemePrefs) {
  const root = document.documentElement;
  root.style.setProperty("--user-accent", prefs.accentColor);
  root.style.setProperty("--user-bg", prefs.bgColor);
  root.style.setProperty("--user-bg-opacity", String(prefs.bgOpacity / 100));
  root.style.setProperty("--user-bg-blur", `${prefs.bgBlur}px`);
  root.style.setProperty("--user-bg-image", prefs.bgImage ? `url(${resolveImageSrc(prefs.bgImage)})` : "none");
  root.style.setProperty("--user-panel-opacity", String(prefs.panelOpacity / 100));
  root.style.setProperty("--user-font-scale", String(prefs.fontScale / 100));
  root.style.setProperty("--user-font-family", `"${(prefs.fontFamily || "Montserrat").trim()}"`);
  root.style.setProperty("--user-font-weight", String(prefs.fontWeight || 400));
  loadGoogleFont(prefs.fontFamily || "Montserrat");
  root.style.setProperty(
    "--user-radius",
    prefs.borderRadius === "sharp" ? "2px" : prefs.borderRadius === "soft" ? "8px" : "16px"
  );
  const animOff = !prefs.animationsEnabled || prefs.reducedMotion;
  root.style.setProperty("--user-anim-duration", animOff ? "0s" : "unset");
  root.style.setProperty("--user-reduced-motion", prefs.reducedMotion ? "true" : "false");
  root.style.setProperty(
    "--user-transition-speed",
    animOff
      ? "0s"
      : { instant: "0s", fast: "0.1s", normal: "0.2s", slow: "0.4s" }[prefs.transitionSpeed]
  );
  root.style.setProperty("--user-cover-breathe", prefs.coverBreathe && !animOff ? "unset" : "none");
  root.style.setProperty("--user-cover-glint", prefs.coverGlint && !animOff ? "unset" : "none");
  root.style.setProperty("--user-card-lift", prefs.cardHoverLift && !animOff ? "unset" : "none");
  root.style.setProperty("--user-card-glint", prefs.cardGlint && !animOff ? "unset" : "none");
  root.style.setProperty("--user-holo-opacity", prefs.holoEffects && !animOff ? "1" : "0");
  root.style.setProperty("--user-status-pulse", prefs.statusPulse && !animOff ? "unset" : "none");
  root.style.setProperty("--user-toast-anim", prefs.toastAnimations && !animOff ? "unset" : "none");
  root.style.setProperty("--user-modal-anim", prefs.modalAnimations && !animOff ? "unset" : "none");
  root.style.setProperty(
    "--user-progress-anim",
    prefs.progressBarAnimation && !animOff ? "unset" : "none"
  );
  root.style.setProperty(
    "--user-btn-hover",
    prefs.buttonHoverEffects && !animOff ? "unset" : "none"
  );
}
