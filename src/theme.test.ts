import { describe, it, expect, beforeEach } from "vitest";
import {
  loadThemePrefs,
  saveThemePrefs,
  applyThemePrefs,
  defaultThemePrefs,
  THEME_PREFS_KEY,
} from "./theme";

describe("loadThemePrefs", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns defaults when nothing is stored", () => {
    expect(loadThemePrefs()).toEqual(defaultThemePrefs);
  });

  it("merges stored prefs over defaults, filling in missing fields", () => {
    // Simulates an old prefs blob saved before a new field (e.g. fontWeight)
    // existed — must not crash and must fall back to the default for it.
    localStorage.setItem(THEME_PREFS_KEY, JSON.stringify({ accentColor: "#123456" }));

    const prefs = loadThemePrefs();

    expect(prefs.accentColor).toBe("#123456");
    expect(prefs.fontFamily).toBe(defaultThemePrefs.fontFamily);
    expect(prefs.fontWeight).toBe(defaultThemePrefs.fontWeight);
  });

  it("falls back to defaults on corrupt JSON instead of throwing", () => {
    localStorage.setItem(THEME_PREFS_KEY, "{not valid json");

    expect(() => loadThemePrefs()).not.toThrow();
    expect(loadThemePrefs()).toEqual(defaultThemePrefs);
  });

  it("no longer has a density field — regression guard for the removed dead setting", () => {
    expect(defaultThemePrefs).not.toHaveProperty("density");
  });
});

describe("saveThemePrefs", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("persists prefs so a later loadThemePrefs sees them", () => {
    saveThemePrefs({ ...defaultThemePrefs, accentColor: "#abcdef" });

    expect(loadThemePrefs().accentColor).toBe("#abcdef");
  });

  it("fires the change event so App.tsx's sidebar listener stays in sync", () => {
    let fired = false;
    window.addEventListener("sf-theme-prefs-changed", () => {
      fired = true;
    });

    saveThemePrefs(defaultThemePrefs);

    expect(fired).toBe(true);
  });
});

describe("applyThemePrefs", () => {
  it("sets the font family CSS variable to the bundled default", () => {
    applyThemePrefs({ ...defaultThemePrefs, fontFamily: "Montserrat" });

    expect(document.documentElement.style.getPropertyValue("--user-font-family")).toBe(
      '"Montserrat"'
    );
  });

  it("removes the Google Font <link> when set back to Montserrat", () => {
    applyThemePrefs({ ...defaultThemePrefs, fontFamily: "Poppins" });
    expect(document.getElementById("sf-google-font-link")).not.toBeNull();

    applyThemePrefs({ ...defaultThemePrefs, fontFamily: "Montserrat" });
    expect(document.getElementById("sf-google-font-link")).toBeNull();
  });

  it("injects a Google Fonts link with the requested family for a custom font", () => {
    applyThemePrefs({ ...defaultThemePrefs, fontFamily: "Poppins" });

    const link = document.getElementById("sf-google-font-link") as HTMLLinkElement | null;
    expect(link).not.toBeNull();
    expect(link!.href).toContain("family=Poppins");
  });
});
