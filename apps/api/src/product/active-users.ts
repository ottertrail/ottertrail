import { USER_FIRST_SEEN } from "../clickhouse/migrations.ts";
import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { addDays, dayStart } from "../telemetry/dashboard-query.ts";
import { COUNTED, type ProductRange } from "./events.ts";
import { type TrendUnit } from "./funnel.ts";

/**
 * Daily, weekly, and monthly active signed-in users, stickiness, and each
 * day's new, returning, and resurrected users (docs/product-analytics.md,
 * "Active users"). Visitor IDs change daily, so only user IDs can be
 * followed across a 7- or 28-day window.
 */

/** Days in a weekly window, the day itself included. */
export const WEEK_DAYS = 7;
/** Days in a monthly window, the day itself included. */
export const MONTH_DAYS = 28;
/**
 * Days read before the period: a returning user on its first day was active
 * in the 28 days before it, one more than the monthly window needs.
 */
export const LOOKBACK_DAYS = MONTH_DAYS;

export interface ActivePoint {
  /** The day, or the Monday that starts the week, "YYYY-MM-DD" in the range's timezone. */
  day: string;
  /** When that day or week starts, for the bar chart's axis. */
  start: Date;
  /** Users active that day; for a week, the average over its days in the period. */
  dau: number;
  /** Users active in the 7 days ending that day, or the week's last day in the period. */
  wau: number;
  /** Users active in the 28 days ending that day, or the week's last day in the period. */
  mau: number;
  /** dau ÷ mau, averaged over the days with any monthly user; null when there are none. */
  stickiness: number | null;
  /** First seen that day or week. They, returning, and resurrected add up to the users active then. */
  new: number;
  /** Active then, and also in the 28 days before the day or week started. */
  returning: number;
  /** Active then, seen before, but not in the 28 days before. */
  resurrected: number;
}

export interface ActiveSummary {
  /** Users active on any day of the period. */
  users: number;
  /** The average of each day's active users. */
  averageDaily: number;
  /** The last day's WAU and MAU. */
  weekly: number;
  monthly: number;
  /** The average of each day's DAU ÷ MAU, over the days with any monthly user. */
  stickiness: number | null;
}

export interface ActiveUsers {
  unit: TrendUnit;
  summary: ActiveSummary;
  points: ActivePoint[];
}

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
/** Monday is 0. */
const weekdayOf = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;

const average = (values: readonly number[]) =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

function stickinessOf(days: readonly { dau: number; mau: number }[]): number | null {
  const counted = days.filter((day) => day.mau > 0);
  return counted.length === 0 ? null : average(counted.map((day) => day.dau / day.mau));
}

/** Which rows the query answers: a day's counts, a slot's lifecycle, or the period's users. */
const KIND = { day: 0, slot: 1, period: 2 } as const;
/** A day's flag: active that day, in its 7 days but not that day, or only in its 28. */
const DAY_FLAG = { monthly: 0, weekly: 1, daily: 2 } as const;
const LIFECYCLE = { new: 1, returning: 2, resurrected: 3 } as const;

/**
 * One pass over the signed-in events of the period and the 28 days before.
 * Each user's active days become offsets from the first day read, so the
 * period's days are LOOKBACK_DAYS to LOOKBACK_DAYS + days - 1. Per user, one
 * row per period day inside any of their 28-day windows (a day's DAU, WAU,
 * and MAU), one per slot they were active in (its lifecycle), and one if
 * they were active in the period at all. Without FINAL: a retried event
 * repeats a day the user was already active on. First-seen times come
 * from user_first_seen, not from history (docs/clickhouse.md).
 */
