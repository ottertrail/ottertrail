import type { Utm } from "./event-store.ts";

/**
 * Turns what a browser sends into what Ottertrail stores. Pure functions:
 * no I/O, so every rule here is unit-tested on its own.
 */

export const MAX_PATH_LENGTH = 2048;
export const MAX_REFERRER_LENGTH = 2048;
export const MAX_UTM_LENGTH = 200;

/** Events older than this, after clock correction, are rejected as too late. */
export const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;

export interface PageUrl {
  /** Lowercase hostname, for checking against the project's allowed hostnames. */
  hostname: string;
  /** Path without the query string or fragment, such as "/lessons/closures". */
  path: string;
  utm: Utm;
}

const UTM_PARAMS = [
  ["source", "utm_source"],
  ["medium", "utm_medium"],
  ["campaign", "utm_campaign"],
  ["term", "utm_term"],
  ["content", "utm_content"],
] as const;

/**
 * Whether PostgreSQL can store a string: text and jsonb cannot hold the NUL
 * character, and jsonb rejects an unpaired UTF-16 surrogate (half of an
 * emoji, for example), which only broken or hostile senders produce.
 */
export function isStorableText(text: string): boolean {
  return !text.includes("\u0000") && text.isWellFormed();
}

/** The first `max` characters, without cutting an emoji or other character in half. */
function truncate(text: string, max: number): string {
  const cut = text.slice(0, max);
  return cut.isWellFormed() ? cut : cut.slice(0, -1);
}

/**
 * Parses the page URL an event happened on.
 *
 * Keeps the hostname, the path, and the five UTM campaign tags. Drops the
 * rest of the query string and the fragment: they can hold secrets such as
 * reset tokens or session IDs. Returns null when the URL is not a valid
 * http(s) URL or its path is too long.
 */
export function parsePageUrl(raw: string): PageUrl | null {
  const url = URL.parse(raw);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return null;
  }
  if (url.pathname.length > MAX_PATH_LENGTH) {
    return null;
  }

  const utm: Utm = {};
  for (const [field, param] of UTM_PARAMS) {
    const value = url.searchParams.get(param)?.trim();
    // A tag that decodes to text PostgreSQL cannot store (`%00`) is dropped,
    // like a broken referrer: it is not a reason to lose the event.
    if (value && isStorableText(value)) {
      utm[field] = truncate(value, MAX_UTM_LENGTH);
    }
  }
  return { hostname: url.hostname, path: url.pathname, utm };
}

/**
 * Reduces a referrer to where the visitor came from, without its query
 * string or fragment, which can hold secrets from the previous site.
 *
 * - "https://news.ycombinator.com/item?id=1" becomes "https://news.ycombinator.com/item"
 * - App referrers such as "android-app://com.google.android.gm/" keep their scheme and host.
 * - Anything unparseable, empty, or too long becomes undefined: a bad
 *   referrer is not a reason to lose the event.
 */
export function cleanReferrer(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const url = URL.parse(raw.trim());
  if (url === null) {
    return undefined;
  }
  const cleaned =
    url.protocol === "https:" || url.protocol === "http:"
      ? `${url.origin}${url.pathname}`
      : `${url.protocol}//${url.host}`;
  return cleaned.length > MAX_REFERRER_LENGTH ? undefined : cleaned;
}

/**
 * Converts a time on the sender's clock to the server's clock.
 *
 * The sender reports when the event happened (occurredAt) and when it sent
 * the batch (sentAt), both by its own clock, which may be wrong by minutes
 * or days. Only the difference between the two is trusted: the event
 * happened (sentAt - occurredAt) before the server received the batch.
 *
 * An event cannot happen after it was sent, so a later occurredAt is
 * treated as sentAt. Returns null when the corrected time is older than
 * MAX_EVENT_AGE_MS.
 */
export function correctClock(occurredAt: number, sentAt: number, receivedAt: number): Date | null {
  const ageAtSend = Math.max(0, sentAt - occurredAt);
  if (ageAtSend > MAX_EVENT_AGE_MS) {
    return null;
  }
  return new Date(receivedAt - ageAtSend);
}

/** Whether a hostname is one of the project's allowed hostnames (exact, case-insensitive). */
export function isAllowedHostname(hostname: string, allowed: readonly string[]): boolean {
  const wanted = hostname.toLowerCase();
  return allowed.some((candidate) => candidate.toLowerCase() === wanted);
}

/**
 * The hostname of a browser's Origin header, or null when the header is
 * "null" or not a valid origin (sandboxed iframes and file:// pages send
 * "null").
 */
export function originHostname(origin: string): string | null {
  const url = URL.parse(origin);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return null;
  }
  return url.hostname;
}
