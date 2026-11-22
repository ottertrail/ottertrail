import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { buildApp } from "../src/app.ts";
import { type ClickHouseClient, createClickHouse } from "../src/clickhouse/clickhouse.ts";
import { loadConfig } from "../src/config.ts";
import { fingerprint } from "../src/errors/fingerprint.ts";
import {
  LOGS_MESSAGES,
  METRICS_MESSAGES,
  STATUS_MESSAGE,
  TRACE_MESSAGES,
} from "../src/telemetry/proto/definitions.ts";
import { MAX_MESSAGES } from "../src/telemetry/wire.ts";
import { signedInDashboard } from "./helpers/dashboard.ts";
import { countEvents, storedEvents } from "./helpers/events.ts";
import { hangingUpClient } from "./helpers/hang-up.ts";
import { insertProject } from "./helpers/projects.ts";
import {
  decodeResponse,
  encodeProtobuf,
  keyValues,
  nowNs,
  secretKeyOf,
  storedRows,
} from "./helpers/telemetry.ts";

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;

beforeAll(async () => {
  dashboard = await signedInDashboard();
});

afterAll(async () => {
  await dashboard?.close();
});

/** A project of its own for each test, so counts never mix. */
async function newProject(name: string) {
  const project = await insertProject(dashboard.db, { name });
  return {
    id: project.id,
    publicKey: project.public_key,
    secretKey: await secretKeyOf(dashboard.db, project.id),
  };
}

const PROTOBUF = "application/x-protobuf";
const JSON_TYPE = "application/json";

function post(
  path: string,
  payload: Buffer | string,
  {
    key,
    type = PROTOBUF,
    headers = {},
    app = dashboard.app,
  }: {
    key: string | undefined;
    type?: string;
    headers?: Record<string, string>;
    app?: typeof dashboard.app;
  },
) {
  return app.inject({
    method: "POST",
    url: path,
    headers: {
      "content-type": type,
      ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
      ...headers,
    },
    payload,
  });
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

const RESOURCE = {
  attributes: keyValues({
    "service.name": "checkout",
    "service.version": "2.3.1",
    "deployment.environment.name": "Staging",
  }),
};

/** A trace request in protobuf's shape: bytes for IDs. */
function protobufTraces(spans: object[]) {
  return encodeProtobuf(TRACE_MESSAGES, {
    resourceSpans: [{ resource: RESOURCE, scopeSpans: [{ scope: { name: "http" }, spans }] }],
  });
}

function protobufSpan(traceId: string, spanId: string, overrides: object = {}) {
  const start = nowNs(-5000);
  return {
    traceId: Buffer.from(traceId, "hex"),
    spanId: Buffer.from(spanId, "hex"),
    name: "POST /pay",
    kind: 2,
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(start + 250_000_000n),
    attributes: [
      ...keyValues({ "http.route": "/pay", "http.status_code": 500, retry: false, ratio: 0.5 }),
      { key: "tags", value: { arrayValue: { values: [{ stringValue: "a" }, { intValue: 1 }] } } },
    ],
    status: { code: 2, message: "card declined" },
    ...overrides,
  };
}

function statusOf(body: Buffer) {
  return STATUS_MESSAGE.toObject(STATUS_MESSAGE.decode(body));
}

describe("authentication", () => {
  test("refuses no key, a public key, and an unknown key, with a Status in the request's encoding", async () => {
    const project = await newProject("Auth");
    const body = protobufTraces([protobufSpan(randomHex(16), randomHex(8))]);

    const none = await post("/v1/traces", body, { key: undefined });
    expect(none.statusCode).toBe(401);
    expect(none.headers["content-type"]).toBe(PROTOBUF);
    expect(statusOf(none.rawPayload)).toEqual({
      code: 16,
      message: "Send the project's secret key: Authorization: Bearer sk_…",
    });

    const publicKey = await post("/v1/traces", body, { key: project.publicKey });
    expect(publicKey.statusCode).toBe(401);

    const unknown = await post("/v1/logs", "{}", { key: `sk_${"0".repeat(32)}`, type: JSON_TYPE });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.headers["content-type"]).toMatch(/^application\/json/);
    expect(unknown.json()).toEqual({ code: 16, message: "No project has this secret key." });

    const valid = await post("/v1/traces", body, { key: project.secretKey });
    expect(valid.statusCode).toBe(200);
    expect(await storedRows(dashboard.reader.client, "spans", project.id)).toHaveLength(1);
  });

  test("a key stores only into its own project", async () => {
    const mine = await newProject("Mine");
    const other = await insertProject(dashboard.db, { name: "Another project" });
    const response = await post(
      "/v1/traces",
      protobufTraces([protobufSpan(randomHex(16), randomHex(8))]),
      { key: mine.secretKey },
    );
    expect(response.statusCode).toBe(200);
    const rows = await storedRows<{ project_id: string }>(
      dashboard.reader.client,
      "spans",
      mine.id,
    );
    expect(rows.map((row) => row.project_id)).toEqual([mine.id]);
    expect(await storedRows(dashboard.reader.client, "spans", other.id)).toEqual([]);
  });
});

