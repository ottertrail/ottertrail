/**
 * What the API's and the worker's log lines never hold: secrets, and the
 * personal data reports keep apart from logs. Applied in the logger itself
 * (destination.ts, the worker's `log`), so stdout, `docker compose logs`,
 * and the Settings page's Server log all get the same masked line.
 *
 * Request lines record only the method and URL (requestLogFields in
 * app.ts): never headers, so Authorization and Cookie never reach a log.
 * These patterns catch what a URL or an error's text can still carry.
 */

import { isLogRecord, type LogRecord } from "./buffer.ts";

/** What a masked value becomes. */
export const MASK = "…";

/**
 * Query parameters whose value is a secret wherever they appear: a
 * one-time token (Better Auth's email verification and reset links), a
 * project key (`/api/replays?key=`, a public key, masked anyway), an OAuth
 * code or state, a signature, a password, a session.
 */
const SECRET_PARAMETER =
  /([?&;](?:[^=&#\s"'<>]*?(?:token|secret|passw(?:or)?d|pwd|signature|sig|key|code|state|auth|session|credential)[^=&#\s"'<>]*)=)[^&#\s"'<>]*/gi;

/**
 * The user and password in a URL: `postgres://ottertrail:…@postgres`, an
 * SMTP_URL, a webhook with credentials. Up to the last `@` before the
 * host, as URL parsers read it, so a password holding `@` is masked whole.
 */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#"'<>]*@/gi;

/**
 * An Authorization header's value, wherever it was copied: `Bearer sk_…`,
 * `Basic dXNlcjpwYXNz`. A credential holds a digit or one of `+/=_`, so
 * prose ("Basic authentication failed") stays as it is.
 */
const AUTHORIZATION = /\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]*[0-9+/=_])[A-Za-z0-9._~+/=-]{8,}/gi;

/** A project's secret key (`sk_` and 32 hex characters, collection/project-keys.ts). */
const SECRET_KEY = /\bsk_[0-9a-f]{32}\b/g;

/** Masks secrets in any text: URLs with credentials or tokens, Authorization values, secret keys. */
export function redactText(text: string): string {
  if (!/[@?&;]|bearer|basic|sk_/i.test(text)) return text;
  return text
    .replace(URL_USERINFO, `$1${MASK}@`)
    .replace(AUTHORIZATION, `$1 ${MASK}`)
    .replace(SECRET_KEY, `sk_${MASK}`)
    .replace(SECRET_PARAMETER, `$1${MASK}`);
}

/**
 * A request's URL as its log line records it: the secrets redactText
 * masks, and personal data a report's address can carry:
 *
 * - a site user's ID in a path (`/projects/:id/users/:userId`), and a
 *   dashboard user's in an avatar's (`/api/avatars/users/:userId/…`);
 * - a site user's ID in a query: the API's `userId=` (the replays list)
 *   and `user=` (the dashboard's pages: Replays, Users, Errors, AI);
 * - text a user typed, which may be a user's ID, name, or email: `search=`
 *   (the users, the reports, the logs, the heatmap pages) and the
 *   dashboard's `q=` (the Logs page);
 * - an `email=` anywhere;
 * - an event property filter's value (`p.<property>=`), which may be one too;
 * - the token in Better Auth's reset link path (`/reset-password/:token`).
 *
 * Other parameters stay: periods, environments, services, routes, models,
 * features, and the names and IDs Ottertrail makes (traces, errors, checks).
 */
export function redactUrl(url: string): string {
  return redactText(url)
    .replace(/(\/users\/)[^/?#]+/g, `$1${MASK}`)
    .replace(/(\/reset-password\/)[^/?#]+/g, `$1${MASK}`)
    .replace(/([?&](?:search|q|user|userId|email|p\.[^=&#]*)=)[^&#]*/gi, `$1${MASK}`);
}

/**
 * The paths in a message, as redactUrl masks a request's URL: Fastify's
 * "Route GET:/api/…?userId=… not found" names the raw URL in its text.
 */
export function redactMessage(text: string): string {
  if (!text.includes("/")) return text;
  return text.replace(
    /(^|[\s:(=])(\/[^\s"'<>]*)/g,
    (_match, before: string, path: string) => `${before}${redactUrl(path)}`,
  );
}

/**
 * Masks every string in a log line's object, keys left as they are, and
 * says whether anything changed. Objects deeper than a log line's are cut
 * off rather than walked forever.
 */
export function redactRecord(record: LogRecord): { value: LogRecord; changed: boolean } {
  let changed = false;
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") {
      const masked = redactText(value);
      if (masked !== value) changed = true;
      return masked;
    }
    if (value === null || typeof value !== "object" || depth > 20) return value;
    if (Array.isArray(value)) {
      let copy: unknown[] | null = null;
      value.forEach((item, index) => {
        const next = walk(item, depth + 1);
        if (next !== item) {
          copy ??= [...value];
          copy[index] = next;
        }
      });
      return copy ?? value;
    }
    const entries = Object.entries(value);
    let copy: Record<string, unknown> | null = null;
    for (const [key, item] of entries) {
      const next = walk(item, depth + 1);
      if (next !== item) {
        copy ??= Object.fromEntries(entries);
        copy[key] = next;
      }
    }
    return copy ?? value;
  };
  const walked = walk(record, 0);
  const value = isLogRecord(walked) ? walked : record;
  if (typeof value.msg === "string") {
    const msg = redactMessage(value.msg);
    if (msg !== value.msg) return { value: { ...value, msg }, changed: true };
  }
  return { value, changed };
}
