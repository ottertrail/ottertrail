import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { NewEvent } from "../src/collection/event-store.ts";
import { previousReadEnd } from "../src/product/funnel.ts";
import { parseSteps } from "../src/product/routes.ts";
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
      JSON.stringify(Array.from({ length: 6 }, () => ({ type: "page", path: "/" }))),
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
  });

  test("leaves out users first seen before the range's weeks", async () => {
    const body = (await get(retentionProject, "/retention?from=2026-11-09&to=2026-11-17")).json();
    expect(body.cohorts.map((cohort: { week: string }) => cohort.week)).toEqual(["2026-11-09"]);
  });
});
