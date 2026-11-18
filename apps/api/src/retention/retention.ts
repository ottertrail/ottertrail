import { type Kysely, sql } from "kysely";

import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { deleteEventsBefore } from "../clickhouse/delete-events.ts";
import type { Database } from "../db/schema.ts";

export interface RetentionResult {
  projectId: string;
  /** Events older than this were deleted: a midnight in the organization's timezone. */
  before: Date;
  /** Rows deleted from ClickHouse (a retry not yet merged away counts twice). */
  deleted: number;
}

/**
 * Deletes each project's events older than its retention (projects with
 * none keep everything) from ClickHouse. The cut-off is a midnight in the
 * timezone of the project's organization, retention_days days before
 * today there, so a report never shows a day with only some of its events.
 * The rows leave reports at once and the disk with removeDeletedRows(),
 * which the worker runs after this. Running this twice, or in two
 * processes at once, is harmless.
 */
export async function deleteExpiredEvents(
  db: Kysely<Database>,
  clickhouse: ClickHouseClient,
  { now = new Date() }: { now?: Date } = {},
): Promise<RetentionResult[]> {
  const { rows: projects } = await sql<{ id: string; before: Date }>`
    select projects.id,
           ((${now}::timestamptz at time zone organizations.time_zone)::date
              - projects.retention_days)::timestamp
             at time zone organizations.time_zone as before
    from projects
    join organizations on organizations.id = projects.organization_id
    -- A timezone PostgreSQL does not know (the API refuses to store one)
    -- skips that organization instead of failing every organization's run.
    join pg_timezone_names on pg_timezone_names.name = organizations.time_zone
    where projects.retention_days is not null
    order by projects.id
  `.execute(db);

  // Every project in one statement, which takes seconds however many there are.
  const deleted = await deleteEventsBefore(
    clickhouse,
    projects.map((project) => ({ projectId: project.id, before: project.before })),
  );
  return projects.map((project) => ({
    projectId: project.id,
    before: project.before,
    deleted: deleted.get(project.id) ?? 0,
  }));
}
