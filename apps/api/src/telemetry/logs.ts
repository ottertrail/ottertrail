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
  newestPage,
  type TelemetryRange,
} from "./dashboard-query.ts";

/**
 * Filters by project and time before using the body text index or trace_id bloom filter
 * (clickhouse/migrations.ts; docs/telemetry.md, "The dashboard").
 */

export const LOGS_PAGE_SIZE = 50;
export const MAX_TRACE_LOGS = 500;

/**
 * OpenTelemetry severity minima: TRACE 1, DEBUG 5, through FATAL 21. A minimum excludes
 * unspecified severity (0).
 */
export const SEVERITIES = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
} as const;
export type Severity = keyof typeof SEVERITIES;

/**
 * Lists truncate bodies to avoid sending up to 64 KB plus 128 attributes of 4 KB per row.
 * logDetail returns full content.
 */
export const SUMMARY_BODY_CHARS = 1000;

export const MAX_SEARCH_WORDS = 8;
export const MAX_SEARCH_LENGTH = 200;

/**
 * Matches splitByNonAlpha tokens: ASCII letters/digits and non-ASCII characters. Tokens exclude
 * LIKE metacharacters (%, _, backslash).
 */
export function searchWords(search: string): string[] {
  const words = search.split(/[^A-Za-z0-9\u{80}-\u{10FFFF}]+/u);
  return [...new Set(words.filter((word) => word !== ""))];
}

export interface LogFilters {
  service?: string | undefined;
  severity?: Severity | undefined;
  /** Requires all words. */
  search?: string | undefined;
  traceId?: string | undefined;
  before?: Cursor | undefined;
}

export interface LogSummary {
  id: string;
  time: Date;
  /** Nanoseconds since 1970, used to find record detail. */
  timeNs: string;
  /** OpenTelemetry severity 1 to 24; 0 if unspecified. */
  severityNumber: number;
  severityText: string;
  body: string;
  bodyTruncated: boolean;
  traceId: string | null;
  spanId: string | null;
  eventName: string;
  service: string;
  environment: string;
}

export interface LogRecord extends Omit<LogSummary, "bodyTruncated"> {
  observedTime: Date;
  release: string;
  attributes: Record<string, string>;
  resourceAttributes: Record<string, string>;
  scope: { name: string; version: string };
}

interface SummaryRow {
  id: string;
  time_ns: string;
  severity_number: number;
  severity_text: string;
  body_start: string;
  body_cut: number | boolean;
  trace_id: string;
  span_id: string;
  event_name: string;
  service: string;
  environment: string;
}

// Cut bodies in ClickHouse to bound API memory. An AS body alias would replace the input to
// lengthUTF8 too.
const SUMMARY_COLUMNS = `id, toString(toUnixTimestamp64Nano(timestamp)) AS time_ns,
  severity_number, severity_text, substringUTF8(body, 1, ${SUMMARY_BODY_CHARS}) AS body_start,
  lengthUTF8(body) > ${SUMMARY_BODY_CHARS} AS body_cut, trace_id, span_id, event_name, service,
  environment`;

function summaryOf(row: SummaryRow): LogSummary {
  return {
    id: row.id,
    time: dateOfNs(row.time_ns),
    timeNs: row.time_ns,
    severityNumber: row.severity_number,
    severityText: row.severity_text,
    body: row.body_start,
    bodyTruncated: row.body_cut === true || row.body_cut === 1,
    traceId: row.trace_id === "" ? null : row.trace_id,
    spanId: row.span_id === "" ? null : row.span_id,
    eventName: row.event_name,
    service: row.service,
    environment: row.environment,
  };
}

/**
 * Shared filters for search, chart, live view, and log lines alert rules (alerts/log-rules.ts), so
 * a rule counts the lines the page shows. The live view and the rules supply their own time
 * window after the project condition.
 */
