/**
 * Redact in the logger so stdout, container logs, and the Server log agree.
 * requestLogFields in app.ts excludes headers; these patterns catch secrets
 * and personal data still present in URLs and error text.
 */

import { isLogRecord, type LogRecord } from "./buffer.ts";

export const MASK = "…";

/**
 * Mask secret parameters, including public project keys. Match decoded names
 * so percent-encoded names such as `%74oken` are covered.
 */
const SECRET_NAME =
  /token|secret|passw(?:or)?d|pwd|signature|sig|key|code|state|auth|session|credential/i;

/** A URL's personal-data parameters, as redactUrl lists them, but `p.<name>`. */
const PERSONAL_NAME = /^(?:search|q|user|userId|email)$/i;
/** Their longest name, percent-encoded whole. */
const PERSONAL_ENCODED_LENGTH = 18;

/**
 * A parameter's name as a server reads it: each `%XX` decoded on its own,
 * so a malformed escape stays as it is and nothing throws. A byte above
 * 0x7F becomes a Latin-1 character, which no ASCII name matches.
 */
function decodeName(name: string): string {
  if (!name.includes("%")) return name;
  return name.replace(/%([0-9a-f]{2})/gi, (_escape, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

interface ParameterRules {
  /** Characters a name starts after: `&` also ends a name not yet closed by `=`. */
  separator: RegExp;
  /** Characters that end a name not yet closed by `=`. */
  stop: RegExp;
  /** Where a value ends (global). */
  end: RegExp;
  /**
   * Whether the name ending at `end` is masked. It may start after any of
   * `starts` (each just after a separator, oldest first): a name can hold
   * `?` or `;`, and a parameter can follow one inside another's name.
   */
  masks: (text: string, starts: readonly number[], end: number) => boolean;
}

/**
 * Masks the value of each parameter whose name `rules` mask. One pass over
 * the text: each `=` closes the names open before it, and a masked value
 * is not read again; another's is, for a parameter inside it
 * (`?next=/cb?token=…`).
 */
function maskParameters(text: string, rules: ParameterRules): string {
  let masked = "";
  let from = 0;
  let starts: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === "=") {
      if (starts.length > 0 && rules.masks(text, starts, index)) {
        rules.end.lastIndex = index + 1;
        const stop = rules.end.exec(text)?.index ?? text.length;
        masked += `${text.slice(from, index + 1)}${MASK}`;
        from = stop;
        index = stop - 1;
      }
      starts = [];
    } else if (rules.separator.test(char)) {
      if (char === "&") starts = [];
      starts.push(index + 1);
    } else if (rules.stop.test(char)) {
      starts = [];
    }
  }
  return masked + text.slice(from);
}

/**
 * Secrets in any text. The longest name holds every shorter one, and the
 * pattern matches anywhere in it, so only that one is tested.
 */
const SECRET_PARAMETERS: ParameterRules = {
  separator: /[?&;]/,
  stop: /[#\s"'<>]/,
  end: /[&#\s"'<>]/g,
  masks: (text, starts, end) => SECRET_NAME.test(decodeName(text.slice(starts[0], end))),
};

/**
 * Personal data in a URL. Each name is tested, in constant time: only a
 * short one can be one of PERSONAL_NAME, and `p.` is read from its start.
 */
const PERSONAL_PARAMETERS: ParameterRules = {
  separator: /[?&]/,
  stop: /#/,
  end: /[&#]/g,
  masks: (text, starts, end) =>
    starts.some(
      (start) =>
        (end - start <= PERSONAL_ENCODED_LENGTH &&
          PERSONAL_NAME.test(decodeName(text.slice(start, end)))) ||
        /^p\./i.test(decodeName(text.slice(start, Math.min(end, start + 6)))),
    ),
};

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
  const masked = text
    .replace(URL_USERINFO, `$1${MASK}@`)
    .replace(AUTHORIZATION, `$1 ${MASK}`)
    .replace(SECRET_KEY, `sk_${MASK}`);
  return maskParameters(masked, SECRET_PARAMETERS);
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
 * - an event property filter's value (`p.<property>=`), which may be one too
 *   (each name read after percent-decoding, as redactText's are);
 * - the token in Better Auth's reset link path (`/reset-password/:token`);
 * - a heartbeat's token in its ping URL (`/api/heartbeats/:token`).
 *
 * Other parameters stay: periods, environments, services, routes, models,
 * features, and the names and IDs Ottertrail makes (traces, errors, checks).
 */
export function redactUrl(url: string): string {
  const masked = redactText(url)
    .replace(/(\/users\/)[^/?#]+/g, `$1${MASK}`)
    .replace(/(\/reset-password\/)[^/?#]+/g, `$1${MASK}`)
    .replace(/(\/heartbeats\/)[^/?#]+/g, `$1${MASK}`);
  return maskParameters(masked, PERSONAL_PARAMETERS);
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
