import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { NewEvent } from "../src/collection/event-store.ts";
import { PUBLIC_URL, signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/*
 * Custom events and funnels credited to their visit's source and campaign
 * (docs/product-analytics.md, "Source and campaign"): the referrer and UTM
 * tags of the visit's first page, as the Analytics page counts them.
 */

/** Noon on Tuesday 17 November 2026 in UTC, the instance's timezone. */
const NOW = new Date("2026-11-17T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let projectId = "";
let otherProject = "";

function event(
  name: string,
  visitorId: string | undefined,
  minutes: number,
  more: Partial<NewEvent> = {},
): NewEvent {
  return {
    eventId: randomUUID(),
    name,
    occurredAt: minutesAgo(minutes),
    path: "/",
    ...(visitorId === undefined ? {} : { visitorId }),
    ...more,
  };
}

function get(project: string, path: string) {
  return dashboard.app.inject({
    url: `/api/projects/${project}${path}`,
    headers: { cookie: dashboard.cookie },
  });
}

const SIGNUP_PURCHASE = [
  { type: "event", name: "signup" },
  { type: "event", name: "purchase" },
];
const query = (rest: string) =>
  `?steps=${encodeURIComponent(JSON.stringify(SIGNUP_PURCHASE))}&period=today&window=3600${rest}`;

beforeAll(async () => {
  dashboard = await signedInDashboard({ now: () => NOW });
  projectId = (
    await insertProject(dashboard.db, { name: "Sources", allowed_hostnames: ["shop.example"] })
  ).id;
  otherProject = (await insertProject(dashboard.db, { name: "Other" })).id;

  await dashboard.store(projectId, [
    // 1 comes from a search, then signs up and buys on the second page,
    // whose own referrer is the site itself.
    event("pageview", "1", 200, { referrer: "https://www.google.com/search?q=shop" }),
    event("pageview", "1", 196, { path: "/waitlist", referrer: "https://shop.example/" }),
    event("signup", "1", 195, { path: "/waitlist", referrer: "https://shop.example/" }),
    event("purchase", "1", 190, { path: "/waitlist", referrer: "https://shop.example/" }),
    // 2 comes from a tagged newsletter link; the second page has no tags.
    event("pageview", "2", 180, {
      utm: { source: "newsletter", medium: "email", campaign: "launch" },
      userId: "u2",
    }),
    event("pageview", "2", 176, { path: "/pricing", userId: "u2" }),
    event("signup", "2", 175, { path: "/pricing", userId: "u2" }),
    // 3 types the address.
    event("pageview", "3", 170),
    event("signup", "3", 165),
    // 4 came from a forum earlier, then again over 30 minutes later by
    // typing the address: the signup is in the second visit.
    event("pageview", "4", 300, { referrer: "https://news.ycombinator.com/item" }),
    event("pageview", "4", 100),
    event("signup", "4", 95),
    // A server's signup: a user, no visitor ID, no visit.
    event("signup", undefined, 50, { userId: "server-user" }),
  ]);

  // The same visitor ID in another project, with another source.
  await dashboard.store(otherProject, [
    event("pageview", "1", 200, { referrer: "https://bing.com/" }),
    event("signup", "1", 199),
  ]);
});

afterAll(async () => {
  await dashboard?.close();
});

describe("GET /api/projects/:id/funnel/breakdown by source and campaign", () => {
  test("credits step 1 on a visit's later page to the visit's source", async () => {
    const response = await get(projectId, `/funnel/breakdown${query("&by=source")}`);
    expect(response.statusCode).toBe(200);
    expect(response.json().rows).toEqual([
      { kind: "value", value: "Direct / none", reached: [2, 0] },
      { kind: "value", value: "google.com", reached: [1, 1] },
      { kind: "value", value: "newsletter", reached: [1, 0] },
    ]);
  });

  test("credits it to the visit's campaign, with No campaign as a value", async () => {
    const rows = (await get(projectId, `/funnel/breakdown${query("&by=utmCampaign")}`)).json().rows;
    expect(rows).toEqual([
      { kind: "value", value: "", reached: [3, 1] },
      { kind: "value", value: "launch", reached: [1, 0] },
    ]);
  });

  test("puts a step 1 without a visit, such as a server's, under Unknown", async () => {
    const rows = (
      await get(projectId, `/funnel/breakdown${query("&count=users&by=source")}`)
    ).json().rows;
    expect(rows).toEqual([
      { kind: "value", value: "newsletter", reached: [1, 0] },
      { kind: "unknown", value: null, reached: [1, 0] },
    ]);
  });

  test("names sources as the Analytics page's Sources list does", async () => {
    const funnel = (await get(projectId, `/funnel/breakdown${query("&by=source")}`)).json();
    const sources = (await get(projectId, "/analytics/list?report=source&period=today")).json();
    const listed = sources.rows.map((row: { value: string }) => row.value);
    for (const row of funnel.rows) expect(listed).toContain(row.value);
  });

  test("reads only the project's own visits", async () => {
    const rows = (await get(otherProject, `/funnel/breakdown${query("&by=source")}`)).json().rows;
    expect(rows).toEqual([{ kind: "value", value: "bing.com", reached: [1, 0] }]);
  });

  test("refuses the medium, which the Analytics page does not list", async () => {
    expect((await get(projectId, `/funnel/breakdown${query("&by=utmMedium")}`)).statusCode).toBe(
      400,
    );
  });
});

describe("GET /api/projects/:id/events/:name/breakdowns", () => {
  test("counts the events by their visit's source and campaign, without a visit as null", async () => {
    const response = await get(projectId, "/events/signup/breakdowns?period=today");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.source).toEqual([
      { value: "Direct / none", visitors: 2, events: 2 },
      { value: "google.com", visitors: 1, events: 1 },
      { value: "newsletter", visitors: 1, events: 1 },
      { value: null, visitors: 0, events: 1 },
    ]);
    expect(body.utmCampaign).toEqual([
      { value: "", visitors: 3, events: 3 },
      { value: "launch", visitors: 1, events: 1 },
      { value: null, visitors: 0, events: 1 },
    ]);
    // The events' own location and device: none recorded here.
    expect(body.country).toEqual([{ value: null, visitors: 4, events: 5 }]);
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining(["region", "city", "deviceType", "browser", "os", "release"]),
    );
  });

  test("applies the page's property filters, and refuses a bad one", async () => {
    const none = (
      await get(projectId, "/events/signup/breakdowns?period=today&p.plan=team")
    ).json();
    expect(none).toMatchObject({ source: [], utmCampaign: [], filters: [{ key: "plan" }] });
    expect((await get(projectId, "/events/signup/breakdowns?period=today&p.=x")).statusCode).toBe(
      400,
    );
  });

  test("narrows the event's page to a visit's source, its lists and totals alike", async () => {
    const lists = (
      await get(projectId, "/events/signup/breakdowns?period=today&source=google.com")
    ).json();
    expect(lists.source).toEqual([{ value: "google.com", visitors: 1, events: 1 }]);
    const detail = (await get(projectId, "/events/signup?period=today&source=google.com")).json();
    expect(detail).toMatchObject({ events: 1, visitors: 1 });
    expect(detail.days.at(-1)).toEqual({ day: "2026-11-17", events: 1 });
    // "" is unknown, as on the Analytics page: here, the server's event without a visit.
    const unknown = (await get(projectId, "/events/signup?period=today&source=")).json();
    expect(unknown).toMatchObject({ events: 1, visitors: 0, users: 1 });
    // A visit without a campaign.
    const noCampaign = (await get(projectId, "/events/signup?period=today&utmCampaign=")).json();
    expect(noCampaign).toMatchObject({ events: 3, visitors: 3 });
  });

  test("narrows by the event's own columns, and refuses a NUL", async () => {
    const located = (await get(projectId, "/events/signup?period=today&country=DE")).json();
    expect(located).toMatchObject({ events: 0 });
    const unknown = (await get(projectId, "/events/signup?period=today&country=")).json();
    expect(unknown).toMatchObject({ events: 5 });
    expect((await get(projectId, "/events/signup?period=today&country=%00")).statusCode).toBe(400);
  });

  test("reads only the project's own events", async () => {
    const body = (await get(otherProject, "/events/signup/breakdowns?period=today")).json();
    expect(body.source).toEqual([{ value: "bing.com", visitors: 1, events: 1 }]);
  });
});

describe("goals on the Analytics page filtered by a source", () => {
  test("count only the conversions of that source's visits, wherever in the visit", async () => {
    const added = await dashboard.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/goals`,
      headers: { cookie: dashboard.cookie, origin: PUBLIC_URL },
      payload: { name: "Signed up", step: { type: "event", name: "signup" } },
    });
    expect(added.statusCode).toBe(201);
    const body = (await get(projectId, "/analytics?period=today&source=google.com")).json();
    expect(body.goals).toMatchObject([{ name: "Signed up", visitors: 1, events: 1 }]);
  });
});
