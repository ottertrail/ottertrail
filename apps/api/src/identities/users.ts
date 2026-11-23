import { fromClickHouseTime, QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { DEFAULT_ENVIRONMENT } from "../collection/environment.ts";
import { ENGAGEMENT, ERROR, VITALS } from "../visits/visits.ts";

/** Events a user did not do themselves: time-on-page reports and Web Vitals. */
const NOT_THEIRS = `name NOT IN ('${ENGAGEMENT}', '${VITALS}')`;

/**
 * Known users: the user IDs a site sends with its events (collection/
 * identity.ts), worked out from the events in ClickHouse when asked, one
 * environment at a time, as reports are. A user's activity is the events
 * that carry the user's ID, and only those: anonymous events before a
 * sign-in are left out, since on a shared computer they may be someone
 * else's (docs/web-analytics.md, "Known users").
 */

export interface User {
  userId: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** Pageviews and custom events with the user's ID. */
  events: number;
}

/** Users per page of the list, and the most it ever returns. */
export const USERS_PAGE_SIZE = 50;
const MAX_OFFSET = 100_000;

interface UserRowData {
  user_id: string;
  first_seen: string;
  last_seen: string;
  events: string;
}

const toUser = (row: UserRowData): User => ({
  userId: row.user_id,
  firstSeenAt: fromClickHouseTime(row.first_seen),
  lastSeenAt: fromClickHouseTime(row.last_seen),
  events: Number(row.events),
});

/**
 * Engagement and vitals do not count as user actions; users with no other events
 * are omitted.
 */
const USER_COLUMNS = `minIf(occurred_at, ${NOT_THEIRS}) AS first_seen,
  maxIf(occurred_at, ${NOT_THEIRS}) AS last_seen,
  countIf(${NOT_THEIRS}) AS events`;

/** The project's events of one environment; the project first, for the table's order. */
function scope(params: QueryParams, projectId: string, environment: string): string {
  return `project_id = ${params.add(projectId, "UUID")}
    AND environment = ${params.add(environment, "String")}`;
}

/** Most recently seen first, with case-insensitive ID search and pagination. */
export async function listUsers(
  reader: Reader,
  options: {
    projectId: string;
    environment?: string;
    search?: string | undefined;
    offset?: number;
    limit?: number;
  },
): Promise<{ users: User[]; hasMore: boolean }> {
  const { projectId, environment = DEFAULT_ENVIRONMENT, search } = options;
  const limit = Math.min(Math.max(1, options.limit ?? USERS_PAGE_SIZE), USERS_PAGE_SIZE);
  const offset = Math.min(Math.max(0, options.offset ?? 0), MAX_OFFSET);
  const params = new QueryParams();
  const matches =
    search === undefined || search === ""
      ? ""
      : `AND positionCaseInsensitiveUTF8(user_id, ${params.add(search, "String")}) > 0`;
  const rows = await queryRows<UserRowData>(
    reader,
    `SELECT user_id, ${USER_COLUMNS}
     FROM events FINAL
     WHERE ${scope(params, projectId, environment)} AND user_id IS NOT NULL ${matches}
     GROUP BY user_id
     HAVING events > 0
     ORDER BY last_seen DESC, user_id
     LIMIT ${limit + 1} OFFSET ${offset}`,
    params,
  );
  return { users: rows.slice(0, limit).map(toUser), hasMore: rows.length > limit };
}

/**
 * The environments with known users, most events first, then the one
 * shown and production even without any: what the users page can switch to.
 */
export async function userEnvironments(
  reader: Reader,
  projectId: string,
  shown: string,
): Promise<string[]> {
  const params = new QueryParams();
  const rows = await queryRows<{ environment: string }>(
    reader,
    `SELECT environment FROM events
     WHERE project_id = ${params.add(projectId, "UUID")} AND user_id IS NOT NULL
     GROUP BY environment
     ORDER BY count() DESC, environment`,
    params,
  );
  const names = rows.map((row) => row.environment);
  for (const name of [shown, DEFAULT_ENVIRONMENT]) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export interface Activity {
  eventId: string;
  /** "pageview", "error", or a custom event's name. */
  name: string;
  occurredAt: Date;
  path: string;
  referrer: string | null;
  properties: Record<string, unknown>;
  browser: string | null;
  os: string | null;
  deviceType: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  release: string | null;
  /** For an error: what went wrong, and its group on the Errors page (docs/errors.md). */
  error: { type: string; message: string; fingerprint: string } | null;
  /** For an error: the session replay its page sent with it, if any (docs/session-replay.md). */
  replayId: string | null;
}

interface ActivityRowData {
  event_id: string;
  name: string;
  occurred_at: string;
  path: string;
  referrer: string | null;
  properties: string;
  browser: string | null;
  os: string | null;
  device_type: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  release: string | null;
  error_type: string;
  error_message: string;
  error_fingerprint: string;
  replay_id: string | null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function propertiesOf(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : {};
  } catch {
    return {};
  }
}

/** Activity pages go back from here: the last event of the page before. */
export interface ActivityCursor {
  occurredAt: Date;
  eventId: string;
}

/** Events per page of a user's activity, and the most it ever returns. */
export const ACTIVITY_PAGE_SIZE = 100;

/**
 * Newest first, paged backward from before. Returns null when the environment
 * has no events for this user.
 */
export async function userActivity(
  reader: Reader,
  options: {
    projectId: string;
    environment?: string;
    userId: string;
    before?: ActivityCursor | undefined;
    limit?: number;
  },
): Promise<{ user: User; activity: Activity[]; hasMore: boolean } | null> {
  const { projectId, environment = DEFAULT_ENVIRONMENT, userId, before } = options;
  const limit = Math.min(Math.max(1, options.limit ?? ACTIVITY_PAGE_SIZE), ACTIVITY_PAGE_SIZE);
  const params = new QueryParams();
  const where = `${scope(params, projectId, environment)}
    AND user_id = ${params.add(userId, "String")}`;
  const [summary] = await queryRows<UserRowData>(
    reader,
    `SELECT user_id, ${USER_COLUMNS}
     FROM events FINAL
     WHERE ${where}
     GROUP BY user_id
     HAVING events > 0`,
    params,
  );
  if (summary === undefined) return null;

  const after =
    before === undefined
      ? ""
      : `AND (occurred_at, event_id) < (${params.time(before.occurredAt)}, ${params.add(
          before.eventId,
          "UUID",
        )})`;
  const rows = await queryRows<ActivityRowData>(
    reader,
    `SELECT event_id, name, occurred_at, path, referrer, properties, browser, os, device_type,
            country, region, city, release, error_type, error_message, error_fingerprint,
            replay_id
     FROM events FINAL
     WHERE ${where} AND ${NOT_THEIRS} ${after}
     ORDER BY occurred_at DESC, event_id DESC
     LIMIT ${limit + 1}`,
    params,
  );
  return {
    user: toUser(summary),
    activity: rows.slice(0, limit).map((row) => ({
      eventId: row.event_id,
      name: row.name,
      occurredAt: fromClickHouseTime(row.occurred_at),
      path: row.path,
      referrer: row.referrer,
      properties: propertiesOf(row.properties),
      browser: row.browser,
      os: row.os,
      deviceType: row.device_type,
      country: row.country,
      region: row.region,
      city: row.city,
      release: row.release,
      error:
        row.name === ERROR && row.error_fingerprint !== ""
          ? { type: row.error_type, message: row.error_message, fingerprint: row.error_fingerprint }
          : null,
      replayId: row.name === ERROR ? row.replay_id : null,
    })),
    hasMore: rows.length > limit,
  };
}
