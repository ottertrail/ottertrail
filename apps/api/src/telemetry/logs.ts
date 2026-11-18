import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import {
  belowCursor,
  type Cursor,
  DASHBOARD_SETTINGS,
  dateOfNs,
  fetchFor,
  hasAnyRow,
  labelsInRange,
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
  const conditions = [
    `project_id = ${params.add(range.projectId, "UUID")}`,
    `timestamp >= ${params.time(range.from)} AND timestamp < ${params.time(range.to)}`,
    `environment = ${params.add(range.environment, "String")}`,
  ];
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
