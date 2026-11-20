import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { QueryParams, queryRows } from "../src/clickhouse/query.ts";
import { listChartBuckets, telemetryRange } from "../src/telemetry/dashboard-query.ts";
import {
  LIVE_PAGE_SIZE,
  LIVE_SETTLE_MS,
  LIVE_WINDOW_MS,
  searchWords,
} from "../src/telemetry/logs.ts";
import { MAX_TRACE_SPANS, traceChart } from "../src/telemetry/traces.ts";
import { signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";
import { keyValues, secretKeyOf } from "./helpers/telemetry.ts";

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;

const MS = 1_000_000n;
/** Now, less some minutes, in nanoseconds since 1970: every record is recent. */
const minutesAgo = (minutes: number) => BigInt(Date.now() - minutes * 60_000) * MS;
/** `minutes` ago, or today's midnight (UTC, the tests' timezone) when that is later. */
const minutesAgoToday = (minutes: number) => {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return BigInt(Math.max(now.getTime() - minutes * 60_000, midnight)) * MS;
};

const byText = (a: string, b: string) => a.localeCompare(b);

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

const resource = (service: string, environment?: string) => ({
  attributes: keyValues({
    "service.name": service,
    "service.version": "2.3.1",
    ...(environment === undefined ? {} : { "deployment.environment.name": environment }),
    "host.name": "web-1",
  }),
});

interface SpanInput {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  start: bigint;
  durationMs: number;
  kind?: number;
  status?: { code: number; message?: string };
  attributes?: Record<string, string | number | boolean>;
  events?: object[];
  links?: object[];
}

const jsonSpan = (span: SpanInput) => ({
  traceId: span.traceId,
  spanId: span.spanId,
  parentSpanId: span.parentSpanId ?? "",
  name: span.name,
  kind: span.kind ?? 1,
  startTimeUnixNano: String(span.start),
  endTimeUnixNano: String(span.start + BigInt(span.durationMs) * MS),
  attributes: keyValues(span.attributes ?? {}),
  status: span.status ?? { code: 0 },
  events: span.events ?? [],
  links: span.links ?? [],
});

async function send(path: string, secretKey: string, body: object) {
  const response = await dashboard.app.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "application/json", authorization: `Bearer ${secretKey}` },
    payload: JSON.stringify(body),
  });
  expect({ status: response.statusCode, body: response.json() }).toEqual({ status: 200, body: {} });
}

/** Sends spans, each group under its own service (and environment). */
async function sendSpans(
  secretKey: string,
  groups: { service: string; environment?: string; spans: SpanInput[] }[],
) {
  await send("/v1/traces", secretKey, {
    resourceSpans: groups.map((group) => ({
      resource: resource(group.service, group.environment),
      scopeSpans: [{ scope: { name: "http", version: "1.0" }, spans: group.spans.map(jsonSpan) }],
    })),
  });
}

interface LogInput {
  time: bigint;
  severityNumber?: number;
  severityText?: string;
  body: string;
  traceId?: string;
  spanId?: string;
  attributes?: Record<string, string | number | boolean>;
}

async function sendLogs(
  secretKey: string,
  groups: { service: string; environment?: string; logs: LogInput[] }[],
) {
  await send("/v1/logs", secretKey, {
    resourceLogs: groups.map((group) => ({
      resource: resource(group.service, group.environment),
      scopeLogs: [
        {
          scope: { name: "app" },
          logRecords: group.logs.map((log) => ({
            timeUnixNano: String(log.time),
            observedTimeUnixNano: String(log.time),
            severityNumber: log.severityNumber ?? 0,
            severityText: log.severityText ?? "",
            body: { stringValue: log.body },
            traceId: log.traceId ?? "",
            spanId: log.spanId ?? "",
            attributes: keyValues(log.attributes ?? {}),
          })),
        },
      ],
    })),
  });
}

async function newProject(name: string) {
  const project = await insertProject(dashboard.db, { name });
  return { id: project.id, secretKey: await secretKeyOf(dashboard.db, project.id) };
}

function get(projectId: string, path: string, cookie = dashboard.cookie) {
  return dashboard.app.inject({
    url: `/api/projects/${projectId}${path}`,
    headers: { cookie },
  });
}

/** The status of each path, to compare with what each should get. */
async function statuses(projectId: string, paths: string[], cookie = dashboard.cookie) {
  const answers: Record<string, number> = {};
  for (const path of paths) answers[path] = (await get(projectId, path, cookie)).statusCode;
  return answers;
}

const all = (paths: string[], status: number) =>
  Object.fromEntries(paths.map((path) => [path, status]));

async function getJson(projectId: string, path: string) {
  const response = await get(projectId, path);
  expect({ path, status: response.statusCode }).toEqual({ path, status: 200 });
  return response.json();
}

// The shop's project: three traces and their logs.
let shop = { id: "", secretKey: "" };
const ORDER = { trace: hex(16), root: hex(8), query: hex(8), charge: hex(8), card: hex(8) };
const ORPHAN = hex(8);
const HEALTH = { trace: hex(16), root: hex(8) };
const CHECKOUT = { trace: hex(16), root: hex(8) };
const LINKED = { trace: hex(16), span: hex(8) };
const ORDER_START = minutesAgo(10);

beforeAll(async () => {
  dashboard = await signedInDashboard();
  shop = await newProject("Shop");
  await sendSpans(shop.secretKey, [
    {
      service: "web",
      spans: [
        // GET /orders/{id}, 120 ms, ok, with a query, and a charge that failed.
        {
          traceId: ORDER.trace,
          spanId: ORDER.root,
          name: "GET /orders/{id}",
          kind: 2,
          start: ORDER_START,
          durationMs: 120,
          attributes: { "http.route": "/orders/{id}", "http.response.status_code": 200 },
          events: [
            {
              timeUnixNano: String(ORDER_START + 5n * MS),
              name: "cache miss",
              attributes: keyValues({ key: "order:5120" }),
            },
          ],
          links: [
            {
              traceId: LINKED.trace,
              spanId: LINKED.span,
              attributes: keyValues({ reason: "queued by" }),
            },
          ],
        },
        {
          traceId: ORDER.trace,
          spanId: ORDER.query,
          parentSpanId: ORDER.root,
          name: "SELECT orders",
          kind: 3,
          start: ORDER_START + 10n * MS,
          durationMs: 30,
        },
        // Its parent was never received: shown at the top level.
        {
          traceId: ORDER.trace,
          spanId: ORPHAN,
          parentSpanId: hex(8),
          name: "background refresh",
          start: ORDER_START + 15n * MS,
          durationMs: 5,
        },
        // GET /health, 2 ms, 20 minutes ago.
        {
          traceId: HEALTH.trace,
          spanId: HEALTH.root,
          name: "GET /health",
          kind: 2,
          start: minutesAgo(20),
          durationMs: 2,
        },
      ],
    },
    {
      service: "payments",
      spans: [
        {
          traceId: ORDER.trace,
          spanId: ORDER.charge,
          parentSpanId: ORDER.root,
          name: "POST /charge",
          kind: 2,
          start: ORDER_START + 50n * MS,
          durationMs: 60,
          status: { code: 2, message: "card declined" },
        },
        {
          traceId: ORDER.trace,
          spanId: ORDER.card,
          parentSpanId: ORDER.charge,
          name: "gateway call",
          kind: 3,
          start: ORDER_START + 55n * MS,
          durationMs: 40,
        },
      ],
    },
    {
      service: "payments",
      environment: "Staging",
      spans: [
        {
          traceId: CHECKOUT.trace,
          spanId: CHECKOUT.root,
          name: "POST /checkout",
          kind: 2,
          start: minutesAgo(30),
          durationMs: 900,
        },
      ],
    },
  ]);
  await sendLogs(shop.secretKey, [
    {
      service: "web",
      logs: [
        {
          time: ORDER_START + 1n * MS,
          severityNumber: 9,
          severityText: "INFO",
          body: "loading order 5120",
          traceId: ORDER.trace,
          spanId: ORDER.root,
          attributes: { "order.id": "5120" },
        },
        {
          time: ORDER_START + 2n * MS,
          severityNumber: 5,
          severityText: "DEBUG",
          body: "cache miss for order 5120",
          traceId: ORDER.trace,
        },
        { time: minutesAgo(40), severityNumber: 13, body: "Slow request: GET /orders took 2s" },
        { time: minutesAgo(41), severityNumber: 0, body: "no severity at all" },
      ],
    },
    {
      service: "payments",
      logs: [
        {
          time: ORDER_START + 60n * MS,
          severityNumber: 17,
          severityText: "ERROR",
          body: "Payment declined: card_declined (order 5120)",
          traceId: ORDER.trace,
          spanId: ORDER.charge,
        },
      ],
    },
    {
      service: "payments",
      environment: "staging",
      logs: [{ time: minutesAgo(30), severityNumber: 21, body: "PAYMENT gateway down" }],
    },
  ]);
});

