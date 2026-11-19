import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import {
  belowCursor,
  type Cursor,
  DASHBOARD_SETTINGS,
  dateOfNs,
  fetchFor,
  hasAnyRow,
  labelsInRange,
  listChartBuckets,
  microseconds,
  newestPage,
  type TelemetryRange,
} from "./dashboard-query.ts";
import { type LogSummary, logsOfTrace } from "./logs.ts";

/**
 * The dashboard's traces (docs/telemetry.md, "The dashboard"): a project's
 * traces by their root spans, a trace's spans and logs, and one span's
 * detail. Every query filters by project first, then time, so it reads one
 * project's days; a trace's spans are found by the bloom filter on trace_id.
 */

/** Root spans a page of the list holds. */
export const TRACES_PAGE_SIZE = 100;
/** Spans a trace's page reads; past this, it says how many more there are. */
export const MAX_TRACE_SPANS = 2000;
/** A trace is looked for this far either side of a known time, such as an error's. */
const AROUND_MS = 24 * 3_600_000;
/**
 * Failed spans are looked for this far either side of the range, both for
 * "with errors" and for each row's Error badge, so the two agree: spans of
 * a trace may start before its root (clocks differ) or after it ends
 * (work it queued).
 */
const TRACE_SLACK_MS = 3_600_000;
/**
 * "With errors" keeps the traces of at most this many failed spans, the
 * latest in the range: the set ClickHouse builds for it stays bounded.
 */
export const MAX_FAILED_SPANS = 10_000;
/** A span's time may be up to an hour ahead (normalize.ts), so a trace's window reaches that far. */
const AHEAD_MS = 3_600_000;

export type SpanKind = "unspecified" | "internal" | "server" | "client" | "producer" | "consumer";
export type SpanStatus = "unset" | "ok" | "error";

export interface TraceFilters {
  service?: string | undefined;
  /** Part of the root span's name, any case. */
  name?: string | undefined;
  /** Only traces with a span whose status is error. */
  errors: boolean;
  /** The root span at least this long. */
  minDurationMs?: number | undefined;
  before?: Cursor | undefined;
}

export interface TraceSummary {
  traceId: string;
  /** The root span's. */
  spanId: string;
  service: string;
  name: string;
  start: Date;
  durationUs: number;
  /** A span of the trace has status error. */
  error: boolean;
  /** The trace's spans, with its root, in the range and an hour either side. */
  spans: number;
}

interface RootRow {
  trace_id: string;
  span_id: string;
  id: string;
  service: string;
  name: string;
  start_ns: string;
  duration_ns: string;
  status_code: SpanStatus;
}

/**
 * Root spans (no parent) in the range, newest first, a page at a time:
 * TRACES_PAGE_SIZE, and the cursor to the next page when there may be
 * more. Read without FINAL, in key order, so a page reads only as far
 * back as it needs; copies of a retried span are dropped
 * (dashboard-query.ts, newestPage). A trace whose root was not received
 * is not listed; a trace with two roots is listed twice.
 */
export async function listTraces(
  reader: Reader,
  range: TelemetryRange,
  filters: TraceFilters,
): Promise<{
  traces: TraceSummary[];
  next: string | null;
  environments: string[];
  services: string[];
  /** Whether the project has sent any span at all: false shows how to send them. */
  received: boolean;
}> {
  const params = new QueryParams();
  const conditions = rootConditions(params, range, filters);
  const window = failureWindow(range);
  const [rows, labels] = await Promise.all([
    queryRows<RootRow>(
      reader,
      `SELECT trace_id, span_id, id, service, name,
              toString(toUnixTimestamp64Nano(timestamp)) AS start_ns, duration_ns, status_code
       FROM spans
       WHERE ${conditions.join(" AND ")}
         ${belowCursor(params, filters.before)}
       ORDER BY timestamp DESC, id DESC
       LIMIT ${fetchFor(TRACES_PAGE_SIZE)}`,
      params,
      DASHBOARD_SETTINGS,
    ),
    labelsInRange(reader, "spans", range, "AND parent_span_id = ''"),
  ]);
  const { page, next } = newestPage(rows, TRACES_PAGE_SIZE, (row) => row.start_ns);
  const counts = await spanCounts(reader, range.projectId, page, window);
  return {
    traces: page.map((row) => {
      const count = counts.get(row.trace_id);
      return {
        traceId: row.trace_id,
        spanId: row.span_id,
        service: row.service,
        name: row.name,
        start: dateOfNs(row.start_ns),
        durationUs: microseconds(row.duration_ns),
        error: row.status_code === "error" || (count?.errors ?? 0) > 0,
        spans: count?.spans ?? 1,
      };
    }),
    next,
    ...labels,
    received: page.length > 0 || (await hasAnyRow(reader, "spans", range.projectId)),
  };
}