describe("POST /v1/traces", () => {
  test("stores protobuf spans with their service, release, environment, and attributes", async () => {
    const project = await newProject("Traces protobuf");
    const traceId = randomHex(16);
    const spanId = randomHex(8);
    const parentId = randomHex(8);
    const response = await post(
      "/v1/traces",
      protobufTraces([
        protobufSpan(traceId, spanId, { parentSpanId: Buffer.from(parentId, "hex") }),
      ]),
      { key: project.secretKey },
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe(PROTOBUF);
    // An empty ExportTraceServiceResponse.
    expect(response.rawPayload.byteLength).toBe(0);

    const [row] = await storedRows(dashboard.reader.client, "spans", project.id);
    expect(row).toMatchObject({
      project_id: project.id,
      id: traceId + spanId,
      trace_id: traceId,
      span_id: spanId,
      parent_span_id: parentId,
      name: "POST /pay",
      kind: "server",
      duration_ns: "250000000",
      status_code: "error",
      status_message: "card declined",
      service: "checkout",
      release: "2.3.1",
      environment: "staging",
      scope_name: "http",
      attributes: {
        "http.route": "/pay",
        "http.status_code": "500",
        retry: "false",
        ratio: "0.5",
        tags: '["a",1]',
      },
      resource_attributes: {
        "service.name": "checkout",
        "service.version": "2.3.1",
        "deployment.environment.name": "Staging",
      },
    });
  });

  test("stores JSON spans: IDs in hex, 64-bit numbers as strings or numbers, enums as numbers", async () => {
    const project = await newProject("Traces JSON");
    const traceId = randomHex(16);
    const spanId = randomHex(8);
    const start = nowNs(-1000);
    const request = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "api" } }] },
          scopeSpans: [
            {
              scope: { name: "manual", version: "1.0.0" },
              spans: [
                {
                  traceId: traceId.toUpperCase(),
                  spanId,
                  name: "SELECT orders",
                  kind: 3,
                  startTimeUnixNano: start.toString(),
                  endTimeUnixNano: Number(start + 2_000_000n),
                  attributes: [{ key: "db.rows", value: { intValue: "7" } }],
                  events: [{ timeUnixNano: start.toString(), name: "retry" }],
                  someFieldFromTheFuture: { ignored: true },
                },
              ],
            },
          ],
        },
      ],
    };
    const response = await post("/v1/traces", JSON.stringify(request), {
      key: project.secretKey,
      type: JSON_TYPE,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(response.json()).toEqual({});

    const [row] = await storedRows(dashboard.reader.client, "spans", project.id);
    expect(row).toMatchObject({
      trace_id: traceId,
      span_id: spanId,
      kind: "client",
      service: "api",
      release: "",
      environment: "production",
      scope_name: "manual",
      scope_version: "1.0.0",
      attributes: { "db.rows": "7" },
      events: JSON.stringify([{ time: start.toString(), name: "retry", attributes: {} }]),
    });
    // Within the number's precision as JSON sends it.
    expect(Number(row?.duration_ns)).toBeGreaterThan(1_000_000);
  });

  test("answers partial_success for refused spans and stores the rest", async () => {
    const project = await newProject("Traces partial");
    const hour = 3600n * 1_000_000_000n;
    const body = protobufTraces([
      protobufSpan(randomHex(16), randomHex(8)),
      protobufSpan(randomHex(16), randomHex(8), {
        startTimeUnixNano: String(nowNs() + 2n * hour),
        endTimeUnixNano: String(nowNs() + 3n * hour),
      }),
      protobufSpan(randomHex(16), randomHex(8), {
        startTimeUnixNano: String(nowNs() - 31n * 24n * hour),
        endTimeUnixNano: String(nowNs() - 31n * 24n * hour + 1n),
      }),
      protobufSpan(randomHex(16), randomHex(8), {
        endTimeUnixNano: String(nowNs() - 3_600_000_000_000n),
      }),
    ]);
    const response = await post("/v1/traces", body, { key: project.secretKey });
    expect(response.statusCode).toBe(200);
    expect(decodeResponse(TRACE_MESSAGES.response, response.rawPayload)).toEqual({
      partialSuccess: {
        rejectedSpans: 3,
        errorMessage:
          "3 of 4 spans refused: times more than an hour ahead of the server's clock; times older than the 30 days telemetry is kept; spans that end before they start.",
      },
    });
    expect(await storedRows(dashboard.reader.client, "spans", project.id)).toHaveLength(1);
  });

  test("a retried request is stored once", async () => {
    const project = await newProject("Traces retried");
    const body = protobufTraces([
      protobufSpan(randomHex(16), randomHex(8)),
      protobufSpan(randomHex(16), randomHex(8)),
    ]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await post("/v1/traces", body, { key: project.secretKey })).statusCode).toBe(200);
    }
    expect(await storedRows(dashboard.reader.client, "spans", project.id)).toHaveLength(2);
  });
});

function logsRequest(records: object[], service = "worker") {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: keyValues({ "service.name": service, "deployment.environment": "QA" }),
        },
        scopeLogs: [{ scope: { name: "pino" }, logRecords: records }],
      },
    ],
  };
}

