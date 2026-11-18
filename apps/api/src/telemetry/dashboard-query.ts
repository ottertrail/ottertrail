import type { Kysely } from "kysely";

import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { DEFAULT_ENVIRONMENT, environmentOf } from "../collection/environment.ts";
import type { Database } from "../db/schema.ts";
import { localDays } from "../reports/reports.ts";
import { type RangeQuery, requestDays } from "../reports/routes.ts";
import { dayIn } from "../visitors/visitor-ids.ts";

/**
 * What the dashboard's telemetry pages share: the range they read,
 * the cursor they page back with, and times as ClickHouse gives them
 * (docs/telemetry.md, "The dashboard").
 */

/** Whole days in the instance's timezone, in one environment, cut to what telemetry keeps. */
export interface TelemetryRange {
  projectId: string;
  environment: string;
  timeZone: string;
  /** "YYYY-MM-DD", both included. */
  firstDay: string;
  lastDay: string;
  /** Start of firstDay, before the retention's cut: where a chart's time buckets are counted from. */
  dayStart: Date;
  /** Start of firstDay, or the oldest time telemetry is kept from, whichever is later. */
  from: Date;
  /** End of lastDay. */
  to: Date;
}

/**
 * The days a request asks for, in the instance's timezone, cut to
 * the last `retentionDays` before `now`; or why they are refused.
 */
export async function telemetryRange(
  db: Kysely<Database>,
  query: RangeQuery,
  access: { projectId: string; timeZone: string },
  now: Date,
  retentionDays: number,
): Promise<{ range: TelemetryRange } | { problem: { error: string; message: string } }> {
  const { projectId, timeZone } = access;
  const days = requestDays(query, dayIn(timeZone)(now));
  if ("problem" in days) return days;
  const { from, to } = await localDays(db, days.from, days.to, timeZone);
  const kept = new Date(now.getTime() - retentionDays * 86_400_000);
  const start = from < kept ? kept : from;
  return {
    range: {
      projectId,
      environment: environmentOf(query.environment),
      timeZone,
      firstDay: days.from,
      lastDay: days.to,
      dayStart: from,
      from: start > to ? to : start,
      to,
    },
  };
}

/**
 * Where a page of a newest-first list ends: the last row's time, in
 * nanoseconds since 1970, and its ID. The next page starts below it.
 */
export interface Cursor {
  ns: bigint;
  id: string;
}

/** "1795003200123456789-<hex ID>": a span's ID is 48 hex digits, a log record's 32. */
export const CURSOR_PATTERN = "^[0-9]{1,19}-[0-9a-f]{32,48}$";

export const cursorText = (cursor: Cursor) => `${cursor.ns.toString()}-${cursor.id}`;

/** The largest nanosecond count ClickHouse's Int64 holds. */
export const MAX_NS = 9_223_372_036_854_775_807n;

/** A cursor sent back by the dashboard (CURSOR_PATTERN); null when its time is out of range. */
export function cursorOf(text: string | undefined): Cursor | undefined | null {
  if (text === undefined) return undefined;
  const [ns = "", id = ""] = text.split("-");
  const time = BigInt(ns);
  return time > MAX_NS ? null : { ns: time, id };
}

/** A trace ID as stored: 32 hex digits, lower case. Any case is accepted. */
export const TRACE_ID_PATTERN = "^[0-9a-fA-F]{32}$";
export const SPAN_ID_PATTERN = "^[0-9a-fA-F]{16}$";

/** A service's name as a filter: what the rows can hold, with no control characters. */
export const SERVICE_PATTERN = "^[^\\u0000-\\u001F\\u007F]{1,256}$";

const NANOS_PER_MS = 1_000_000n;

/** A moment in nanoseconds since 1970 (as text, from ClickHouse), as a Date. */
export const dateOfNs = (ns: string | bigint) => new Date(Number(BigInt(ns) / NANOS_PER_MS));

/** Nanoseconds as microseconds, as the dashboard shows durations: µs keep sub-millisecond spans. */
export const microseconds = (ns: string | bigint) => Number(BigInt(ns)) / 1000;

/** The tables the dashboard's telemetry pages read. */
export type TelemetryTable = "spans" | "logs" | "metric_points" | "metric_histograms";

/**
 * Settings of every query the telemetry pages make: a query that runs
 * past 15 seconds or 300 MB ends, and the page says to narrow it; large
 * groupings and sorts spill to disk before that.
 */
