import { createHash } from "node:crypto";

import protobuf from "protobufjs";
import { describe, expect, test } from "vite-plus/test";

import {
  cutBytes,
  environmentOfResource,
  flattenAttributes,
  keepWithin,
  MAX_ATTRIBUTES,
  MAX_HISTOGRAM_BOUNDS,
  MAX_RESOURCE_ATTRIBUTE_BYTES,
  nanosText,
  normalizeLogs,
  normalizeMetrics,
  normalizeTraces,
  valueText,
} from "../src/telemetry/normalize.ts";
import { COMMON_PROTO } from "../src/telemetry/proto/common.ts";
import {
  LOGS_MESSAGES,
  METRICS_MESSAGES,
  TRACE_MESSAGES,
} from "../src/telemetry/proto/definitions.ts";
import { LOGS_SERVICE_PROTO } from "../src/telemetry/proto/logs-service.ts";
import { LOGS_PROTO } from "../src/telemetry/proto/logs.ts";
import { METRICS_SERVICE_PROTO } from "../src/telemetry/proto/metrics-service.ts";
import { METRICS_PROTO } from "../src/telemetry/proto/metrics.ts";
import { RESOURCE_PROTO } from "../src/telemetry/proto/resource.ts";
import { TRACE_SERVICE_PROTO } from "../src/telemetry/proto/trace-service.ts";
import { TRACE_PROTO } from "../src/telemetry/proto/trace.ts";
import { MalformedError } from "../src/telemetry/read.ts";
import {
  countJsonContainers,
  countMessages,
  countProtobufMessages,
  decodeRequest,
  ELEMENTS_PER_MESSAGE,
  MAX_MESSAGES,
  TooManyMessagesError,
} from "../src/telemetry/wire.ts";
import { encodeProtobuf, keyValues } from "./helpers/telemetry.ts";

const PROJECT = "0b0e5f1e-8a4e-4e43-9b0a-1f0c5d3e7a11";
const OTHER_PROJECT = "7c1d2e3f-4a5b-4c6d-8e7f-901a2b3c4d5e";
/** 18 November 2026, 12:00 UTC. */
const NOW = 1_795_003_200_000_000_000n;
const SECOND = 1_000_000_000n;
const context = { projectId: PROJECT, receivedAtNs: NOW, retentionDays: 30 };

const TRACE_ID = "5b8efff798038103d269b633813fc60c";
const SPAN_ID = "eee19b7ec3c1b174";

function span(overrides: Record<string, unknown> = {}) {
  return {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    name: "GET /checkout",
    kind: 2,
    startTimeUnixNano: String(NOW - 10n * SECOND),
    endTimeUnixNano: String(NOW - 10n * SECOND + 1_500_000n),
    ...overrides,
  };
}

function traces(spans: object[], resource = keyValues({ "service.name": "shop" })) {
  return { resourceSpans: [{ resource: { attributes: resource }, scopeSpans: [{ spans }] }] };
}

/** A histogram point with this many bounds, one value in its first bucket. */
const boundsPoint = (bounds: number) => ({
  timeUnixNano: String(NOW - SECOND),
  count: "1",
  explicitBounds: Array.from({ length: bounds }, (_, i) => i + 1),
  bucketCounts: Array.from({ length: bounds + 1 }, (_, i) => (i === 0 ? "1" : "0")),
});

/** A histogram point of one bucket, with this count and bucket count. */
const countPoint = (count: string, bucket: string) => ({
  timeUnixNano: String(NOW - SECOND),
  count,
  explicitBounds: [],
  bucketCounts: [bucket],
});

describe("the vendored message definitions", () => {
  // SHA-256 of each file at opentelemetry-proto v1.11.1, as GitHub serves it.
  test.each([
    ["common.proto", COMMON_PROTO],
    ["resource.proto", RESOURCE_PROTO],
    ["trace.proto", TRACE_PROTO],
    ["logs.proto", LOGS_PROTO],
    ["metrics.proto", METRICS_PROTO],
    ["trace_service.proto", TRACE_SERVICE_PROTO],
    ["logs_service.proto", LOGS_SERVICE_PROTO],
    ["metrics_service.proto", METRICS_SERVICE_PROTO],
  ])("%s keeps its Apache-2.0 header and is unchanged", (name, source) => {
    expect(source).toMatch(/^\/\/ Copyright \d{4}, OpenTelemetry Authors\n/);
    expect(source).toContain("Licensed under the Apache License, Version 2.0");
    expect(createHash("sha256").update(source).digest("hex")).toBe(UPSTREAM_SHA256[name]);
  });
});

