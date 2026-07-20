import { convertFileSrc } from "@tauri-apps/api/core";

// Cover/logo fields accept a direct image URL or a local file path. A raw
// path can't be used as an <img src> though — it needs Tauri's asset
// protocol — so anything that isn't a scheme this app actually serves images
// over goes through convertFileSrc() instead of being used as-is. Parsed
// with the URL constructor (not a regex) so a scheme is only ever accepted
// when it's genuinely the URL's protocol — not, say, a colon appearing
// somewhere later in an otherwise-relative-looking string — and anything
// that isn't a well-formed absolute URL at all (a bare filesystem path,
// which is the common case) falls through to convertFileSrc() too.
const ALLOWED_IMAGE_PROTOCOLS = new Set(["http:", "https:", "asset:"]);

export function resolveImageSrc(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  try {
    if (ALLOWED_IMAGE_PROTOCOLS.has(new URL(trimmed).protocol)) return trimmed;
  } catch {
    // Not a well-formed absolute URL — treat it as a local path below.
  }
  return convertFileSrc(trimmed);
}
