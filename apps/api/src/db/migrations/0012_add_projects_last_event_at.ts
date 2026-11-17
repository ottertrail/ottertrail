import { type Kysely, sql } from "kysely";

/**
 * projects.last_event_at: when the project's latest event happened, which
 * the dashboard shows ("Last event 2 minutes ago", or that none has arrived
 * yet). It was worked out from the events table, which will keep only the
 * last day of events once reports read ClickHouse (docs/clickhouse.md), so
 * the worker now records it as it copies events there.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table projects add column last_event_at timestamptz`.execute(db);
  await sql`
    update projects
    set last_event_at = (select max(occurred_at) from events where events.project_id = projects.id)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table projects drop column last_event_at`.execute(db);
}
