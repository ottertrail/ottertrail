import type { Utm } from "./event-store.ts";

export const MAX_PATH_LENGTH = 2048;
export const MAX_REFERRER_LENGTH = 2048;
export const MAX_UTM_LENGTH = 200;

/** Events older than this, after clock correction, are rejected as too late. */
export const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;

export interface PageUrl {
  /** Lowercase hostname, for checking against the project's allowed hostnames. */
  hostname: string;
  /** Path without the query string or fragment, such as "/lessons/closures", or with a route: "/#/pricing". */
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
 * Format characters (bidi controls, zero-width characters) and the line and
 * paragraph separators: they can hide or reorder displayed text. The AI
 * ingestion schema refuses the same (ai/ingest-routes.ts, NO_FORMAT).
 */
export function hasHiddenCharacters(text: string): boolean {
  return /[\p{Cf}\u2028\u2029]/u.test(text);
}

/** PostgreSQL text and jsonb reject NUL; jsonb also rejects unpaired UTF-16 surrogates. */
export function isStorableText(text: string): boolean {
  return !text.includes("\u0000") && text.isWellFormed();
}

/** The first `max` characters, without cutting an emoji or other character in half. */
export function truncate(text: string, max: number): string {
  const cut = text.slice(0, max);
  return cut.isWellFormed() ? cut : cut.slice(0, -1);
}

/**
 * A hash router's route ("#/pricing"), cut at its query, or "" for any other
 * fragment. A fragment with "=", "&", or a second "#" is no route: sign-in
 * flows put tokens there ("#access_token=…", "#/callback&code=…"). "#/"
 * alone is the home page. The tracker applies the same rule
 * (packages/tracker/src/url.ts); this one does not trust it.
 */
export function routeOf(hash: string): string {
  const route = hash.split("?")[0] ?? "";
  return /^#\/[^=&#]+$/.test(route) ? route : "";
}

/**
 * Keeps the hostname, path, and five UTM tags. Other query fields and fragments
 * can contain secrets. A route-like fragment (routeOf) stays at the end of the
 * path, as "/#/pricing", unless the two together pass the path's limit.
 * Returns null for invalid http(s) URLs or paths over the limit.
 */
export function parsePageUrl(raw: string): PageUrl | null {
  const url = URL.parse(raw);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return null;
  }
  if (url.pathname.length > MAX_PATH_LENGTH) {
    return null;
  }
  const route = routeOf(url.hash);
  const path =
    url.pathname.length + route.length > MAX_PATH_LENGTH ? url.pathname : url.pathname + route;

  const utm: Utm = {};
  for (const [field, param] of UTM_PARAMS) {
    const value = url.searchParams.get(param)?.trim();
    // Drop invalid tags such as %00 without losing the event.
    if (value && isStorableText(value)) {
      utm[field] = truncate(value, MAX_UTM_LENGTH);
    }
  }
  return { hostname: url.hostname, path, utm };
}

/**
 * Strips queries and fragments that may contain secrets. App referrers keep their
 * scheme and host. Invalid, empty, or oversized referrers do not discard the event.
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
 * Trusts the sender's elapsed time (sentAt - occurredAt), relative to receipt.
 * Retries can shift by network delay. ClickHouse deduplicates by project, day, and
 * ID (clickhouse/migrations.ts, 0001), unless retries straddle midnight UTC.
 * Clamps occurredAt to sentAt and rejects corrected ages over MAX_EVENT_AGE_MS.
 */
export function correctClock(occurredAt: number, sentAt: number, receivedAt: number): Date | null {
  const ageAtSend = Math.max(0, sentAt - occurredAt);
  if (ageAtSend > MAX_EVENT_AGE_MS) {
    return null;
  }
  return new Date(receivedAt - ageAtSend);
}

/** Hostnames match exactly, ignoring case. */
export function isAllowedHostname(hostname: string, allowed: readonly string[]): boolean {
  const wanted = hostname.toLowerCase();
  return allowed.some((candidate) => candidate.toLowerCase() === wanted);
}

/** Sandboxed iframes and file:// pages send "null", which returns null here. */
export function originHostname(origin: string): string | null {
  const url = URL.parse(origin);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return null;
  }
  return url.hostname;
}
