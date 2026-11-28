import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { NewEvent } from "../src/collection/event-store.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/*
 * The goal filter of the Analytics page (docs/web-analytics.md, "The goal
 * filter"): it adds conversions to every list without narrowing the visits.
 */

/** Noon on Tuesday 17 November 2026 in UTC, the instance's timezone. */
const NOW = new Date("2026-11-17T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let projectId = "";
let otherProject = "";
const goalIds: Record<string, string> = {};
let otherGoalId = "";

function event(
  name: string,
  visitorId: string | undefined,
  minutes: number,
  more: Partial<NewEvent> & { country?: string; device?: "desktop" | "mobile" } = {},
): NewEvent {
  const { country, device = "desktop", ...rest } = more;
  return {
    eventId: randomUUID(),
    name,
    occurredAt: minutesAgo(minutes),
    path: "/",
    ...(visitorId === undefined
      ? {}
      : {
          visitorId,
          client: { browser: "Chrome", browserVersion: "142", os: "macOS", deviceType: device },
          ...(country === undefined ? {} : { location: { country } }),
        }),
    ...rest,
  };
}

function get(path: string, cookie = dashboard.cookie, project = projectId) {
  return dashboard.app.inject({
    url: `/api/projects/${project}${path}`,
    headers: { cookie },
  });
}

async function addGoal(project: string, name: string, step: object): Promise<string> {
  const response = await dashboard.app.inject({
    method: "POST",
    url: `/api/projects/${project}/goals`,
    headers: { cookie: dashboard.cookie, origin: PUBLIC_URL },
    payload: { name, step },
  });
  expect(response.statusCode).toBe(201);
  return response.json().goal.id;
}

const DE = { country: "DE" };
const US = { country: "US", device: "mobile" as const };

beforeAll(async () => {
  dashboard = await signedInDashboard({ now: () => NOW });
  projectId = (
    await insertProject(dashboard.db, { name: "Goal filter", allowed_hostnames: ["shop.example"] })
  ).id;
  otherProject = (await insertProject(dashboard.db, { name: "Other" })).id;

  await dashboard.store(projectId, [
    // 1 comes from a search and signs up for a team on the second page.
    event("pageview", "1", 200, { ...DE, referrer: "https://www.google.com/search" }),
    event("pageview", "1", 197, { ...DE, path: "/pricing", referrer: "https://shop.example/" }),
    event("signup", "1", 195, { ...DE, path: "/pricing", properties: { plan: "team" } }),
    // 2 comes from a newsletter, reads pricing, and leaves.
    event("pageview", "2", 180, { ...US, utm: { source: "newsletter" } }),
    event("pageview", "2", 178, { ...US, path: "/pricing" }),
    // 3 comes from a forum and leaves, then over 30 minutes later types the
    // address, reads the docs, and signs up: in the second visit only.
    event("pageview", "3", 300, { ...DE, referrer: "https://news.ycombinator.com/item" }),
    event("pageview", "3", 100, { ...DE, path: "/docs/intro" }),
    event("signup", "3", 95, { ...DE, path: "/docs/intro", properties: { plan: "free" } }),
    // 4 types the address and signs up on the home page.
    event("pageview", "4", 60, US),
    event("signup", "4", 58, { ...US, properties: { plan: "free" } }),
    // A server's signup: a user, no visitor ID, so no conversion.
    event("signup", undefined, 50, { userId: "server-user" }),
  ]);
  await dashboard.store(otherProject, [
    event("pageview", "1", 200, { referrer: "https://bing.com/" }),
    event("signup", "1", 199),
  ]);

  goalIds.signedUp = await addGoal(projectId, "Signed up", { type: "event", name: "signup" });
  goalIds.team = await addGoal(projectId, "Team signup", {
    type: "event",
    name: "signup",
    filter: { key: "plan", value: "team" },
  });
  goalIds.docs = await addGoal(projectId, "Read the docs", { type: "page", path: "/docs/*" });
  otherGoalId = await addGoal(otherProject, "Signed up", { type: "event", name: "signup" });
});

afterAll(async () => {
  await dashboard?.close();
});

interface Row {
  value: string | null;
  visitors: number;
  converted?: number;
}

const counts = (rows: Row[]) =>
  rows.map(({ value, visitors, converted }) => ({ value, visitors, converted }));

describe("a saved goal on the Analytics page", () => {
  test("adds converted visitors, events, and the rate, and leaves the visits as they are", async () => {
    const plain = (await get("/analytics?period=today")).json();
    const body = (await get(`/analytics?period=today&goal=${goalIds.signedUp}`)).json();
    expect(body.summary).toEqual(plain.summary);
    expect(body.summary.visitors).toBe(4);
    // The server's signup has no visitor: not counted.
    expect(body.goal).toEqual({
      id: goalIds.signedUp,
      name: "Signed up",
      step: { type: "event", name: "signup" },
      converted: 3,
      events: 3,
      conversionRate: 0.75,
      previous: { converted: 0, events: 0 },
    });
    // Today goes by the hour: the goal events of all its hours.
    const converted = body.chart.map((point: { converted: number }) => point.converted);
    expect(converted.reduce((sum: number, value: number) => sum + value, 0)).toBe(3);
    expect(plain.goal).toBeNull();
    expect(plain.chart.at(-1).converted).toBeUndefined();
  });

  test("counts a visit-level row's visitors whose visit of that value reached it", async () => {
    const body = (await get(`/analytics?period=today&goal=${goalIds.signedUp}`)).json();
    // 3 signed up in the direct visit, not the forum's.
    expect(counts(body.breakdowns.source)).toEqual([
      { value: "Direct / none", visitors: 2, converted: 2 },
      { value: "google.com", visitors: 1, converted: 1 },
      { value: "news.ycombinator.com", visitors: 1, converted: 0 },
      { value: "newsletter", visitors: 1, converted: 0 },
    ]);
    expect(counts(body.breakdowns.country)).toEqual([
      { value: "DE", visitors: 2, converted: 2 },
      { value: "US", visitors: 2, converted: 1 },
    ]);
    expect(counts(body.breakdowns.entryPage)).toEqual([
      { value: "/", visitors: 4, converted: 2 },
      { value: "/docs/intro", visitors: 1, converted: 1 },
    ]);
    expect(counts(body.breakdowns.deviceType)).toEqual([
      { value: "desktop", visitors: 2, converted: 2 },
      { value: "mobile", visitors: 2, converted: 1 },
    ]);
  });

  test("counts a page's visitors who viewed it in a visit that reached it", async () => {
    const body = (await get(`/analytics?period=today&goal=${goalIds.signedUp}`)).json();
    // 3 viewed the home page in the forum's visit, which did not convert.
    expect(
      body.pages.map(({ path, visitors, converted }: Record<string, unknown>) => ({
        path,
        visitors,
        converted,
      })),
    ).toEqual([
      { path: "/", visitors: 4, converted: 2 },
      { path: "/pricing", visitors: 2, converted: 1 },
      { path: "/docs/intro", visitors: 1, converted: 1 },
    ]);
  });

  test("gives each row what the Goals table shows when the page is filtered by it", async () => {
    const body = (await get(`/analytics?period=today&goal=${goalIds.signedUp}`)).json();
    const checks = [
      ...body.breakdowns.source.map((row: Row) => ["source", row.value, row.converted]),
      ...body.breakdowns.country.map((row: Row) => ["country", row.value, row.converted]),
      ...body.pages.map((row: { path: string; converted: number }) => [
        "page",
        row.path,
        row.converted,
      ]),
    ];
    for (const [name, value, converted] of checks) {
      const filtered = (
        await get(`/analytics?period=today&${name}=${encodeURIComponent(value ?? "")}`)
      ).json();
      const goal = filtered.goals.find((item: { name: string }) => item.name === "Signed up");
      expect({ name, value, converted: goal.visitors }).toEqual({ name, value, converted });
    }
  });

  test("matches a property filter and a path pattern as the Goals table does", async () => {
    const team = (await get(`/analytics?period=today&goal=${goalIds.team}`)).json();
    expect(team.goal).toMatchObject({ converted: 1, events: 1, conversionRate: 0.25 });
    expect(counts(team.breakdowns.source).slice(0, 2)).toEqual([
      { value: "google.com", visitors: 1, converted: 1 },
      { value: "Direct / none", visitors: 2, converted: 0 },
    ]);
    const docs = (await get(`/analytics?period=today&goal=${goalIds.docs}`)).json();
    expect(docs.goal).toMatchObject({ converted: 1, events: 1 });
    expect(counts(docs.breakdowns.source)[0]).toEqual({
      value: "Direct / none",
      visitors: 2,
      converted: 1,
    });
    const table = (await get("/analytics?period=today")).json().goals;
    expect(table.map((goal: { visitors: number }) => goal.visitors)).toEqual([3, 1, 1]);
  });

  test("stacks with the other filters, which narrow the visits", async () => {
    const body = (await get(`/analytics?period=today&country=US&goal=${goalIds.signedUp}`)).json();
    expect(body.summary.visitors).toBe(2);
    expect(body.goal).toMatchObject({ converted: 1, conversionRate: 0.5 });
    expect(counts(body.breakdowns.source)).toEqual([
      { value: "Direct / none", visitors: 1, converted: 1 },
      { value: "newsletter", visitors: 1, converted: 0 },
    ]);
  });

  test("applies to a full list, and leaves custom events as they are", async () => {
    const list = (
      await get(`/analytics/list?report=country&period=today&goal=${goalIds.signedUp}`)
    ).json();
    expect(counts(list.rows)).toEqual([
      { value: "DE", visitors: 2, converted: 2 },
      { value: "US", visitors: 2, converted: 1 },
    ]);
    const pages = (
      await get(`/analytics/list?report=pages&period=today&limit=1&goal=${goalIds.signedUp}`)
    ).json();
    expect(pages).toMatchObject({ rows: [{ path: "/", converted: 2 }], hasMore: true });
    const events = (
      await get(`/analytics/list?report=customEvents&period=today&goal=${goalIds.signedUp}`)
    ).json();
    expect(events.rows).toEqual([{ name: "signup", events: 3, visitors: 3 }]);
  });
});

describe("Unknown", () => {
  test("comes last in every list, with or without a goal, though it has the most", async () => {
    const project = (await insertProject(dashboard.db, { name: "Unknown last" })).id;
    await dashboard.store(project, [
      // Three visitors without a location or a browser sign up; one from Germany only looks.
      ...["7", "8", "9"].flatMap((visitor) => [
        event("pageview", undefined, 90, { visitorId: visitor }),
        event("signup", undefined, 85, { visitorId: visitor }),
      ]),
      event("pageview", "10", 80, DE),
    ]);
    for (const goal of ["", "&goalEvent=signup"]) {
      const body = (await get(`/analytics?period=today${goal}`, dashboard.cookie, project)).json();
      for (const list of ["country", "browser", "deviceType", "region", "city", "release"]) {
        const values = body.breakdowns[list].map((row: Row) => row.value);
        expect({
          goal,
          list,
          last: values.at(-1),
          unknowns: values.filter((v: unknown) => v === null).length,
        }).toEqual({ goal, list, last: null, unknowns: 1 });
        expect(values.length).toBe(["region", "city", "release"].includes(list) ? 1 : 2);
      }
      const full = (
        await get(`/analytics/list?report=country&period=today${goal}`, dashboard.cookie, project)
      ).json();
      expect(full.rows.map((row: Row) => row.value)).toEqual(["DE", null]);
    }
    const lists = (
      await get("/events/signup/breakdowns?period=today", dashboard.cookie, project)
    ).json();
    expect(lists.country.map((row: Row) => row.value)).toEqual([null]);
  });
});

describe("a custom event as the goal", () => {
  test("counts as a goal of that event by name", async () => {
    const saved = (await get(`/analytics?period=today&goal=${goalIds.signedUp}`)).json();
    const adHoc = (await get("/analytics?period=today&goalEvent=signup")).json();
    expect(adHoc.goal).toEqual({ ...saved.goal, id: null, name: "signup" });
    expect(adHoc.breakdowns).toEqual(saved.breakdowns);
    expect(adHoc.pages).toEqual(saved.pages);
  });

  test("needs only web analytics, while a saved goal needs product analytics", async () => {
    const member = await signedInUser(dashboard, {
      name: "Web only",
      email: "web-only@example.com",
      grants: { projects: [projectId], areas: { web_analytics: "view" } },
    });
    const adHoc = await get("/analytics?period=today&goalEvent=signup", member.cookie);
    expect(adHoc.statusCode).toBe(200);
    expect(adHoc.json()).toMatchObject({ goal: { converted: 3 }, goals: [] });
    const saved = await get(`/analytics?period=today&goal=${goalIds.signedUp}`, member.cookie);
    expect([saved.statusCode, saved.json().error]).toEqual([403, "forbidden"]);
  });
});

describe("the goal parameters", () => {
  test("refuse another project's goal, an unknown one, and a malformed one", async () => {
    for (const [query, status, error] of [
      [`goal=${otherGoalId}`, 400, "unknown_goal"],
      [`goal=${randomUUID()}`, 400, "unknown_goal"],
      ["goal=signup", 400, "FST_ERR_VALIDATION"],
      ["goalEvent=", 400, "FST_ERR_VALIDATION"],
      ["goalEvent=a%09b", 400, "FST_ERR_VALIDATION"],
      [`goalEvent=${"x".repeat(201)}`, 400, "FST_ERR_VALIDATION"],
      ["goalEvent=pageview", 400, "invalid_goal"],
      ["goalEvent=engagement", 400, "invalid_goal"],
      [`goal=${goalIds.signedUp}&goalEvent=signup`, 400, "invalid_goal"],
    ] as const) {
      for (const path of ["/analytics", "/analytics/list"]) {
        const response = await get(
          `${path}?period=today&report=source&${query}`.replace(
            "/analytics?period=today&report=source",
            "/analytics?period=today",
          ),
        );
        const body = response.json();
        expect({
          path,
          query,
          status: response.statusCode,
          error: body.code ?? body.error,
        }).toEqual({ path, query, status, error });
      }
    }
  });

  test("count only the project's own events", async () => {
    const body = (
      await get(`/analytics?period=today&goal=${otherGoalId}`, dashboard.cookie, otherProject)
    ).json();
    expect(body.goal).toMatchObject({ converted: 1, events: 1, conversionRate: 1 });
    expect(counts(body.breakdowns.source)).toEqual([
      { value: "bing.com", visitors: 1, converted: 1 },
    ]);
  });
});
