import { context, SeverityNumber, SpanKind, trace } from "@opentelemetry/api";
import { OTLPLogExporter as JsonLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPLogExporter as ProtoLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter as JsonMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPMetricExporter as ProtoMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter as JsonTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as ProtoTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  type ReadableLogRecord,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";
import { secretKeyOf, storedRows } from "./helpers/telemetry.ts";

/** Use OpenTelemetry's JavaScript exporters to check both encodings over real HTTP. */

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let baseUrl = "";

beforeAll(async () => {
  dashboard = await signedInDashboard();
  baseUrl = await dashboard.app.listen({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await dashboard?.close();
});

const RESOURCE = resourceFromAttributes({
  "service.name": "exporter-test",
  "service.version": "3.0.0",
  "deployment.environment.name": "Staging",
});

/** What an exporter's export() reports: 0 for success, with its error otherwise. */
interface ExportResult {
  code: number;
  error?: Error;
}

function exported(exportWith: (done: (result: ExportResult) => void) => void) {
  return new Promise<ExportResult>((resolve) => {
    exportWith(resolve);
  });
}

async function newProject(name: string) {
  const project = await insertProject(dashboard.db, {
    name,
  });
  return { id: project.id, key: await secretKeyOf(dashboard.db, project.id) };
}

function options(path: string, key: string, compression: "gzip" | "none") {
  return {
    url: `${baseUrl}${path}`,
    headers: { Authorization: `Bearer ${key}` },
    compression: compression as never,
  };
}

/** Spans as the SDK records them: a server span and its child. */
async function recordSpans(): Promise<ReadableSpan[]> {
  const memory = new InMemorySpanExporter();
  const provider = new TracerProvider({
    resource: RESOURCE,
    spanProcessors: [new SimpleSpanProcessor({ exporter: memory })],
  });
  const tracer = provider.getTracer("exporter-test-tracer", "1.2.3");
  const parent = tracer.startSpan("GET /orders", {
    kind: SpanKind.SERVER,
    attributes: { "http.route": "/orders" },
  });
  // A child, given its parent explicitly: no context manager is registered here.
  const child = tracer.startSpan("SELECT orders", {}, trace.setSpan(context.active(), parent));
  child.setAttribute("db.rows", 3);
  child.end();
  parent.addEvent("cache miss", { key: "orders" });
  parent.end();
  await provider.forceFlush();
  const spans = memory.getFinishedSpans();
  await provider.shutdown();
  return spans;
}

async function recordLogs(): Promise<ReadableLogRecord[]> {
  const memory = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    resource: RESOURCE,
    processors: [new SimpleLogRecordProcessor({ exporter: memory })],
  });
  const logger = provider.getLogger("exporter-test-logger");
  logger.emit({
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
    body: "payment failed",
    attributes: { "order.id": 42 },
  });
  logger.emit({ severityNumber: SeverityNumber.INFO, body: { structured: true } });
  await provider.forceFlush();
  const records = memory.getFinishedLogRecords();
  await provider.shutdown();
  return records;
}

async function recordMetrics(): Promise<ResourceMetrics> {
  const memory = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = new MeterProvider({
    resource: RESOURCE,
    readers: [
      new PeriodicExportingMetricReader({ exporter: memory, exportIntervalMillis: 3_600_000 }),
    ],
  });
  const meter = provider.getMeter("exporter-test-meter");
  meter.createCounter("orders.placed").add(5, { channel: "web" });
  meter.createUpDownCounter("jobs.queued").add(-2);
  meter.createGauge("cpu.load").record(0.75);
  const durations = meter.createHistogram("orders.duration", { unit: "ms" });
  for (const value of [3, 12, 40]) durations.record(value);
  await provider.forceFlush();
  const [metrics] = memory.getMetrics();
  await provider.shutdown();
  if (metrics === undefined) throw new Error("the SDK recorded no metrics");
  return metrics;
}

describe.each([
  ["http/protobuf", "none"],
  ["http/protobuf", "gzip"],
  ["http/json", "none"],
  ["http/json", "gzip"],
] as const)("OpenTelemetry's %s exporters, compression %s", (protocol, compression) => {
  const proto = protocol === "http/protobuf";

  test("spans are stored", async () => {
    const project = await newProject(`Spans ${protocol} ${compression}`);
    const spans = await recordSpans();
    const exporter = proto
      ? new ProtoTraceExporter(options("/v1/traces", project.key, compression))
      : new JsonTraceExporter(options("/v1/traces", project.key, compression));
    const result = await exported((done) => exporter.export(spans, done));
    await exporter.shutdown();
    expect(result.error).toBeUndefined();
    expect(result.code).toBe(0);

    const rows = await storedRows(dashboard.reader.client, "spans", project.id);
    expect(rows).toHaveLength(2);
    const parent = rows.find((row) => row.name === "GET /orders");
    const child = rows.find((row) => row.name === "SELECT orders");
    expect(parent).toMatchObject({
      kind: "server",
      service: "exporter-test",
      release: "3.0.0",
      environment: "staging",
      scope_name: "exporter-test-tracer",
      scope_version: "1.2.3",
      attributes: { "http.route": "/orders" },
    });
    expect(JSON.parse(String(parent?.events))).toMatchObject([
      { name: "cache miss", attributes: { key: "orders" } },
    ]);
    expect(child).toMatchObject({
      trace_id: parent?.trace_id,
      parent_span_id: parent?.span_id,
      attributes: { "db.rows": "3" },
    });
    expect(String(parent?.trace_id)).toMatch(/^[0-9a-f]{32}$/);
    expect(String(parent?.trace_id)).toBe(spans[0]?.spanContext().traceId);
  });

  test("log records are stored", async () => {
    const project = await newProject(`Logs ${protocol} ${compression}`);
    const records = await recordLogs();
    const exporter = proto
      ? new ProtoLogExporter(options("/v1/logs", project.key, compression))
      : new JsonLogExporter(options("/v1/logs", project.key, compression));
    const result = await exported((done) => exporter.export(records, done));
    await exporter.shutdown();
    expect(result.error).toBeUndefined();
    expect(result.code).toBe(0);

    const rows = await storedRows(dashboard.reader.client, "logs", project.id);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity_number: 17,
          severity_text: "ERROR",
          body: "payment failed",
          attributes: { "order.id": "42" },
          service: "exporter-test",
          environment: "staging",
          scope_name: "exporter-test-logger",
        }),
        expect.objectContaining({ severity_number: 9, body: '{"structured":true}' }),
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  test("metrics are stored", async () => {
    const project = await newProject(`Metrics ${protocol} ${compression}`);
    const metrics = await recordMetrics();
    const exporter = proto
      ? new ProtoMetricExporter(options("/v1/metrics", project.key, compression))
      : new JsonMetricExporter(options("/v1/metrics", project.key, compression));
    const result = await exported((done) => exporter.export(metrics, done));
    await exporter.shutdown();
    expect(result.error).toBeUndefined();
    expect(result.code).toBe(0);

    const points = await storedRows(dashboard.reader.client, "metric_points", project.id);
    expect(points).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "orders.placed",
          kind: "sum",
          monotonic: true,
          temporality: "cumulative",
          value: 5,
          attributes: { channel: "web" },
          service: "exporter-test",
        }),
        expect.objectContaining({ name: "jobs.queued", kind: "sum", monotonic: false, value: -2 }),
        expect.objectContaining({ name: "cpu.load", kind: "gauge", value: 0.75 }),
      ]),
    );
    expect(points).toHaveLength(3);
    const histograms = await storedRows(dashboard.reader.client, "metric_histograms", project.id);
    expect(histograms).toEqual([
      expect.objectContaining({
        name: "orders.duration",
        unit: "ms",
        temporality: "cumulative",
        count: "3",
        sum: 55,
        min: 3,
        max: 40,
      }),
    ]);
  });
});

test("an exporter with a wrong key is told so and does not retry", async () => {
  const spans = await recordSpans();
  const exporter = new ProtoTraceExporter(options("/v1/traces", `sk_${"0".repeat(32)}`, "none"));
  const result = await exported((done) => exporter.export(spans, done));
  await exporter.shutdown();
  expect(result.code).toBe(1);
  expect(String(result.error?.message)).toMatch(/401|Unauthorized|secret key/);
});
