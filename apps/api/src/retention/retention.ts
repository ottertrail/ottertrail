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
 * Deletes each project's events older than its retention (projects with
 * none keep everything) from ClickHouse. The cut-off is a midnight in the
 * instance's timezone, retention_days days before
 * today there, so a report never shows a day with only some of its events.
 * The rows leave reports at once and the disk with removeDeletedRows(),
 * which the worker runs after this. Running this twice, or in two
 * processes at once, is harmless.
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

  // Every project in one statement, which takes seconds however many there are.
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
