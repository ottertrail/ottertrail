import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { NewEvent } from "../src/collection/event-store.ts";
import { previousReadEnd } from "../src/product/funnel.ts";
import { averageOf } from "../src/product/retention.ts";
import { parseSteps } from "../src/product/routes.ts";
import { type Step, stepsOverlap } from "../src/product/steps.ts";
import { PUBLIC_URL, signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/** Noon on Tuesday 17 November 2026 in UTC, the instance's timezone. */
const NOW = new Date("2026-11-17T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const at = (iso: string) => new Date(iso);

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let funnelProject = "";
let retentionProject = "";
let compareProject = "";
let savedProject = "";
let otherProject = "";

function event(name: string, visitorId: string, occurredAt: Date, more: Partial<NewEvent> = {}) {
  return { eventId: randomUUID(), name, occurredAt, path: "/", visitorId, ...more };
}
const pricing = (visitorId: string, occurredAt: Date, more: Partial<NewEvent> = {}) =>
  event("pageview", visitorId, occurredAt, { path: "/pricing", ...more });

function get(projectId: string, path: string) {
  return dashboard.app.inject({
    url: `/api/projects/${projectId}${path}`,
    headers: { cookie: dashboard.cookie },
  });
}

/** The funnel's address: its steps as JSON. */
const funnelQuery = (steps: unknown[], rest = "") =>
  `/funnel?steps=${encodeURIComponent(JSON.stringify(steps))}${rest}`;

const reachedOf = (body: { steps: { reached: number }[] }) =>
  body.steps.map((step) => step.reached);

/** Saves a funnel as the dashboard does, or throws. */
async function save(projectId: string, name: string, steps: unknown[]) {
  const response = await dashboard.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/funnels`,
    headers: { cookie: dashboard.cookie, origin: PUBLIC_URL },
    payload: { name, steps, count: "visitors", window: 3600 },
  });
  if (response.statusCode !== 201) throw new Error(`saving ${name}: ${response.body}`);
}

/** A funnel's status and error code over the last 7 days. */
async function status(steps: unknown[]) {
  const response = await get(funnelProject, funnelQuery(steps, "&period=7d"));
  return [response.statusCode, response.json().error];
}

const PRICING_SIGNUP_INVITE = [
  { type: "page", path: "/pricing" },
  { type: "event", name: "signup" },
  { type: "event", name: "invite" },
];

beforeAll(async () => {
  dashboard = await signedInDashboard({ now: () => NOW });
  const insert = async (name: string) => (await insertProject(dashboard.db, { name })).id;
  funnelProject = await insert("Funnel");
  retentionProject = await insert("Retention");
  compareProject = await insert("Compare");
  savedProject = await insert("Saved");
  otherProject = await insert("Other");

  await dashboard.store(compareProject, [
    // Today, up to noon: 11 converts, 12 does not.
    pricing("11", at("2026-11-17T09:00:00Z")),
    event("signup", "11", at("2026-11-17T09:10:00Z")),
    pricing("12", at("2026-11-17T10:00:00Z")),
    // Yesterday: 21 converts, 22 does not.
    pricing("21", at("2026-11-16T08:00:00Z")),
    event("signup", "21", at("2026-11-16T08:20:00Z")),
    pricing("22", at("2026-11-16T09:00:00Z")),
    // 23 starts before noon yesterday, and signs up after it.
    pricing("23", at("2026-11-16T11:50:00Z")),
    event("signup", "23", at("2026-11-16T12:10:00Z")),
    // 24 starts after noon yesterday.
    pricing("24", at("2026-11-16T13:00:00Z")),
  ]);

  await dashboard.store(funnelProject, [
    // 1: all three steps, within the hour.
    pricing("1", minutesAgo(300)),
    event("signup", "1", minutesAgo(250), { properties: { plan: "team" } }),
    event("invite", "1", minutesAgo(245)),
    // 2: pricing, then a free signup ten minutes later.
    pricing("2", minutesAgo(300)),
    event("signup", "2", minutesAgo(290), { properties: { plan: "free" } }),
    // 3: signed up first, saw pricing after: only step 1, in order.
    event("signup", "3", minutesAgo(240)),
    pricing("3", minutesAgo(180)),
    // 4: pricing only.
    pricing("4", minutesAgo(120)),
    // 5: pricing yesterday, before the range: no funnel starts.
    pricing("5", at("2026-11-16T23:50:00Z")),
    event("signup", "5", at("2026-11-17T00:10:00Z")),
    // 6: signup twenty minutes after pricing, on /plans.
    event("pageview", "6", minutesAgo(100), { path: "/plans" }),
    event("signup", "6", minutesAgo(80)),
    // Ada: pricing two days ago, signup a day later, from another visitor ID.
    pricing("7", at("2026-11-15T10:00:00Z"), { userId: "ada" }),
    event("signup", "8", at("2026-11-16T10:00:00Z"), { userId: "ada" }),
  ]);

  await dashboard.store(retentionProject, [
    // Ada: first seen the week of 2 November, back in the next two weeks.
    event("signup", "1", at("2026-11-02T09:00:00Z"), { userId: "ada" }),
    event("pageview", "1", at("2026-11-10T09:00:00Z"), { userId: "ada" }),
    event("invite", "1", at("2026-11-17T09:00:00Z"), { userId: "ada" }),
    // Bob: first seen that week too; later only time on page and Web Vitals.
    event("signup", "2", at("2026-11-03T09:00:00Z"), { userId: "bob" }),
    event("engagement", "2", at("2026-11-11T09:00:00Z"), {
      userId: "bob",
      properties: { engagedMs: 5000 },
    }),
    event("vitals", "2", at("2026-11-11T09:00:00Z"), { userId: "bob", properties: { lcp: 900 } }),
    // Cy: first seen the week of 9 November, back this week.
    event("signup", "3", at("2026-11-10T09:00:00Z"), { userId: "cy" }),
    event("pageview", "3", at("2026-11-17T08:00:00Z"), { userId: "cy" }),
    // Dee: first seen in September, before the range, active again since.
    event("signup", "4", at("2026-09-30T09:00:00Z"), { userId: "dee" }),
    event("pageview", "4", at("2026-11-04T09:00:00Z"), { userId: "dee" }),
    // Anonymous: never in retention.
    event("signup", "5", at("2026-11-04T09:00:00Z")),
  ]);
});

afterAll(async () => {
  await dashboard?.close();
});

describe("GET /api/projects/:id/funnel", () => {
  test("follows each visitor through the steps in order, within the window", async () => {
    const response = await get(
      funnelProject,
      funnelQuery(PRICING_SIGNUP_INVITE, "&period=today&window=3600"),
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      count: "visitors",
      window: 3600,
      firstDay: "2026-11-17",
      environments: ["production"],
    });
    expect(body.steps.map((step: { reached: number }) => step.reached)).toEqual([4, 2, 1]);
    expect(body.steps[0].step).toEqual({ type: "page", path: "/pricing" });
  });

  test("filters a step by a property", async () => {
    const steps = [
      { type: "page", path: "/pricing" },
      { type: "event", name: "signup", filter: { key: "plan", value: "team" } },
    ];
    const body = (await get(funnelProject, funnelQuery(steps, "&period=today"))).json();
    expect(body.steps.map((step: { reached: number }) => step.reached)).toEqual([4, 1]);
  });

  test("counts only steps within the window", async () => {
    const steps = [
      { type: "page", path: "/plans" },
      { type: "event", name: "signup" },
    ];
    const reached = async (window: number) =>
      (await get(funnelProject, funnelQuery(steps, `&period=today&window=${window}`)))
        .json()
        .steps.map((step: { reached: number }) => step.reached);
    expect(await reached(300)).toEqual([1, 0]);
    expect(await reached(1800)).toEqual([1, 1]);
  });

  test("follows a signed-in user across days and visitor IDs", async () => {
    const steps = PRICING_SIGNUP_INVITE.slice(0, 2);
    const byVisitors = (await get(funnelProject, funnelQuery(steps, "&period=7d"))).json();
    const byUsers = (
      await get(funnelProject, funnelQuery(steps, "&period=7d&count=users&window=604800"))
    ).json();
    // Ada's two days are two visitors, each with half the funnel: 1, 2, and
    // 5 convert (5's ID stays the same over midnight here, unlike a real one).
    expect(byUsers.steps.map((step: { reached: number }) => step.reached)).toEqual([1, 1]);
    expect(byVisitors.steps[1].reached).toBe(3);
  });

  test("refuses bad steps, and a window over a day for visitors", async () => {
    for (const steps of [
      "not json",
      JSON.stringify([{ type: "page", path: "/one" }]),
      JSON.stringify(Array.from({ length: 9 }, () => ({ type: "page", path: "/" }))),
      JSON.stringify([
        { type: "page", path: "pricing" },
        { type: "page", path: "/" },
      ]),
      JSON.stringify([
        { type: "event", name: "" },
        { type: "page", path: "/" },
      ]),
      // The tracker's own event: never a product event, so never a step.
      JSON.stringify([
        { type: "event", name: "pageview" },
        { type: "page", path: "/" },
      ]),
      JSON.stringify([
        { type: "event", name: "a", filter: { key: "" } },
        { type: "page", path: "/" },
      ]),
    ]) {
      const response = await get(
        funnelProject,
        `/funnel?steps=${encodeURIComponent(steps)}&period=7d`,
      );
      expect({ steps, status: response.statusCode }).toEqual({ steps, status: 400 });
    }
    const tooLong = await get(
      funnelProject,
      funnelQuery(PRICING_SIGNUP_INVITE, "&period=7d&window=604800"),
    );
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error).toBe("invalid_window");
  });

  test("refuses two steps in a row that one event could both be", async () => {
    const page = { type: "page", path: "/pricing" };
    const signup = { type: "event", name: "signup" };
    const team = { ...signup, filter: { key: "plan", value: "team" } };
    const free = { ...signup, filter: { key: "plan", value: "free" } };
    expect(await status([page, page])).toEqual([400, "steps_overlap"]);
    expect(await status([signup, team])).toEqual([400, "steps_overlap"]);
    expect(await status([team, { ...signup, filter: { key: "seats", value: "5" } }])).toEqual([
      400,
      "steps_overlap",
    ]);
    // Apart: different values of one property, or another step between.
    expect((await status([team, free]))[0]).toBe(200);
    expect((await status([page, signup, page]))[0]).toBe(200);
  });

  test("refuses a page step over 500 characters", async () => {
    const steps = [
      { type: "page", path: `/${"a".repeat(500)}` },
      { type: "event", name: "signup" },
    ];
    expect((await get(funnelProject, funnelQuery(steps, "&period=7d"))).statusCode).toBe(400);
  });

  test("reads steps as the dashboard writes them", () => {
    expect(
      parseSteps(
        JSON.stringify([
          { type: "event", name: "signup", filter: { key: "plan", value: "team" } },
          { type: "page", path: "/welcome" },
        ]),
      ),
    ).toEqual([
      { type: "event", name: "signup", filter: { key: "plan", value: "team" } },
      { type: "page", path: "/welcome" },
    ]);
  });
});

describe("the funnel's period before", () => {
  const steps = PRICING_SIGNUP_INVITE.slice(0, 2);

  test("compares a running day with the day before, up to the same time", async () => {
    const response = await get(compareProject, funnelQuery(steps, "&period=today"));
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(reachedOf(body)).toEqual([2, 1]);
    // 21, 22, and 23 started before noon, and only 21 signed up before noon.
    expect(body.previous).toEqual({
      firstDay: "2026-11-16",
      lastDay: "2026-11-16",
      until: "2026-11-16T12:00:00.000Z",
      reached: [3, 1],
    });
  });

  test("compares a whole day with the whole day before", async () => {
    const body = (
      await get(compareProject, funnelQuery(steps, "&from=2026-11-16&to=2026-11-16"))
    ).json();
    expect(reachedOf(body)).toEqual([4, 2]);
    expect(body.previous).toEqual({
      firstDay: "2026-11-15",
      lastDay: "2026-11-15",
      until: null,
      reached: [0, 0],
    });
  });

  test("answers zeros when the period before has no data", async () => {
    const body = (
      await get(funnelProject, funnelQuery(PRICING_SIGNUP_INVITE, "&period=7d"))
    ).json();
    expect(body.previous).toMatchObject({
      firstDay: "2026-11-04",
      lastDay: "2026-11-10",
      reached: [0, 0, 0],
    });
  });

  test("stops reading the period before where this one stops", () => {
    const day = 86_400_000;
    const range = { from: at("2026-11-16T00:00:00Z"), to: at("2026-11-17T00:00:00Z") };
    const previous = { from: at("2026-11-15T00:00:00Z"), to: at("2026-11-16T00:00:00Z") };
    // A one-day window from yesterday is cut at now, so the day before is cut a day earlier.
    expect(previousReadEnd(range, previous, 86_400, NOW)).toEqual(new Date(NOW.getTime() - day));
    // A five-minute window ends before now: both read five minutes past their end.
    expect(previousReadEnd(range, previous, 300, NOW)).toEqual(at("2026-11-16T00:05:00Z"));
  });
});

describe("GET /api/projects/:id/funnels/results", () => {
  beforeAll(async () => {
    await dashboard.store(savedProject, [
      pricing("31", minutesAgo(60)),
      event("signup", "31", minutesAgo(50)),
      pricing("32", minutesAgo(40)),
      pricing("33", minutesAgo(40), { environment: "staging" }),
    ]);
    // Another project: the same visitor, and a saved funnel of its own.
    await dashboard.store(otherProject, [
      pricing("32", minutesAgo(30)),
      event("signup", "32", minutesAgo(20)),
    ]);
    const two = PRICING_SIGNUP_INVITE.slice(0, 2);
    await save(savedProject, "Signup", two);
    await save(savedProject, "Invite", PRICING_SIGNUP_INVITE);
    await save(otherProject, "Elsewhere", two);
  });

  test("counts only the project's own funnels and events", async () => {
    const body = (await get(otherProject, "/funnels/results?period=today")).json();
    expect(
      body.funnels.map((item: { steps: { reached: number }[] }) =>
        item.steps.map((step) => step.reached),
      ),
    ).toEqual([[1, 1]]);
  });

  test("counts every saved funnel of the project, for the period and environment", async () => {
    const response = await get(savedProject, "/funnels/results?period=today");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      environment: "production",
      firstDay: "2026-11-17",
      lastDay: "2026-11-17",
    });
    const byName = new Map(
      (await get(savedProject, "/funnels"))
        .json()
        .funnels.map((item: { id: string; name: string }) => [item.id, item.name]),
    );
    expect(
      body.funnels.map(
        (item: { id: string; count: string; window: number; steps: { reached: number }[] }) => ({
          name: byName.get(item.id),
          count: item.count,
          window: item.window,
          reached: item.steps.map((step) => step.reached),
        }),
      ),
    ).toEqual([
      // By name, as the list is.
      { name: "Invite", count: "visitors", window: 3600, reached: [2, 1, 0] },
      { name: "Signup", count: "visitors", window: 3600, reached: [2, 1] },
    ]);
    const staging = (
      await get(savedProject, "/funnels/results?period=today&environment=staging")
    ).json();
    expect(
      staging.funnels.map((item: { steps: { reached: number }[] }) =>
        item.steps.map((step) => step.reached),
      ),
    ).toEqual([
      [1, 0, 0],
      [1, 0],
    ]);
  });

  test("answers an empty list for a project without saved funnels", async () => {
    const body = (await get(compareProject, "/funnels/results?period=7d")).json();
    expect(body.funnels).toEqual([]);
  });

  test("refuses a bad period", async () => {
    for (const query of [
      "period=year",
      "period=7d&from=2026-11-01&to=2026-11-02",
      "from=2026-11-01",
      "environment=%20",
    ]) {
      const response = await get(savedProject, `/funnels/results?${query}`);
      expect({ query, status: response.statusCode }).toEqual({ query, status: 400 });
    }
  });
});

const pageStep = (path: string): Step => ({ type: "page", path });
const pagesOverlap = (a: string, b: string) => stepsOverlap(pageStep(a), pageStep(b));
const signupWhere = (filter?: object) =>
  ({ type: "event", name: "signup", ...(filter === undefined ? {} : { filter }) }) as Step;
const planIs = (value: string, operator?: "notEquals" | "contains") =>
  signupWhere({ key: "plan", value, ...(operator === undefined ? {} : { operator }) });

describe("steps that match more than one exact thing", () => {
  let matchProject = "";
  let longProject = "";
  /** Each step 1 alone: a funnel with a step nobody did after it. */
  const firstStep = async (step: unknown) => {
    const response = await get(
      matchProject,
      funnelQuery([step, { type: "event", name: "never" }], "&period=today"),
    );
    expect(response.statusCode).toBe(200);
    return response.json().steps[0].reached;
  };
  const EIGHT = Array.from({ length: 8 }, (_, index) => ({ type: "page", path: `/s${index + 1}` }));

  beforeAll(async () => {
    const insert = async (name: string) => (await insertProject(dashboard.db, { name })).id;
    matchProject = await insert("Match");
    longProject = await insert("Long");
    await dashboard.store(matchProject, [
      event("pageview", "101", minutesAgo(60), { path: "/docs/" }),
      event("pageview", "102", minutesAgo(60), { path: "/docs/a/b" }),
      event("pageview", "103", minutesAgo(60), { path: "/docs" }),
      event("pageview", "104", minutesAgo(60), { path: "/blog/docs/a" }),
      // % and _ are literal in a pattern: only the first matches /50%_off/*.
      event("pageview", "105", minutesAgo(60), { path: "/50%_off/a" }),
      event("pageview", "106", minutesAgo(60), { path: "/50xyoff/a" }),
      event("signup", "201", minutesAgo(60), { properties: { plan: "team" } }),
      event("signup", "202", minutesAgo(60), { properties: { plan: "free" } }),
      event("signup", "203", minutesAgo(60), { properties: { plan: "teamplus" } }),
      event("signup", "204", minutesAgo(60)),
      event("signup", "205", minutesAgo(60), { properties: { plan: 5 } }),
    ]);
    await dashboard.store(longProject, [
      // u1 does all eight pages, u2 the first five, u3 the first one.
      ...EIGHT.map((step, index) =>
        event("pageview", "1", minutesAgo(80 - index), { path: step.path, userId: "u1" }),
      ),
      ...EIGHT.slice(0, 5).map((step, index) =>
        event("pageview", "2", minutesAgo(80 - index), {
          path: step.path,
          userId: "u2",
          client: { browser: "Safari" },
        }),
      ),
      event("pageview", "3", minutesAgo(80), { path: "/s1", userId: "u3" }),
    ]);
  });

  test("a path with * matches any run of characters, none included", async () => {
    expect(await firstStep({ type: "page", path: "/docs/*" })).toBe(2);
    expect(await firstStep({ type: "page", path: "/docs*" })).toBe(3);
    expect(await firstStep({ type: "page", path: "/*docs/*" })).toBe(3);
    expect(await firstStep({ type: "page", path: "/50%_off/*" })).toBe(1);
    // Without *, a path matches only itself, % and _ included.
    expect(await firstStep({ type: "page", path: "/50%_off/a" })).toBe(1);
    expect(await firstStep({ type: "page", path: "/docs" })).toBe(1);
  });

  test("a filter compares by equals, not equals, or contains; a missing property matches none", async () => {
    const plan = async (value: string, operator?: "notEquals" | "contains") =>
      firstStep(planIs(value, operator));
    expect(await plan("team")).toBe(1);
    // free is left out, and so is e4, which has no plan.
    expect(await plan("free", "notEquals")).toBe(3);
    expect(await plan("team", "contains")).toBe(2);
    // Case-sensitive, as equals is; numbers compare as their text.
    expect(await plan("Team", "contains")).toBe(0);
    expect(await plan("5", "contains")).toBe(1);
    expect(await firstStep(signupWhere({ key: "seats", value: "1", operator: "notEquals" }))).toBe(
      0,
    );
  });

  test("refuses an unknown operator", async () => {
    expect(
      await status([signupWhere({ key: "plan", value: "a", operator: "startsWith" }), EIGHT[0]]),
    ).toEqual([400, "invalid_steps"]);
  });

  test("refuses patterns and filters in a row that one event could both match", async () => {
    const page = pageStep;
    expect(await status([page("/docs/*"), page("/docs/a")])).toEqual([400, "steps_overlap"]);
    expect(await status([page("/docs/*"), page("/*/a")])).toEqual([400, "steps_overlap"]);
    expect((await status([page("/docs/*"), page("/blog/*")]))[0]).toBe(200);
    const plan = planIs;
    expect(await status([plan("team"), plan("free", "notEquals")])).toEqual([400, "steps_overlap"]);
    expect((await status([plan("team"), plan("team", "notEquals")]))[0]).toBe(200);
  });

  test("counts two steps as overlapping exactly when some event could match both", () => {
    const pages = pagesOverlap;
    // [first, second, could one path match both]
    for (const [a, b, both] of [
      ["/docs", "/docs", true],
      ["/docs", "/doc", false],
      ["/docs/*", "/docs/a", true],
      ["/docs/*", "/docs", false],
      ["/docs/*", "/blog/*", false],
      ["/docs/*", "/*", true],
      ["/docs/*", "/*/a", true],
      ["/*.html", "/*.pdf", false],
      ["/*.html", "/docs/*", true],
      ["/a/*/b", "/a/x*", true],
      ["/a/*/b", "/a/x*/c", false],
      ["/a/*/b", "/c/*/b", false],
      ["/a/*/b", "/a/*/*/b", true],
      ["/a*b*c", "/a*c", true],
      ["/a*b*c", "/x*c", false],
      ["/a/*/b", "/a/x/b", true],
      ["/a/*/b", "/a/b", false],
    ] as const) {
      expect({ a, b, both: pages(a, b) }).toEqual({ a, b, both });
      expect({ a: b, b: a, both: pages(b, a) }).toEqual({ a: b, b: a, both });
    }
    const [signup, plan] = [signupWhere, planIs];
    for (const [a, b, both] of [
      [plan("team"), plan("team"), true],
      [plan("team"), plan("free"), false],
      [plan("team"), plan("free", "notEquals"), true],
      [plan("team"), plan("team", "notEquals"), false],
      [plan("teamplus"), plan("team", "contains"), true],
      [plan("free"), plan("team", "contains"), false],
      [plan("a", "notEquals"), plan("a", "notEquals"), true],
      [plan("a", "notEquals"), plan("a", "contains"), true],
      [plan("a", "contains"), plan("b", "contains"), true],
      [plan("team"), signup({ key: "seats", value: "1" }), true],
      [plan("team"), signup(), true],
      [plan("team"), { type: "event", name: "invite" } as Step, false],
      [plan("team"), { type: "page", path: "/*" } as Step, false],
    ] as const) {
      expect([a, b, stepsOverlap(a, b)]).toEqual([a, b, both]);
      expect([b, a, stepsOverlap(b, a)]).toEqual([b, a, both]);
    }
  });

  test("follows eight steps through every view", async () => {
    const steps = `?steps=${encodeURIComponent(JSON.stringify(EIGHT))}&period=today&count=users&window=3600`;
    const funnel = (await get(longProject, `/funnel${steps}`)).json();
    expect(reachedOf(funnel)).toEqual([3, 2, 2, 2, 2, 1, 1, 1]);
    const breakdown = (await get(longProject, `/funnel/breakdown${steps}&by=browser`)).json();
    expect(breakdown.rows).toEqual([
      { kind: "value", value: "Safari", reached: [1, 1, 1, 1, 1, 0, 0, 0] },
      { kind: "unknown", value: null, reached: [2, 1, 1, 1, 1, 1, 1, 1] },
    ]);
    const trend = (await get(longProject, `/funnel/trend${steps}`)).json();
    expect(trend.points).toEqual([{ day: "2026-11-17", started: 3, converted: 1 }]);
    const times = (await get(longProject, `/funnel/times${steps}`)).json();
    expect(times.between).toHaveLength(7);
    expect(times.between[6]).toEqual({ people: 1, median: 60, p75: 60 });
    expect(times.overall).toEqual({ people: 1, median: 420, p75: 420 });
    const people = async (step: number, outcome: string) =>
      (await get(longProject, `/funnel/people${steps}&step=${step}&outcome=${outcome}`))
        .json()
        .users.map((user: { userId: string }) => user.userId);
    expect(await people(8, "converted")).toEqual(["u1"]);
    expect(await people(5, "dropped")).toEqual(["u2"]);
    // Nine steps are refused.
    expect(await status([...EIGHT, { type: "page", path: "/s9" }])).toEqual([400, "invalid_steps"]);
  });
});

describe("GET /api/projects/:id/retention", () => {
  test("shows each week's new users and how many came back in the weeks after", async () => {
    const response = await get(retentionProject, "/retention?period=30d");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      currentWeek: "2026-11-16",
      firstDay: "2026-10-19",
      environments: ["production"],
    });
    expect(body.cohorts).toEqual([
      // Ada and Bob; only Ada came back, both weeks.
      { week: "2026-11-02", users: 2, retained: [2, 1, 1] },
      // Cy, back this week, which is not over.
      { week: "2026-11-09", users: 1, retained: [1, 1] },
    ]);
    // Week 1 of Cy's cohort is this week, not over: only Ada and Bob count.
    // No cohort has finished week 2 yet.
    expect(body.average).toEqual([
      { users: 3, retained: 3 },
      { users: 2, retained: 1 },
      { users: 0, retained: 0 },
    ]);
    expect(body.identifiesUsers).toBe(true);
  });

  test("leaves out users first seen before the range's weeks", async () => {
    const body = (await get(retentionProject, "/retention?from=2026-11-09&to=2026-11-17")).json();
    expect(body.cohorts.map((cohort: { week: string }) => cohort.week)).toEqual(["2026-11-09"]);
  });

  test("shows every cohort of a long range, not only the latest", async () => {
    const body = (await get(retentionProject, "/retention?period=90d")).json();
    expect(body.cohorts.map((cohort: { week: string }) => cohort.week)).toEqual([
      "2026-09-28",
      "2026-11-02",
      "2026-11-09",
    ]);
  });

  test("an empty range still says the project identifies users", async () => {
    const body = (await get(retentionProject, "/retention?from=2026-06-01&to=2026-06-30")).json();
    expect(body).toMatchObject({ cohorts: [], average: [], identifiesUsers: true });
  });

  test("a project that never identified a user says so", async () => {
    // The compare project's events carry no user ID.
    const none = (await get(compareProject, "/retention?period=30d")).json();
    expect(none).toMatchObject({ cohorts: [], average: [], identifiesUsers: false });
  });
});

describe("averageOf", () => {
  test("pools users of the cohorts that finished each week", () => {
    const cohorts = [
      { week: "2026-10-19", users: 10, retained: [10, 4, 2, 1, 0] },
      { week: "2026-10-26", users: 30, retained: [30, 6, 3, 1] },
      { week: "2026-11-09", users: 5, retained: [5, 2] },
      { week: "2026-11-16", users: 7, retained: [7] },
    ];
    expect(averageOf(cohorts, "2026-11-16")).toEqual([
      // The current week's cohort has not finished week 0.
      { users: 45, retained: 45 },
      // The 9 November cohort's week 1 is this week.
      { users: 40, retained: 10 },
      { users: 40, retained: 5 },
      // Only the 19 October cohort finished week 3; week 4 is this week.
      { users: 10, retained: 1 },
      { users: 0, retained: 0 },
    ]);
  });
});
