import type { Kysely } from "kysely";

import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { rebuildFirstSeen } from "../clickhouse/delete-events.ts";
import {
  clickHouseTime,
  fromClickHouseTime,
  QueryParams,
  queryRows,
  type Reader,
  runCommand,
} from "../clickhouse/query.ts";
import type { Database } from "../db/schema.ts";
import { DASHBOARD_SETTINGS } from "../telemetry/dashboard-query.ts";
import {
  ENGAGEMENT,
  PAGEVIEW,
  VISIT_CONTEXT_MS,
  VISIT_TIMEOUT_MS,
  VITALS,
} from "../visits/visits.ts";

/**
 * ClickHouse limits statement URLs to 1 MiB. Deletes use VISITS_PER_STATEMENT
 * chunks, each taking seconds (docs/clickhouse.md, "Retention and deleting a project").
 * Refuse larger requests so users can narrow the period or filters.
 */
export const MAX_VISITS_PER_DELETE = 10_000;
export const VISITS_PER_STATEMENT = 2_000;

/**
 * Include unmerged retries whose timestamps differ by network delay
 * (docs/clickhouse.md, "Each event once"). Padding stays below the visit gap
 * so it cannot reach another visit.
 */
export const VISIT_PADDING_MS = VISIT_TIMEOUT_MS / 3;

/** What picks the visits to delete. Every filter given must match one event of the visit. */
export interface SpamFilters {
  projectId: string;
  /** The period: the start of its first day and the end of its last, in the instance's timezone. */
  from: Date;
  to: Date;
  /** A referrer domain; its subdomains match too. */
  referrerDomain?: string | undefined;
  path?: string | undefined;
  /** An ISO 3166-1 country code, such as "DE". */
  country?: string | undefined;
}

export interface SpamCounts {
  visits: number;
  events: number;
  pageviews: number;
  customEvents: number;
  errors: number;
  /** Time-on-page reports and Web Vitals. */
  other: number;
  /** Session replays recorded for the visits' errors. */
  replays: number;
}

interface VisitRow {
  environment: string;
  visitor: string;
  started_at: string;
  ended_at: string;
  events: string;
  pageviews: string;
  custom: string;
  errors: string;
  with_user: string;
  replays: string[];
}

/**
 * ClickHouse SQL for the visits that match the filters: each visitor's run
 * of events of any kind (errors and Web Vitals included, so they go with
 * their visit) with no gap over 30 minutes, per environment, as the visits
 * of reports (visits/visits.ts); kept when one of its events in the period
 * matches every filter. Visitor IDs change at midnight, so a visit lies
 * within one local day: reading VISIT_CONTEXT_MS around the period sees
 * each such visit whole. Server-side events have no visitor and belong to
 * no visit: they are never deleted here.
 */
function visitsSql(filters: SpamFilters, params: QueryParams): string {
  const hit = [
    `occurred_at >= ${params.time(filters.from)}`,
    `occurred_at < ${params.time(filters.to)}`,
  ];
  if (filters.referrerDomain !== undefined) {
    const domain = params.add(filters.referrerDomain, "String");
    hit.push(
      `referrer IS NOT NULL`,
      `(lower(domain(assumeNotNull(referrer))) = ${domain}
        OR endsWith(lower(domain(assumeNotNull(referrer))), concat('.', ${domain})))`,
    );
  }
  if (filters.path !== undefined) hit.push(`path = ${params.add(filters.path, "String")}`);
  if (filters.country !== undefined) {
    hit.push(`country = ${params.add(filters.country, "String")}`);
  }
  const order = "occurred_at, event_id";
  return `
    WITH range_events AS (
      SELECT event_id, environment, assumeNotNull(visitor_id) AS visitor, occurred_at, name,
             error_fingerprint != '' AS is_error, replay_id, user_id IS NOT NULL AS has_user,
             (${hit.join(" AND ")}) AS hit
      FROM events FINAL
      WHERE project_id = ${params.add(filters.projectId, "UUID")}
        AND visitor_id IS NOT NULL
        AND occurred_at >= ${params.time(new Date(filters.from.getTime() - VISIT_CONTEXT_MS))}
        AND occurred_at < ${params.time(new Date(filters.to.getTime() + VISIT_CONTEXT_MS))}
    ),
    marked AS (
      SELECT *,
             if(dateDiff('millisecond',
                         lagInFrame(occurred_at, 1, toDateTime64(0, 3, 'UTC')) OVER (
                           PARTITION BY environment, visitor ORDER BY ${order}
                           ROWS BETWEEN 1 PRECEDING AND CURRENT ROW),
                         occurred_at) > ${VISIT_TIMEOUT_MS}, 1, 0) AS starts_visit
      FROM range_events
    ),
    numbered AS (
      SELECT *,
             sum(starts_visit) OVER (PARTITION BY environment, visitor ORDER BY ${order}
                                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS visit
      FROM marked
    )
    SELECT environment, toString(visitor) AS visitor,
           min(occurred_at) AS started_at, max(occurred_at) AS ended_at,
           count() AS events,
           countIf(name = '${PAGEVIEW}' AND NOT is_error) AS pageviews,
           countIf(name NOT IN ('${PAGEVIEW}', '${ENGAGEMENT}', '${VITALS}') AND NOT is_error) AS custom,
           countIf(is_error) AS errors,
           countIf(has_user) AS with_user,
           arrayMap(id -> toString(id), groupUniqArrayIf(assumeNotNull(replay_id), replay_id IS NOT NULL)) AS replays
    FROM numbered
    GROUP BY environment, visitor, visit
    HAVING max(hit) = 1`;
}

