import { randomUUID } from "node:crypto";

import { sql } from "kysely";
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
  // "/" stayed open 40 minutes, then the visitor moved on: the engagement
  // report and the next pageview share a moment. The report comes first and
  // is stale: it reports time for a visit that had already ended.
  pv("4", "2026-11-17T03:40:00Z", "/", {
    name: "engagement",
    properties: { engagedMs: 2_400_000 },
    location: { country: "DE" },
  }),
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

/** All custom events in a response. */
const totalEvents = (body: { customEvents: { events: number }[] }) =>
  body.customEvents.reduce((sum, row) => sum + row.events, 0);

describe("GET /api/projects/:id/analytics with filters", () => {
  let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
  let projectId = "";

  beforeAll(async () => {
    dashboard = await signedInDashboard({
      timeZone: TIME_ZONE,
      now: () => new Date("2026-11-17T17:00:00Z"),
    });
    const project = await dashboard.db
      .insertInto("projects")
      .values({ name: "Filter test", allowed_hostnames: ["example.com"] })
      .returning("id")
      .executeTakeFirstOrThrow();
    projectId = project.id;
    await storeEvents(dashboard.db, projectId, EVENTS);
  });

  afterAll(async () => {
    await dashboard?.close();
  });

  /** The analytics for 16-17 November, with extra query parameters. */
  async function filtered(query: Record<string, string>) {
    const params = new URLSearchParams({ from: "2026-11-16", to: "2026-11-17", ...query });
    const response = await dashboard.app.inject({
      url: `/api/projects/${projectId}/analytics?${params.toString()}`,
      headers: { cookie: dashboard.cookie },
    });
    return response;
  }

  // The fixture's six visits: 1 (DE, from Google, / then /pricing, signup),
  // 2 (US, newsletter campaign, /pricing), 3 (no location, from Hacker
  // News, /docs), 33 (no location, /), and visitor 4's two visits on the
  // 17th (DE, / and then /docs 40 minutes later).

  test("a country keeps its visits, and only their events, in every report", async () => {
    const body = (await filtered({ country: "DE" })).json();

    expect(body.summary).toMatchObject({ visits: 3, visitors: 2, pageviews: 4 });
    expect(body.days.map((day: { visits: number }) => day.visits)).toEqual([1, 2]);
    expect(body.pages).toEqual([
      { path: "/", pageviews: 2, visitors: 2, avgEngagedMs: null },
      { path: "/docs", pageviews: 1, visitors: 1, avgEngagedMs: null },
      { path: "/pricing", pageviews: 1, visitors: 1, avgEngagedMs: 60_000 },
    ]);
    expect(body.customEvents).toEqual([{ name: "signup", events: 1, visitors: 1 }]);
    expect(body.breakdowns.country).toEqual([
      { value: "DE", visitors: 2, visits: 3, bounceRate: 2 / 3 },
    ]);
  });

  test("an empty value matches visits where the dimension is unknown", async () => {
    const body = (await filtered({ country: "" })).json();

    expect(body.summary).toMatchObject({ visits: 2, visitors: 2, pageviews: 2 });
    expect(body.breakdowns.country).toEqual([
      { value: null, visitors: 2, visits: 2, bounceRate: 1 },
    ]);
  });

  test("a value matches exactly as its breakdown row shows it", async () => {
    expect((await filtered({ source: "google.com" })).json().summary).toMatchObject({
      visits: 1,
      pageviews: 2,
    });
    expect((await filtered({ source: "Direct / none" })).json().summary.visits).toBe(3);
    expect((await filtered({ region: "Bavaria, DE" })).json().summary.visits).toBe(1);
    expect((await filtered({ utmCampaign: "launch" })).json().summary.visits).toBe(1);
    expect((await filtered({ deviceType: "mobile" })).json().summary.visits).toBe(1);
    expect((await filtered({ entryPage: "/docs" })).json().summary.visits).toBe(2);
  });

  test("a page keeps the visits that viewed it, with all their pageviews", async () => {
    const body = (await filtered({ page: "/pricing" })).json();

    expect(body.summary).toMatchObject({ visits: 2, visitors: 2, pageviews: 3 });
    expect(body.pages.map((row: { path: string }) => row.path)).toEqual(["/pricing", "/"]);
  });

  test("several filters must all match", async () => {
    const body = (await filtered({ country: "DE", page: "/docs" })).json();

    expect(body.summary).toMatchObject({ visits: 1, visitors: 1, pageviews: 1 });
    expect(body.pages).toEqual([{ path: "/docs", pageviews: 1, visitors: 1, avgEngagedMs: null }]);
  });

  test("each row's filter keeps exactly that row's visits and events, so the rows add up", async () => {
    const all = (await filtered({})).json();
    for (const dimension of DIMENSIONS) {
      const sums = { visits: 0, pageviews: 0, events: 0 };
      for (const row of all.breakdowns[dimension] as { value: string | null; visits: number }[]) {
        const body = (await filtered({ [dimension]: row.value ?? "" })).json();
        expect({ dimension, value: row.value, visits: body.summary.visits }).toEqual({
          dimension,
          value: row.value,
          visits: row.visits,
        });
        sums.visits += body.summary.visits;
        sums.pageviews += body.summary.pageviews;
        sums.events += totalEvents(body);
      }
      expect({ dimension, ...sums }).toEqual({
        dimension,
        visits: all.summary.visits,
        pageviews: all.summary.pageviews,
        events: totalEvents(all),
      });
    }
  });

  test("leaves out a stale engagement report at the moment a visit starts", async () => {
    // Unfiltered, the time on "/" averages every report for it, stale or not.
    const all = (await filtered({})).json();
    expect(all.pages.find((row: { path: string }) => row.path === "/").avgEngagedMs).toBe(
      2_400_000,
    );
    // Filtered, only reports that belong to a matching visit count.
    const body = (await filtered({ country: "DE" })).json();
    expect(body.pages.find((row: { path: string }) => row.path === "/").avgEngagedMs).toBeNull();
  });

  test("a report refuses visits that were filtered differently from its range", async () => {
    const db = dashboard.db;
    const range = {
      projectId,
      timeZone: TIME_ZONE,
      filters: [{ name: "country" as const, value: "DE" }],
      ...(await localDays(db, "2026-11-16", "2026-11-17", TIME_ZONE)),
    };
    const unfiltered = { sql: sql`select 1`, filters: [] };

    await expect(summary(db, range, unfiltered)).rejects.toThrow(/filtered differently/);
  });

  test("gives the same numbers as each report function on its own", async () => {
    const body = (await filtered({ country: "DE", page: "/" })).json();
    const db = dashboard.db;
    const range = {
      projectId,
      timeZone: TIME_ZONE,
      filters: [
        { name: "page" as const, value: "/" },
        { name: "country" as const, value: "DE" },
      ],
      ...(await localDays(db, "2026-11-16", "2026-11-17", TIME_ZONE)),
    };
    expect(body.summary).toEqual(json(await summary(db, range)));
    expect(body.days).toEqual(json(await timeseries(db, range)));
    expect(body.pages).toEqual(json(await topPages(db, range)));
    expect(body.customEvents).toEqual(json(await customEvents(db, range)));
    for (const dimension of DIMENSIONS) {
      expect({ [dimension]: body.breakdowns[dimension] }).toEqual({
        [dimension]: json(await breakdown(db, range, dimension)),
      });
    }
    expect(body.summary.visits).toBe(2);
  });

  test("a value is compared, never run as SQL", async () => {
    const response = await filtered({ country: "DE' or '1'='1" });

    expect(response.statusCode).toBe(200);
    expect(response.json().summary.visits).toBe(0);
  });

  test.each<[Record<string, string>, string]>([
    [{ colour: "red" }, "an unknown filter"],
    [{ page: `/${"a".repeat(2048)}` }, "a value over 2,048 characters"],
    [{ country: "D\u0000E" }, "a NUL character"],
  ])("refuses %j (%s)", async (query) => {
    expect((await filtered(query)).statusCode).toBe(400);
  });
});