describe("POST /v1/logs", () => {
  test("stores protobuf and JSON log records", async () => {
    const project = await newProject("Logs");
    const traceId = randomHex(16);
    const at = nowNs(-2000);
    const protobuf = await post(
      "/v1/logs",
      encodeProtobuf(
        LOGS_MESSAGES,
        logsRequest([
          {
            timeUnixNano: String(at),
            severityNumber: 17,
            severityText: "ERROR",
            body: { stringValue: "payment failed for order 42" },
            traceId: Buffer.from(traceId, "hex"),
            attributes: keyValues({ "order.id": 42 }),
          },
        ]),
      ),
      { key: project.secretKey },
    );
    expect(protobuf.statusCode).toBe(200);

    const json = await post(
      "/v1/logs",
      JSON.stringify(
        logsRequest([
          {
            observedTimeUnixNano: String(at + 1n),
            severityNumber: 9,
            body: { kvlistValue: { values: [{ key: "msg", value: { stringValue: "hi" } }] } },
            traceId,
          },
        ]),
      ),
      { key: project.secretKey, type: JSON_TYPE },
    );
    expect(json.statusCode).toBe(200);
    expect(json.json()).toEqual({});

    const rows = await storedRows(dashboard.reader.client, "logs", project.id);
    expect(rows).toEqual([
      expect.objectContaining({
        severity_number: 17,
        severity_text: "ERROR",
        body: "payment failed for order 42",
        trace_id: traceId,
        service: "worker",
        environment: "qa",
        scope_name: "pino",
        attributes: { "order.id": "42" },
      }),
      expect.objectContaining({ severity_number: 9, body: '{"msg":"hi"}', trace_id: traceId }),
    ]);
  });

  test("finds a record by a word of its body (the text index)", async () => {
    const project = await newProject("Logs search");
    const word = `needle${randomHex(4)}`;
    const response = await post(
      "/v1/logs",
      encodeProtobuf(
        LOGS_MESSAGES,
        logsRequest([
          { timeUnixNano: String(nowNs()), body: { stringValue: `found the ${word} here` } },
          { timeUnixNano: String(nowNs()), body: { stringValue: "nothing" } },
        ]),
      ),
      { key: project.secretKey },
    );
    expect(response.statusCode).toBe(200);
    const result = await dashboard.reader.client.query({
      query: `SELECT body FROM logs WHERE project_id = {project:UUID} AND hasToken(body, {word:String})`,
      query_params: { project: project.id, word },
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([{ body: `found the ${word} here` }]);
  });

  test("a retried request is stored once", async () => {
    const project = await newProject("Logs retried");
    const body = JSON.stringify(
      logsRequest([
        { timeUnixNano: String(nowNs()), body: { stringValue: "one" } },
        { timeUnixNano: String(nowNs()), body: { stringValue: "two" } },
      ]),
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        (await post("/v1/logs", body, { key: project.secretKey, type: JSON_TYPE })).statusCode,
      ).toBe(200);
    }
    expect(await storedRows(dashboard.reader.client, "logs", project.id)).toHaveLength(2);
  });
});

function metricsRequest(metrics: object[]) {
  return {
    resourceMetrics: [
      {
        resource: { attributes: keyValues({ "service.name": "api", "service.version": "9" }) },
        scopeMetrics: [{ scope: { name: "meter" }, metrics }],
      },
    ],
  };
}

const time = () => String(nowNs(-1000));

function allKinds() {
  return metricsRequest([
    {
      name: "queue.depth",
      unit: "{job}",
      gauge: { dataPoints: [{ timeUnixNano: time(), asDouble: 3.5 }] },
    },
    {
      name: "http.requests",
      sum: {
        aggregationTemporality: 2,
        isMonotonic: true,
        dataPoints: [
          {
            startTimeUnixNano: String(nowNs(-60_000)),
            timeUnixNano: time(),
            asInt: "41",
            attributes: keyValues({ "http.route": "/pay" }),
          },
        ],
      },
    },
    {
      name: "http.duration",
      unit: "ms",
      histogram: {
        aggregationTemporality: 1,
        dataPoints: [
          {
            timeUnixNano: time(),
            count: "4",
            sum: 30,
            min: 2,
            max: 15,
            explicitBounds: [5, 10],
            bucketCounts: ["2", "1", "1"],
          },
        ],
      },
    },
  ]);
}

describe("POST /v1/metrics", () => {
  test("stores protobuf gauges, sums, and histograms", async () => {
    const project = await newProject("Metrics protobuf");
    const response = await post("/v1/metrics", encodeProtobuf(METRICS_MESSAGES, allKinds()), {
      key: project.secretKey,
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.byteLength).toBe(0);

    const points = await storedRows(dashboard.reader.client, "metric_points", project.id);
    expect(points).toHaveLength(2);
    expect(points).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "queue.depth",
          unit: "{job}",
          kind: "gauge",
          temporality: "unspecified",
          monotonic: false,
          value: 3.5,
          service: "api",
          release: "9",
        }),
        expect.objectContaining({
          name: "http.requests",
          kind: "sum",
          temporality: "cumulative",
          monotonic: true,
          value: 41,
          attributes: { "http.route": "/pay" },
        }),
      ]),
    );
    const histograms = await storedRows(dashboard.reader.client, "metric_histograms", project.id);
    expect(histograms).toEqual([
      expect.objectContaining({
        name: "http.duration",
        temporality: "delta",
        count: "4",
        sum: 30,
        min: 2,
        max: 15,
        bounds: [5, 10],
        bucket_counts: ["2", "1", "1"],
      }),
    ]);
  });

  test("stores JSON metrics; a retry is stored once", async () => {
    const project = await newProject("Metrics JSON");
    const body = JSON.stringify(allKinds());
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await post("/v1/metrics", body, {
        key: project.secretKey,
        type: JSON_TYPE,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({});
    }
    expect(await storedRows(dashboard.reader.client, "metric_points", project.id)).toHaveLength(2);
    expect(await storedRows(dashboard.reader.client, "metric_histograms", project.id)).toHaveLength(
      1,
    );
  });

  test("refuses exponential histograms, summaries, and points without a time, in partial_success", async () => {
    const project = await newProject("Metrics partial");
    const request = metricsRequest([
      {
        name: "latency",
        exponentialHistogram: {
          aggregationTemporality: 1,
          dataPoints: [{ timeUnixNano: time(), count: "1", scale: 2 }],
        },
      },
      {
        name: "rpc.duration",
        summary: { dataPoints: [{ timeUnixNano: time(), count: "1", sum: 2 }] },
      },
      { name: "up", gauge: { dataPoints: [{ asInt: "1" }, { timeUnixNano: time(), asInt: "1" }] } },
    ]);

    const json = await post("/v1/metrics", JSON.stringify(request), {
      key: project.secretKey,
      type: JSON_TYPE,
    });
    expect(json.statusCode).toBe(200);
    expect(json.json()).toEqual({
      partialSuccess: {
        rejectedDataPoints: "3",
        errorMessage:
          "3 of 4 data points refused: exponential histograms and summaries are not supported yet; data points without a time.",
      },
    });

    const protobuf = await post("/v1/metrics", encodeProtobuf(METRICS_MESSAGES, request), {
      key: project.secretKey,
    });
    expect(decodeResponse(METRICS_MESSAGES.response, protobuf.rawPayload)).toMatchObject({
      partialSuccess: { rejectedDataPoints: 3 },
    });
    expect(await storedRows(dashboard.reader.client, "metric_points", project.id)).toHaveLength(1);
  });
});

