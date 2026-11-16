import { UNSTORABLE } from "./sanitize.ts";

const UTM_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];

/** The API's limits: longer URLs or paths fail the whole batch. */
export const MAX_URL_LENGTH = 8192;
export const MAX_PATH_LENGTH = 2048;

/**
 * The page URL to send: origin and path, plus only the five UTM campaign
 * tags. Everything else in the query string and the fragment is removed in
 * the browser, so secrets such as "?token=…" never leave the visitor's
 * device. (The API removes them again; it does not trust senders.)
 *
 * A UTM tag whose value PostgreSQL cannot store (a NUL from "%00") is left
 * out. Returns "" when the cleaned URL or its path is longer than the API
 * accepts: events on such a page are not sent.
 */
export function cleanPageUrl(href: string): string {
  const url = new URL(href);
  const clean = new URL(url.origin + url.pathname);
  for (const param of UTM_PARAMS) {
    const value = url.searchParams.get(param);
    if (value && !UNSTORABLE.test(value)) {
      clean.searchParams.set(param, value);
    }
  }
  return clean.href.length > MAX_URL_LENGTH || clean.pathname.length > MAX_PATH_LENGTH
    ? ""
    : clean.href;
}

/**
 * Where the visitor came from, without query string or fragment. App
 * referrers (android-app://…) keep only their scheme and host. Returns
 * undefined for no referrer, one that cannot be parsed, or one longer than
 * the API accepts.
 */
export function cleanReferrer(referrer: string): string | undefined {
  if (!referrer) {
    return undefined;
  }
  try {
    const url = new URL(referrer);
    const clean =
      url.protocol === "https:" || url.protocol === "http:"
        ? url.origin + url.pathname
        : `${url.protocol}//${url.host}`;
    return clean.length > MAX_URL_LENGTH ? undefined : clean;
  } catch {
    return undefined;
  }
}
