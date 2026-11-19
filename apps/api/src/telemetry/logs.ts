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
 * The dashboard's log search (docs/telemetry.md, "The dashboard"): a
 * project's log records, newest first, by period, environment, service,
 * severity, words in the body, and trace. Every query filters by project
 * first, then time; the words use the text index on `body`, a trace the
 * bloom filter on `trace_id` (clickhouse/migrations.ts).
 */

/** Records a page of the search holds. */
export const LOGS_PAGE_SIZE = 50;
/** Records a trace's page reads. */
export const MAX_TRACE_LOGS = 500;

/**
 * The lowest severity number of each OpenTelemetry severity range (TRACE
 * 1 to 4, DEBUG 5 to 8, …, FATAL 21 to 24). A minimum leaves out records
 * that name no severity (0).
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
 * Characters of a body a list shows. A body may hold 64 KB, and a record
 * 128 attributes of 4 KB: lists send a summary with the body cut to this,
 * and a record's whole content comes when it is opened (logDetail).
 */
export const SUMMARY_BODY_CHARS = 1000;

/** Words a search may hold, and how long it may be. */
export const MAX_SEARCH_WORDS = 8;
export const MAX_SEARCH_LENGTH = 200;

/**
 * The words of a search as the text index cuts a body into them
 * (tokenizer splitByNonAlpha): runs of ASCII letters and digits, and of
 * any characters beyond ASCII; every other ASCII character separates. So
 * a word never holds LIKE's special characters (%, _, and backslash).
 */
export function searchWords(search: string): string[] {
  const words = search.split(/[^A-Za-z0-9\u{80}-\u{10FFFF}]+/u);
  return [...new Set(words.filter((word) => word !== ""))];
}

export interface LogFilters {
  service?: string | undefined;
  severity?: Severity | undefined;
  /** Words the body holds, all of them. */
  search?: string | undefined;
  traceId?: string | undefined;
  before?: Cursor | undefined;
}

/** A record as lists show it: what a row needs, and the start of its body. */
export interface LogSummary {
  id: string;
  time: Date;
  /** Its time in nanoseconds since 1970, as text: what finds its detail. */
  timeNs: string;
  /** 0 when the sender named none; 1 to 24 as OpenTelemetry numbers them. */
  severityNumber: number;
  severityText: string;
  /** The first SUMMARY_BODY_CHARS characters. */
  body: string;
  /** The body is longer than `body`. */
  bodyTruncated: boolean;
  /** null without one. */
  traceId: string | null;
  spanId: string | null;
  eventName: string;
  service: string;
  environment: string;
}

/** A whole record, when one is opened. */
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

// The body is cut by ClickHouse, so the API never holds a whole one for a
// list. Not "AS body": the alias would stand for the column in lengthUTF8.
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
 * The conditions the search, its chart, and the live view share: the
 * project first, then the time (a range of when records happened, or none
 * for the live view, which adds its own), then the environment and
 * filters.
 */
function filterConditions(
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
  // Each word, in any case, anywhere in the body: ClickHouse 26.8 reads the
  // text index for ILIKE '%word%' (docs/telemetry.md, "How the pages read").
  for (const word of searchWords(filters.search ?? "")) {
    conditions.push(`body ILIKE ${params.add(`%${word}%`, "String")}`);
  }
  return conditions;
}

/**
 * Log records in the range, newest first, LOGS_PAGE_SIZE at a time, with
 * the cursor to the next page when there may be more. Read without FINAL,
 * in key order, so a page reads only as far back as it needs; copies of a
 * retried record are dropped (dashboard-query.ts, newestPage).
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
  /** Whether the project has sent any log record at all: false shows how to send them. */
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

