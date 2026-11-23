import { type Kysely, sql } from "kysely";

import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { deleteEventsBefore, type RoomCheck } from "../clickhouse/delete-events.ts";
import type { Database } from "../db/schema.ts";
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
