import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { NewEvent } from "../src/collection/event-store.ts";
import { signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/** Noon on 17 November 2026 in UTC, the organization's timezone. */
const NOW = new Date("2026-11-17T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let projectId = "";

/** A page load's Web Vitals, as the tracker sends them. */
function pageLoad(
  path: string,
  vitals: Record<string, number>,
  more: Partial<NewEvent> & { deviceType?: "desktop" | "mobile" | "tablet" } = {},
): NewEvent {
  const { deviceType = "desktop", ...rest } = more;
  return {
    eventId: randomUUID(),
    name: "vitals",
    occurredAt: hoursAgo(2),
    path,
    visitorId: "1",
    properties: vitals,
    client: { browser: "Chrome", browserVersion: "142", os: "macOS", deviceType },
    ...rest,
  };
}

function speed(query: string) {
  return dashboard.app.inject({
    url: `/api/projects/${projectId}/speed?${query}`,
    headers: { cookie: dashboard.cookie },
  });
}

beforeAll(async () => {
  dashboard = await signedInDashboard({ now: () => NOW });
  projectId = (
    await insertProject(dashboard.db, {
      organization_id: dashboard.organizationId,
      name: "Shop",
    })
  ).id;
  await dashboard.store(projectId, [
    // Four loads of / on desktop: LCP 1,000 to 4,000 ms.
    pageLoad("/", { lcp: 1000, inp: 100, cls: 0.05, fcp: 800, ttfb: 200 }),
    pageLoad("/", { lcp: 2000, inp: 150, cls: 0.1, fcp: 900, ttfb: 300 }),
    pageLoad("/", { lcp: 3000, inp: 300, cls: 0.2, fcp: 1000, ttfb: 400 }),
    pageLoad("/", { lcp: 4000, cls: 0.3, fcp: 1100, ttfb: 500 }),
    // One slow load of /pricing on a phone, yesterday.
    pageLoad(
      "/pricing",
      { lcp: 6000, inp: 700, cls: 0.5, fcp: 3500, ttfb: 2000 },
      { deviceType: "mobile", occurredAt: hoursAgo(26) },
    ),
    // Time on page, even with numbers of the same names: not a page load.
    { ...pageLoad("/", { engagedMs: 4000, lcp: 99_999 }), name: "engagement" },
    // Without a possible value, as a site's own older "vitals" event might
    // be: not a page load either.
    pageLoad("/", { lcp: -1, cls: 500 }),
    pageLoad("/", { note: 1 }),
    // Staging's own.
    pageLoad("/", { lcp: 9000 }, { environment: "staging" }),
  ]);
});

afterAll(async () => {
  await dashboard?.close();
});

describe("GET /api/projects/:id/speed", () => {
  test("gives each metric's 75th percentile and how many loads were good, so-so, or poor", async () => {
    const response = await speed("period=7d");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      environment: "production",
      environments: ["production", "staging"],
      firstDay: "2026-11-11",
      lastDay: "2026-11-17",
      device: null,
      loads: 5,
      thresholds: { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25] },
    });
    expect(body.metrics.lcp).toEqual({
      p75: 4000,
      count: 5,
      good: 2,
      needsImprovement: 2,
      poor: 1,
    });
    // INP only where there was an interaction: four of the five loads.
    expect(body.metrics.inp).toMatchObject({ count: 4, good: 2, needsImprovement: 1, poor: 1 });
    expect(body.metrics.cls).toMatchObject({ count: 5, good: 2, needsImprovement: 1, poor: 2 });
    expect(body.metrics.ttfb).toMatchObject({ good: 4, needsImprovement: 0, poor: 1 });
  });

  test("breaks them down by device, page, and day", async () => {
    const body = (await speed("period=7d")).json();
    expect(body.devices).toMatchObject([
      // Between the third and fourth of 1, 2, 3, and 4 seconds.
      { deviceType: "desktop", loads: 4, lcp: 3250 },
      { deviceType: "mobile", loads: 1, lcp: 6000, inp: 700 },
    ]);
    expect(body.pages).toMatchObject([
      { path: "/", loads: 4 },
      { path: "/pricing", loads: 1, cls: 0.5 },
    ]);
    expect(body.days).toHaveLength(7);
    expect(body.days.slice(-2)).toMatchObject([
      { day: "2026-11-16", loads: 1, lcp: 6000 },
      { day: "2026-11-17", loads: 4 },
    ]);
    expect(body.days[0]).toEqual({ day: "2026-11-11", loads: 0, lcp: null, inp: null, cls: null });
  });

  test("filters by device, and counts one environment at a time", async () => {
    const mobile = (await speed("period=7d&device=mobile")).json();
    expect(mobile).toMatchObject({ device: "mobile", loads: 1, pages: [{ path: "/pricing" }] });
    const staging = (await speed("period=7d&environment=staging")).json();
    expect(staging.metrics.lcp).toMatchObject({ p75: 9000, count: 1, poor: 1 });
  });

  test("an empty range has no percentiles", async () => {
    const body = (await speed("from=2026-10-01&to=2026-10-07")).json();
    expect(body.loads).toBe(0);
    expect(body.metrics.lcp).toEqual({
      p75: null,
      count: 0,
      good: 0,
      needsImprovement: 0,
      poor: 0,
    });
    expect(body.pages).toEqual([]);
  });

  test("a page load's vitals are not web analytics, nor something a user did", async () => {
    const other = await insertProject(dashboard.db, {
      organization_id: dashboard.organizationId,
      name: "Blog",
    });
    await dashboard.store(other.id, [
      {
        eventId: randomUUID(),
        name: "pageview",
        occurredAt: hoursAgo(3),
        path: "/",
        visitorId: "7",
        userId: "ada",
      },
      pageLoad("/", { lcp: 1000 }, { visitorId: "7", userId: "ada", occurredAt: hoursAgo(1) }),
    ]);
    const read = async (path: string) =>
      (
        await dashboard.app.inject({
          url: `/api/projects/${other.id}${path}`,
          headers: { cookie: dashboard.cookie },
        })
      ).json();

    const analytics = await read("/analytics?period=7d");
    expect(analytics.summary).toMatchObject({ visits: 1, pageviews: 1 });
    expect(analytics.customEvents).toEqual([]);
    const user = await read("/users/ada");
    expect(user.user).toMatchObject({ events: 1, lastSeenAt: hoursAgo(3).toISOString() });
    expect(user.activity.map((item: { name: string }) => item.name)).toEqual(["pageview"]);
  });

  test("refuses an unknown device or a bad range", async () => {
    expect((await speed("period=7d&device=watch")).statusCode).toBe(400);
    expect((await speed("period=7d&from=2026-11-01")).statusCode).toBe(400);
  });
});
