/**
 * Session replay around errors, built to dist/r.js and served beside the
 * tracker at /r.js. The tracker loads it only when its tag says
 * data-replay="errors" (script.ts): the recorder is rrweb (MIT), many times
 * the tracker's size, so pages that do not record never download it.
 *
 * It records the page into memory, masked in the browser, and sends a
 * replay only around the page load's first error (replay-recorder.ts,
 * docs/session-replay.md).
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
