import { convertFileSrc } from "@tauri-apps/api/core";

// Cover/logo fields accept a direct image URL or a local file path. A raw
// path can't be used as an <img src> though — it needs Tauri's asset
// protocol — so anything that isn't already a URL scheme goes through
// convertFileSrc(). Already-converted values pass through untouched too.
const URL_SCHEME_RE = /^(https?:|data:|blob:|asset:)/i;

export function resolveImageSrc(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || URL_SCHEME_RE.test(trimmed)) return trimmed;
  return convertFileSrc(trimmed);
}
