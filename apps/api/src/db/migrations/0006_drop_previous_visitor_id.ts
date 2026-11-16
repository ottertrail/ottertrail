import { type Kysely, sql } from "kysely";

/**
 * Visits no longer continue across midnight (docs/web-analytics.md,
 * section 6).
 *
 * previous_visitor_id linked a visitor's IDs on two consecutive days. The
 * link outlived the salts, so anyone who could compute today's ID from a
 * guessed address could follow it back to the day before, which broke the
 * promise that an anonymous visitor is never linked across days.
 *
 * The values are cleared before the column is dropped: dropping a column
 * in PostgreSQL only hides it, and its data stays in each row until the
 * row is rewritten.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`update events set previous_visitor_id = null where previous_visitor_id is not null`.execute(
    db,
  );
  await sql`alter table events drop column previous_visitor_id`.execute(db);
}

/** Restores the empty column. The cleared links cannot be restored. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table events add column previous_visitor_id bigint`.execute(db);
}