/**
 * The trace IDs with a failed span in the window, the latest
 * MAX_FAILED_SPANS: what "with errors" keeps, and what the chart counts as
 * a trace with errors. Duplicates do not matter to IN, so no FINAL.
 */
function failedTraces(
  params: QueryParams,
  range: TelemetryRange,
  limit = MAX_FAILED_SPANS,
  column = "trace_id",
): string {
  const window = failureWindow(range);
  return `(SELECT ${column} FROM spans
           WHERE project_id = ${params.add(range.projectId, "UUID")}
             AND timestamp >= ${params.time(window.from)}
             AND timestamp < ${params.time(window.to)}
             AND status_code = 'error'
           ORDER BY timestamp DESC
           LIMIT ${limit})`;
}

/** The list's conditions on root spans, which its chart shares: the project first, then the range. */
function rootConditions(
  params: QueryParams,
  range: TelemetryRange,
  filters: Omit<TraceFilters, "before">,
  maxFailedSpans = MAX_FAILED_SPANS,
): string[] {
  const conditions = [
    `project_id = ${params.add(range.projectId, "UUID")}`,
    `timestamp >= ${params.time(range.from)} AND timestamp < ${params.time(range.to)}`,
    `parent_span_id = ''`,
    `environment = ${params.add(range.environment, "String")}`,
  ];
  if (filters.service !== undefined) {
    conditions.push(`service = ${params.add(filters.service, "String")}`);
  }
  if (filters.name !== undefined) {
    conditions.push(`positionCaseInsensitiveUTF8(name, ${params.add(filters.name, "String")}) > 0`);
  }
  if (filters.minDurationMs !== undefined && filters.minDurationMs > 0) {
    conditions.push(
      `duration_ns >= ${params.add((BigInt(filters.minDurationMs) * 1_000_000n).toString(), "UInt64")}`,
    );
  }
  if (filters.errors) {
    conditions.push(`trace_id IN ${failedTraces(params, range, maxFailedSpans)}`);
  }
  return conditions;
}

/** The Traces page's charts: traces per time bucket, those with errors, and the 95th-percentile duration. */
export interface TraceChart {
  /** The first bucket's start. */
  start: Date;
  /** Each bucket's start, on the clock of the instance's timezone (listChartBuckets). */
  bucketStarts: Date[];
  stepSeconds: number;
  buckets: number;
  /** Root spans per bucket, as the list counts traces. */
  traces: number[];
  /** Of those, the traces "With errors only" keeps. */
  failed: number[];
  /** The 95th percentile of the roots' durations, in microseconds; null without a trace. */
  p95Us: (number | null)[];
  /** Every trace counted, and those with errors. */
  total: { traces: number; failed: number };
  /**
   * More failed spans than MAX_FAILED_SPANS in the window: errors are
   * counted among the latest of them, so older traces with errors count as
   * without.
   */
  failedCapped: boolean;
}

/**
 * The list's traces over the range, in time buckets (listChartBuckets),
 * in one read of root spans with the list's filters: how many, how many
 * with errors exactly as "With errors only" finds them (a failed span,
 * the root's own included, among the latest MAX_FAILED_SPANS of the
 * window), whether that cap was reached, and the exact 95th percentile of
 * their durations. Read without FINAL, as the Services page and its charts
 * are: this adds up every root span of the period, the read FINAL was
 * measured to fail on, so a retried root counts twice until its day is
 * merged (docs/telemetry.md, "How the pages read").
 */
