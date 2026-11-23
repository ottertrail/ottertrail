/**
 * Load rrweb only for data-replay="errors" to keep it out of the main tracker.
 * Recordings are masked in memory and sent around the first error.
 * See replay-recorder.ts and docs/session-replay.md.
 */
import { REPLAY_PROPERTY, type ReplayConfig } from "./replay-names.ts";
import { startReplay } from "./replay-start.ts";

const isConfig = (value: unknown): value is ReplayConfig =>
  typeof value === "object" &&
  value !== null &&
  "endpoint" in value &&
  typeof value.endpoint === "string" &&
  "key" in value &&
  typeof value.key === "string" &&
  "register" in value &&
  typeof value.register === "function";

try {
  const script = document.currentScript;
  const config: unknown = script === null ? undefined : Reflect.get(script, REPLAY_PROPERTY);
  if (isConfig(config)) startReplay(config);
} catch {
  // Never break the page the tracker runs on.
}