describe("bodies", () => {
  test("takes a gzip body", async () => {
    const project = await newProject("Gzip");
    const response = await post(
      "/v1/traces",
      gzipSync(protobufTraces([protobufSpan(randomHex(16), randomHex(8))])),
      { key: project.secretKey, headers: { "content-encoding": "gzip" } },
    );
    expect(response.statusCode).toBe(200);
    expect(await storedRows(dashboard.reader.client, "spans", project.id)).toHaveLength(1);
  });

  test("413 over 16 MiB, sent or once unpacked", async () => {
    const project = await newProject("Too large");
    const huge = Buffer.alloc(16 * 1024 * 1024 + 1, 0x20);

    const sent = await post("/v1/logs", huge, { key: project.secretKey, type: JSON_TYPE });
    expect(sent.statusCode).toBe(413);
    expect(sent.json()).toEqual({ code: 3, message: "The body is larger than 16 MiB." });

    const unpacked = await post("/v1/logs", gzipSync(huge), {
      key: project.secretKey,
      headers: { "content-encoding": "gzip" },
    });
    expect(unpacked.statusCode).toBe(413);
    expect(statusOf(unpacked.rawPayload)).toEqual({
      code: 3,
      message: "The body is larger than 16 MiB once unpacked.",
    });
  });

  test("415 for another content type or encoding", async () => {
    const project = await newProject("Unsupported");
    const type = await post("/v1/traces", "spans", { key: project.secretKey, type: "text/plain" });
    expect(type.statusCode).toBe(415);
    expect(type.json()).toMatchObject({ code: 3 });

    const encoding = await post("/v1/traces", "{}", {
      key: project.secretKey,
      type: JSON_TYPE,
      headers: { "content-encoding": "br" },
    });
    expect(encoding.statusCode).toBe(415);
    expect(encoding.json()).toEqual({
      code: 3,
      message: "Send the body as it is, or with Content-Encoding: gzip.",
    });
  });

  test("400 for what is not OTLP, or not the encoding it says", async () => {
    const project = await newProject("Malformed");
    const cases: [string, Buffer | string, string][] = [
      ["/v1/traces", Buffer.from([0x0a, 0xff, 0xff, 0xff, 0xff, 0x0f]), PROTOBUF],
      ["/v1/traces", "{not json", JSON_TYPE],
      ["/v1/traces", "[]", JSON_TYPE],
      ["/v1/traces", JSON.stringify({ resourceSpans: 5 }), JSON_TYPE],
      [
        "/v1/traces",
        JSON.stringify({
          resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: "xyz", spanId: "00" }] }] }],
        }),
        JSON_TYPE,
      ],
      [
        "/v1/logs",
        JSON.stringify({
          resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: "1.5" }] }] }],
        }),
        JSON_TYPE,
      ],
      ["/v1/metrics", Buffer.from("not gzip"), PROTOBUF],
    ];
    for (const [index, [path, body, type]] of cases.entries()) {
      const response = await post(path, body, {
        key: project.secretKey,
        type,
        headers: index === cases.length - 1 ? { "content-encoding": "gzip" } : {},
      });
      expect(response.statusCode, `case ${index}`).toBe(400);
      const status =
        type === PROTOBUF ? statusOf(response.rawPayload) : response.json<{ code: number }>();
      expect(status.code).toBe(3);
    }
    // An empty protobuf body is an empty request: nothing to store.
    const empty = await post("/v1/traces", Buffer.alloc(0), { key: project.secretKey });
    expect(empty.statusCode).toBe(200);
  });

  test(`413 for a body that decodes into more than ${MAX_MESSAGES} messages, counted before decoding`, async () => {
    const project = await newProject("Many messages");
    const message = `A request decodes into at most ${MAX_MESSAGES} messages (records, attributes, values). Send smaller batches.`;
    // Empty ResourceSpans, two bytes each: about 2 MB that would decode into a million objects.
    const protobuf = Buffer.alloc(MAX_MESSAGES * 2);
    for (let index = 0; index < protobuf.length; index += 2) protobuf[index] = 0x0a;
    const fromProtobuf = await post("/v1/traces", protobuf, { key: project.secretKey });
    expect(fromProtobuf.statusCode).toBe(413);
    expect(statusOf(fromProtobuf.rawPayload)).toEqual({ code: 3, message });

    const json = `{"resourceSpans":[${"{},".repeat(MAX_MESSAGES - 1)}{}]}`;
    const fromJson = await post("/v1/traces", json, { key: project.secretKey, type: JSON_TYPE });
    expect(fromJson.statusCode).toBe(413);
    expect(fromJson.json()).toEqual({ code: 3, message });
    expect(await storedRows(dashboard.reader.client, "spans", project.id)).toEqual([]);
  });
});