describe("attributes", () => {
  test("strings as they are, numbers and booleans as written, the rest as JSON or hex", () => {
    const { attributes, dropped } = flattenAttributes([
      ...keyValues({ "http.route": "/checkout", "http.status_code": 503, ratio: 0.25, ok: false }),
      { key: "big", value: { intValue: "9007199254740993" } },
      { key: "inf", value: { doubleValue: "Infinity" } },
      { key: "bytes", value: { bytesValue: "AQID" } },
      {
        key: "list",
        value: {
          arrayValue: {
            values: [{ stringValue: "a" }, { intValue: 2 }, { boolValue: true }, {}],
          },
        },
      },
      {
        key: "map",
        value: {
          kvlistValue: {
            values: [
              { key: "nested", value: { kvlistValue: { values: keyValues({ n: 1 }) } } },
              { key: "huge", value: { intValue: "-9223372036854775808" } },
            ],
          },
        },
      },
      { key: "empty" },
    ]);
    expect(attributes).toEqual({
      "http.route": "/checkout",
      "http.status_code": "503",
      ratio: "0.25",
      ok: "false",
      big: "9007199254740993",
      inf: "Infinity",
      bytes: "010203",
      list: '["a",2,true,null]',
      map: '{"nested":{"n":1},"huge":"-9223372036854775808"}',
      empty: "",
    });
    expect(dropped).toBe(0);
    // Sorted by key, so the same attributes always give the same row.
    expect(Object.keys(attributes)).toEqual(Object.keys(attributes).toSorted());
  });

  test(`keeps at most ${MAX_ATTRIBUTES}, cuts keys to 256 characters and values to 4 KB`, () => {
    const many = Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`k${i}`, "v"]));
    const { attributes, dropped } = flattenAttributes([
      ...keyValues(many),
      // A key already kept is replaced, not dropped.
      ...keyValues({ k0: "again" }),
    ]);
    expect(Object.keys(attributes)).toHaveLength(MAX_ATTRIBUTES);
    expect(attributes.k0).toBe("again");
    expect(dropped).toBe(2);

    const long = flattenAttributes(keyValues({ ["k".repeat(300)]: "é".repeat(3000) })).attributes;
    const [[key, value] = ["", ""]] = Object.entries(long);
    expect(key).toHaveLength(256);
    expect(Buffer.byteLength(value)).toBe(4096);
  });

  test("an own property named __proto__ is an attribute like any other", () => {
    const { attributes } = flattenAttributes(keyValues({ ["__proto__"]: "x" }));
    expect(Object.getPrototypeOf(attributes)).toBe(Object.prototype);
    expect(Object.hasOwn(attributes, "__proto__")).toBe(true);
  });

  test("cuts text at a character, never inside one", () => {
    expect(cutBytes("aé", 2)).toBe("a");
    expect(cutBytes("a😀b", 4)).toBe("a");
    expect(cutBytes("abc", 3)).toBe("abc");
    // An unpaired surrogate cannot be stored as UTF-8: replaced.
    expect(cutBytes("a\uD800", 10)).toBe("a�");
  });

  test("renders a value as text", () => {
    expect(valueText(undefined)).toBe("");
    expect(valueText({ stringValue: "plain" })).toBe("plain");
    expect(valueText({ intValue: 7n })).toBe("7");
    expect(valueText({ doubleValue: 1e21 })).toBe("1e+21");
    expect(valueText({ bytesValue: Buffer.from([255]) })).toBe("ff");
  });

  test("a value of the wrong type is malformed", () => {
    expect(() => flattenAttributes([{ key: "x", value: { intValue: "1.5" } }])).toThrow(
      MalformedError,
    );
    expect(() => flattenAttributes([{ key: 5 }])).toThrow(MalformedError);
    expect(() => valueText({ arrayValue: { values: "no" } })).toThrow(MalformedError);
  });
});

describe("environment", () => {
  test("from deployment.environment.name, or the older deployment.environment, in lower case", () => {
    expect(environmentOfResource({ "deployment.environment.name": "Staging" })).toBe("staging");
    expect(environmentOfResource({ "deployment.environment": "QA-2" })).toBe("qa-2");
    expect(
      environmentOfResource({
        "deployment.environment.name": "preview",
        "deployment.environment": "old",
      }),
    ).toBe("preview");
  });

  test("production when missing or not a name the tracker accepts", () => {
    expect(environmentOfResource({})).toBe("production");
    expect(environmentOfResource({ "deployment.environment.name": "not valid!" })).toBe(
      "production",
    );
    expect(environmentOfResource({ "deployment.environment.name": "x".repeat(65) })).toBe(
      "production",
    );
  });
});

test("nanosText writes nanoseconds as ClickHouse reads a DateTime64(9)", () => {
  expect(nanosText(NOW + 123_456_789n)).toBe("2026-11-18 12:00:00.123456789");
  expect(nanosText(0n)).toBe("1970-01-01 00:00:00.000000000");
});

