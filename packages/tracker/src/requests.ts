/**
 * n.js: request tracing, loaded by the tracker only with data-traces="on".
 * See request-tracing.ts and docs/web-analytics.md, "Traces".
 */
import { startRequestTracing } from "./request-tracing.ts";
import { TRACES_PROPERTY, type TracesConfig } from "./traces.ts";

const isConfig = (value: unknown): value is TracesConfig =>
  typeof value === "object" &&
  value !== null &&
  "skip" in value &&
  typeof value.skip === "string" &&
  "sampled" in value &&
  typeof value.sampled === "function" &&
  "register" in value &&
  typeof value.register === "function";

try {
  const script = document.currentScript;
  const config: unknown = script === null ? undefined : Reflect.get(script, TRACES_PROPERTY);
  if (isConfig(config)) {
    startRequestTracing(config, window, crypto, () => performance.now());
  }
} catch {
  // Never break the page the tracker runs on.
}
