import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { type Step, stepSql } from "../product/steps.ts";
import { dayIn } from "../visitors/visitor-ids.ts";
import { PAGEVIEW } from "../visits/visits.ts";
import { activitySql, countedVisitsSql, type ReportRange, type VisitsSource } from "./reports.ts";

/**
 * The Web analytics chart: one point per hour, day, week, or month in the
 * instance's timezone (docs/web-analytics.md, "Chart intervals").
 */
export const CHART_INTERVALS = ["hour", "day", "week", "month"] as const;
export type ChartInterval = (typeof CHART_INTERVALS)[number];

/** Longest span, in days, for an interval: hours up to a week, days up to a year. */
const MAX_DAYS: Record<ChartInterval, number> = {
  hour: 7,
  day: 366,
  week: Number.POSITIVE_INFINITY,
  month: Number.POSITIVE_INFINITY,
};
/** Shortest span, in days: an interval that gives one or two points shows no trend. */
const MIN_DAYS: Record<ChartInterval, number> = { hour: 1, day: 2, week: 14, month: 60 };

/**
 * The intervals that fit a range of `days` calendar days. A rolling window
 * (the last 24 hours) goes by the hour only: its days are partial.
 */
export function intervalsFor(days: number, rolling: boolean): ChartInterval[] {
  if (rolling) return ["hour"];
  return CHART_INTERVALS.filter(
    (interval) => days >= MIN_DAYS[interval] && days <= MAX_DAYS[interval],
  );
}

/** Hours for a day, days up to about 3 months, weeks up to a year, then months. */
export function defaultInterval(days: number, rolling: boolean): ChartInterval {
  if (rolling || days <= 1) return "hour";
  if (days <= 92) return "day";
  return days <= 366 ? "week" : "month";
}

export interface ChartCounts {
  visitors: number;
  pageviews: number;
  visits: number;
  /** With a goal: the visitors with a goal event in the point. */
  converted?: number;
}

export interface ChartPoint extends ChartCounts {
  /**
   * The point's first moment in the range, in the instance's timezone:
   * "YYYY-MM-DDTHH:mm" for an hour, "YYYY-MM-DD" otherwise. A week or a
   * month cut by the range starts on the range's first day.
   */
  start: string;
  /** Its last day in the range, "YYYY-MM-DD"; an hour's day. */
  end: string;
  /**
   * Covers less than its whole hour, day, week, or month: cut by the
   * range, or still running.
   */
  partial: boolean;
  /** The comparison's counts at the same place; null when comparison is off. */
  previous: ChartCounts | null;
}

/** A point's place: the ClickHouse key its events group under, and what the answer shows. */
export interface ChartBucket {
  key: string;
  start: string;
  end: string;
  partial: boolean;
}

/** How the comparison's events move onto the chart's points: forward by this much. */
export type ChartShift = { unit: "day" | "hour" | "year"; amount: number };

function addDays(day: string, days: number): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

/** ISO weekday of a "YYYY-MM-DD", Monday 0. */
const weekday = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;

function localParts(timeZone: string) {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return (moment: number) =>
    Object.fromEntries(format.formatToParts(moment).map((part) => [part.type, part.value]));
}

/**
 * The chart's points for [from, to) up to `now`: hours or days that have
 * begun, and the weeks (from Monday) and months they fall in. Hours step
 * through instants, so a daylight saving day has 23 or 25 of them.
 */
