import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { NewEvent } from "../src/collection/event-store.ts";
import { signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/*
 * A funnel broken down by one dimension, and the signed-in users who
 * dropped off or converted at a step (docs/product-analytics.md,
 * "Breakdown" and "Who dropped off").
 */

/** Noon on Tuesday 17 November 2026 in UTC, the instance's timezone. */
const NOW = new Date("2026-11-17T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let breakdownProject = "";
let peopleProject = "";
let otherProject = "";

function event(name: string, visitorId: string, occurredAt: Date, more: Partial<NewEvent> = {}) {
  return { eventId: randomUUID(), name, occurredAt, path: "/", visitorId, ...more };
}

function get(projectId: string, path: string, cookie = dashboard.cookie) {
  return dashboard.app.inject({
    url: `/api/projects/${projectId}${path}`,
    headers: { cookie },
  });
}

const query = (steps: unknown[], rest: string) =>
  `?steps=${encodeURIComponent(JSON.stringify(steps))}&period=today${rest}`;

const SIGNUP_PURCHASE = [
  { type: "event", name: "signup" },
  { type: "event", name: "purchase" },
];
const SIGNUP_PURCHASE_INVITE = [...SIGNUP_PURCHASE, { type: "event", name: "invite" }];

/** A visitor's signup on `browser`, with `plan` when given, and a purchase when `buys`. */
function visitor(
  id: string,
  browser: string | undefined,
  { buys = false, plan, at = 200 }: { buys?: boolean; plan?: string; at?: number } = {},
): NewEvent[] {
  const client = browser === undefined ? {} : { client: { browser } };
  return [
    event("signup", id, minutesAgo(at), {
      ...client,
      ...(plan === undefined ? {} : { properties: { plan } }),
    }),
    ...(buys ? [event("purchase", id, minutesAgo(at - 10), client)] : []),
  ];
}

const DROPPED = 105;

beforeAll(async () => {
  dashboard = await signedInDashboard({ now: () => NOW });
  const insert = async (name: string) => (await insertProject(dashboard.db, { name })).id;
  breakdownProject = await insert("Breakdown");
  peopleProject = await insert("People");
  otherProject = await insert("Other");

  await dashboard.store(breakdownProject, [
    // b1 starts on Chrome on the team plan; a later signup elsewhere does not move them.
    ...visitor("1", "Chrome", { buys: true, plan: "team", at: 300 }),
    event("signup", "1", minutesAgo(100), {
      client: { browser: "Safari" },
      properties: { plan: "free" },
    }),
    ...visitor("2", "Chrome", { buys: true, plan: "team" }),
    ...visitor("3", "Chrome", { plan: "free" }),
    ...visitor("4", "Safari", { buys: true }),
    ...visitor("5", "Safari"),
    ...visitor("6", "Firefox"),
    ...visitor("7", "Firefox"),
    ...visitor("8", "Edge"),
    ...visitor("9", "Opera"),
    ...visitor("10", "Brave", { buys: true }),
    ...visitor("11", "Vivaldi"),
    // No browser recognized.
    ...visitor("12", undefined),
  ]);

  await dashboard.store(peopleProject, [
    // 105 users sign up and stop, one a minute.
    ...Array.from({ length: DROPPED }, (_, index) =>
      event("signup", `${1000 + index}`, minutesAgo(index + 1), { userId: `dropped-${index}` }),
    ),
    // One stops after the purchase; one invites too.
    event("signup", "2001", minutesAgo(200), { userId: "bought" }),
    event("purchase", "2001", minutesAgo(190), { userId: "bought" }),
    event("signup", "2002", minutesAgo(200), { userId: "converted" }),
    event("purchase", "2002", minutesAgo(190), { userId: "converted" }),
    event("invite", "2002", minutesAgo(180), { userId: "converted" }),
  ]);

  // Another project: the same visitor and user IDs, never counted in the two above.
  await dashboard.store(otherProject, [
    ...visitor("1", "Chrome", { buys: true, plan: "team" }),
    ...visitor("13", "Chrome"),
    event("signup", "3001", minutesAgo(5), { userId: "dropped-0" }),
    event("signup", "3002", minutesAgo(5), { userId: "intruder" }),
  ]);
});

afterAll(async () => {
  await dashboard?.close();
});

describe("GET /api/projects/:id/funnel/breakdown", () => {
  test("the top five values by step 1, then Other, then Unknown", async () => {
    const response = await get(
      breakdownProject,
      `/funnel/breakdown${query(SIGNUP_PURCHASE, "&window=3600&by=browser")}`,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ count: "visitors", window: 3600, by: "browser" });
    // Ties by step 1 go by name: Firefox before Safari, Brave and Edge before Opera and Vivaldi.
    expect(body.rows).toEqual([
      { kind: "value", value: "Chrome", reached: [3, 2] },
      { kind: "value", value: "Firefox", reached: [2, 0] },
      { kind: "value", value: "Safari", reached: [2, 1] },
      { kind: "value", value: "Brave", reached: [1, 1] },
      { kind: "value", value: "Edge", reached: [1, 0] },
      { kind: "other", value: null, reached: [2, 0] },
      { kind: "unknown", value: null, reached: [1, 0] },
    ]);
  });

  test("counts each person once, under their first step 1, so the rows add up to the funnel", async () => {
    const steps = query(SIGNUP_PURCHASE, "&window=3600");
    const funnel = (await get(breakdownProject, `/funnel${steps}`)).json();
    const rows = (await get(breakdownProject, `/funnel/breakdown${steps}&by=p.plan`)).json().rows;
    // b1's later free signup leaves them on the team plan.
    expect(rows).toEqual([
      { kind: "value", value: "team", reached: [2, 2] },
      { kind: "value", value: "free", reached: [1, 0] },
      { kind: "unknown", value: null, reached: [9, 2] },
    ]);
    expect(funnel.steps.map((step: { reached: number }) => step.reached)).toEqual(
      [0, 1].map((index) =>
        rows.reduce(
          (sum: number, row: { reached: number[] }) => sum + (row.reached[index] ?? 0),
          0,
        ),
      ),
    );
  });

  test("refuses a dimension not on the list, a bad property name, and a property of a page", async () => {
    const steps = query(SIGNUP_PURCHASE, "");
    for (const by of ["referrer", "utmSource", "p.", `p.${"k".repeat(101)}`, "p.a\u0000b"]) {
      const response = await get(
        breakdownProject,
        `/funnel/breakdown${steps}&by=${encodeURIComponent(by)}`,
      );
      expect({ by, status: response.statusCode }).toEqual({ by, status: 400 });
    }
    expect((await get(breakdownProject, `/funnel/breakdown${steps}`)).statusCode).toBe(400);
    const page = await get(
      breakdownProject,
      `/funnel/breakdown${query([{ type: "page", path: "/" }, SIGNUP_PURCHASE[0]], "&by=p.plan")}`,
    );
    expect(page.statusCode).toBe(400);
    expect(page.json().error).toBe("invalid_breakdown");
    // A device column of a page funnel is fine.
    const device = await get(
      breakdownProject,
      `/funnel/breakdown${query([{ type: "page", path: "/" }, SIGNUP_PURCHASE[0]], "&by=deviceType")}`,
    );
    expect(device.statusCode).toBe(200);
  });

  test("refuses steps the funnel refuses", async () => {
    const response = await get(
      breakdownProject,
      `/funnel/breakdown${query(SIGNUP_PURCHASE, "&window=604800&by=browser")}`,
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_window");
  });

  test("counts only the project's own events", async () => {
    const rows = (
      await get(otherProject, `/funnel/breakdown${query(SIGNUP_PURCHASE, "&by=browser")}`)
    ).json().rows;
    expect(rows).toEqual([
      { kind: "value", value: "Chrome", reached: [2, 1] },
      { kind: "unknown", value: null, reached: [2, 0] },
    ]);
  });
});

/** The people at a step of signup, purchase, invite, counted by users within the hour. */
const people = (step: number, outcome: string, rest = "&count=users&window=3600") =>
  `/funnel/people${query(SIGNUP_PURCHASE_INVITE, `${rest}&step=${step}&outcome=${outcome}`)}`;

describe("GET /api/projects/:id/funnel/people", () => {
  test("those who dropped off after step 1: the 100 most recent, and how many in all", async () => {
    const response = await get(peopleProject, people(1, "dropped"));
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ step: 1, outcome: "dropped", limit: 100, total: DROPPED });
    expect(body.users).toHaveLength(100);
    expect(body.users[0]).toEqual({
      userId: "dropped-0",
      reachedAt: minutesAgo(1).toISOString(),
    });
    expect(body.users.at(-1).userId).toBe("dropped-99");
    // Another project's users, even with the same ID, are not here.
    expect(body.users.some((user: { userId: string }) => user.userId === "intruder")).toBe(false);
  });

  test("dropped off after a later step, and converted at the last", async () => {
    const dropped = (await get(peopleProject, people(2, "dropped"))).json();
    expect(dropped).toMatchObject({ total: 1, users: [{ userId: "bought" }] });
    const converted = (await get(peopleProject, people(3, "converted"))).json();
    expect(converted).toMatchObject({
      total: 1,
      users: [{ userId: "converted", reachedAt: minutesAgo(180).toISOString() }],
    });
    const other = (await get(otherProject, people(1, "dropped"))).json();
    expect(other.users.map((user: { userId: string }) => user.userId).toSorted()).toEqual([
      "dropped-0",
      "intruder",
    ]);
  });

  test("refuses visitors, and an outcome that does not fit the step", async () => {
    const visitors = await get(peopleProject, people(1, "dropped", "&window=3600"));
    expect(visitors.statusCode).toBe(400);
    expect(visitors.json().error).toBe("people_need_users");
    for (const [step, outcome] of [
      [3, "dropped"],
      [1, "converted"],
      [4, "dropped"],
      [0, "dropped"],
      [1, "left"],
    ] as const) {
      const response = await get(peopleProject, people(step, outcome));
      expect({ step, outcome, status: response.statusCode }).toEqual({
        step,
        outcome,
        status: 400,
      });
    }
  });

  test("needs the users area as well as product analytics", async () => {
    const member = async (email: string, users: "none" | "view", product: "none" | "view") =>
      (
        await signedInUser(dashboard, {
          name: email,
          email,
          grants: {
            projects: [peopleProject],
            areas: { product_analytics: product, users },
          },
        })
      ).cookie;
    const productOnly = await member("product@example.com", "none", "view");
    const refused = await get(peopleProject, people(1, "dropped"), productOnly);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("forbidden");
    // The funnel itself is still theirs.
    expect(
      (
        await get(
          peopleProject,
          `/funnel${query(SIGNUP_PURCHASE, "&count=users&window=3600")}`,
          productOnly,
        )
      ).statusCode,
    ).toBe(200);
    const usersOnly = await member("users@example.com", "view", "none");
    expect((await get(peopleProject, people(1, "dropped"), usersOnly)).statusCode).toBe(403);
    const both = await member("both@example.com", "view", "view");
    expect((await get(peopleProject, people(1, "dropped"), both)).statusCode).toBe(200);
  });
});
