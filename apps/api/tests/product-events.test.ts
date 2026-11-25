import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { NewEvent } from "../src/collection/event-store.ts";
import { signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/** Noon on 17 November 2026 in UTC, the instance's timezone. */
const NOW = new Date("2026-11-17T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
/** Nothing in the period before. */
const NONE = { events: 0, visitors: 0, users: 0 };

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let projectId = "";

function event(name: string, more: Partial<NewEvent> = {}): NewEvent {
  return {
    eventId: randomUUID(),
    name,
    occurredAt: hoursAgo(2),
    path: "/",
    visitorId: "1",
    ...more,
  };
}

function get(path: string) {
  return dashboard.app.inject({
    url: `/api/projects/${projectId}${path}`,
    headers: { cookie: dashboard.cookie },
  });
}

beforeAll(async () => {
  dashboard = await signedInDashboard({ now: () => NOW });
  projectId = (
    await insertProject(dashboard.db, {
      name: "App",
    })
  ).id;
  await dashboard.store(projectId, [
    event("signup", { properties: { plan: "team", seats: 5, trial: true }, userId: "ada" }),
    event("signup", { properties: { plan: "team", seats: 2, trial: false }, visitorId: "2" }),
    event("signup", {
      properties: { plan: "free", seats: 5, coupon: null, "a.b": "x" },
      visitorId: "3",
      occurredAt: hoursAgo(26),
    }),
    // From the site's server: a user, no visitor.
    event("invoice_paid", { userId: "ada", visitorId: undefined, properties: { amount: 49 } }),
    // An event a site named "error" itself, without an error's details.
    event("error", { properties: { where: "checkout" } }),
    // The tracker's own: never product events.
    event("pageview"),
    event("engagement", { properties: { engagedMs: 5000 } }),
    event("vitals", { properties: { lcp: 1200 } }),
    event("error", {
      error: {
        type: "TypeError",
        message: "x",
        handled: false,
        fingerprint: "1-0123456789abcdef0123",
      },
    }),
    // Staging's own.
    event("signup", { environment: "staging", properties: { plan: "team" } }),
  ]);
});

afterAll(async () => {
  await dashboard?.close();
});

describe("GET /api/projects/:id/events", () => {
  test("lists the product events, most frequent first, with visitors and users", async () => {
    const response = await get("/events?period=7d");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      environment: "production",
      environments: ["production", "staging"],
      firstDay: "2026-11-11",
      lastDay: "2026-11-17",
    });
    expect(body.events).toEqual([
      { name: "signup", events: 3, visitors: 3, users: 1, previous: NONE },
      { name: "error", events: 1, visitors: 1, users: 0, previous: NONE },
      { name: "invoice_paid", events: 1, visitors: 0, users: 1, previous: NONE },
    ]);
  });

  test("counts one environment at a time", async () => {
    const body = (await get("/events?period=7d&environment=staging")).json();
    expect(body.events).toEqual([
      { name: "signup", events: 1, visitors: 1, users: 0, previous: NONE },
    ]);
  });
});

describe("the period before", () => {
  let other = "";
  const read = (path: string) =>
    dashboard.app.inject({
      url: `/api/projects/${other}${path}`,
      headers: { cookie: dashboard.cookie },
    });
  /** 7d from noon on the 17th runs from the 11th: the period before is the 4th to the 10th, up to noon. */
  const BEFORE = {
    firstDay: "2026-11-04",
    lastDay: "2026-11-10",
    until: "2026-11-10T12:00:00.000Z",
  };

  beforeAll(async () => {
    other = (await insertProject(dashboard.db, { name: "Compare" })).id;
    await dashboard.store(other, [
      ...["1", "2", "3"].map((visitorId) => event("checkout", { visitorId, userId: visitorId })),
      // The 8th: in the period before.
      event("checkout", { occurredAt: hoursAgo(9 * 24), userId: "1" }),
      // The 10th at 06:00 counts; at 18:00 it is past the moment this period has reached.
      event("checkout", { occurredAt: hoursAgo(7 * 24 + 6), visitorId: "2" }),
      event("checkout", { occurredAt: hoursAgo(7 * 24 - 6), visitorId: "3" }),
      // Only now: nothing to compare with.
      event("Invite_Sent"),
      // Only before: not listed.
      event("gone", { occurredAt: hoursAgo(9 * 24) }),
    ]);
  });

  test("lists each event's counts in the same days before, up to the same time while it runs", async () => {
    const body = (await read("/events?period=7d")).json();
    expect(body.previous).toEqual(BEFORE);
    expect(body.events).toEqual([
      {
        name: "checkout",
        events: 3,
        visitors: 3,
        users: 3,
        previous: { events: 2, visitors: 2, users: 1 },
      },
      { name: "Invite_Sent", events: 1, visitors: 1, users: 0, previous: NONE },
    ]);
  });

  test("compares a finished period with all of the one before", async () => {
    const body = (await read("/events?from=2026-11-11&to=2026-11-16")).json();
    expect(body.previous).toEqual({ firstDay: "2026-11-05", lastDay: "2026-11-10", until: null });
    expect(body.events).toEqual([]);
  });

  test("one event's counts in the period before, with its filters", async () => {
    const body = (await read("/events/checkout?period=7d")).json();
    expect(body.previous).toEqual({ ...BEFORE, events: 2, visitors: 2, users: 1 });
    const filtered = (await read("/events/checkout?period=7d&p.plan=team")).json();
    expect(filtered.previous).toEqual({ ...BEFORE, ...NONE });
  });

  test("searches the names for a part of one, in any case", async () => {
    const names = async (search: string) =>
      (await read(`/events?period=7d&search=${encodeURIComponent(search)}`))
        .json()
        .events.map((item: { name: string }) => item.name);
    expect(await names("invite")).toEqual(["Invite_Sent"]);
    expect(await names("OUT")).toEqual(["checkout"]);
    expect(await names("gone")).toEqual([]);
    expect(await names("")).toEqual(["checkout", "Invite_Sent"]);
    expect((await read("/events?period=7d&search=%01")).statusCode).toBe(400);
    expect((await read(`/events?period=7d&search=${"x".repeat(201)}`)).statusCode).toBe(400);
  });
});

