const UTM_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];

/**
 * The page URL to send: origin and path, plus only the five UTM campaign
 * tags. Everything else in the query string and the fragment is removed in
 * the browser, so secrets such as "?token=…" never leave the visitor's
 * device. (The API removes them again; it does not trust senders.)
 */
export function cleanPageUrl(href: string): string {
  const url = new URL(href);
  const clean = new URL(url.origin + url.pathname);
  for (const param of UTM_PARAMS) {
    const value = url.searchParams.get(param);
    if (value) {
      clean.searchParams.set(param, value);
    }
  }
  return clean.href;
}

/**
 * Where the visitor came from, without query string or fragment. App
 * referrers (android-app://…) keep only their scheme and host. Returns
 * undefined for no referrer or one that cannot be parsed.
 */
export function cleanReferrer(referrer: string): string | undefined {
  if (!referrer) {
    return undefined;
  }
  try {
    const url = new URL(referrer);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin + url.pathname
      : `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}