describe("budgets", () => {
  test("429 with Retry-After once a project's records run out; never more than the budget in one request", async () => {
    const limited = await signedInDashboard({
      telemetry: {
        projectLimit: { capacity: 3, refillPerSecond: 0.01 },
        instanceLimit: { capacity: 9, refillPerSecond: 0.03 },
      },
    });
    try {
      const project = await insertProject(limited.db, {
        name: "Budget",
      });
      const key = await secretKeyOf(limited.db, project.id);
      const spans = (count: number) =>
        protobufTraces(
          Array.from({ length: count }, () => protobufSpan(randomHex(16), randomHex(8))),
        );

      // Too many records for any budget: refused once decoded. Decoding
      // its 71 messages cost 2, which it keeps, so 1 is left.
      const tooMany = await post("/v1/traces", spans(4), { key, app: limited.app });
      expect(tooMany.statusCode).toBe(413);
      expect(statusOf(tooMany.rawPayload).message).toBe(
        "A request holds at most 3 records. This request contains 4. Send smaller batches.",
      );

      expect((await post("/v1/traces", spans(1), { key, app: limited.app })).statusCode).toBe(200);
      const over = await post("/v1/traces", spans(1), { key, app: limited.app });
      expect(over.statusCode).toBe(429);
      expect(Number(over.headers["retry-after"])).toBeGreaterThan(0);
      expect(statusOf(over.rawPayload)).toMatchObject({ code: 8 });
      expect(await storedRows(limited.reader.client, "spans", project.id)).toHaveLength(1);
    } finally {
      await limited.close();
    }
  });
});

/** About 8 KB of attributes, which every record's row repeats. */
const LARGE_RESOURCE = {
  attributes: keyValues(
    Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`k8s.label.${i}`, "x".repeat(2000)])),
  ),
};

function logsOf(resource: object, count: number) {
  return encodeProtobuf(LOGS_MESSAGES, {
    resourceLogs: [
      {
        resource,
        scopeLogs: [
          {
            logRecords: Array.from({ length: count }, (_, index) => ({
              timeUnixNano: String(nowNs(-index)),
              body: { stringValue: `line ${index}` },
            })),
          },
        ],
      },
    ],
  });
}

/** A trace request of one span with `count` integer attributes. */
function spanWithAttributes(count: number) {
  return protobufTraces([
    protobufSpan(randomHex(16), randomHex(8), {
      attributes: keyValues(
        Object.fromEntries(Array.from({ length: count }, (_, i) => [`a${i}`, i])),
      ),
    }),
  ]);
}

