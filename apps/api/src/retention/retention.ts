import { type Kysely, sql } from "kysely";

import type { Database } from "../db/schema.ts";

/** Events deleted per statement, so no delete holds its locks for long. */
export const DELETE_BATCH_SIZE = 5_000;

export interface RetentionResult {
  projectId: string;
  /** Events older than this were deleted: a midnight in the instance's timezone. */
  before: Date;
  deleted: number;
}

/**
 * Deletes each project's events older than its retention (projects with
 * none keep everything). The cut-off is a midnight in the instance's
 * timezone, retention_days days before today, so a report never shows a
 * day with only some of its events. Deletes run in batches; running this
 * twice, or in two processes at once, is harmless.
 */
export async function deleteExpiredEvents(
  db: Kysely<Database>,
  {
    timeZone,
    now = new Date(),
    batchSize = DELETE_BATCH_SIZE,
  }: { timeZone: string; now?: Date; batchSize?: number },
): Promise<RetentionResult[]> {
  const { rows: projects } = await sql<{ id: string; before: Date }>`
    select id,
           ((${now}::timestamptz at time zone ${timeZone})::date - retention_days)::timestamp
             at time zone ${timeZone} as before
    from projects
    where retention_days is not null
    order by id
  `.execute(db);

  const results: RetentionResult[] = [];
  for (const project of projects) {
    let deleted = 0;
    for (;;) {
      const result = await sql`
        delete from events
        where project_id = ${project.id}
          and event_id in (
            select event_id from events
            where project_id = ${project.id} and occurred_at < ${project.before}
            limit ${batchSize}
          )
      `.execute(db);
      const count = Number(result.numAffectedRows ?? 0);
      deleted += count;
      if (count < batchSize) break;
    }
    results.push({ projectId: project.id, before: project.before, deleted });
  }
  return results;
}
