import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";
import { keyValues, secretKeyOf } from "./helpers/telemetry.ts";

/**
 * The Services page's p99 and status classes, and a service's and route's
 * charts (GET /api/projects/:id/services/chart), on spans sent over OTLP.
 * Every number is worked out by hand in the comments.
 */

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;

const MS = 1_000_000n;
/** Yesterday, in UTC (the instance's timezone): a whole day, so 288 buckets of 5 minutes. */
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const DAY = `from=${YESTERDAY}&to=${YESTERDAY}`;
/** Seven days ending yesterday: buckets of an hour. */
const WEEK_START = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
const WEEK = `from=${WEEK_START}&to=${YESTERDAY}`;
const at = (time: string) => BigInt(Date.parse(`${YESTERDAY}T${time}Z`)) * MS;
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/** A value as the tests compare them: 4 decimals. */
const round = (value: number) => Math.round(value * 10_000) / 10_000;
const rounded = (value: number | null) => (value === null ? null : round(value));

let shop = { id: "", secretKey: "" };

function span(
  name: string,
  time: string,
  durationMs: number,
  attributes: Record<string, string | number>,
  extra: object = {},
) {
  const start = at(time);
  return {
    traceId: hex(16),
    spanId: hex(8),
    parentSpanId: "",
    name,
    kind: 2,
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(start + BigInt(durationMs) * MS),
    attributes: keyValues(attributes),
    status: { code: 0 },
    ...extra,
  };
}

const ORDERS = { "http.route": "/orders/{id}" };

/**
 * The shop's requests, yesterday. /orders/{id} (http.route):
 *
 *   1. 10:00:10, 10 ms, http.response.status_code 200 (int)   2xx
 *   2. 10:01:00, 20 ms, http.response.status_code 201         2xx
 *   3. 10:02:00, 30 ms, http.status_code "404" (older, text)  4xx
 *   4. 10:06:00, 40 ms, both: 503 and 200, failed             5xx (the newer name wins)
 *   5. 10:07:00, 50 ms, 301                                   3xx
 *   6. 10:08:00, 1,000 ms, no status code                     none
 *
 * GET /health (no http.route, so its name):
 *
 *   7. 10:03:00, 5 ms, http.response.status_code "OK"         none (not a number)
 *   8. 10:09:00, 15 ms, http.status_code 200                  2xx
 *
 * Plus a client span (not a request) and a span in staging (not production's).
 */
const SHOP_SPANS = [
  span("GET /orders/{id}", "10:00:10", 10, { ...ORDERS, "http.response.status_code": 200 }),
  span("GET /orders/{id}", "10:01:00", 20, { ...ORDERS, "http.response.status_code": 201 }),
  span("GET /orders/{id}", "10:02:00", 30, { ...ORDERS, "http.status_code": "404" }),
  span(
    "GET /orders/{id}",
    "10:06:00",
    40,
    { ...ORDERS, "http.response.status_code": 503, "http.status_code": 200 },
    { status: { code: 2 } },
  ),
  span("GET /orders/{id}", "10:07:00", 50, { ...ORDERS, "http.response.status_code": 301 }),
  span("GET /orders/{id}", "10:08:00", 1000, ORDERS),
  span("GET /health", "10:03:00", 5, { "http.response.status_code": "OK" }),
  span("GET /health", "10:09:00", 15, { "http.status_code": 200 }),
  span("SELECT orders", "10:04:00", 7, {}, { kind: 3 }),
];

async function send(secretKey: string, service: string, spans: object[], environment?: string) {
  const response = await dashboard.app.inject({
    method: "POST",
    url: "/v1/traces",
    headers: { "content-type": "application/json", authorization: `Bearer ${secretKey}` },
    payload: JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: keyValues({
              "service.name": service,
              ...(environment === undefined ? {} : { "deployment.environment.name": environment }),
            }),
          },
          scopeSpans: [{ spans }],
        },
      ],
    }),
  });
  expect({ status: response.statusCode, body: response.json() }).toEqual({ status: 200, body: {} });
}

function get(projectId: string, path: string, { signedIn = true } = {}) {
  return dashboard.app.inject({
    url: `/api/projects/${projectId}${path}`,
    headers: signedIn ? { cookie: dashboard.cookie } : {},
  });
}

async function getJson(projectId: string, path: string) {
  const response = await get(projectId, path);
  expect({ path, status: response.statusCode, body: response.json() }).toMatchObject({
    path,
    status: 200,
  });
  return response.json();
}

const chartPath = (query: string, service: string, route?: string) =>
  `/services/chart?${query}&service=${encodeURIComponent(service)}${
    route === undefined ? "" : `&route=${encodeURIComponent(route)}`
  }`;