describe("budgets by size", () => {
  let limited: Awaited<ReturnType<typeof signedInDashboard>>;

  beforeAll(async () => {
    limited = await signedInDashboard({
      telemetry: {
        projectLimit: { capacity: 10, refillPerSecond: 0.01 },
        instanceLimit: { capacity: 1000, refillPerSecond: 1 },
      },
    });
  });

  afterAll(async () => {
    await limited?.close();
  });

  async function limitedProject(name: string) {
    const project = await insertProject(limited.db, {
      name,
    });
    return { id: project.id, secretKey: await secretKeyOf(limited.db, project.id) };
  }

  test("records that repeat a large resource cost a unit per 2 KiB of their rows", async () => {
    const small = await limitedProject("Small resource");
    const smallResponse = await post("/v1/logs", logsOf(RESOURCE, 3), {
      key: small.secretKey,
      app: limited.app,
    });
    expect(smallResponse.statusCode).toBe(200);

    // Three rows of 8 KB each, and the body: 16 units, over the 10 a project has.
    const large = await limitedProject("Large resource");
    const tooLarge = await post("/v1/logs", logsOf(LARGE_RESOURCE, 3), {
      key: large.secretKey,
      app: limited.app,
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(statusOf(tooLarge.rawPayload).message).toBe(
      "A request may cost at most 10 (one per record, or more for numerous or large attributes). This request costs 16. Send smaller batches.",
    );

    // One row: 8 units, so a second does not fit.
    const one = await limitedProject("One large record");
    const first = await post("/v1/logs", logsOf(LARGE_RESOURCE, 1), {
      key: one.secretKey,
      app: limited.app,
    });
    expect(first.statusCode).toBe(200);
    const second = await post("/v1/logs", logsOf(LARGE_RESOURCE, 1), {
      key: one.secretKey,
      app: limited.app,
    });
    expect(second.statusCode).toBe(429);
    expect(await storedRows(limited.reader.client, "logs", one.id)).toHaveLength(1);
  });

  test("a record of many attributes costs a unit per 64 messages, paid before decoding", async () => {
    const project = await limitedProject("Many attributes");
    // 400 attributes are 800 messages, and the request's own: 13 units.
    const many = await post("/v1/traces", spanWithAttributes(400), {
      key: project.secretKey,
      app: limited.app,
    });
    expect(many.statusCode).toBe(413);
    expect(statusOf(many.rawPayload).message).toMatch(/This request costs 13\./);
    const few = await post("/v1/traces", spanWithAttributes(20), {
      key: project.secretKey,
      app: limited.app,
    });
    expect(few.statusCode).toBe(200);
  });
});

describe("requests in progress", () => {
  test("503 past the process's limit, 429 past one project's, each given back with its answer", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let inserts = 0;
    // A ClickHouse that holds every insert until the gate opens.
    const held = {
      insert: async () => {
        inserts += 1;
        await gate;
      },
    } as unknown as ClickHouseClient;
    const app = buildApp({
      db: dashboard.db,
      telemetry: { clickhouse: held, maxInFlight: 3, maxInFlightPerProject: 2 },
    });
    try {
      const ours = await newProject("Busy");
      const theirs = await newProject("Busy elsewhere");
      const send = (secretKey: string) =>
        post("/v1/traces", protobufTraces([protobufSpan(randomHex(16), randomHex(8))]), {
          key: secretKey,
          app,
        });

      const waiting = [send(ours.secretKey), send(ours.secretKey)];
      await expect.poll(() => inserts).toBe(2);
      const projectFull = await send(ours.secretKey);
      expect(projectFull.statusCode).toBe(429);
      expect(projectFull.headers["retry-after"]).toBe("1");

      waiting.push(send(theirs.secretKey));
      await expect.poll(() => inserts).toBe(3);
      const processFull = await send(theirs.secretKey);
      expect(processFull.statusCode).toBe(503);
      expect(processFull.headers["retry-after"]).toBe("1");
      expect(statusOf(processFull.rawPayload)).toMatchObject({ code: 14 });

      open();
      for (const response of await Promise.all(waiting)) expect(response.statusCode).toBe(200);
      // Every slot was given back.
      expect((await send(ours.secretKey)).statusCode).toBe(200);
      expect((await send(ours.secretKey)).statusCode).toBe(200);
      expect((await send(theirs.secretKey)).statusCode).toBe(200);
    } finally {
      open();
      await app.close();
    }
  });
  test("a client that hangs up while its records are being written gives its slots back", async () => {
    const waiting: (() => void)[] = [];
    // A ClickHouse that holds every insert until the test lets it finish.
    const held = {
      insert: () =>
        new Promise<void>((resolve) => {
          waiting.push(resolve);
        }),
    } as unknown as ClickHouseClient;
    const app = buildApp({
      db: dashboard.db,
      telemetry: { clickhouse: held, maxInFlight: 2, maxInFlightPerProject: 1 },
    });
    try {
      const project = await newProject("Hangs up");
      const hangUp = await hangingUpClient(app);
      const headers = { "content-type": PROTOBUF, authorization: `Bearer ${project.secretKey}` };
      // More hang-ups than either limit: each would be refused if one before kept its slot.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const before = waiting.length;
        await hangUp(
          "/v1/traces",
          headers,
          protobufTraces([protobufSpan(randomHex(16), randomHex(8))]),
          () => waiting.length > before,
        );
      }
      const before = waiting.length;
      const next = post("/v1/traces", protobufTraces([protobufSpan(randomHex(16), randomHex(8))]), {
        key: project.secretKey,
        app,
      });
      await expect.poll(() => waiting.length).toBeGreaterThan(before);
      for (const resolve of waiting) resolve();
      expect((await next).statusCode).toBe(200);
    } finally {
      for (const resolve of waiting) resolve();
      await app.close();
    }
  });
});