describe("normalizeTraces", () => {
  test("a span becomes a row with its resource's service, release, and environment", () => {
    const result = normalizeTraces(
      {
        resourceSpans: [
          {
            resource: {
              attributes: keyValues({
                "service.name": "checkout",
                "service.version": "1.4.2",
                "deployment.environment.name": "Staging",
                "host.name": "web-1",
              }),
            },
            scopeSpans: [
              {
                scope: { name: "@opentelemetry/instrumentation-http", version: "0.200.0" },
                spans: [
                  span({
                    parentSpanId: "0102030405060708",
                    attributes: keyValues({ "http.route": "/checkout" }),
                    droppedAttributesCount: 3,
                    status: { code: 2, message: "payment failed" },
                    events: [
                      {
                        timeUnixNano: String(NOW - 9n * SECOND),
                        name: "exception",
                        attributes: keyValues({ "exception.type": "PaymentError" }),
                      },
                    ],
                    links: [{ traceId: TRACE_ID.toUpperCase(), spanId: "0a0b0c0d0e0f1011" }],
                  }),
                ],
              },
            ],
          },
        ],
      },
      context,
    );
    expect(result).toMatchObject({ records: 1, refused: 0, message: "" });
    expect(result.rows).toEqual([
      {
        project_id: PROJECT,
        service: "checkout",
        release: "1.4.2",
        environment: "staging",
        resource_attributes: {
          "deployment.environment.name": "Staging",
          "host.name": "web-1",
          "service.name": "checkout",
          "service.version": "1.4.2",
        },
        scope_name: "@opentelemetry/instrumentation-http",
        scope_version: "0.200.0",
        timestamp: "2026-11-18 11:59:50.000000000",
        id: TRACE_ID + SPAN_ID,
        trace_id: TRACE_ID,
        span_id: SPAN_ID,
        parent_span_id: "0102030405060708",
        name: "GET /checkout",
        kind: 2,
        duration_ns: "1500000",
        status_code: 2,
        status_message: "payment failed",
        attributes: { "http.route": "/checkout" },
        dropped_attributes_count: 3,
        events: JSON.stringify([
          {
            time: String(NOW - 9n * SECOND),
            name: "exception",
            attributes: { "exception.type": "PaymentError" },
          },
        ]),
        dropped_events_count: 0,
        links: JSON.stringify([{ traceId: TRACE_ID, spanId: "0a0b0c0d0e0f1011", attributes: {} }]),
        dropped_links_count: 0,
      },
    ]);
  });

  test("without service.name, the service is unknown_service; a release with spaces is left out", () => {
    const [row] = normalizeTraces(
      traces([span()], keyValues({ "service.version": "not a release" })),
      context,
    ).rows;
    expect(row).toMatchObject({
      service: "unknown_service",
      release: "",
      environment: "production",
    });
  });

  test("protobuf's bytes and bigints read as JSON's hex and strings do", () => {
    const fromJson = normalizeTraces(traces([span()]), context).rows;
    const fromProtobuf = normalizeTraces(
      traces([
        span({
          traceId: Buffer.from(TRACE_ID, "hex"),
          spanId: Buffer.from(SPAN_ID, "hex"),
          startTimeUnixNano: NOW - 10n * SECOND,
          endTimeUnixNano: NOW - 10n * SECOND + 1_500_000n,
        }),
      ]),
      context,
    ).rows;
    expect(fromProtobuf).toEqual(fromJson);
  });

  test("keeps 128 events and 128 links, and counts the rest as dropped", () => {
    const event = { timeUnixNano: String(NOW), name: "tick" };
    const link = { traceId: TRACE_ID, spanId: SPAN_ID };
    const [row] = normalizeTraces(
      traces([
        span({
          events: Array.from({ length: 130 }, () => event),
          links: Array.from({ length: 129 }, () => link),
          droppedEventsCount: 1,
        }),
      ]),
      context,
    ).rows;
    expect(JSON.parse(row?.events ?? "[]")).toHaveLength(128);
    expect(JSON.parse(row?.links ?? "[]")).toHaveLength(128);
    expect(row).toMatchObject({ dropped_events_count: 3, dropped_links_count: 1 });
  });

  test("refuses spans without IDs, ending before they start, too far ahead, or too old, and says why", () => {
    const result = normalizeTraces(
      traces([
        span(),
        span({ spanId: "" }),
        span({ traceId: "0".repeat(32) }),
        span({ endTimeUnixNano: String(NOW - 11n * SECOND) }),
        span({ startTimeUnixNano: String(NOW + 3601n * SECOND), endTimeUnixNano: "0" }),
        span({ startTimeUnixNano: String(NOW - 31n * 86_400n * SECOND) }),
        span({ startTimeUnixNano: "0" }),
      ]),
      context,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.records).toBe(7);
    expect(result.refused).toBe(6);
    expect(result.message).toBe(
      "6 of 7 spans refused: spans without a trace ID and a span ID; spans that end before they start; times more than an hour ahead of the server's clock; times older than the 30 days telemetry is kept; spans without a start time.",
    );
  });

  test("an ID that is not hex, or not the right length, is malformed", () => {
    expect(() => normalizeTraces(traces([span({ traceId: "zz".repeat(16) })]), context)).toThrow(
      "traceId is not a hex ID",
    );
    expect(() => normalizeTraces(traces([span({ spanId: "abcd" })]), context)).toThrow(
      "spanId is not 8 bytes",
    );
    expect(() => normalizeTraces({ resourceSpans: {} }, context)).toThrow(MalformedError);
    expect(() => normalizeTraces(traces([span({ startTimeUnixNano: "soon" })]), context)).toThrow(
      MalformedError,
    );
  });

  test("the same span gives the same row", () => {
    expect(normalizeTraces(traces([span()]), context)).toEqual(
      normalizeTraces(traces([span()]), context),
    );
  });
});

