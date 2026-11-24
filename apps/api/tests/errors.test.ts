import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { NewEvent } from "../src/collection/event-store.ts";
import { fingerprint } from "../src/errors/fingerprint.ts";
import { OWNER, PUBLIC_URL, signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/** Noon on 17 November 2026 in UTC, the instance's timezone. */
const NOW = new Date("2026-11-17T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

const STACK = `TypeError: Cannot read properties of undefined (reading 'total')
    at renderCart (https://shop.example/assets/index-BfK3x9A2.js:1:2345)`;
const CART = {
  type: "TypeError",
  message: "Cannot read properties of undefined (reading 'total')",
  stack: STACK,
};
const PAYMENT = { type: "Error", message: "Payment declined" };
const CART_GROUP = fingerprint(CART);
const PAYMENT_GROUP = fingerprint(PAYMENT);

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let projectId = "";

function anError(
  error: { type: string; message: string; stack?: string },
  occurredAt: Date,
  more: Partial<NewEvent> = {},
): NewEvent {
  return {
    eventId: randomUUID(),
    name: "error",
    occurredAt,
    path: "/cart",
    visitorId: "1",
    client: { browser: "Chrome", browserVersion: "142", os: "macOS", deviceType: "desktop" },
    error: { ...error, handled: false, fingerprint: fingerprint(error) },
    ...more,
  };
}

function get(path: string) {
  return dashboard.app.inject({
    url: `/api/projects/${projectId}${path}`,
    headers: { cookie: dashboard.cookie },
  });
}

function setStatus(group: string, status: string, headers: Record<string, string> = {}) {
  return dashboard.app.inject({
    method: "PATCH",
    url: `/api/projects/${projectId}/errors/${group}`,
    headers: { cookie: dashboard.cookie, origin: PUBLIC_URL, ...headers },
    payload: { status },
  });
}

beforeAll(async () => {
  dashboard = await signedInDashboard({ now: () => NOW });
  projectId = (
    await insertProject(dashboard.db, {
      name: "Shop",
    })
  ).id;
  await dashboard.store(projectId, [
    // Visitor 1, signed in as user 42, views the cart and hits the error twice.
    {
      eventId: randomUUID(),
      name: "pageview",
      occurredAt: hoursAgo(3),
      path: "/cart",
      visitorId: "1",
      userId: "42",
    },
    anError(CART, hoursAgo(3), { userId: "42", release: "1.4.2" }),
    anError(CART, hoursAgo(2), { userId: "42", release: "1.4.2" }),
    // Visitor 2, anonymous, on another page, in Firefox, a day earlier.
    anError(CART, hoursAgo(26), {
      visitorId: "2",
      path: "/checkout",
      client: { browser: "Firefox", browserVersion: "140", os: "Windows", deviceType: "desktop" },
    }),
    // Caught by the site, three days ago.
    anError(PAYMENT, hoursAgo(72), {
      error: { ...PAYMENT, handled: true, fingerprint: PAYMENT_GROUP },
    }),
    // The same cart error on staging.
    anError(CART, hoursAgo(1), { environment: "staging" }),
  ]);
});

afterAll(async () => {
  await dashboard?.close();
});

describe("GET /api/projects/:id/errors", () => {
  test("lists the groups seen in the range, latest first, with their counts", async () => {
    const response = await get("/errors?period=7d");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      environment: "production",
      firstDay: "2026-11-11",
      lastDay: "2026-11-17",
      status: "unresolved",
      truncated: false,
    });
    expect(body.groups).toMatchObject([
      {
        fingerprint: CART_GROUP,
        type: "TypeError",
        message: CART.message,
        occurrences: 3,
        users: 1,
        visitors: 2,
        firstSeen: hoursAgo(26).toISOString(),
        lastSeen: hoursAgo(2).toISOString(),
        status: "unresolved",
        resolvedAt: null,
      },
      { fingerprint: PAYMENT_GROUP, occurrences: 1, users: 0, visitors: 1 },
    ]);
  });

  test("counts one environment at a time, and lists those to switch to", async () => {
    expect((await get("/errors?period=7d")).json().environments).toEqual(["production", "staging"]);
    const body = (await get("/errors?period=7d&environment=staging")).json();
    expect(body.groups).toMatchObject([{ fingerprint: CART_GROUP, occurrences: 1 }]);
    expect((await get("/errors?period=7d&environment=preview")).json()).toMatchObject({
      groups: [],
      environments: ["production", "staging", "preview"],
    });
  });

  test("counts only the range, but knows when each group was first seen", async () => {
    const body = (await get("/errors?period=today")).json();
    expect(body.groups).toMatchObject([
      { fingerprint: CART_GROUP, occurrences: 2, firstSeen: hoursAgo(26).toISOString() },
    ]);
  });

  test("says whether the project has any error at all, beyond the list's filters", async () => {
    expect((await get("/errors?period=7d")).json()).toMatchObject({ received: true });
    // None in this environment, or resolved, but the project has errors.
    expect((await get("/errors?period=7d&environment=preview")).json()).toMatchObject({
      groups: [],
      received: true,
    });
    expect((await get("/errors?period=7d&status=resolved")).json()).toMatchObject({
      groups: [],
      received: true,
    });
    const quiet = (await insertProject(dashboard.db, { name: "Quiet" })).id;
    const answer = await dashboard.app.inject({
      url: `/api/projects/${quiet}/errors?period=7d`,
      headers: { cookie: dashboard.cookie },
    });
    expect(answer.json()).toMatchObject({ groups: [], received: false });
  });

  test("refuses a bad range or status", async () => {
    expect((await get("/errors?period=7d&from=2026-11-01")).statusCode).toBe(400);
    expect((await get("/errors?period=7d&status=open")).statusCode).toBe(400);
  });
});

