/**
 * Heatmap capture, built to dist/h.js and served beside the tracker at
 * /h.js. The tracker loads it only when its tag says data-heatmaps="on",
 * with the first pageview in the sample (script.ts), so pages without
 * heatmaps never download it.
 *
 * It records each click of a sampled pageview on the element it hit, and
 * the pageview's scroll depth, sent when the page is hidden or left
 * (heatmap-capture.ts, docs/web-analytics.md, "Heatmaps"). It stores
 * nothing on the device.
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
