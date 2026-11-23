/**
 * Load o.js only for a dashboard overlay link, so visitors do not download it.
 * The overlay uses no device storage. Saving a view loads snapshot.ts (s.js).
 * See overlay-view.ts and docs/web-analytics.md, "The overlay on your site".
 */
import { currentScriptReader, type OverlayConfig, OVERLAY_PROPERTY } from "./overlay-names.ts";
import { startOverlay } from "./overlay-view.ts";

// As early as o.js can: a page script that wraps fetch later never sees the session.
const pageFetch = typeof fetch === "function" ? fetch.bind(window) : undefined;
// The same for document.currentScript, which the s.js handoff checks.
const currentScript = currentScriptReader(document);

const isConfig = (value: unknown): value is OverlayConfig =>
  typeof value === "object" &&
  value !== null &&
  "host" in value &&
  typeof value.host === "string" &&
  "token" in value &&
  typeof value.token === "string";

try {
  const script = document.currentScript;
  const handoff: unknown = script === null ? undefined : Reflect.get(script, OVERLAY_PROPERTY);
  if (script !== null) Reflect.deleteProperty(script, OVERLAY_PROPERTY);
  // Taken from the tracker now, while this is the current script: once only.
  const config: unknown = typeof handoff === "function" ? handoff() : undefined;
  const send = isConfig(config) ? (config.fetch ?? pageFetch) : undefined;
  if (isConfig(config) && send !== undefined) {
    startOverlay(config, {
      window,
      document,
      fetch: (url, init) => send(url, init),
      currentScript,
      ...(script?.nonce ? { nonce: script.nonce } : {}),
      ...(script instanceof HTMLScriptElement && script.src ? { scriptUrl: script.src } : {}),
    });
  }
} catch {
  // Never break the page the tracker runs on.
}