afterAll(async () => {
  await dashboard?.close();
});

/** The root spans' names the shop's traces list has with this query. */
const names = async (query: string) =>
  (await getJson(shop.id, `/traces?period=7d&${query}`)).traces.map(
    (trace: { name: string }) => trace.name,
  );

/** The bodies of the shop's log records this query finds. */
const bodies = async (query: string) =>
  (await getJson(shop.id, `/logs?period=7d&${query}`)).logs.map(
    (log: { body: string }) => log.body,
  );

/** The query plan of a read of the shop's rows, with its indexes. */
const explain = async (table: string, condition: string, params: Record<string, string>) => {
  const result = await dashboard.reader.client.query({
    query: `EXPLAIN indexes = 1
            SELECT id FROM ${table} FINAL
            WHERE project_id = {project:UUID} AND ${condition}`,
    query_params: { project: shop.id, ...params },
    format: "TabSeparatedRaw",
  });
  return result.text();
};

describe("GET /api/projects/:id/traces", () => {
  test("lists root spans newest first, with each trace's spans and whether any failed", async () => {
    const list = await getJson(shop.id, "/traces?period=7d");
    expect(list).toMatchObject({
      timeZone: "UTC",
      environment: "production",
      retentionDays: 30,
      next: null,
      received: true,
    });
    expect(list.environments).toEqual(["production", "staging"]);
    expect(list.services.toSorted(byText)).toEqual(["web"]);
    expect(list.traces).toEqual([
      {
        traceId: ORDER.trace,
        spanId: ORDER.root,
        service: "web",
        name: "GET /orders/{id}",
        start: new Date(Number(ORDER_START / MS)).toISOString(),
        durationUs: 120_000,
        error: true,
        spans: 5,
      },
      expect.objectContaining({
        traceId: HEALTH.trace,
        name: "GET /health",
        durationUs: 2000,
        error: false,
        spans: 1,
      }),
    ]);
  });

  test("filters by environment, service, name, errors, and duration", async () => {
    expect(await names("environment=Staging")).toEqual(["POST /checkout"]);
    expect(await names("environment=staging&service=payments")).toEqual(["POST /checkout"]);
    expect(await names("service=payments")).toEqual([]);
    expect(await names("service=web&name=orders")).toEqual(["GET /orders/{id}"]);
    expect(await names("name=HEALTH")).toEqual(["GET /health"]);
    // Its root is fine, but its charge failed.
    expect(await names("errors=true")).toEqual(["GET /orders/{id}"]);
    expect(await names("minDuration=100")).toEqual(["GET /orders/{id}"]);
    expect(await names("minDuration=2")).toEqual(["GET /orders/{id}", "GET /health"]);
    expect(await names("minDuration=3&errors=false")).toEqual(["GET /orders/{id}"]);
  });

  test("pages back with a cursor, a hundred at a time, never repeating a trace", async () => {
    const busy = await newProject("Busy");
    const spans = Array.from({ length: 130 }, (_, i) => ({
      traceId: hex(16),
      spanId: hex(8),
      name: `job ${i}`,
      start: minutesAgo(60) - BigInt(i) * 1000n * MS,
      durationMs: 1,
    }));
    await sendSpans(busy.secretKey, [{ service: "worker", spans }]);
    const first = await getJson(busy.id, "/traces?period=7d");
    expect(first.traces).toHaveLength(100);
    expect(first.next).toMatch(/^[0-9]+-[0-9a-f]{48}$/);
    const second = await getJson(busy.id, `/traces?period=7d&before=${first.next}`);
    expect(second.next).toBeNull();
    const seen = [...first.traces, ...second.traces].map((trace: { name: string }) => trace.name);
    expect(seen).toEqual(spans.map((span) => span.name));
  });

  test("says when the project has never sent a span", async () => {
    const quiet = await newProject("Quiet");
    expect(await getJson(quiet.id, "/traces?period=7d")).toMatchObject({
      traces: [],
      next: null,
      received: false,
    });
    // Spans, but none in the environment asked for: received, and the list is empty.
    expect(await getJson(shop.id, "/traces?period=7d&environment=test")).toMatchObject({
      traces: [],
      received: true,
    });
  });

  test("refuses bad parameters", async () => {
    const bad = [
      "period=forever",
      "period=7d&minDuration=-1",
      "period=7d&minDuration=fast",
      "period=7d&minDuration=86400001",
      "period=7d&errors=maybe",
      `period=7d&name=${"x".repeat(201)}`,
      "period=7d&name=",
      "period=7d&before=yesterday",
      `period=7d&before=99999999999999999999-${"a".repeat(48)}`,
      `period=7d&before=9999999999999999999-${"a".repeat(48)}`,
      "period=7d&environment=no%20spaces",
    ].map((query) => `/traces?${query}`);
    expect(await statuses(shop.id, bad)).toEqual(all(bad, 400));
  });
});

describe("GET /api/projects/:id/traces/:traceId", () => {
  test("gives the spans by start, with their parents and offsets, and the trace's logs", async () => {
    const trace = await getJson(shop.id, `/traces/${ORDER.trace}`);
    expect(trace).toMatchObject({
      traceId: ORDER.trace,
      timeZone: "UTC",
      retentionDays: 30,
      start: new Date(Number(ORDER_START / MS)).toISOString(),
      durationUs: 120_000,
      totalSpans: 5,
      logsTruncated: false,
    });
    expect(
      trace.spans.map((span: Record<string, unknown>) => [
        span.name,
        span.parentSpanId,
        span.service,
        span.kind,
        span.status,
        span.offsetUs,
        span.durationUs,
      ]),
    ).toEqual([
      ["GET /orders/{id}", "", "web", "server", "unset", 0, 120_000],
      ["SELECT orders", ORDER.root, "web", "client", "unset", 10_000, 30_000],
      [
        "background refresh",
        expect.stringMatching(/^[0-9a-f]{16}$/),
        "web",
        "internal",
        "unset",
        15_000,
        5000,
      ],
      ["POST /charge", ORDER.root, "payments", "server", "error", 50_000, 60_000],
      ["gateway call", ORDER.charge, "payments", "client", "unset", 55_000, 40_000],
    ]);
    expect(trace.spans[0].startNs).toBe(String(ORDER_START));
    expect(
      trace.logs.map((log: Record<string, unknown>) => [log.body, log.spanId, log.severityNumber]),
    ).toEqual([
      ["loading order 5120", ORDER.root, 9],
      ["cache miss for order 5120", null, 5],
      ["Payment declined: card_declined (order 5120)", ORDER.charge, 17],
    ]);
    // Summaries: a record's attributes come with its detail.
    expect(trace.logs[0]).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      time: new Date(Number((ORDER_START + MS) / MS)).toISOString(),
      timeNs: String(ORDER_START + MS),
      severityNumber: 9,
      severityText: "INFO",
      body: "loading order 5120",
      bodyTruncated: false,
      traceId: ORDER.trace,
      spanId: ORDER.root,
      eventName: "",
      service: "web",
      environment: "production",
    });
  });

  test("looks a day either side of a known time, and takes the ID in any case", async () => {
    const near = new Date(Number(ORDER_START / MS) + 3_600_000).toISOString();
    const around = await getJson(shop.id, `/traces/${ORDER.trace.toUpperCase()}?at=${near}`);
    expect(around.totalSpans).toBe(5);
    const farAway = new Date(Number(ORDER_START / MS) - 3 * 86_400_000).toISOString();
    const elsewhere = await getJson(shop.id, `/traces/${ORDER.trace}?at=${farAway}`);
    expect(elsewhere).toMatchObject({ spans: [], logs: [], totalSpans: 0, start: null });
  });

  test("answers a trace with nothing kept with no spans, not an error", async () => {
    const unknown = await getJson(shop.id, `/traces/${hex(16)}`);
    expect(unknown).toMatchObject({ spans: [], logs: [], totalSpans: 0, durationUs: 0 });
  });

  test(`reads at most ${MAX_TRACE_SPANS} spans, and says how many there are`, async () => {
    const big = await newProject("Big trace");
    const traceId = hex(16);
    const root = hex(8);
    const start = minutesAgo(5);
    const spans = Array.from({ length: MAX_TRACE_SPANS + 3 }, (_, i) => ({
      traceId,
      spanId: i === 0 ? root : hex(8),
      ...(i === 0 ? {} : { parentSpanId: root }),
      name: i === 0 ? "batch" : `item ${i}`,
      start: start + BigInt(i) * MS,
      durationMs: 1,
    }));
    await sendSpans(big.secretKey, [{ service: "worker", spans }]);
    const trace = await getJson(big.id, `/traces/${traceId}`);
    expect(trace.spans).toHaveLength(MAX_TRACE_SPANS);
    expect(trace.totalSpans).toBe(MAX_TRACE_SPANS + 3);
    expect(trace.spans[0].name).toBe("batch");
  });

  test("refuses bad IDs and times", async () => {
    const bad = [
      "/traces/not-a-trace",
      `/traces/${hex(15)}`,
      `/traces/${hex(16)}?at=yesterday`,
      `/traces/${hex(16)}?at=2026-13-45T99:00:00Z`,
    ];
    expect(await statuses(shop.id, bad)).toEqual(all(bad, 400));
  });
});