export function chartBuckets(
  interval: ChartInterval,
  range: { from: Date; to: Date; timeZone: string },
  now: Date,
): ChartBucket[] {
  const end = Math.min(range.to.getTime(), now.getTime());
  const { from, timeZone } = range;
  if (end <= from.getTime()) return [];
  if (interval === "hour") {
    const parts = localParts(timeZone);
    const hourStart = (moment: number) => {
      const local = parts(moment);
      return moment - (Number(local.minute) * 60 + Number(local.second)) * 1000 - (moment % 1000);
    };
    const buckets: ChartBucket[] = [];
    for (let start = hourStart(from.getTime()); start < end;) {
      const local = parts(start);
      const next = Math.max(hourStart(start + 3_600_000), start + 1_800_000);
      buckets.push({
        key: String(start / 1000),
        start: `${local.year}-${local.month}-${local.day}T${local.hour}:${local.minute}`,
        end: `${local.year}-${local.month}-${local.day}`,
        partial: start < from.getTime() || next > now.getTime() || next > range.to.getTime(),
      });
      start = next;
    }
    return buckets;
  }
  const day = dayIn(timeZone);
  const firstDay = day(from);
  const lastDay = day(new Date(end - 1));
  const today = day(now);
  const buckets: ChartBucket[] = [];
  for (let current = firstDay; current <= lastDay;) {
    const [year = 0, month = 1] = current.split("-").map(Number);
    const calendarStart =
      interval === "day"
        ? current
        : interval === "week"
          ? addDays(current, -weekday(current))
          : `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
    const calendarEnd =
      interval === "day"
        ? current
        : interval === "week"
          ? addDays(calendarStart, 6)
          : new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    const last = calendarEnd < lastDay ? calendarEnd : lastDay;
    buckets.push({
      key: calendarStart,
      start: current,
      end: last,
      partial: calendarStart < current || calendarEnd > last || calendarEnd >= today,
    });
    current = addDays(last, 1);
  }
  return buckets;
}

/** The SQL that puts `column` on its point, after moving it by `shift`. */
function bucketSql(
  interval: ChartInterval,
  column: string,
  timeZone: string,
  shift?: ChartShift,
): string {
  const local = `toDateTime64(${column}, 3, ${timeZone})`;
  const moved =
    shift === undefined || shift.amount === 0
      ? local
      : shift.unit === "day"
        ? `addDays(${local}, ${shift.amount})`
        : shift.unit === "hour"
          ? `addHours(${local}, ${shift.amount})`
          : `addYears(${local}, ${shift.amount})`;
  const keys: Record<ChartInterval, string> = {
    hour: `toString(toUnixTimestamp(toStartOfHour(${moved})))`,
    day: `toString(toDate(${moved}))`,
    week: `toString(toMonday(toDate(${moved})))`,
    month: `toString(toStartOfMonth(toDate(${moved})))`,
  };
  return keys[interval];
}

/**
 * Visitors, pageviews, and visits per point, keyed by ChartBucket.key. A
 * visit counts where it started. With `shift`, the range is the
 * comparison's, and its events land on the chart's points: a week before
 * on the same weekday, a year before on the same date.
 */
export async function chartCounts(
  reader: Reader,
  range: ReportRange,
  interval: ChartInterval,
  visitsSource: VisitsSource,
  goal?: Step,
  shift?: ChartShift,
): Promise<Map<string, ChartCounts>> {
  // Whole numbers only reach the SQL text.
  if (shift !== undefined && !Number.isInteger(shift.amount)) {
    throw new Error("A chart shift is a whole number");
  }
  const params = new QueryParams();
  const visits = countedVisitsSql(range, visitsSource, params);
  const timeZone = params.add(range.timeZone, "String");
  const converted = goal === undefined ? "0" : `uniqExactIf(visitor_id, ${stepSql(params, goal)})`;
  const rows = await queryRows<{
    key: string;
    visitors: string;
    pageviews: string;
    visits: string;
    converted: string;
  }>(
    reader,
    `SELECT key, sum(visitors) AS visitors, sum(pageviews) AS pageviews, sum(visits) AS visits,
            sum(converted) AS converted
     FROM (
       SELECT ${bucketSql(interval, "occurred_at", timeZone, shift)} AS key,
              uniqExact(visitor_id) AS visitors, countIf(name = '${PAGEVIEW}') AS pageviews,
              0 AS visits, ${converted} AS converted
       FROM (${activitySql(range, visits, params)}) GROUP BY key
       UNION ALL
       SELECT ${bucketSql(interval, "started_at", timeZone, shift)} AS key, 0, 0, count(), 0
       FROM (${visits}) GROUP BY key
     )
     GROUP BY key`,
    params,
  );
  return new Map(
    rows.map((row) => [
      row.key,
      {
        visitors: Number(row.visitors),
        pageviews: Number(row.pageviews),
        visits: Number(row.visits),
        ...(goal === undefined ? {} : { converted: Number(row.converted) }),
      },
    ]),
  );
}

const ZERO: ChartCounts = { visitors: 0, pageviews: 0, visits: 0 };

/** The points, with zeros where nothing happened, and the comparison's counts beside them. */
export function chartPoints(
  buckets: readonly ChartBucket[],
  current: Map<string, ChartCounts>,
  previous: Map<string, ChartCounts> | null,
  goal: boolean,
): ChartPoint[] {
  const zero = goal ? { ...ZERO, converted: 0 } : ZERO;
  return buckets.map((bucket) => ({
    start: bucket.start,
    end: bucket.end,
    partial: bucket.partial,
    ...(current.get(bucket.key) ?? zero),
    previous: previous === null ? null : (previous.get(bucket.key) ?? zero),
  }));
}
