/**
 * The heatmap overlay, built to dist/o.js and served beside the tracker at
 * /o.js. The tracker loads it only on a page opened from the dashboard's
 * "Open on your site", whose address carried a one-time link token
 * (script.ts), so visitors never download it.
 *
 * It draws the project's heatmap for this page over the page itself, for
 * the signed-in owner who opened it (overlay-view.ts; docs/web-analytics.md,
 * "The overlay on your site"). It stores nothing on the device.
 */
import { type OverlayConfig, OVERLAY_PROPERTY } from "./overlay-names.ts";
import { startOverlay } from "./overlay-view.ts";

const isConfig = (value: unknown): value is OverlayConfig =>
  typeof value === "object" &&
  value !== null &&
  "host" in value &&
  typeof value.host === "string" &&
  "token" in value &&
  typeof value.token === "string";

try {
  const script = document.currentScript;
  const config: unknown = script === null ? undefined : Reflect.get(script, OVERLAY_PROPERTY);
  // Off the element at once: the token and the tracker's callback are o.js's alone.
  if (script !== null) Reflect.deleteProperty(script, OVERLAY_PROPERTY);
  if (isConfig(config)) {
    startOverlay(config, {
      window,
      document,
      fetch: (url, init) => fetch(url, init),
      ...(script?.nonce ? { nonce: script.nonce } : {}),
    });
  }
} catch {
  // Never break the page the tracker runs on.
}
