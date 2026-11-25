import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { NewEvent } from "../src/collection/event-store.ts";
import { signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/*
 * A funnel's conversion over time and the time between its steps
 * (docs/product-analytics.md, "Conversion over time" and "Time between
 * steps").
 */

/** Noon on Tuesday 17 November 2026 in UTC: 7:00 in New York, the instance's timezone. */
const NOW = new Date("2026-11-17T12:00:00.000Z");
const at = (iso: string) => new Date(iso);

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let trendProject = "";
let timesProject = "";
let otherProject = "";

/** Visitor IDs are numbers: one per user ID. */
const visitorIds = new Map<string, string>();
function event(name: string, userId: string, occurredAt: Date): NewEvent {
  const visitorId = visitorIds.get(userId) ?? String(visitorIds.size + 1);
  visitorIds.set(userId, visitorId);
  return { eventId: randomUUID(), name, occurredAt, path: "/", visitorId, userId };
}

function get(projectId: string, path: string, cookie = dashboard.cookie) {
  return dashboard.app.inject({
    url: `/api/projects/${projectId}${path}`,
    headers: { cookie },
  });
}

const SIGNUP_PURCHASE = [
  { type: "event", name: "signup" },
  { type: "event", name: "purchase" },
];
const SIGNUP_PURCHASE_INVITE = [...SIGNUP_PURCHASE, { type: "event", name: "invite" }];

const query = (steps: unknown[], rest: string) =>
  `?steps=${encodeURIComponent(JSON.stringify(steps))}&count=users&window=3600${rest}`;

/** Seconds after a moment in the times project. */
const T = new Date("2026-11-17T09:00:00.000Z").getTime();
const after = (seconds: number) => new Date(T + seconds * 1000);

beforeAll(async () => {
  dashboard = await signedInDashboard({ now: () => NOW, timeZone: "America/New_York" });
  const insert = async (name: string) => (await insertProject(dashboard.db, { name })).id;
  trendProject = await insert("Trend");
  timesProject = await insert("Times");
  otherProject = await insert("Other");

  await dashboard.store(trendProject, [
    // e starts on 13 November and converts after a second signup on the 16th: counted on the 13th.
    event("signup", "e", at("2026-11-13T14:00:00Z")),
    event("signup", "e", at("2026-11-16T15:00:00Z")),
    event("purchase", "e", at("2026-11-16T15:05:00Z")),
    // 14 November in New York, though b's signup is on the 15th in UTC.
    event("signup", "a", at("2026-11-14T15:00:00Z")),
    event("purchase", "a", at("2026-11-14T15:10:00Z")),
    event("signup", "b", at("2026-11-15T03:00:00Z")),
    // Nobody signs up on 15 November.
    event("signup", "c", at("2026-11-16T14:00:00Z")),
    event("purchase", "c", at("2026-11-16T14:30:00Z")),
    event("signup", "d", at("2026-11-16T16:00:00Z")),
    event("purchase", "d", at("2026-11-16T16:01:00Z")),
  ]);

  await dashboard.store(timesProject, [
    event("signup", "u1", after(0)),
    event("purchase", "u1", after(60)),
    event("invite", "u1", after(360)),
    event("signup", "u2", after(0)),
    event("purchase", "u2", after(120)),
    event("invite", "u2", after(720)),
    // u3 stops after the purchase, u4 after the signup.
    event("signup", "u3", after(0)),
    event("purchase", "u3", after(180)),
    event("signup", "u4", after(0)),
    // u5 signs up twice: the latest signup before the purchase counts, and
    // a repeated purchase keeps its first time.
    event("signup", "u5", after(0)),
    event("signup", "u5", after(600)),
    event("purchase", "u5", after(660)),
    event("purchase", "u5", after(900)),
    event("invite", "u5", after(1500)),
  ]);

  // The same user IDs in another project, never counted in the two above.
  await dashboard.store(otherProject, [
    event("signup", "a", at("2026-11-15T15:00:00Z")),
    event("signup", "u1", after(0)),
    event("purchase", "u1", after(3000)),
  ]);
});

afterAll(async () => {
  await dashboard?.close();
});

describe("GET /api/projects/:id/funnel/trend", () => {
  test("per day of each person's first step 1, in the instance's timezone, with no point for an empty day", async () => {
    const response = await get(
      trendProject,
      `/funnel/trend${query(SIGNUP_PURCHASE, "&from=2026-11-12&to=2026-11-17")}`,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      timeZone: "America/New_York",
      count: "users",
      window: 3600,
      unit: "day",
    });
    expect(body.points).toEqual([
      { day: "2026-11-13", started: 1, converted: 1 },
      { day: "2026-11-14", started: 2, converted: 1 },
      { day: "2026-11-16", started: 2, converted: 2 },
    ]);
  });

  test("the points add up to the funnel", async () => {
    const rest = "&from=2026-11-12&to=2026-11-17";
    const points = (await get(trendProject, `/funnel/trend${query(SIGNUP_PURCHASE, rest)}`)).json()
      .points as { started: number; converted: number }[];
    const funnel = (await get(trendProject, `/funnel${query(SIGNUP_PURCHASE, rest)}`)).json();
    expect(funnel.steps.map((step: { reached: number }) => step.reached)).toEqual([
      points.reduce((sum, point) => sum + point.started, 0),
      points.reduce((sum, point) => sum + point.converted, 0),
    ]);
  });

  test("per week, from Monday, when the period is longer than 60 days", async () => {
    const body = (
      await get(
        trendProject,
        `/funnel/trend${query(SIGNUP_PURCHASE, "&from=2026-08-01&to=2026-11-17")}`,
      )
    ).json();
    expect(body.unit).toBe("week");
    expect(body.points).toEqual([
      { day: "2026-11-09", started: 3, converted: 2 },
      { day: "2026-11-16", started: 2, converted: 2 },
    ]);
    // Exactly 60 days stay daily.
    const sixty = (
      await get(
        trendProject,
        `/funnel/trend${query(SIGNUP_PURCHASE, "&from=2026-09-19&to=2026-11-17")}`,
      )
    ).json();
    expect(sixty.unit).toBe("day");
  });

  test("counts only the project's own events", async () => {
    const body = (
      await get(
        otherProject,
        `/funnel/trend${query(SIGNUP_PURCHASE, "&from=2026-11-12&to=2026-11-17")}`,
      )
    ).json();
    expect(body.points).toEqual([
      { day: "2026-11-15", started: 1, converted: 0 },
      { day: "2026-11-17", started: 1, converted: 1 },
    ]);
  });
});

