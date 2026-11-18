import { createHash } from "node:crypto";

import { type Kysely, sql } from "kysely";

import { type EventRow, toClickHouse } from "../collection/event-store.ts";
import type { Database } from "../db/schema.ts";
import type { ClickHouseClient } from "./clickhouse.ts";

/** Events per ClickHouse insert: ClickHouse prefers few large inserts. */
export const DRAIN_BATCH_SIZE = 10_000;

/** The PostgreSQL migration that drops the events table. */
export const DROP_EVENTS_MIGRATION = "0024_drop_events";

/** Whether PostgreSQL still has its events table: PostgreSQL migration 0024 drops it. */
export async function hasPostgresEvents(db: Kysely<Database>): Promise<boolean> {
  const { rows } = await sql<{ found: boolean }>`
    select to_regclass('events') is not null as found
  `.execute(db);
  return rows[0]?.found === true;
}

/**
 * Whether this database must copy its events to ClickHouse before
 * migration 0024: that migration has not run (Kysely's record of it, not
 * the table, decides, so a table of that name made later never sends the
 * database back to 0023), and the table is there (a new database has none
 * until its first migration).
 */
export async function needsEventDrain(db: Kysely<Database>): Promise<boolean> {
  const { rows } = await sql<{ found: boolean }>`
    select to_regclass('kysely_migration') is not null as found
  `.execute(db);
  if (rows[0]?.found === true) {
    const applied = await sql<{ applied: boolean }>`
      select exists (select 1 from kysely_migration where name = ${DROP_EVENTS_MIGRATION}) as applied
    `.execute(db);
    if (applied.rows[0]?.applied === true) return false;
  }
  return hasPostgresEvents(db);
}

/**
 * Once, when upgrading: copies the events PostgreSQL received but had not
 * copied to ClickHouse yet (copied_at is null) there, before migration
 * 0024 drops PostgreSQL's table. Until then, events arrived in PostgreSQL
 * and the worker copied them; now they go straight to ClickHouse
 * (docs/clickhouse.md). migrate.ts runs it, with the table at migration
 * 0023's shape; it returns how many it copied, 0 without the table.
 *
 * In batches, each marked copied once ClickHouse has it, as the worker
 * did, so events an API of the earlier version adds meanwhile are copied
 * too, and migration 0024 can check that none is left. Each batch carries
 * a deduplication token made from its events, so a batch sent again after
 * a failure to mark it is dropped by ClickHouse, within its last 1,000
 * inserts; anything else repeated is one row per event once ClickHouse
 * merges (ReplacingMergeTree), and reports read with FINAL. Each project's
 * latest event is recorded too (projects.last_event_at), as the worker did.
 */
export async function drainPostgresEvents(
  db: Kysely<Database>,
  clickhouse: ClickHouseClient,
  { batchSize = DRAIN_BATCH_SIZE }: { batchSize?: number } = {},
): Promise<number> {
  if (!(await hasPostgresEvents(db))) return 0;
  let copied = 0;
  const latest = new Map<string, Date>();
  for (;;) {
    const { rows } = await sql<EventRow>`
      select * from events
      where copied_at is null
      order by project_id, event_id
      limit ${batchSize}
    `.execute(db);
    if (rows.length === 0) break;

    // The same rows always make the same token.
    const token = createHash("sha256")
      .update(rows.map((row) => `${row.project_id}/${row.event_id}`).join("\n"))
      .digest("hex");
    await clickhouse.insert({
      table: "events",
      values: rows.map(toClickHouse),
      format: "JSONEachRow",
      clickhouse_settings: { insert_deduplication_token: token },
    });
    // Two arrays, not a list of 10,000 pairs, which PostgreSQL refuses as
    // too deeply nested ("stack depth limit exceeded").
    await sql`
      update events set copied_at = now()
      from unnest(
        ${rows.map((row) => row.project_id)}::uuid[],
        ${rows.map((row) => row.event_id)}::uuid[]
      ) as copied(project_id, event_id)
      where events.project_id = copied.project_id and events.event_id = copied.event_id
    `.execute(db);
    for (const row of rows) {
      const known = latest.get(row.project_id);
      if (known === undefined || row.occurred_at > known)
        latest.set(row.project_id, row.occurred_at);
    }
    copied += rows.length;
  }
  for (const [projectId, at] of latest) {
    await db
      .updateTable("projects")
      .set({ last_event_at: sql<Date>`greatest(last_event_at, ${at})` })
      .where("id", "=", projectId)
      .execute();
  }
  return copied;
}
