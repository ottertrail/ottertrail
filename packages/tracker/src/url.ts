import { UNSTORABLE } from "./sanitize.ts";

const UTM_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];

/** The API's limits: longer URLs or paths fail the whole batch. */
export const MAX_URL_LENGTH = 8192;
export const MAX_PATH_LENGTH = 2048;

/**
 * A hash router's route ("#/pricing"), cut at its query, or "" for any
 * other fragment. A fragment with "=", "&", or a second "#" is no route:
 * sign-in flows put tokens there ("#access_token=…", "#/callback&code=…").
 * "#/" alone is the home page, the same as no fragment. The API applies the
 * same rule (routeOf in apps/api/src/collection/normalize.ts).
 */
export function routeOf(hash: string): string {
  const route = hash.split("?")[0] ?? "";
  return /^#\/[^=&#]+$/.test(route) ? route : "";
}

/**
 * The page URL to send: origin and path, plus only the five UTM campaign
 * tags, `ref` when there is no utm_source (unless `ref` is false, for
 * data-ref="off"), and with `hashRoutes` the fragment's route (routeOf). Everything
 * else in the query string and the fragment is removed in the browser, so
 * secrets such as "?token=…" never leave the visitor's device. (The API
 * removes them again; it does not trust senders.)
 *
 * A tag that is blank, or whose value PostgreSQL cannot store (a NUL from
 * "%00"), is left out. Returns "" when the cleaned URL or its path and route are longer than
 * the API accepts: events on such a page are not sent.
 */
export function cleanPageUrl(href: string, hashRoutes = false, ref = true): string {
  const url = new URL(href);
  const clean = new URL(url.origin + url.pathname);
  if (hashRoutes) clean.hash = routeOf(url.hash);
  const keep = (param: string) => {
    const value = url.searchParams.get(param);
    if (value?.trim() && !UNSTORABLE.test(value)) {
      clean.searchParams.set(param, value);
    }
  };
  for (const param of UTM_PARAMS) keep(param);
  // The source when there is no utm_source; the API reads it so too.
  if (ref && !clean.searchParams.has("utm_source")) keep("ref");
  return clean.href.length > MAX_URL_LENGTH ||
    clean.pathname.length + clean.hash.length > MAX_PATH_LENGTH
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
