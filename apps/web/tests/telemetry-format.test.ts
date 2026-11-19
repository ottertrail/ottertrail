import { describe, expect, test } from "vite-plus/test";

import { bucketLabel } from "../src/features/telemetry/chart-time.ts";
import { formatDuration } from "../src/features/telemetry/format.ts";

describe("durations", () => {
  test("take the unit their size needs", () => {
    expect(formatDuration(0)).toBe("0 µs");
    expect(formatDuration(0.4)).toBe("<1 µs");
    expect(formatDuration(850)).toBe("850 µs");
    expect(formatDuration(12_400)).toBe("12.4 ms");
    expect(formatDuration(120_000)).toBe("120 ms");
    expect(formatDuration(1_250_000)).toBe("1.25 s");
    expect(formatDuration(125_000_000)).toBe("2 min 5 s");
    expect(formatDuration(120_000_000)).toBe("2 min");
  });

  test("never show a rounded value at the next unit's threshold", () => {
    expect(formatDuration(999.7)).toBe("1 ms");
    expect(formatDuration(999_700)).toBe("1 s");
    expect(formatDuration(59_970_000)).toBe("1 min");
    expect(formatDuration(119_600_000)).toBe("2 min");
    expect(formatDuration(179_700_000)).toBe("3 min");
  });
});

describe("a chart bucket's label", () => {
  test("gives its day and times, written with to", () => {
    // 02:00 UTC is 10:00 in Singapore.
    expect(bucketLabel(new Date("2026-11-17T02:00:00Z"), 300, "Asia/Singapore")).toBe(
      "Tue 17 Nov 2026, 10:00 to 10:05",
    );
  });

  test("names the next day when the bucket ends after midnight", () => {
    expect(bucketLabel(new Date("2026-11-16T15:00:00Z"), 3600, "Asia/Singapore")).toBe(
      "Mon 16 Nov 2026, 23:00 to Tue 17 Nov 2026, 00:00",
    );
  });

  test("is the day alone for a bucket of a day", () => {
    expect(bucketLabel(new Date("2026-11-16T16:00:00Z"), 86_400, "Asia/Singapore")).toBe(
      "Tue 17 Nov 2026",
    );
  });
});
