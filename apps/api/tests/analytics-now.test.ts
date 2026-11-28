import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { NewEvent } from "../src/collection/event-store.ts";
import { signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/*
 * Right now (docs/web-analytics.md, "Right now"): the visitors of the last
 * 5 minutes, the last 30 minutes per minute, and the window's pages,
 * sources, and countries.
 */

/** 30 seconds into 12:00 on Tuesday 17 November 2026, UTC, the instance's timezone. */
const NOON = new Date("2026-11-17T12:00:30.000Z");
let clock = NOON;
const at = (time: string) => new Date(`2026-11-17T${time}.000Z`);

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let projectId = "";
let otherProject = "";

function event(
  name: string,
  visitorId: string | undefined,
  occurredAt: Date,
  more: Partial<NewEvent> & { country?: string } = {},
): NewEvent {
  const { country, ...rest } = more;
  return {
    eventId: randomUUID(),
    name,
    occurredAt,
    path: "/",
    ...(visitorId === undefined
      ? {}
      : {
          visitorId,
          client: { browser: "Chrome", browserVersion: "142", os: "macOS", deviceType: "desktop" },
          ...(country === undefined ? {} : { location: { country } }),
        }),
    ...rest,
  };
}

function get(path: string, cookie = dashboard.cookie, project = projectId) {
  return dashboard.app.inject({ url: `/api/projects/${project}${path}`, headers: { cookie } });
}

beforeAll(async () => {
  dashboard = await signedInDashboard({ now: () => clock });
  projectId = (
    await insertProject(dashboard.db, { name: "Right now", allowed_hostnames: ["shop.example"] })
  ).id;
  otherProject = (await insertProject(dashboard.db, { name: "Other" })).id;
  const DE = { country: "DE" };
  await dashboard.store(projectId, [
    // 1 came from a search 40 minutes ago and is still on the site: its visit's source counts.
    event("pageview", "1", at("11:20:00"), { ...DE, referrer: "https://www.google.com/search" }),
    event("pageview", "1", at("11:45:00"), {
      ...DE,
      path: "/pricing",
      referrer: "https://shop.example/",
    }),
    event("engagement", "1", at("11:46:00"), {
      ...DE,
      path: "/pricing",
      properties: { engagedMs: 50_000 },
    }),
    event("pageview", "1", at("11:58:10"), { ...DE, path: "/signup" }),
    // 2 came from a newsletter 20 minutes ago and has not been back.
    event("pageview", "2", at("11:40:00"), { country: "US", utm: { source: "newsletter" } }),
    // 3, from nowhere known, read the blog and signed up 4 minutes ago.
    event("pageview", "3", at("11:35:00"), { path: "/blog" }),
    event("signup", "3", at("11:56:00"), { path: "/blog" }),
    // 4 left 50 minutes ago: outside the window.
    event("pageview", "4", at("11:10:00"), DE),
    // A server's event has no visitor; errors and Web Vitals are not web analytics.
    event("invoice_paid", undefined, at("11:59:00")),
    event("error", "5", at("11:59:00"), {
      error: { type: "TypeError", message: "x is undefined", handled: false, fingerprint: "f1" },
    }),
    event("vitals", "5", at("11:59:00"), { properties: { lcp: 1200 } }),
    // Staging counts apart.
    event("pageview", "6", at("11:59:00"), { environment: "staging", path: "/beta" }),
  ]);
  await dashboard.store(otherProject, [event("pageview", "7", at("11:59:00"))]);
}, 60_000);

afterAll(async () => {
  await dashboard.close();
});

describe("right now", () => {
  test("counts the last 5 minutes, and lists the last 30", async () => {
    const response = await get("/analytics/now");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(body).toMatchObject({
      timeZone: "UTC",
      environment: "production",
      at: NOON.toISOString(),
      visitors: 2,
      windowVisitors: 3,
      pages: [
        { path: "/", visitors: 1, pageviews: 1 },
        { path: "/blog", visitors: 1, pageviews: 1 },
        { path: "/pricing", visitors: 1, pageviews: 1 },
        { path: "/signup", visitors: 1, pageviews: 1 },
      ],
      sources: [
        { value: "Direct / none", visitors: 1 },
        { value: "google.com", visitors: 1 },
        { value: "newsletter", visitors: 1 },
      ],
      countries: [
        { value: "DE", visitors: 1 },
        { value: "US", visitors: 1 },
        { value: null, visitors: 1 },
      ],
    });
  });

  test("gives 30 whole minutes, the current one last", async () => {
    const { perMinute } = (await get("/analytics/now")).json();
    expect(perMinute).toHaveLength(30);
    expect(perMinute[0].start).toBe(at("11:31:00").toISOString());
    expect(perMinute[29].start).toBe(at("12:00:00").toISOString());
    const active = perMinute.filter(
      (minute: { visitors: number; pageviews: number }) => minute.visitors > 0,
    );
    expect(active).toEqual([
      { start: at("11:35:00").toISOString(), visitors: 1, pageviews: 1 },
      { start: at("11:40:00").toISOString(), visitors: 1, pageviews: 1 },
      { start: at("11:45:00").toISOString(), visitors: 1, pageviews: 1 },
      { start: at("11:46:00").toISOString(), visitors: 1, pageviews: 0 },
      { start: at("11:56:00").toISOString(), visitors: 1, pageviews: 0 },
      { start: at("11:58:00").toISOString(), visitors: 1, pageviews: 1 },
    ]);
  });

  test("counts one environment, and only the project's own events", async () => {
    expect((await get("/analytics/now?environment=staging")).json()).toMatchObject({
      environment: "staging",
      visitors: 1,
      pages: [{ path: "/beta", visitors: 1, pageviews: 1 }],
      sources: [{ value: "Direct / none", visitors: 1 }],
    });
    expect((await get("/analytics/now", dashboard.cookie, otherProject)).json()).toMatchObject({
      visitors: 1,
      windowVisitors: 1,
    });
  });

  test("a window that crosses midnight keeps the visits that started before it", async () => {
    const later = new Date("2026-11-18T00:05:00.000Z");
    await dashboard.store(otherProject, [
      event("pageview", "8", new Date("2026-11-17T23:50:00.000Z"), {
        referrer: "https://www.bing.com/",
      }),
      event("pageview", "8", new Date("2026-11-17T23:59:00.000Z"), { path: "/docs" }),
      event("pageview", "9", new Date("2026-11-18T00:04:00.000Z"), { path: "/docs" }),
    ]);
    clock = later;
    try {
      expect((await get("/analytics/now", dashboard.cookie, otherProject)).json()).toMatchObject({
        visitors: 1,
        windowVisitors: 2,
        pages: [
          { path: "/docs", visitors: 2, pageviews: 2 },
          { path: "/", visitors: 1, pageviews: 1 },
        ],
        sources: [
          { value: "Direct / none", visitors: 1 },
          { value: "bing.com", visitors: 1 },
        ],
      });
    } finally {
      clock = NOON;
    }
  });

  test("answers zeros when nobody is there", async () => {
    clock = new Date("2026-11-17T15:00:00.000Z");
    try {
      const body = (await get("/analytics/now")).json();
      expect(body).toMatchObject({ visitors: 0, windowVisitors: 0, pages: [], sources: [] });
      expect(body.perMinute.every((minute: { visitors: number }) => minute.visitors === 0)).toBe(
        true,
      );
    } finally {
      clock = NOON;
    }
  });
});

describe("who may read it", () => {
  test("needs web analytics on the project", async () => {
    const product = await signedInUser(dashboard, {
      name: "Product only",
      email: "now-product@example.com",
      grants: { projects: [projectId], areas: { product_analytics: "view" } },
    });
    const refused = await get("/analytics/now", product.cookie);
    expect([refused.statusCode, refused.json().error]).toEqual([403, "forbidden"]);

    const web = await signedInUser(dashboard, {
      name: "Web only",
      email: "now-web@example.com",
      grants: { projects: [projectId], areas: { web_analytics: "view" } },
    });
    expect((await get("/analytics/now", web.cookie)).statusCode).toBe(200);
    const elsewhere = await get("/analytics/now", web.cookie, otherProject);
    expect(elsewhere.statusCode).toBe(404);
  });

  test("refuses unknown parameters and a malformed environment", async () => {
    const unknown = await get("/analytics/now?period=today");
    expect([unknown.statusCode, unknown.json().error]).toEqual([400, "invalid_query"]);
    expect((await get("/analytics/now?environment=no%20spaces")).statusCode).toBe(400);
  });
});
