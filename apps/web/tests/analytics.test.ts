import { describe, expect, test } from "vite-plus/test";

import {
  countryName,
  formatCount,
  formatDayRange,
  formatDuration,
  formatPercent,
  formatRatio,
  niceTicks,
} from "../src/features/analytics/format.ts";
import { isAnalytics } from "../src/lib/analytics-api.ts";

describe("formatting", () => {
  test.each([
    [0, "0"],
    [1284, "1,284"],
    [9999, "9,999"],
    [12_900, "12.9K"],
    [4_200_000, "4.2M"],
  ])("formatCount(%s) is %j", (value, expected) => {
    expect(formatCount(value)).toBe(expected);
  });

  test.each([
    [null, "–"],
    [45_400, "45s"],
    [192_000, "3m 12s"],
    [3_900_000, "1h 05m"],
  ])("formatDuration(%s) is %j", (value, expected) => {
    expect(formatDuration(value)).toBe(expected);
  });

  test("formats shares as whole percentages", () => {
    expect(formatPercent(0.714)).toBe("71%");
    expect(formatPercent(null)).toBe("–");
    expect(formatRatio(2)).toBe("2");
    expect(formatRatio(1.46)).toBe("1.5");
    expect(formatRatio(null)).toBe("–");
  });

  test.each([
    ["2026-11-16", "2026-11-16", "16 Nov 2026"],
    ["2026-11-12", "2026-11-18", "12–18 Nov 2026"],
    ["2026-11-28", "2026-12-04", "28 Nov – 4 Dec 2026"],
    ["2025-11-19", "2026-11-18", "19 Nov 2025 – 18 Nov 2026"],
  ])("formatDayRange(%s, %s) is %j", (first, last, expected) => {
    expect(formatDayRange(first, last)).toBe(expected);
  });

  test("names countries and leaves other values alone", () => {
    expect(countryName("DE")).toBe("Germany");
    expect(countryName("Bavaria, DE")).toBe("Bavaria, DE");
  });
});

describe("niceTicks", () => {
  test.each([
    [0, [0, 1]],
    [3, [0, 1, 2, 3]],
    [37, [0, 10, 20, 30, 40]],
    [1840, [0, 500, 1000, 1500, 2000]],
  ])("covers %s with %j", (max, expected) => {
    expect(niceTicks(max)).toEqual(expected);
  });
});

describe("isAnalytics", () => {
  const empty = Object.fromEntries(
    [
      "source",
      "utmCampaign",
      "entryPage",
      "exitPage",
      "country",
      "region",
      "city",
      "deviceType",
      "browser",
      "os",
    ].map((name) => [name, []]),
  );
  const valid = {
    timeZone: "UTC",
    firstDay: "2026-11-12",
    lastDay: "2026-11-18",
    summary: {
      visitors: 1,
      pageviews: 1,
      visits: 1,
      viewsPerVisit: 1,
      bounceRate: 1,
      avgDurationMs: 0,
      avgEngagedMs: null,
    },
    days: [{ day: "2026-11-18", visitors: 1, pageviews: 1, visits: 1 }],
    pages: [{ path: "/", pageviews: 1, visitors: 1, avgEngagedMs: null }],
    breakdowns: { ...empty, source: [{ value: null, visitors: 1, visits: 1, bounceRate: 1 }] },
    customEvents: [],
  };

  test("accepts the endpoint's response and refuses anything else", () => {
    expect(isAnalytics(valid)).toBe(true);
    expect(isAnalytics({ ...valid, summary: { ...valid.summary, visitors: "1" } })).toBe(false);
    expect(isAnalytics({ ...valid, breakdowns: { ...valid.breakdowns, os: undefined } })).toBe(
      false,
    );
  });
});
