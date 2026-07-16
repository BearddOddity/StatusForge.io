import { convertFileSrc } from "@tauri-apps/api/core";

// Cover/logo fields accept either a direct image URL or a local absolute
// file path (typed in, or pasted from Explorer/Finder's "Copy as path").
// A raw file path can't be used as an <img src> in the webview — it needs
// Tauri's asset protocol (asset://, or http://asset.localhost on Windows),
// so anything that isn't already a URL scheme gets converted through
// convertFileSrc(). Values already in a recognized scheme pass through
// untouched, including ones already converted (idempotent).
const URL_SCHEME_RE = /^(https?:|data:|blob:|asset:)/i;

export function resolveImageSrc(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || URL_SCHEME_RE.test(trimmed)) return trimmed;
  return convertFileSrc(trimmed);
}