describe("GET /api/projects/:id/traces/:traceId/spans/:spanId", () => {
  test("gives a span's attributes, resource, events, links, status, and kind", async () => {
    const response = await getJson(
      shop.id,
      `/traces/${ORDER.trace}/spans/${ORDER.root}?start=${ORDER_START}`,
    );
    expect(response.timeZone).toBe("UTC");
    expect(response.span).toEqual({
      traceId: ORDER.trace,
      spanId: ORDER.root,
      parentSpanId: "",
      name: "GET /orders/{id}",
      kind: "server",
      status: "unset",
      statusMessage: "",
      service: "web",
      release: "2.3.1",
      environment: "production",
      start: new Date(Number(ORDER_START / MS)).toISOString(),
      durationUs: 120_000,
      attributes: { "http.route": "/orders/{id}", "http.response.status_code": "200" },
      resourceAttributes: {
        "service.name": "web",
        "service.version": "2.3.1",
        "host.name": "web-1",
      },
      droppedAttributes: 0,
      events: [
        {
          name: "cache miss",
          time: new Date(Number((ORDER_START + 5n * MS) / MS)).toISOString(),
          offsetUs: 5000,
          attributes: { key: "order:5120" },
        },
      ],
      droppedEvents: 0,
      links: [{ traceId: LINKED.trace, spanId: LINKED.span, attributes: { reason: "queued by" } }],
      droppedLinks: 0,
      scope: { name: "http", version: "1.0" },
    });
    const charge = await getJson(
      shop.id,
      `/traces/${ORDER.trace}/spans/${ORDER.charge}?start=${ORDER_START + 50n * MS}`,
    );
    expect(charge.span).toMatchObject({ status: "error", statusMessage: "card declined" });
  });

  test("is not found at another start, or with another trace", async () => {
    const wrongStart = await get(
      shop.id,
      `/traces/${ORDER.trace}/spans/${ORDER.root}?start=${ORDER_START + 1n}`,
    );
    expect(wrongStart.statusCode).toBe(404);
    expect(wrongStart.json().error).toBe("no_span");
    const wrongTrace = await get(
      shop.id,
      `/traces/${HEALTH.trace}/spans/${ORDER.root}?start=${ORDER_START}`,
    );
    expect(wrongTrace.statusCode).toBe(404);
  });

  test("refuses bad IDs and starts", async () => {
    const bad = [
      `/traces/${ORDER.trace}/spans/${ORDER.root}`,
      `/traces/${ORDER.trace}/spans/${ORDER.root}?start=soon`,
      `/traces/${ORDER.trace}/spans/${ORDER.root}?start=9999999999999999999`,
      `/traces/${ORDER.trace}/spans/xyz?start=1`,
    ];
    expect(await statuses(shop.id, bad)).toEqual(all(bad, 400));
  });
});

describe("GET /api/projects/:id/logs", () => {
  test("lists log records newest first, with their attributes and trace", async () => {
    const result = await getJson(shop.id, "/logs?period=7d");
    expect(result).toMatchObject({
      timeZone: "UTC",
      environment: "production",
      retentionDays: 30,
      next: null,
      received: true,
    });
    expect(result.environments).toEqual(["production", "staging"]);
    expect(result.services.toSorted(byText)).toEqual(["payments", "web"]);
    expect(result.logs.map((log: { body: string }) => log.body)).toEqual([
      "Payment declined: card_declined (order 5120)",
      "cache miss for order 5120",
      "loading order 5120",
      "Slow request: GET /orders took 2s",
      "no severity at all",
    ]);
    expect(result.logs[0]).toMatchObject({
      severityNumber: 17,
      severityText: "ERROR",
      traceId: ORDER.trace,
      spanId: ORDER.charge,
      service: "payments",
      bodyTruncated: false,
    });
    expect(result.logs[0]).not.toHaveProperty("attributes");
    expect(result.logs[4]).toMatchObject({ traceId: null, spanId: null, severityNumber: 0 });
  });

  test("finds words in the body, in any case, whole or in part", async () => {
    const payment = "Payment declined: card_declined (order 5120)";
    expect(await bodies("search=declined")).toEqual([payment]);
    expect(await bodies("search=pAyMeNt")).toEqual([payment]);
    expect(await bodies("search=decline")).toEqual([payment]);
    // Every word, anywhere: card_declined is the words card and declined.
    expect(await bodies("search=declined%20card")).toEqual([payment]);
    expect(await bodies("search=card_declined")).toEqual([payment]);
    expect(await bodies("search=ORDER%205120")).toEqual([
      payment,
      "cache miss for order 5120",
      "loading order 5120",
    ]);
    expect(await bodies("search=order%205121")).toEqual([]);
    // Punctuation alone searches for nothing; LIKE's wildcards are not words.
    expect(await bodies("search=%3A%3A").then((found) => found.length)).toBe(5);
    expect(await bodies("search=%25_%25")).toHaveLength(5);
  });

  test("words and trace IDs read the indexes, not every record", async () => {
    expect(await explain("logs", "body ILIKE {word:String}", { word: "%declin%" })).toContain(
      "body_text",
    );
    expect(await explain("logs", "trace_id = {trace:String}", { trace: ORDER.trace })).toContain(
      "trace_id_index",
    );
    expect(await explain("spans", "trace_id = {trace:String}", { trace: ORDER.trace })).toContain(
      "trace_id_index",
    );
  });

  test("filters by minimum severity, service, environment, and trace", async () => {
    expect(await bodies("severity=warn")).toEqual([
      "Payment declined: card_declined (order 5120)",
      "Slow request: GET /orders took 2s",
    ]);
    expect(await bodies("severity=trace")).toHaveLength(4);
    expect(await bodies("service=web&severity=info")).toEqual([
      "loading order 5120",
      "Slow request: GET /orders took 2s",
    ]);
    expect(await bodies("environment=staging&search=payment")).toEqual(["PAYMENT gateway down"]);
    expect(await bodies(`traceId=${ORDER.trace.toUpperCase()}`)).toEqual([
      "Payment declined: card_declined (order 5120)",
      "cache miss for order 5120",
      "loading order 5120",
    ]);
  });

  test("pages back with a cursor", async () => {
    const chatty = await newProject("Chatty");
    const logs = Array.from({ length: 70 }, (_, i) => ({
      time: minutesAgo(5) - BigInt(i) * 1000n * MS,
      severityNumber: 9,
      body: `line ${i}`,
    }));
    await sendLogs(chatty.secretKey, [{ service: "worker", logs }]);
    const first = await getJson(chatty.id, "/logs?period=7d");
    expect(first.logs).toHaveLength(50);
    const second = await getJson(chatty.id, `/logs?period=7d&before=${first.next}`);
    expect(second.next).toBeNull();
    expect([...first.logs, ...second.logs].map((log: { body: string }) => log.body)).toEqual(
      logs.map((log) => log.body),
    );
  });

  test("says when the project has never sent a log record", async () => {
    const quiet = await newProject("Quiet logs");
    expect(await getJson(quiet.id, "/logs?period=7d")).toMatchObject({
      logs: [],
      received: false,
    });
  });

  test("refuses bad parameters", async () => {
    const bad = [
      "period=7d&severity=loud",
      "period=7d&traceId=abc",
      `period=7d&search=${"a".repeat(201)}`,
      "period=7d&search=a%20b%20c%20d%20e%20f%20g%20h%20i",
      "period=7d&before=1-xyz",
      "from=2026-11-10",
    ].map((query) => `/logs?${query}`);
    expect(await statuses(shop.id, bad)).toEqual(all(bad, 400));
  });
});