describe("GET /api/projects/:id/events/:name", () => {
  test("gives one event's counts, days, and properties with their values", async () => {
    const body = (await get("/events/signup?period=7d")).json();
    expect(body).toMatchObject({ name: "signup", events: 3, visitors: 3, users: 1, filters: [] });
    expect(body.days.slice(-2)).toEqual([
      { day: "2026-11-16", events: 1 },
      { day: "2026-11-17", events: 2 },
    ]);
    const property = (key: string) =>
      body.properties.find((item: { key: string }) => item.key === key);
    expect(property("plan")).toEqual({
      key: "plan",
      events: 3,
      values: [
        { value: "team", events: 2 },
        { value: "free", events: 1 },
      ],
    });
    // Numbers, true, false, and null as JSON writes them.
    expect(property("seats").values).toEqual([
      { value: "5", events: 2 },
      { value: "2", events: 1 },
    ]);
    expect(property("trial").values).toEqual([
      { value: "false", events: 1 },
      { value: "true", events: 1 },
    ]);
    expect(property("coupon").values).toEqual([{ value: "null", events: 1 }]);
  });

  test("filters by properties, all of them, compared as text", async () => {
    const team = (await get("/events/signup?period=7d&p.plan=team")).json();
    expect(team).toMatchObject({ events: 2, filters: [{ key: "plan", value: "team" }] });
    expect(team.properties.find((item: { key: string }) => item.key === "plan").values).toEqual([
      { value: "team", events: 2 },
    ]);

    expect((await get("/events/signup?period=7d&p.seats=5")).json().events).toBe(2);
    expect((await get("/events/signup?period=7d&p.seats=5&p.plan=team")).json().events).toBe(1);
    expect((await get("/events/signup?period=7d&p.trial=true")).json().events).toBe(1);
    // A property name with a dot in it.
    expect((await get("/events/signup?period=7d&p.a.b=x")).json().events).toBe(1);
  });

  test("answers zeros when nothing matches, not an error", async () => {
    const body = (await get("/events/signup?period=7d&p.plan=enterprise")).json();
    expect(body).toMatchObject({ events: 0, visitors: 0, users: 0, properties: [] });
    expect((await get("/events/never_sent?period=7d")).json().events).toBe(0);
  });

  test("never counts the tracker's own events as product events", async () => {
    for (const name of ["pageview", "engagement", "vitals"]) {
      expect((await get(`/events/${name}?period=7d`)).json().events).toBe(0);
    }
    // Only the "error" a site named itself: not the error with details.
    expect((await get("/events/error?period=7d")).json().events).toBe(1);
  });

  test("refuses too many filters, or a name with control characters", async () => {
    const six = Array.from({ length: 6 }, (_, index) => `p.k${index}=v`).join("&");
    expect((await get(`/events/signup?period=7d&${six}`)).statusCode).toBe(400);
    expect((await get("/events/sign%01up?period=7d")).statusCode).toBe(400);
  });
});

describe("property filters, at their edges", () => {
  let other = "";
  const read = (path: string) =>
    dashboard.app.inject({
      url: `/api/projects/${other}${path}`,
      headers: { cookie: dashboard.cookie },
    });

  beforeAll(async () => {
    other = (
      await insertProject(dashboard.db, {
        name: "Edges",
      })
    ).id;
    await dashboard.store(other, [
      event("checkout", { properties: { coupon: "" } }),
      event("checkout", { properties: {} }),
      event("checkout", { properties: { "tab\tname": "x" } }),
    ]);
  });

  test("an empty value matches only events that have the property, empty", async () => {
    expect((await read("/events/checkout?period=7d&p.coupon=")).json().events).toBe(1);
  });

  test("a property name collection allowed can be filtered by, odd as it is", async () => {
    const name = encodeURIComponent("p.tab\tname");
    expect((await read(`/events/checkout?period=7d&${name}=x`)).json().events).toBe(1);
  });

  test("refuses a filter it cannot use, rather than dropping it", async () => {
    const tooLong = `p.${"k".repeat(101)}=v`;
    const response = await read(`/events/checkout?period=7d&${tooLong}`);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_filter");
    expect((await read("/events/checkout?period=7d&p.=v")).statusCode).toBe(400);
  });
});
