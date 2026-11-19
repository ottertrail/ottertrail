import { describe, expect, test } from "vite-plus/test";

import { createRageDetector, deviceOf } from "../src/heatmap-capture.ts";

describe("device classes by viewport width", () => {
  test("mobile under 768 pixels, tablet under 1024, desktop from 1024", () => {
    expect([320, 767, 768, 1023, 1024, 2560].map(deviceOf)).toEqual([
      "mobile",
      "mobile",
      "tablet",
      "tablet",
      "desktop",
      "desktop",
    ]);
  });
});

describe("rage clicks", () => {
  test("the third click within 1 second and 30 pixels, and later ones of the burst", () => {
    const rage = createRageDetector();
    expect([
      rage(0, 100, 100),
      rage(400, 110, 105),
      rage(800, 95, 100),
      rage(1100, 100, 100),
    ]).toEqual([false, false, true, true]);
  });

  test("not three within the second", () => {
    const rage = createRageDetector();
    expect([rage(0, 100, 100), rage(600, 100, 100), rage(1201, 100, 100)]).toEqual([
      false,
      false,
      false,
    ]);
  });

  test("not within 30 pixels of each other", () => {
    const rage = createRageDetector();
    expect([rage(0, 100, 100), rage(100, 131, 100), rage(200, 162, 100)]).toEqual([
      false,
      false,
      false,
    ]);
    // Exactly 30 apart still counts.
    const edge = createRageDetector();
    expect([edge(0, 0, 0), edge(100, 30, 0), edge(200, 15, 0)]).toEqual([false, false, true]);
  });
});
