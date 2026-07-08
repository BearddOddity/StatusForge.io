import { describe, it, expect } from "vitest";
import { clampInt } from "./number";

describe("clampInt", () => {
  it("passes through a normal in-range value", () => {
    expect(clampInt("30", 0, 300, 5)).toBe(30);
  });

  it("clamps a negative value up to min, instead of passing it through", () => {
    // Regression test: this exact gap (a typed "-1" sailing past parseInt
    // unclamped) caused every engine-settings save to fail with "invalid
    // args `payload`" — the Rust fields are unsigned (u64), which can never
    // legally be negative, so Tauri's IPC layer rejected it outright.
    expect(clampInt("-1", 2, 300, 2)).toBe(2);
    expect(clampInt("-999", 0, 100, 0)).toBe(0);
  });

  it("clamps a too-large value down to max", () => {
    expect(clampInt("9999", 1, 60, 5)).toBe(60);
  });

  it("falls back on empty input", () => {
    expect(clampInt("", 2, 300, 2)).toBe(2);
  });

  it("falls back on non-numeric input", () => {
    expect(clampInt("abc", 1, 60, 1)).toBe(1);
  });

  it("respects a non-zero floor (e.g. the scan interval's 2s minimum)", () => {
    expect(clampInt("0", 2, 300, 2)).toBe(2);
    expect(clampInt("1", 2, 300, 2)).toBe(2);
    expect(clampInt("2", 2, 300, 2)).toBe(2);
  });
});