export function filterConditions(
  params: QueryParams,
  scope: { projectId: string; environment: string; from?: Date; to?: Date },
  filters: Omit<LogFilters, "before">,
): string[] {
  const conditions = [`project_id = ${params.add(scope.projectId, "UUID")}`];
  if (scope.from !== undefined && scope.to !== undefined) {
    conditions.push(
      `timestamp >= ${params.time(scope.from)} AND timestamp < ${params.time(scope.to)}`,
    );
  }
  conditions.push(`environment = ${params.add(scope.environment, "String")}`);
  if (filters.service !== undefined) {
    conditions.push(`service = ${params.add(filters.service, "String")}`);
  }
  if (filters.severity !== undefined) {
    conditions.push(`severity_number >= ${params.add(SEVERITIES[filters.severity], "UInt8")}`);
  }
  if (filters.traceId !== undefined) {
    conditions.push(`trace_id = ${params.add(filters.traceId, "String")}`);
  }
  // ClickHouse 26.8 uses the text index for ILIKE '%word%' (docs/telemetry.md, "How the pages
  // read").
  for (const word of searchWords(filters.search ?? "")) {
    conditions.push(`body ILIKE ${params.add(`%${word}%`, "String")}`);
  }
  return conditions;
}

/**
 * Reads in reverse key order without FINAL to stop after a page. newestPage drops retry copies
 * (dashboard-query.ts).
 */
export async function searchLogs(
  reader: Reader,
  range: TelemetryRange,
  filters: LogFilters,
): Promise<{
  logs: LogSummary[];
  next: string | null;
  environments: string[];
  services: string[];
  /** False shows setup instructions. */
  received: boolean;
}> {
  const params = new QueryParams();
  const conditions = filterConditions(params, range, filters);
  const [rows, labels] = await Promise.all([
    queryRows<SummaryRow>(
      reader,
      `SELECT ${SUMMARY_COLUMNS}
       FROM logs
       WHERE ${conditions.join(" AND ")}
         ${belowCursor(params, filters.before)}
       ORDER BY timestamp DESC, id DESC
       LIMIT ${fetchFor(LOGS_PAGE_SIZE)}`,
      params,
      DASHBOARD_SETTINGS,
    ),
    labelsInRange(reader, "logs", range),
  ]);
  const { page, next } = newestPage(rows, LOGS_PAGE_SIZE, (row) => row.time_ns);
  return {
    logs: page.map(summaryOf),
    next,
    ...labels,
    received: page.length > 0 || (await hasAnyRow(reader, "logs", range.projectId)),
  };
}

/** Returns the first MAX_TRACE_LOGS within `window`, oldest first. */
export async function logsOfTrace(
  reader: Reader,
  projectId: string,
  traceId: string,
  window: { from: Date; to: Date },
): Promise<{ logs: LogSummary[]; logsTruncated: boolean }> {
  const params = new QueryParams();
  // FINAL is bounded here: trace_id's bloom filter finds a small set.
  const rows = await queryRows<SummaryRow>(
    reader,
    `SELECT ${SUMMARY_COLUMNS}
     FROM logs FINAL
     WHERE project_id = ${params.add(projectId, "UUID")}
       AND timestamp >= ${params.time(window.from)} AND timestamp < ${params.time(window.to)}
       AND trace_id = ${params.add(traceId, "String")}
     ORDER BY timestamp, id
     LIMIT ${MAX_TRACE_LOGS + 1}`,
    params,
    DASHBOARD_SETTINGS,
  );
  return {
    logs: rows.slice(0, MAX_TRACE_LOGS).map(summaryOf),
    logsTruncated: rows.length > MAX_TRACE_LOGS,
  };
}

