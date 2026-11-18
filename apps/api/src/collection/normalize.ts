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

/** A sender's clock off by less than this is taken as right (correctClock). */
export const CLOCK_TOLERANCE_MS = 60 * 1000;

/**
 * Converts a time on the sender's clock to the server's clock.
 *
 * The sender reports when the event happened (occurredAt) and when it sent
 * the batch (sentAt), both by its own clock, which may be wrong by minutes
 * or days. The difference between when the server received the batch and
 * when the sender says it sent it is the sender's clock error plus the
 * time the request spent on the way:
 *
 * - Under a minute either way, the clock is taken as right, and the event
 *   keeps the sender's time.
 * - Otherwise the event's time moves by that difference rounded to whole
 *   minutes.
 *
 * The result must be the same on every attempt to send the event: a retry
 * is stored as a second row with the same ID and time, which ClickHouse
 * keeps once (event-store.ts). The tracker reads sentAt again for each
 * attempt, and the time on the way differs each time, so the correction
 * leaves that time out: the event cannot simply be placed
 * (sentAt - occurredAt) before arrival. The cost is that a corrected time
 * can be off by up to half a minute plus the time on the way, which
 * reports, counting by day and hour, do not show.
 *
 * One case still counts twice: a clock off by about a minute or more,
 * whose attempts' times on the way differ enough that the difference
 * rounds to another whole minute (or crosses the one-minute line). That
 * needs a wrong clock and a slow attempt; it is rare.
 *
 * An event cannot happen after it was sent, but a clock set back between
 * the two (by a time sync) can make it seem so. Up to a minute after, the
 * event keeps its time; further, it is placed at the start of the minute
 * it was sent in. Neither uses sentAt as it is, which changes with each
 * attempt. Returns null when the event was more than MAX_EVENT_AGE_MS old
 * when it was sent.
 */
export function correctClock(occurredAt: number, sentAt: number, receivedAt: number): Date | null {
  const ageAtSend = Math.max(0, sentAt - occurredAt);
  if (ageAtSend > MAX_EVENT_AGE_MS) {
    return null;
  }
  const offset = receivedAt - sentAt;
  const correction =
    Math.abs(offset) < CLOCK_TOLERANCE_MS
      ? 0
      : Math.round(offset / CLOCK_TOLERANCE_MS) * CLOCK_TOLERANCE_MS;
  const at =
    occurredAt <= sentAt + CLOCK_TOLERANCE_MS
      ? occurredAt
      : Math.floor(sentAt / CLOCK_TOLERANCE_MS) * CLOCK_TOLERANCE_MS;
  return new Date(at + correction);
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
