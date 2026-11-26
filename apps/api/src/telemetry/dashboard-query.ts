import type { Kysely } from "kysely";

import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { DEFAULT_ENVIRONMENT, environmentOf } from "../collection/environment.ts";
import type { Database } from "../db/schema.ts";
import { localDays } from "../reports/reports.ts";
import { type RangeQuery, requestDays } from "../reports/routes.ts";
import { dayIn } from "../visitors/visitor-ids.ts";

/** Shared telemetry reads (docs/telemetry.md, "The dashboard"). */

/** Whole days in the instance timezone, clipped to retention. */
export interface TelemetryRange {
  projectId: string;
  environment: string;
  timeZone: string;
  /** "YYYY-MM-DD", both included. */
  firstDay: string;
  lastDay: string;
  /** Unclipped day start anchors chart buckets. */
  dayStart: Date;
  /** Clipped to the oldest retained time. */
  from: Date;
  to: Date;
  /** A time window inside the days (`start` and `end`), as an alert's link opens the Logs page. */
  narrowed?: boolean;
}

/** A time window the Logs page may open on: `start` and `end`, instants in UTC. */
export interface TimeWindowQuery {
  start?: string;
  end?: string;
}

/** An ISO 8601 instant in UTC, as `Date.toISOString` writes it, the milliseconds optional. */
export const INSTANT_PATTERN =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$";

/** The longest time window: a day, well past an alert rule's longest window. */
export const MAX_TIME_WINDOW_MS = 86_400_000;

export const TIME_WINDOW_PROPERTIES = {
  start: { type: "string", pattern: INSTANT_PATTERN },
  end: { type: "string", pattern: INSTANT_PATTERN },
} as const;

const windowProblem = (message: string) => ({ problem: { error: "invalid_range", message } });

/** A time window from `start` and `end`, both or neither; or the problem. */
function timeWindowOf(
  query: RangeQuery & TimeWindowQuery,
): { start: Date; end: Date } | { problem: { error: string; message: string } } | null {
  if (query.start === undefined && query.end === undefined) return null;
  if (query.start === undefined || query.end === undefined) {
    return windowProblem("Send both start and end.");
  }
  if (query.period !== undefined || query.from !== undefined || query.to !== undefined) {
    return windowProblem("Send either start and end, or days, not both.");
  }
  const start = new Date(query.start);
  const end = new Date(query.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return windowProblem("start and end must be real times.");
  }
  if (end <= start || end.getTime() - start.getTime() > MAX_TIME_WINDOW_MS) {
    return windowProblem("end must be after start, and at most a day after it.");
  }
  return { start, end };
}

/**
 * Clips requested days to `retentionDays` before `now`, using the instance timezone. A time
 * window (`start` and `end`) takes the days it falls on and narrows them to itself.
 */