function logs(records: object[]) {
  return {
    resourceLogs: [
      {
        resource: { attributes: keyValues({ "service.name": "worker" }) },
        scopeLogs: [{ scope: { name: "app" }, logRecords: records }],
      },
    ],
  };
}

describe("resource attributes", () => {
  test(`kept in key order up to ${MAX_RESOURCE_ATTRIBUTE_BYTES} bytes; service and environment read from all of them`, () => {
    const large = keyValues({
      "a.label": "x".repeat(4000),
      "b.label": "y".repeat(4000),
      "c.label": "z".repeat(4000),
      "deployment.environment.name": "staging",
      "service.name": "shop",
    });
    const [row] = normalizeTraces(traces([span()], large), context).rows;
    expect(Object.keys(row?.resource_attributes ?? {})).toEqual(["a.label", "b.label"]);
    expect(row).toMatchObject({ service: "shop", environment: "staging" });
  });

  test("keepWithin counts keys and values in UTF-8 bytes", () => {
    expect(keepWithin({ a: "é", b: "c" }, 3)).toEqual({ attributes: { a: "é" }, bytes: 3 });
    expect(keepWithin({ a: "é", b: "c" }, 5)).toEqual({
      attributes: { a: "é", b: "c" },
      bytes: 5,
    });
  });

  test("each row's copy of them is counted in sharedBytes", () => {
    const resource = keyValues({ "service.name": "shop" });
    const result = normalizeTraces(
      traces([span(), span({ spanId: "eee19b7ec3c1b175" })], resource),
      context,
    );
    // "service.name" and "shop", twice.
    expect(result.sharedBytes).toBe(2 * 16);
  });

  test("a log record's or data point's ID changes with its resource's attributes", () => {
    const record = { timeUnixNano: String(NOW), body: { stringValue: "hello" } };
    const withResource = (attributes: Record<string, string>) => ({
      resourceLogs: [
        {
          resource: { attributes: keyValues(attributes) },
          scopeLogs: [{ logRecords: [record] }],
        },
      ],
    });
    const [a] = normalizeLogs(
      withResource({ "service.name": "a", "host.name": "1" }),
      context,
    ).rows;
    const [b] = normalizeLogs(
      withResource({ "service.name": "a", "host.name": "2" }),
      context,
    ).rows;
    expect(a?.id).not.toBe(b?.id);
  });
});