describe("ClickHouse", () => {
  test("503 with Retry-After when it cannot take the records, and the budget is given back", async () => {
    const unreachable = createClickHouse(
      { ...loadConfig().clickhouse, url: "http://127.0.0.1:1" },
      { database: dashboard.clickhouseDatabase },
    );
    const app = buildApp({
      db: dashboard.db,
      telemetry: {
        clickhouse: unreachable,
        projectLimit: { capacity: 2, refillPerSecond: 0.01 },
      },
    });
    try {
      const project = await newProject("ClickHouse down");
      const body = protobufTraces([
        protobufSpan(randomHex(16), randomHex(8)),
        protobufSpan(randomHex(16), randomHex(8)),
      ]);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await post("/v1/traces", body, { key: project.secretKey, app });
        // Refused for the store, never for the budget the first attempt spent.
        expect(response.statusCode).toBe(503);
        expect(response.headers["retry-after"]).toBe("5");
        expect(statusOf(response.rawPayload)).toEqual({
          code: 14,
          message: "Telemetry was not stored. Retry later.",
        });
      }
    } finally {
      await app.close();
      await unreachable.close();
    }
  });
});

const SERVER_STACK = `java.lang.IllegalStateException: Cart 7731 is empty
\tat com.example.shop.cart.CartService.checkout(CartService.java:88)
\tat com.example.shop.cart.CartController.post(CartController.java:41)`;

/** A span event recording an exception, as OpenTelemetry's SDKs do. */
function exceptionEvent(message: string, at = nowNs(-4000)) {
  return {
    name: "exception",
    timeUnixNano: String(at),
    attributes: keyValues({
      "exception.type": "java.lang.IllegalStateException",
      "exception.message": message,
      "exception.stacktrace": SERVER_STACK,
    }),
  };
}

/** A log record with an exception's attributes, as OpenTelemetry's log bridges write them. */
function exceptionLog(message: string, traceId: string, spanId: string) {
  return {
    timeUnixNano: String(nowNs(-3000)),
    severityNumber: 17,
    body: { stringValue: "charge failed" },
    traceId,
    spanId,
    attributes: keyValues({
      "exception.type": "TimeoutError",
      "exception.message": message,
      "user.id": "ada",
    }),
  };
}

