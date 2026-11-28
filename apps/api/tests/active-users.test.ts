import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { NewEvent } from "../src/collection/event-store.ts";
import { signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/** Noon on Tuesday 17 November 2026 in Singapore (UTC+8), the instance's timezone. */
const NOW = new Date("2026-11-17T04:00:00.000Z");
/** 09:00 on a day in Singapore. */
const on = (day: string) => new Date(`${day}T01:00:00Z`);

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let project = "";
let otherProject = "";
let anonymousProject = "";
let quietProject = "";

let visitors = 0;

function event(userId: string | undefined, occurredAt: Date, more: Partial<NewEvent> = {}) {
  return {
    eventId: randomUUID(),
    name: "pageview",
    occurredAt,
    path: "/",
    visitorId: String((visitors += 1)),
    ...(userId === undefined ? {} : { userId }),
    ...more,
  };
}

function get(projectId: string, query: string) {
  return dashboard.app.inject({
    url: `/api/projects/${projectId}/active-users?${query}`,
    headers: { cookie: dashboard.cookie },
  });
}

interface Point {
  day: string;
  start: string;
  dau: number;
  wau: number;
  mau: number;
  stickiness: number | null;
  new: number;
  returning: number;
  resurrected: number;
}

beforeAll(async () => {
  dashboard = await signedInDashboard({ now: () => NOW, timeZone: "Asia/Singapore" });
  const insert = async (name: string) => (await insertProject(dashboard.db, { name })).id;
  project = await insert("Active users");
  otherProject = await insert("Other");
  anonymousProject = await insert("Anonymous");
  quietProject = await insert("Quiet");

  await dashboard.store(project, [
    // Ada: first seen 1 November, back on the 7th; time on page on the 2nd does not count.
    event("ada", on("2026-11-01"), { name: "signup" }),
    event("ada", on("2026-11-02"), { name: "engagement", properties: { engagedMs: 5000 } }),
    event("ada", on("2026-11-07")),
    // Bob: 4 October, exactly 28 days before 1 November: returning then.
    event("bob", on("2026-10-04")),
    event("bob", on("2026-11-01")),
    // Cy: only 5 October, 27 days before 1 November: in that day's MAU and no later one.
    event("cy", on("2026-10-05")),
    // Jo: 3 October, 29 days before 1 November: resurrected then.
    event("jo", on("2026-10-03")),
    event("jo", on("2026-11-01")),
    // Dee: seen in August, resurrected on 3 November, returning on the 4th.
    event("dee", on("2026-08-01")),
    event("dee", on("2026-11-03")),
    event("dee", on("2026-11-04")),
    // Eve: only 5 November: in the WAU up to the 11th.
    event("eve", on("2026-11-05")),
    // Fay: 16:30 UTC on 9 November is 00:30 on the 10th in Singapore.
    event("fay", new Date("2026-11-09T16:30:00Z")),
    // Gus: one server event without a visitor, at 23:59:59 on 12 November in Singapore.
    {
      eventId: randomUUID(),
      name: "invoice_paid",
      occurredAt: new Date("2026-11-12T15:59:59Z"),
      userId: "gus",
    },
    // Hal: only time on page and Web Vitals, never active.
    event("hal", on("2026-11-06"), { name: "engagement", properties: { engagedMs: 5000 } }),
    event("hal", on("2026-11-06"), { name: "vitals", properties: { lcp: 900 } }),
    // Ivy: another environment.
    event("ivy", on("2026-11-06"), { environment: "staging" }),
    // Anonymous events never count.
    event(undefined, on("2026-11-02")),
    event(undefined, on("2026-11-06")),
  ]);
  await dashboard.store(otherProject, [
    event("ada", on("2026-11-02")),
    event("zed", on("2026-11-06")),
  ]);
  await dashboard.store(anonymousProject, [event(undefined, on("2026-11-06"))]);
  await dashboard.store(quietProject, [event("old", on("2026-06-01"))]);
});

afterAll(async () => {
  await dashboard.close();
});

const DAU = [3, 0, 1, 1, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0];
const WAU = [3, 3, 4, 4, 5, 5, 5, 3, 3, 4, 3, 3, 3, 2];
const MAU = [4, 3, 4, 4, 5, 5, 5, 5, 5, 6, 6, 7, 7, 7];
const DAYS = DAU.map((_, index) => `2026-11-${String(index + 1).padStart(2, "0")}`);
const lifecycleOf = (day: string) =>
  ({
    "2026-11-01": { new: 1, returning: 1, resurrected: 1 },
    "2026-11-03": { new: 0, returning: 0, resurrected: 1 },
    "2026-11-04": { new: 0, returning: 1, resurrected: 0 },
    "2026-11-05": { new: 1, returning: 0, resurrected: 0 },
    "2026-11-07": { new: 0, returning: 1, resurrected: 0 },
    "2026-11-10": { new: 1, returning: 0, resurrected: 0 },
    "2026-11-12": { new: 1, returning: 0, resurrected: 0 },
  })[day] ?? { new: 0, returning: 0, resurrected: 0 };
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

describe("GET /api/projects/:id/active-users", () => {
  test("counts DAU, WAU, and MAU per day, at the 7- and 28-day edges, in the instance's timezone", async () => {
    const response = await get(project, "from=2026-11-01&to=2026-11-14");
    expect(response.statusCode).toBe(200);
    const body = response.json<{ unit: string; points: Point[]; timeZone: string }>();
    expect(body.unit).toBe("day");
    expect(body.timeZone).toBe("Asia/Singapore");
    expect(body.points.map((point) => point.day)).toEqual(DAYS);
    expect(body.points.map((point) => point.dau)).toEqual(DAU);
    expect(body.points.map((point) => point.wau)).toEqual(WAU);
    expect(body.points.map((point) => point.mau)).toEqual(MAU);
    // Each day starts at midnight in Singapore.
    expect(body.points[0]?.start).toBe("2026-10-31T16:00:00.000Z");
    expect(body.points.map((point) => point.stickiness)).toEqual(
      DAU.map((dau, index) => dau / (MAU[index] ?? 1)),
    );
  });

  test("splits each day's users into new, returning, and resurrected, adding up to the DAU", async () => {
    const body = (await get(project, "from=2026-11-01&to=2026-11-14")).json<{ points: Point[] }>();
    for (const point of body.points) {
      expect({
        new: point.new,
        returning: point.returning,
        resurrected: point.resurrected,
      }).toEqual(lifecycleOf(point.day));
      expect(point.new + point.returning + point.resurrected).toBe(point.dau);
    }
  });

  test("sums up the period and the period before", async () => {
    const body = (await get(project, "from=2026-11-01&to=2026-11-14")).json();
    expect(body.summary).toEqual({
      users: 7,
      averageDaily: 9 / 14,
      weekly: 2,
      monthly: 7,
      stickiness: mean(DAU.map((dau, index) => dau / (MAU[index] ?? 1))),
    });
    // 18 to 31 October: nobody active, but Bob and Cy in the 28 days ending the 31st.
    expect(body.previous).toEqual({
      firstDay: "2026-10-18",
      lastDay: "2026-10-31",
      until: null,
      users: 0,
      averageDaily: 0,
      weekly: 0,
      monthly: 2,
      stickiness: 0,
    });
    expect(body.identifiesUsers).toBe(true);
    expect(body.environments).toEqual(["production", "staging"]);
  });

  test("counts weeks from Monday for a period over 60 days", async () => {
    const body = (await get(project, "from=2026-08-03&to=2026-11-15")).json<{
      unit: string;
      points: Point[];
    }>();
    expect(body.unit).toBe("week");
    expect(body.points).toHaveLength(15);
    const week = (day: string) => body.points.find((point) => point.day === day);
    // 2 to 8 November: Ada returning, Dee resurrected, Eve new; DAU 0, 1, 1, 1, 0, 1, 0.
    expect(week("2026-11-02")).toMatchObject({
      dau: 4 / 7,
      wau: 3,
      mau: 5,
      new: 1,
      returning: 1,
      resurrected: 1,
    });
    expect(week("2026-11-09")).toMatchObject({ new: 2, returning: 0, resurrected: 0 });
    // 28 September to 4 October: Jo and Bob first seen.
    expect(week("2026-09-28")).toMatchObject({ new: 2, returning: 0, resurrected: 0 });
  });

  test("reads another environment only when asked", async () => {
    const body = (await get(project, "from=2026-11-01&to=2026-11-14&environment=staging")).json();
    expect(body.summary.users).toBe(1);
    expect(body.points[5]).toMatchObject({ day: "2026-11-06", dau: 1, new: 1 });
  });

  test("leaves out other projects' users", async () => {
    const body = (await get(otherProject, "from=2026-11-01&to=2026-11-14")).json();
    expect(body.summary.users).toBe(2);
    expect(body.points[1]).toMatchObject({ dau: 1, new: 1 });
  });

  test("tells a project without signed-in users from a quiet period", async () => {
    const anonymous = (await get(anonymousProject, "from=2026-11-01&to=2026-11-14")).json();
    expect(anonymous.summary.users).toBe(0);
    expect(anonymous.identifiesUsers).toBe(false);
    const quiet = (await get(quietProject, "from=2026-11-01&to=2026-11-14")).json();
    expect(quiet.summary).toMatchObject({ users: 0, monthly: 0, stickiness: null });
    expect(quiet.identifiesUsers).toBe(true);
  });

  test("refuses a range it cannot read", async () => {
    expect((await get(project, "from=2026-11-14&to=2026-11-01")).statusCode).toBe(400);
    expect((await get(project, "from=2025-01-01&to=2026-11-14")).statusCode).toBe(400);
  });
});
