import { describe, expect, test } from "vite-plus/test";

import { hostTicks } from "../scripts/seed-telemetry.ts";
import { LATEST_WINDOW_MS } from "../src/telemetry/hosts.ts";

/**
 * Guard CPU visibility at every second of a 15-minute seed step (scripts/seed-telemetry.ts).
 * The last two counter points must fit LATEST_WINDOW_MS (src/telemetry/hosts.ts).
 * docs/telemetry.md promises support for points up to half that window apart.
 */
describe("the seed's host points", () => {
  test("two in the Hosts list's window, at any time of the step", () => {
    const quarter = Date.parse("2026-11-19T18:15:00Z");
    const wrong: string[] = [];
    for (let second = 0; second < 15 * 60; second += 1) {
      const nowMs = quarter + second * 1000;
      const ticks = hostTicks(nowMs);
      const last = ticks.at(-1) ?? 0;
      const inWindow = ticks.filter((tick) => tick >= last - LATEST_WINDOW_MS).length;
      // The last two within the limit the documentation gives, and apart.
      const gap = last - (ticks.at(-2) ?? 0);
      if (last !== nowMs - 20_000 || inWindow < 2 || gap <= 0 || gap > LATEST_WINDOW_MS / 2) {
        wrong.push(`${new Date(nowMs).toISOString()}: ${inWindow} in the window, ${gap / 1000} s`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
