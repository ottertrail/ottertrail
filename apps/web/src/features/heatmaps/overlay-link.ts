import type { HeatmapDevice } from "@/lib/heatmaps-api";

/** Overlay windows for docs/web-analytics.md, "The overlay on your site". */

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

/** Match overlay routes: local hosts allow HTTP and any port because browsers treat them as secure contexts. */
export const isLocalHostname = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost");

/** A port as typed: "" for none, or 1 to 65535. */
export const isPort = (text: string) =>
  text === "" || (/^\d{1,5}$/.test(text) && Number(text) >= 1 && Number(text) <= 65_535);

export function siteOrigin(hostname: string, port = ""): string {
  if (!isLocalHostname(hostname)) return `https://${hostname}`;
  return `http://${hostname}${port === "" ? "" : `:${port}`}`;
}

/** Keep the token in the fragment so it is not sent to the site server. Set untrusted paths as paths so //other.example/ cannot change the origin. */
export function overlayUrl(origin: string, path: string, token: string): string {
  const url = new URL(origin);
  url.pathname = path;
  url.hash = `ottertrail-heatmap=${token}`;
  if (url.origin !== new URL(origin).origin) throw new Error("The path left the site");
  return url.href;
}

export function popupFeatures(
  size: { width: number; height: number },
  screen: { availWidth: number; availHeight: number },
): string {
  const width = Math.min(size.width, screen.availWidth);
  const height = Math.min(size.height, screen.availHeight);
  return `popup=yes,width=${width},height=${height}`;
}
