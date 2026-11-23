/** Script tag attributes data-environment and data-release apply to each batch (docs/web-analytics.md, section 2). */

export const DEFAULT_ENVIRONMENT = "production";

/** Stored in lowercase so "Staging" and "staging" share an environment. */
export const ENVIRONMENT_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";

export const RELEASE_PATTERN = "^[^\\s\\u0000-\\u001F\\u007F-\\u009F]{1,200}$";

export function environmentOf(sent: string | undefined): string {
  return sent === undefined ? DEFAULT_ENVIRONMENT : sent.toLowerCase();
}
