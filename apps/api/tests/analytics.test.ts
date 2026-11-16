import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { type NewEvent, storeEvents } from "../src/collection/event-store.ts";
import {
  breakdown,
  customEvents,
  localDays,
  summary,
  timeseries,
  topPages,
  type VisitDimension,
} from "../src/reports/reports.ts";
import { signedInDashboard } from "./helpers/dashboard.ts";

const TIME_ZONE = "Asia/Singapore";

function pv(visitorId: string, iso: string, path: string, extra: Partial<NewEvent> = {}): NewEvent {
  return {
    eventId: randomUUID(),
    name: "pageview",
    occurredAt: new Date(iso),
    path,
    visitorId,
    ...extra,
  };
}

/** Two days in Singapore (UTC+8), 16 and 17 November 2026; times below are UTC. */
const EVENTS: NewEvent[] = [
  pv("1", "2026-11-16T02:00:00Z", "/", {
    referrer: "https://www.google.com/search",
    location: { country: "DE", region: "Bavaria", city: "Munich" },
    client: { browser: "Chrome", os: "macOS", deviceType: "desktop" },
  }),
  pv("1", "2026-11-16T02:05:00Z", "/pricing"),
  pv("1", "2026-11-16T02:06:00Z", "/pricing", { name: "signup" }),
  pv("1", "2026-11-16T02:07:00Z", "/pricing", {
    name: "engagement",
    properties: { engagedMs: 60_000 },
  }),
  pv("2", "2026-11-16T05:00:00Z", "/pricing", {
    utm: { source: "newsletter", medium: "email", campaign: "launch" },
    location: { country: "US", region: "California", city: "Mountain View" },
    client: { browser: "Safari", os: "iOS", deviceType: "mobile" },
  }),
  pv("3", "2026-11-16T15:50:00Z", "/docs", { referrer: "https://news.ycombinator.com/item" }),
  pv("33", "2026-11-16T16:05:00Z", "/"),
  pv("4", "2026-11-17T03:00:00Z", "/", { location: { country: "DE" } }),
  pv("4", "2026-11-17T03:40:00Z", "/docs", { location: { country: "DE" } }),
];

/** A value as it looks after a round trip through JSON, like an API response. */
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

const DIMENSIONS = [
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
] as const satisfies readonly VisitDimension[];

describe("GET /api/projects/:id/analytics", () => {
  let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
  let projectId = "";

  beforeAll(async () => {
    // 01:00 on 18 November in Singapore: still the 17th in UTC.
    dashboard = await signedInDashboard({
      timeZone: TIME_ZONE,
      now: () => new Date("2026-11-17T17:00:00Z"),
    });
    const project = await dashboard.db
      .insertInto("projects")
      .values({ name: "Analytics test", allowed_hostnames: ["example.com"] })
      .returning("id")
      .executeTakeFirstOrThrow();
    projectId = project.id;
    await storeEvents(dashboard.db, projectId, EVENTS);
  });

  afterAll(async () => {
    await dashboard?.close();
  });

  function analytics(
    query: string,
    headers: Record<string, string> = { cookie: dashboard.cookie },
  ) {
    return dashboard.app.inject({ url: `/api/projects/${projectId}/analytics?${query}`, headers });
  }

  test("needs a signed-in user", async () => {
    expect((await analytics("from=2026-11-16&to=2026-11-17", {})).statusCode).toBe(401);
  });

  test("works out visits once and gives every report the same numbers as on its own", async () => {
    const response = await analytics("from=2026-11-16&to=2026-11-17");
    expect(response.statusCode).toBe(200);
    const body = response.json();

    // Each report function on its own works out the visits itself.
    const db = dashboard.db;
    const range = {
      projectId,
      timeZone: TIME_ZONE,
      ...(await localDays(db, "2026-11-16", "2026-11-17", TIME_ZONE)),
    };
    expect(body).toMatchObject({
      timeZone: TIME_ZONE,
      firstDay: "2026-11-16",
      lastDay: "2026-11-17",
    });
    expect(body.summary).toEqual(json(await summary(db, range)));
    expect(body.days).toEqual(json(await timeseries(db, range)));
    expect(body.pages).toEqual(json(await topPages(db, range)));
    expect(body.customEvents).toEqual(json(await customEvents(db, range)));
    for (const dimension of DIMENSIONS) {
      expect({ [dimension]: body.breakdowns[dimension] }).toEqual({
        [dimension]: json(await breakdown(db, range, dimension)),
      });
    }

    // And the numbers themselves.
    expect(body.summary).toMatchObject({ visitors: 5, pageviews: 7, visits: 6 });
    expect(body.days.map((day: { visits: number }) => day.visits)).toEqual([3, 3]);
  });

  test("works out a period's days from today in the instance's timezone", async () => {
    const body = (await analytics("period=7d")).json();
    expect(body).toMatchObject({ firstDay: "2026-11-12", lastDay: "2026-11-18" });
    expect((await analytics("period=today")).json()).toMatchObject({
      firstDay: "2026-11-18",
      lastDay: "2026-11-18",
    });
    // The same date a year ago is left out: 365 days.
    expect((await analytics("period=12m")).json()).toMatchObject({ firstDay: "2025-11-19" });
  });

  test("respects the row limit", async () => {
    const body = (await analytics("from=2026-11-16&to=2026-11-17&limit=1")).json();
    expect(body.pages).toHaveLength(1);
    expect(body.breakdowns.source).toHaveLength(1);
  });

  test.each([
    ["from=2026-02-30&to=2026-03-01", "not a calendar day"],
    ["from=2026-11-17&to=2026-11-16", "to before from"],
    ["from=2025-01-01&to=2026-01-02", "over 366 days"],
    ["from=2026-11-16", "no to"],
    ["from=16-11-2026&to=17-11-2026", "wrong format"],
    ["period=7d&from=2026-11-16&to=2026-11-17", "both a period and days"],
    ["period=week", "an unknown period"],
    ["", "nothing"],
  ])("refuses %s (%s)", async (query) => {
    expect((await analytics(query)).statusCode).toBe(400);
  });

  test("answers 404 for an unknown project", async () => {
    const response = await dashboard.app.inject({
      url: `/api/projects/${randomUUID()}/analytics?from=2026-11-16&to=2026-11-17`,
      headers: { cookie: dashboard.cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});
