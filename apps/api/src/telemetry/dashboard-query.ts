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

/** The most buckets a list's chart has (the Logs and Traces pages), so each bar stays a few pixels wide. */
export const LIST_CHART_BUCKETS = 120;

/**
 * Bucket lengths a list's chart takes, in seconds: whole minutes and hours
 * that divide a day, and whole days.
 */
const LIST_CHART_STEPS = [
  60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400, 172_800, 259_200,
  345_600, 604_800,
];

const DAY_SECONDS = 86_400;

const WALL_FORMATS = new Map<string, Intl.DateTimeFormat>();

/** A moment's wall clock in `timeZone`: its day ("YYYY-MM-DD") and minutes since midnight. */
function wallClock(ms: number, timeZone: string): { day: string; minutes: number } {
  let format = WALL_FORMATS.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    WALL_FORMATS.set(timeZone, format);
  }
  const parts = new Map(format.formatToParts(ms).map((part) => [part.type, part.value]));
  return {
    day: `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`,
    minutes: Number(parts.get("hour")) * 60 + Number(parts.get("minute")),
  };
}

/** Milliseconds since 1970 of a day's wall-clock time read as UTC. */
const asUtc = (day: string, minutes: number) => Date.parse(`${day}T00:00:00Z`) + minutes * 60_000;

/** A moment's offset from UTC in `timeZone`, in milliseconds. */
const offsetAt = (ms: number, timeZone: string) => {
  const wall = wallClock(ms, timeZone);
  return asUtc(wall.day, wall.minutes) - (ms - (ms % 60_000));
};

/**
 * The first moment a day's wall-clock time happens in `timeZone`: the
 * earlier of two when the clock repeats it (the hour after a change back);
 * null when the clock skips it (the hour a change forward jumps over).
 */
function zonedTime(day: string, minutes: number, timeZone: string): number | null {
  const wanted = asUtc(day, minutes);
  // The offsets a few hours either side: one change a day at most, so one of them holds.
  const offsets = new Set([
    offsetAt(wanted - 14 * 3_600_000, timeZone),
    offsetAt(wanted + 14 * 3_600_000, timeZone),
  ]);
  const found = [...offsets]
    .map((offset) => wanted - offset)
    .filter((ms) => {
      const wall = wallClock(ms, timeZone);
      return wall.day === day && wall.minutes === minutes;
    });
  return found.length === 0 ? null : Math.min(...found);
}

/**
 * The first moment at or after a day's wall-clock time, within `span`
 * minutes: the time itself, or, when the clock skips it, the moment the
 * clock jumps to. null when the clock skips the whole span.
 */
function firstMoment(day: string, minutes: number, span: number, timeZone: string) {
  for (let minute = minutes; minute < minutes + span && minute < 1440; minute += 1) {
    const moment = zonedTime(day, minute, timeZone);
    if (moment !== null) return moment;
  }
  return null;
}

/** "YYYY-MM-DD" plus `days`. */
export const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * A list's chart's time buckets: their starts, on the clock of the
 * instance's timezone, and how a row finds its bucket.
 */
export interface ListChartBuckets {
  /** The buckets' length on the clock; one across a daylight saving change is shorter or longer. */
  stepSeconds: number;
  /** Each bucket's start, in milliseconds since 1970, rising. */
  starts: number[];
  /**
   * A row's bucket, in SQL: its place in `starts`, the last start at or
   * before its moment, so every row of the range is in exactly one.
   */
  bucketSql: (params: QueryParams) => string;
}

/**
 * The buckets of a list's chart over a range, in the instance's timezone:
 * the shortest step of LIST_CHART_STEPS that keeps them within
 * LIST_CHART_BUCKETS over the span on the local clock: a range of several
 * days its whole span, so its chart keeps one step at every time of day,
 * and one day (today) the part up to now, so its first hours are not a few
 * wide bars. The buckets run up to the end of the range or now, whichever
 * is sooner. A step shorter than a day starts each bucket on the clock's
 * marks (midnight, 06:00, 12:00 for 6 hours) whatever the date's offset; a
 * step of days starts each on a midnight,
 * counted from the range's first day. A mark the clock skips (a change
 * forward, or a midnight some zones skip) starts at the first moment that
 * exists after it, and a slot the clock skips whole has no bucket, so the
 * bucket before it is shorter; a mark the clock repeats (a change back)
 * starts at its first occurrence, so the bucket that holds the repeated
 * time is longer. Rows are placed by their moment, not by their wall
 * clock (bucketSql), so none falls outside a bucket and none counts
 * twice. Today at noon is 72 buckets of 10 minutes; a past day, 96 of 15
 * minutes; 7 days, about 80 of 2 hours; 30 days, 120 of 6 hours; 90 days,
 * 90 of a day; 12 months, about 92 of 4 days. A bucket wholly before the
 * retention's cut is left out.
 */
export function listChartBuckets(
  range: Pick<TelemetryRange, "from" | "to" | "timeZone" | "firstDay" | "lastDay">,
  now: Date,
): ListChartBuckets {
  const fromMs = range.from.getTime();
  const endMs = Math.max(fromMs, Math.min(range.to.getTime(), now.getTime()));
  // The span on the local clock, so a day an hour longer does not change the step.
  const end =
    range.firstDay === range.lastDay
      ? wallClock(endMs, range.timeZone)
      : { day: addDays(range.lastDay, 1), minutes: 0 };
  const spanMs = asUtc(end.day, end.minutes) - asUtc(range.firstDay, 0);
  const step =
    LIST_CHART_STEPS.find(
      (seconds) => Math.ceil(spanMs / (seconds * 1000)) <= LIST_CHART_BUCKETS,
    ) ??
    LIST_CHART_STEPS.at(-1) ??
    604_800;
  const { timeZone } = range;
  const candidates: number[] = [];
  if (step < DAY_SECONDS) {
    const minutes = step / 60;
    for (let day = range.firstDay; day <= range.lastDay; day = addDays(day, 1)) {
      for (let slot = 0; slot * minutes < 1440; slot += 1) {
        const start = firstMoment(day, slot * minutes, minutes, timeZone);
        if (start !== null) candidates.push(start);
      }
    }
  } else {
    const days = step / DAY_SECONDS;
    for (let group = 0; addDays(range.firstDay, group * days) <= range.lastDay; group += 1) {
      // Midnight, or the first moment after it on a day whose clock skips midnight.
      const start = firstMoment(addDays(range.firstDay, group * days), 0, 1440, timeZone);
      if (start !== null) candidates.push(start);
    }
  }
  // Rising, each once: a slot whose start the clock carried into the next slot's is no bucket.
  const rising = candidates.filter((start, at) => at === 0 || start > (candidates[at - 1] ?? 0));
  const starts = rising.filter((start, at) => {
    const next = rising[at + 1] ?? range.to.getTime();
    return start < endMs && next > fromMs;
  });
  const bucketSql = (params: QueryParams) => {
    // A row later than the last bucket (a clock ahead of now) counts in it.
    const moment = `toUnixTimestamp64Milli(least(timestamp,
      fromUnixTimestamp64Milli(${params.add(Math.max(fromMs, endMs - 1), "Int64")}, 'UTC')))`;
    // The last start at or before the row's moment: starts rise, so a count of those.
    return `greatest(0, arrayCount(start -> start <= ${moment}, ${params.add(starts, "Array(Int64)")}) - 1)`;
  };
  return { stepSeconds: step, starts, bucketSql };
}
