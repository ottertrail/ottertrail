import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { NewEvent } from "../src/collection/event-store.ts";
import { MAX_GOALS } from "../src/goals/goals.ts";
import { PUBLIC_URL, signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/** Noon on 17 November 2026 in UTC, the instance's timezone. */
const NOW = new Date("2026-11-17T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let projectId = "";

function call(
  method: "GET" | "POST" | "DELETE",
  path: string,
  payload?: object,
  origin = PUBLIC_URL,
) {
  return dashboard.app.inject({
    method,
    url: `/api/projects/${projectId}${path}`,
    headers: { cookie: dashboard.cookie, origin },
    ...(payload === undefined ? {} : { payload }),
  });
}

function event(
  name: string,
  visitorId: string,
  more: Partial<NewEvent> & { deviceType?: "desktop" | "mobile" } = {},
): NewEvent {
  const { deviceType = "desktop", ...rest } = more;
  return {
    eventId: randomUUID(),
    name,
    occurredAt: minutesAgo(60),
    path: "/",
    visitorId,
    client: { browser: "Chrome", browserVersion: "142", os: "macOS", deviceType },
    ...rest,
  };
}

const SAW_PRICING = { type: "page", path: "/pricing" };
const SIGNED_UP = { type: "event", name: "signup" };
const TEAM_SIGNUP = { type: "event", name: "signup", filter: { key: "plan", value: "team" } };

beforeAll(async () => {
  dashboard = await signedInDashboard({ now: () => NOW });
  projectId = (await insertProject(dashboard.db, { name: "Shop" })).id;
  await dashboard.store(projectId, [
    // 1: pricing, then a team signup, on a desktop.
    event("pageview", "1", { path: "/pricing", occurredAt: minutesAgo(70) }),
    event("signup", "1", { properties: { plan: "team" } }),
    // 2: a free signup on a phone, twice (a retry the site sent twice).
    event("pageview", "2", { deviceType: "mobile", occurredAt: minutesAgo(70) }),
    event("signup", "2", { deviceType: "mobile", properties: { plan: "free" } }),
    event("signup", "2", { deviceType: "mobile", properties: { plan: "free" } }),
    // 3: the home page only.
    event("pageview", "3"),
    // 4: pricing, a page, and nothing else.
    event("pageview", "4", { path: "/pricing" }),
  ]);
});

afterAll(async () => {
  await dashboard?.close();
});

describe("goals", () => {
  test("are added, listed in that order, and named once each", async () => {
    const added = await call("POST", "/goals", { name: "  Saw pricing ", step: SAW_PRICING });
    expect(added.statusCode).toBe(201);
    expect(added.json().goal).toMatchObject({ name: "Saw pricing", step: SAW_PRICING });
    await call("POST", "/goals", { name: "Signed up", step: SIGNED_UP });
    await call("POST", "/goals", { name: "Team signup", step: TEAM_SIGNUP });

    const list = (await call("GET", "/goals")).json().goals;
    expect(list.map((goal: { name: string }) => goal.name)).toEqual([
      "Saw pricing",
      "Signed up",
      "Team signup",
    ]);
    expect(list[2].step).toEqual(TEAM_SIGNUP);

    const again = await call("POST", "/goals", { name: "Signed up", step: SAW_PRICING });
    expect([again.statusCode, again.json().error]).toEqual([409, "goal_name_taken"]);
  });

  test("count on the analytics page: visitors who reached each, of all visitors", async () => {
    const body = (
      await dashboard.app.inject({
        url: `/api/projects/${projectId}/analytics?period=today`,
        headers: { cookie: dashboard.cookie },
      })
    ).json();
    expect(body.summary.visitors).toBe(4);
    expect(body.goals).toMatchObject([
      { name: "Saw pricing", visitors: 2, events: 2, conversionRate: 0.5 },
      { name: "Signed up", visitors: 2, events: 3, conversionRate: 0.5 },
      { name: "Team signup", visitors: 1, events: 1, conversionRate: 0.25 },
    ]);
  });

  test("count only the page's own visits when it is filtered", async () => {
    const body = (
      await dashboard.app.inject({
        url: `/api/projects/${projectId}/analytics?period=today&deviceType=mobile`,
        headers: { cookie: dashboard.cookie },
      })
    ).json();
    expect(body.summary.visitors).toBe(1);
    expect(body.goals).toMatchObject([
      { name: "Saw pricing", visitors: 0, conversionRate: 0 },
      { name: "Signed up", visitors: 1, events: 2, conversionRate: 1 },
      { name: "Team signup", visitors: 0 },
    ]);
  });

  test("refuse a bad name or step, more than the limit, and a change from elsewhere", async () => {
    for (const [payload, error] of [
      [{ name: "", step: SIGNED_UP }, "invalid_name"],
      [{ name: "Tab\there", step: SIGNED_UP }, "invalid_name"],
      [{ name: "x".repeat(101), step: SIGNED_UP }, "invalid_name"],
      [{ name: "Bad", step: { type: "page", path: "pricing" } }, "invalid_step"],
      [{ name: "Bad", step: { type: "event", name: "" } }, "invalid_step"],
      [{ name: "Bad", step: { type: "event", name: "a", filter: { key: "" } } }, "invalid_step"],
    ] as const) {
      const response = await call("POST", "/goals", payload);
      expect({ payload, status: response.statusCode, error: response.json().error }).toEqual({
        payload,
        status: 400,
        error,
      });
    }
    const elsewhere = await call(
      "POST",
      "/goals",
      { name: "Evil", step: SIGNED_UP },
      "https://evil.example",
    );
    expect(elsewhere.statusCode).toBe(403);

    const have = (await call("GET", "/goals")).json().goals.length;
    for (let index = have; index < MAX_GOALS; index += 1) {
      await call("POST", "/goals", {
        name: `Goal ${index}`,
        step: { type: "page", path: `/p${index}` },
      });
    }
    const over = await call("POST", "/goals", { name: "One more", step: SIGNED_UP });
    expect([over.statusCode, over.json().error]).toEqual([409, "too_many_goals"]);
  });

  test("are deleted, once", async () => {
    const [first] = (await call("GET", "/goals")).json().goals;
    expect((await call("DELETE", `/goals/${first.id}`)).statusCode).toBe(204);
    expect((await call("DELETE", `/goals/${first.id}`)).statusCode).toBe(404);
    const names = (await call("GET", "/goals"))
      .json()
      .goals.map((goal: { name: string }) => goal.name);
    expect(names).not.toContain("Saw pricing");
  });
});

/** Another project, for tests that need their own goals. */
const otherProject = async (name: string) => (await insertProject(dashboard.db, { name })).id;

/** Adds a goal to any project, from the dashboard. */
const post = (project: string, payload: object) =>
  dashboard.app.inject({
    method: "POST",
    url: `/api/projects/${project}/goals`,
    headers: { cookie: dashboard.cookie, origin: PUBLIC_URL },
    payload,
  });

describe("goals, at their edges", () => {
  test("refuse the tracker's own events, which could never match", async () => {
    const project = await otherProject("Tracker names");
    for (const name of ["pageview", "engagement", "error", "vitals"]) {
      const response = await post(project, { name: `Goal ${name}`, step: { type: "event", name } });
      expect({ name, status: response.statusCode, error: response.json().error }).toEqual({
        name,
        status: 400,
        error: "invalid_step",
      });
    }
  });

  test("match a path pattern and a filter's operator, and keep them", async () => {
    const project = await otherProject("Patterns");
    await dashboard.store(project, [
      event("pageview", "1", { path: "/docs/start" }),
      event("pageview", "2", { path: "/docs/api/keys" }),
      event("pageview", "3", { path: "/docs" }),
      event("signup", "1", { properties: { plan: "team" } }),
      event("signup", "2", { properties: { plan: "free" } }),
      event("signup", "3"),
    ]);
    const docs = { type: "page", path: "/docs/*" };
    const paid = {
      type: "event",
      name: "signup",
      filter: { key: "plan", value: "free", operator: "notEquals" },
    };
    const team = {
      type: "event",
      name: "signup",
      filter: { key: "plan", value: "tea", operator: "contains" },
    };
    for (const [name, step] of [
      ["Read the docs", docs],
      ["Paid signup", paid],
      ["Team signup", team],
    ] as const) {
      const added = await post(project, { name, step });
      expect(added.statusCode).toBe(201);
      expect(added.json().goal.step).toEqual(step);
    }
    const listed = await dashboard.app.inject({
      url: `/api/projects/${project}/goals`,
      headers: { cookie: dashboard.cookie },
    });
    expect(listed.json().goals.map((goal: { step: object }) => goal.step)).toEqual([
      docs,
      paid,
      team,
    ]);
    const body = (
      await dashboard.app.inject({
        url: `/api/projects/${project}/analytics?period=today`,
        headers: { cookie: dashboard.cookie },
      })
    ).json();
    // Visitor 3 has neither a page under /docs/ nor a plan.
    expect(body.goals).toMatchObject([
      { name: "Read the docs", visitors: 2 },
      { name: "Paid signup", visitors: 1 },
      { name: "Team signup", visitors: 1 },
    ]);
    const bad = await post(project, {
      name: "Bad",
      step: { ...team, filter: { key: "plan", value: "a", operator: "startsWith" } },
    });
    expect([bad.statusCode, bad.json().error]).toEqual([400, "invalid_step"]);
    // The database holds an operator only with a filter.
    await expect(
      dashboard.db
        .insertInto("goals")
        .values({
          project_id: project,
          name: "No filter",
          kind: "event",
          event_name: "signup",
          path: null,
          filter_key: null,
          filter_value: null,
          filter_operator: "contains",
        })
        .execute(),
    ).rejects.toThrow(/goals_filter_operator_filter_check/);
  });

  test("hold the limit when goals are added at the same moment", async () => {
    const project = await otherProject("Busy");
    for (let index = 0; index < MAX_GOALS - 1; index += 1) {
      await post(project, { name: `Goal ${index}`, step: { type: "page", path: `/p${index}` } });
    }
    const statuses = await Promise.all(
      ["A", "B", "C"].map(
        async (name) => (await post(project, { name, step: SIGNED_UP })).statusCode,
      ),
    );
    expect(statuses.toSorted((a, b) => a - b)).toEqual([201, 409, 409]);
  });

  test("are deleted only through their own project's address", async () => {
    const [first, second] = [await otherProject("First"), await otherProject("Second")];
    const goal = (await post(second, { name: "Theirs", step: SIGNED_UP })).json().goal;
    const wrong = await dashboard.app.inject({
      method: "DELETE",
      url: `/api/projects/${first}/goals/${goal.id}`,
      headers: { cookie: dashboard.cookie, origin: PUBLIC_URL },
    });
    expect(wrong.statusCode).toBe(404);
    const still = await dashboard.app.inject({
      url: `/api/projects/${second}/goals`,
      headers: { cookie: dashboard.cookie },
    });
    expect(still.json().goals.map((item: { id: string }) => item.id)).toEqual([goal.id]);
  });
});