export async function traceChart(
  reader: Reader,
  range: TelemetryRange,
  filters: Omit<TraceFilters, "before">,
  now: Date,
  { maxFailedSpans = MAX_FAILED_SPANS }: { maxFailedSpans?: number } = {},
): Promise<TraceChart> {
  const buckets = listChartBuckets(range, now);
  const count = buckets.starts.length;
  const blank = <T>(fill: T) => Array.from({ length: count }, () => fill);
  const chart: TraceChart = {
    start: new Date(buckets.starts[0] ?? range.from.getTime()),
    bucketStarts: buckets.starts.map((ms) => new Date(ms)),
    stepSeconds: buckets.stepSeconds,
    buckets: count,
    traces: blank(0),
    failed: blank(0),
    p95Us: blank<number | null>(null),
    total: { traces: 0, failed: 0 },
    failedCapped: false,
  };
  if (count === 0) return chart;
  const params = new QueryParams();
  const conditions = rootConditions(params, range, filters, maxFailedSpans);
  const failed = filters.errors
    ? "count()"
    : `countIf(trace_id IN ${failedTraces(params, range, maxFailedSpans)})`;
  const capped = `(SELECT count() FROM ${failedTraces(params, range, maxFailedSpans + 1, "1")}) > ${maxFailedSpans}`;
  const rows = await queryRows<{
    bucket: string;
    traces: string;
    failed: string;
    p95: number;
    capped: number | boolean;
  }>(
    reader,
    `SELECT ${buckets.bucketSql(params)} AS bucket, count() AS traces, ${failed} AS failed,
            quantileExactInclusive(0.95)(duration_ns) AS p95, any(${capped}) AS capped
     FROM spans
     WHERE ${conditions.join(" AND ")}
     GROUP BY bucket
     ORDER BY bucket
     LIMIT ${count + 2}`,
    params,
    DASHBOARD_SETTINGS,
  );
  for (const row of rows) {
    const index = buckets.index.get(row.bucket);
    if (index === undefined) continue;
    const traces = Number(row.traces);
    const errors = Number(row.failed);
    chart.traces[index] = traces;
    chart.failed[index] = errors;
    chart.p95Us[index] = traces === 0 ? null : row.p95 / 1000;
    chart.total.traces += traces;
    chart.total.failed += errors;
    if (row.capped === true || row.capped === 1) chart.failedCapped = true;
  }
  return chart;
}

/** Where failed spans count: the range, an hour either side. */
function failureWindow(range: TelemetryRange): { from: Date; to: Date } {
  return {
    from: new Date(range.from.getTime() - TRACE_SLACK_MS),
    to: new Date(range.to.getTime() + TRACE_SLACK_MS),
  };
}

/**
 * How many spans each listed trace has, and how many failed, in the same
 * window "with errors" looks in. The bloom filter on trace_id finds them.
 */
async function spanCounts(
  reader: Reader,
  projectId: string,
  roots: RootRow[],
  window: { from: Date; to: Date },
): Promise<Map<string, { spans: number; errors: number }>> {
  if (roots.length === 0) return new Map();
  const params = new QueryParams();
  const rows = await queryRows<{ trace_id: string; spans: string; errors: string }>(
    reader,
    `SELECT trace_id, count() AS spans, countIf(status_code = 'error') AS errors
     FROM spans FINAL
     WHERE project_id = ${params.add(projectId, "UUID")}
       AND timestamp >= ${params.time(window.from)}
       AND timestamp < ${params.time(window.to)}
       AND trace_id IN ${params.add([...new Set(roots.map((row) => row.trace_id))], "Array(String)")}
     GROUP BY trace_id`,
    params,
    DASHBOARD_SETTINGS,
  );
  return new Map(
    rows.map((row) => [row.trace_id, { spans: Number(row.spans), errors: Number(row.errors) }]),
  );
}

/** Where a trace is looked for: around a known time, or all the time telemetry is kept. */
export function traceWindow(
  now: Date,
  retentionDays: number,
  around: Date | undefined,
): { from: Date; to: Date } {
  const kept = new Date(now.getTime() - retentionDays * 86_400_000);
  const latest = new Date(now.getTime() + AHEAD_MS);
  if (around === undefined) return { from: kept, to: latest };
  const from = new Date(Math.max(kept.getTime(), around.getTime() - AROUND_MS));
  const to = new Date(Math.min(latest.getTime(), around.getTime() + AROUND_MS));
  // A time outside what is kept: an empty window, so nothing is read.
  return to < from ? { from, to: from } : { from, to };
}