describe("exceptions join the error list", () => {
  test("a span's exception and a log's, in protobuf and JSON, become error events; a retry keeps one of each", async () => {
    const project = await newProject("Server errors");
    const traceId = randomHex(16);
    const spanId = randomHex(8);
    const traceBody = protobufTraces([
      protobufSpan(traceId, spanId, {
        attributes: keyValues({ "http.route": "/pay", "user.id": "ada" }),
        events: [exceptionEvent("Cart 7731 is empty")],
      }),
    ]);
    const logBody = JSON.stringify(
      logsRequest([exceptionLog("gateway timed out", traceId, spanId)], "payments"),
    );
    const jsonTraceBody = JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: keyValues({ "service.name": "api" }) },
          scopeSpans: [
            {
              spans: [
                {
                  traceId,
                  spanId: randomHex(8),
                  name: "GET /cart",
                  startTimeUnixNano: String(nowNs(-6000)),
                  endTimeUnixNano: String(nowNs(-5900)),
                  status: { code: 1 },
                  events: [exceptionEvent("Cart 9 is empty", nowNs(-5950))],
                },
              ],
            },
          ],
        },
      ],
    });
    const protobufLogBody = encodeProtobuf(
      LOGS_MESSAGES,
      logsRequest([
        {
          ...exceptionLog("gateway refused", traceId, spanId),
          traceId: Buffer.from(traceId, "hex"),
          spanId: Buffer.from(spanId, "hex"),
          severityNumber: 13,
        },
      ]),
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await post("/v1/traces", traceBody, { key: project.secretKey })).statusCode).toBe(
        200,
      );
      expect(
        (await post("/v1/traces", jsonTraceBody, { key: project.secretKey, type: JSON_TYPE }))
          .statusCode,
      ).toBe(200);
      expect(
        (await post("/v1/logs", logBody, { key: project.secretKey, type: JSON_TYPE })).statusCode,
      ).toBe(200);
      expect((await post("/v1/logs", protobufLogBody, { key: project.secretKey })).statusCode).toBe(
        200,
      );
    }

    expect(await countEvents(dashboard.reader.client, project.id)).toBe(4);
    const events = await storedEvents(dashboard.reader.client, project.id);
    const byMessage = Object.fromEntries(events.map((event) => [event.error_message, event]));
    expect(byMessage["Cart 7731 is empty"]).toMatchObject({
      name: "error",
      path: "/pay",
      user_id: "ada",
      environment: "staging",
      release: "2.3.1",
      visitor_id: null,
      browser: null,
      properties: {},
      error_type: "java.lang.IllegalStateException",
      error_stack: SERVER_STACK,
      error_handled: false,
      error_fingerprint: fingerprint({
        type: "java.lang.IllegalStateException",
        message: "Cart 7731 is empty",
        stack: SERVER_STACK,
      }),
      service: "checkout",
      trace_id: traceId,
      span_id: spanId,
    });
    // On a span that did not fail: handled. No route: no path.
    expect(byMessage["Cart 9 is empty"]).toMatchObject({
      path: null,
      environment: "production",
      error_handled: true,
      service: "api",
      trace_id: traceId,
    });
    expect(byMessage["gateway timed out"]).toMatchObject({
      error_type: "TimeoutError",
      error_stack: null,
      error_handled: false,
      user_id: "ada",
      environment: "qa",
      service: "payments",
      trace_id: traceId,
      span_id: spanId,
    });
    // Below the error severity: handled.
    expect(byMessage["gateway refused"]).toMatchObject({ error_handled: true, span_id: spanId });
  });

  test("the error list shows the group, and its page the service and trace", async () => {
    const project = await newProject("Server error pages");
    const traceId = randomHex(16);
    const spanId = randomHex(8);
    const response = await post(
      "/v1/traces",
      protobufTraces([
        protobufSpan(traceId, spanId, { events: [exceptionEvent("Cart 7731 is empty")] }),
      ]),
      { key: project.secretKey },
    );
    expect(response.statusCode).toBe(200);
    const group = fingerprint({
      type: "java.lang.IllegalStateException",
      message: "Cart 7731 is empty",
      stack: SERVER_STACK,
    });
    const get = (path: string) =>
      dashboard.app.inject({
        url: `/api/projects/${project.id}${path}`,
        headers: { cookie: dashboard.cookie },
      });

    const list = await get("/errors?period=7d&environment=staging");
    expect(list.statusCode).toBe(200);
    expect(list.json().groups).toMatchObject([
      {
        fingerprint: group,
        type: "java.lang.IllegalStateException",
        message: "Cart 7731 is empty",
        occurrences: 1,
        users: 0,
        visitors: 0,
      },
    ]);

    const detail = await get(`/errors/${group}?period=7d&environment=staging`);
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body).toMatchObject({
      source: "server",
      stack: SERVER_STACK,
      // Source maps are for browser code.
      frames: null,
      sourceMaps: null,
      breakdowns: {
        path: [{ value: "/pay", occurrences: 1 }],
        browser: [{ value: null, occurrences: 1 }],
        service: [{ value: "checkout", occurrences: 1 }],
      },
    });
    expect(body.occurrences).toMatchObject([
      {
        path: "/pay",
        release: "2.3.1",
        browser: null,
        os: null,
        service: "checkout",
        traceId,
        spanId,
        replay: null,
      },
    ]);
  });

  test("each error event costs a unit more", async () => {
    const limited = await signedInDashboard({
      telemetry: {
        projectLimit: { capacity: 5, refillPerSecond: 0.01 },
        instanceLimit: { capacity: 1000, refillPerSecond: 1 },
      },
    });
    try {
      const project = await insertProject(limited.db, {
        name: "Exception budget",
      });
      const key = await secretKeyOf(limited.db, project.id);
      const withExceptions = (count: number) =>
        protobufTraces([
          protobufSpan(randomHex(16), randomHex(8), {
            events: Array.from({ length: count }, (_, i) => exceptionEvent(`failure ${i}`)),
          }),
        ]);

      // One span of about 3 KB (10 stacks), 2 units, and its 10 exceptions:
      // 12, over the 5 a project has.
      const tooMany = await post("/v1/traces", withExceptions(10), { key, app: limited.app });
      expect(tooMany.statusCode).toBe(413);
      expect(statusOf(tooMany.rawPayload).message).toMatch(/This request costs 12\./);
      expect(await countEvents(limited.reader.client, project.id)).toBe(0);

      // A span and its exception: 2 of the 5. Then a span and 3 exceptions,
      // 4, does not fit in the 3 left (it keeps the 1 its decoding cost),
      // where the span alone does.
      const project2 = await insertProject(limited.db, {
        name: "Exception budget 2",
      });
      const key2 = await secretKeyOf(limited.db, project2.id);
      const send = (count: number) =>
        post("/v1/traces", withExceptions(count), { key: key2, app: limited.app });
      expect((await send(1)).statusCode).toBe(200);
      expect((await send(3)).statusCode).toBe(429);
      expect((await send(0)).statusCode).toBe(200);
      expect(await countEvents(limited.reader.client, project2.id)).toBe(1);
    } finally {
      await limited.close();
    }
  });

  test("503 when ClickHouse cannot take them, and neither the spans nor the errors are stored", async () => {
    const unreachable = createClickHouse(
      { ...loadConfig().clickhouse, url: "http://127.0.0.1:1" },
      { database: dashboard.clickhouseDatabase },
    );
    const app = buildApp({ db: dashboard.db, telemetry: { clickhouse: unreachable } });
    try {
      const project = await newProject("Server errors, ClickHouse down");
      const response = await post(
        "/v1/traces",
        protobufTraces([
          protobufSpan(randomHex(16), randomHex(8), { events: [exceptionEvent("lost")] }),
        ]),
        { key: project.secretKey, app },
      );
      expect(response.statusCode).toBe(503);
      expect(await storedRows(dashboard.reader.client, "spans", project.id)).toEqual([]);
      expect(await countEvents(dashboard.reader.client, project.id)).toBe(0);
    } finally {
      await app.close();
      await unreachable.close();
    }
  });
});
