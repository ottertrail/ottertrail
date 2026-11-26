import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { NewEvent } from "../src/collection/event-store.ts";
import { fingerprint } from "../src/errors/fingerprint.ts";
import { signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { storedEvents } from "./helpers/events.ts";
import { insertProject } from "./helpers/projects.ts";
import { keyValues, secretKeyOf } from "./helpers/telemetry.ts";

/**
 * Browser events linked to server traces (docs/telemetry.md, "The browser
 * and the server"): what collection takes and stores, an error's requests,
 * a trace's browser part and who sees what of it, and a server span under
 * the browser's request listed as a root.
 */

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const SITE = "shop.example";
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let project: { id: string; public_key: string };

beforeAll(async () => {
  dashboard = await signedInDashboard();
  project = await insertProject(dashboard.db, { name: "Shop", allowed_hostnames: [SITE] });
});

afterAll(async () => {
  await dashboard?.close();
});

const CART_ERROR = { type: "TypeError", message: "cart is undefined" };

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    name: "pageview",
    occurredAt: Date.now() - 1000,
    url: `https://${SITE}/checkout`,
    ...overrides,
  };
}

function send(events: unknown[]) {
  return dashboard.app.inject({
    method: "POST",
    url: "/api/events",
    headers: { "content-type": "text/plain", "user-agent": CHROME_MAC },
    payload: JSON.stringify({
      v: 1,
      key: project.public_key,
      sentAt: Date.now(),
      release: "2.0.1",
      events,
    }),
    remoteAddress: "203.0.113.10",
  });
}

function get(path: string, cookie = dashboard.cookie) {
  return dashboard.app.inject({
    url: `/api/projects/${project.id}${path}`,
    headers: { cookie },
  });
}

const request = (traceId: string, overrides: Record<string, unknown> = {}) => ({
  method: "POST",
  path: "/api/orders",
  status: 503,
  durationMs: 812,
  traceId,
  ...overrides,
});

describe("collection", () => {
  test("stores the page load's trace and an error's requests", async () => {
    const pageTrace = hex(16);
    const span = hex(8);
    const requestTrace = hex(16);
    const pageview = event({ traceId: pageTrace, spanId: span });
    const error = event({
      name: "error",
      traceId: pageTrace,
      spanId: span,
      error: {
        ...CART_ERROR,
        requests: [
          request(hex(16), { method: "GET", path: "/api/cart", status: 200 }),
          request(requestTrace),
        ],
      },
    });
    const response = await send([pageview, error]);
    expect(response.statusCode).toBe(202);

    const stored = await storedEvents(dashboard.reader.client, project.id);
    const byId = new Map(stored.map((row) => [row.event_id, row]));
    expect(byId.get(pageview.id)).toMatchObject({
      trace_id: pageTrace,
      span_id: span,
      service: "",
      error_requests: [],
    });
    expect(byId.get(error.id)).toMatchObject({
      trace_id: pageTrace,
      span_id: span,
      error_requests: [
        { method: "GET", path: "/api/cart", status: 200, duration_ms: 812 },
        {
          method: "POST",
          path: "/api/orders",
          status: 503,
          duration_ms: 812,
          trace_id: requestTrace,
        },
      ],
    });
  });

  test.each([
    ["a trace ID in uppercase", { traceId: hex(16).toUpperCase(), spanId: hex(8) }],
    ["an all-zero trace ID", { traceId: "0".repeat(32), spanId: hex(8) }],
    ["an all-zero span ID", { traceId: hex(16), spanId: "0".repeat(16) }],
    ["a trace without its span", { traceId: hex(16) }],
    ["a span without its trace", { spanId: hex(8) }],
    ["a short span ID", { traceId: hex(16), spanId: hex(7) }],
  ])("refuses %s", async (_label, fields) => {
    const response = await send([event(fields)]);
    expect(response.statusCode).toBe(400);
  });

  test.each([
    ["six requests", Array.from({ length: 6 }, () => request(hex(16)))],
    ["a path with a query string", [request(hex(16), { path: "/api/orders?token=1" })]],
    ["a path with a fragment", [request(hex(16), { path: "/api/orders#top" })]],
    ["a path that is not one", [request(hex(16), { path: "https://shop.example/api" })]],
    ["a long path", [request(hex(16), { path: `/${"a".repeat(2048)}` })]],
    ["a lowercase method", [request(hex(16), { method: "post" })]],
    ["a status past 999", [request(hex(16), { status: 1000 })]],
    ["a duration past an hour", [request(hex(16), { durationMs: 3_600_001 })]],
    ["a bad trace ID", [request("x".repeat(32))]],
    ["a request without its trace", [{ method: "GET", path: "/", status: 200, durationMs: 1 }]],
  ])("refuses an error with %s", async (_label, requests) => {
    const response = await send([event({ name: "error", error: { ...CART_ERROR, requests } })]);
    expect(response.statusCode).toBe(400);
  });

  test("drops fields it does not know in a request, as elsewhere", async () => {
    const extra = event({
      name: "error",
      error: { ...CART_ERROR, requests: [{ ...request(hex(16)), query: "?token=secret" }] },
    });
    expect((await send([extra])).statusCode).toBe(202);
    const stored = await storedEvents(dashboard.reader.client, project.id);
    expect(JSON.stringify(stored)).not.toContain("secret");
  });
});