/** Read-only and bounded, as the dashboard's reports: a period too large answers 503. */
const FIND_SETTINGS = DASHBOARD_SETTINGS;

export async function countSpamVisits(
  clickhouse: ClickHouseClient,
  filters: SpamFilters,
): Promise<SpamCounts> {
  const params = new QueryParams();
  const [row] = await queryRows<Record<string, string>>(
    { client: clickhouse },
    `SELECT count() AS total_visits, sum(events) AS total_events,
            sum(pageviews) AS total_pageviews, sum(custom) AS total_custom,
            sum(errors) AS total_errors, sum(length(replays)) AS total_replays
     FROM (${visitsSql(filters, params)})`,
    params,
    FIND_SETTINGS,
  );
  const total = (name: string) => Number(row?.[`total_${name}`] ?? 0);
  const events = total("events");
  const pageviews = total("pageviews");
  const customEvents = total("custom");
  const errors = total("errors");
  return {
    visits: total("visits"),
    events,
    pageviews,
    customEvents,
    errors,
    other: events - pageviews - customEvents - errors,
    replays: total("replays"),
  };
}

export type SpamDeletion =
  | {
      ok: true;
      counts: SpamCounts;
      replaysDeleted: number;
    }
  /**
   * Nothing deleted: past MAX_VISITS_PER_DELETE visits, or not the number
   * the user confirmed (visits came or went since the preview).
   */
  | { ok: false; reason: "too_many" | "changed"; visits: number };

/**
 * A delete that failed partway: the visits of `deletedVisits` went (whole
 * statements: a statement is applied completely or not at all), the rest
 * did not. Their replays were deleted and first-seen times worked out
 * again as far as those steps succeeded.
 */
export class PartialSpamDeletionError extends Error {
  override name = "PartialSpamDeletionError";
  readonly deletedVisits: number;
  readonly totalVisits: number;
  constructor(deletedVisits: number, totalVisits: number, options: { cause: unknown }) {
    super(`Deleted ${deletedVisits} of ${totalVisits} visits before a failure`, options);
    this.deletedVisits = deletedVisits;
    this.totalVisits = totalVisits;
  }
}

export interface VisitBounds {
  environment: string;
  /** The visitor ID, a 64-bit integer as text. */
  visitor: string;
  startedAt: Date;
  endedAt: Date;
}

/**
 * Filters project first for the index. Expand each visit by VISIT_PADDING_MS
 * to include retries while excluding events in other visits.
 */
export function visitsWhere(
  projectId: string,
  visits: readonly VisitBounds[],
  params: QueryParams,
): string {
  const starts = visits.map((visit) => new Date(visit.startedAt.getTime() - VISIT_PADDING_MS));
  const ends = visits.map((visit) => new Date(visit.endedAt.getTime() + VISIT_PADDING_MS));
  const timeArray = "Array(DateTime64(3, 'UTC'))";
  const environments = params.add(
    visits.map((visit) => visit.environment),
    "Array(String)",
  );
  const visitors = params.add(
    visits.map((visit) => BigInt(visit.visitor)),
    "Array(Int64)",
  );
  const firsts = params.add(starts.map(clickHouseTime), timeArray);
  const lasts = params.add(ends.map(clickHouseTime), timeArray);
  const lowest = new Date(Math.min(...starts.map((date) => date.getTime())));
  const highest = new Date(Math.max(...ends.map((date) => date.getTime())));
  return `project_id = ${params.add(projectId, "UUID")}
     AND occurred_at >= ${params.time(lowest)}
     AND occurred_at <= ${params.time(highest)}
     AND visitor_id IS NOT NULL
     AND has(${visitors}, assumeNotNull(visitor_id))
     AND arrayExists((environment_, visitor_, first_, last_) ->
           environment_ = environment AND visitor_ = assumeNotNull(visitor_id)
           AND occurred_at >= first_ AND occurred_at <= last_,
         ${environments}, ${visitors}, ${firsts}, ${lasts})`;
}