export async function activeUsers(
  reader: Reader,
  range: ProductRange,
  unit: TrendUnit,
): Promise<ActiveUsers> {
  const days = daysBetween(range.firstDay, range.lastDay) + 1;
  const slotDays = unit === "week" ? 7 : 1;
  // Slots are calendar weeks from Monday; the first may start before the period.
  const shift = unit === "week" ? weekdayOf(range.firstDay) : 0;
  const slots = Math.floor((days - 1 + shift) / slotDays) + 1;

  const params = new QueryParams();
  const timeZone = params.add(range.timeZone, "String");
  const base = `toDate(${params.add(addDays(range.firstDay, -LOOKBACK_DAYS), "String")})`;
  const first = params.add(LOOKBACK_DAYS, "Int32");
  const last = params.add(LOOKBACK_DAYS + days - 1, "Int32");
  const size = params.add(slotDays, "Int32");
  const offset = params.add(shift, "Int32");
  const projectId = params.add(range.projectId, "UUID");
  const environment = params.add(range.environment, "String");
  const slotStart = (slot: string) =>
    `greatest(${first}, ${first} + ${slot} * ${size} - ${offset})`;

  const rows = await queryRows<{ kind: number; slot: number; flag: number; users: string }>(
    reader,
    `SELECT t.1 AS kind, t.2 AS slot, t.3 AS flag, count() AS users
     FROM (
       SELECT days,
              least(arrayMin(days), ifNull(seen, arrayMin(days))) AS first_day,
              arrayFilter(d -> d >= ${first} AND d <= ${last},
                arrayDistinct(arrayFlatten(
                  arrayMap(a -> range(toUInt32(a), toUInt32(a + ${MONTH_DAYS})), days)))) AS candidates,
              arrayDistinct(arrayMap(a -> intDiv(a - ${first} + ${offset}, ${size}),
                arrayFilter(a -> a >= ${first}, days))) AS slots
       FROM (
         SELECT user_id,
                groupUniqArray(toInt32(dateDiff('day', ${base}, toDate(occurred_at, ${timeZone})))) AS days
         FROM events
         WHERE project_id = ${projectId}
           AND environment = ${environment}
           AND occurred_at >= toDateTime(${base}, ${timeZone})
           AND occurred_at < ${params.time(range.to)}
           AND ${COUNTED.retention}
         GROUP BY user_id
       ) AS activity
       LEFT JOIN (
         SELECT user_id,
                toNullable(toInt32(dateDiff('day', ${base},
                  toDate(minMerge(first_seen), ${timeZone})))) AS seen
         FROM ${USER_FIRST_SEEN}
         WHERE project_id = ${projectId}
           AND environment = ${environment}
         GROUP BY user_id
       ) AS firsts
       ON activity.user_id = assumeNotNull(firsts.user_id)
     )
     ARRAY JOIN arrayConcat(
       arrayMap(d -> tuple(toUInt8(${KIND.day}), toInt32(d - ${first}),
         toUInt8(multiIf(has(days, d), ${DAY_FLAG.daily},
                         arrayExists(a -> a <= d AND a > d - ${WEEK_DAYS}, days), ${DAY_FLAG.weekly},
                         ${DAY_FLAG.monthly}))), candidates),
       arrayMap(s -> tuple(toUInt8(${KIND.slot}), toInt32(s),
         toUInt8(multiIf(first_day >= ${slotStart("s")}, ${LIFECYCLE.new},
                         arrayExists(a -> a >= ${slotStart("s")} - ${MONTH_DAYS}
                                          AND a < ${slotStart("s")}, days), ${LIFECYCLE.returning},
                         ${LIFECYCLE.resurrected}))), slots),
       if(empty(slots), [], [tuple(toUInt8(${KIND.period}), toInt32(0), toUInt8(0))])
     ) AS t
     GROUP BY kind, slot, flag`,
    params,
  );

  const daily = Array.from({ length: days }, () => ({ dau: 0, wau: 0, mau: 0 }));
  const lifecycle = Array.from({ length: slots }, () => ({ new: 0, returning: 0, resurrected: 0 }));
  let users = 0;
  for (const row of rows) {
    const count = Number(row.users);
    const { kind, flag, slot } = row;
    if (kind === KIND.period) {
      users += count;
    } else if (kind === KIND.day) {
      const day = daily[slot];
      if (day === undefined) continue;
      day.mau += count;
      if (flag >= DAY_FLAG.weekly) day.wau += count;
      if (flag === DAY_FLAG.daily) day.dau += count;
    } else {
      const part = lifecycle[slot];
      if (part === undefined) continue;
      if (flag === LIFECYCLE.new) part.new += count;
      else if (flag === LIFECYCLE.returning) part.returning += count;
      else part.resurrected += count;
    }
  }

  const points = lifecycle.map((part, slot) => {
    const from = Math.max(0, slot * slotDays - shift);
    const to = Math.min(days - 1, slot * slotDays - shift + slotDays - 1);
    const inSlot = daily.slice(from, to + 1);
    const lastDay = inSlot.at(-1) ?? { wau: 0, mau: 0 };
    const day = addDays(range.firstDay, slot * slotDays - shift);
    return {
      day,
      start: new Date(dayStart(day, range.timeZone) ?? Date.parse(`${day}T00:00:00Z`)),
      dau: average(inSlot.map((item) => item.dau)),
      wau: lastDay.wau,
      mau: lastDay.mau,
      stickiness: stickinessOf(inSlot),
      ...part,
    };
  });
  const lastDay = daily.at(-1) ?? { wau: 0, mau: 0 };
  return {
    unit,
    summary: {
      users,
      averageDaily: average(daily.map((day) => day.dau)),
      weekly: lastDay.wau,
      monthly: lastDay.mau,
      stickiness: stickinessOf(daily),
    },
    points,
  };
}