describe("GET /api/projects/:id/errors/:fingerprint", () => {
  test("shows one group: each day, where it happens, and its latest occurrences", async () => {
    const response = await get(`/errors/${CART_GROUP}?period=7d`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.group).toMatchObject({ fingerprint: CART_GROUP, occurrences: 3 });
    expect(body.days).toHaveLength(7);
    expect(body.days.slice(-2)).toEqual([
      { day: "2026-11-16", occurrences: 1 },
      { day: "2026-11-17", occurrences: 2 },
    ]);
    expect(body.breakdowns.path).toEqual([
      { value: "/cart", occurrences: 2 },
      { value: "/checkout", occurrences: 1 },
    ]);
    expect(body.breakdowns.browser).toEqual([
      { value: "Chrome", occurrences: 2 },
      { value: "Firefox", occurrences: 1 },
    ]);
    expect(body.breakdowns.release).toEqual([
      { value: "1.4.2", occurrences: 2 },
      { value: null, occurrences: 1 },
    ]);
    expect(
      body.occurrences.map((occurrence: { occurredAt: string }) => occurrence.occurredAt),
    ).toEqual([hoursAgo(2), hoursAgo(3), hoursAgo(26)].map((time) => time.toISOString()));
    expect(body.occurrences[0]).toMatchObject({
      userId: "42",
      path: "/cart",
      browser: "Chrome",
      release: "1.4.2",
      handled: false,
      message: CART.message,
    });
    expect(body.stack).toBe(STACK);
  });

  test("has no stack when the browser gave none", async () => {
    const body = (await get(`/errors/${PAYMENT_GROUP}?period=7d`)).json();
    expect(body.stack).toBeNull();
    expect(body.occurrences[0].handled).toBe(true);
  });

  test("is not found outside its range or environment, or for an unknown group", async () => {
    const none = await get(`/errors/${PAYMENT_GROUP}?period=today`);
    expect(none.statusCode).toBe(404);
    expect(none.json().error).toBe("no_occurrences");
    expect((await get(`/errors/${PAYMENT_GROUP}?period=7d&environment=staging`)).statusCode).toBe(
      404,
    );
    expect((await get("/errors/1-0123456789abcdef0123?period=7d")).statusCode).toBe(404);
    expect((await get("/errors/not-a-fingerprint?period=7d")).statusCode).toBe(400);
  });
});