describe("normalizeLogs", () => {
  test("a record's time, or its observed time when it has none, or when it arrived", () => {
    const at = NOW - 5n * SECOND;
    const result = normalizeLogs(
      logs([
        {
          timeUnixNano: String(at),
          observedTimeUnixNano: String(at + 1000n),
          severityNumber: 17,
          severityText: "ERROR",
          body: { stringValue: "payment failed" },
          traceId: TRACE_ID,
          spanId: SPAN_ID,
          eventName: "payment.failed",
          attributes: keyValues({ "order.id": 42 }),
        },
        {
          observedTimeUnixNano: String(at),
          body: { kvlistValue: { values: keyValues({ a: 1 }) } },
        },
        { body: { stringValue: "no time at all" } },
      ]),
      context,
    );
    expect(result.refused).toBe(0);
    expect(result.rows.map((row) => [row.timestamp, row.observed_timestamp, row.body])).toEqual([
      ["2026-11-18 11:59:55.000000000", "2026-11-18 11:59:55.000001000", "payment failed"],
      ["2026-11-18 11:59:55.000000000", "2026-11-18 11:59:55.000000000", '{"a":1}'],
      ["2026-11-18 12:00:00.000000000", "2026-11-18 12:00:00.000000000", "no time at all"],
    ]);
    expect(result.rows[0]).toMatchObject({
      service: "worker",
      scope_name: "app",
      severity_number: 17,
      severity_text: "ERROR",
      trace_id: TRACE_ID,
      span_id: SPAN_ID,
      event_name: "payment.failed",
      attributes: { "order.id": "42" },
    });
    expect(result.rows[1]).toMatchObject({ trace_id: "", span_id: "" });
  });

  test("cuts a body to 64 KB", () => {
    const [row] = normalizeLogs(
      logs([{ timeUnixNano: String(NOW), body: { stringValue: "x".repeat(70_000) } }]),
      context,
    ).rows;
    expect(row?.body).toHaveLength(64 * 1024);
  });

  test("an ID from the record's content: the same in a retry, another in another project", () => {
    const request = logs([{ timeUnixNano: String(NOW), body: { stringValue: "hello" } }]);
    const [first] = normalizeLogs(request, context).rows;
    const [again] = normalizeLogs(request, { ...context, receivedAtNs: NOW + SECOND }).rows;
    const [elsewhere] = normalizeLogs(request, { ...context, projectId: OTHER_PROJECT }).rows;
    expect(first?.id).toMatch(/^[0-9a-f]{32}$/);
    expect(again?.id).toBe(first?.id);
    expect(elsewhere?.id).not.toBe(first?.id);
  });

  test("refuses records too far ahead or too old", () => {
    const result = normalizeLogs(
      logs([
        { timeUnixNano: String(NOW + 2n * 3600n * SECOND) },
        { timeUnixNano: String(NOW - 40n * 86_400n * SECOND) },
        { timeUnixNano: String(NOW) },
      ]),
      { ...context, retentionDays: 35 },
    );
    expect(result).toMatchObject({ records: 3, refused: 2 });
    expect(result.message).toContain("times older than the 35 days telemetry is kept");
  });
});

function metrics(list: object[]) {
  return {
    resourceMetrics: [
      {
        resource: { attributes: keyValues({ "service.name": "api" }) },
        scopeMetrics: [{ scope: { name: "meter" }, metrics: list }],
      },
    ],
  };
}

