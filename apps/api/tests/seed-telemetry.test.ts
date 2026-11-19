import { describe, expect, test } from "vite-plus/test";

import { hostTicks } from "../scripts/seed-telemetry.ts";
import { LATEST_WINDOW_MS } from "../src/telemetry/hosts.ts";

/**
 * The seed's host metrics (scripts/seed-telemetry.ts) at every second of a
 * 15-minute step. The Hosts list takes CPU from a counter's last two points
 * within LATEST_WINDOW_MS of the host's last point (src/telemetry/hosts.ts),
 * which docs/telemetry.md promises for points up to half of it apart.
 * Before, a seed run 15:20 to 16:00 past a quarter hour left up to 15:40
 * between its last two, and the list showed no CPU.
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
