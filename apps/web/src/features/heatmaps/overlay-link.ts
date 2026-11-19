import type { HeatmapDevice } from "@/lib/heatmaps-api";

/**
 * Opening a page of the site with its heatmap drawn over it
 * (docs/web-analytics.md, "The overlay on your site"): where, and in a
 * window of what width.
 */

/** The window widths offered, one per device class, in CSS pixels. */
export const OVERLAY_WIDTHS = [
  { value: "mobile", label: "Phone", width: 390, height: 844 },
  { value: "tablet", label: "Tablet", width: 820, height: 1180 },
  { value: "desktop", label: "Desktop", width: 1280, height: 900 },
] as const satisfies readonly {
  value: HeatmapDevice;
  label: string;
  width: number;
  height: number;
}[];

/** Sites served on the owner's own computer: plain http, and any port. */
export const isLocalHostname = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1";

/** A port as typed: "" for none, or 1 to 65535. */
export const isPort = (text: string) =>
  text === "" || (/^\d{1,5}$/.test(text) && Number(text) >= 1 && Number(text) <= 65_535);

/** The site's origin: https, except http on localhost and 127.0.0.1, where a port may be given. */
export function siteOrigin(hostname: string, port = ""): string {
  if (!isLocalHostname(hostname)) return `https://${hostname}`;
  return `http://${hostname}${port === "" ? "" : `:${port}`}`;
}

/**
 * The page's address with the link token in its fragment, which the
 * browser never sends to the site's server: the tracker on the page takes
 * it out of the address at once and loads the overlay. The path is set as
 * a path only: a stored path such as "//other.example/" (any page can send
 * one) never takes the link to another site.
 */
export function overlayUrl(origin: string, path: string, token: string): string {
  const url = new URL(origin);
  url.pathname = path;
  url.hash = `ottertrail-heatmap=${token}`;
  if (url.origin !== new URL(origin).origin) throw new Error("The path left the site");
  return url.href;
}

/** window.open's features for a window this size, within the screen. */
export function popupFeatures(
  size: { width: number; height: number },
  screen: { availWidth: number; availHeight: number },
): string {
  const width = Math.min(size.width, screen.availWidth);
  const height = Math.min(size.height, screen.availHeight);
  return `popup=yes,width=${width},height=${height}`;
}