describe("normalizeMetrics", () => {
  const time = String(NOW - SECOND);
  const start = String(NOW - 60n * SECOND);

  test("gauges and sums become points, histograms histogram rows", () => {
    const result = normalizeMetrics(
      metrics([
        {
          name: "process.memory.usage",
          unit: "By",
          gauge: { dataPoints: [{ timeUnixNano: time, asDouble: 1024.5 }] },
        },
        {
          name: "http.server.requests",
          unit: "{request}",
          sum: {
            aggregationTemporality: 2,
            isMonotonic: true,
            dataPoints: [
              {
                startTimeUnixNano: start,
                timeUnixNano: time,
                asInt: "12",
                attributes: keyValues({ "http.route": "/" }),
              },
            ],
          },
        },
        {
          name: "http.server.duration",
          unit: "ms",
          histogram: {
            aggregationTemporality: 1,
            dataPoints: [
              {
                startTimeUnixNano: start,
                timeUnixNano: time,
                count: "6",
                sum: 75.5,
                min: 1,
                max: 40,
                explicitBounds: [10, 20],
                bucketCounts: ["3", "2", "1"],
              },
            ],
          },
        },
      ]),
      context,
    );
    expect(result).toMatchObject({ records: 3, refused: 0, message: "" });
    expect(result.points).toEqual([
      expect.objectContaining({
        name: "process.memory.usage",
        unit: "By",
        kind: "gauge",
        temporality: 0,
        monotonic: false,
        value: 1024.5,
        start_timestamp: "1970-01-01 00:00:00.000000000",
        timestamp: "2026-11-18 11:59:59.000000000",
        service: "api",
        scope_name: "meter",
      }),
      expect.objectContaining({
        name: "http.server.requests",
        kind: "sum",
        temporality: 2,
        monotonic: true,
        value: 12,
        start_timestamp: "2026-11-18 11:59:00.000000000",
        attributes: { "http.route": "/" },
      }),
    ]);
    expect(result.histograms).toEqual([
      expect.objectContaining({
        name: "http.server.duration",
        unit: "ms",
        temporality: 1,
        count: "6",
        sum: 75.5,
        min: 1,
        max: 40,
        bounds: [10, 20],
        bucket_counts: ["3", "2", "1"],
      }),
    ]);
  });

  test("refuses exponential histograms and summaries, points without a time or value, and mismatched buckets", () => {
    const result = normalizeMetrics(
      metrics([
        {
          name: "latency",
          exponentialHistogram: { dataPoints: [{ timeUnixNano: time }, { timeUnixNano: time }] },
        },
        { name: "quantiles", summary: { dataPoints: [{ timeUnixNano: time }] } },
        {
          name: "g",
          gauge: {
            dataPoints: [
              { timeUnixNano: "0", asDouble: 1 },
              { timeUnixNano: time },
              { timeUnixNano: time, asDouble: "NaN" },
              { timeUnixNano: time, asDouble: 1, flags: 1 },
              { timeUnixNano: time, asDouble: 2 },
            ],
          },
        },
        {
          name: "h",
          histogram: {
            dataPoints: [{ timeUnixNano: time, explicitBounds: [1], bucketCounts: ["1"] }],
          },
        },
      ]),
      context,
    );
    expect(result.points).toHaveLength(1);
    expect(result.histograms).toHaveLength(0);
    expect(result).toMatchObject({ records: 9, refused: 8 });
    expect(result.message).toBe(
      "8 of 9 data points refused: exponential histograms and summaries are not supported yet; data points without a time; data points without a value; values that are not finite numbers; histograms whose bucket counts do not match their bounds.",
    );
  });

  test("a bucket count beyond an unsigned 64-bit integer is malformed", () => {
    const request = metrics([
      {
        name: "h",
        histogram: {
          dataPoints: [
            {
              timeUnixNano: String(NOW - SECOND),
              explicitBounds: [],
              bucketCounts: ["99999999999999999999"],
            },
          ],
        },
      },
    ]);
    expect(() => normalizeMetrics(request, context)).toThrow(MalformedError);
  });

  test(`a histogram with more than ${MAX_HISTOGRAM_BOUNDS} bounds is refused, and counted`, () => {
    const result = normalizeMetrics(
      metrics([
        {
          name: "h",
          histogram: {
            dataPoints: [boundsPoint(MAX_HISTOGRAM_BOUNDS), boundsPoint(MAX_HISTOGRAM_BOUNDS + 1)],
          },
        },
      ]),
      context,
    );
    expect(result.histograms.map((row) => row.bounds.length)).toEqual([MAX_HISTOGRAM_BOUNDS]);
    expect(result.refused).toBe(1);
    expect(result.message).toContain(`more than ${MAX_HISTOGRAM_BOUNDS} bucket bounds`);
  });

  test("a histogram's lists are measured before any element is converted", () => {
    const result = normalizeMetrics(
      metrics([
        {
          name: "h",
          histogram: {
            dataPoints: [
              {
                timeUnixNano: String(NOW - SECOND),
                explicitBounds: junk(MAX_HISTOGRAM_BOUNDS + 1),
                bucketCounts: junk(MAX_HISTOGRAM_BOUNDS + 2),
              },
              {
                timeUnixNano: String(NOW - SECOND),
                explicitBounds: junk(2),
                bucketCounts: junk(2),
              },
            ],
          },
        },
      ]),
      context,
    );
    expect(result.refused).toBe(2);
    expect(result.message).toContain(`more than ${MAX_HISTOGRAM_BOUNDS} bucket bounds`);
    expect(result.message).toContain("bucket counts do not match their bounds");
  });

  test("a histogram count of 2^63 or more is refused, so a chart never sees it wrap", () => {
    const result = normalizeMetrics(
      metrics([
        {
          name: "h",
          histogram: {
            dataPoints: [
              countPoint("9223372036854775807", "9223372036854775807"),
              countPoint("9223372036854775808", "1"),
              countPoint("1", "9223372036854775808"),
            ],
          },
        },
      ]),
      context,
    );
    expect(result.histograms).toHaveLength(1);
    expect(result.refused).toBe(2);
    expect(result.message).toContain("a count of 2^63 or more");
  });

  test("the same point gives the same ID; another value, another", () => {
    const one = metrics([
      { name: "g", gauge: { dataPoints: [{ timeUnixNano: time, asDouble: 1 }] } },
    ]);
    const two = metrics([
      { name: "g", gauge: { dataPoints: [{ timeUnixNano: time, asDouble: 2 }] } },
    ]);
    const [a] = normalizeMetrics(one, context).points;
    const [b] = normalizeMetrics(one, context).points;
    const [c] = normalizeMetrics(two, context).points;
    expect(a?.id).toBe(b?.id);
    expect(a?.id).not.toBe(c?.id);
  });
});

/** Objects in a decoded request: one per message, as the counters count them. */
/** A list of `length` values no number can be read from. */
function junk(length: number): string[] {
  return Array.from({ length }, () => "not a number");
}

function objectsIn(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + objectsIn(item), 0);
  if (typeof value !== "object" || value === null || value instanceof Uint8Array) return 0;
  return 1 + Object.values(value).reduce((sum: number, item) => sum + objectsIn(item), 0);
}

