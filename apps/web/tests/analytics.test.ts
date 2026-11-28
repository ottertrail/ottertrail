import { describe, expect, test } from "vite-plus/test";

import {
  countryName,
  formatConversion,
  formatCount,
  formatDayRange,
  formatDuration,
  formatPercent,
  formatRatio,
  formatTimeOfDay,
  pointsChange,
  relativeChange,
  niceTicks,
} from "../src/features/analytics/format.ts";
import { isDay, rangeFrom, rangeProblem } from "../src/lib/analytics-api.ts";
import { goalChoiceFrom, isAnalytics } from "../src/lib/analytics-queries.ts";

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

  test.each([
    [0, "0%"],
    [0.0004, "<0.1%"],
    [0.0523, "5.2%"],
    [0.05, "5.0%"],
    [0.0996, "10%"],
    [0.166, "17%"],
    [1, "100%"],
  ])("formatConversion(%s) is %j: one decimal below 10%%", (value, expected) => {
    expect(formatConversion(value)).toBe(expected);
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
    ["2026-11-12", "2026-11-18", "12 to 18 Nov 2026"],
    ["2026-11-28", "2026-12-04", "28 Nov to 4 Dec 2026"],
    ["2025-11-19", "2026-11-18", "19 Nov 2025 to 18 Nov 2026"],
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

describe("changes from the previous period", () => {
  test("counts and averages change in percent, rounded", () => {
    expect(relativeChange(765, 683)).toEqual({ direction: "up", text: "12%", spoken: "12%" });
    expect(relativeChange(1820, 2000)).toEqual({ direction: "down", text: "9%", spoken: "9%" });
    expect(relativeChange(30_000, 1000)).toEqual({
      direction: "up",
      text: "2,900%",
      spoken: "2,900%",
    });
    expect(relativeChange(824, 824)).toEqual({ direction: "same", text: "0%", spoken: "0%" });
  });

  test("a change too small to round to 1% is never shown as no change", () => {
    expect(relativeChange(825, 824)).toEqual({
      direction: "up",
      text: "<1%",
      spoken: "less than 1%",
    });
    expect(relativeChange(999, 1000)).toEqual({
      direction: "down",
      text: "<1%",
      spoken: "less than 1%",
    });
  });

  test("there is no change without something to compare with", () => {
    expect(relativeChange(5, 0)).toBeNull();
    expect(relativeChange(5, null)).toBeNull();
    expect(relativeChange(null, 5)).toBeNull();
  });

  test("shares change in percentage points, matching the percentages shown", () => {
    expect(pointsChange(0.3, 0.24)).toEqual({ direction: "up", text: "6 pts", spoken: "6 points" });
    expect(pointsChange(0.23, 0.24)).toEqual({
      direction: "down",
      text: "1 pt",
      spoken: "1 point",
    });
    // 24.49% and 23.51% both show as 24%, so they have not changed.
    expect(pointsChange(0.2449, 0.2351)).toEqual({
      direction: "same",
      text: "0 pts",
      spoken: "0 points",
    });
    expect(pointsChange(0.3, null)).toBeNull();
  });

  test("a time of day reads in the instance's timezone", () => {
    expect(formatTimeOfDay("2026-11-16T07:00:00Z", "Asia/Singapore")).toBe("15:00");
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
      "release",
    ].map((name) => [name, []]),
  );
  const valid = {
    timeZone: "UTC",
    environment: "production",
    environments: ["production"],
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
    goals: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        name: "Team signup",
        step: { type: "event", name: "signup", filter: { key: "plan", value: "team" } },
        createdAt: "2026-11-01T00:00:00.000Z",
        visitors: 1,
        events: 2,
        conversionRate: 1,
      },
    ],
    goal: null,
    previous: {
      firstDay: "2026-11-05",
      lastDay: "2026-11-11",
      until: null,
      summary: {
        visitors: 0,
        pageviews: 0,
        visits: 0,
        viewsPerVisit: null,
        bounceRate: null,
        avgDurationMs: null,
        avgEngagedMs: null,
      },
    },
  };

  test("accepts the endpoint's response and refuses anything else", () => {
    expect(isAnalytics(valid)).toBe(true);
    expect(isAnalytics({ ...valid, summary: { ...valid.summary, visitors: "1" } })).toBe(false);
    expect(isAnalytics({ ...valid, breakdowns: { ...valid.breakdowns, os: undefined } })).toBe(
      false,
    );
    expect(isAnalytics({ ...valid, previous: undefined })).toBe(false);
    expect(isAnalytics({ ...valid, goals: undefined })).toBe(false);
    expect(isAnalytics({ ...valid, goals: [{ ...valid.goals[0], step: { type: "page" } }] })).toBe(
      false,
    );
    expect(isAnalytics({ ...valid, goals: [{ ...valid.goals[0], conversionRate: "1" }] })).toBe(
      false,
    );
    expect(isAnalytics({ ...valid, previous: { ...valid.previous, until: 5 } })).toBe(false);
  });

  test("accepts a goal's counts, and refuses a missing goal or a bad count", () => {
    const goal = {
      id: null,
      name: "signup",
      step: { type: "event", name: "signup" },
      converted: 1,
      events: 2,
      conversionRate: 1,
      previous: { converted: 0, events: 0 },
    };
    const withGoal = {
      ...valid,
      goal,
      days: [{ ...valid.days[0], converted: 1 }],
      pages: [{ ...valid.pages[0], converted: 1 }],
    };
    expect(isAnalytics(withGoal)).toBe(true);
    expect(isAnalytics({ ...valid, goal: undefined })).toBe(false);
    expect(isAnalytics({ ...withGoal, goal: { ...goal, previous: undefined } })).toBe(false);
    expect(isAnalytics({ ...withGoal, pages: [{ ...valid.pages[0], converted: "1" }] })).toBe(
      false,
    );
  });
});

