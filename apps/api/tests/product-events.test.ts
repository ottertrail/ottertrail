import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { NewEvent } from "../src/collection/event-store.ts";
import { signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/** Noon on 17 November 2026 in UTC, the instance's timezone. */
const NOW = new Date("2026-11-17T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

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
      { name: "signup", events: 3, visitors: 3, users: 1 },
      { name: "error", events: 1, visitors: 1, users: 0 },
      { name: "invoice_paid", events: 1, visitors: 0, users: 1 },
    ]);
  });

  test("counts one environment at a time", async () => {
    const body = (await get("/events?period=7d&environment=staging")).json();
    expect(body.events).toEqual([{ name: "signup", events: 1, visitors: 1, users: 0 }]);
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