describe("GET /api/projects/:id/logs/:logId", () => {
  test("lists a summary with the body cut, and gives the whole record on its own", async () => {
    const verbose = await newProject("Verbose");
    const body = `${"é".repeat(999)}xyz${"a".repeat(60_000)}`;
    const attributes = Object.fromEntries(
      Array.from({ length: 128 }, (_, i) => [`key.${i}`, "v".repeat(4000)]),
    );
    await sendLogs(verbose.secretKey, [
      {
        service: "api",
        logs: [{ time: minutesAgo(3), severityNumber: 13, body, attributes }],
      },
    ]);
    const listed = await get(verbose.id, "/logs?period=7d");
    // 64 KB of body and 512 KB of attributes stored; the list sends a little over 1,000 characters.
    expect(listed.body.length).toBeLessThan(4000);
    const [summary] = listed.json().logs;
    expect(summary.body).toBe(`${"é".repeat(999)}x`);
    expect(summary.bodyTruncated).toBe(true);

    const detail = await getJson(verbose.id, `/logs/${summary.id}?time=${summary.timeNs}`);
    expect(detail.timeZone).toBe("UTC");
    expect(detail.log).toMatchObject({
      id: summary.id,
      timeNs: summary.timeNs,
      body,
      severityNumber: 13,
      service: "api",
      release: "2.3.1",
      environment: "production",
      traceId: null,
      spanId: null,
      scope: { name: "app", version: "" },
      resourceAttributes: { "service.name": "api", "host.name": "web-1" },
    });
    expect(Object.keys(detail.log.attributes)).toHaveLength(128);
    expect(detail.log.observedTime).toBe(summary.time);
  });

  test("is not found at another time, or in another project", async () => {
    const [log] = (await getJson(shop.id, "/logs?period=7d")).logs;
    const wrongTime = await get(shop.id, `/logs/${log.id}?time=${BigInt(log.timeNs) + 1n}`);
    expect(wrongTime.statusCode).toBe(404);
    expect(wrongTime.json().error).toBe("no_log");
    const other = await newProject("Other");
    expect((await get(other.id, `/logs/${log.id}?time=${log.timeNs}`)).statusCode).toBe(404);
  });

  test("refuses bad IDs and times", async () => {
    const bad = [
      `/logs/${"a".repeat(32)}`,
      `/logs/${"a".repeat(31)}?time=1`,
      `/logs/${"A".repeat(32)}?time=1`,
      `/logs/${"a".repeat(32)}?time=soon`,
      `/logs/${"a".repeat(32)}?time=9999999999999999999`,
    ];
    expect(await statuses(shop.id, bad)).toEqual(all(bad, 400));
  });
});

describe("pages read without FINAL", () => {
  test("drop a retried span's and record's copies, and page across rows at one time", async () => {
    const retried = await newProject("Retried");
    // 120 roots at three times, 40 at each, and 70 records, 30 at each: pages end inside a group.
    const times = [minutesAgo(10), minutesAgo(20), minutesAgo(30)];
    const spans = Array.from({ length: 120 }, (_, i) => ({
      traceId: hex(16),
      spanId: hex(8),
      name: `job ${i}`,
      start: times[Math.floor(i / 40)] ?? 0n,
      durationMs: 1,
    }));
    const logs = Array.from({ length: 70 }, (_, i) => ({
      time: times[Math.floor(i / 30)] ?? 0n,
      severityNumber: 9,
      body: `line ${i}`,
    }));
    // Each sent twice, as an exporter retries after a lost answer.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await sendSpans(retried.secretKey, [{ service: "worker", spans }]);
      await sendLogs(retried.secretKey, [{ service: "worker", logs }]);
    }

    const first = await getJson(retried.id, "/traces?period=7d");
    expect(first.traces).toHaveLength(100);
    const second = await getJson(retried.id, `/traces?period=7d&before=${first.next}`);
    expect(second.next).toBeNull();
    const listed = [...first.traces, ...second.traces].map((trace: { name: string }) => trace.name);
    expect(listed.toSorted(byText)).toEqual(spans.map((span) => span.name).toSorted(byText));
    // Newest first: the groups in order.
    expect(listed.slice(0, 40).toSorted(byText)).toEqual(
      spans
        .slice(0, 40)
        .map((span) => span.name)
        .toSorted(byText),
    );

    const logPages = [await getJson(retried.id, "/logs?period=7d")];
    while (logPages.at(-1)?.next !== null) {
      logPages.push(await getJson(retried.id, `/logs?period=7d&before=${logPages.at(-1)?.next}`));
    }
    const pagedBodies = logPages.flatMap((page) =>
      page.logs.map((log: { body: string }) => log.body),
    );
    expect(logPages[0].logs).toHaveLength(50);
    expect(pagedBodies.toSorted(byText)).toEqual(logs.map((log) => log.body).toSorted(byText));
  });
});

describe("ingestion for the pages", () => {
  test("all-zero IDs are none: such a parent makes a root, such a trace no trace", async () => {
    const zeros = await newProject("Zeros");
    const traceId = hex(16);
    const root = hex(8);
    await sendSpans(zeros.secretKey, [
      {
        service: "web",
        spans: [
          {
            traceId,
            spanId: root,
            parentSpanId: "0".repeat(16),
            name: "root with a zero parent",
            start: minutesAgo(2),
            durationMs: 3,
            links: [{ traceId: "0".repeat(32), spanId: "0".repeat(16), attributes: [] }],
          },
        ],
      },
    ]);
    await sendLogs(zeros.secretKey, [
      {
        service: "web",
        logs: [
          {
            time: minutesAgo(2),
            body: "no trace",
            traceId: "0".repeat(32),
            spanId: "0".repeat(16),
          },
        ],
      },
    ]);
    const list = await getJson(zeros.id, "/traces?period=7d");
    expect(list.traces.map((trace: { name: string }) => trace.name)).toEqual([
      "root with a zero parent",
    ]);
    const trace = await getJson(zeros.id, `/traces/${traceId}`);
    expect(trace.spans[0].parentSpanId).toBe("");
    const span = await getJson(
      zeros.id,
      `/traces/${traceId}/spans/${root}?start=${trace.spans[0].startNs}`,
    );
    expect(span.span.links).toEqual([{ traceId: "", spanId: "", attributes: {} }]);
    const [log] = (await getJson(zeros.id, "/logs?period=7d")).logs;
    expect(log).toMatchObject({ body: "no trace", traceId: null, spanId: null });
  });

  test("labels lose their control characters, so the service filter takes them", async () => {
    const noisy = await newProject("Noisy");
    await sendSpans(noisy.secretKey, [
      {
        service: "check\u0007out\n",
        spans: [
          { traceId: hex(16), spanId: hex(8), name: "GET /", start: minutesAgo(2), durationMs: 1 },
        ],
      },
    ]);
    const list = await getJson(noisy.id, "/traces?period=7d");
    expect(list.services).toEqual(["checkout"]);
    const filtered = await getJson(noisy.id, "/traces?period=7d&service=checkout");
    expect(filtered.traces).toHaveLength(1);
  });
});

interface LogTime {
  severityNumber: number;
  timeNs: string;
}

/** A chart as the API answers it: each bucket's start. */
interface ChartFrame {
  buckets: number;
  bucketStarts: string[];
}

/** The bucket a time falls in on a chart the API answered: the last start at or before it. */
const bucketOf = (chart: ChartFrame, ns: bigint) =>
  Math.max(
    0,
    chart.bucketStarts.findLastIndex((start) => Date.parse(start) <= Number(ns / MS)),
  );

