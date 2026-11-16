import { type Kysely, sql } from "kysely";

/**
 * Step 6 of web analytics: visits that cross midnight.
 *
 * Visitor IDs change at midnight in the instance's timezone. For events in
 * the first 30 minutes of a day, ingestion also stores the visitor's ID
 * under the previous day's salt, so the visit query can join a visit that
 * started before midnight with its continuation after it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table events add column previous_visitor_id bigint`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table events drop column previous_visitor_id`.execute(db);
}
