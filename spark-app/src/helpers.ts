export function timeAgo(secs: number): string {
  if (!secs) return "—";
  const d = Math.max(0, Math.floor(Date.now() / 1000 - secs));
  if (d < 5) return "now";
  if (d < 60) return `${d}s`;
  return `${Math.floor(d / 60)}m`;
}