/** Counts per bucket, as the API gives them, of records at these times. */
function perBucket(chart: ChartFrame, times: bigint[]) {
  const counts: number[] = Array.from({ length: chart.buckets }, () => 0);
  for (const time of times) {
    const index = bucketOf(chart, time);
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts;
}

/** "YYYY-MM-DD", in UTC (the tests' timezone), `days` ago. */
const dayAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The traces chart's totals of the shop with this query. */
const traceTotals = async (query: string) =>
  (await getJson(shop.id, `/traces/chart?period=7d&${query}`)).total;

/** A poll's bodies, cursor, what it skipped, and its gap. */
const poll = async (projectId: string, query = "") => {
  const answer = await getJson(projectId, `/logs/live?${query}`);
  return {
    bodies: answer.logs.map((log: { body: string }) => log.body) as string[],
    cursor: answer.cursor as string,
    skipped: answer.skipped as number,
    gap: answer.gap as { from: string; to: string } | null,
    ids: answer.logs.map((log: { id: string }) => log.id) as string[],
  };
};

/** Nanoseconds since 1970 as ClickHouse takes a DateTime64(9) in JSON. */
const nanosText = (ns: bigint) =>
  `${new Date(Number(ns / MS)).toISOString().slice(0, 19).replace("T", " ")}.${(ns % 1_000_000_000n)
    .toString()
    .padStart(9, "0")}`;

/** Log records written straight into ClickHouse, each with its own arrival. */
async function insertLogs(projectId: string, records: { body: string; receivedNs: bigint }[]) {
  await dashboard.reader.client.insert({
    table: "logs",
    values: records.map((record) => ({
      project_id: projectId,
      timestamp: nanosText(record.receivedNs),
      observed_timestamp: nanosText(record.receivedNs),
      received_at: nanosText(record.receivedNs),
      id: hex(16),
      severity_number: 9,
      body: record.body,
      service: "web",
      environment: "production",
    })),
    format: "JSONEachRow",
  });
}

describe("GET /api/projects/:id/logs/volume", () => {
  test("counts the records per time bucket and severity range", async () => {
    const volume = await getJson(shop.id, "/logs/volume?period=7d");
    expect(volume).toMatchObject({
      timeZone: "UTC",
      environment: "production",
      retentionDays: 30,
      total: 5,
    });
    // About 60 to 120 buckets over a week, on whole hours from the first day's start.
    expect(volume.stepSeconds).toBe(7200);
    expect(volume.buckets).toBeGreaterThanOrEqual(72);
    expect(volume.buckets).toBeLessThanOrEqual(84);
    expect(volume.start).toBe(`${dayAgo(6)}T00:00:00.000Z`);
    // Each record in the bucket of its time, as the list gives it.
    const { logs } = await getJson(shop.id, "/logs?period=7d");
    const timesOf = (from: number, to: number) =>
      logs
        .filter((log: LogTime) => log.severityNumber >= from && log.severityNumber < to)
        .map((log: LogTime) => BigInt(log.timeNs));
    expect(volume.counts).toEqual({
      none: perBucket(volume, timesOf(0, 1)),
      trace: perBucket(volume, []),
      debug: perBucket(volume, timesOf(5, 9)),
      info: perBucket(volume, timesOf(9, 13)),
      warn: perBucket(volume, timesOf(13, 17)),
      error: perBucket(volume, timesOf(17, 21)),
      fatal: perBucket(volume, []),
    });
    expect(volume.counts.debug.filter((count: number) => count > 0)).toEqual([1]);
  });

  test("applies the search's filters: severity, service, environment, words, and trace", async () => {
    const totals = async (query: string) =>
      (await getJson(shop.id, `/logs/volume?period=7d&${query}`)).total;
    expect(await totals("severity=warn")).toBe(2);
    expect(await totals("service=web")).toBe(4);
    expect(await totals("service=web&severity=info")).toBe(2);
    expect(await totals("environment=staging")).toBe(1);
    expect(
      (await getJson(shop.id, "/logs/volume?period=7d&environment=staging")).counts.fatal,
    ).toContain(1);
    expect(await totals("search=order%205120")).toBe(3);
    expect(await totals(`traceId=${ORDER.trace.toUpperCase()}`)).toBe(3);
  });

  test("counts only the period", async () => {
    const old = await newProject("Old logs");
    const logs = [
      { time: minutesAgo(48 * 60), severityNumber: 9, body: "two days ago" },
      // Today, also from 00:00 to 00:05, when 5 minutes ago is yesterday.
      { time: minutesAgoToday(5), severityNumber: 9, body: "just now" },
    ];
    await sendLogs(old.secretKey, [{ service: "worker", logs }]);
    const totals = async (query: string) => (await getJson(old.id, `/logs/volume?${query}`)).total;
    expect(await totals("period=7d")).toBe(2);
    expect(await totals(`from=${dayAgo(2)}&to=${dayAgo(2)}`)).toBe(1);
    expect(await totals(`from=${dayAgo(1)}&to=${dayAgo(1)}`)).toBe(0);
    // A day is 96 buckets of 15 minutes; a past day's last bucket ends at midnight.
    const day = await getJson(old.id, `/logs/volume?from=${dayAgo(2)}&to=${dayAgo(2)}`);
    expect({ step: day.stepSeconds, buckets: day.buckets }).toEqual({ step: 900, buckets: 96 });
    expect(day.counts.info).toEqual(perBucket(day, [logs[0]?.time ?? 0n]));
  });

  test("reads without FINAL: a retried record counts twice until its day is merged", async () => {
    const retried = await newProject("Retried logs");
    const logs = [{ time: minutesAgo(5), severityNumber: 9, body: "sent twice" }];
    // Merges stopped, so the copies stay as they would in a busy day before
    // ClickHouse merges it (forced within about an hour, migration 0002).
    const { client } = dashboard.reader;
    await client.command({ query: "SYSTEM STOP MERGES logs" });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await sendLogs(retried.secretKey, [{ service: "worker", logs }]);
      }
      expect((await getJson(retried.id, "/logs/volume?period=7d")).total).toBe(2);
      // The list drops the copy.
      expect((await getJson(retried.id, "/logs?period=7d")).logs).toHaveLength(1);
    } finally {
      await client.command({ query: "SYSTEM START MERGES logs" });
    }
  });

  test("refuses bad parameters", async () => {
    const bad = [
      "period=7d&severity=loud",
      "period=7d&traceId=abc",
      "period=7d&search=a%20b%20c%20d%20e%20f%20g%20h%20i",
      "period=forever",
      "from=2026-11-10",
    ].map((query) => `/logs/volume?${query}`);
    expect(await statuses(shop.id, bad)).toEqual(all(bad, 400));
  });
});

/** The exact inclusive percentile ClickHouse gives: a straight line between the two nearest values. */
function percentile(values: number[], q: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  const at = q * (sorted.length - 1);
  const low = sorted[Math.floor(at)] ?? 0;
  const high = sorted[Math.ceil(at)] ?? low;
  return low + (high - low) * (at - Math.floor(at));
}

describe("GET /api/projects/:id/traces/chart", () => {
  test("counts root spans per bucket, those with a failed span, and their 95th percentile", async () => {
    const chart = await getJson(shop.id, "/traces/chart?period=7d");
    expect(chart).toMatchObject({
      timeZone: "UTC",
      environment: "production",
      stepSeconds: 7200,
      total: { traces: 2, failed: 1 },
    });
    // Each root in the bucket of its start, as the list gives it.
    const listed: { start: string; durationUs: number; error: boolean }[] = (
      await getJson(shop.id, "/traces?period=7d")
    ).traces;
    const roots = listed.map((trace) => ({
      start: BigInt(Date.parse(trace.start)) * MS,
      us: trace.durationUs,
      failed: trace.error,
    }));
    expect(roots.filter((root) => root.failed)).toHaveLength(1);
    expect(chart.traces).toEqual(
      perBucket(
        chart,
        roots.map((root) => root.start),
      ),
    );
    // The order's charge failed, a child span: the trace counts as one with errors.
    expect(chart.failed).toEqual(
      perBucket(
        chart,
        roots.filter((root) => root.failed).map((root) => root.start),
      ),
    );
    const expected = Array.from({ length: chart.buckets }, (_, index) => {
      const here = roots.filter((root) => bucketOf(chart, root.start) === index);
      return here.length === 0
        ? null
        : percentile(
            here.map((root) => root.us),
            0.95,
          );
    });
    expect(
      chart.p95Us.map((value: number | null) => (value === null ? null : Math.round(value))),
    ).toEqual(expected.map((value) => (value === null ? null : Math.round(value))));
  });

  test('counts errors as "With errors only" finds them, and says when the failed spans\' cap was reached', async () => {
    expect((await getJson(shop.id, "/traces/chart?period=7d")).failedCapped).toBe(false);
    const failing = await newProject("Failing traces");
    // Two traces whose roots failed, a minute apart.
    const roots = [minutesAgo(3), minutesAgo(2)].map((start) => ({
      traceId: hex(16),
      spanId: hex(8),
      name: "GET /broken",
      start,
      durationMs: 5,
      status: { code: 2, message: "boom" },
    }));
    await sendSpans(failing.secretKey, [{ service: "web", spans: roots }]);
    const asked = await telemetryRange(
      dashboard.db,
      { period: "7d" },
      { projectId: failing.id, timeZone: "UTC" },
      new Date(),
      30,
    );
    if ("problem" in asked) throw new Error("no range");
    const wide = await traceChart(dashboard.reader, asked.range, { errors: false }, new Date());
    expect({ total: wide.total, capped: wide.failedCapped }).toEqual({
      total: { traces: 2, failed: 2 },
      capped: false,
    });
    // A cap of one failed span: only the latest trace counts with errors, as the filter keeps it.
    const capped = await traceChart(dashboard.reader, asked.range, { errors: false }, new Date(), {
      maxFailedSpans: 1,
    });
    expect({ total: capped.total, capped: capped.failedCapped }).toEqual({
      total: { traces: 2, failed: 1 },
      capped: true,
    });
    const filtered = await traceChart(dashboard.reader, asked.range, { errors: true }, new Date(), {
      maxFailedSpans: 1,
    });
    expect(filtered.total).toEqual({ traces: 1, failed: 1 });
  });

  test("applies the list's filters: environment, service, name, errors, and duration", async () => {
    expect(await traceTotals("environment=staging")).toEqual({ traces: 1, failed: 0 });
    expect(await traceTotals("service=payments")).toEqual({ traces: 0, failed: 0 });
    expect(await traceTotals("service=web")).toEqual({ traces: 2, failed: 1 });
    expect(await traceTotals("name=HEALTH")).toEqual({ traces: 1, failed: 0 });
    expect(await traceTotals("errors=true")).toEqual({ traces: 1, failed: 1 });
    expect(await traceTotals("minDuration=100")).toEqual({ traces: 1, failed: 1 });
  });

  test("counts only the period", async () => {
    const old = await newProject("Old traces");
    await sendSpans(old.secretKey, [
      {
        service: "web",
        spans: [
          {
            traceId: hex(16),
            spanId: hex(8),
            name: "old",
            start: minutesAgo(48 * 60),
            durationMs: 5,
          },
          {
            traceId: hex(16),
            spanId: hex(8),
            name: "new",
            // Today, also from 00:00 to 00:05, when 5 minutes ago is yesterday.
            start: minutesAgoToday(5),
            durationMs: 5,
          },
        ],
      },
    ]);
    const total = async (query: string) =>
      (await getJson(old.id, `/traces/chart?${query}`)).total.traces;
    expect(await total("period=7d")).toBe(2);
    expect(await total(`from=${dayAgo(2)}&to=${dayAgo(2)}`)).toBe(1);
    expect(await total(`from=${dayAgo(1)}&to=${dayAgo(1)}`)).toBe(0);
  });

  test("refuses bad parameters", async () => {
    const bad = [
      "period=7d&minDuration=-1",
      "period=7d&errors=maybe",
      "period=7d&name=",
      "from=2026-11-10",
    ].map((query) => `/traces/chart?${query}`);
    expect(await statuses(shop.id, bad)).toEqual(all(bad, 400));
  });
});

