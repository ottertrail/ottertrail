import { type Kysely, sql } from "kysely";

/**
 * events.copied_at: when the worker copied the event to ClickHouse, or null
 * until it has (clickhouse/copy-events.ts). Events still arrive here first:
 * PostgreSQL confirms them and its unique (project_id, event_id) keeps
 * retries out. The partial index holds only the events still to copy, so
 * the worker finds them without reading the rest.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table events add column copied_at timestamptz`.execute(db);
  await sql`
    create index events_to_copy_idx on events (received_at, project_id, event_id)
      where copied_at is null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index events_to_copy_idx`.execute(db);
  await sql`alter table events drop column copied_at`.execute(db);
}
