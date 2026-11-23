/**
 * Load h.js only for data-heatmaps="on" and a sampled pageview.
 * Capture uses no device storage. See heatmap-capture.ts and
 * docs/web-analytics.md, "Heatmaps".
 */
import { startCapture } from "./heatmap-capture.ts";
import { HEATMAP_PROPERTY, type HeatmapConfig } from "./heatmap-names.ts";

const isConfig = (value: unknown): value is HeatmapConfig =>
  typeof value === "object" &&
  value !== null &&
  "endpoint" in value &&
  typeof value.endpoint === "string" &&
  "key" in value &&
  typeof value.key === "string" &&
  "page" in value &&
  typeof value.page === "function" &&
  "register" in value &&
  typeof value.register === "function";

try {
  const script = document.currentScript;
  const config: unknown = script === null ? undefined : Reflect.get(script, HEATMAP_PROPERTY);
  if (isConfig(config)) {
    const capture = startCapture(config, {
      window,
      document,
      fetch: (url, init) => fetch(url, init),
      beacon: (url, body) => navigator.sendBeacon(url, body),
    });
    config.register({ navigated: capture.navigated, stop: capture.stop });
  }
} catch {
  // Never break the page the tracker runs on.
}
