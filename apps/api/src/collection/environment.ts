/**
 * Environments and releases: where an event's app runs (production,
 * staging …) and which version of it (a version number, a commit). A site
 * names them in its script tag (data-environment, data-release) and the
 * tracker sends them with each batch; reports show one environment at a
 * time (docs/web-analytics.md, section 2).
 */

/** The environment of events whose sender names none. */
export const DEFAULT_ENVIRONMENT = "production";

/**
 * 1 to 64 letters, digits, ".", "_", or "-", starting with a letter or a
 * digit. Stored in lower case, so "Staging" and "staging" are one.
 */
export const ENVIRONMENT_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";

/**
 * 1 to 200 characters, with no spaces or control characters (C0, DEL, and
 * C1): "1.4.2", "web@2026.11.17+3f2a9c1". Anything else gets a 400.
 */
export const RELEASE_PATTERN = "^[^\\s\\u0000-\\u001F\\u007F-\\u009F]{1,200}$";

/** The environment as stored: lower case, or the default when none was sent. */
export function environmentOf(sent: string | undefined): string {
  return sent === undefined ? DEFAULT_ENVIRONMENT : sent.toLowerCase();
}
