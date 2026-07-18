import { describe, it, expect, vi, afterEach } from "vitest";
import { timeAgo } from "./helpers";

describe("timeAgo", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns '—' for falsy input", () => {
    expect(timeAgo(0)).toBe("—");
  });

  it("returns 'now' for recent timestamps (<5s)", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(timeAgo(now)).toBe("now");
    expect(timeAgo(now - 1)).toBe("now");
    expect(timeAgo(now - 4)).toBe("now");
  });

  it("returns seconds for <60s", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(timeAgo(now - 5)).toBe("5s");
    expect(timeAgo(now - 30)).toBe("30s");
    expect(timeAgo(now - 59)).toBe("59s");
  });

  it("returns minutes for >=60s", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(timeAgo(now - 60)).toBe("1m");
    expect(timeAgo(now - 120)).toBe("2m");
    expect(timeAgo(now - 300)).toBe("5m");
  });

  it("clamps negative diff to zero", () => {
    const now = Math.floor(Date.now() / 1000);
    // Future timestamp would give negative diff → clamped to 0 → "now"
    expect(timeAgo(now + 100)).toBe("now");
  });
});
