/**
 * Load o.js only for a dashboard overlay link, so visitors do not download it.
 * The overlay uses no device storage. Saving a view loads snapshot.ts (s.js).
 * See overlay-view.ts and docs/web-analytics.md, "The overlay on your site".
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
      ...(script instanceof HTMLScriptElement && script.src ? { scriptUrl: script.src } : {}),
    });
  }
} catch {
  // Never break the page the tracker runs on.
}