/** Looks up (project, time, ID). Returns null when no record is retained. */
export async function logDetail(
  reader: Reader,
  projectId: string,
  id: string,
  timeNs: bigint,
): Promise<LogRecord | null> {
  const params = new QueryParams();
  const [row] = await queryRows<{
    id: string;
    time_ns: string;
    observed_ns: string;
    severity_number: number;
    severity_text: string;
    body: string;
    trace_id: string;
    span_id: string;
    event_name: string;
    service: string;
    release: string;
    environment: string;
    attributes: Record<string, string>;
    resource_attributes: Record<string, string>;
    scope_name: string;
    scope_version: string;
  }>(
    reader,
    `SELECT id, toString(toUnixTimestamp64Nano(timestamp)) AS time_ns,
            toString(toUnixTimestamp64Nano(observed_timestamp)) AS observed_ns,
            severity_number, severity_text, body, trace_id, span_id, event_name, service,
            release, environment, attributes, resource_attributes, scope_name, scope_version
     FROM logs FINAL
     WHERE project_id = ${params.add(projectId, "UUID")}
       AND timestamp = fromUnixTimestamp64Nano(${params.add(timeNs.toString(), "Int64")}, 'UTC')
       AND id = ${params.add(id, "String")}
     LIMIT 1`,
    params,
    DASHBOARD_SETTINGS,
  );
  if (row === undefined) return null;
  return {
    id: row.id,
    time: dateOfNs(row.time_ns),
    timeNs: row.time_ns,
    observedTime: dateOfNs(row.observed_ns),
    severityNumber: row.severity_number,
    severityText: row.severity_text,
    body: row.body,
    traceId: row.trace_id === "" ? null : row.trace_id,
    spanId: row.span_id === "" ? null : row.span_id,
    eventName: row.event_name,
    service: row.service,
    release: row.release,
    environment: row.environment,
    attributes: row.attributes,
    resourceAttributes: row.resource_attributes,
    scope: { name: row.scope_name, version: row.scope_version },
  };
}

