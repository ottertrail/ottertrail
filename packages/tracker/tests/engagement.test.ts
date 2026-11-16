import { describe, expect, test } from "vite-plus/test";

import { createEngagementTimer } from "../src/engagement.ts";

function clock() {
  let time = 0;
  return { now: () => time, set: (ms: number) => (time = ms) };
}

describe("createEngagementTimer", () => {
  test("counts only the time the page is visible", () => {
    const c = clock();
    const timer = createEngagementTimer(c.now);

    timer.resume(); // Visible at 0 s.
    c.set(5000);
    timer.pause(); // Hidden at 5 s.
    c.set(65_000); // A minute in another tab: not counted.
    timer.resume();
    c.set(68_000);

    expect(timer.take()).toBe(8000);
  });

  test("starts again from zero after each report, and keeps counting while visible", () => {
    const c = clock();
    const timer = createEngagementTimer(c.now);
    timer.resume();
    c.set(4000);
    expect(timer.take()).toBe(4000);
    c.set(6500);
    expect(timer.take()).toBe(2500);
  });

  test("reports nothing while hidden", () => {
    const c = clock();
    const timer = createEngagementTimer(c.now);
    timer.resume();
    c.set(3000);
    timer.pause();
    expect(timer.take()).toBe(3000);
    c.set(10_000);
    expect(timer.take()).toBe(0);
  });

  test("ignores repeated resume and pause calls", () => {
    const c = clock();
    const timer = createEngagementTimer(c.now);
    timer.resume();
    c.set(1000);
    timer.resume(); // Already counting since 0: must not restart at 1 s.
    c.set(2000);
    timer.pause();
    timer.pause();
    expect(timer.take()).toBe(2000);
  });
});
