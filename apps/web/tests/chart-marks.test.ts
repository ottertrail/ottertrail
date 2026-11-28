import { describe, expect, test } from "vite-plus/test";

import { pointIndexOf } from "../src/features/analytics/chart-marks-data.ts";
import type { ChartPoint } from "../src/lib/analytics-api.ts";

const point = (start: string, end = start.slice(0, 10)): ChartPoint => ({
  start,
  end,
  visitors: 0,
  visits: 0,
  pageviews: 0,
  partial: false,
  previous: null,
});

describe("pointIndexOf", () => {
  const days = [point("2026-11-10"), point("2026-11-11"), point("2026-11-12")];

  test("puts a day, or a moment of it, on that day's point", () => {
    expect(pointIndexOf(days, "2026-11-11")).toBe(1);
    expect(pointIndexOf(days, "2026-11-11T23:59")).toBe(1);
    expect(pointIndexOf(days, "2026-11-12T08:00")).toBe(2);
  });

  test("leaves out what falls before or after the chart", () => {
    expect(pointIndexOf(days, "2026-11-09T23:59")).toBeNull();
    expect(pointIndexOf(days, "2026-11-13")).toBeNull();
    expect(pointIndexOf([], "2026-11-13")).toBeNull();
  });

  test("puts a moment in a week on the week's point", () => {
    const weeks = [point("2026-11-04", "2026-11-08"), point("2026-11-09", "2026-11-15")];
    expect(pointIndexOf(weeks, "2026-11-08T22:00")).toBe(0);
    expect(pointIndexOf(weeks, "2026-11-15T10:00")).toBe(1);
  });

  test("puts a moment on its hour, and a whole day on the first hour of a chart that starts mid-day", () => {
    const hours = [
      point("2026-11-15T22:00"),
      point("2026-11-15T23:00"),
      point("2026-11-16T00:00"),
      point("2026-11-16T01:00"),
    ];
    expect(pointIndexOf(hours, "2026-11-15T23:30")).toBe(1);
    expect(pointIndexOf(hours, "2026-11-16")).toBe(2);
    expect(pointIndexOf(hours, "2026-11-15")).toBe(0);
    expect(pointIndexOf(hours, "2026-11-15T21:59")).toBeNull();
  });
});