describe("counting messages before decoding", () => {
  const traceRequest = {
    resourceSpans: [
      {
        resource: { attributes: keyValues({ "service.name": "shop", port: 8080 }) },
        scopeSpans: [
          {
            scope: { name: "http", attributes: keyValues({ lib: "x" }) },
            spans: [
              {
                ...span(),
                traceId: Buffer.from(TRACE_ID, "hex"),
                spanId: Buffer.from(SPAN_ID, "hex"),
                attributes: [
                  ...keyValues({ route: "/a", ok: true }),
                  {
                    key: "nested",
                    value: {
                      kvlistValue: {
                        values: [
                          { key: "list", value: { arrayValue: { values: [{ intValue: 1 }] } } },
                        ],
                      },
                    },
                  },
                ],
                events: [{ name: "exception", attributes: keyValues({ "exception.type": "E" }) }],
                links: [
                  { traceId: Buffer.from(TRACE_ID, "hex"), spanId: Buffer.from(SPAN_ID, "hex") },
                ],
                status: { code: 2 },
              },
            ],
          },
        ],
      },
    ],
  };

  test("protobuf: as many as decoding makes", () => {
    for (const [messages, request] of [
      [TRACE_MESSAGES, traceRequest],
      [
        LOGS_MESSAGES,
        logs([{ timeUnixNano: "1", body: { stringValue: "x" }, attributes: keyValues({ a: 1 }) }]),
      ],
      [
        METRICS_MESSAGES,
        metrics([{ name: "g", gauge: { dataPoints: [{ timeUnixNano: "1", asDouble: 1 }] } }]),
      ],
    ] as const) {
      const body = encodeProtobuf(messages, request);
      expect(countProtobufMessages(messages.request, body)).toBe(
        objectsIn(decodeRequest(messages, body, "protobuf")),
      );
    }
  });

  test(`protobuf: a 64-bit integer in a list counts a message, a double 1/${ELEMENTS_PER_MESSAGE}, packed or not`, () => {
    const bounds = Array.from({ length: 100 }, (_, index) => index + 0.5);
    const counts = Array.from({ length: 101 }, (_, index) => String(index * 300));
    const request = metrics([
      {
        name: "h",
        histogram: {
          dataPoints: [{ timeUnixNano: "1", explicitBounds: bounds, bucketCounts: counts }],
        },
      },
    ]);
    const packed = encodeProtobuf(METRICS_MESSAGES, request);
    const objects = objectsIn(decodeRequest(METRICS_MESSAGES, packed, "protobuf"));
    expect(countProtobufMessages(METRICS_MESSAGES.request, packed)).toBe(
      objects + Math.ceil(100 / ELEMENTS_PER_MESSAGE) + 101,
    );
    // A point with its counts sent unpacked: field 6, fixed64, a tag each.
    const histogramPoint = METRICS_MESSAGES.request.lookupType(
      "opentelemetry.proto.metrics.v1.HistogramDataPoint",
    );
    const raw = protobuf.Writer.create()
      .uint32((3 << 3) | 1)
      .fixed64(1);
    for (const count of counts) raw.uint32((6 << 3) | 1).fixed64(Number(count));
    expect(countProtobufMessages(histogramPoint, raw.finish())).toBe(1 + 101);
  });

  test("protobuf: past the limit, or not protobuf", () => {
    const body = encodeProtobuf(TRACE_MESSAGES, traceRequest);
    const total = countProtobufMessages(TRACE_MESSAGES.request, body);
    expect(countProtobufMessages(TRACE_MESSAGES.request, body, total)).toBe(total);
    expect(() => countProtobufMessages(TRACE_MESSAGES.request, body, total - 1)).toThrow(
      TooManyMessagesError,
    );
    for (const bytes of [
      [0x0a, 0x05, 0x00], // a length past the end
      [0x0b], // a group
      [0x08, 0x80], // a varint cut short
      [0x09, 0x00], // a fixed64 cut short
    ]) {
      expect(() => countProtobufMessages(TRACE_MESSAGES.request, Uint8Array.from(bytes))).toThrow(
        MalformedError,
      );
    }
  });

  test("JSON: objects and arrays outside strings", () => {
    const text = JSON.stringify({ a: [{ b: '{[\\"[{' }, []], c: "}" });
    expect(countJsonContainers(Buffer.from(text))).toBe(4);
    expect(() => countJsonContainers(Buffer.from(text), 3)).toThrow(TooManyMessagesError);
  });

  test("JSON: each other value in an array counts too", () => {
    const text = '{"a": [1, "x,]", true , null, [2.5e3]], "b": {"c": 7}, "d": []}';
    // 5 objects and arrays, and 5 array elements that are neither, at a quarter each.
    expect(countJsonContainers(Buffer.from(text))).toBe(5 + Math.ceil(5 / ELEMENTS_PER_MESSAGE));
    const bounds = JSON.stringify({ explicitBounds: Array.from({ length: 1000 }, () => 1) });
    expect(countJsonContainers(Buffer.from(bounds), 252)).toBe(252);
    expect(() => countJsonContainers(Buffer.from(bounds), 251)).toThrow(TooManyMessagesError);
  });

  test("a Collector's batch of 8,192 histogram points with 64 bounds fits, in both encodings", () => {
    const explicitBounds = Array.from({ length: 64 }, (_, index) => 2 ** index);
    const bucketCounts = Array.from({ length: 65 }, (_, index) => String(index));
    const request = metrics([
      {
        name: "http.server.duration",
        histogram: {
          aggregationTemporality: 2,
          dataPoints: Array.from({ length: 8192 }, (_, index) => ({
            timeUnixNano: String(NOW - SECOND),
            count: "2080",
            explicitBounds,
            bucketCounts,
            attributes: keyValues({ "http.route": `/r/${index}`, "http.method": "GET" }),
          })),
        },
      },
    ]);
    for (const [body, encoding] of [
      [encodeProtobuf(METRICS_MESSAGES, request), "protobuf"],
      [Buffer.from(JSON.stringify(request)), "json"],
    ] as const) {
      expect(countMessages(METRICS_MESSAGES, body, encoding)).toBeLessThan(MAX_MESSAGES);
    }
    const { histograms, refused } = normalizeMetrics(request, context);
    expect([histograms.length, refused]).toEqual([8192, 0]);
  });

  test("an exponential histogram is decoded as its bytes: counted as one, its points counted from them", () => {
    const zeros = Array.from({ length: 3_990_000 }, () => 0);
    const time = String(NOW - SECOND);
    const request = metrics([
      {
        name: "e",
        exponentialHistogram: {
          dataPoints: [
            { timeUnixNano: time, positive: { bucketCounts: zeros } },
            { timeUnixNano: time },
            { timeUnixNano: time },
          ],
        },
      },
    ]);
    const body = encodeProtobuf(METRICS_MESSAGES, request);
    expect(countMessages(METRICS_MESSAGES, body, "protobuf")).toBeLessThan(10);
    const decoded = decodeRequest(METRICS_MESSAGES, body, "protobuf");
    const result = normalizeMetrics(decoded, context);
    expect([result.records, result.refused]).toEqual([3, 3]);
    // The full definitions still count every bucket.
    expect(() => countProtobufMessages(METRICS_MESSAGES.request, body)).toThrow(
      TooManyMessagesError,
    );
  });

  test("a 4 MB body of one-byte 64-bit counts is refused, and 16 MiB of JSON numbers", () => {
    const buckets = METRICS_MESSAGES.request.lookupType(
      "opentelemetry.proto.metrics.v1.ExponentialHistogramDataPoint.Buckets",
    );
    // Field 2, packed uint64 varints: every zero byte is a count, decoded
    // to a BigInt. 3.99 million: about 400 MB of heap.
    const zeros = new Uint8Array(3_990_000);
    const packed = protobuf.Writer.create()
      .uint32((2 << 3) | 2)
      .bytes(zeros)
      .finish();
    expect(() => countProtobufMessages(buckets, packed)).toThrow(TooManyMessagesError);
    const json = Buffer.from(`{"bucketCounts":[${"0,".repeat(8 * 1024 * 1024 - 16)}0]}`);
    expect(() => countJsonContainers(json)).toThrow(TooManyMessagesError);
  });
});

const UPSTREAM_SHA256: Record<string, string> = {
  "common.proto": "0429795169e29089cc53490b541a0ae89fa7c80492ac58ed2b3c4171cce4ecee",
  "resource.proto": "34fe1c26b8959f09d97656348ae03b105d15a5f07ada0f8f1614ef5dff7d1569",
  "trace.proto": "45a33961142210add67d583cc525702fb985afdbae181e6daf2143929bad0613",
  "logs.proto": "0c9d0c45eea723d38ef28ee13135ff61c037387f41cacc476ccac3485d6c138a",
  "metrics.proto": "9663b2670f980041e73a71a7c09fdf4fe0bc64056be762f2fcbd2642c4d112a3",
  "trace_service.proto": "03c8cc4e3e101087d884392d6eda32152ad5cd696e6344f50deaa59804a75c7a",
  "logs_service.proto": "0252687fc8f59d139ced709d383e83678e9bd4957bdbe76077242f1c32363fa5",
  "metrics_service.proto": "2bb3c6adee5f7609c8a32c5e4b1ec57057320015e298e9cf136699a42abc24d7",
};
