import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { NewEvent } from "../src/collection/event-store.ts";
import { chartBuckets } from "../src/reports/chart.ts";
import { shiftedDays } from "../src/reports/reports.ts";
import { signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/** Daylight saving ends on 1 November 2026 and starts on 8 March 2026. */
const TIME_ZONE = "America/New_York";
/** 10:30 on Saturday 28 November in New York. Never the real clock. */
const NOW = new Date("2026-11-28T15:30:00Z");

/** Each named visitor's ID: IDs are whole numbers. */
const visitors = new Map<string, string>();

function pv(visitor: string, iso: string, environment?: string): NewEvent {
  const visitorId = visitors.get(visitor) ?? String(visitors.size + 1);
  visitors.set(visitor, visitorId);
  return {
    eventId: randomUUID(),
    name: "pageview",
    occurredAt: new Date(iso),
    path: "/",
    visitorId,
    ...(environment === undefined ? {} : { environment }),
  };
}

const EVENTS: NewEvent[] = [
  // The first event: 23:30 on 27 February 2023 in New York, the 28th in UTC.
  pv("first", "2023-02-28T04:30:00Z"),
  // 28 February and 1 March 2023, a year before 2024's leap day.
  pv("feb", "2023-02-28T17:00:00Z"),
  pv("mar", "2023-03-01T17:00:00Z"),
  // 01:30 twice on 1 November 2026: in summer time, then in winter time.
  pv("summer", "2026-11-01T05:30:00Z"),
  pv("winter", "2026-11-01T06:30:00Z"),
  // 10:00 on 20 November: a week before the 27th.
  pv("week", "2026-11-20T15:00:00Z"),
  // 11:00 on 27 November 2025: a year before the last 24 hours' first hours.
  pv("year", "2025-11-27T16:00:00Z"),
  // 09:20 on 27 November: the 24 hours before the last 24.
  pv("day", "2026-11-27T14:20:00Z"),
  // 09:10 today.
  pv("today", "2026-11-28T14:10:00Z"),
  // Older than All time reads: 11 years ago, in an environment of its own.
  pv("old", "2015-06-01T12:00:00Z", "old"),
];

interface Point {
  start: string;
  end: string;
  partial: boolean;
  visitors: number;
  previous: { visitors: number } | null;
}

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let projectId = "";

beforeAll(async () => {
  dashboard = await signedInDashboard({ timeZone: TIME_ZONE, now: () => NOW });
  projectId = (await insertProject(dashboard.db, { name: "Ranges" })).id;
  await dashboard.store(projectId, EVENTS);
});

afterAll(async () => {
  await dashboard?.close();
});

const get = (query: string) =>
  dashboard.app.inject({
    url: `/api/projects/${projectId}/analytics?${query}`,
    headers: { cookie: dashboard.cookie },
  });

async function analytics(query: string) {
  const response = await get(query);
  expect(response.statusCode).toBe(200);
  return response.json();
}

const point = (body: { chart: Point[] }, start: string) =>
  body.chart.find((item) => item.start === start);

/** "YYYY-MM-DD" `days` after `day`. */
const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

describe("ranges in the instance's timezone", () => {
  test("yesterday is the whole local day before today", async () => {
    expect(await analytics("period=yesterday")).toMatchObject({
      firstDay: "2026-11-27",
      lastDay: "2026-11-27",
      from: "2026-11-27T05:00:00.000Z",
      to: "2026-11-28T05:00:00.000Z",
      interval: "hour",
      intervals: ["hour"],
    });
  });

  test("the last 24 hours end now, with a partial hour at each end", async () => {
    const body = await analytics("period=24h");
    expect(body).toMatchObject({
      firstDay: "2026-11-27",
      lastDay: "2026-11-28",
      from: "2026-11-27T15:30:00.000Z",
      to: NOW.toISOString(),
      interval: "hour",
      intervals: ["hour"],
    });
    const chart: Point[] = body.chart;
    expect(chart).toHaveLength(25);
    expect(chart[0]).toMatchObject({ start: "2026-11-27T10:00", partial: true });
    expect(chart.at(-1)).toMatchObject({ start: "2026-11-28T10:00", partial: true });
    expect(chart.slice(1, -1).every((item) => !item.partial)).toBe(true);
    expect(body.summary.visitors).toBe(1);
  });

  test("month to date and year to date start on the local first day", async () => {
    const month = await analytics("period=mtd");
    expect(month).toMatchObject({
      firstDay: "2026-11-01",
      lastDay: "2026-11-28",
      // Still summer time at midnight on 1 November.
      from: "2026-11-01T04:00:00.000Z",
      interval: "day",
      intervals: ["day", "week"],
    });
    expect(month.chart).toHaveLength(28);
    expect(month.chart.at(-1)).toMatchObject({ start: "2026-11-28", partial: true });
    expect(await analytics("period=ytd")).toMatchObject({
      firstDay: "2026-01-01",
      from: "2026-01-01T05:00:00.000Z",
      interval: "week",
      intervals: ["day", "week", "month"],
    });
  });

  test("All time starts on the local day of the first event, without a comparison", async () => {
    const body = await analytics("period=all&compare=previous");
    expect(body).toMatchObject({
      firstDay: "2023-02-27",
      lastDay: "2026-11-28",
      interval: "month",
      intervals: ["week", "month"],
      comparison: "off",
      previous: null,
    });
    expect(body.chart[0]).toMatchObject({ start: "2023-02-27", end: "2023-02-28", partial: true });
    expect(body.summary.visitors).toBe(9);
  });

  test("All time without events is today, and reads ten years back at most", async () => {
    expect(await analytics("period=all&environment=staging")).toMatchObject({
      firstDay: "2026-11-28",
      lastDay: "2026-11-28",
    });
    const old = await analytics("period=all&environment=old");
    expect(old.firstDay).toBe(addDays("2026-11-28", -3659));
    expect(old.summary.visitors).toBe(0);
  });

  test.each([
    ["period=all&from=2026-11-01&to=2026-11-02"],
    ["period=24h&from=2026-11-01&to=2026-11-02"],
    ["period=week"],
    ["period=7d&interval=year"],
    ["period=7d&compare=lastyear"],
  ])("refuses %s", async (query) => {
    expect((await get(query)).statusCode).toBe(400);
  });

  test("a full list takes the same ranges", async () => {
    const response = await dashboard.app.inject({
      url: `/api/projects/${projectId}/analytics/list?report=pages&period=24h`,
      headers: { cookie: dashboard.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().rows).toEqual([
      { path: "/", pageviews: 1, visitors: 1, avgEngagedMs: null },
    ]);
  });
});

describe("chart intervals", () => {
  test("the day daylight saving ends has 25 hours, 01:00 twice", async () => {
    const body = await analytics("from=2026-11-01&to=2026-11-01");
    const chart: Point[] = body.chart;
    expect(chart).toHaveLength(25);
    expect(chart.slice(0, 4).map((item) => item.start)).toEqual([
      "2026-11-01T00:00",
      "2026-11-01T01:00",
      "2026-11-01T01:00",
      "2026-11-01T02:00",
    ]);
    expect(chart.slice(0, 4).map((item) => item.visitors)).toEqual([0, 1, 1, 0]);
  });

  test("the day it starts has 23, without 02:00", async () => {
    const chart: Point[] = (await analytics("from=2026-03-08&to=2026-03-08")).chart;
    expect(chart).toHaveLength(23);
    expect(chart.map((item) => item.start)).not.toContain("2026-03-08T02:00");
    expect(chart.every((item) => !item.partial)).toBe(true);
  });

  test("hours over a week stop at the current hour", async () => {
    const body = await analytics("period=7d&interval=hour");
    expect(body).toMatchObject({ interval: "hour", intervals: ["hour", "day"] });
    // Six whole days and today's hours from 00:00 to 10:00.
    expect(body.chart).toHaveLength(6 * 24 + 11);
    expect(body.chart.at(-1)).toMatchObject({ start: "2026-11-28T10:00", partial: true });
    expect(point(body, "2026-11-28T09:00")?.visitors).toBe(1);
  });

  test("an interval that does not fit the range gives way to the range's own", async () => {
    expect(await analytics("period=7d&interval=month")).toMatchObject({ interval: "day" });
    expect(await analytics("period=today&interval=day")).toMatchObject({ interval: "hour" });
  });

  test("weeks start on Monday, cut by the range and by today", async () => {
    const chart: Point[] = (await analytics("period=mtd&interval=week")).chart;
    expect(chart.map((item) => [item.start, item.end, item.partial])).toEqual([
      ["2026-11-01", "2026-11-01", true],
      ["2026-11-02", "2026-11-08", false],
      ["2026-11-09", "2026-11-15", false],
      ["2026-11-16", "2026-11-22", false],
      ["2026-11-23", "2026-11-28", true],
    ]);
    expect(chart.map((item) => item.visitors)).toEqual([2, 0, 0, 1, 2]);
  });

  test("months run to their last day, and the current one to today", async () => {
    const chart: Point[] = (await analytics("period=ytd&interval=month")).chart;
    expect(chart).toHaveLength(11);
    expect(chart[0]).toMatchObject({ start: "2026-01-01", end: "2026-01-31", partial: false });
    expect(chart[1]).toMatchObject({ start: "2026-02-01", end: "2026-02-28" });
    expect(chart.at(-1)).toMatchObject({ start: "2026-11-01", end: "2026-11-28", partial: true });
  });

  test("hours follow a timezone that is half an hour off UTC", () => {
    const buckets = chartBuckets(
      "hour",
      {
        from: new Date("2026-11-27T18:30:00Z"),
        to: new Date("2026-11-28T18:30:00Z"),
        timeZone: "Asia/Kolkata",
      },
      // 21:10 in Kolkata.
      new Date("2026-11-28T15:40:00Z"),
    );
    expect(buckets).toHaveLength(22);
    expect(buckets[0]).toMatchObject({
      key: String(Date.parse("2026-11-27T18:30:00Z") / 1000),
      start: "2026-11-28T00:00",
      partial: false,
    });
    expect(buckets.at(-1)).toMatchObject({ start: "2026-11-28T21:00", partial: true });
  });
});

describe("comparison", () => {
  test("the previous period by default, on the chart too, by the same interval", async () => {
    const body = await analytics("period=7d");
    expect(body).toMatchObject({
      comparison: "previous",
      previous: {
        firstDay: "2026-11-15",
        lastDay: "2026-11-21",
        until: "2026-11-21T15:30:00.000Z",
      },
    });
    // 20 November's visitor, a week later on the chart.
    expect(point(body, "2026-11-27")).toMatchObject({ visitors: 1, previous: { visitors: 1 } });
    expect(point(body, "2026-11-22")?.previous).toEqual({ visitors: 0, pageviews: 0, visits: 0 });
  });

  test("off compares with nothing", async () => {
    const body = await analytics("period=7d&compare=off");
    expect(body).toMatchObject({ comparison: "off", previous: null });
    expect(body.chart.every((item: Point) => item.previous === null)).toBe(true);
    expect(body.summary.visitors).toBe(2);
  });

  test("the last 24 hours compare with the 24 before, hour by hour", async () => {
    const body = await analytics("period=24h");
    expect(body.previous).toMatchObject({
      firstDay: "2026-11-26",
      lastDay: "2026-11-27",
      until: "2026-11-27T15:30:00.000Z",
      summary: { visitors: 1 },
    });
    expect(point(body, "2026-11-28T09:00")).toMatchObject({
      visitors: 1,
      previous: { visitors: 1 },
    });
  });

  test("the same period last year, up to the same moment while it runs", async () => {
    const day = await analytics("period=24h&compare=year");
    expect(day.previous).toMatchObject({
      firstDay: "2025-11-27",
      lastDay: "2025-11-28",
      until: "2025-11-28T15:30:00.000Z",
      summary: { visitors: 1 },
    });
    expect(point(day, "2026-11-27T11:00")?.previous).toMatchObject({ visitors: 1 });
    expect((await analytics("period=mtd&compare=year")).previous).toMatchObject({
      firstDay: "2025-11-01",
      lastDay: "2025-11-28",
      until: "2025-11-28T15:30:00.000Z",
    });
  });

  test("29 February compares with nothing on the chart; 28 February with the 28th", async () => {
    const body = await analytics("from=2024-02-28&to=2024-03-01&compare=year");
    expect(body.previous).toMatchObject({
      firstDay: "2023-02-28",
      lastDay: "2023-03-01",
      until: null,
      summary: { visitors: 2 },
    });
    expect(body.chart.map((item: Point) => [item.start, item.previous?.visitors])).toEqual([
      ["2024-02-28", 1],
      ["2024-02-29", 0],
      ["2024-03-01", 1],
    ]);
  });

  test("a year before 29 February is the 28th", async () => {
    const days = await shiftedDays(dashboard.db, "2024-02-29", "2024-02-29", TIME_ZONE, NOW, {
      years: 1,
      days: 0,
    });
    expect(days).toMatchObject({ firstDay: "2023-02-28", lastDay: "2023-02-28", until: null });
  });
});