/** "none" means unspecified severity (0). */
export const SEVERITY_LEVELS = [
  "none",
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const satisfies readonly ("none" | Severity)[];
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

export interface LogVolume {
  start: Date;
  /** Bucket starts in the instance timezone (listChartBuckets). */
  bucketStarts: Date[];
  stepSeconds: number;
  buckets: number;
  counts: Record<SeverityLevel, number[]>;
  total: number;
}

/**
 * Uses search filters and listChartBuckets. Reads without FINAL to bound memory
 * (docs/telemetry.md, "How the pages read"). Retry copies count until daily merges, forced within
 * about an hour of the day's last insert.
 */
export async function logVolume(
  reader: Reader,
  range: TelemetryRange,
  filters: Omit<LogFilters, "before">,
  now: Date,
): Promise<LogVolume> {
  const buckets = listChartBuckets(range, now);
  const count = buckets.starts.length;
  const blank = () => Array.from({ length: count }, () => 0);
  const counts: Record<SeverityLevel, number[]> = {
    none: blank(),
    trace: blank(),
    debug: blank(),
    info: blank(),
    warn: blank(),
    error: blank(),
    fatal: blank(),
  };
  let total = 0;
  if (count > 0) {
    const params = new QueryParams();
    const conditions = filterConditions(params, range, filters);
    const rows = await queryRows<{
      bucket: string | number;
      level: SeverityLevel;
      records: string;
    }>(
      reader,
      `SELECT ${buckets.bucketSql(params)} AS bucket,
              multiIf(severity_number = 0, 'none', severity_number < 5, 'trace',
                      severity_number < 9, 'debug', severity_number < 13, 'info',
                      severity_number < 17, 'warn', severity_number < 21, 'error', 'fatal') AS level,
              count() AS records
       FROM logs
       WHERE ${conditions.join(" AND ")}
       GROUP BY bucket, level
       ORDER BY bucket, level
       LIMIT ${(count + 2) * SEVERITY_LEVELS.length}`,
      params,
      DASHBOARD_SETTINGS,
    );
    for (const row of rows) {
      const index = Number(row.bucket);
      const line = counts[row.level];
      if (line === undefined || index < 0 || index >= count) continue;
      const records = Number(row.records);
      line[index] = (line[index] ?? 0) + records;
      total += records;
    }
  }
  return {
    start: new Date(buckets.starts[0] ?? range.from.getTime()),
    bucketStarts: buckets.starts.map((ms) => new Date(ms)),
    stepSeconds: buckets.stepSeconds,
    buckets: count,
    counts,
    total,
  };
}

/** When arrivals exceed this cap, polls skip to the newest records. */
export const LIVE_PAGE_SIZE = 200;
/** Older cursors produce a gap. */
export const LIVE_WINDOW_MS = 5 * 60_000;
/** Leaves time for a batch part to commit after ClickHouse assigns its arrival time. */
export const LIVE_SETTLE_MS = 2000;
/** Rereads late commits and index builds beyond LIVE_SETTLE_MS. The page deduplicates by ID. */
export const LIVE_REREAD_MS = 10_000;

export interface LiveLogs {
  /** Newest arrival first, deduplicated by record ID. */
  logs: LogSummary[];
  /** Nanoseconds since 1970, LIVE_SETTLE_MS before ClickHouse's now. */
  cursor: string;
  /** Arrivals after the cursor omitted by the page cap. */
  skipped: number;
  /** Cursor exceeded LIVE_WINDOW_MS; the poll restarted at the window start. */
  gap: { from: Date; to: Date } | null;
}

/**
 * Polls by ClickHouse arrival time, rereading LIVE_REREAD_MS before `after` and stopping
 * LIVE_SETTLE_MS before now. Sends the newest LIVE_PAGE_SIZE records and counts skipped arrivals.
 * Absent or expired cursors restart at LIVE_WINDOW_MS.
 *
 * Reads ClickHouse's clock, then project records via the received_at minmax index, also bounded by
 * occurrence-time retention. FINAL cannot join retries with different arrivals; the poll and page
 * deduplicate by record ID.
 */
export async function liveLogs(
  reader: Reader,
  scope: { projectId: string; environment: string; retentionDays: number },
  filters: Omit<LogFilters, "before">,
  after: bigint | undefined,
  now: Date,
): Promise<LiveLogs> {
  const [clock] = await queryRows<{ now_ns: string }>(
    reader,
    "SELECT toString(toUnixTimestamp64Nano(now64(9))) AS now_ns",
    new QueryParams(),
    DASHBOARD_SETTINGS,
  );
  const serverNow = BigInt(clock?.now_ns ?? `${now.getTime()}000000`);
  const ms = 1_000_000n;
  const upper = serverNow - BigInt(LIVE_SETTLE_MS) * ms;
  const windowStart = serverNow - BigInt(LIVE_WINDOW_MS) * ms;
  const gap =
    after !== undefined && after < windowStart
      ? { from: dateOfNs(after), to: dateOfNs(windowStart) }
      : null;
  const since = after === undefined || gap !== null ? windowStart : after;
  const reread = since - BigInt(LIVE_REREAD_MS) * ms;
  const readFrom =
    after === undefined || gap !== null ? since : reread < windowStart ? windowStart : reread;

  const params = new QueryParams();
  const conditions = filterConditions(params, scope, filters);
  const kept = new Date(now.getTime() - scope.retentionDays * 86_400_000);
  const nanos = (value: bigint) =>
    `fromUnixTimestamp64Nano(${params.add(value.toString(), "Int64")}, 'UTC')`;
  const upperSql = nanos(upper);
  const sinceSql = nanos(since);
  conditions.splice(
    1,
    0,
    `received_at > ${nanos(readFrom)}`,
    `received_at <= ${upperSql}`,
    `timestamp >= ${params.time(kept)}`,
  );
  const where = conditions.join(" AND ");
  const rows = await queryRows<SummaryRow & { received_ns: string; after_cursor: string }>(
    reader,
    `SELECT ${SUMMARY_COLUMNS}, toString(toUnixTimestamp64Nano(received_at)) AS received_ns,
            (SELECT uniqExact(id) FROM logs WHERE ${where} AND received_at > ${sinceSql}) AS after_cursor
     FROM logs
     WHERE ${where}
     ORDER BY received_at DESC, id DESC
     LIMIT ${LIVE_PAGE_SIZE}`,
    params,
    DASHBOARD_SETTINGS,
  );
  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
  const arrived = Number(rows[0]?.after_cursor ?? 0);
  // Count unique record IDs, matching the arrival count above.
  const sentNew = new Set(
    rows.filter((row) => BigInt(row.received_ns) > since).map((row) => row.id),
  ).size;
  const oldest = rows.at(-1);
  return {
    logs: unique.map(summaryOf),
    cursor: upper > since ? upper.toString() : since.toString(),
    // Fresh starts skip only arrivals before the displayed page.
    skipped: after === undefined || gap !== null ? 0 : Math.max(0, arrived - sentNew),
    // A full page after a gap can also omit older records within the window.
    gap:
      gap === null
        ? null
        : {
            from: gap.from,
            to: arrived > sentNew && oldest !== undefined ? dateOfNs(oldest.received_ns) : gap.to,
          },
  };
}