describe("an error's page", () => {
  test("lists each occurrence's page load trace and requests", async () => {
    const error = { type: "RangeError", message: "Invalid array length" };
    const traceId = hex(16);
    const spanId = hex(8);
    const requestTrace = hex(16);
    await dashboard.store(project.id, [
      {
        eventId: randomUUID(),
        name: "error",
        occurredAt: new Date(Date.now() - 60_000),
        path: "/checkout",
        error: {
          ...error,
          handled: false,
          fingerprint: fingerprint(error),
          requests: [
            {
              method: "GET",
              path: "/api/cart",
              status: 500,
              duration_ms: 41,
              trace_id: requestTrace,
            },
          ],
        },
        trace: { traceId, spanId },
      },
    ]);
    const response = await get(`/errors/${fingerprint(error)}?period=7d`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.source).toBe("browser");
    expect(body.occurrences[0]).toMatchObject({
      service: null,
      traceId,
      spanId,
      requests: [
        { method: "GET", path: "/api/cart", status: 500, durationMs: 41, traceId: requestTrace },
      ],
    });
  });
});

describe("a trace's browser part", () => {
  const pageTrace = hex(16);
  const pageSpan = hex(8);
  const requestTrace = hex(16);
  const replayId = randomUUID();
  const at = new Date(Date.now() - 10 * 60_000);
  const PAYMENT = { type: "Error", message: "Payment failed" };

  beforeAll(async () => {
    const base = {
      path: "/checkout",
      client: { browser: "Firefox", browserVersion: "140", os: "Linux", deviceType: "desktop" },
      release: "2.0.1",
      userId: "ada",
      visitorId: "7",
    } satisfies Partial<NewEvent>;
    await dashboard.store(project.id, [
      {
        ...base,
        eventId: randomUUID(),
        name: "pageview",
        occurredAt: new Date(at.getTime() + 300),
        trace: { traceId: pageTrace, spanId: pageSpan },
      },
      {
        ...base,
        eventId: randomUUID(),
        name: "vitals",
        occurredAt: new Date(at.getTime() + 60_000),
        trace: { traceId: pageTrace, spanId: pageSpan },
      },
      {
        ...base,
        eventId: randomUUID(),
        name: "error",
        occurredAt: new Date(at.getTime() + 2000),
        trace: { traceId: pageTrace, spanId: pageSpan },
        error: {
          ...PAYMENT,
          handled: true,
          fingerprint: fingerprint(PAYMENT),
          replayId,
          requests: [
            {
              method: "POST",
              path: "/api/pay",
              status: 502,
              duration_ms: 1200,
              trace_id: requestTrace,
            },
          ],
        },
      },
      // A server's exception in the same trace is not the browser's.
      {
        eventId: randomUUID(),
        name: "error",
        occurredAt: new Date(at.getTime() + 100),
        server: { service: "web", traceId: pageTrace, spanId: hex(8) },
        error: { ...PAYMENT, handled: false, fingerprint: fingerprint(PAYMENT) },
      },
      // The same trace in another project is never read.
    ]);
    const other = await insertProject(dashboard.db, { name: "Other" });
    await dashboard.store(other.id, [
      {
        eventId: randomUUID(),
        name: "pageview",
        occurredAt: at,
        path: "/elsewhere",
        trace: { traceId: pageTrace, spanId: pageSpan },
      },
    ]);
  });

  const browser = (traceId: string, cookie?: string, when = at) =>
    get(`/traces/${traceId}/browser?at=${when.toISOString()}`, cookie);

  test("of a page load: its pageview and its errors", async () => {
    const response = await browser(pageTrace);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      timeZone: "UTC",
      errorsHidden: false,
      usersHidden: false,
      pageLoad: {
        occurredAt: new Date(at.getTime() + 300).toISOString(),
        path: "/checkout",
        browser: "Firefox",
        browserVersion: "140",
        os: "Linux",
        release: "2.0.1",
        environment: "production",
        userId: "ada",
      },
      errors: [
        expect.objectContaining({
          fingerprint: fingerprint(PAYMENT),
          type: "Error",
          message: "Payment failed",
          path: "/checkout",
          replayId,
          request: null,
        }),
      ],
    });
  });

  test("of a request: the error that carries it, with the request", async () => {
    const body = (await browser(requestTrace)).json();
    expect(body.pageLoad).toBeNull();
    expect(body.errors).toMatchObject([
      {
        fingerprint: fingerprint(PAYMENT),
        request: { method: "POST", path: "/api/pay", status: 502, durationMs: 1200 },
      },
    ]);
  });

  test("looks only around the trace's start, and finds nothing for another trace", async () => {
    const twoDaysLater = new Date(at.getTime() + 2 * 86_400_000);
    expect((await browser(pageTrace, undefined, twoDaysLater)).json()).toMatchObject({
      pageLoad: null,
      errors: [],
    });
    expect((await browser(hex(16))).json()).toMatchObject({ pageLoad: null, errors: [] });
  });

  test("leaves out what a member's areas do not cover", async () => {
    const { cookie } = await signedInUser(dashboard, {
      name: "Mo",
      email: "monitoring-only@example.com",
      grants: { projects: "all", areas: { monitoring: "view" } },
    });
    const body = (await browser(pageTrace, cookie)).json();
    expect(body).toMatchObject({ errorsHidden: true, usersHidden: true, errors: [] });
    expect(body.pageLoad).toMatchObject({ path: "/checkout", userId: null });

    const withErrors = await signedInUser(dashboard, {
      name: "Eve",
      email: "errors-too@example.com",
      grants: { projects: "all", areas: { monitoring: "view", errors: "view" } },
    });
    const seen = (await browser(pageTrace, withErrors.cookie)).json();
    expect(seen.errors).toMatchObject([{ replayId: null, userId: null }]);

    const noMonitoring = await signedInUser(dashboard, {
      name: "Al",
      email: "no-monitoring@example.com",
      grants: { projects: "all", areas: { errors: "view" } },
    });
    expect((await browser(pageTrace, noMonitoring.cookie)).statusCode).toBe(403);
  });

  test("refuses a bad trace ID or time", async () => {
    expect((await get(`/traces/${pageTrace}/browser`)).statusCode).toBe(400);
    expect((await get(`/traces/xyz/browser?at=${at.toISOString()}`)).statusCode).toBe(400);
    expect((await get(`/traces/${pageTrace}/browser?at=yesterday`)).statusCode).toBe(400);
  });
});