describe("resolving", () => {
  test("a resolved group leaves the list until it happens again", async () => {
    const resolved = await setStatus(PAYMENT_GROUP, "resolved");
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().resolvedAt).toEqual(expect.any(String));

    const open = (await get("/errors?period=7d")).json().groups;
    expect(open.map((group: { fingerprint: string }) => group.fingerprint)).toEqual([CART_GROUP]);
    const done = (await get("/errors?period=7d&status=resolved")).json().groups;
    expect(done).toMatchObject([
      { fingerprint: PAYMENT_GROUP, status: "resolved", resolvedBy: OWNER.name },
    ]);

    // It happens again: back in the list, as a regression.
    await dashboard.store(projectId, [anError(PAYMENT, new Date(Date.now() + 60_000))]);
    const again = (await get("/errors?period=7d")).json().groups;
    expect(again).toContainEqual(
      expect.objectContaining({ fingerprint: PAYMENT_GROUP, status: "regressed" }),
    );
  });

  test("a status belongs to the project: happening again anywhere is a regression everywhere", async () => {
    // Its own group, seen only in production, well before the real clock's now.
    const slow = { type: "RangeError", message: "Too slow" };
    const group = fingerprint(slow);
    await dashboard.store(projectId, [anError(slow, hoursAgo(30))]);
    await setStatus(group, "resolved");
    const resolved = (await get("/errors?period=7d&status=resolved")).json().groups;
    expect(resolved).toContainEqual(expect.objectContaining({ fingerprint: group }));

    await dashboard.store(projectId, [
      anError(slow, new Date(Date.now() + 60_000), { environment: "staging" }),
    ]);
    // Production saw nothing new, but the group is back in its list too.
    const production = (await get("/errors?period=7d")).json().groups;
    expect(production).toContainEqual(
      expect.objectContaining({ fingerprint: group, status: "regressed" }),
    );
  });

  test("an event a site named error before errors existed stays a custom event", async () => {
    const other = await insertProject(dashboard.db, {
      name: "Old events",
    });
    await dashboard.store(other.id, [
      {
        eventId: randomUUID(),
        name: "pageview",
        occurredAt: hoursAgo(5),
        path: "/",
        visitorId: "9",
      },
      { eventId: randomUUID(), name: "error", occurredAt: hoursAgo(4), path: "/", visitorId: "9" },
    ]);
    const read = (path: string) =>
      dashboard.app.inject({
        url: `/api/projects/${other.id}${path}`,
        headers: { cookie: dashboard.cookie },
      });
    expect((await read("/errors?period=7d")).json().groups).toEqual([]);
    expect((await read("/analytics?period=7d")).json().customEvents).toMatchObject([
      { name: "error", events: 1 },
    ]);
  });

  test("reopening makes it unresolved", async () => {
    await setStatus(CART_GROUP, "resolved");
    const reopened = await setStatus(CART_GROUP, "unresolved");
    expect(reopened.json()).toEqual({ fingerprint: CART_GROUP, resolvedAt: null });
    const body = (await get(`/errors/${CART_GROUP}?period=7d`)).json();
    expect(body.group).toMatchObject({ status: "unresolved", resolvedAt: null });
  });

  test("needs the dashboard's origin and a known status", async () => {
    expect(
      (await setStatus(CART_GROUP, "resolved", { origin: "https://evil.example" })).statusCode,
    ).toBe(403);
    expect((await setStatus(CART_GROUP, "ignored")).statusCode).toBe(400);
  });
});

describe("errors and the rest of the project", () => {
  test("are not web analytics: no visit, page, or custom event comes from them", async () => {
    const body = (await get("/analytics?period=7d")).json();
    // Visitor 1's pageview is the only visit; visitor 2 only had an error.
    expect(body.summary).toMatchObject({ visits: 1, visitors: 1, pageviews: 1 });
    expect(body.customEvents).toEqual([]);
  });

  test("show in the user's activity, with their group", async () => {
    const body = (await get("/users/42")).json();
    expect(body.activity).toContainEqual(
      expect.objectContaining({
        name: "error",
        path: "/cart",
        error: { type: "TypeError", message: CART.message, fingerprint: CART_GROUP },
      }),
    );
    expect(
      body.activity.find((item: { name: string }) => item.name === "pageview").error,
    ).toBeNull();
  });
});
