import { randomUUID } from "node:crypto";

import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { buildApp } from "../src/app.ts";
import { type ClickHouseClient, createClickHouse } from "../src/clickhouse/clickhouse.ts";
import type { NewEvent } from "../src/collection/event-store.ts";
import { loadConfig } from "../src/config.ts";
import {
  breakdown,
  customEvents,
  localDays,
  previousDays,
  summary,
  timeseries,
  topPages,
  type VisitDimension,
} from "../src/reports/reports.ts";
import { PUBLIC_URL, signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

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
    const project = await insertProject(dashboard.db, {
      name: "Analytics test",
      allowed_hostnames: ["example.com"],
    });
    projectId = project.id;
    await dashboard.store(projectId, EVENTS);
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
      ownHostnames: ["example.com"],
      environment: "production",
      ...(await localDays(db, "2026-11-16", "2026-11-17", TIME_ZONE)),
    };
    expect(body).toMatchObject({
      timeZone: TIME_ZONE,
      firstDay: "2026-11-16",
      lastDay: "2026-11-17",
    });
    expect(body.summary).toEqual(json(await summary(dashboard.reader, range)));
    expect(body.days).toEqual(json(await timeseries(dashboard.reader, range)));
    expect(body.pages).toEqual(json(await topPages(dashboard.reader, range)));
    expect(body.customEvents).toEqual(json(await customEvents(dashboard.reader, range)));
    for (const dimension of DIMENSIONS) {
      expect({ [dimension]: body.breakdowns[dimension] }).toEqual({
        [dimension]: json(await breakdown(dashboard.reader, range, dimension)),
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
    const project = await insertProject(dashboard.db, {
      name: "Filter test",
      allowed_hostnames: ["example.com"],
    });
    projectId = project.id;
    await dashboard.store(projectId, EVENTS);
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

  // A whole report for each row of each breakdown, one after another: over
  // ten seconds on the dev VM, past the default five.
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
  }, 60_000);

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
      ownHostnames: ["example.com"],
      environment: "production",
      filters: [{ name: "country" as const, value: "DE" }],
      ...(await localDays(db, "2026-11-16", "2026-11-17", TIME_ZONE)),
    };
    const unfiltered = { table: "analytics_visits", filters: [] };

    await expect(summary(dashboard.reader, range, unfiltered)).rejects.toThrow(
      /filtered differently/,
    );
  });

  test("gives the same numbers as each report function on its own", async () => {
    const body = (await filtered({ country: "DE", page: "/" })).json();
    const db = dashboard.db;
    const range = {
      projectId,
      timeZone: TIME_ZONE,
      ownHostnames: ["example.com"],
      environment: "production",
      filters: [
        { name: "page" as const, value: "/" },
        { name: "country" as const, value: "DE" },
      ],
      ...(await localDays(db, "2026-11-16", "2026-11-17", TIME_ZONE)),
    };
    expect(body.summary).toEqual(json(await summary(dashboard.reader, range)));
    expect(body.days).toEqual(json(await timeseries(dashboard.reader, range)));
    expect(body.pages).toEqual(json(await topPages(dashboard.reader, range)));
    expect(body.customEvents).toEqual(json(await customEvents(dashboard.reader, range)));
    for (const dimension of DIMENSIONS) {
      expect({ [dimension]: body.breakdowns[dimension] }).toEqual({
        [dimension]: json(await breakdown(dashboard.reader, range, dimension)),
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

/** A dashboard whose clock reads `now`, with the fixture's events stored. */
async function dashboardAt(now: string) {
  const dashboard = await signedInDashboard({ timeZone: TIME_ZONE, now: () => new Date(now) });
  const project = await insertProject(dashboard.db, {
    name: "Comparison test",
    allowed_hostnames: ["example.com"],
  });
  await dashboard.store(project.id, EVENTS);
  const analytics = async (query: string) =>
    (
      await dashboard.app.inject({
        url: `/api/projects/${project.id}/analytics?${query}`,
        headers: { cookie: dashboard.cookie },
      })
    ).json();
  return { dashboard, analytics };
}

describe("comparison with the previous period", () => {
  test("compares whole past days with as many whole days before them", async () => {
    // 01:00 on 18 November in Singapore: the 17th is over.
    const { dashboard, analytics } = await dashboardAt("2026-11-17T17:00:00Z");
    try {
      const day = await analytics("from=2026-11-17&to=2026-11-17");
      expect(day.summary).toMatchObject({ visits: 3, visitors: 2, pageviews: 3 });
      expect(day.previous).toMatchObject({
        firstDay: "2026-11-16",
        lastDay: "2026-11-16",
        until: null,
        summary: { visits: 3, visitors: 3, pageviews: 4 },
      });

      const week = await analytics("from=2026-11-11&to=2026-11-17");
      expect(week.previous).toMatchObject({
        firstDay: "2026-11-04",
        lastDay: "2026-11-10",
        summary: { visits: 0, pageviews: 0, bounceRate: null },
      });

      // Filters apply to both periods.
      const filtered = await analytics("from=2026-11-17&to=2026-11-17&country=DE");
      expect(filtered.previous.summary).toMatchObject({ visits: 1, pageviews: 2 });
    } finally {
      await dashboard.close();
    }
  });

  test("compares a running day up to the same time of day", async () => {
    const { dashboard, analytics } = await dashboardAt("2026-11-17T17:00:00Z");
    try {
      // Today is the 18th, one hour in: compared with the 17th up to 01:00,
      // which holds visitor 33's visit at 00:05 and nothing after.
      const today = await analytics("period=today");
      expect(today.previous).toMatchObject({
        firstDay: "2026-11-17",
        lastDay: "2026-11-17",
        until: "2026-11-16T17:00:00.000Z",
        summary: { visits: 1, pageviews: 1 },
      });
    } finally {
      await dashboard.close();
    }
  });

  test("sees a visit in progress at that time as it stood then", async () => {
    // 10:03 on the 17th in Singapore. On the 16th at 10:03, visitor 1 had
    // seen one page; the pricing page, the signup, and the time on page
    // came later. Up to then, the visit was a bounce of 0 seconds.
    const { dashboard, analytics } = await dashboardAt("2026-11-17T02:03:00Z");
    try {
      const today = await analytics("period=today");
      expect(today.previous).toMatchObject({
        until: "2026-11-16T02:03:00.000Z",
        summary: {
          visits: 1,
          visitors: 1,
          pageviews: 1,
          viewsPerVisit: 1,
          bounceRate: 1,
          avgDurationMs: 0,
          avgEngagedMs: 0,
        },
      });
    } finally {
      await dashboard.close();
    }
  });

  test("a range running past today compares up to the same moment, and says which day", async () => {
    const { dashboard, analytics } = await dashboardAt("2026-11-17T17:00:00Z");
    try {
      // November, at 01:00 on the 18th: 30 days, with data up to now. The 30
      // days before start on 2 October; the same moment there is 01:00 on
      // 19 October, so that is where the comparison ends.
      const month = await analytics("from=2026-11-01&to=2026-11-30");
      expect(month.previous).toMatchObject({
        firstDay: "2026-10-02",
        lastDay: "2026-10-19",
        until: "2026-10-18T17:00:00.000Z",
      });
    } finally {
      await dashboard.close();
    }
  });

  test("a cut-off applies to events as well as visits", async () => {
    const { dashboard } = await dashboardAt("2026-11-17T17:00:00Z");
    try {
      const [project] = await dashboard.db.selectFrom("projects").select("id").execute();
      // The whole 16th, but only what had happened by 10:03: visitor 1's first page.
      const range = {
        projectId: project?.id ?? "",
        timeZone: TIME_ZONE,
        ownHostnames: ["example.com"],
        environment: "production",
        ...(await localDays(dashboard.db, "2026-11-16", "2026-11-16", TIME_ZONE)),
        until: new Date("2026-11-16T02:03:00Z"),
      };
      expect(await summary(dashboard.reader, range)).toMatchObject({
        visits: 1,
        visitors: 1,
        pageviews: 1,
        bounceRate: 1,
      });
      expect(await topPages(dashboard.reader, range)).toEqual([
        { path: "/", pageviews: 1, visitors: 1, avgEngagedMs: null },
      ]);
      expect(await customEvents(dashboard.reader, range)).toEqual([]);
    } finally {
      await dashboard.close();
    }
  });

  test("keeps the time of day across a daylight saving change", async () => {
    const { dashboard } = await dashboardAt("2026-11-17T17:00:00Z");
    try {
      // Berlin leaves summer time on 25 October 2026. At 15:00 on the 31st
      // (14:00 UTC), the last 7 days compare with 18-24 October up to 15:00
      // on the 24th, in summer time: 13:00 UTC.
      const previous = await previousDays(
        dashboard.db,
        "2026-10-25",
        "2026-10-31",
        "Europe/Berlin",
        new Date("2026-10-31T14:00:00Z"),
      );
      expect(previous).toEqual({
        firstDay: "2026-10-18",
        lastDay: "2026-10-24",
        from: new Date("2026-10-17T22:00:00Z"),
        to: new Date("2026-10-24T13:00:00Z"),
        until: new Date("2026-10-24T13:00:00Z"),
      });
    } finally {
      await dashboard.close();
    }
  });
});

/** The names in a list response: paths, or breakdown values. */
const names = (body: { rows: { path?: string; value?: string | null }[] }) =>
  body.rows.map((row) => row.path ?? row.value);

describe("GET /api/projects/:id/analytics/list", () => {
  let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
  let projectId = "";

  beforeAll(async () => {
    dashboard = await signedInDashboard({
      timeZone: TIME_ZONE,
      now: () => new Date("2026-11-17T17:00:00Z"),
    });
    const project = await insertProject(dashboard.db, {
      name: "List test",
      allowed_hostnames: ["example.com"],
    });
    projectId = project.id;
    // A path with LIKE's own characters, which a search must match literally.
    await dashboard.store(projectId, [...EVENTS, pv("5", "2026-11-17T05:00:00Z", "/100%_off")]);
  });

  afterAll(async () => {
    await dashboard?.close();
  });

  async function list(query: Record<string, string>) {
    const params = new URLSearchParams({ from: "2026-11-16", to: "2026-11-17", ...query });
    return dashboard.app.inject({
      url: `/api/projects/${projectId}/analytics/list?${params.toString()}`,
      headers: { cookie: dashboard.cookie },
    });
  }
  const rows = async (query: Record<string, string>) => (await list(query)).json();

  test("reads a list a page at a time, and says when more follow", async () => {
    const first = await rows({ report: "pages", limit: "2" });
    expect(names(first)).toEqual(["/", "/docs"]);
    expect(first.hasMore).toBe(true);
    const second = await rows({ report: "pages", limit: "2", offset: "2" });
    expect(names(second)).toEqual(["/pricing", "/100%_off"]);
    expect(second.hasMore).toBe(false);
  });

  test("gives the same rows as the page's lists", async () => {
    const page = (
      await dashboard.app.inject({
        url: `/api/projects/${projectId}/analytics?from=2026-11-16&to=2026-11-17`,
        headers: { cookie: dashboard.cookie },
      })
    ).json();
    expect((await rows({ report: "pages" })).rows).toEqual(page.pages);
    expect((await rows({ report: "source" })).rows).toEqual(page.breakdowns.source);
    expect((await rows({ report: "customEvents" })).rows).toEqual(page.customEvents);
  });

  test("searches names without regard to case", async () => {
    expect(names(await rows({ report: "pages", search: "PRIC" }))).toEqual(["/pricing"]);
    expect(names(await rows({ report: "source", search: "hacker" }))).toEqual([]);
    expect(names(await rows({ report: "source", search: "YCOMB" }))).toEqual([
      "news.ycombinator.com",
    ]);
    expect(names(await rows({ report: "customEvents", search: "sign" }))).toEqual([undefined]);
    expect((await rows({ report: "customEvents", search: "sign" })).rows[0].name).toBe("signup");
  });

  test("matches % and _ as themselves", async () => {
    expect(names(await rows({ report: "pages", search: "%" }))).toEqual(["/100%_off"]);
    expect(names(await rows({ report: "pages", search: "_" }))).toEqual(["/100%_off"]);
    expect(names(await rows({ report: "pages", search: "0%_o" }))).toEqual(["/100%_off"]);
  });

  test("finds a country by its name or its code", async () => {
    expect(names(await rows({ report: "country", search: "germ" }))).toEqual(["DE"]);
    expect(names(await rows({ report: "country", search: "united states" }))).toEqual(["US"]);
    expect(names(await rows({ report: "country", search: "us" }))).toEqual(["US"]);
    expect(names(await rows({ report: "country", search: "atlantis" }))).toEqual([]);
  });

  test("applies the page's filters", async () => {
    expect(names(await rows({ report: "pages", country: "DE" }))).toEqual([
      "/",
      "/docs",
      "/pricing",
    ]);
    expect(names(await rows({ report: "pages", country: "DE", search: "doc" }))).toEqual(["/docs"]);
  });

  test("needs a signed-in user and a known project", async () => {
    const signedOut = await dashboard.app.inject({
      url: `/api/projects/${projectId}/analytics/list?report=pages&period=7d`,
    });
    expect(signedOut.statusCode).toBe(401);
    const unknown = await dashboard.app.inject({
      url: `/api/projects/${randomUUID()}/analytics/list?report=pages&period=7d`,
      headers: { cookie: dashboard.cookie },
    });
    expect(unknown.statusCode).toBe(404);
  });

  test.each<[Record<string, string>, string]>([
    [{}, "no report"],
    [{ report: "colour" }, "an unknown report"],
    [{ report: "pages", limit: "51" }, "more than 50 rows"],
    [{ report: "pages", offset: "-1" }, "a negative offset"],
    [{ report: "pages", search: "a".repeat(201) }, "a search over 200 characters"],
    [{ report: "pages", search: "a\u0000b" }, "a NUL in the search"],
    [{ report: "pages", sort: "name" }, "an unknown parameter"],
  ])("refuses %j (%s)", async (query) => {
    expect((await list(query)).statusCode).toBe(400);
  });
});

/** Breakdown rows by value, "(unknown)" for none. */
const byValue = <T extends { value: string | null }>(rows: T[]) =>
  Object.fromEntries(rows.map((row) => [row.value ?? "(unknown)", row]));

describe("environments and releases", () => {
  let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
  let projectId = "";

  beforeAll(async () => {
    dashboard = await signedInDashboard({
      timeZone: TIME_ZONE,
      now: () => new Date("2026-11-17T17:00:00Z"),
    });
    const project = await insertProject(dashboard.db, {
      name: "Environments",
      allowed_hostnames: ["example.com"],
    });
    projectId = project.id;
    await dashboard.store(projectId, [
      pv("1", "2026-11-16T02:00:00Z", "/", { release: "1.4.2" }),
      pv("1", "2026-11-16T02:05:00Z", "/pricing", { release: "1.4.2" }),
      pv("2", "2026-11-16T03:00:00Z", "/", { release: "1.5.0" }),
      pv("3", "2026-11-16T04:00:00Z", "/"),
      // The same visitor on the staging site: never part of production's numbers.
      pv("1", "2026-11-16T02:03:00Z", "/beta", { environment: "staging", release: "1.6.0-rc.1" }),
    ]);
  });

  afterAll(async () => {
    await dashboard?.close();
  });

  async function analytics(query: string) {
    return dashboard.app.inject({
      url: `/api/projects/${projectId}/analytics?from=2026-11-16&to=2026-11-17&${query}`,
      headers: { cookie: dashboard.cookie },
    });
  }

  test("count production unless asked, and list the environments to switch to", async () => {
    const body = (await analytics("")).json();
    expect(body).toMatchObject({
      environment: "production",
      environments: ["production", "staging"],
      summary: { visits: 3, pageviews: 4, visitors: 3 },
    });
    expect(body.pages.map((row: { path: string }) => row.path)).not.toContain("/beta");
    expect(byValue(body.breakdowns.release)).toMatchObject({
      "1.4.2": { visits: 1 },
      "1.5.0": { visits: 1 },
      "(unknown)": { visits: 1 },
    });
  });

  test("count another environment, named in any case", async () => {
    const body = (await analytics("environment=Staging")).json();
    expect(body).toMatchObject({
      environment: "staging",
      summary: { visits: 1, pageviews: 1 },
      pages: [{ path: "/beta" }],
      breakdowns: { release: [{ value: "1.6.0-rc.1", visits: 1 }] },
    });
  });

  test("an environment with nothing in the range shows zeros, and stays in the list", async () => {
    const body = (await analytics("environment=preview")).json();
    expect(body.environment).toBe("preview");
    expect(body.environments).toEqual(["production", "staging", "preview"]);
    expect(body.summary).toMatchObject({ visits: 0, pageviews: 0 });
  });

  test("filter by release, and list releases in full", async () => {
    const filtered = (await analytics("release=1.4.2")).json();
    expect(filtered.summary).toMatchObject({ visits: 1, pageviews: 2 });

    const list = await dashboard.app.inject({
      url: `/api/projects/${projectId}/analytics/list?report=release&from=2026-11-16&to=2026-11-17&environment=staging`,
      headers: { cookie: dashboard.cookie },
    });
    expect(list.json().rows).toEqual([
      { value: "1.6.0-rc.1", visitors: 1, visits: 1, bounceRate: 1 },
    ]);
  });

  test("always list production, so the page can switch back to it", async () => {
    const project = await insertProject(dashboard.db, {
      name: "Not live yet",
      allowed_hostnames: ["example.com"],
    });
    await dashboard.store(project.id, [
      pv("9", "2026-11-16T02:00:00Z", "/", { environment: "staging" }),
    ]);
    for (const environment of ["production", "staging"]) {
      const response = await dashboard.app.inject({
        url: `/api/projects/${project.id}/analytics?from=2026-11-16&to=2026-11-17&environment=${environment}`,
        headers: { cookie: dashboard.cookie },
      });
      expect(response.json().environments).toEqual(["staging", "production"]);
    }
  });

  test.each(["my staging", "-staging", "s".repeat(65)])("refuses environment %j", async (name) => {
    expect((await analytics(`environment=${encodeURIComponent(name)}`)).statusCode).toBe(400);
  });
});

describe("when ClickHouse fails", () => {
  let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
  let projectId = "";

  beforeAll(async () => {
    dashboard = await signedInDashboard({ timeZone: TIME_ZONE });
    const project = await insertProject(dashboard.db, {
      name: "Failures",
      allowed_hostnames: ["example.com"],
    });
    projectId = project.id;
  });

  afterAll(async () => {
    await dashboard?.close();
  });

  /** The analytics endpoint on the same database and sign-in, reading `clickhouse`. */
  async function analyticsWith(clickhouse: ClickHouseClient) {
    const app = buildApp({
      db: dashboard.db,
      dashboard: {
        auth: dashboard.auth,
        clickhouse,
        publicUrl: PUBLIC_URL,
        trustedOrigins: [PUBLIC_URL],
      },
    });
    try {
      return await app.inject({
        url: `/api/projects/${projectId}/analytics?from=2026-11-16&to=2026-11-17`,
        headers: { cookie: dashboard.cookie },
      });
    } finally {
      await app.close();
      await clickhouse.close();
    }
  }

  test("a server error says nothing about the database", async () => {
    const response = await analyticsWith(
      createClickHouse({ ...loadConfig().clickhouse, url: "http://127.0.0.1:1" }),
    );
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: "internal_error",
      message: "The reports could not be calculated. Try again.",
    });
  });

  test("running out of memory asks to try a shorter range or again later", async () => {
    const config = loadConfig().clickhouse;
    // As if the server had no memory to spare: every query fails.
    const starved = createClient({
      url: config.url,
      username: config.username,
      password: config.password,
      database: dashboard.clickhouseDatabase,
      clickhouse_settings: { max_memory_usage: "1" },
    });
    const response = await analyticsWith(starved);
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("60");
    expect(response.json()).toMatchObject({ error: "reports_busy" });
  });

  test("a bad request still names its problem", async () => {
    const response = await dashboard.app.inject({
      url: `/api/projects/${projectId}/analytics?from=2026-11-16&to=2026-11-17&limit=0`,
      headers: { cookie: dashboard.cookie },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/limit/);
  });
});
