import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { AlertEvaluator } from "../src/alerts/evaluator.ts";
import type { AlertContext } from "../src/alerts/fire.ts";
import type { RuleKind } from "../src/alerts/kinds.ts";
import {
  evaluateTelemetryPass,
  evaluateTelemetryRule,
  type PassResult,
  releaseRules,
  type RuleResult,
  takeDueRules,
  telemetryRules,
} from "../src/alerts/telemetry-rules.ts";
import type { Reader } from "../src/clickhouse/query.ts";
import { isPayload, type NotificationPayload } from "../src/notifications/events.ts";
import { PUBLIC_URL, signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";
import { keyValues, secretKeyOf } from "./helpers/telemetry.ts";

/**
 * Guard telemetry alert thresholds, request minimums, recovery windows, and missing data.
 * Use OTLP and real databases (docs/uptime-alerts.md, "Alerts on telemetry").
 */

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let context: AlertContext;
let channelId = "";
let projectId = "";
let secretKey = "";

const PUBLIC = "https://ottertrail.example.com";
const MINUTE = 60_000;
/** The evaluations' clock: a whole minute, two hours ago, within what telemetry keeps. */
const AT = new Date(Math.floor((Date.now() - 2 * 60 * MINUTE) / MINUTE) * MINUTE);
/** A moment some minutes (and seconds) after AT. */
const after = (minutes: number, seconds = 0) =>
  new Date(AT.getTime() + minutes * MINUTE + seconds * 1000);
const ns = (moment: Date) => String(BigInt(moment.getTime()) * 1_000_000n);
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

beforeAll(async () => {
  dashboard = await signedInDashboard();
  context = { db: dashboard.db, publicUrl: PUBLIC };
});

afterAll(async () => {
  await dashboard?.close();
});

beforeEach(async () => {
  await dashboard.db.deleteFrom("alert_rules").execute();
  await dashboard.db.deleteFrom("notification_channels").execute();
  const channel = await dashboard.db
    .insertInto("notification_channels")
    .values({
      name: "Team",
      kind: "webhook",
      webhook_url: "https://hooks.example.com/ottertrail",
      // Made at run time: no literal that looks like a key.
      webhook_secret: "x".repeat(43),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  channelId = channel.id;
  // A project of its own per test: ClickHouse's rows stay apart.
  projectId = (await insertProject(dashboard.db, { name: "Shop" })).id;
  secretKey = await secretKeyOf(dashboard.db, projectId);
});

/** Rules inserted so far: each is a millisecond younger than the one before, so their order is known. */
let inserted = 0;

async function insertRule(kind: RuleKind, settings: object) {
  inserted += 1;
  const row = await dashboard.db
    .insertInto("alert_rules")
    .values({
      project_id: projectId,
      name: `Rule ${kind}`,
      kind,
      settings: JSON.stringify(settings),
      channel_ids: [channelId],
      active_since: AT,
      created_at: new Date(AT.getTime() + inserted),
      updated_at: AT,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Evaluates one rule at a moment, as the worker does. */
async function evaluate(ruleId: string, at: Date, reader: Reader = dashboard.reader) {
  const rules = await telemetryRules(dashboard.db, projectId);
  const rule = rules.find((item) => item.id === ruleId);
  if (rule === undefined) throw new Error("no such rule");
  return evaluateTelemetryRule(context, reader, rule, at);
}

/** The project's notifications, oldest first. */
async function sent(): Promise<NotificationPayload[]> {
  const rows = await dashboard.db
    .selectFrom("notification_deliveries")
    .select(["payload"])
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  return rows
    .map((row) => {
      if (!isPayload(row.payload)) throw new Error("not a payload");
      return row.payload;
    })
    .filter((payload) => payload.project?.id === projectId);
}

const stateOf = (ruleId: string) =>
  dashboard.db
    .selectFrom("alert_states")
    .selectAll()
    .where("rule_id", "=", ruleId)
    .executeTakeFirst();

async function send(path: string, body: object) {
  const response = await dashboard.app.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "application/json", authorization: `Bearer ${secretKey}` },
    payload: JSON.stringify(body),
  });
  expect({ status: response.statusCode, body: response.json() }).toEqual({ status: 200, body: {} });
}

interface Request {
  route: string;
  durationMs: number;
  failed?: boolean;
  /** The span's own IDs, to send a request twice as a retry would. */
  traceId?: string;
  spanId?: string;
}

/** Server spans of a service, all starting at `start`. */
async function sendRequests(service: string, start: Date, requests: Request[]) {
  await send("/v1/traces", {
    resourceSpans: [
      {
        resource: { attributes: keyValues({ "service.name": service }) },
        scopeSpans: [
          {
            scope: { name: "http" },
            spans: requests.map((request) => ({
              traceId: request.traceId ?? hex(16),
              spanId: request.spanId ?? hex(8),
              name: `HTTP ${request.route}`,
              kind: 2,
              startTimeUnixNano: ns(start),
              endTimeUnixNano: String(BigInt(ns(start)) + BigInt(request.durationMs) * 1_000_000n),
              attributes: keyValues({ "http.route": request.route }),
              status: { code: request.failed === true ? 2 : 0 },
            })),
          },
        ],
      },
    ],
  });
}

const times = (count: number, request: Request): Request[] =>
  Array.from({ length: count }, () => ({ ...request }));

/** Metrics under one resource: a service, and optionally a host. */
async function sendMetric(metric: object, resource: Record<string, string> = {}) {
  await send("/v1/metrics", {
    resourceMetrics: [
      {
        resource: { attributes: keyValues({ "service.name": "worker", ...resource }) },
        scopeMetrics: [{ scope: { name: "app" }, metrics: [metric] }],
      },
    ],
  });
}

const gaugePoints = (
  name: string,
  points: { at: Date; value: number; attributes?: Record<string, string> }[],
) => ({
  name,
  unit: "1",
  gauge: {
    dataPoints: points.map((point) => ({
      timeUnixNano: ns(point.at),
      startTimeUnixNano: "0",
      attributes: keyValues(point.attributes ?? {}),
      asDouble: point.value,
    })),
  },
});

const outcomeOf = (result: RuleResult) => result.outcome;

/**
 * Readers that count the projects' queries running at once, each taking
 * `delayMs` first; a project `fail` names has its queries fail.
 */
function countingReader(fail: (projectId: string) => boolean, delayMs = 40) {
  let running = 0;
  let most = 0;
  return {
    most: () => most,
    readerOf: (project: string, deadline: number): Reader => ({
      client: dashboard.reader.client,
      deadline,
      gate: async <T>(work: () => Promise<T>) => {
        if (fail(project)) throw new Error("ClickHouse timed out");
        running += 1;
        most = Math.max(most, running);
        try {
          await new Promise((done) => {
            setTimeout(done, delayMs);
          });
          return await work();
        } finally {
          running -= 1;
        }
      },
    }),
  };
}

const ruleOn = (route: string) =>
  insertRule("route_latency", {
    environment: "production",
    service: "checkout",
    route,
    percentile: "p95",
    thresholdMs: 100,
    windowMinutes: 5,
    minRequests: 1,
  });

function call(method: "GET" | "POST" | "PATCH", path: string, payload?: object, cookie?: string) {
  return dashboard.app.inject({
    method,
    url: `/api${path}`,
    headers: { cookie: cookie ?? dashboard.cookie, origin: PUBLIC_URL },
    ...(payload === undefined ? {} : { payload }),
  });
}
const rules = () => `/projects/${projectId}/alert-rules`;

/** A rule the API refuses: its error code, or Fastify's for a schema's refusal. */
const refused = async (sentBody: object) => {
  const response = await call("POST", rules(), { channelIds: [channelId], ...sentBody });
  expect(response.statusCode).toBe(400);
  const body = response.json<{ error: string; code?: string }>();
  return body.code ?? body.error;
};

const metricRule = (metric: string, metricKind: string, aggregate: string, value: number) =>
  insertRule("metric_threshold", {
    environment: "production",
    metric,
    metricKind,
    aggregate,
    direction: "above",
    value,
    windowMinutes: 10,
    host: null,
    attributeKey: null,
    attributeValue: null,
  });

/** Pods each sending an up-down counter of `value`, every minute from `from` to `to` (minutes after AT, 30 s before the minute). */
const pods = async (names: string[], value: number, from: number, to: number) => {
  for (const pod of names) {
    await sendMetric(
      {
        name: "pool.connections",
        unit: "{connection}",
        sum: {
          aggregationTemporality: 2,
          isMonotonic: false,
          dataPoints: Array.from({ length: to - from + 1 }, (_, i) => ({
            timeUnixNano: ns(after(from + i, -30)),
            startTimeUnixNano: ns(after(-60)),
            attributes: [],
            asDouble: value,
          })),
        },
      },
      { "k8s.pod.name": pod },
    );
  }
};

/** A project of its own with one route rule on GET /slow, whose requests are slow. */
async function slowProject(name: string) {
  projectId = (await insertProject(dashboard.db, { name })).id;
  secretKey = await secretKeyOf(dashboard.db, projectId);
  const id = await ruleOn("GET /slow");
  await sendRequests("checkout", after(-3), [{ route: "GET /slow", durationMs: 500 }]);
  return { projectId, ruleId: id };
}

const evaluatorWith = (
  telemetry: ConstructorParameters<typeof AlertEvaluator>[0]["telemetry"],
  clock: () => Date,
  logs?: [string, string, Record<string, unknown> | undefined][],
) =>
  new AlertEvaluator({
    ...context,
    ...(logs === undefined ? {} : { log: (level, msg, fields) => logs.push([level, msg, fields]) }),
    clickhouse: dashboard.reader.client,
    now: clock,
    telemetry,
  });

const outcomes = (results: PassResult[]) =>
  results.map((item) => ("result" in item ? item.result.outcome : "error"));

describe("route latency", () => {
  test("fires when the window's p95 is above the threshold, counting only its route", async () => {
    const ruleId = await insertRule("route_latency", {
      environment: "production",
      service: "checkout",
      route: "GET /cart",
      percentile: "p95",
      thresholdMs: 130,
      windowMinutes: 5,
      minRequests: 20,
    });
    // 19 requests of 100 ms and one of 900 ms, 3 minutes before AT: in the
    // window [AT − 6 min, AT − 1 min). p95 of 20 durations, interpolated
    // (quantileExactInclusive): position 0.95 × 19 = 18.05, between the
    // 19th (100 ms) and the 20th (900 ms): 100 + 0.05 × 800 = 140 ms.
    const slow = { route: "GET /cart", durationMs: 900 };
    const requests = [...times(19, { route: "GET /cart", durationMs: 100 }), slow];
    await sendRequests("checkout", after(-3), requests);
    // Another route's requests do not count. (Read without FINAL, a retried
    // copy not yet merged away would count twice: docs/uptime-alerts.md.)
    await sendRequests("checkout", after(-3), times(5, { route: "GET /", durationMs: 5000 }));

    const first = await evaluate(ruleId, AT);
    expect(first.reading.requests).toBe(20);
    expect(first.reading.value).toBeCloseTo(140, 6);
    expect(outcomeOf(first)).toBe("sent");
    // Evaluated again: still firing, nothing more sent.
    expect(outcomeOf(await evaluate(ruleId, after(1)))).toBe("none");

    const [fired, ...rest] = await sent();
    expect(rest).toEqual([]);
    expect(fired?.type).toBe("route.latency");
    expect(fired?.message).toBe(
      "Shop: the 95th percentile duration of GET /cart in checkout in production was 140 ms over the last 5 minutes, above the rule's 130 ms, across 20 requests.",
    );
    expect(fired?.subject).toEqual({
      type: "route",
      service: "checkout",
      route: "GET /cart",
      environment: "production",
      windowMinutes: 5,
      requests: 20,
      percentile: "p95",
      valueMs: 140,
      thresholdMs: 130,
      ruleId,
      ruleName: "Rule route_latency",
    });
    const url = new URL(fired?.url ?? "");
    expect(url.pathname).toBe(`/projects/${projectId}/services`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      env: '"production"',
      service: '"checkout"',
      route: '"GET /cart"',
    });
  });

  test("does not fire below the request minimum, nor without requests", async () => {
    const ruleId = await insertRule("route_latency", {
      environment: "production",
      service: "checkout",
      route: null,
      percentile: "p99",
      thresholdMs: 50,
      windowMinutes: 5,
      minRequests: 21,
    });
    expect(await evaluate(ruleId, AT)).toMatchObject({ outcome: "none", reading: { value: null } });
    await sendRequests("checkout", after(-3), times(20, { route: "GET /cart", durationMs: 400 }));
    const below = await evaluate(ruleId, AT);
    expect(below).toMatchObject({ outcome: "none", reading: { value: null, requests: 20 } });
    // One more request reaches the minimum: 21 of 400 ms, p99 400 ms.
    await sendRequests("checkout", after(-2), times(1, { route: "GET /", durationMs: 400 }));
    expect(await evaluate(ruleId, AT)).toMatchObject({
      outcome: "sent",
      reading: { value: 400, requests: 21 },
    });
  });

  test("resolves only after a whole window back below, and no data in between starts it again", async () => {
    const ruleId = await insertRule("route_latency", {
      environment: "production",
      service: "checkout",
      route: "GET /cart",
      percentile: "p95",
      thresholdMs: 200,
      windowMinutes: 5,
      minRequests: 20,
    });
    const fast = { route: "GET /cart", durationMs: 50 };
    await sendRequests("checkout", after(-3), times(20, { route: "GET /cart", durationMs: 300 }));
    expect(outcomeOf(await evaluate(ruleId, AT))).toBe("sent");

    // Fast again from AT + 2 min. At AT + 5 min the window [AT − 1, AT + 4)
    // holds only fast requests: back below, since then.
    await sendRequests("checkout", after(2), times(20, fast));
    expect(outcomeOf(await evaluate(ruleId, after(5)))).toBe("waiting");
    expect((await stateOf(ruleId))?.clear_since).toEqual(after(5));
    // Nothing in [AT + 3, AT + 8): no data does not resolve, and starts the wait again.
    expect(await evaluate(ruleId, after(9))).toMatchObject({
      outcome: "none",
      reading: { value: null },
    });
    expect(await stateOf(ruleId)).toMatchObject({ firing: true, clear_since: null });

    // Fast requests every 3 minutes from AT + 9.
    for (const minute of [9, 12, 15])
      await sendRequests("checkout", after(minute), times(20, fast));
    expect(outcomeOf(await evaluate(ruleId, after(11)))).toBe("waiting");
    expect(outcomeOf(await evaluate(ruleId, after(14)))).toBe("waiting");
    // A whole window (5 minutes) after AT + 11, still below ([AT + 10, AT + 15)): resolved.
    const resolved = await evaluate(ruleId, after(16));
    expect(resolved).toMatchObject({ outcome: "sent", reading: { value: 50, requests: 20 } });
    expect((await sent()).map((payload) => [payload.type, payload.message])).toEqual([
      [
        "route.latency",
        "Shop: the 95th percentile duration of GET /cart in checkout in production was 300 ms over the last 5 minutes, above the rule's 200 ms, across 20 requests.",
      ],
      [
        "route.latency_resolved",
        "Shop: the 95th percentile duration of GET /cart in checkout in production stayed at or below 200 ms for 5 minutes: 50 ms over the last 5 minutes, across 20 requests.",
      ],
    ]);
  });
});

describe("route failures", () => {
  test("the whole service: fires above the failed share, and resolves after a window back", async () => {
    const ruleId = await insertRule("route_failures", {
      environment: "production",
      service: "checkout",
      route: null,
      thresholdPercent: 10,
      windowMinutes: 5,
      minRequests: 20,
    });
    // 20 requests over two routes, 3 failed: 15%.
    await sendRequests("checkout", after(-4), [
      ...times(10, { route: "GET /cart", durationMs: 10 }),
      ...times(7, { route: "POST /pay", durationMs: 10 }),
      ...times(3, { route: "POST /pay", durationMs: 10, failed: true }),
    ]);
    // Another service's failures do not count.
    await sendRequests(
      "search",
      after(-4),
      times(30, { route: "GET /", durationMs: 1, failed: true }),
    );
    const fired = await evaluate(ruleId, AT);
    expect(fired).toMatchObject({
      outcome: "sent",
      reading: { value: 15, failed: 3, requests: 20 },
    });

    // Below the threshold from AT + 1 (1 of 20 failed: 5%), back at AT + 4, resolved at AT + 9.
    for (const minute of [1, 4, 7]) {
      await sendRequests("checkout", after(minute), [
        ...times(19, { route: "GET /cart", durationMs: 10 }),
        { route: "GET /cart", durationMs: 10, failed: true },
      ]);
    }
    expect(outcomeOf(await evaluate(ruleId, after(4)))).toBe("waiting");
    // Back above for a moment: the wait starts again.
    await sendRequests(
      "checkout",
      after(5),
      times(10, { route: "GET /cart", durationMs: 10, failed: true }),
    );
    expect(await evaluate(ruleId, after(7))).toMatchObject({ outcome: "none" });
    expect(await stateOf(ruleId)).toMatchObject({ firing: true, clear_since: null });
    // [AT + 6, AT + 11): only the 5% batch at AT + 7.
    expect(outcomeOf(await evaluate(ruleId, after(12)))).toBe("waiting");
    // Five minutes after AT + 12, with [AT + 11, AT + 16) empty: no data, no resolution.
    expect(await evaluate(ruleId, after(17))).toMatchObject({
      outcome: "none",
      reading: { value: null },
    });
    expect(await stateOf(ruleId)).toMatchObject({ firing: true, clear_since: null });
    expect((await sent()).map((payload) => payload.type)).toEqual(["route.failures"]);
    expect((await sent())[0]?.message).toBe(
      "Shop: 15% of requests of checkout in production failed over the last 5 minutes, above the rule's 10%: 3 of 20 requests.",
    );
  });

  test("one route, below the request minimum, never fires", async () => {
    const ruleId = await insertRule("route_failures", {
      environment: "production",
      service: "checkout",
      route: "POST /pay",
      thresholdPercent: 0,
      windowMinutes: 10,
      minRequests: 5,
    });
    await sendRequests("checkout", after(-4), [
      ...times(50, { route: "GET /cart", durationMs: 10 }),
      ...times(4, { route: "POST /pay", durationMs: 10, failed: true }),
    ]);
    expect(await evaluate(ruleId, AT)).toMatchObject({
      outcome: "none",
      reading: { value: null, requests: 4, failed: 4 },
    });
    await sendRequests("checkout", after(-3), times(1, { route: "POST /pay", durationMs: 10 }));
    expect(await evaluate(ruleId, AT)).toMatchObject({
      outcome: "sent",
      reading: { value: 80, requests: 5 },
    });
  });
});

describe("metric", () => {
  test("a gauge's average, for one host or all; no data never fires, nor resolves", async () => {
    const all = await insertRule("metric_threshold", {
      environment: "production",
      metric: "queue.depth",
      metricKind: "gauge",
      aggregate: "avg",
      direction: "above",
      value: 50,
      windowMinutes: 5,
      host: null,
      attributeKey: null,
      attributeValue: null,
    });
    const quiet = await insertRule("metric_threshold", {
      environment: "production",
      metric: "queue.depth",
      metricKind: "gauge",
      aggregate: "avg",
      direction: "above",
      value: 50,
      windowMinutes: 5,
      host: "web-1",
      attributeKey: null,
      attributeValue: null,
    });
    expect(await evaluate(all, AT)).toMatchObject({ outcome: "none", reading: { value: null } });
    // In the window [AT − 6, AT − 1): web-1 10, 20, 30 (average 20); web-2 100, 200.
    // All points: (10 + 20 + 30 + 100 + 200) / 5 = 72. A point after the window does not count.
    await sendMetric(
      gaugePoints("queue.depth", [
        { at: after(-5), value: 10 },
        { at: after(-4), value: 20 },
        { at: after(-2), value: 30 },
        { at: after(0, -30), value: 5000 },
      ]),
      { "host.name": "web-1" },
    );
    await sendMetric(
      gaugePoints("queue.depth", [
        { at: after(-5), value: 100 },
        { at: after(-3), value: 200 },
      ]),
      { "host.name": "web-2" },
    );
    expect(await evaluate(all, AT)).toMatchObject({ outcome: "sent", reading: { value: 72 } });
    expect(await evaluate(quiet, AT)).toMatchObject({ outcome: "none", reading: { value: 20 } });

    const [fired] = await sent();
    expect(fired?.type).toBe("metric.threshold");
    expect(fired?.message).toBe(
      "Shop: the average of queue.depth in production was 72 over the last 5 minutes, above the rule's 50.",
    );
    expect(fired?.subject).toMatchObject({
      type: "metric",
      metric: "queue.depth",
      metricKind: "gauge",
      aggregate: "avg",
      direction: "above",
      value: 72,
      threshold: 50,
      host: null,
      windowMinutes: 5,
    });

    // [AT + 2, AT + 7) holds nothing: still firing.
    expect(await evaluate(all, after(8))).toMatchObject({
      outcome: "none",
      reading: { value: null },
    });
    expect(await stateOf(all)).toMatchObject({ firing: true });
    // Back below from AT + 8 on, every minute.
    const low = Array.from({ length: 12 }, (_, i) => ({ at: after(8 + i), value: 3 }));
    await sendMetric(gaugePoints("queue.depth", low), { "host.name": "web-1" });
    expect(outcomeOf(await evaluate(all, after(10)))).toBe("waiting");
    expect(outcomeOf(await evaluate(all, after(14)))).toBe("waiting");
    expect(outcomeOf(await evaluate(all, after(15)))).toBe("sent");
    expect((await sent()).at(-1)?.message).toBe(
      "Shop: the average of queue.depth in production stayed at or below 50 for 5 minutes: 3 over the last 5 minutes.",
    );
    expect((await sent()).at(-1)?.type).toBe("metric.threshold_resolved");
  });

  test("below a value, for one attribute value: a pool's minimum", async () => {
    const ruleId = await insertRule("metric_threshold", {
      environment: "production",
      metric: "pool.available",
      metricKind: "gauge",
      aggregate: "min",
      direction: "below",
      value: 2,
      windowMinutes: 10,
      host: null,
      attributeKey: "pool",
      attributeValue: "db",
    });
    const cacheOnly = await insertRule("metric_threshold", {
      environment: "production",
      metric: "pool.available",
      metricKind: "gauge",
      aggregate: "min",
      direction: "below",
      value: 2,
      windowMinutes: 10,
      host: null,
      attributeKey: "pool",
      attributeValue: "cache",
    });
    await sendMetric(
      gaugePoints("pool.available", [
        { at: after(-8), value: 3, attributes: { pool: "db" } },
        { at: after(-6), value: 1, attributes: { pool: "db" } },
        { at: after(-4), value: 2, attributes: { pool: "db" } },
        { at: after(-8), value: 10, attributes: { pool: "cache" } },
        { at: after(-4), value: 12, attributes: { pool: "cache" } },
      ]),
    );
    expect(await evaluate(ruleId, AT)).toMatchObject({ outcome: "sent", reading: { value: 1 } });
    expect(await evaluate(cacheOnly, AT)).toMatchObject({
      outcome: "none",
      reading: { value: 10 },
    });
    const [fired] = await sent();
    expect(fired?.message).toBe(
      "Shop: the minimum of pool.available where pool is db in production was 1 over the last 10 minutes, below the rule's 2.",
    );
    const url = new URL(fired?.url ?? "");
    expect(url.pathname).toBe(`/projects/${projectId}/metrics/pool.available`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      kind: '"gauge"',
      env: '"production"',
      attr: '"pool"',
      attrValue: '"db"',
    });
  });

  test("a counter's rate per second, from cumulative points, with the step past the window's end", async () => {
    const ruleId = await insertRule("metric_threshold", {
      environment: "production",
      metric: "jobs.done",
      metricKind: "counter",
      aggregate: "rate",
      direction: "above",
      value: 15,
      windowMinutes: 5,
      host: null,
      attributeKey: null,
      attributeValue: null,
    });
    // Cumulative points every minute, 30 seconds off the minute, since a
    // start at AT − 30 min. The window is [AT − 6:00, AT − 1:00); the
    // points around it, and the increase of each step:
    //   AT − 7:30  1,000   (the first read: nothing before it to count from)
    //   AT − 6:30  1,600   +600, all before the window
    //   AT − 5:30  2,200   +600, half inside (from AT − 6:00):   300
    //   AT − 4:30  2,800   +600, inside:                          600
    //   AT − 3:30  4,000 +1,200, inside:                        1,200
    //   AT − 2:30  5,200 +1,200, inside:                        1,200
    //   AT − 1:30  6,400 +1,200, inside:                        1,200
    //   AT − 0:30  7,600 +1,200, half inside (to AT − 1:00):     600
    // 5,100 over 300 seconds: 17 a second.
    const values = [1000, 1600, 2200, 2800, 4000, 5200, 6400, 7600];
    await sendMetric({
      name: "jobs.done",
      unit: "{job}",
      sum: {
        aggregationTemporality: 2,
        isMonotonic: true,
        dataPoints: values.map((value, i) => ({
          timeUnixNano: ns(after(-7 + i, -30)),
          startTimeUnixNano: ns(after(-30)),
          attributes: [],
          asDouble: value,
        })),
      },
    });
    const fired = await evaluate(ruleId, AT);
    expect(fired.outcome).toBe("sent");
    expect(fired.reading.value).toBeCloseTo(17, 9);
    expect((await sent())[0]?.message).toBe(
      "Shop: the rate per second of jobs.done in production was 17 over the last 5 minutes, above the rule's 15.",
    );
  });

  test("a histogram's 95th percentile, from the window's bucket counts", async () => {
    const ruleId = await insertRule("metric_threshold", {
      environment: "production",
      metric: "http.server.request.duration",
      metricKind: "histogram",
      aggregate: "p95",
      direction: "above",
      value: 800,
      windowMinutes: 5,
      host: null,
      attributeKey: null,
      attributeValue: null,
    });
    // Cumulative, bounds 100, 250, 500, 1000. The last point before the
    // window (AT − 7) and the last inside it (AT − 2):
    //   AT − 7:  10, 20,  5,  0, 0
    //   AT − 2:  40, 70, 25, 15, 0
    // The window's counts are the difference: 30, 50, 20, 15, 0 (115).
    // p95's rank is 0.95 × 115 = 109.25; the counts before the fourth
    // bucket (500, 1000] add up to 100, so it falls 9.25 of its 15 in:
    // 500 + 500 × 9.25 / 15 = 808.33.
    const point = (at: Date, counts: number[]) => ({
      timeUnixNano: ns(at),
      startTimeUnixNano: ns(after(-30)),
      attributes: [],
      count: String(counts.reduce((total, count) => total + count, 0)),
      bucketCounts: counts.map(String),
      explicitBounds: [100, 250, 500, 1000],
    });
    await sendMetric({
      name: "http.server.request.duration",
      unit: "ms",
      histogram: {
        aggregationTemporality: 2,
        dataPoints: [point(after(-7), [10, 20, 5, 0, 0]), point(after(-2), [40, 70, 25, 15, 0])],
      },
    });
    const fired = await evaluate(ruleId, AT);
    expect(fired.outcome).toBe("sent");
    expect(fired.reading.value).toBeCloseTo(500 + (500 * 9.25) / 15, 9);
    expect((await sent())[0]?.message).toBe(
      "Shop: the 95th percentile of http.server.request.duration in production was 808.3 ms over the last 5 minutes, above the rule's 800 ms.",
    );
  });
});

describe("metric windows", () => {
  test("an up-down total counts only the series still reporting at the window's end", async () => {
    const ruleId = await metricRule("pool.connections", "updown", "sum", 25);
    // The window is [AT − 11, AT − 1). Three old pods report 10 each until
    // AT − 6, then three new pods 7 each from AT − 5 to AT − 1:30. Counting
    // every series' last value would add 3 × 10 + 3 × 7 = 51; only the new
    // ones' last points are within 2 minutes of the window's end: 21.
    await pods(["old-1", "old-2", "old-3"], 10, -11, -6);
    await pods(["new-1", "new-2", "new-3"], 7, -5, -1);
    expect(await evaluate(ruleId, AT)).toMatchObject({ outcome: "none", reading: { value: 21 } });
  });

  test("a counter exported less often than its window still has the point before it", async () => {
    const ruleId = await metricRule("jobs.rare", "counter", "rate", 0.5);
    // Every 15 minutes: AT − 30, AT − 15, AT − 0:30. The window [AT − 11,
    // AT − 1) lies inside the last step (AT − 15 to AT − 0:30, +900 over
    // 870 s); without a look back of a window's length, its first point
    // would have nothing before it. The step's part inside is 600 s of
    // 870 s: 900 × 600 / 870 = 620.69 over 600 s, 1.0345 a second.
    await sendMetric({
      name: "jobs.rare",
      unit: "{job}",
      sum: {
        aggregationTemporality: 2,
        isMonotonic: true,
        dataPoints: [
          { at: after(-30), value: 100 },
          { at: after(-15), value: 400 },
          { at: after(0, -30), value: 1300 },
        ].map((point) => ({
          timeUnixNano: ns(point.at),
          startTimeUnixNano: ns(after(-60)),
          attributes: [],
          asDouble: point.value,
        })),
      },
    });
    const fired = await evaluate(ruleId, AT);
    expect(fired.outcome).toBe("sent");
    expect(fired.reading.value).toBeCloseTo(900 / 870, 9);
  });
});

describe("long names", () => {
  test("a route of 1,000 characters fires, its link without the route, its message cut", async () => {
    // Each "é" takes 6 characters in the link (%C3%A9): far past its 2,048.
    const route = `GET /${"é".repeat(995)}`;
    expect(route.length).toBe(1000);
    const created = await call("POST", rules(), {
      kind: "route_latency",
      settings: { service: "checkout", route, thresholdMs: 1, windowMinutes: 5, minRequests: 1 },
      channelIds: [channelId],
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ rule: { id: string } }>().rule;
    await sendRequests("checkout", after(-3), [{ route, durationMs: 50 }]);
    expect(await evaluate(id, AT)).toMatchObject({ outcome: "sent" });
    const [fired] = await sent();
    const url = new URL(fired?.url ?? "");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      env: '"production"',
      service: '"checkout"',
    });
    expect(fired?.message).toContain(route.slice(0, 200));
    expect(fired?.message.length).toBeLessThanOrEqual(1000);
    expect(
      await refused({
        kind: "route_latency",
        settings: { service: "checkout", route: `${route}y`, thresholdMs: 1 },
      }),
    ).toBe("FST_ERR_VALIDATION");
    expect(
      await refused({
        kind: "metric_threshold",
        settings: { metric: "m", metricKind: "gauge", value: 1, host: "h".repeat(1001) },
      }),
    ).toBe("FST_ERR_VALIDATION");
  });
});

