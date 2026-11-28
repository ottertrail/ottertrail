/**
 * The link a tracker's outbound_link or file_download event carries
 * (docs/web-analytics.md, "Links and not found pages").
 */

/** As long as any property value may be (routes.ts, PROPERTIES_SCHEMA). */
export const MAX_LINK_LENGTH = 500;

/**
 * The link's origin and path, without credentials, query string, or
 * fragment, and its hostname, which a goal can match exactly. null for
 * anything but an http(s) URL of at most MAX_LINK_LENGTH characters.
 */
export function linkProperties(value: unknown): { url: string; host: string } | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const clean = url.origin + url.pathname;
  return clean.length > MAX_LINK_LENGTH ? null : { url: clean, host: url.hostname };
}