export const DASHBOARD_SETTINGS = {
  max_execution_time: 15,
  /** 300 MB a query: past it, the page says to narrow the range, as after a timeout. */
  max_memory_usage: "300000000",
  /**
   * Past 100 MB, a GROUP BY or a sort goes on in parts on disk instead of
   * failing: slower, but a period with a million span names still answers.
   */
  max_bytes_before_external_group_by: "100000000",
  max_bytes_before_external_sort: "100000000",
  /**
   * Read-only, settings still changeable: these queries only read (a
   * grouping or sort spilled to disk is still a read). ClickHouse stops a
   * query whose HTTP connection closes only when it is read-only, and the
   * client sends its queries as POST with readonly 0 unless told; with
   * readonly 2, a query ends when the API closes its request, as when the
   * browser gives up or the reader's signal fires (Reader.signal).
   */
  readonly: "2",
  cancel_http_readonly_queries_on_client_close: 1,
} as const;

/**
 * One page of a newest-first list read without FINAL (traces.ts, logs.ts).
 * FINAL merges every row of the range before the first can be sent, so a
 * page would read the whole range; without it, ClickHouse reads the
 * project's rows in key order, newest first, and stops at the LIMIT. A
 * retry stored twice has the same (timestamp, id), so its copies sit next
 * to each other and are dropped here. The query fetches FETCH(size) rows,
 * more than a page, so a page stays full despite copies.
 */
export const fetchFor = (size: number) => size * 2 + 1;

export function newestPage<Row extends { id: string }>(
  rows: Row[],
  size: number,
  nsOf: (row: Row) => string,
): { page: Row[]; next: string | null } {
  const unique = rows.filter((row, index) => {
    const before = rows[index - 1];
    return before === undefined || before.id !== row.id || nsOf(before) !== nsOf(row);
  });
  const page = unique.slice(0, size);
  const last = page.at(-1);
  // More rows than a page, or a full fetch that copies shrank: there may be older ones.
  const more = unique.length > size || rows.length >= fetchFor(size);
  return {
    page,
    next: more && last !== undefined ? cursorText({ ns: BigInt(nsOf(last)), id: last.id }) : null,
  };
}

/** The rows below the cursor, newest first: a condition on (timestamp, id). */
export function belowCursor(params: QueryParams, cursor: Cursor | undefined): string {
  if (cursor === undefined) return "";
  const time = `fromUnixTimestamp64Nano(${params.add(cursor.ns.toString(), "Int64")}, 'UTC')`;
  // The first part lets the primary key skip newer parts; the tuple breaks ties.
  return `AND timestamp <= ${time} AND (timestamp, id) < (${time}, ${params.add(cursor.id, "String")})`;
}

/**
 * The environments and services one or more tables have in the range,
 * from their rows' labels: environments with the most rows first, then the
 * one shown and production even without, so the page can always switch
 * back; the shown environment's services, most rows first.
 */
export async function labelsInRange(
  reader: Reader,
  tables: TelemetryTable | readonly TelemetryTable[],
  range: TelemetryRange,
  /** A condition on each table's rows, such as only root spans for the traces list. */
  extra = "",
): Promise<{ environments: string[]; services: string[] }> {
  const params = new QueryParams();
  const project = params.add(range.projectId, "UUID");
  const from = params.time(range.from);
  const to = params.time(range.to);
  // Table names are constants, never input.
  const reads = (typeof tables === "string" ? [tables] : tables).map(
    (table) =>
      `SELECT environment, service
       FROM ${table}
       WHERE project_id = ${project} AND timestamp >= ${from} AND timestamp < ${to}
         ${extra}`,
  );
  const rows = await queryRows<{ environment: string; service: string; count: string }>(
    reader,
    `SELECT environment, service, count() AS count
     FROM (${reads.join(" UNION ALL ")})
     GROUP BY environment, service
     ORDER BY count DESC, environment, service
     LIMIT 1000`,
    params,
    DASHBOARD_SETTINGS,
  );
  const environments: string[] = [];
  const services: string[] = [];
  for (const row of rows) {
    if (!environments.includes(row.environment)) environments.push(row.environment);
    if (row.environment === range.environment && row.service !== "") services.push(row.service);
  }
  for (const name of [range.environment, DEFAULT_ENVIRONMENT]) {
    if (!environments.includes(name)) environments.push(name);
  }
  return { environments, services };
}

/** Whether the project has any row in the tables: whether it has sent any at all, within the retention. */
export async function hasAnyRow(
  reader: Reader,
  tables: TelemetryTable | readonly TelemetryTable[],
  projectId: string,
): Promise<boolean> {
  const params = new QueryParams();
  const project = params.add(projectId, "UUID");
  const reads = (typeof tables === "string" ? [tables] : tables).map(
    (table) => `SELECT 1 AS found FROM ${table} WHERE project_id = ${project} LIMIT 1`,
  );
  const rows = await queryRows<{ found: number }>(
    reader,
    `SELECT found FROM (${reads.join(" UNION ALL ")}) LIMIT 1`,
    params,
    DASHBOARD_SETTINGS,
  );
  return rows.length > 0;
}