export interface WaterfallSpan {
  spanId: string;
  /** "" for a root; a parent not among the spans read leaves the span at the top level. */
  parentSpanId: string;
  name: string;
  service: string;
  kind: SpanKind;
  status: SpanStatus;
  /** Its start, in nanoseconds since 1970, as text: what finds its detail. */
  startNs: string;
  /** From the trace's first span's start. */
  offsetUs: number;
  durationUs: number;
}

export interface TraceDetail {
  traceId: string;
  /** The first span's start; null with no span. */
  start: Date | null;
  /** From the first span's start to the last span's end. */
  durationUs: number;
  /** The first MAX_TRACE_SPANS by start. */
  spans: WaterfallSpan[];
  /** The trace's spans in the window, all of them: more than `spans` holds when it was cut. */
  totalSpans: number;
  /** Oldest first, as summaries. */
  logs: LogSummary[];
  /** More log records than `logs` holds. */
  logsTruncated: boolean;
}

/** One trace's spans, as a waterfall, and its log records, within `window`. */
export async function traceDetail(
  reader: Reader,
  projectId: string,
  traceId: string,
  window: { from: Date; to: Date },
): Promise<TraceDetail> {
  const scope = (params: QueryParams) =>
    `project_id = ${params.add(projectId, "UUID")}
     AND timestamp >= ${params.time(window.from)} AND timestamp < ${params.time(window.to)}
     AND trace_id = ${params.add(traceId, "String")}`;
  const params = new QueryParams();
  const [rows, logs] = await Promise.all([
    queryRows<{
      span_id: string;
      parent_span_id: string;
      name: string;
      service: string;
      kind: SpanKind;
      status_code: SpanStatus;
      start_ns: string;
      duration_ns: string;
    }>(
      reader,
      `SELECT span_id, parent_span_id, name, service, kind, status_code,
              toString(toUnixTimestamp64Nano(timestamp)) AS start_ns, duration_ns
       FROM spans FINAL
       WHERE ${scope(params)}
       ORDER BY timestamp, id
       LIMIT ${MAX_TRACE_SPANS + 1}`,
      params,
      DASHBOARD_SETTINGS,
    ),
    logsOfTrace(reader, projectId, traceId, window),
  ]);
  let totalSpans = rows.length;
  if (rows.length > MAX_TRACE_SPANS) {
    const countParams = new QueryParams();
    const [counted] = await queryRows<{ spans: string }>(
      reader,
      `SELECT count() AS spans FROM spans FINAL WHERE ${scope(countParams)}`,
      countParams,
      DASHBOARD_SETTINGS,
    );
    totalSpans = Number(counted?.spans ?? rows.length);
  }
  const spans = rows.slice(0, MAX_TRACE_SPANS);
  const first = spans[0] === undefined ? null : BigInt(spans[0].start_ns);
  let end = first ?? 0n;
  for (const span of spans) {
    const spanEnd = BigInt(span.start_ns) + BigInt(span.duration_ns);
    if (spanEnd > end) end = spanEnd;
  }
  return {
    traceId,
    start: first === null ? null : dateOfNs(first),
    durationUs: first === null ? 0 : microseconds(end - first),
    spans: spans.map((span) => ({
      spanId: span.span_id,
      parentSpanId: span.parent_span_id,
      name: span.name,
      service: span.service,
      kind: span.kind,
      status: span.status_code,
      startNs: span.start_ns,
      offsetUs: microseconds(BigInt(span.start_ns) - (first ?? 0n)),
      durationUs: microseconds(span.duration_ns),
    })),
    totalSpans,
    ...logs,
  };
}

export interface SpanEvent {
  name: string;
  /** null when the sender gave no time. */
  time: Date | null;
  /** From the span's start; null without a time. */
  offsetUs: number | null;
  attributes: Record<string, string>;
}

