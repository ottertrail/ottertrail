import { type Kysely, sql } from "kysely";

/**
 * Storage warnings through the instance's notification channels
 * (docs/deployment.md, "Storage warnings"; storage/warning-job.ts).
 *
 * - storage_warning_channels: the channels that get them, one row each;
 *   none by default. A deleted channel leaves the list with its row.
 * - storage_warnings: one row per warning that is on, with its level and
 *   since when. The worker writes it every 5 minutes; a row's start and
 *   its removal are what send `storage.low` and `storage.recovered`.
 * - first_seen_rebuilds: projects whose first-seen times must be worked
 *   out again (clickhouse/delete-events.ts, rebuildFirstSeen). Written
 *   before a rebuild removes anything and deleted once it is done, so a
 *   rebuild skipped for lack of disk, or one that failed part way, is
 *   tried again by the worker.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table storage_warning_channels (
      channel_id uuid primary key references notification_channels (id) on delete cascade
    )
  `.execute(db);
  await sql`
    create table storage_warnings (
      warning    text        primary key
                             check (warning in ('merge_headroom', 'backup_space', 'disk_used',
                               'replay_budget', 'source_map_budget', 'budgets_exceed_disk')),
      level      text        not null check (level in ('warning', 'critical')),
      started_at timestamptz not null,
      updated_at timestamptz not null
    )
  `.execute(db);
  await sql`
    create table first_seen_rebuilds (
      project_id   uuid        primary key references projects (id) on delete cascade,
      requested_at timestamptz not null default now()
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table first_seen_rebuilds`.execute(db);
  await sql`drop table storage_warnings`.execute(db);
  await sql`drop table storage_warning_channels`.execute(db);
}