describe("the worker", () => {
  test("each rule is due once a minute, and one worker of two takes it", async () => {
    const projects = [];
    for (let i = 0; i < 6; i += 1) projects.push(await slowProject(`Shop ${i}`));
    // Each worker counts its own reads: the limit is per worker, and two
    // workers that take rules at the same moment may run 8 between them.
    const countingFirst = countingReader(() => false);
    const countingSecond = countingReader(() => false);
    let clock = AT;
    const first = evaluatorWith({ readerOf: countingFirst.readerOf, concurrency: 4 }, () => clock);
    const second = evaluatorWith(
      { readerOf: countingSecond.readerOf, concurrency: 4 },
      () => clock,
    );
    const [a, b] = await Promise.all([first.telemetryTick(), second.telemetryTick()]);
    const taken = [...a, ...b].map((item) => item.rule.id).toSorted();
    expect(taken).toEqual(projects.map((project) => project.ruleId).toSorted());
    expect(outcomes([...a, ...b])).toEqual(projects.map(() => "sent"));
    // At most 4 projects at once in each worker.
    expect(countingFirst.most()).toBeLessThanOrEqual(4);
    expect(countingSecond.most()).toBeLessThanOrEqual(4);
    // Not due again within the minute; due again a minute later.
    clock = after(0, 59);
    expect(await first.telemetryTick()).toEqual([]);
    clock = after(1);
    expect((await first.telemetryTick()).length).toBe(6);
    const next = await dashboard.db
      .selectFrom("alert_rules")
      .select("next_evaluation_at")
      .execute();
    expect(next.map((row) => row.next_evaluation_at)).toEqual(projects.map(() => after(2)));
  });

  test("a project's rules share its budget, and another project is not held up", async () => {
    const quick = await slowProject("Quick");
    projectId = (await insertProject(dashboard.db, { name: "Busy" })).id;
    const busy = [];
    for (let i = 0; i < 3; i += 1) {
      busy.push(
        await insertRule("metric_threshold", {
          environment: "production",
          metric: `queue.${i}`,
          metricKind: "gauge",
          aggregate: "avg",
          direction: "above",
          value: 1,
          windowMinutes: 5,
          host: null,
          attributeKey: null,
          attributeValue: null,
        }),
      );
    }
    // Each of the busy project's queries waits 1 s before it starts (a metric with no series
    // makes one), and a query starts only with a whole second of the budget left. Of 3.9 s, the
    // second starts 2 s in, plus the time the first rule's other work took: up to 0.9 s of that
    // still leaves it its second, on a busy machine too. The third starts 3 s in, at the
    // earliest, with less than a second left: refused.
    const counting = countingReader(() => false, 0);
    const slow = (project: string, deadline: number): Reader => {
      const reader = counting.readerOf(project, deadline);
      if (project !== projectId) return reader;
      return {
        ...reader,
        gate: async (work) => {
          await new Promise((done) => {
            setTimeout(done, 1000);
          });
          return work();
        },
      };
    };
    const started = Date.now();
    const results = await evaluatorWith(
      { readerOf: slow, budgetMs: 3900 },
      () => AT,
    ).telemetryTick();
    // The budget bounds the pass: no query starts after it.
    expect(Date.now() - started).toBeLessThan(5500);
    expect(results.find((item) => item.rule.id === quick.ruleId)).toMatchObject({
      result: { outcome: "sent" },
    });
    const late = results.filter((item) => "error" in item);
    expect(late.map((item) => item.rule.id)).toEqual([busy[2]]);
    const rule = await dashboard.db
      .selectFrom("alert_rules")
      .select(["evaluation_error", "evaluation_failing_since"])
      .where("id", "=", busy[2] ?? "")
      .executeTakeFirstOrThrow();
    expect(rule).toEqual({
      evaluation_error:
        "The project's rules reached their time limit for this minute before this rule could be read.",
      evaluation_failing_since: AT,
    });
  });

  test("a rule that fails is recorded on it and logged once per outage; the others go on", async () => {
    const broken = await slowProject("Broken");
    const working = await slowProject("Working");
    let failing = true;
    const counting = countingReader((project) => failing && project === broken.projectId);
    const logs: [string, string, Record<string, unknown> | undefined][] = [];
    let clock = AT;
    const evaluator = evaluatorWith({ readerOf: counting.readerOf }, () => clock, logs);
    const first = await evaluator.telemetryTick();
    expect(first.find((item) => item.rule.id === working.ruleId)).toMatchObject({
      result: { outcome: "sent" },
    });
    expect(first.find((item) => item.rule.id === broken.ruleId)).toHaveProperty("error");
    clock = after(1);
    await evaluator.telemetryTick();
    const errors = () => logs.filter(([level]) => level === "error");
    expect(errors()).toEqual([
      [
        "error",
        "alert rules: evaluating a telemetry rule failed",
        { rule: broken.ruleId, project: broken.projectId, err: "Error: ClickHouse timed out" },
      ],
    ]);
    // The rule says so, as the Alerts page shows it.
    const shown = await call("GET", `/projects/${broken.projectId}/alert-rules/${broken.ruleId}`);
    expect(shown.json()).toMatchObject({
      rule: {
        evaluationError: { message: "ClickHouse timed out", since: AT.toISOString() },
      },
    });

    failing = false;
    clock = after(2);
    await evaluator.telemetryTick();
    expect(
      logs.filter(([, msg]) => msg === "alert rules: a telemetry rule evaluates again"),
    ).toEqual([
      [
        "info",
        "alert rules: a telemetry rule evaluates again",
        { rule: broken.ruleId, project: broken.projectId },
      ],
    ]);
    const after2 = await call("GET", `/projects/${broken.projectId}/alert-rules/${broken.ruleId}`);
    expect(after2.json()).toMatchObject({ rule: { evaluationError: null } });
  });

  test("once stopping, nothing more starts, and the rules not reached are due again at once", async () => {
    const projects = [];
    for (let i = 0; i < 3; i += 1) projects.push(await slowProject(`Shop ${i}`));
    const rulesTaken = await takeDueRules(dashboard.db, AT);
    expect(rulesTaken.length).toBe(3);
    // The worker is told to stop while the first project's query runs.
    let stop = false;
    const counting = countingReader(() => false);
    const pass = await evaluateTelemetryPass(context, rulesTaken, {
      readerOf: (project, deadline) => {
        const reader = counting.readerOf(project, deadline);
        return {
          ...reader,
          gate: async (work) => {
            const result = await work();
            stop = true;
            return result;
          },
        };
      },
      concurrency: 1,
      now: () => AT,
      stopping: () => stop,
    });
    expect(pass.results.length).toBe(1);
    expect(pass.released.length).toBe(2);
    await releaseRules(
      dashboard.db,
      pass.released.map((rule) => rule.id),
    );
    expect((await takeDueRules(dashboard.db, AT)).map((rule) => rule.id).toSorted()).toEqual(
      pass.released.map((rule) => rule.id).toSorted(),
    );
  });

  test("a stopped evaluator takes nothing", async () => {
    await slowProject("Shop");
    const evaluator = evaluatorWith({}, () => AT);
    evaluator.stop();
    expect(await evaluator.telemetryTick()).toEqual([]);
    expect((await takeDueRules(dashboard.db, AT)).length).toBe(1);
  });
});