describe("the traces list", () => {
  test("lists a server span under the browser's request as a root", async () => {
    const secretKey = await secretKeyOf(dashboard.db, project.id);
    const traceId = hex(16);
    const start = BigInt(Date.now() - 60_000) * 1_000_000n;
    const span = (spanId: string, parentSpanId: string, name: string) => ({
      traceId,
      spanId,
      parentSpanId,
      name,
      kind: 2,
      startTimeUnixNano: String(start),
      endTimeUnixNano: String(start + 5_000_000n),
      attributes: [],
      status: { code: 0 },
    });
    const server = hex(8);
    const response = await dashboard.app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: { "content-type": "application/json", authorization: `Bearer ${secretKey}` },
      payload: JSON.stringify({
        resourceSpans: [
          {
            resource: { attributes: keyValues({ "service.name": "web" }) },
            scopeSpans: [
              {
                scope: { name: "http" },
                spans: [
                  // Its parent is the browser's request, never sent.
                  span(server, traceId.slice(0, 16), "POST /api/orders"),
                  span(hex(8), server, "SELECT orders"),
                  // A parent that never came is not the browser's.
                  span(hex(8), hex(8), "orphan"),
                ],
              },
            ],
          },
        ],
      }),
    });
    expect(response.statusCode).toBe(200);
    const list = (await get("/traces?period=today")).json();
    const names = list.traces
      .filter((trace: { traceId: string }) => trace.traceId === traceId)
      .map((trace: { name: string }) => trace.name);
    expect(names).toEqual(["POST /api/orders"]);
    expect(list.services).toContain("web");
  });
});
