import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { visitSourceSql } from "../visits/visit-source.ts";
import { analyticsEvent, PAGEVIEW, visitsSql } from "../visits/visits.ts";

/**
 * Right now: a project's visitors in the last minutes (docs/web-analytics.md,
 * "Right now"). Activity is any browser event web analytics counts
 * (pageviews, engagement, custom events) with a visitor ID, so a server's
 * events, which have none, never count. Bots were refused on arrival.
 */

/** "Visitors now" counts the visitors active in this many last minutes. */
export const NOW_MINUTES = 5;
/** The chart's minutes and the lists' window, the current minute included. */
export const WINDOW_MINUTES = 30;
const LIST_ROWS = 10;
const MINUTE_MS = 60_000;

export interface NowRange {
  projectId: string;
  environment: string;
  /** The project's hostnames: a referrer on one is not a source. */
  ownHostnames: readonly string[];
  now: Date;
  /**
   * The midnight in the instance's timezone that starts the day of the
   * window's first minute: visits of the visitor IDs active in the window
   * started at it or later, since IDs change there.
   */
  dayStart: Date;
}

export interface NowMinute {
  /** The minute's start, ISO 8601. */
  start: string;
  visitors: number;
  pageviews: number;
}

export interface NowAnswer {
  /** Visitors active in the last NOW_MINUTES minutes. */
  visitors: number;
  /** Visitors active in the window, WINDOW_MINUTES minutes. */
  windowVisitors: number;
  /** WINDOW_MINUTES minutes, oldest first, the current one last. */
  perMinute: NowMinute[];
  /** The pages visitors were on in the window, most visitors first. */
  pages: { path: string; visitors: number; pageviews: number }[];
  /** The sources of the visits active in the window, as the Sources list names them. */
  sources: { value: string; visitors: number }[];
  /** The countries of those visits; null is unknown, last. */
  countries: { value: string | null; visitors: number }[];
}

/** The first minute of the window: WINDOW_MINUTES whole minutes, the current one last. */
export function windowStart(now: Date): Date {
  const minute = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  return new Date(minute - (WINDOW_MINUTES - 1) * MINUTE_MS);
}

/** The window's events web analytics counts. Bound values only; `project_id` first. */
function windowEvents(range: NowRange, params: QueryParams, columns: string): string {
  return `
    SELECT ${columns}
    FROM events FINAL
    WHERE project_id = ${params.add(range.projectId, "UUID")}
      AND environment = ${params.add(range.environment, "String")}
      AND occurred_at >= ${params.time(windowStart(range.now))}
      AND occurred_at <= ${params.time(range.now)}
      AND visitor_id IS NOT NULL
      AND ${analyticsEvent()}`;
}

const count = (value: unknown) => Number(value ?? 0);

/**
 * The counts, the minutes, and the pages, in one read of the window:
 * grouping sets give the minutes (kind 1), the pages (kind 2), and the
 * whole window (kind 3), as `grouping()` numbers them.
 */
async function windowCounts(reader: Reader, range: NowRange) {
  const params = new QueryParams();
  const first = windowStart(range.now);
  const rows = await queryRows<{
    kind: string;
    minute: string;
    path: string;
    visitors: string;
    pageviews: string;
    recent: string;
  }>(
    reader,
    `SELECT grouping(minute, path) AS kind, minute, path,
            uniqExact(visitor_id) AS visitors,
            countIf(name = '${PAGEVIEW}') AS pageviews,
            uniqExactIf(visitor_id, occurred_at >= ${params.time(
              new Date(range.now.getTime() - NOW_MINUTES * MINUTE_MS),
            )}) AS recent
     FROM (
       ${windowEvents(
         range,
         params,
         `visitor_id, name, path, occurred_at,
          intDiv(toUnixTimestamp64Milli(occurred_at) - ${params.add(first.getTime(), "Int64")}, ${MINUTE_MS}) AS minute`,
       )}
     )
     GROUP BY GROUPING SETS ((minute), (path), ())
     ORDER BY kind, visitors DESC, pageviews DESC, path
     LIMIT ${WINDOW_MINUTES} BY kind`,
    params,
  );
  const byMinute = new Map(
    rows.filter((row) => Number(row.kind) === 1).map((row) => [Number(row.minute), row]),
  );
  const total = rows.find((row) => Number(row.kind) === 3);
  return {
    visitors: count(total?.recent),
    windowVisitors: count(total?.visitors),
    perMinute: Array.from({ length: WINDOW_MINUTES }, (_, index) => {
      const row = byMinute.get(index);
      return {
        start: new Date(first.getTime() + index * MINUTE_MS).toISOString(),
        visitors: count(row?.visitors),
        pageviews: count(row?.pageviews),
      };
    }),
    pages: rows
      .filter((row) => Number(row.kind) === 2)
      .slice(0, LIST_ROWS)
      .map((row) => ({
        path: row.path,
        visitors: count(row.visitors),
        pageviews: count(row.pageviews),
      })),
  };
}

/**
 * The sources and countries of the visits active in the window. A visit's
 * source comes from its first event, which may be before the window, so
 * the active visitors' visits are worked out from the day's start
 * (NowRange.dayStart), for those visitors only.
 */
async function visitLists(reader: Reader, range: NowRange) {
  const params = new QueryParams();
  const end = new Date(range.now.getTime() + 1);
  const visits = visitsSql(
    {
      projectId: range.projectId,
      environment: range.environment,
      from: range.dayStart,
      to: end,
      until: end,
    },
    params,
    { contextMs: 0, visitorsIn: windowEvents(range, params, "visitor_id") },
  );
  const rows = await queryRows<{
    kind: string;
    source: string;
    country: string | null;
    visitors: string;
  }>(
    reader,
    `SELECT grouping(source, country) AS kind, source, country, uniqExact(visitor_id) AS visitors
     FROM (
       SELECT visitor_id, ${visitSourceSql(range.ownHostnames, params)} AS source, country
       FROM (${visits})
       WHERE ended_at >= ${params.time(windowStart(range.now))}
     )
     GROUP BY GROUPING SETS ((source), (country))
     ORDER BY kind, country IS NULL, visitors DESC, source, country
     LIMIT ${LIST_ROWS} BY kind`,
    params,
  );
  return {
    sources: rows
      .filter((row) => Number(row.kind) === 1)
      .map((row) => ({ value: row.source, visitors: count(row.visitors) })),
    countries: rows
      .filter((row) => Number(row.kind) === 2)
      .map((row) => ({ value: row.country, visitors: count(row.visitors) })),
  };
}

/**
 * Two queries, one after the other, as a live poll holds one query slot at
 * a time; the second only when someone was active in the window.
 */
export async function projectNow(reader: Reader, range: NowRange): Promise<NowAnswer> {
  const counts = await windowCounts(reader, range);
  if (counts.windowVisitors === 0) return { ...counts, sources: [], countries: [] };
  return { ...counts, ...(await visitLists(reader, range)) };
}
