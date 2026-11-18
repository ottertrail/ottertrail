import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { searchWords } from "../src/telemetry/logs.ts";
import { MAX_TRACE_SPANS } from "../src/telemetry/traces.ts";
import { signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";
import { keyValues, secretKeyOf } from "./helpers/telemetry.ts";

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;

const MS = 1_000_000n;
/** Now, less some minutes, in nanoseconds since 1970: every record is recent. */
const minutesAgo = (minutes: number) => BigInt(Date.now() - minutes * 60_000) * MS;

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

async function newProject(name: string, organizationId = dashboard.organizationId) {
  const project = await insertProject(dashboard.db, { organization_id: organizationId, name });
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

describe("access", () => {
  test("a member of another organization gets nothing, as for a project that does not exist", async () => {
    const bob = await signedInUser(
      dashboard,
      { name: "Bob", email: "bob@example.com" },
      { newOrganization: "Bob's shop" },
    );
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
    const answers = await Promise.all(
      paths.map(async (path) => (await get(shop.id, path, bob.cookie)).json()),
    );
    expect(await statuses(shop.id, paths, bob.cookie)).toEqual(all(paths, 404));
    expect(answers).toEqual(
      paths.map(() => ({ error: "not_found", message: "No project has this ID." })),
    );
    // Bob's own project is empty: an ID from the browser reaches only its own project.
    const bobs = await insertProject(dashboard.db, {
      organization_id: bob.organizationId ?? "",
      name: "Bob's site",
    });
    const own = await get(bobs.id, `/traces/${ORDER.trace}`, bob.cookie);
    expect(own.json()).toMatchObject({ spans: [], logs: [], totalSpans: 0 });
    const ownSpan = await get(
      bobs.id,
      `/traces/${ORDER.trace}/spans/${ORDER.root}?start=${ORDER_START}`,
      bob.cookie,
    );
    expect(ownSpan.statusCode).toBe(404);
    expect((await get(bobs.id, logPath, bob.cookie)).statusCode).toBe(404);
    const ownLogs = await get(bobs.id, `/logs?period=7d&traceId=${ORDER.trace}`, bob.cookie);
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
