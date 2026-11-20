import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import {
  MAX_BUCKETS,
  SPARKLINE_BUCKETS,
  SPARKLINE_MAX_DAYS,
  SPARKLINE_SERIES,
} from "../src/telemetry/metrics.ts";
import { signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";
import { keyValues, secretKeyOf } from "./helpers/telemetry.ts";

/**
 * The charts above the Services and Databases lists
 * (GET /api/projects/:id/services/trend, /databases/trend) and the
 * sparklines of the Metrics list (GET /api/projects/:id/metrics/sparkline),
 * on telemetry sent over OTLP. Every number is worked out by hand in the
 * comments.
 */

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;

const MS = 1_000_000n;
/** Yesterday, in UTC (the instance's timezone): a whole day. */
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const DAY = `from=${YESTERDAY}&to=${YESTERDAY}`;
const WEEK_START = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
const WEEK = `from=${WEEK_START}&to=${YESTERDAY}`;
const YEAR_START = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
const TODAY = new Date().toISOString().slice(0, 10);
const YEAR = `from=${YEAR_START}&to=${TODAY}`;
const at = (time: string) => BigInt(Date.parse(`${YESTERDAY}T${time}Z`)) * MS;
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/** A value as the tests compare them: 4 decimals. */
const round = (value: number) => Math.round(value * 10_000) / 10_000;
const rounded = (value: number | null) => (value === null ? null : round(value));
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** The buckets that are not 0, as [index, value] pairs. */
const nonZero = (values: number[]) =>
  values.map((value, index) => [index, value]).filter(([, value]) => value !== 0);

/** The buckets with a value, as [index, value] pairs. */
const present = (values: (number | null)[]) =>
  values
    .map((value, index) => [index, rounded(value)] as const)
    .filter(([, value]) => value !== null);

let shop = { id: "", secretKey: "" };

const SERVER = 2;
const CLIENT = 3;

function span(
  name: string,
  start: bigint,
  durationMs: number,
  attributes: Record<string, string | number>,
  extra: object = {},
) {
  return {
    traceId: hex(16),
    spanId: hex(8),
    parentSpanId: "",
    name,
    kind: SERVER,
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(start + BigInt(durationMs) * MS),
    attributes: keyValues(attributes),
    status: { code: 0 },
    ...extra,
  };
}

const FAILED = { status: { code: 2 } };
const POSTGRES = { "db.system.name": "postgresql", "db.namespace": "shop" };

async function post(path: string, secretKey: string, body: object) {
  const response = await dashboard.app.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "application/json", authorization: `Bearer ${secretKey}` },
    payload: JSON.stringify(body),
  });
  expect({ status: response.statusCode, body: response.json() }).toEqual({ status: 200, body: {} });
}

function sendSpans(secretKey: string, service: string, spans: object[], environment?: string) {
  return post("/v1/traces", secretKey, {
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
  });
}