describe("goalChoiceFrom", () => {
  test("takes a saved goal's ID or a custom event, and drops what the API would refuse", () => {
    const id = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAA1";
    expect(goalChoiceFrom({ goal: id })).toEqual({ id: id.toLowerCase() });
    expect(goalChoiceFrom({ goalEvent: "signup" })).toEqual({ event: "signup" });
    expect(goalChoiceFrom({ goal: id, goalEvent: "signup" })).toEqual({ id: id.toLowerCase() });
    expect(goalChoiceFrom({ goal: "signup" })).toBeUndefined();
    expect(goalChoiceFrom({ goalEvent: "pageview" })).toBeUndefined();
    expect(goalChoiceFrom({ goalEvent: "a\tb" })).toBeUndefined();
    expect(goalChoiceFrom({ goalEvent: "x".repeat(201) })).toBeUndefined();
  });
});

describe("chosen days", () => {
  test("a day is a real calendar day", () => {
    expect(isDay("2026-11-16")).toBe(true);
    expect(isDay("2028-02-29")).toBe(true);
    expect(isDay("2026-02-29")).toBe(false);
    expect(isDay("2026-13-01")).toBe(false);
    expect(isDay("16-11-2026")).toBe(false);
    expect(isDay(20_261_116)).toBe(false);
  });

  test("a range is refused as the API would refuse it", () => {
    expect(rangeProblem("2026-11-01", "2026-11-30")).toBeNull();
    expect(rangeProblem("2026-11-16", "2026-11-16")).toBeNull();
    expect(rangeProblem("2026-11-30", "2026-11-01")).toBe("The last day is before the first.");
    // 366 days is the most; 367 is one too many.
    expect(rangeProblem("2025-11-17", "2026-11-17")).toBeNull();
    expect(rangeProblem("2025-11-16", "2026-11-17")).toBe("A range covers at most 366 days.");
    expect(rangeProblem("", "2026-11-17")).toBe("Choose a first and a last day.");
  });

  test("an address's chosen days win over its period, and unusable days fall back", () => {
    expect(rangeFrom({ from: "2026-10-01", to: "2026-10-31", period: "90d" })).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(rangeFrom({ from: "2026-02-30", to: "2026-03-01", period: "30d" })).toEqual({
      period: "30d",
    });
    expect(rangeFrom({ from: "2026-10-31", to: "2026-10-01" })).toEqual({ period: "7d" });
    expect(rangeFrom({ from: "2026-10-01" })).toEqual({ period: "7d" });
  });
});