describe("the rule routes", () => {
  const latency = {
    kind: "route_latency",
    settings: { service: "checkout", route: "GET /cart", thresholdMs: 500 },
  };

  test("save a telemetry rule with defaults, and warn when what it watches has not reported", async () => {
    const created = await call("POST", rules(), { ...latency, channelIds: [channelId] });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      rule: {
        name: "Route latency",
        kind: "route_latency",
        settings: {
          environment: "production",
          service: "checkout",
          route: "GET /cart",
          percentile: "p95",
          thresholdMs: 500,
          windowMinutes: 10,
          minRequests: 20,
        },
      },
      warning: {
        reason: "not_seen",
        message:
          "No request from checkout on the route GET /cart arrived in production in the last 24 hours. The rule is saved. Monitoring starts when the service reports.",
      },
    });
    await sendRequests("checkout", after(-3), times(1, { route: "GET /cart", durationMs: 10 }));
    const again = await call("POST", rules(), { ...latency, channelIds: [channelId] });
    expect(again.json()).toMatchObject({ warning: null });

    const metric = await call("POST", rules(), {
      kind: "metric_threshold",
      settings: {
        metric: "queue.depth",
        metricKind: "gauge",
        value: 100,
        host: "web-9",
        environment: "Staging",
      },
      channelIds: [channelId],
    });
    expect(metric.statusCode).toBe(201);
    expect(metric.json()).toMatchObject({
      rule: {
        settings: {
          environment: "staging",
          metric: "queue.depth",
          metricKind: "gauge",
          aggregate: "avg",
          direction: "above",
          value: 100,
          host: "web-9",
          attributeKey: null,
          attributeValue: null,
        },
      },
      warning: {
        reason: "not_seen",
        message:
          "No point from the gauge queue.depth on host web-9 arrived in staging in the last 24 hours. The rule is saved. Monitoring starts when the metric reports.",
      },
    });
    // Turning it off is not a change of what it watches: nothing is looked for.
    const { id } = metric.json<{ rule: { id: string } }>().rule;
    const off = await call("PATCH", `${rules()}/${id}`, { enabled: false });
    expect(off.json()).toMatchObject({ rule: { enabled: false }, warning: null });
  });

  test("refuse settings a kind does not take", async () => {
    expect(await refused({ kind: "route_latency", settings: { thresholdMs: 10 } })).toBe(
      "invalid_service",
    );
    expect(await refused({ kind: "route_latency", settings: { service: "checkout" } })).toBe(
      "invalid_threshold",
    );
    expect(
      await refused({ kind: "route_latency", settings: { service: "checkout", thresholdMs: 0 } }),
    ).toBe("FST_ERR_VALIDATION");
    expect(
      await refused({
        kind: "route_failures",
        settings: { service: "checkout", thresholdPercent: 100 },
      }),
    ).toBe("invalid_threshold");
    expect(
      await refused({
        kind: "route_failures",
        settings: { service: "checkout", thresholdPercent: 5, windowMinutes: 90 },
      }),
    ).toBe("invalid_window");
    expect(
      await refused({
        kind: "metric_threshold",
        settings: { metric: "queue.depth", metricKind: "gauge", aggregate: "rate", value: 1 },
      }),
    ).toBe("invalid_aggregate");
    expect(
      await refused({
        kind: "metric_threshold",
        settings: { metric: "queue.depth", metricKind: "gauge", value: 1, attributeKey: "pool" },
      }),
    ).toBe("invalid_attribute");
    expect(
      await refused({ kind: "metric_threshold", settings: { metric: "queue.depth", value: 1 } }),
    ).toBe("invalid_metric_kind");
    expect(
      await refused({
        kind: "metric_threshold",
        settings: { metric: "queue.depth", metricKind: "summary", value: 1 },
      }),
    ).toBe("FST_ERR_VALIDATION");
  });

  test("a route rule's window is at most 30 minutes; a metric rule's, 60", async () => {
    expect(
      await refused({
        kind: "route_failures",
        settings: { service: "checkout", thresholdPercent: 5, windowMinutes: 31 },
      }),
    ).toBe("invalid_window");
    const metric = await call("POST", rules(), {
      kind: "metric_threshold",
      settings: { metric: "queue.depth", metricKind: "gauge", value: 1, windowMinutes: 60 },
      channelIds: [channelId],
    });
    expect(metric.statusCode).toBe(201);
  });

  test("the form's route suggestions: distinct services and routes of the last day", async () => {
    await sendRequests("checkout", after(-3), [
      ...times(3, { route: "GET /cart", durationMs: 10 }),
      { route: "POST /pay", durationMs: 10 },
    ]);
    await sendRequests("search", after(-3), [{ route: "GET /", durationMs: 10 }]);
    const response = await call("GET", `/projects/${projectId}/services/routes`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      environment: "production",
      maxRoutes: 200,
      routes: [
        { service: "checkout", route: "GET /cart" },
        { service: "checkout", route: "POST /pay" },
        { service: "search", route: "GET /" },
      ],
      truncated: false,
    });
    const signedOut = await dashboard.app.inject({
      url: `/api/projects/${projectId}/services/routes`,
    });
    expect(signedOut.statusCode).toBe(401);
  });

  test("signed out: 401; an unknown project: 404", async () => {
    const signedOut = await dashboard.app.inject({
      method: "POST",
      url: `/api${rules()}`,
      headers: { origin: PUBLIC_URL },
      payload: { ...latency, channelIds: [channelId] },
    });
    expect(signedOut.statusCode).toBe(401);
    const missing = await call(
      "POST",
      "/projects/00000000-0000-4000-8000-000000000000/alert-rules",
      {
        ...latency,
        channelIds: [channelId],
      },
    );
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "not_found" });
  });

  test("a metric's chart, narrowed to one host or one attribute value", async () => {
    const now = new Date();
    await sendMetric(gaugePoints("queue.depth", [{ at: now, value: 4, attributes: { q: "a" } }]), {
      "host.name": "web-1",
    });
    await sendMetric(gaugePoints("queue.depth", [{ at: now, value: 40, attributes: { q: "b" } }]), {
      "host.name": "web-2",
    });
    const chart = async (query: string) => {
      const response = await call(
        "GET",
        `/projects/${projectId}/metrics/chart?name=queue.depth&kind=gauge&period=today${query}`,
      );
      expect(response.statusCode).toBe(200);
      const body = response.json<{ series: { values: { max: (number | null)[] } }[] }>();
      return Math.max(...(body.series[0]?.values.max ?? []).map((value) => value ?? 0));
    };
    expect(await chart("")).toBe(40);
    expect(await chart("&host=web-1")).toBe(4);
    expect(await chart("&attr=q&attrValue=b")).toBe(40);
    const lone = await call(
      "GET",
      `/projects/${projectId}/metrics/chart?name=queue.depth&kind=gauge&attr=q`,
    );
    expect(lone.statusCode).toBe(400);
  });
});