function sendMetrics(secretKey: string, metrics: object[]) {
  return post("/v1/metrics", secretKey, {
    resourceMetrics: [
      {
        resource: { attributes: keyValues({ "service.name": "shop" }) },
        scopeMetrics: [{ scope: { name: "app" }, metrics }],
      },
    ],
  });
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

/**
 * The shop's requests and database calls, yesterday:
 *
 *   shop  10:00:10  10 ms  200            2xx
 *   shop  10:01:00  20 ms  500, failed    5xx
 *   shop  10:06:00  40 ms  200            2xx
 *   api   10:02:00  30 ms  404            4xx
 *   api   10:07:00  50 ms  no status      none
 *
 * Database calls (client spans with a system):
 *
 *   shop  10:00:30  10 ms  postgresql shop
 *   shop  10:03:00  30 ms  postgresql shop, failed
 *   api   10:07:00  20 ms  redis
 *
 * Not counted anywhere: a client span without a database system, and a
 * request and a call in staging.
 */
const SHOP_SPANS = [
  span("GET /a", at("10:00:10"), 10, { "http.route": "/a", "http.response.status_code": 200 }),
  span(
    "GET /a",
    at("10:01:00"),
    20,
    { "http.route": "/a", "http.response.status_code": 500 },
    FAILED,
  ),
  span("GET /b", at("10:06:00"), 40, { "http.route": "/b", "http.response.status_code": 200 }),
  span("SELECT orders", at("10:00:30"), 10, POSTGRES, { kind: CLIENT }),
  span("SELECT orders", at("10:03:00"), 30, POSTGRES, { kind: CLIENT, ...FAILED }),
  span("GET rates", at("10:04:00"), 99, { "http.request.method": "GET" }, { kind: CLIENT }),
];
const API_SPANS = [
  span("GET /c", at("10:02:00"), 30, { "http.route": "/c", "http.response.status_code": 404 }),
  span("GET /d", at("10:07:00"), 50, { "http.route": "/d" }),
  span("GET", at("10:07:00"), 20, { "db.system.name": "redis" }, { kind: CLIENT }),
];

const CUMULATIVE = 2;
const point = (time: string, start: string, value: number, attributes = {}) => ({
  timeUnixNano: String(at(time)),
  startTimeUnixNano: String(at(start)),
  attributes: keyValues(attributes),
  asDouble: value,
});
const histogramPoint = (time: string, counts: number[], count?: number) => ({
  timeUnixNano: String(at(time)),
  startTimeUnixNano: String(at("10:00:00")),
  attributes: [],
  count: String(count ?? sum(counts)),
  bucketCounts: counts.map(String),
  explicitBounds: counts.length === 0 ? [] : [0.1, 1],
});

/** One of each kind, yesterday, in hourly buckets (a day is 24 of a sparkline's at most 30). */
const SHOP_METRICS = [
  // A gauge: 2 and 4 in 10:00–11:00 (average 3), 9 in 12:00–13:00.
  {
    name: "queue.depth",
    gauge: {
      dataPoints: [
        point("10:10:00", "10:00:00", 2),
        point("10:40:00", "10:00:00", 4),
        point("12:30:00", "10:00:00", 9),
      ],
    },
  },
  // A counter from 10:00: 1,800 by 10:30 (all in 10:00–11:00), 5,400 by 11:30
  // (3,600 over an hour, half in each). 10:00–11:00: 3,600 in 3,600 s, 1 a
  // second; 11:00–12:00: 1,800, 0.5 a second.
  {
    name: "jobs.done",
    sum: {
      aggregationTemporality: CUMULATIVE,
      isMonotonic: true,
      dataPoints: [point("10:30:00", "10:00:00", 1800), point("11:30:00", "10:00:00", 5400)],
    },
  },
  // An up-down counter of two series: each one's last value in 10:00–11:00, 5 + 2.
  {
    name: "pool.used",
    sum: {
      aggregationTemporality: CUMULATIVE,
      isMonotonic: false,
      dataPoints: [
        point("10:20:00", "10:00:00", 3, { pool: "a" }),
        point("10:50:00", "10:00:00", 5, { pool: "a" }),
        point("10:30:00", "10:00:00", 2, { pool: "b" }),
      ],
    },
  },
  // A histogram, bounds 0.1 and 1, from 10:00. 10:00–11:00: 10 in the first
  // bucket, rank 9.5 of 10: 0 + 0.1 × 9.5 / 10 = 0.095. 11:00–12:00: 10 more
  // in the second, rank 9.5: 0.1 + 0.9 × 9.5 / 10 = 0.955.
  {
    name: "request.duration",
    histogram: {
      aggregationTemporality: CUMULATIVE,
      dataPoints: [histogramPoint("10:30:00", [10, 0, 0]), histogramPoint("11:30:00", [10, 10, 0])],
    },
  },
  // A histogram without bucket counts: no percentiles to draw.
  {
    name: "plain.duration",
    histogram: {
      aggregationTemporality: CUMULATIVE,
      dataPoints: [histogramPoint("10:30:00", [], 5)],
    },
  },
];

beforeAll(async () => {
  dashboard = await signedInDashboard();
  const project = await insertProject(dashboard.db, { name: "Shop" });
  shop = { id: project.id, secretKey: await secretKeyOf(dashboard.db, project.id) };
  await sendSpans(shop.secretKey, "shop", SHOP_SPANS);
  await sendSpans(shop.secretKey, "api", API_SPANS);
  await sendSpans(
    shop.secretKey,
    "shop",
    [
      span("GET /a", at("10:00:00"), 9999, { "http.route": "/a" }, FAILED),
      span("SELECT orders", at("10:00:00"), 9999, POSTGRES, { kind: CLIENT }),
    ],
    "staging",
  );
  await sendMetrics(shop.secretKey, SHOP_METRICS);
});

afterAll(async () => {
  await dashboard?.close();
});

interface ServicesTrend {
  start: string;
  stepSeconds: number;
  buckets: number;
  totals: { requests: number; failed: number; p95Us: number; statuses: Record<string, number> };
  counts: { requests: number[]; failed: number[]; statuses: Record<string, number[]> };
  perSecond: Record<string, (number | null)[]>;
  failedShare: (number | null)[];
  durations: Record<"p50Us" | "p95Us" | "p99Us", (number | null)[]>;
}

/**
 * Two minutes ahead of the clock, as a client's clock may be, but within
 * today: from 23:58, two minutes ahead is tomorrow, which today's range
 * leaves out. A second before midnight is still ahead of the clock.
 */
function aheadToday(): bigint {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return BigInt(Math.min(now.getTime() + 120_000, midnight - 1000)) * MS;
}

describe("GET /api/projects/:id/services/trend", () => {
  test("every service's requests together, in 5-minute buckets, worked out by hand", async () => {
    const trend: ServicesTrend = await getJson(shop.id, `/services/trend?${DAY}`);
    expect(trend).toMatchObject({
      timeZone: "UTC",
      environment: "production",
      start: `${YESTERDAY}T00:00:00.000Z`,
      stepSeconds: 300,
      buckets: 288,
    });
    // 10:00–10:05 is bucket 120: 10, 20 (failed), 30 ms. 10:05–10:10, bucket 121: 40, 50 ms.
    expect(present(trend.counts.requests).filter(([, value]) => value !== 0)).toEqual([
      [120, 3],
      [121, 2],
    ]);
    expect(present(trend.failedShare)).toEqual([
      [120, rounded(1 / 3)],
      [121, 0],
    ]);
    // Bucket 120, 10 20 30 ms: p95 at 0.95 × 2 = 1.9, 20 + 0.9 × 10 = 29 ms.
    // Bucket 121, 40 50 ms: p95 at 0.95, 40 + 0.95 × 10 = 49.5 ms.
    expect(present(trend.durations.p95Us)).toEqual([
      [120, 29_000],
      [121, 49_500],
    ]);
    // Each class per second over the bucket's 300 seconds.
    expect(present(trend.perSecond["2xx"] ?? []).filter(([, value]) => value !== 0)).toEqual([
      [120, rounded(1 / 300)],
      [121, rounded(1 / 300)],
    ]);
    expect(trend.perSecond["2xx"]?.[0]).toBe(0);
    expect(trend.failedShare[0]).toBeNull();
    // The whole day: 5 requests, 1 failed; p95 of 10 20 30 40 50 at 3.8, 40 + 0.8 × 10 = 48 ms.
    expect({ ...trend.totals, p95Us: round(trend.totals.p95Us) }).toMatchObject({
      requests: 5,
      failed: 1,
      p95Us: 48_000,
      statuses: { "2xx": 2, "3xx": 0, "4xx": 1, "5xx": 1, none: 1 },
    });
  });

  test("agrees with the Services page: its services added up, bucket by bucket", async () => {
    const list = await getJson(shop.id, `/services?${DAY}`);
    const trend: ServicesTrend = await getJson(shop.id, `/services/trend?${DAY}`);
    const services = list.services as { requests: number; failed: number }[];
    expect(services.length).toBe(2);
    expect(trend.totals.requests).toBe(sum(services.map((service) => service.requests)));
    expect(trend.totals.failed).toBe(sum(services.map((service) => service.failed)));
    expect(sum(trend.counts.requests)).toBe(trend.totals.requests);
    expect(sum(trend.counts.failed)).toBe(trend.totals.failed);
  });

  test("seven days are hourly buckets, and no range passes the chart's cap", async () => {
    const week: ServicesTrend = await getJson(shop.id, `/services/trend?${WEEK}`);
    expect(week).toMatchObject({ stepSeconds: 3600, buckets: 168 });
    // 10:00 yesterday is bucket 6 × 24 + 10.
    expect(present(week.counts.requests).filter(([, value]) => value !== 0)).toEqual([[154, 5]]);
    const year: ServicesTrend = await getJson(shop.id, `/services/trend?${YEAR}`);
    expect(year.buckets).toBeLessThanOrEqual(MAX_BUCKETS);
    expect(year.counts.requests.length).toBe(year.buckets);
  });

  test("another environment reads its own requests", async () => {
    const trend: ServicesTrend = await getJson(
      shop.id,
      `/services/trend?${DAY}&environment=staging`,
    );
    expect(trend.totals).toMatchObject({ requests: 1, failed: 1 });
  });

  test("a request ahead of the server's clock counts in the last bucket", async () => {
    const project = await insertProject(dashboard.db, { name: "Ahead" });
    const secretKey = await secretKeyOf(dashboard.db, project.id);
    const ahead = aheadToday();
    await sendSpans(secretKey, "api", [span("GET /", ahead, 5, {})]);
    const trend: ServicesTrend = await getJson(project.id, "/services/trend?period=today");
    expect(trend.totals.requests).toBe(1);
    expect(trend.counts.requests.at(-1)).toBe(1);
    expect(sum(trend.counts.requests)).toBe(1);
  });

  test("a retried batch counts once its day is merged, and as the list counts it before", async () => {
    // Merges stopped, so the copies stay as they would on a busy day before
    // ClickHouse merges it (forced within about an hour, migration 0002).
    const { client } = dashboard.reader;
    const project = await insertProject(dashboard.db, { name: "Retried" });
    const secretKey = await secretKeyOf(dashboard.db, project.id);
    const batch = [
      span("GET /a", at("10:00:00"), 10, { "http.route": "/a" }),
      span("GET /a", at("10:01:00"), 30, { "http.route": "/a" }, FAILED),
    ];
    await client.command({ query: "SYSTEM STOP MERGES spans" });
    try {
      // The same spans twice, as an exporter retries after a lost answer.
      await sendSpans(secretKey, "api", batch);
      await sendSpans(secretKey, "api", batch);
      const list = await getJson(project.id, `/services?${DAY}`);
      const before: ServicesTrend = await getJson(project.id, `/services/trend?${DAY}`);
      // Unmerged, both read each copy: 2 requests, each twice, 1 failed, twice.
      expect(before.totals).toMatchObject({ requests: 4, failed: 2 });
      expect(list.services[0]).toMatchObject({ requests: 4, failed: 2 });
      expect(before.totals.requests).toBe(list.services[0].requests);
      expect(before.totals.failed).toBe(list.services[0].failed);
    } finally {
      await client.command({ query: "SYSTEM START MERGES spans" });
    }
    await client.command({ query: `OPTIMIZE TABLE spans PARTITION '${YESTERDAY}' FINAL` });
    const after: ServicesTrend = await getJson(project.id, `/services/trend?${DAY}`);
    // Merged: 2 requests, 1 failed, each once.
    expect(after.totals).toMatchObject({ requests: 2, failed: 1 });
    expect(sum(after.counts.requests)).toBe(2);
    expect(present(after.failedShare)).toEqual([[120, 0.5]]);
  });

  test("refuses bad parameters", async () => {
    const bad = [
      "/services/trend?period=forever",
      `/services/trend?${DAY}&environment=no%20spaces`,
      `/services/trend?from=${YESTERDAY}`,
    ];
    const answers: Record<string, number> = {};
    for (const path of bad) answers[path] = (await get(shop.id, path)).statusCode;
    expect(answers).toEqual(Object.fromEntries(bad.map((path) => [path, 400])));
  });
});

interface DatabasesTrend {
  start: string;
  stepSeconds: number;
  buckets: number;
  totals: { calls: number; failed: number; totalUs: number; perSecond: number | null };
  counts: { calls: number[]; failed: number[]; totalUs: number[] };
  perSecond: (number | null)[];
}

describe("GET /api/projects/:id/databases/trend", () => {
  test("every database call together, in 5-minute buckets, worked out by hand", async () => {
    const trend: DatabasesTrend = await getJson(shop.id, `/databases/trend?${DAY}`);
    expect(trend).toMatchObject({
      start: `${YESTERDAY}T00:00:00.000Z`,
      stepSeconds: 300,
      buckets: 288,
    });
    // Bucket 120: 10 and 30 ms (failed); bucket 121: 20 ms. The client span
    // without a system and staging's call are left out.
    expect(nonZero(trend.counts.calls)).toEqual([
      [120, 2],
      [121, 1],
    ]);
    expect(nonZero(trend.counts.failed)).toEqual([[120, 1]]);
    expect(nonZero(trend.counts.totalUs)).toEqual([
      [120, 40_000],
      [121, 20_000],
    ]);
    // Calls per second over the bucket's 300 seconds; a bucket without a call is 0.
    expect(rounded(trend.perSecond[120] ?? null)).toBe(rounded(2 / 300));
    expect(rounded(trend.perSecond[121] ?? null)).toBe(rounded(1 / 300));
    expect(trend.perSecond[0]).toBe(0);
    // The whole day: 3 calls in 86,400 seconds, 60 ms in all.
    expect({ ...trend.totals, perSecond: rounded(trend.totals.perSecond) }).toEqual({
      calls: 3,
      failed: 1,
      totalUs: 60_000,
      perSecond: rounded(3 / 86_400),
    });
  });

  test("agrees with the Databases page: its databases added up", async () => {
    const list = await getJson(shop.id, `/databases?${DAY}`);
    const trend: DatabasesTrend = await getJson(shop.id, `/databases/trend?${DAY}`);
    const databases = list.databases as { calls: number; failed: number; totalUs: number }[];
    expect(databases.length).toBe(2);
    expect(trend.totals.calls).toBe(sum(databases.map((database) => database.calls)));
    expect(trend.totals.failed).toBe(sum(databases.map((database) => database.failed)));
    expect(trend.totals.totalUs).toBe(sum(databases.map((database) => database.totalUs)));
    expect(sum(trend.counts.calls)).toBe(trend.totals.calls);
    expect(sum(trend.counts.totalUs)).toBe(trend.totals.totalUs);
  });

  test("seven days are hourly buckets; no range passes the cap; staging reads its own", async () => {
    const week: DatabasesTrend = await getJson(shop.id, `/databases/trend?${WEEK}`);
    expect(week).toMatchObject({ stepSeconds: 3600, buckets: 168 });
    expect(week.counts.calls[154]).toBe(3);
    const year: DatabasesTrend = await getJson(shop.id, `/databases/trend?${YEAR}`);
    expect(year.buckets).toBeLessThanOrEqual(MAX_BUCKETS);
    expect(year.perSecond.length).toBe(year.buckets);
    const staging: DatabasesTrend = await getJson(
      shop.id,
      `/databases/trend?${DAY}&environment=staging`,
    );
    expect(staging.totals).toMatchObject({ calls: 1, totalUs: 9_999_000 });
  });

  test("a call ahead of the server's clock counts in the last bucket", async () => {
    const project = await insertProject(dashboard.db, { name: "Ahead calls" });
    const secretKey = await secretKeyOf(dashboard.db, project.id);
    const ahead = aheadToday();
    await sendSpans(secretKey, "api", [span("SELECT 1", ahead, 5, POSTGRES, { kind: CLIENT })]);
    const trend: DatabasesTrend = await getJson(project.id, "/databases/trend?period=today");
    expect(trend.totals.calls).toBe(1);
    expect(trend.counts.calls.at(-1)).toBe(1);
  });

  test("refuses bad parameters", async () => {
    const bad = [
      "/databases/trend?period=forever",
      `/databases/trend?${DAY}&environment=no%20spaces`,
      `/databases/trend?to=${YESTERDAY}`,
    ];
    const answers: Record<string, number> = {};
    for (const path of bad) answers[path] = (await get(shop.id, path)).statusCode;
    expect(answers).toEqual(Object.fromEntries(bad.map((path) => [path, 400])));
  });
});

interface Sparkline {
  name: string;
  kind: string;
  measure: string;
  start: string;
  stepSeconds: number;
  buckets: number;
  values: (number | null)[];
  percentiles: boolean;
  seriesCount: number;
  seriesCapped: boolean;
}

const sparkPath = (query: string, name: string, kind: string) =>
  `/metrics/sparkline?${query}&name=${encodeURIComponent(name)}&kind=${kind}`;

/** One of the shop's metrics' sparklines, yesterday. */
const spark = (name: string, kind: string): Promise<Sparkline> =>
  getJson(shop.id, sparkPath(DAY, name, kind));

describe("GET /api/projects/:id/metrics/sparkline", () => {
  test("each kind's default line, in hourly buckets, worked out by hand", async () => {
    const gauge = await spark("queue.depth", "gauge");
    expect(gauge).toMatchObject({
      name: "queue.depth",
      kind: "gauge",
      measure: "avg",
      start: `${YESTERDAY}T00:00:00.000Z`,
      stepSeconds: 3600,
      buckets: 24,
      percentiles: true,
      seriesCount: 1,
    });
    expect(gauge.values.length).toBe(24);
    expect(present(gauge.values)).toEqual([
      [10, 3],
      [12, 9],
    ]);
    const counter = await spark("jobs.done", "counter");
    expect(counter.measure).toBe("rate");
    expect(present(counter.values)).toEqual([
      [10, 1],
      [11, 0.5],
    ]);
    const updown = await spark("pool.used", "updown");
    expect(updown).toMatchObject({ measure: "sum", seriesCount: 2 });
    expect(present(updown.values)).toEqual([[10, 7]]);
    const histogram = await spark("request.duration", "histogram");
    expect(histogram).toMatchObject({ measure: "p95", percentiles: true });
    expect(present(histogram.values)).toEqual([
      [10, 0.095],
      [11, 0.955],
    ]);
  });

  test(`reads at most ${SPARKLINE_SERIES} series, those with the most points, and says when it left some out`, async () => {
    // 101 series, one point each at 10:10; one more point for series 0 to 99 at 10:20.
    const points = [
      ...Array.from({ length: 101 }, (_, i) => point("10:10:00", "10:00:00", i, { i: String(i) })),
      ...Array.from({ length: 100 }, (_, i) => point("10:20:00", "10:00:00", i, { i: String(i) })),
    ];
    await sendMetrics(shop.secretKey, [{ name: "many.series", gauge: { dataPoints: points } }]);
    const line: Sparkline = await getJson(shop.id, sparkPath(DAY, "many.series", "gauge"));
    expect(line).toMatchObject({ seriesCount: 100, seriesCapped: true });
    // Series 100, with one point, is left out: the average of 0 to 99, each twice, is 49.5.
    expect(present(line.values)).toEqual([[10, 49.5]]);
    const few: Sparkline = await getJson(shop.id, sparkPath(DAY, "queue.depth", "gauge"));
    expect(few.seriesCapped).toBe(false);
  });

  test("a histogram without bucket counts has no line, and says why", async () => {
    const plain: Sparkline = await getJson(shop.id, sparkPath(DAY, "plain.duration", "histogram"));
    expect(plain).toMatchObject({ percentiles: false, seriesCount: 1 });
    expect(present(plain.values)).toEqual([]);
  });

  test("a metric that sent nothing has every bucket empty", async () => {
    const none: Sparkline = await getJson(shop.id, sparkPath(DAY, "nothing.here", "gauge"));
    expect(none).toMatchObject({ buckets: 24, seriesCount: 0 });
    expect(none.values.every((value) => value === null)).toBe(true);
  });

  test(`no range has more than ${SPARKLINE_BUCKETS} buckets, and the last reaches the range's end`, async () => {
    const endOfYesterday = Date.parse(`${YESTERDAY}T00:00:00Z`) + 86_400_000;
    // DAY and WEEK end with yesterday; today and the last 7 days run to now.
    for (const [query, until] of [
      [DAY, endOfYesterday],
      [WEEK, endOfYesterday],
      ["period=today", Date.now()],
      ["period=7d", Date.now()],
    ] as const) {
      const line: Sparkline = await getJson(shop.id, sparkPath(query, "queue.depth", "gauge"));
      expect({ query, under: line.buckets <= SPARKLINE_BUCKETS }).toEqual({ query, under: true });
      expect(line.values.length).toBe(line.buckets);
      // The last bucket holds the range's end (or now): none is cut off, none is past it.
      const end = Date.parse(line.start) + line.buckets * line.stepSeconds * 1000;
      expect({
        query,
        reaches: end >= until - 60_000,
        last: end - line.stepSeconds * 1000 < until,
      }).toEqual({ query, reaches: true, last: true });
    }
    const week: Sparkline = await getJson(shop.id, sparkPath(WEEK, "queue.depth", "gauge"));
    // 7 days in 6-hour buckets: 28. Yesterday's 06:00 to 12:00 is bucket 6 × 4 + 1
    // (2 and 4, average 3); 12:00 to 18:00 is bucket 26 (9).
    expect(week).toMatchObject({ stepSeconds: 21_600, buckets: 28 });
    expect(present(week.values)).toEqual([
      [25, 3],
      [26, 9],
    ]);
  });

  test(`refuses a period longer than ${SPARKLINE_MAX_DAYS} days`, async () => {
    const eightDays = new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10);
    for (const query of [`from=${eightDays}&to=${YESTERDAY}`, "period=30d", YEAR]) {
      const response = await get(shop.id, sparkPath(query, "queue.depth", "gauge"));
      expect({ query, status: response.statusCode, body: response.json() }).toEqual({
        query,
        status: 400,
        body: {
          error: "range_too_long",
          message: "Sparklines are drawn for periods of up to 7 days.",
        },
      });
    }
  });

  test("refuses bad parameters", async () => {
    const bad = [
      `/metrics/sparkline?${DAY}`,
      `/metrics/sparkline?${DAY}&name=queue.depth`,
      sparkPath(DAY, "queue.depth", "summary"),
      sparkPath(DAY, "x".repeat(1025), "gauge"),
      // 600 characters, 1,200 bytes: past 1,024.
      sparkPath(DAY, "é".repeat(600), "gauge"),
      sparkPath("period=forever", "queue.depth", "gauge"),
    ];
    const answers: Record<string, number> = {};
    for (const path of bad) answers[path] = (await get(shop.id, path)).statusCode;
    expect(answers).toEqual(Object.fromEntries(bad.map((path) => [path, 400])));
  });
});

describe("access", () => {
  test.each([
    `/services/trend?${DAY}`,
    `/databases/trend?${DAY}`,
    sparkPath(DAY, "queue.depth", "gauge"),
  ])(
    "%s: signed out 401, an unknown project 404, another project reads nothing of this one's",
    async (path) => {
      expect((await get(shop.id, path, { signedIn: false })).statusCode).toBe(401);
      const missing = await get(randomUUID(), path);
      expect({ status: missing.statusCode, body: missing.json() }).toEqual({
        status: 404,
        body: { error: "not_found", message: "No project has this ID." },
      });
      const other = await insertProject(dashboard.db, { name: `Another ${randomUUID()}` });
      const theirs = await getJson(other.id, path);
      const values: (number | null)[] =
        theirs.values ?? theirs.counts?.requests ?? theirs.counts?.calls;
      expect(values.every((value) => value === null || value === 0)).toBe(true);
    },
  );
});