export async function telemetryRange(
  db: Kysely<Database>,
  query: RangeQuery & TimeWindowQuery,
  access: { projectId: string; timeZone: string },
  now: Date,
  retentionDays: number,
): Promise<{ range: TelemetryRange } | { problem: { error: string; message: string } }> {
  const { projectId, timeZone } = access;
  const window = timeWindowOf(query);
  if (window !== null) {
    if ("problem" in window) return window;
    const dayOf = dayIn(timeZone);
    const firstDay = dayOf(window.start);
    // `end` is excluded: a window ending at midnight stays on the day before.
    const lastDay = dayOf(new Date(window.end.getTime() - 1));
    const days = await localDays(db, firstDay, lastDay, timeZone);
    const kept = new Date(now.getTime() - retentionDays * 86_400_000);
    const start = window.start < kept ? kept : window.start;
    return {
      range: {
        projectId,
        environment: environmentOf(query.environment),
        timeZone,
        firstDay,
        lastDay,
        dayStart: days.from,
        from: start > window.end ? window.end : start,
        to: window.end,
        narrowed: true,
      },
    };
  }
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

/** Next page starts below this (nanoseconds since 1970, ID) pair. */
export interface Cursor {
  ns: bigint;
  id: string;
}

/** Span IDs have 48 hex digits; log IDs have 32. */
export const CURSOR_PATTERN = "^[0-9]{1,19}-[0-9a-f]{32,48}$";

export const cursorText = (cursor: Cursor) => `${cursor.ns.toString()}-${cursor.id}`;

export const MAX_NS = 9_223_372_036_854_775_807n;

/** Returns null for out-of-range time and undefined for absent input. */
export function cursorOf(text: string | undefined): Cursor | undefined | null {
  if (text === undefined) return undefined;
  const [ns = "", id = ""] = text.split("-");
  const time = BigInt(ns);
  return time > MAX_NS ? null : { ns: time, id };
}

/** Accepts either case; stored IDs are lowercase. */
export const TRACE_ID_PATTERN = "^[0-9a-fA-F]{32}$";
export const SPAN_ID_PATTERN = "^[0-9a-fA-F]{16}$";

export const SERVICE_PATTERN = "^[^\\u0000-\\u001F\\u007F]{1,256}$";

const NANOS_PER_MS = 1_000_000n;

/** Input is nanoseconds since 1970. */
export const dateOfNs = (ns: string | bigint) => new Date(Number(BigInt(ns) / NANOS_PER_MS));

/** Microseconds preserve sub-millisecond durations. */
export const microseconds = (ns: string | bigint) => Number(BigInt(ns)) / 1000;

export type TelemetryTable = "spans" | "logs" | "metric_points" | "metric_histograms";

/** Bounds queries at 15 seconds and 300 MB. Large groupings and sorts spill to disk first. */
export const DASHBOARD_SETTINGS = {
  max_execution_time: 15,
  max_memory_usage: "300000000",
  /** Spills GROUP BY and sorts to disk after 100 MB. */
  max_bytes_before_external_group_by: "100000000",
  max_bytes_before_external_sort: "100000000",
  /**
   * ClickHouse cancels disconnected HTTP queries only in read-only mode. Mode 2 still permits
   * query settings; the client defaults to 0 for POST.
   */
  readonly: "2",
  cancel_http_readonly_queries_on_client_close: 1,
} as const;

/**
 * FINAL would merge the whole range before returning a page. Read in reverse key order with a
 * LIMIT instead, then drop adjacent retry copies with the same (timestamp, id). Overfetch to keep
 * pages full after deduplication.
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
  // A full fetch may hide older rows even if duplicates leave fewer than a page.
  const more = unique.length > size || rows.length >= fetchFor(size);
  return {
    page,
    next: more && last !== undefined ? cursorText({ ns: BigInt(nsOf(last)), id: last.id }) : null,
  };
}

export function belowCursor(params: QueryParams, cursor: Cursor | undefined): string {
  if (cursor === undefined) return "";
  const time = `fromUnixTimestamp64Nano(${params.add(cursor.ns.toString(), "Int64")}, 'UTC')`;
  // The time condition skips newer parts; the tuple breaks ties.
  return `AND timestamp <= ${time} AND (timestamp, id) < (${time}, ${params.add(cursor.id, "String")})`;
}

/**
 * Ranks labels by row count. Includes the selected environment and production even without rows so
 * users can switch back.
 */
export async function labelsInRange(
  reader: Reader,
  tables: TelemetryTable | readonly TelemetryTable[],
  range: TelemetryRange,
  /** Additional row filter, such as root spans only. */
  extra = "",
): Promise<{ environments: string[]; services: string[] }> {
  const params = new QueryParams();
  const project = params.add(range.projectId, "UUID");
  const from = params.time(range.from);
  const to = params.time(range.to);
  // Table names are constants.
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

/** Checks for any data within retention. */
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

/** Keeps list chart bars a few pixels wide. */
export const LIST_CHART_BUCKETS = 120;

/** Seconds; subday steps divide a day. */
const LIST_CHART_STEPS = [
  60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400, 172_800, 259_200,
  345_600, 604_800,
];

const DAY_SECONDS = 86_400;

const WALL_FORMATS = new Map<string, Intl.DateTimeFormat>();

/** Returns local day and minutes since midnight. */
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

const asUtc = (day: string, minutes: number) => Date.parse(`${day}T00:00:00Z`) + minutes * 60_000;

const offsetAt = (ms: number, timeZone: string) => {
  const wall = wallClock(ms, timeZone);
  return asUtc(wall.day, wall.minutes) - (ms - (ms % 60_000));
};

/** Uses the first occurrence of repeated wall time; returns null for skipped time. */
function zonedTime(day: string, minutes: number, timeZone: string): number | null {
  const wanted = asUtc(day, minutes);
  // At most one offset change per day, so offsets a few hours either side cover it.
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
 * For skipped wall time, uses the next valid moment within `span` minutes; null if the whole span
 * is skipped.
 */
function firstMoment(day: string, minutes: number, span: number, timeZone: string) {
  for (let minute = minutes; minute < minutes + span && minute < 1440; minute += 1) {
    const moment = zonedTime(day, minute, timeZone);
    if (moment !== null) return moment;
  }
  return null;
}

export const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export interface ListChartBuckets {
  /** Wall-clock length; elapsed time varies across daylight saving changes. */
  stepSeconds: number;
  /** Milliseconds since 1970, strictly increasing. */
  starts: number[];
  /** SQL finds the last start at or before the row, placing each row exactly once. */
  bucketSql: (params: QueryParams) => string;
}

/**
 * Uses the shortest LIST_CHART_STEPS step within LIST_CHART_BUCKETS, aligned to the instance's
 * wall clock. Multi-day ranges use their full span for a stable step; today uses elapsed time.
 * Stops at the range end or now, excluding buckets wholly before retention.
 *
 * Skipped marks start at the next valid moment; fully skipped slots have no bucket. Repeated marks
 * use their first occurrence. Assign rows by instant so clock changes cannot skip or double-count
 * them.
 */
export function listChartBuckets(
  range: Pick<TelemetryRange, "from" | "to" | "timeZone" | "firstDay" | "lastDay" | "narrowed">,
  now: Date,
): ListChartBuckets {
  const fromMs = range.from.getTime();
  const endMs = Math.max(fromMs, Math.min(range.to.getTime(), now.getTime()));
  // Choose steps by wall-clock span so daylight saving does not change the step.
  const end =
    range.firstDay === range.lastDay
      ? wallClock(endMs, range.timeZone)
      : { day: addDays(range.lastDay, 1), minutes: 0 };
  // A time window's step fits the window itself, not the days it falls on.
  const spanMs =
    range.narrowed === true
      ? endMs - fromMs
      : asUtc(end.day, end.minutes) - asUtc(range.firstDay, 0);
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
      // Some timezones skip midnight.
      const start = firstMoment(addDays(range.firstDay, group * days), 0, 1440, timeZone);
      if (start !== null) candidates.push(start);
    }
  }
  // Skip duplicate starts caused by clocks jumping across whole slots.
  const rising = candidates.filter((start, at) => at === 0 || start > (candidates[at - 1] ?? 0));
  const starts = rising.filter((start, at) => {
    const next = rising[at + 1] ?? range.to.getTime();
    return start < endMs && next > fromMs;
  });
  const bucketSql = (params: QueryParams) => {
    // Future rows go in the last bucket.
    const moment = `toUnixTimestamp64Milli(least(timestamp,
      fromUnixTimestamp64Milli(${params.add(Math.max(fromMs, endMs - 1), "Int64")}, 'UTC')))`;
    return `greatest(0, arrayCount(start -> start <= ${moment}, ${params.add(starts, "Array(Int64)")}) - 1)`;
  };
  return { stepSeconds: step, starts, bucketSql };
}
