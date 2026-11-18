import { describe, expect, test } from "vite-plus/test";

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