/** A trace's log records within `window`, oldest first: the first MAX_TRACE_LOGS, as summaries. */
export async function logsOfTrace(
  reader: Reader,
  projectId: string,
  traceId: string,
  window: { from: Date; to: Date },
): Promise<{ logs: LogSummary[]; logsTruncated: boolean }> {
  const params = new QueryParams();
  // FINAL: a trace's records are few, found by the bloom filter on trace_id.
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

/**
 * One whole record, found by its row's key: the project, its time (from
 * the list), and its ID. null when no such record is kept.
 */
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

/** A record's severity range, or "none" when the sender named none (0). */
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

/** The Logs page's chart: records per time bucket and severity range. */
export interface LogVolume {
  /** The first bucket's start. */
  start: Date;
  /** Each bucket's start, on the clock of the instance's timezone (listChartBuckets). */
  bucketStarts: Date[];
  stepSeconds: number;
  buckets: number;
  /** Per severity range, a count per bucket. */
  counts: Record<SeverityLevel, number[]>;
  /** Every record counted, all buckets and ranges together. */
  total: number;
}

/**
 * The records the search would find in the range, counted per time bucket
 * (listChartBuckets) and severity range, in one read: the project first,
 * then the range, then the search's own filters. Read without FINAL, as
 * the Traces chart and the Services page are (docs/telemetry.md, "How the
 * pages read"): a count reads every row of the range, the read FINAL was
 * measured to fail on for spans, so a retried record counts twice until
 * its day is merged, which the logs table forces within about an hour of
 * the day's last insert.
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

/** Records one poll of the live view sends at most: past it, the poll skips ahead to the newest. */
export const LIVE_PAGE_SIZE = 200;
/** How far back the live view looks for arrivals: a cursor older than this is a gap. */
export const LIVE_WINDOW_MS = 5 * 60_000;
/**
 * How long after its arrival a record is first sent to the live view. A
 * record's arrival is ClickHouse's clock as it writes the batch, and the
 * batch shows once its part is committed, a moment later: reading only up
 * to this long ago leaves the commit time to finish first.
 */
export const LIVE_SETTLE_MS = 2000;
/**
 * How far before its cursor each poll reads again: a part that became
 * visible later than LIVE_SETTLE_MS after its rows' arrival (a slow
 * commit, an index being built) is still found, and the page drops the
 * records it already holds, by ID.
 */
export const LIVE_REREAD_MS = 10_000;

/** One poll of the live view. */
export interface LiveLogs {
  /** Newest arrival first; one copy of each record ID. */
  logs: LogSummary[];
  /**
   * Where the next poll starts, in nanoseconds since 1970: the arrival
   * this poll read up to (LIVE_SETTLE_MS before ClickHouse's now).
   */
  cursor: string;
  /** Records that arrived after the cursor but were not sent: more than a page came at once. */
  skipped: number;
  /**
   * The cursor was older than LIVE_WINDOW_MS: what arrived from `from` to
   * `to` is not read, and the poll started again at the window's start.
   */
  gap: { from: Date; to: Date } | null;
}

/**
 * The live view's poll: records of the environment and filters that
 * arrived after `after` (an arrival, in nanoseconds since 1970), less
 * LIVE_REREAD_MS, up to LIVE_SETTLE_MS before ClickHouse's now, the newest
 * LIVE_PAGE_SIZE first. When more than a page arrived after the cursor,
 * the older ones are skipped and counted: the page shows the newest, not a
 * backlog it would take many polls to read. A cursor older than
 * LIVE_WINDOW_MS is a gap: the poll reads from the window's start and says
 * what it left out. Without a cursor, it starts at the window's start. The
 * project first, then the arrival, which the minmax index on received_at
 * reads; records are kept for `retentionDays` by when they happened, which
 * bounds the time too. Two reads: ClickHouse's clock, then the records
 * with a count of those after the cursor. Read without FINAL: a retry is
 * written again with a later arrival, which FINAL could not join anyway,
 * so a poll drops a second row with an ID, and the page an ID it holds.
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
  // Read from: the cursor, or the window's start when there is none or it is too old.
  const since = after === undefined || gap !== null ? windowStart : after;
  const reread = since - BigInt(LIVE_REREAD_MS) * ms;
  // The re-read reaches no further back than the window's start.
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
  // Skipped: the records that arrived after the cursor, less those this poll sent.
  const arrived = Number(rows[0]?.after_cursor ?? 0);
  // Records, not rows: a retried record's copies count once, as the count above does.
  const sentNew = new Set(
    rows.filter((row) => BigInt(row.received_ns) > since).map((row) => row.id),
  ).size;
  const oldest = rows.at(-1);
  return {
    logs: unique.map(summaryOf),
    cursor: upper > since ? upper.toString() : since.toString(),
    // A fresh start shows the newest page of the window; nothing is missed but what came before.
    skipped: after === undefined || gap !== null ? 0 : Math.max(0, arrived - sentNew),
    // After a gap, a window fuller than a page leaves out its older part too.
    gap:
      gap === null
        ? null
        : {
            from: gap.from,
            to: arrived > sentNew && oldest !== undefined ? dateOfNs(oldest.received_ns) : gap.to,
          },
  };
}
