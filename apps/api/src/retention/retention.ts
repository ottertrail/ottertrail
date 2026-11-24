import { type Kysely, sql } from "kysely";

import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import {
  deleteEventsBefore,
  deleteTelemetryBefore,
  type RoomCheck,
} from "../clickhouse/delete-events.ts";
import type { Database } from "../db/schema.ts";
import { effectiveTelemetryRetentionDays } from "../projects/telemetry-retention.ts";
import { readInstanceSettings } from "../settings/settings.ts";

export interface RetentionResult {
  projectId: string;
  /** Events older than this were deleted: a midnight in the instance's timezone. */
  before: Date;
  /** Rows deleted from ClickHouse (a retry not yet merged away counts twice). */
  deleted: number;
}

/**
 * Delete whole local days to avoid partial report days. Projects without
 * retention keep everything. Reports exclude deleted rows immediately;
 * the worker calls removeDeletedRows() to reclaim disk. Repeated or
 * concurrent runs are safe.
 */
export async function deleteExpiredEvents(
  db: Kysely<Database>,
  clickhouse: ClickHouseClient,
  { now = new Date(), room = {} }: { now?: Date; room?: RoomCheck } = {},
): Promise<RetentionResult[]> {
  const { timeZone } = await readInstanceSettings(db);
  const { rows: projects } = await sql<{ id: string; before: Date }>`
    select projects.id,
           ((${now}::timestamptz at time zone ${timeZone})::date
              - projects.retention_days)::timestamp
             at time zone ${timeZone} as before
    from projects
    where projects.retention_days is not null
    order by projects.id
  `.execute(db);

  const deleted = await deleteEventsBefore(
    db,
    clickhouse,
    projects.map((project) => ({ projectId: project.id, before: project.before })),
    room,
  );
  return projects.map((project) => ({
    projectId: project.id,
    before: project.before,
    deleted: deleted.get(project.id) ?? 0,
  }));
}

export interface TelemetryRetentionResult {
  projectId: string;
  /** Traces, logs, and metrics older than this were deleted: a midnight UTC. */
  before: Date;
  /** Rows deleted from ClickHouse, the four tables together. */
  deleted: number;
}

/**
 * Deletes the traces, logs, and metrics of each project that keeps fewer
 * days than the instance's maximum (`maxDays`, TELEMETRY_RETENTION_DAYS):
 * those from before the midnight UTC that many days ago, the whole days
 * ClickHouse's TTL would drop at that retention (toDateTime(timestamp) +
 * INTERVAL N DAY, by daily part). The TTL drops every project's days past
 * the maximum, so projects at it are left alone. Repeated or concurrent
 * runs are safe.
 */
export async function deleteExpiredTelemetry(
  db: Kysely<Database>,
  clickhouse: ClickHouseClient,
  { maxDays, now = new Date() }: { maxDays: number; now?: Date },
): Promise<TelemetryRetentionResult[]> {
  const projects = await db
    .selectFrom("projects")
    .select(["id", "telemetry_retention_days"])
    .where("telemetry_retention_days", "<", maxDays)
    .orderBy("id")
    .execute();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutOffs = projects.map((project) => ({
    projectId: project.id,
    before: new Date(
      today -
        effectiveTelemetryRetentionDays(project.telemetry_retention_days, maxDays) * 86_400_000,
    ),
  }));
  const deleted = await deleteTelemetryBefore(clickhouse, cutOffs);
  return cutOffs.map((cutOff) => ({ ...cutOff, deleted: deleted.get(cutOff.projectId) ?? 0 }));
}
