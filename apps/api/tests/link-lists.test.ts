import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { NewEvent } from "../src/collection/event-store.ts";
import { PUBLIC_URL, signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/*
 * The Analytics page's lists of outbound links, file downloads, and not
 * found pages (docs/web-analytics.md, "Links and not found pages").
 */

/** Noon on Tuesday 17 November 2026 in UTC, the instance's timezone. */
const NOW = new Date("2026-11-17T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let projectId = "";
let otherProject = "";

const GITHUB = "https://github.com/acme/widgets";
const DOCS = "https://docs.example.org/guide";
const PDF = "https://shop.example/files/price-list.pdf";

function event(
  name: string,
  visitorId: string,
  minutes: number,
  more: Partial<NewEvent> = {},
): NewEvent {
  return {
    eventId: randomUUID(),
    name,
    occurredAt: minutesAgo(minutes),
    path: "/",
    visitorId,
    client: { browser: "Chrome", browserVersion: "142", os: "macOS", deviceType: "desktop" },
    ...more,
  };
}

const link = (name: string, visitorId: string, minutes: number, url: string) =>
  event(name, visitorId, minutes, { properties: { url, host: new URL(url).hostname } });

function get(path: string, project = projectId) {
  return dashboard.app.inject({
    url: `/api/projects/${project}${path}`,
    headers: { cookie: dashboard.cookie },
  });
}

function addGoal(name: string, step: object) {
  return dashboard.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/goals`,
    headers: { cookie: dashboard.cookie, origin: PUBLIC_URL },
    payload: { name, step },
  });
}

beforeAll(async () => {
  dashboard = await signedInDashboard({ now: () => NOW });
  projectId = (
    await insertProject(dashboard.db, { name: "Links", allowed_hostnames: ["shop.example"] })
  ).id;
  otherProject = (await insertProject(dashboard.db, { name: "Other links" })).id;

  await dashboard.store(projectId, [
    // 1 clicks GitHub twice, downloads the price list, and signs up.
    event("pageview", "1", 200),
    link("outbound_link", "1", 199, GITHUB),
    link("outbound_link", "1", 198, GITHUB),
    link("file_download", "1", 197, PDF),
    event("signup", "1", 196),
    // 2 clicks GitHub and the docs, and leaves.
    event("pageview", "2", 180),
    link("outbound_link", "2", 179, GITHUB),
    link("outbound_link", "2", 178, DOCS),
    // 3 lands on a missing page, and leaves: a bounce.
    event("pageview", "3", 100, { path: "/old-pricing" }),
    event("not_found", "3", 100, { path: "/old-pricing" }),
    // 4 lands on another missing page, then finds the home page.
    event("pageview", "4", 60, { path: "/blog/2019" }),
    event("not_found", "4", 60, { path: "/blog/2019" }),
    event("pageview", "4", 59),
  ]);
  await dashboard.store(otherProject, [
    event("pageview", "1", 200),
    link("outbound_link", "1", 199, "https://elsewhere.example/"),
    event("not_found", "1", 199, { path: "/gone" }),
  ]);
});

afterAll(async () => {
  await dashboard?.close();
});

describe("the lists", () => {
  test("count each link's and page's visitors and events, most visitors first", async () => {
    const body = (await get("/analytics?period=today")).json();
    expect(body.outboundLinks).toEqual([
      { value: GITHUB, visitors: 2, events: 3 },
      { value: DOCS, visitors: 1, events: 1 },
    ]);
    expect(body.fileDownloads).toEqual([{ value: PDF, visitors: 1, events: 1 }]);
    expect(body.notFoundPages).toEqual([
      { value: "/blog/2019", visitors: 1, events: 1 },
      { value: "/old-pricing", visitors: 1, events: 1 },
    ]);
  });

  test("are not custom events; a link click is an interaction, a not found page is not", async () => {
    const body = (await get("/analytics?period=today")).json();
    expect(body.customEvents).toEqual([{ name: "signup", events: 1, visitors: 1 }]);
    // 2 clicked links on one page, so it is no bounce; 3 only saw the missing page.
    expect(body.summary).toMatchObject({ visits: 4, pageviews: 5, bounceRate: 0.25 });
  });

  test("never show another project's events", async () => {
    const body = (await get("/analytics?period=today")).json();
    const values = [...body.outboundLinks, ...body.notFoundPages].map(
      (row: { value: string }) => row.value,
    );
    expect(values).not.toContain("https://elsewhere.example/");
    expect(values).not.toContain("/gone");
    const other = (await get("/analytics?period=today", otherProject)).json();
    expect(other.outboundLinks).toEqual([
      { value: "https://elsewhere.example/", visitors: 1, events: 1 },
    ]);
    expect(other.fileDownloads).toEqual([]);
  });

  test("have full lists with search and paging", async () => {
    const first = (await get("/analytics/list?report=outboundLinks&period=today&limit=1")).json();
    expect(first).toEqual({ rows: [{ value: GITHUB, visitors: 2, events: 3 }], hasMore: true });
    const found = (
      await get("/analytics/list?report=outboundLinks&period=today&search=DOCS.example")
    ).json();
    expect(found).toEqual({ rows: [{ value: DOCS, visitors: 1, events: 1 }], hasMore: false });
    const pages = (await get("/analytics/list?report=notFoundPages&period=today&search=blog"))
      .json()
      .rows.map((row: { value: string }) => row.value);
    expect(pages).toEqual(["/blog/2019"]);
    const files = (await get("/analytics/list?report=fileDownloads&period=today")).json();
    expect(files.rows).toEqual([{ value: PDF, visitors: 1, events: 1 }]);
  });
});

describe("a row's filter", () => {
  test.each([
    ["outbound", GITHUB, 2],
    ["outbound", DOCS, 1],
    ["download", PDF, 1],
    ["notFound", "/old-pricing", 1],
  ])("%s=%s keeps the visits with it", async (name, value, visitors) => {
    const body = (await get(`/analytics?period=today&${name}=${encodeURIComponent(value)}`)).json();
    expect(body.summary.visitors).toBe(visitors);
    // The row's own list shows the row with the same visitors.
    const list =
      name === "outbound"
        ? body.outboundLinks
        : name === "download"
          ? body.fileDownloads
          : body.notFoundPages;
    expect(list.find((row: { value: string }) => row.value === value)?.visitors).toBe(visitors);
  });

  test("of a value nobody has keeps nothing", async () => {
    const body = (
      await get("/analytics?period=today&outbound=https%3A%2F%2Fnone.example%2F")
    ).json();
    expect(body.summary.visitors).toBe(0);
  });
});

describe("goals", () => {
  test("a row shows its converted visitors with a goal", async () => {
    const body = (await get("/analytics?period=today&goalEvent=signup")).json();
    expect(body.outboundLinks).toEqual([
      { value: GITHUB, visitors: 2, events: 3, converted: 1 },
      { value: DOCS, visitors: 1, events: 1, converted: 0 },
    ]);
    expect(body.notFoundPages.map((row: { converted: number }) => row.converted)).toEqual([0, 0]);
    const list = (
      await get("/analytics/list?report=fileDownloads&period=today&goalEvent=signup")
    ).json();
    expect(list.rows).toEqual([{ value: PDF, visitors: 1, events: 1, converted: 1 }]);
  });

  test("a goal can be a click on a link to one host, or on a file", async () => {
    const add = addGoal;
    expect(
      (
        await add("Went to GitHub", {
          type: "event",
          name: "outbound_link",
          filter: { key: "host", value: "github.com" },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await add("Got the price list", {
          type: "event",
          name: "file_download",
          filter: { key: "url", value: "price-list", operator: "contains" },
        })
      ).statusCode,
    ).toBe(201);
    // A not found page is the tracker's own, never a goal.
    expect((await add("Missing", { type: "event", name: "not_found" })).statusCode).toBe(400);

    const goals = (await get("/analytics?period=today")).json().goals;
    expect(
      goals.map(({ name, visitors, events }: Record<string, unknown>) => ({
        name,
        visitors,
        events,
      })),
    ).toEqual([
      { name: "Went to GitHub", visitors: 2, events: 3 },
      { name: "Got the price list", visitors: 1, events: 1 },
    ]);
  });
});