/**
 * Deletes every event of the visits that match the filters, whole: a spam
 * visit's time-on-page reports, Web Vitals, and errors go with its
 * pageviews. Works the visits out again, as the preview did, then deletes
 * them by visitor and time, VISITS_PER_STATEMENT per lightweight DELETE,
 * filtered by project first, as retention does. Reads with FINAL stop
 * seeing them at once; the worker's APPLY DELETED MASK takes them off the
 * disk (clickhouse/delete-events.ts). When the visits had signed-in users,
 * the project's first-seen times are worked out again. Refuses, deleting
 * nothing, past MAX_VISITS_PER_DELETE visits, or when the visits found are
 * not `expectedVisits`, the number the user confirmed. The replays of the
 * visits' errors go through `deleteReplays`. A failure partway throws
 * PartialSpamDeletionError, after the visits that went have taken their
 * replays and first-seen times with them. A visit still going on keeps the
 * events that arrive after it is found.
 */
export async function deleteSpamVisits(
  db: Kysely<Database>,
  clickhouse: ClickHouseClient,
  filters: SpamFilters,
  expectedVisits: number,
  options: {
    /** Deletes these replays (the visits' errors' recordings); how many there were. */
    deleteReplays?: (replayIds: string[]) => Promise<number>;
  } = {},
): Promise<SpamDeletion> {
  const reader: Reader = { client: clickhouse };
  const params = new QueryParams();
  const visits = await queryRows<VisitRow>(
    reader,
    `SELECT * FROM (${visitsSql(filters, params)}) ORDER BY started_at
     LIMIT ${MAX_VISITS_PER_DELETE + 1}`,
    params,
    FIND_SETTINGS,
  );
  if (visits.length > MAX_VISITS_PER_DELETE) {
    return { ok: false, reason: "too_many", visits: visits.length };
  }
  if (visits.length !== expectedVisits) {
    return { ok: false, reason: "changed", visits: visits.length };
  }

  // Clean up replays and first-seen times in finally, including after partial failure.
  let deleted = 0;
  let replaysDeleted = 0;
  let failure: unknown;
  try {
    for (let start = 0; start < visits.length; start += VISITS_PER_STATEMENT) {
      const chunk = visits.slice(start, start + VISITS_PER_STATEMENT);
      const statement = new QueryParams();
      await runCommand(
        reader,
        `DELETE FROM events WHERE ${visitsWhere(filters.projectId, chunk.map(boundsOf), statement)}`,
        statement,
      );
      deleted += chunk.length;
    }
  } catch (error) {
    failure = error;
  } finally {
    const gone = visits.slice(0, deleted);
    try {
      if (gone.some((visit) => Number(visit.with_user) > 0)) {
        await rebuildFirstSeen(db, clickhouse, [filters.projectId]);
      }
      const goneReplays = [...new Set(gone.flatMap((visit) => visit.replays))];
      if (options.deleteReplays !== undefined && goneReplays.length > 0) {
        replaysDeleted = await options.deleteReplays(goneReplays);
      }
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) {
    throw new PartialSpamDeletionError(deleted, visits.length, { cause: failure });
  }

  const sum = (column: "events" | "pageviews" | "custom" | "errors") =>
    visits.reduce((total, visit) => total + Number(visit[column]), 0);
  const replays = new Set(visits.flatMap((visit) => visit.replays)).size;
  const events = sum("events");
  const pageviews = sum("pageviews");
  const customEvents = sum("custom");
  const errors = sum("errors");
  return {
    ok: true,
    counts: {
      visits: visits.length,
      events,
      pageviews,
      customEvents,
      errors,
      other: events - pageviews - customEvents - errors,
      replays,
    },
    replaysDeleted,
  };
}

function boundsOf(visit: VisitRow): VisitBounds {
  return {
    environment: visit.environment,
    visitor: visit.visitor,
    startedAt: fromClickHouseTime(visit.started_at),
    endedAt: fromClickHouseTime(visit.ended_at),
  };
}