/** A moment's wall clock in `timeZone`, "2026-10-25 06:00". */
const wallClock = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(ms);

/**
 * The buckets of chosen days in a timezone, as the charts make them, at
 * `now` (by default two days after the last), with where the range starts and ends.
 */
async function rangeBuckets(timeZone: string, from: string, to: string, now?: string) {
  const at = new Date(now ?? Date.parse(`${to}T00:00:00Z`) + 2 * 86_400_000);
  const asked = await telemetryRange(
    dashboard.db,
    { from, to },
    { projectId: shop.id, timeZone },
    at,
    400,
  );
  if ("problem" in asked) throw new Error("no range");
  const { range } = asked;
  return {
    buckets: listChartBuckets(range, at),
    fromMs: range.from.getTime(),
    endMs: Math.min(range.to.getTime(), at.getTime()),
  };
}

async function bucketsOf(timeZone: string, from: string, to: string) {
  return (await rangeBuckets(timeZone, from, to)).buckets;
}

/** The bucket ClickHouse puts a row at `iso` in, by its SQL. */
async function bucketInClickHouse(buckets: Awaited<ReturnType<typeof bucketsOf>>, iso: string) {
  const params = new QueryParams();
  const [row] = await queryRows<{ bucket: string | number }>(
    dashboard.reader,
    `SELECT ${buckets.bucketSql(params)} AS bucket
     FROM (SELECT toDateTime64(${params.add(iso.replace("T", " ").replace("Z", ""), "String")}, 9, 'UTC') AS timestamp)`,
    params,
  );
  return Number(row?.bucket);
}

/**
 * Every minute of a range placed by ClickHouse, as the charts' queries
 * place rows: the minutes each bucket got, beside the minutes its span
 * holds (to the next bucket's start, or the range's end). Equal, with the
 * total every minute of the range, when no row falls outside a bucket and
 * none counts twice.
 */
async function everyMinute(timeZone: string, from: string, to: string, now?: string) {
  const { buckets, fromMs, endMs } = await rangeBuckets(timeZone, from, to, now);
  const minutes = (endMs - fromMs) / 60_000;
  const params = new QueryParams();
  const rows = await queryRows<{ bucket: string | number; minutes: string }>(
    dashboard.reader,
    `SELECT ${buckets.bucketSql(params)} AS bucket, count() AS minutes
     FROM (SELECT fromUnixTimestamp64Milli(${params.add(fromMs, "Int64")} + toInt64(number) * 60000, 'UTC') AS timestamp
           FROM numbers(${params.add(minutes, "UInt64")}))
     GROUP BY bucket ORDER BY bucket`,
    params,
  );
  const placed = Array.from({ length: buckets.starts.length }, () => 0);
  for (const row of rows) placed[Number(row.bucket)] = Number(row.minutes);
  const spans = buckets.starts.map(
    (start, at) =>
      (Math.min(buckets.starts[at + 1] ?? endMs, endMs) - Math.max(start, fromMs)) / 60_000,
  );
  return {
    buckets,
    placed,
    spans,
    minutes,
    total: placed.reduce((sum, count) => sum + count, 0),
    walls: buckets.starts.map((start) => wallClock(start, timeZone)),
  };
}

describe("the lists' charts at every time of day", () => {
  test("a range of days keeps its step from just after midnight to just before the next", async () => {
    const times = ["00:05", "00:15:30", "06:00:30", "12:00", "13:00:30", "23:55"];
    for (const [from, step] of [
      // 3 days: 72 hours in 120 buckets is an hour each; 30 minutes only fit before 12:00.
      ["2026-11-18", 3600],
      // 2 days: 30 minutes; 15 minutes only fit before 06:00.
      ["2026-11-19", 1800],
      ["2026-11-14", 7200],
    ] as const) {
      for (const time of times) {
        const { buckets } = await rangeBuckets("UTC", from, "2026-11-20", `2026-11-20T${time}Z`);
        expect({ from, time, step: buckets.stepSeconds }).toEqual({ from, time, step });
      }
    }
  });
});

describe("the lists' charts across a daylight saving change", () => {
  test("Europe/Berlin, 25 October 2026: 6-hour buckets on the clock's marks, one 7 hours long", async () => {
    const buckets = await bucketsOf("Europe/Berlin", "2026-10-11", "2026-11-09");
    expect(buckets.stepSeconds).toBe(21_600);
    const walls = buckets.starts.map((start) => wallClock(start, "Europe/Berlin"));
    expect(walls.every((wall) => /(00|06|12|18):00$/.test(wall))).toBe(true);
    expect(walls).toHaveLength(30 * 4);
    const change = walls.indexOf("2026-10-25 00:00");
    expect(walls.slice(change, change + 3)).toEqual([
      "2026-10-25 00:00",
      "2026-10-25 06:00",
      "2026-10-25 12:00",
    ]);
    // The clock goes back an hour at 03:00: that bucket is 7 hours long, the others 6.
    const lengths = buckets.starts.slice(1).map((start, at) => start - (buckets.starts[at] ?? 0));
    expect(lengths[change]).toBe(7 * 3_600_000);
    expect(lengths.filter((length) => length !== 6 * 3_600_000)).toEqual([7 * 3_600_000]);
    // ClickHouse puts a row in the bucket of its local time: 06:30 local is 05:30 UTC.
    expect(await bucketInClickHouse(buckets, "2026-10-25T05:30:00Z")).toBe(change + 1);
    expect(await bucketInClickHouse(buckets, "2026-10-25T04:30:00Z")).toBe(change);
  });

  test("Europe/Berlin over 90 days: each day's bucket starts at its midnight", async () => {
    const buckets = await bucketsOf("Europe/Berlin", "2026-09-01", "2026-11-29");
    expect(buckets.stepSeconds).toBe(86_400);
    const walls = buckets.starts.map((start) => wallClock(start, "Europe/Berlin"));
    expect(walls).toHaveLength(90);
    expect(walls.every((wall) => wall.endsWith(" 00:00"))).toBe(true);
    expect(new Set(walls.map((wall) => wall.slice(0, 10))).size).toBe(90);
    const after = walls.indexOf("2026-10-26 00:00");
    // 00:30 on 26 October in Berlin is 23:30 UTC on the 25th.
    expect(await bucketInClickHouse(buckets, "2026-10-25T23:30:00Z")).toBe(after);
    expect(await bucketInClickHouse(buckets, "2026-10-25T22:30:00Z")).toBe(after - 1);
  });

  test("America/New_York, 1 November 2026: midnights and 6-hour marks", async () => {
    const days = await bucketsOf("America/New_York", "2026-09-01", "2026-11-29");
    const midnights = days.starts.map((start) => wallClock(start, "America/New_York"));
    expect(midnights.every((wall) => wall.endsWith(" 00:00"))).toBe(true);
    expect(midnights).toContain("2026-11-01 00:00");
    expect(midnights).toContain("2026-11-02 00:00");
    const marks = await bucketsOf("America/New_York", "2026-10-18", "2026-11-16");
    const walls = marks.starts.map((start) => wallClock(start, "America/New_York"));
    expect(walls.every((wall) => /(00|06|12|18):00$/.test(wall))).toBe(true);
    expect(walls).toContain("2026-11-01 06:00");
    // 06:30 local on 1 November, after the change to UTC-5, is 11:30 UTC.
    expect(await bucketInClickHouse(marks, "2026-11-01T11:30:00Z")).toBe(
      walls.indexOf("2026-11-01 06:00"),
    );
  });
});