const STATUS_NAMES = ["2xx", "3xx", "4xx", "5xx", "none"] as const;

interface Chart {
  start: string;
  stepSeconds: number;
  buckets: number;
  totals: Record<string, unknown> & { requests: number; failed: number };
  counts: {
    requests: number[];
    failed: number[];
    statuses: Record<(typeof STATUS_NAMES)[number], number[]>;
  };
  perSecond: Record<(typeof STATUS_NAMES)[number], (number | null)[]>;
  failedShare: (number | null)[];
  durations: Record<"p50Us" | "p95Us" | "p99Us", (number | null)[]>;
}

/** The buckets with a request, as [index, value] pairs. */
const busy = (chart: Chart, values: (number | null)[]) =>
  values
    .map((value, index) => [index, rounded(value)] as const)
    .filter(([index]) => (chart.counts.requests[index] ?? 0) > 0);

/** A service's or route's numbers with its durations rounded (Float64 interpolation is not exact). */
function roundedStats<T extends { p50Us: number; p95Us: number; p99Us: number }>(stats: T): T {
  return {
    ...stats,
    p50Us: round(stats.p50Us),
    p95Us: round(stats.p95Us),
    p99Us: round(stats.p99Us),
  };
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

beforeAll(async () => {
  dashboard = await signedInDashboard();
  const project = await insertProject(dashboard.db, { name: "Shop" });
  shop = { id: project.id, secretKey: await secretKeyOf(dashboard.db, project.id) };
  await send(shop.secretKey, "shop", SHOP_SPANS);
  await send(
    shop.secretKey,
    "shop",
    [span("GET /orders/{id}", "10:00:00", 9999, { ...ORDERS, "http.response.status_code": 500 })],
    "staging",
  );
});

afterAll(async () => {
  await dashboard?.close();
});

describe("the Services page's columns", () => {
  test("gives the 99th percentile and the requests by status class, from either attribute", async () => {
    const list = await getJson(shop.id, `/services?${DAY}`);
    // Durations, interpolated at q × (n − 1) between the two nearest:
    //   the service, 5 10 15 20 30 40 50 1000 ms (n = 8): p50 at 3.5, 20 + 0.5 × 10 = 25;
    //     p95 at 6.65, 50 + 0.65 × 950 = 667.5; p99 at 6.93, 50 + 0.93 × 950 = 933.5.
    //   /orders/{id}, 10 20 30 40 50 1000 (n = 6): p50 at 2.5, 35; p95 at 4.75,
    //     50 + 0.75 × 950 = 762.5; p99 at 4.95, 50 + 0.95 × 950 = 952.5.
    //   GET /health, 5 15 (n = 2): p50 10; p95 5 + 0.95 × 10 = 14.5; p99 14.9.
    const services = list.services.map(
      (service: { p50Us: number; p95Us: number; p99Us: number; routes: never[] }) => ({
        ...roundedStats(service),
        routes: service.routes.map(roundedStats),
      }),
    );
    expect(services).toEqual([
      {
        service: "shop",
        requests: 8,
        failed: 1,
        p50Us: 25_000,
        p95Us: 667_500,
        p99Us: 933_500,
        statuses: { "2xx": 3, "3xx": 1, "4xx": 1, "5xx": 1, none: 2 },
        routeCount: 2,
        routes: [
          {
            route: "/orders/{id}",
            requests: 6,
            failed: 1,
            p50Us: 35_000,
            p95Us: 762_500,
            p99Us: 952_500,
            statuses: { "2xx": 2, "3xx": 1, "4xx": 1, "5xx": 1, none: 1 },
          },
          {
            route: "GET /health",
            requests: 2,
            failed: 0,
            p50Us: 10_000,
            p95Us: 14_500,
            p99Us: 14_900,
            statuses: { "2xx": 1, "3xx": 0, "4xx": 0, "5xx": 0, none: 1 },
          },
        ],
      },
    ]);
  });
});

describe("GET /api/projects/:id/services/chart", () => {
  test("a service over a day, in 5-minute buckets, worked out by hand", async () => {
    const chart: Chart = await getJson(shop.id, chartPath(DAY, "shop"));
    expect(chart).toMatchObject({
      service: "shop",
      route: null,
      timeZone: "UTC",
      environment: "production",
      environments: ["production", "staging"],
      start: `${YESTERDAY}T00:00:00.000Z`,
      stepSeconds: 300,
      buckets: 288,
    });
    // 10:00–10:05 is bucket 120: spans 1, 2, 3, 7 (10, 20, 30, 5 ms).
    // 10:05–10:10 is bucket 121: spans 4, 5, 6, 8 (40, 50, 1000, 15 ms).
    expect(busy(chart, chart.counts.requests)).toEqual([
      [120, 4],
      [121, 4],
    ]);
    expect(busy(chart, chart.counts.statuses["2xx"])).toEqual([
      [120, 2],
      [121, 1],
    ]);
    expect(busy(chart, chart.counts.statuses["3xx"])).toEqual([
      [120, 0],
      [121, 1],
    ]);
    expect(busy(chart, chart.counts.statuses["4xx"])).toEqual([
      [120, 1],
      [121, 0],
    ]);
    expect(busy(chart, chart.counts.statuses["5xx"])).toEqual([
      [120, 0],
      [121, 1],
    ]);
    expect(busy(chart, chart.counts.statuses.none)).toEqual([
      [120, 1],
      [121, 1],
    ]);
    // Per second over the bucket's 300 seconds: 2 / 300 and 1 / 300.
    expect(busy(chart, chart.perSecond["2xx"])).toEqual([
      [120, rounded(2 / 300)],
      [121, rounded(1 / 300)],
    ]);
    // A bucket without a request is 0 per second, not a gap.
    expect(chart.perSecond["2xx"][0]).toBe(0);
    // One of four failed in bucket 121; none in 120; no request elsewhere: null.
    expect(busy(chart, chart.failedShare)).toEqual([
      [120, 0],
      [121, 0.25],
    ]);
    expect(chart.failedShare[0]).toBeNull();
    // Bucket 120, 5 10 20 30 ms: p50 at 1.5, 15; p95 at 2.85, 20 + 0.85 × 10 = 28.5; p99 29.7.
    // Bucket 121, 15 40 50 1000 ms: p50 45; p95 50 + 0.85 × 950 = 857.5; p99 50 + 0.97 × 950 = 971.5.
    expect(busy(chart, chart.durations.p50Us)).toEqual([
      [120, 15_000],
      [121, 45_000],
    ]);
    expect(busy(chart, chart.durations.p95Us)).toEqual([
      [120, 28_500],
      [121, 857_500],
    ]);
    expect(busy(chart, chart.durations.p99Us)).toEqual([
      [120, 29_700],
      [121, 971_500],
    ]);
    expect(chart.durations.p95Us[0]).toBeNull();
  });

  test("a route's chart reads only its requests", async () => {
    const chart: Chart = await getJson(shop.id, chartPath(DAY, "shop", "/orders/{id}"));
    expect(chart).toMatchObject({ service: "shop", route: "/orders/{id}" });
    // Bucket 120: spans 1, 2, 3 (10, 20, 30 ms): p50 20, p95 at 1.9, 29; p99 at 1.98, 29.8.
    // Bucket 121: spans 4, 5, 6 (40, 50, 1000 ms): p50 50, p95 at 1.9, 50 + 0.9 × 950 = 905;
    // p99 at 1.98, 50 + 0.98 × 950 = 981.
    expect(busy(chart, chart.counts.requests)).toEqual([
      [120, 3],
      [121, 3],
    ]);
    expect(busy(chart, chart.durations.p95Us)).toEqual([
      [120, 29_000],
      [121, 905_000],
    ]);
    expect(busy(chart, chart.durations.p99Us)).toEqual([
      [120, 29_800],
      [121, 981_000],
    ]);
    expect(busy(chart, chart.failedShare)).toEqual([
      [120, 0],
      [121, rounded(1 / 3)],
    ]);
    // A route that sent nothing: every bucket empty, totals zero.
    const quiet: Chart = await getJson(shop.id, chartPath(DAY, "shop", "/nothing"));
    expect(sum(quiet.counts.requests)).toBe(0);
    expect(quiet.totals).toMatchObject({ requests: 0, failed: 0, p95Us: 0 });
    expect(quiet.buckets).toBe(288);
  });

  test("seven days are hourly buckets: 10:00 yesterday is bucket 6 × 24 + 10", async () => {
    const chart: Chart = await getJson(shop.id, chartPath(WEEK, "shop"));
    expect(chart).toMatchObject({
      start: `${WEEK_START}T00:00:00.000Z`,
      stepSeconds: 3600,
      buckets: 168,
    });
    expect(busy(chart, chart.counts.requests)).toEqual([[154, 8]]);
    // 3 of 2xx over 3,600 seconds.
    expect(busy(chart, chart.perSecond["2xx"])).toEqual([[154, rounded(3 / 3600)]]);
  });

  test("the totals and the buckets agree with the Services page", async () => {
    const list = await getJson(shop.id, `/services?${DAY}`);
    const [service] = list.services;
    for (const [route, expected] of [
      [undefined, service],
      ...service.routes.map((item: { route: string }) => [item.route, item]),
    ]) {
      const chart: Chart = await getJson(shop.id, chartPath(DAY, "shop", route));
      const { requests, failed, p50Us, p95Us, p99Us, statuses } = expected;
      expect({ route, totals: chart.totals }).toEqual({
        route,
        totals: { requests, failed, p50Us, p95Us, p99Us, statuses },
      });
      expect(sum(chart.counts.requests)).toBe(expected.requests);
      expect(sum(chart.counts.failed)).toBe(expected.failed);
      for (const name of STATUS_NAMES) {
        expect(sum(chart.counts.statuses[name])).toBe(expected.statuses[name]);
      }
    }
  });

  test("a retried batch not yet merged counts twice, on the list and the charts alike", async () => {
    // Merges stopped, so the copies stay as they would in a busy day before
    // ClickHouse merges it (forced within about an hour, migration 0002).
    const { client } = dashboard.reader;
    await client.command({ query: "SYSTEM STOP MERGES spans" });
    try {
      const project = await insertProject(dashboard.db, { name: "Retried" });
      const secretKey = await secretKeyOf(dashboard.db, project.id);
      const batch = [
        span("GET /a", "10:00:00", 10, { "http.route": "/a", "http.response.status_code": 200 }),
        span(
          "GET /a",
          "10:01:00",
          30,
          { "http.route": "/a", "http.response.status_code": 500 },
          {
            status: { code: 2 },
          },
        ),
        span("GET /b", "10:06:00", 20, {}),
      ];
      // The same spans twice, as an exporter retries after a lost answer.
      await send(secretKey, "api", batch);
      await send(secretKey, "api", batch);

      const list = await getJson(project.id, `/services?${DAY}`);
      const [service] = list.services;
      const chart: Chart = await getJson(project.id, chartPath(DAY, "api"));
      // 3 requests, each twice: 6; 1 failed, twice; durations 10 10 20 20 30 30 ms.
      expect(roundedStats(chart.totals as never)).toEqual(
        roundedStats({
          requests: service.requests,
          failed: service.failed,
          p50Us: service.p50Us,
          p95Us: service.p95Us,
          p99Us: service.p99Us,
          statuses: service.statuses,
        }),
      );
      expect(chart.totals).toMatchObject({
        requests: 6,
        failed: 2,
        p50Us: 20_000,
        statuses: { "2xx": 2, "3xx": 0, "4xx": 0, "5xx": 2, none: 2 },
      });
      expect(sum(chart.counts.requests)).toBe(6);
    } finally {
      await client.command({ query: "SYSTEM START MERGES spans" });
    }
  });

  test("another environment reads its own requests", async () => {
    const chart: Chart = await getJson(shop.id, chartPath(`${DAY}&environment=staging`, "shop"));
    expect(chart.totals).toMatchObject({
      requests: 1,
      statuses: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 1, none: 0 },
    });
  });

  test("refuses bad parameters", async () => {
    const bad = [
      `/services/chart?${DAY}`,
      chartPath(DAY, ""),
      chartPath(DAY, "a\u0001b"),
      chartPath(DAY, "x".repeat(257)),
      `${chartPath(DAY, "shop")}&route=`,
      chartPath(DAY, "shop", "r".repeat(4097)),
      // 2,100 characters, 4,200 bytes: past 4 KB.
      chartPath(DAY, "shop", "é".repeat(2100)),
      chartPath("period=forever", "shop"),
      chartPath(`${DAY}&environment=no%20spaces`, "shop"),
    ];
    const answers: Record<string, number> = {};
    for (const path of bad) answers[path] = (await get(shop.id, path)).statusCode;
    expect(answers).toEqual(Object.fromEntries(bad.map((path) => [path, 400])));
    expect((await get(shop.id, chartPath(DAY, "shop", "é".repeat(2100)))).json()).toMatchObject({
      error: "invalid_route",
    });
  });
});

describe("access", () => {
  test("signed out gets 401; an unknown project 404; another project reads nothing of this one's", async () => {
    const path = chartPath(DAY, "shop");
    expect((await get(shop.id, path, { signedIn: false })).statusCode).toBe(401);
    const missing = await get(randomUUID(), path);
    expect({ status: missing.statusCode, body: missing.json() }).toEqual({
      status: 404,
      body: { error: "not_found", message: "No project has this ID." },
    });
    const other = await insertProject(dashboard.db, { name: "Another shop" });
    const theirs: Chart = await getJson(other.id, path);
    expect(theirs.totals.requests).toBe(0);
    expect(sum(theirs.counts.requests)).toBe(0);
  });
});
