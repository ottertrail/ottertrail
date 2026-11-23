/**
 * Load rrweb only when the owner saves a view (snapshot-take.ts).
 * o.js uploads the result with its session; this script never sees a token.
 * See docs/web-analytics.md, "Saved views".
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
