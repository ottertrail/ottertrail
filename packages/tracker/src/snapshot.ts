/**
 * Saved heatmap views, built to dist/s.js and served beside the tracker at
 * /s.js. The heatmap overlay (o.js) loads it only when the owner presses
 * "Save this view", so neither visitors nor an overlay that saves nothing
 * download rrweb (snapshot-take.ts; docs/web-analytics.md, "Saved views").
 *
 * It takes the snapshot and hands it back to o.js, which uploads it with
 * its own session: this script never sees a token.
 */
import { type SnapshotConfig, SNAPSHOT_PROPERTY } from "./snapshot-names.ts";
import { takeSnapshot } from "./snapshot-take.ts";

const isConfig = (value: unknown): value is SnapshotConfig =>
  typeof value === "object" &&
  value !== null &&
  "ready" in value &&
  typeof value.ready === "function";

try {
  const script = document.currentScript;
  const config: unknown = script === null ? undefined : Reflect.get(script, SNAPSHOT_PROPERTY);
  if (script !== null) Reflect.deleteProperty(script, SNAPSHOT_PROPERTY);
  if (isConfig(config)) config.ready((hide) => takeSnapshot({ hide }));
} catch {
  // Never break the page the tracker runs on.
}
