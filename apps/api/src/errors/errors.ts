import type { Kysely } from "kysely";

import { forgetRegressions } from "../alerts/rules.ts";
import { fromClickHouseTime, QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { DEFAULT_ENVIRONMENT } from "../collection/environment.ts";
import type { BrowserRequest } from "../collection/event-store.ts";
import type { Database } from "../db/schema.ts";
import { ERROR } from "../visits/visits.ts";
import { type Assignee, assigneesOf } from "./assignments.ts";

/**
 * Count fingerprint groups in ClickHouse; read resolutions from PostgreSQL
 * (error_resolutions; docs/errors.md).
 */

/** A range of whole days in the instance's timezone, in one environment. */
export interface ErrorRange {
  projectId: string;
  environment: string;
  timeZone: string;
  /** "YYYY-MM-DD", both included. */
  firstDay: string;
  lastDay: string;
  /** Start of firstDay and end of lastDay, in the timezone. */
  from: Date;
  to: Date;
}

/**
 * - unresolved: nobody marked it resolved.
 * - resolved: marked resolved, and not seen since.
 * - regressed: seen again after it was marked resolved; counts as unresolved.
 */
export type ErrorStatus = "unresolved" | "resolved" | "regressed";
export const STATUS_FILTERS = ["unresolved", "resolved", "all"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export interface ErrorGroup {
  fingerprint: string;
  /** The type and message of its latest occurrence in the range. */
  type: string;
  message: string;
  occurrences: number;
  /** Known users (user IDs) who had it, in the range. */
  users: number;
  /** Daily visitor IDs, as in web analytics; server exceptions have none. */
  visitors: number;
  /** Its first and latest occurrence in the environment, at any time the project keeps. */
  firstSeen: Date;
  lastSeen: Date;
  status: ErrorStatus;
  resolvedAt: Date | null;
  /** The dashboard user who resolved it; null when unknown or not resolved. */
  resolvedBy: string | null;
  assignee: Assignee | null;
}

export const MAX_GROUPS = 1000;
/** Fingerprints per query, so a query's parameters stay small. */
const CHUNK = 200;

const errorScope = (params: QueryParams, projectId: string, environment: string) =>
  `project_id = ${params.add(projectId, "UUID")}
   AND environment = ${params.add(environment, "String")}
   AND name = '${ERROR}'
   AND error_fingerprint != ''`;

const inRange = (params: QueryParams, range: ErrorRange) =>
  `occurred_at >= ${params.time(range.from)} AND occurred_at < ${params.time(range.to)}`;

const count = (value: unknown) => Number(value);

interface RangeRow {
  fingerprint: string;
  type: string;
  message: string;
  occurrences: string;
  users: string;
  visitors: string;
}

async function groupsInRange(
  reader: Reader,
  range: ErrorRange,
  fingerprint?: string,
): Promise<RangeRow[]> {
  const params = new QueryParams();
  return queryRows<RangeRow>(
    reader,
    `SELECT error_fingerprint AS fingerprint,
            argMax(error_type, (occurred_at, event_id)) AS type,
            argMax(error_message, (occurred_at, event_id)) AS message,
            count() AS occurrences,
            uniqExactIf(user_id, user_id IS NOT NULL) AS users,
            uniqExact(visitor_id) AS visitors
     FROM events FINAL
     WHERE ${errorScope(params, range.projectId, range.environment)}
       AND ${inRange(params, range)}
       ${fingerprint === undefined ? "" : `AND error_fingerprint = ${params.add(fingerprint, "String")}`}
     GROUP BY error_fingerprint
     ORDER BY max(occurred_at) DESC, fingerprint
     LIMIT ${MAX_GROUPS + 1}`,
    params,
  );
}

interface Seen {
  /** First and latest occurrence in the environment shown. */
  firstSeen: Date;
  lastSeen: Date;
  /** Latest occurrence in any environment: a status belongs to the project. */
  lastAnywhere: Date;
}

/**
 * Read all retained occurrences; the fingerprint bloom filter skips
 * parts without the group.
 */
async function seen(
  reader: Reader,
  projectId: string,
  environment: string,
  fingerprints: string[],
): Promise<Map<string, Seen>> {
  const found = new Map<string, Seen>();
  for (let start = 0; start < fingerprints.length; start += CHUNK) {
    const params = new QueryParams();
    const shown = params.add(environment, "String");
    const rows = await queryRows<{
      fingerprint: string;
      first_seen: string;
      last_seen: string;
      last_anywhere: string;
    }>(
      reader,
      `SELECT error_fingerprint AS fingerprint,
              minIf(occurred_at, environment = ${shown}) AS first_seen,
              maxIf(occurred_at, environment = ${shown}) AS last_seen,
              max(occurred_at) AS last_anywhere
       FROM events FINAL
       WHERE project_id = ${params.add(projectId, "UUID")}
         AND name = '${ERROR}'
         AND error_fingerprint IN ${params.add(fingerprints.slice(start, start + CHUNK), "Array(String)")}
       GROUP BY error_fingerprint`,
      params,
    );
    for (const row of rows) {
      found.set(row.fingerprint, {
        firstSeen: fromClickHouseTime(row.first_seen),
        lastSeen: fromClickHouseTime(row.last_seen),
        lastAnywhere: fromClickHouseTime(row.last_anywhere),
      });
    }
  }
  return found;
}

export async function resolutions(
  db: Kysely<Database>,
  projectId: string,
  fingerprints: string[],
): Promise<Map<string, { resolvedAt: Date; resolvedBy: string | null }>> {
  if (fingerprints.length === 0) return new Map();
  const rows = await db
    .selectFrom("error_resolutions")
    .leftJoin("dashboard_users", "dashboard_users.id", "error_resolutions.resolved_by")
    .select([
      "error_resolutions.fingerprint",
      "error_resolutions.resolved_at",
      "dashboard_users.name",
    ])
    .where("error_resolutions.project_id", "=", projectId)
    .where("error_resolutions.fingerprint", "in", fingerprints)
    .execute();
  return new Map(
    rows.map((row) => [row.fingerprint, { resolvedAt: row.resolved_at, resolvedBy: row.name }]),
  );
}

/**
 * Regressions use the latest occurrence across environments, matching
 * alerts/error-rules.ts.
 */
export function statusOf(
  lastSeen: Date,
  resolution: { resolvedAt: Date } | undefined,
): ErrorStatus {
  if (resolution === undefined) return "unresolved";
  return lastSeen > resolution.resolvedAt ? "regressed" : "resolved";
}

async function toGroups(
  reader: Reader,
  db: Kysely<Database>,
  range: ErrorRange,
  rows: RangeRow[],
): Promise<ErrorGroup[]> {
  const fingerprints = rows.map((row) => row.fingerprint);
  const [times, resolved, assignees] = await Promise.all([
    seen(reader, range.projectId, range.environment, fingerprints),
    resolutions(db, range.projectId, fingerprints),
    assigneesOf(db, range.projectId, fingerprints),
  ]);
  return rows.map((row) => {
    const time = times.get(row.fingerprint);
    // The group has occurrences; the fallback satisfies the type checker.
    const lastSeen = time?.lastSeen ?? range.to;
    const resolution = resolved.get(row.fingerprint);
    const status = statusOf(time?.lastAnywhere ?? lastSeen, resolution);
    return {
      fingerprint: row.fingerprint,
      type: row.type,
      message: row.message,
      occurrences: count(row.occurrences),
      users: count(row.users),
      visitors: count(row.visitors),
      firstSeen: time?.firstSeen ?? range.from,
      lastSeen,
      status,
      resolvedAt: resolution?.resolvedAt ?? null,
      resolvedBy: resolution?.resolvedBy ?? null,
      assignee: assignees.get(row.fingerprint) ?? null,
    };
  });
}

/**
 * Include the selected environment and production even without data,
 * so the page can switch back.
 */
export async function errorEnvironments(reader: Reader, range: ErrorRange): Promise<string[]> {
  const params = new QueryParams();
  const rows = await queryRows<{ environment: string }>(
    reader,
    `SELECT environment FROM events
     WHERE project_id = ${params.add(range.projectId, "UUID")}
       AND name = '${ERROR}'
       AND error_fingerprint != ''
       AND ${inRange(params, range)}
     GROUP BY environment
     ORDER BY count() DESC, environment`,
    params,
  );
  const names = rows.map((row) => row.environment);
  for (const name of [range.environment, DEFAULT_ENVIRONMENT]) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Unresolved includes regressions. Apply status and assignee filters to
 * the MAX_GROUPS most recent groups; truncated means more exist.
 */
export async function listErrors(
  reader: Reader,
  db: Kysely<Database>,
  range: ErrorRange,
  status: StatusFilter = "unresolved",
  assignee: AssigneeFilter = null,
): Promise<{ groups: ErrorGroup[]; truncated: boolean }> {
  const read = await groupsInRange(reader, range);
  const rows = read.slice(0, MAX_GROUPS);
  const groups = await toGroups(reader, db, range, rows);
  const wanted = groups.filter(
    (group) =>
      (status === "all" || (group.status === "resolved") === (status === "resolved")) &&
      (assignee === null ||
        (assignee.kind === "none"
          ? group.assignee === null
          : group.assignee?.id === assignee.userId)),
  );
  return { groups: wanted, truncated: read.length > MAX_GROUPS };
}

/**
 * Whether the project has any error at all, in any environment, within retention: the list's
 * "No errors yet" when not. One row is enough; events are ordered by project first.
 */
export async function anyError(reader: Reader, projectId: string): Promise<boolean> {
  const params = new QueryParams();
  const rows = await queryRows<{ found: number }>(
    reader,
    `SELECT 1 AS found FROM events
     WHERE project_id = ${params.add(projectId, "UUID")}
       AND name = '${ERROR}'
       AND error_fingerprint != ''
     LIMIT 1`,
    params,
  );
  return rows.length > 0;
}

/** Whose groups the list shows: everyone's (null), one user's, or nobody's. */
export type AssigneeFilter = { kind: "user"; userId: string } | { kind: "none" } | null;

export interface ErrorDay {
  /** "YYYY-MM-DD" in the instance's timezone. */
  day: string;
  occurrences: number;
}

export interface Occurrence {
  eventId: string;
  occurredAt: Date;
  /** Messages may differ in the parts the fingerprint ignores. */
  message: string;
  handled: boolean;
  path: string;
  userId: string | null;
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  deviceType: string | null;
  country: string | null;
  release: string | null;
  /** The session replay its page sent with it, if any (docs/session-replay.md). */
  replayId: string | null;
  /** OTLP service (docs/telemetry.md); null for browser errors. */
  service: string | null;
  /** A server's trace and span, or a browser's page load's (data-traces); null without one. */
  traceId: string | null;
  spanId: string | null;
  /** A browser's last requests before it, oldest first (data-traces); empty for others. */
  requests: { method: string; path: string; status: number; durationMs: number; traceId: string }[];
}

export type ErrorSource = "browser" | "server";

export interface BreakdownRow {
  value: string | null;
  occurrences: number;
}

export interface ErrorDetail {
  group: ErrorGroup;
  days: ErrorDay[];
  breakdowns: {
    path: BreakdownRow[];
    browser: BreakdownRow[];
    os: BreakdownRow[];
    release: BreakdownRow[];
    /** A server's exceptions' services; null for a browser's errors. */
    service: BreakdownRow[];
  };
  occurrences: Occurrence[];
  /** Determines whether to parse the latest stack as browser or server format. */
  source: ErrorSource;
  /** The latest occurrence's stack, as the browser or server wrote it; null without one. */
  stack: string | null;
}

export const RECENT_OCCURRENCES = 20;
export const BREAKDOWN_ROWS = 5;

function eachDay(firstDay: string, lastDay: string): string[] {
  const days: string[] = [];
  const end = Date.parse(`${lastDay}T00:00:00Z`);
  for (let time = Date.parse(`${firstDay}T00:00:00Z`); time <= end; time += 86_400_000) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

const BREAKDOWN_COLUMNS = {
  path: "nullIf(path, '')",
  browser: "browser",
  os: "os",
  release: "release",
  service: "nullIf(service, '')",
} as const;

const breakdown = (rows: { value: string | null; occurrences: string }[] | undefined) =>
  (rows ?? []).map((item) => ({ value: item.value, occurrences: count(item.occurrences) }));

/** Return null if the group has no occurrence in the range. */
export async function errorDetail(
  reader: Reader,
  db: Kysely<Database>,
  range: ErrorRange,
  fingerprint: string,
): Promise<ErrorDetail | null> {
  const [row] = await groupsInRange(reader, range, fingerprint);
  if (row === undefined) return null;
  const scoped = (params: QueryParams) =>
    `${errorScope(params, range.projectId, range.environment)}
     AND error_fingerprint = ${params.add(fingerprint, "String")}
     AND ${inRange(params, range)}`;

  const dayParams = new QueryParams();
  const occurrenceParams = new QueryParams();
  const [groups, dayRows, occurrenceRows, ...breakdownRows] = await Promise.all([
    toGroups(reader, db, range, [row]),
    queryRows<{ day: string; occurrences: string }>(
      reader,
      `SELECT toString(toDate(occurred_at, ${dayParams.add(range.timeZone, "String")})) AS day,
              count() AS occurrences
       FROM events FINAL
       WHERE ${scoped(dayParams)}
       GROUP BY day`,
      dayParams,
    ),
    queryRows<{
      event_id: string;
      occurred_at: string;
      error_message: string;
      error_handled: boolean;
      error_stack: string;
      path: string;
      user_id: string | null;
      browser: string | null;
      browser_version: string | null;
      os: string | null;
      device_type: string | null;
      country: string | null;
      release: string | null;
      replay_id: string | null;
      service: string;
      trace_id: string;
      span_id: string;
      error_requests: BrowserRequest[];
    }>(
      reader,
      `SELECT event_id, occurred_at, error_message, error_handled, error_stack, path, user_id,
              browser, browser_version, os, device_type, country, release, replay_id,
              service, trace_id, span_id, error_requests
       FROM events FINAL
       WHERE ${scoped(occurrenceParams)}
       ORDER BY occurred_at DESC, event_id DESC
       LIMIT ${RECENT_OCCURRENCES}`,
      occurrenceParams,
    ),
    ...Object.values(BREAKDOWN_COLUMNS).map((column) => {
      const params = new QueryParams();
      // The column expressions are the constants above, never input.
      return queryRows<{ value: string | null; occurrences: string }>(
        reader,
        `SELECT ${column} AS value, count() AS occurrences
         FROM events FINAL
         WHERE ${scoped(params)}
         GROUP BY value
         ORDER BY occurrences DESC, value
         LIMIT ${BREAKDOWN_ROWS}`,
        params,
      );
    }),
  ]);

  const perDay = new Map(dayRows.map((day) => [day.day, count(day.occurrences)]));
  const [group] = groups;
  if (group === undefined) return null;
  return {
    group,
    days: eachDay(range.firstDay, range.lastDay).map((day) => ({
      day,
      occurrences: perDay.get(day) ?? 0,
    })),
    breakdowns: {
      path: breakdown(breakdownRows[0]),
      browser: breakdown(breakdownRows[1]),
      os: breakdown(breakdownRows[2]),
      release: breakdown(breakdownRows[3]),
      service: breakdown(breakdownRows[4]),
    },
    occurrences: occurrenceRows.map((occurrence) => ({
      eventId: occurrence.event_id,
      occurredAt: fromClickHouseTime(occurrence.occurred_at),
      message: occurrence.error_message,
      handled: occurrence.error_handled,
      path: occurrence.path,
      userId: occurrence.user_id,
      browser: occurrence.browser,
      browserVersion: occurrence.browser_version,
      os: occurrence.os,
      deviceType: occurrence.device_type,
      country: occurrence.country,
      release: occurrence.release,
      replayId: occurrence.replay_id,
      service: occurrence.service || null,
      traceId: occurrence.trace_id || null,
      spanId: occurrence.span_id || null,
      requests: occurrence.error_requests.map((request) => ({
        method: request.method,
        path: request.path,
        status: request.status,
        durationMs: request.duration_ms,
        traceId: request.trace_id,
      })),
    })),
    source: (occurrenceRows[0]?.service ?? "") === "" ? "browser" : "server",
    stack: occurrenceRows[0]?.error_stack || null,
  };
}

/** Return the resolution, or null after marking unresolved. */
export async function setResolution(
  db: Kysely<Database>,
  options: { projectId: string; fingerprint: string; resolved: boolean; userId: string },
): Promise<{ resolvedAt: Date } | null> {
  const { projectId, fingerprint, resolved, userId } = options;
  // Regressed-error alerts guard the resolution they fired for; another one starts afresh.
  await forgetRegressions(db, projectId, fingerprint);
  if (!resolved) {
    await db
      .deleteFrom("error_resolutions")
      .where("project_id", "=", projectId)
      .where("fingerprint", "=", fingerprint)
      .execute();
    return null;
  }
  const row = await db
    .insertInto("error_resolutions")
    .values({ project_id: projectId, fingerprint, resolved_by: userId })
    .onConflict((conflict) =>
      conflict.columns(["project_id", "fingerprint"]).doUpdateSet((update) => ({
        resolved_at: update.fn<Date>("now"),
        resolved_by: update.ref("excluded.resolved_by"),
      })),
    )
    .returning("resolved_at")
    .executeTakeFirstOrThrow();
  return { resolvedAt: row.resolved_at };
}

/** Count each occurrence once with FINAL for overview comparisons. */
export async function countOccurrences(
  reader: Reader,
  scope: { projectId: string; environment: string; from: Date; to: Date },
): Promise<number> {
  const params = new QueryParams();
  const [row] = await queryRows<{ occurrences: string }>(
    reader,
    `SELECT count() AS occurrences
     FROM events FINAL
     WHERE ${errorScope(params, scope.projectId, scope.environment)}
       AND occurred_at >= ${params.time(scope.from)} AND occurred_at < ${params.time(scope.to)}`,
    params,
  );
  return count(row?.occurrences ?? 0);
}

/** Whether the project has ever had an error in the environment, within what it keeps. */
export async function hasErrors(
  reader: Reader,
  projectId: string,
  environment: string,
): Promise<boolean> {
  const params = new QueryParams();
  const rows = await queryRows<{ found: number }>(
    reader,
    `SELECT 1 AS found FROM events
     WHERE ${errorScope(params, projectId, environment)}
     LIMIT 1`,
    params,
  );
  return rows.length > 0;
}

/**
 * Count all groups and first-seen groups, without the MAX_GROUPS cap.
 * First-seen times use retained history in this environment up to `to`.
 */
export async function countGroups(
  reader: Reader,
  scope: { projectId: string; environment: string; from: Date; to: Date },
): Promise<{ seen: number; new: number }> {
  const params = new QueryParams();
  const from = params.time(scope.from);
  const [row] = await queryRows<{ seen: string; first_seen_in_range: string }>(
    reader,
    `SELECT count() AS seen, countIf(first >= ${from}) AS first_seen_in_range
     FROM (
       SELECT error_fingerprint, min(occurred_at) AS first, max(occurred_at) AS last
       FROM events
       WHERE ${errorScope(params, scope.projectId, scope.environment)}
         AND occurred_at < ${params.time(scope.to)}
       GROUP BY error_fingerprint
       HAVING last >= ${from}
     )`,
    params,
  );
  return { seen: count(row?.seen ?? 0), new: count(row?.first_seen_in_range ?? 0) };
}
