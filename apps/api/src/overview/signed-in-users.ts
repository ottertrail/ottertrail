import { USER_FIRST_SEEN } from "../clickhouse/migrations.ts";
import { fromClickHouseTime, QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { ENGAGEMENT, VITALS } from "../visits/visits.ts";

/**
 * The overview's signed-in users (docs/dashboard.md, "Overview"): how many
 * were active in a period and the period before, how many were new (first
 * seen in it), and the week-1 and week-4 retention of the latest weekly
 * cohorts, as the Retention page counts them (product/retention.ts): a
 * user is active in a week when they did anything there but report time on
 * a page or Web Vitals.
 *
 * When a user was first seen comes from user_first_seen (docs/clickhouse.md,
 * "First-seen times"), a row per user, so no query reads all the history.
 * Activity is read only from the earliest day a figure needs: the period
 * before, or the first cohort's Monday, whichever is earlier. Both read
 * without FINAL: a retried event stored twice changes neither a user's
 * first event nor the weeks they were active.
 */

/** Weekly cohorts the overview shows, the current week's included. */
export const OVERVIEW_COHORTS = 6;
/** The weeks after a cohort's first that the overview shows. */
export const RETENTION_WEEKS = [1, 4] as const;
/** Newest signed-in users listed, for those who may see users. */
export const NEWEST_USERS = 5;

/** A cohort's users active some weeks later; `current` while that week is still running. */
export interface Retained {
  users: number;
  current: boolean;
}

export interface OverviewCohort {
  /** The Monday the cohort's week starts, "YYYY-MM-DD", in the instance's timezone. */
  week: string;
  /** Users first seen that week. */
  users: number;
  /** Users of the cohort active 1 and 4 weeks later; null for a week that has not begun. */
  week1: Retained | null;
  week4: Retained | null;
}

export interface NewUsers {
  new: number;
  /** In the period before, up to the same moment while the period runs. */
  previousNew: number;
  /** Whether the environment has any signed-in user at all, up to the period's end. */
  received: boolean;
}

export interface SignedInUsers extends NewUsers {
  active: number;
  previousActive: number;
  /** Oldest first. */
  cohorts: OverviewCohort[];
  /** The Monday of the current week. */
  currentWeek: string;
  /** The newest users first seen in the period, newest first; only when asked for. */
  newest?: { userId: string; firstSeenAt: Date }[];
}

export interface UsersScope {
  projectId: string;
  environment: string;
  timeZone: string;
  from: Date;
  to: Date;
  previousFrom: Date;
  previousTo: Date;
}

const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" of the Monday of a day's week. */
export function mondayOf(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const back = (date.getUTCDay() + 6) % 7;
  return new Date(date.getTime() - back * DAY_MS).toISOString().slice(0, 10);
}

const weeksBefore = (monday: string, weeks: number) =>
  new Date(Date.parse(`${monday}T00:00:00Z`) - weeks * 7 * DAY_MS).toISOString().slice(0, 10);

/** Each user's first-seen time in the scope's environment, first seen before the period's end. */
function firstSeen(params: QueryParams, scope: UsersScope): string {
  return `SELECT user_id, minMerge(first_seen) AS first_time
          FROM ${USER_FIRST_SEEN}
          WHERE project_id = ${params.add(scope.projectId, "UUID")}
            AND environment = ${params.add(scope.environment, "String")}
          GROUP BY user_id
          HAVING first_time < ${params.time(scope.to)}`;
}

/**
 * New signed-in users in the period and the one before, from the first-seen
 * times alone: the overview's headline without a main goal.
 */
export async function newUsers(reader: Reader, scope: UsersScope): Promise<NewUsers> {
  const params = new QueryParams();
  const [row] = await queryRows<{ users: string; new_users: string; previous_new: string }>(
    reader,
    `SELECT count() AS users,
            countIf(first_time >= ${params.time(scope.from)}) AS new_users,
            countIf(first_time >= ${params.time(scope.previousFrom)}
                    AND first_time < ${params.time(scope.previousTo)}) AS previous_new
     FROM (${firstSeen(params, scope)})`,
    params,
  );
  return {
    new: Number(row?.new_users ?? 0),
    previousNew: Number(row?.previous_new ?? 0),
    received: Number(row?.users ?? 0) > 0,
  };
}

export async function signedInUsers(
  reader: Reader,
  scope: UsersScope & {
    /** Today, "YYYY-MM-DD", in the timezone: the current week's cohort is the last. */
    today: string;
    /** List the newest users by ID (the users area). */
    withNewest: boolean;
  },
): Promise<SignedInUsers> {
  const currentWeek = mondayOf(scope.today);
  const firstCohort = weeksBefore(currentWeek, OVERVIEW_COHORTS - 1);

  const params = new QueryParams();
  const timeZone = params.add(scope.timeZone, "String");
  const cohortStart = `toDate(${params.add(firstCohort, "String")})`;
  const from = params.time(scope.from);
  const previousFrom = params.time(scope.previousFrom);
  const previousTo = params.time(scope.previousTo);
  const week = `toMonday(toDate(occurred_at, ${timeZone}))`;
  // Activity from the period before, or the first cohort's Monday, whichever is earlier.
  const readFrom = `least(${previousFrom}, toDateTime64(${cohortStart}, 3, ${timeZone}))`;
  // The offsets a cohort's user was active in, of 0 (their first week) and RETENTION_WEEKS.
  const offsets = `arrayFilter(o -> has([0, ${RETENTION_WEEKS.join(", ")}], o),
                     arrayMap(w -> intDiv(dateDiff('day', first_week, w), 7), weeks))`;
  const activityQuery = queryRows<{
    active: string;
    previous_active: string;
    retained: [string[], (string | number)[]];
  }>(
    reader,
    `SELECT countIf(active_now) AS active,
            countIf(active_before) AS previous_active,
            sumMapIf(
              arrayMap(o -> concat(toString(first_week), ':', toString(o)), ${offsets}),
              arrayMap(o -> toUInt64(1), ${offsets}),
              first_week >= ${cohortStart}
            ) AS retained
     FROM (
       SELECT user_id,
              countIf(occurred_at >= ${from}) > 0 AS active_now,
              countIf(occurred_at >= ${previousFrom} AND occurred_at < ${previousTo}) > 0
                AS active_before,
              groupUniqArrayIf(${week}, ${week} >= ${cohortStart}) AS weeks
       FROM events
       WHERE project_id = ${params.add(scope.projectId, "UUID")}
         AND environment = ${params.add(scope.environment, "String")}
         AND occurred_at >= ${readFrom}
         AND occurred_at < ${params.time(scope.to)}
         AND user_id IS NOT NULL
         AND name NOT IN ('${ENGAGEMENT}', '${VITALS}')
       GROUP BY user_id
     ) AS activity
     INNER JOIN (
       SELECT user_id, toMonday(toDate(first_time, ${timeZone})) AS first_week
       FROM (${firstSeen(params, scope)})
     ) AS firsts
     ON activity.user_id = assumeNotNull(firsts.user_id)`,
    params,
  );

  const newestParams = new QueryParams();
  const newestQuery = scope.withNewest
    ? queryRows<{ user_id: string; first_time: string }>(
        reader,
        `SELECT user_id, first_time
         FROM (${firstSeen(newestParams, scope)})
         WHERE first_time >= ${newestParams.time(scope.from)}
         ORDER BY first_time DESC, user_id
         LIMIT ${NEWEST_USERS}`,
        newestParams,
      )
    : Promise.resolve([]);

  const [[row], counts, newest] = await Promise.all([
    activityQuery,
    newUsers(reader, scope),
    newestQuery,
  ]);
  // sumMap answers a tuple of keys and values: two arrays.
  const [keys = [], values = []] = Array.isArray(row?.retained) ? row.retained : [];
  const retainedOf = (key: string): number => {
    const index = Array.isArray(keys) ? keys.indexOf(key) : -1;
    return index === -1 || !Array.isArray(values) ? 0 : Number(values[index] ?? 0);
  };
  const cohorts = Array.from({ length: OVERVIEW_COHORTS }, (_, index) => {
    const cohortWeek = weeksBefore(currentWeek, OVERVIEW_COHORTS - 1 - index);
    /** A later week's figure: null before it begins, `current` while it runs. */
    const later = (offset: number): Retained | null => {
      const monday = weeksBefore(cohortWeek, -offset);
      if (monday > currentWeek) return null;
      return { users: retainedOf(`${cohortWeek}:${offset}`), current: monday === currentWeek };
    };
    return {
      week: cohortWeek,
      users: retainedOf(`${cohortWeek}:0`),
      week1: later(1),
      week4: later(4),
    };
  });
  return {
    ...counts,
    active: Number(row?.active ?? 0),
    previousActive: Number(row?.previous_active ?? 0),
    cohorts,
    currentWeek,
    ...(scope.withNewest
      ? {
          newest: newest.map((user) => ({
            userId: user.user_id,
            firstSeenAt: fromClickHouseTime(user.first_time),
          })),
        }
      : {}),
  };
}