describe("GET /api/projects/:id/funnel/times", () => {
  test("the median and 75th percentile from each step to the next, and overall, for those who reached it", async () => {
    const response = await get(
      timesProject,
      `/funnel/times${query(SIGNUP_PURCHASE_INVITE, "&period=today")}`,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ count: "users", window: 3600 });
    // Step 2: 60, 60, 120, 180 seconds (u1, u5, u2, u3); u4 never purchased.
    // Step 3: 300, 600, 840 (u1, u2, u5); overall 360, 720, 900.
    expect(body.between).toEqual([
      { people: 4, median: 90, p75: 135 },
      { people: 3, median: 600, p75: 720 },
    ]);
    expect(body.overall).toEqual({ people: 3, median: 720, p75: 810 });
  });

  test("no time where nobody reached the step", async () => {
    const steps = [
      { type: "event", name: "signup" },
      { type: "event", name: "refund" },
    ];
    const body = (await get(timesProject, `/funnel/times${query(steps, "&period=today")}`)).json();
    expect(body.between).toEqual([{ people: 0, median: null, p75: null }]);
    expect(body.overall).toEqual({ people: 0, median: null, p75: null });
  });

  test("counts only the project's own events", async () => {
    const body = (
      await get(otherProject, `/funnel/times${query(SIGNUP_PURCHASE, "&period=today")}`)
    ).json();
    expect(body.between).toEqual([{ people: 1, median: 3000, p75: 3000 }]);
  });
});

/** A member who may see the times project, with or without product analytics there. */
const member = async (email: string, product: "none" | "view") =>
  (
    await signedInUser(dashboard, {
      name: email,
      email,
      grants: { projects: [timesProject], areas: { product_analytics: product } },
    })
  ).cookie;

describe("validation and access", () => {
  test("refuses what the funnel refuses", async () => {
    for (const route of ["trend", "times"]) {
      const bad = await get(trendProject, `/funnel/${route}?steps=${encodeURIComponent("[1]")}`);
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toBe("invalid_steps");
      const window = await get(
        trendProject,
        `/funnel/${route}?steps=${encodeURIComponent(JSON.stringify(SIGNUP_PURCHASE))}&count=visitors&window=604800`,
      );
      expect(window.statusCode).toBe(400);
      expect(window.json().error).toBe("invalid_window");
      const range = await get(
        trendProject,
        `/funnel/${route}${query(SIGNUP_PURCHASE, "&from=2025-01-01&to=2026-11-17")}`,
      );
      expect(range.statusCode).toBe(400);
      expect(
        (await get("not-a-uuid", `/funnel/${route}${query(SIGNUP_PURCHASE, "")}`)).statusCode,
      ).toBe(400);
    }
  });

  test("needs product analytics on the project", async () => {
    const none = await member("none@example.com", "none");
    const viewer = await member("viewer@example.com", "view");
    for (const route of ["trend", "times"]) {
      const path = `/funnel/${route}${query(SIGNUP_PURCHASE, "&period=today")}`;
      expect((await get(timesProject, path, none)).statusCode).toBe(403);
      expect((await get(timesProject, path, viewer)).statusCode).toBe(200);
      // Another project is not theirs.
      expect((await get(trendProject, path, viewer)).statusCode).toBe(404);
    }
  });
});
