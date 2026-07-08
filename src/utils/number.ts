// Parses + clamps a number input to [min, max], falling back to `fallback`
// for empty/non-numeric input. The backend engine settings this feeds are
// unsigned (u64) — an out-of-range value like a typed "-1" would otherwise
// pass straight through parseInt and get rejected by Tauri's IPC layer as an
// invalid arg payload instead of being sanitized.
export function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