export interface SpanLink {
  traceId: string;
  spanId: string;
  attributes: Record<string, string>;
}

export interface SpanDetail {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: SpanKind;
  status: SpanStatus;
  statusMessage: string;
  service: string;
  release: string;
  environment: string;
  start: Date;
  durationUs: number;
  attributes: Record<string, string>;
  resourceAttributes: Record<string, string>;
  /** Attributes, events, and links the sender or Ottertrail dropped (docs/telemetry.md, "Limits"). */
  droppedAttributes: number;
  events: SpanEvent[];
  droppedEvents: number;
  links: SpanLink[];
  droppedLinks: number;
  scope: { name: string; version: string };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRecordOfText = (value: unknown): value is Record<string, string> =>
  isObject(value) && Object.values(value).every((item) => typeof item === "string");

/** A span's events, from the JSON its row keeps (normalize.ts); nothing that is not as written there. */
function eventsOf(json: string, startNs: bigint): SpanEvent[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item: unknown) => {
    if (!isObject(item)) return [];
    const { time, name, attributes } = item;
    if (typeof time !== "string" || !/^[0-9]+$/.test(time) || typeof name !== "string") return [];
    const ns = BigInt(time);
    return [
      {
        name,
        time: ns === 0n ? null : dateOfNs(ns),
        offsetUs: ns === 0n ? null : microseconds(ns - startNs),
        attributes: isRecordOfText(attributes) ? attributes : {},
      },
    ];
  });
}

function linksOf(json: string): SpanLink[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item: unknown) => {
    if (!isObject(item)) return [];
    const { traceId, spanId, attributes } = item;
    if (typeof traceId !== "string" || typeof spanId !== "string") return [];
    return [{ traceId, spanId, attributes: isRecordOfText(attributes) ? attributes : {} }];
  });
}

/**
 * One span, found by its row's key: the project, its start (from the
 * trace's waterfall), and its ID. null when no such span is kept.
 */
export async function spanDetail(
  reader: Reader,
  projectId: string,
  traceId: string,
  spanId: string,
  startNs: bigint,
): Promise<SpanDetail | null> {
  const params = new QueryParams();
  const [row] = await queryRows<{
    parent_span_id: string;
    name: string;
    kind: SpanKind;
    status_code: SpanStatus;
    status_message: string;
    service: string;
    release: string;
    environment: string;
    start_ns: string;
    duration_ns: string;
    attributes: Record<string, string>;
    resource_attributes: Record<string, string>;
    dropped_attributes_count: number;
    events: string;
    dropped_events_count: number;
    links: string;
    dropped_links_count: number;
    scope_name: string;
    scope_version: string;
  }>(
    reader,
    `SELECT parent_span_id, name, kind, status_code, status_message, service, release,
            environment, toString(toUnixTimestamp64Nano(timestamp)) AS start_ns, duration_ns,
            attributes, resource_attributes, dropped_attributes_count, events,
            dropped_events_count, links, dropped_links_count, scope_name, scope_version
     FROM spans FINAL
     WHERE project_id = ${params.add(projectId, "UUID")}
       AND timestamp = fromUnixTimestamp64Nano(${params.add(startNs.toString(), "Int64")}, 'UTC')
       AND id = ${params.add(traceId + spanId, "String")}
     LIMIT 1`,
    params,
    DASHBOARD_SETTINGS,
  );
  if (row === undefined) return null;
  const start = BigInt(row.start_ns);
  return {
    traceId,
    spanId,
    parentSpanId: row.parent_span_id,
    name: row.name,
    kind: row.kind,
    status: row.status_code,
    statusMessage: row.status_message,
    service: row.service,
    release: row.release,
    environment: row.environment,
    start: dateOfNs(start),
    durationUs: microseconds(row.duration_ns),
    attributes: row.attributes,
    resourceAttributes: row.resource_attributes,
    droppedAttributes: row.dropped_attributes_count,
    events: eventsOf(row.events, start),
    droppedEvents: row.dropped_events_count,
    links: linksOf(row.links),
    droppedLinks: row.dropped_links_count,
    scope: { name: row.scope_name, version: row.scope_version },
  };
}
