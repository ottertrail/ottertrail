import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { ENGAGEMENT, VITALS } from "../visits/visits.ts";
import type { ProductRange } from "./events.ts";

/**
 * One retention report (docs/product-analytics.md, "Retention"): signed-in
 * users by the week of their first event, and how many did something in
 * each week after. Visitors cannot be followed: their IDs change daily.
 */

/** Cohorts a report shows, and weeks after each: about a quarter. */
export const MAX_COHORTS = 13;
export const MAX_WEEKS = 12;

export interface Cohort {
  /** The Monday the cohort's week starts, "YYYY-MM-DD", in the instance's timezone. */
  week: string;
  /** Users first seen that week. */
  users: number;
  /**
   * Users who did something in week 0, 1, 2 … after: week 0 is everyone.
   * Only weeks that have begun; the last may not be over (`current`).
   */
  retained: number[];
}

export interface Retention {
  cohorts: Cohort[];
  /** The Monday of the current week: a cohort's week with this date is not over. */
  currentWeek: string;
}

/** "YYYY-MM-DD" of the Monday of a day's week. */
function mondayOf(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const back = (date.getUTCDay() + 6) % 7;
  return new Date(date.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}

const weeksBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (7 * 86_400_000));

/**
 * The cohorts whose week holds a day of the range, the latest MAX_COHORTS,
 * with up to MAX_WEEKS weeks after each, until the current week. A user's
 * first week is over all the time the project keeps, so this reads every
 * signed-in event of the environment.
 */
export async function retention(
  reader: Reader,
  range: ProductRange,
  today: string,
): Promise<Retention> {
  const params = new QueryParams();
  const timeZone = params.add(range.timeZone, "String");
  const week = `toMonday(toDate(occurred_at, ${timeZone}))`;
  const firstWeek = mondayOf(range.firstDay);
  const lastWeek = mondayOf(range.lastDay);
  const currentWeek = mondayOf(today);
  // Events after the last cohort's last shown week change nothing: they can
  // neither make a first week earlier nor fill a column the report shows.
  const readUntil = new Date(Date.parse(`${lastWeek}T00:00:00Z`) + (MAX_WEEKS + 1) * 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const rows = await queryRows<{ cohort: string; offset: string; users: string }>(
    reader,
    `SELECT toString(first_week) AS cohort,
            intDiv(dateDiff('day', first_week, active), 7) AS offset,
            count() AS users
     FROM (
       SELECT user_id, min(${week}) AS first_week, groupUniqArray(${week}) AS weeks
       FROM events FINAL
       WHERE project_id = ${params.add(range.projectId, "UUID")}
         AND environment = ${params.add(range.environment, "String")}
         AND user_id IS NOT NULL
         AND name NOT IN ('${ENGAGEMENT}', '${VITALS}')
         AND occurred_at < toDateTime(toDate(${params.add(readUntil, "String")}), ${timeZone})
       GROUP BY user_id
       HAVING first_week >= toDate(${params.add(firstWeek, "String")})
          AND first_week <= toDate(${params.add(lastWeek, "String")})
     )
     ARRAY JOIN weeks AS active
     WHERE offset <= ${MAX_WEEKS}
     GROUP BY first_week, offset`,
    params,
  );
  const byCohort = new Map<string, Map<number, number>>();
  for (const row of rows) {
    const offsets = byCohort.get(row.cohort) ?? new Map<number, number>();
    offsets.set(Number(row.offset), Number(row.users));
    byCohort.set(row.cohort, offsets);
  }
  const cohorts = [...byCohort.keys()]
    .toSorted()
    .slice(-MAX_COHORTS)
    .map((cohortWeek) => {
      const offsets = byCohort.get(cohortWeek) ?? new Map<number, number>();
      const weeks = Math.min(MAX_WEEKS, Math.max(0, weeksBetween(cohortWeek, currentWeek)));
      return {
        week: cohortWeek,
        users: offsets.get(0) ?? 0,
        retained: Array.from({ length: weeks + 1 }, (_, offset) => offsets.get(offset) ?? 0),
      };
    });
  return { cohorts, currentWeek };
}