describe("the lists' charts when the clock skips or repeats a time", () => {
  test("America/New_York, 8 March 2026, 2-hour steps: the 02:00 bucket starts at 03:00, and every minute is in a bar", async () => {
    const result = await everyMinute("America/New_York", "2026-03-05", "2026-03-11");
    expect(result.buckets.stepSeconds).toBe(7200);
    expect(result.placed).toEqual(result.spans);
    expect(result.total).toBe(result.minutes);
    const at = result.walls.indexOf("2026-03-08 03:00");
    expect(result.walls.slice(at - 1, at + 2)).toEqual([
      "2026-03-08 00:00",
      "2026-03-08 03:00",
      "2026-03-08 04:00",
    ]);
    // 03:00 to 04:00 local: one hour, the clock having skipped 02:00 to 03:00.
    expect(result.spans[at]).toBe(60);
    expect(result.spans.filter((span) => span !== 120)).toEqual([60]);
  });

  test("America/New_York, 8 March 2026, 1-hour and 15-minute steps: no bucket for the skipped hour, none lost", async () => {
    const hours = await everyMinute("America/New_York", "2026-03-07", "2026-03-09");
    expect(hours.buckets.stepSeconds).toBe(3600);
    expect(hours.placed).toEqual(hours.spans);
    expect(hours.total).toBe(hours.minutes);
    expect(hours.walls).not.toContain("2026-03-08 02:00");
    expect(hours.walls).toContain("2026-03-08 03:00");
    expect(hours.walls).toHaveLength(3 * 24 - 1);
    expect(new Set(hours.spans)).toEqual(new Set([60]));

    const quarters = await everyMinute("America/New_York", "2026-03-08", "2026-03-08");
    expect(quarters.buckets.stepSeconds).toBe(900);
    expect(quarters.placed).toEqual(quarters.spans);
    expect(quarters.total).toBe(quarters.minutes);
    expect(quarters.walls).toHaveLength(96 - 4);
    expect(new Set(quarters.spans)).toEqual(new Set([15]));
  });

  test("America/Santiago, 6 September 2026, 6-hour steps: the skipped midnight's bucket starts at 01:00", async () => {
    const result = await everyMinute("America/Santiago", "2026-08-24", "2026-09-22");
    expect(result.buckets.stepSeconds).toBe(21_600);
    expect(result.placed).toEqual(result.spans);
    expect(result.total).toBe(result.minutes);
    const at = result.walls.indexOf("2026-09-06 01:00");
    expect(at).toBeGreaterThan(0);
    expect(result.walls).not.toContain("2026-09-06 00:00");
    // 01:00 to 06:00: five hours.
    expect(result.spans[at]).toBe(300);
  });

  test("Australia/Lord_Howe, 4 October 2026, hourly: the half hour after the jump is in the 02:00 bar", async () => {
    const result = await everyMinute("Australia/Lord_Howe", "2026-10-03", "2026-10-05");
    expect(result.buckets.stepSeconds).toBe(3600);
    expect(result.placed).toEqual(result.spans);
    expect(result.total).toBe(result.minutes);
    const at = result.walls.indexOf("2026-10-04 02:30");
    expect(at).toBeGreaterThan(0);
    expect(result.spans[at]).toBe(30);
  });

  test("Europe/Berlin, 25 October 2026, 5, 10, and 15 minutes: the repeated hour in one bar, every minute once", async () => {
    for (const [now, step, long] of [
      ["2026-10-25T07:00:00Z", 300, 65],
      ["2026-10-25T15:00:00Z", 600, 70],
      [undefined, 900, 75],
    ] as const) {
      const result = await everyMinute("Europe/Berlin", "2026-10-25", "2026-10-25", now);
      expect(result.buckets.stepSeconds).toBe(step);
      expect(result.placed).toEqual(result.spans);
      expect(result.total).toBe(result.minutes);
      // One bar for each wall-clock slot: none twice.
      expect(new Set(result.walls).size).toBe(result.walls.length);
      // The last slot before 03:00 holds the hour the clock repeats.
      const last = result.walls.indexOf(`2026-10-25 02:${String(60 - step / 60).padStart(2, "0")}`);
      expect(result.spans[last]).toBe(long);
      expect(result.spans.filter((span) => span !== step / 60)).toEqual([long]);
    }
    // 02:30 the second time (01:30 UTC) is in the bar of 02:45 the first time (00:45 UTC),
    // and 03:00 (02:00 UTC) starts the next.
    const { buckets } = await rangeBuckets("Europe/Berlin", "2026-10-25", "2026-10-25");
    expect(await bucketInClickHouse(buckets, "2026-10-25T01:30:00Z")).toBe(
      await bucketInClickHouse(buckets, "2026-10-25T00:59:00Z"),
    );
    expect(await bucketInClickHouse(buckets, "2026-10-25T02:00:00Z")).toBe(
      (await bucketInClickHouse(buckets, "2026-10-25T01:30:00Z")) + 1,
    );
  });
});

describe("GET /api/projects/:id/logs/live", () => {
  test("sends what arrived after the cursor, newest first, and reads 10 seconds before it again", async () => {
    const live = await newProject("Live");
    const start = await poll(live.id);
    expect(start).toMatchObject({ bodies: [], skipped: 0, gap: null });
    const cursor = BigInt(start.cursor);
    // Rows made visible after the poll that should have read them: one arrived
    // 5 seconds before the cursor (a late part), one 15 seconds before (past
    // the re-read), and one not settled yet (it arrived a second after the
    // cursor, less than LIVE_SETTLE_MS before the next poll's now).
    await insertLogs(live.id, [
      { body: "visible late, 5 s before the cursor", receivedNs: cursor - 5000n * MS },
      { body: "visible late, 15 s before the cursor", receivedNs: cursor - 15_000n * MS },
      { body: "not settled", receivedNs: cursor + 1000n * MS },
    ]);
    const next = await poll(live.id, `after=${start.cursor}`);
    expect(next.bodies).toEqual(["visible late, 5 s before the cursor"]);
    expect(BigInt(next.cursor)).toBeGreaterThan(cursor);
    expect(BigInt(next.cursor)).toBeLessThan(cursor + 1000n * MS);

    // A record sent now, with a time two days old: it shows by its arrival.
    await sendLogs(live.secretKey, [
      { service: "web", logs: [{ time: minutesAgo(48 * 60), severityNumber: 13, body: "late" }] },
    ]);
    await sleep(LIVE_SETTLE_MS + 300);
    const third = await poll(live.id, `after=${next.cursor}`);
    expect(third.bodies[0]).toBe("late");
    expect(third.skipped).toBe(0);
  });

  test("past a page, skips ahead to the newest and counts what it skipped", async () => {
    const live = await newProject("Live backlog");
    const start = await poll(live.id);
    const batch = Array.from({ length: LIVE_PAGE_SIZE + 50 }, (_, i) => ({
      time: minutesAgo(1) + BigInt(i) * MS,
      severityNumber: 9,
      body: `line ${i}`,
    }));
    await sendLogs(live.secretKey, [{ service: "web", logs: batch }]);
    await sleep(LIVE_SETTLE_MS + 300);
    const next = await poll(live.id, `after=${start.cursor}`);
    expect(next.bodies).toHaveLength(LIVE_PAGE_SIZE);
    expect(new Set(next.bodies).size).toBe(LIVE_PAGE_SIZE);
    expect(next.skipped).toBe(50);
    expect(next.gap).toBeNull();
    // From there, nothing new: nothing skipped.
    expect(await poll(live.id, `after=${next.cursor}`)).toMatchObject({ skipped: 0, gap: null });
  });

  test("counts what it skipped in records, not rows: a burst sent twice skips each record once", async () => {
    const live = await newProject("Live burst retried");
    const start = await poll(live.id);
    const batch = Array.from({ length: LIVE_PAGE_SIZE + 50 }, (_, i) => ({
      time: minutesAgo(1) + BigInt(i) * MS,
      severityNumber: 9,
      body: `line ${i}`,
    }));
    const { client } = dashboard.reader;
    await client.command({ query: "SYSTEM STOP MERGES logs" });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await sendLogs(live.secretKey, [{ service: "web", logs: batch }]);
      }
      await sleep(LIVE_SETTLE_MS + 300);
      const next = await poll(live.id, `after=${start.cursor}`);
      expect(new Set(next.ids).size).toBe(next.ids.length);
      expect(next.skipped).toBe(LIVE_PAGE_SIZE + 50 - next.ids.length);
      expect(next.skipped).toBe(50);
    } finally {
      await client.command({ query: "SYSTEM START MERGES logs" });
    }
  });

  test("a cursor just inside the window still reads again before it, from the window's start", async () => {
    const live = await newProject("Live edge of the window");
    const settled = BigInt((await poll(live.id)).cursor);
    // About 5 seconds inside the window: the 10 seconds before it reach past its start.
    const after = settled + BigInt(LIVE_SETTLE_MS) * MS - BigInt(LIVE_WINDOW_MS) * MS + 5000n * MS;
    await insertLogs(live.id, [
      { body: "arrived 3 s before the cursor", receivedNs: after - 3000n * MS },
    ]);
    const next = await poll(live.id, `after=${after}`);
    expect(next.gap).toBeNull();
    expect(next.bodies).toEqual(["arrived 3 s before the cursor"]);
  });

  test("a cursor older than the window is a gap: it says what it left out and starts again", async () => {
    const live = await newProject("Live gap");
    await sendLogs(live.secretKey, [
      { service: "web", logs: [{ time: minutesAgo(1), severityNumber: 9, body: "after the gap" }] },
    ]);
    await sleep(LIVE_SETTLE_MS + 300);
    const now = BigInt(Date.now()) * MS;
    const old = now - 20n * 60_000n * MS;
    const answer = await getJson(live.id, `/logs/live?after=${old}`);
    expect(answer.logs.map((log: { body: string }) => log.body)).toEqual(["after the gap"]);
    expect(answer.skipped).toBe(0);
    expect(answer.gap.from).toBe(new Date(Number(old / MS)).toISOString());
    // The window's start: about 5 minutes before now.
    const to = Date.parse(answer.gap.to);
    expect(Math.abs(to - (Date.now() - LIVE_WINDOW_MS))).toBeLessThan(30_000);
    // Without a cursor, a fresh start is no gap.
    expect((await poll(live.id)).gap).toBeNull();
  });

  test("applies the filters and the environment, and sends one copy of a retried record", async () => {
    const live = await newProject("Live filters");
    const logs = [
      { time: minutesAgo(1), severityNumber: 9, body: "web info" },
      { time: minutesAgo(1) + MS, severityNumber: 17, body: "web error with card declined" },
    ];
    const groups = [
      { service: "web", logs },
      {
        service: "worker",
        logs: [{ time: minutesAgo(1), severityNumber: 17, body: "worker error" }],
      },
      {
        service: "web",
        environment: "staging",
        logs: [{ time: minutesAgo(1), severityNumber: 17, body: "staging error" }],
      },
    ];
    // Sent twice, as an exporter retries after a lost answer; merges stopped,
    // so both copies stay as they would before ClickHouse merges the day.
    const { client } = dashboard.reader;
    await client.command({ query: "SYSTEM STOP MERGES logs" });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) await sendLogs(live.secretKey, groups);
      await sleep(LIVE_SETTLE_MS + 300);
      const every = await poll(live.id);
      expect(every.bodies.toSorted(byText)).toEqual(
        ["web info", "web error with card declined", "worker error"].toSorted(byText),
      );
      expect(new Set(every.ids).size).toBe(3);
      expect((await poll(live.id, "service=web")).bodies.toSorted(byText)).toEqual([
        "web error with card declined",
        "web info",
      ]);
      expect((await poll(live.id, "severity=error")).bodies.toSorted(byText)).toEqual([
        "web error with card declined",
        "worker error",
      ]);
      expect((await poll(live.id, "search=declined")).bodies).toEqual([
        "web error with card declined",
      ]);
      expect((await poll(live.id, "environment=staging")).bodies).toEqual(["staging error"]);
    } finally {
      await client.command({ query: "SYSTEM START MERGES logs" });
    }
  });

  test("looks only a few minutes back", async () => {
    const live = await newProject("Live window");
    const tenMinutesAgo = BigInt(Date.now() - 10 * 60_000) * MS;
    await insertLogs(live.id, [{ body: "arrived ten minutes ago", receivedNs: tenMinutesAgo }]);
    await sendLogs(live.secretKey, [
      { service: "web", logs: [{ time: minutesAgo(1), severityNumber: 9, body: "arrived now" }] },
    ]);
    await sleep(LIVE_SETTLE_MS + 300);
    expect((await poll(live.id)).bodies).toEqual(["arrived now"]);
    expect((await poll(live.id, "after=0")).bodies).toEqual(["arrived now"]);
  });

  test("refuses bad parameters", async () => {
    const bad = [
      "after=1-xyz",
      `after=${"9".repeat(19)}`,
      `after=${"1".repeat(20)}`,
      "severity=loud",
      "traceId=abc",
      "search=a%20b%20c%20d%20e%20f%20g%20h%20i",
    ].map((query) => `/logs/live?${query}`);
    expect(await statuses(shop.id, bad)).toEqual(all(bad, 400));
  });
});

describe("the charts' and live view's access", () => {
  const paths = ["/logs/volume?period=7d", "/logs/live", "/traces/chart?period=7d"];

  test("a member without monitoring gets 403; one without the project, as if it did not exist", async () => {
    const without = await signedInUser(dashboard, {
      name: "No monitoring",
      email: "no-monitoring@example.com",
      grants: { projects: [shop.id], areas: { errors: "view" } },
    });
    expect(await statuses(shop.id, paths, without.cookie)).toEqual(all(paths, 403));
    const elsewhere = await signedInUser(dashboard, {
      name: "Another project",
      email: "another-project@example.com",
      grants: { projects: [], areas: { monitoring: "view" } },
    });
    const answers = await Promise.all(
      paths.map(async (path) => (await get(shop.id, path, elsewhere.cookie)).json()),
    );
    expect(answers).toEqual(
      paths.map(() => ({ error: "not_found", message: "No project has this ID." })),
    );
    const viewer = await signedInUser(dashboard, {
      name: "Monitoring viewer",
      email: "monitoring-viewer@example.com",
      grants: { projects: [shop.id], areas: { monitoring: "view" } },
    });
    expect(await statuses(shop.id, paths, viewer.cookie)).toEqual(all(paths, 200));
  });

  test("another project reads nothing of this one's", async () => {
    const other = await insertProject(dashboard.db, { name: "Another shop" });
    expect((await getJson(other.id, "/logs/volume?period=7d")).total).toBe(0);
    expect((await getJson(other.id, "/traces/chart?period=7d")).total).toEqual({
      traces: 0,
      failed: 0,
    });
    expect((await getJson(other.id, "/logs/live")).logs).toEqual([]);
  });
});

describe("access", () => {
  test("a project that does not exist gets 404; another project reads nothing of this one's", async () => {
    const missing = randomUUID();
    const [log] = (await getJson(shop.id, "/logs?period=7d")).logs;
    const logPath = `/logs/${log.id}?time=${log.timeNs}`;
    expect((await get(shop.id, logPath)).statusCode).toBe(200);
    const paths = [
      "/traces?period=7d",
      `/traces/${ORDER.trace}`,
      `/traces/${ORDER.trace}/spans/${ORDER.root}?start=${ORDER_START}`,
      "/logs?period=7d",
      `/logs?period=7d&traceId=${ORDER.trace}`,
      logPath,
    ];
    const answers = await Promise.all(paths.map(async (path) => (await get(missing, path)).json()));
    expect(await statuses(missing, paths)).toEqual(all(paths, 404));
    expect(answers).toEqual(
      paths.map(() => ({ error: "not_found", message: "No project has this ID." })),
    );
    // Another project is empty: the IDs in a path reach only the project named.
    const other = await insertProject(dashboard.db, { name: "Another site" });
    const own = await get(other.id, `/traces/${ORDER.trace}`);
    expect(own.json()).toMatchObject({ spans: [], logs: [], totalSpans: 0 });
    const ownSpan = await get(
      other.id,
      `/traces/${ORDER.trace}/spans/${ORDER.root}?start=${ORDER_START}`,
    );
    expect(ownSpan.statusCode).toBe(404);
    expect((await get(other.id, logPath)).statusCode).toBe(404);
    const ownLogs = await get(other.id, `/logs?period=7d&traceId=${ORDER.trace}`);
    expect(ownLogs.json()).toMatchObject({ logs: [], received: false });
  });

  test("needs a session", async () => {
    const response = await dashboard.app.inject({ url: `/api/projects/${shop.id}/logs` });
    expect(response.statusCode).toBe(401);
  });
});

describe("search words", () => {
  test("are cut as the text index cuts a body", () => {
    expect(searchWords("card_declined (order 5120) über-cool")).toEqual([
      "card",
      "declined",
      "order",
      "5120",
      "über",
      "cool",
    ]);
    expect(searchWords("  ::  ")).toEqual([]);
  });
});
