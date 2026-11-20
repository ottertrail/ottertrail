import { type Kysely, sql } from "kysely";

/**
 * Scheduled backups (docs/deployment.md, "Backups"; backups/).
 *
 * - backup_settings: one row, as instance_settings has. Whether the worker
 *   backs up each day, at what time in the instance's timezone, how many
 *   days it keeps, and where: a bucket and folder (prefix) on the object
 *   store's connection, or on a separate S3-compatible destination with
 *   its endpoint, region, and access key. That key's secret and the backup
 *   key (an age X25519 identity, made when backups are first turned on)
 *   are sealed with a key derived from AUTH_SECRET (backups/secrets.ts);
 *   the key's public half (`key_recipient`) is not secret. The schedule's
 *   bookkeeping (`schedule_from`, `last_slot`, `retry_at`) and the owner's
 *   requests ("Back up now", "Test restore") are here too: the API asks,
 *   the worker runs.
 * - backup_runs: each backup and test restore, its result, and its
 *   heartbeat. One runs at a time, in any number of workers: a unique
 *   index allows one running row.
 * - storage_warnings takes two more warnings: the last backup failed, and
 *   a backup is overdue (storage/warnings.ts).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table backup_settings (
      id                         boolean     primary key default true check (id),
      enabled                    boolean     not null default false,
      time_of_day                text        not null default '03:00'
        constraint backup_settings_time_check check (time_of_day ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
      keep_days                  integer     not null default 14
        constraint backup_settings_keep_check check (keep_days between 1 and 365),
      bucket                     text,
      prefix                     text        not null default 'ottertrail-backups'
        constraint backup_settings_prefix_check check (char_length(prefix) <= 200),
      endpoint                   text,
      region                     text,
      access_key_id              text,
      secret_sealed              text,
      key_sealed                 text,
      key_recipient              text,
      key_created_at             timestamptz,
      key_saved_at               timestamptz,
      schedule_from              timestamptz,
      last_slot                  date,
      retry_at                   timestamptz,
      backup_requested_at        timestamptz,
      test_restore_requested_at  timestamptz,
      updated_at                 timestamptz not null default now(),
      constraint backup_settings_key_check check ((key_sealed is null) = (key_recipient is null))
    )
  `.execute(db);
  await sql`insert into backup_settings default values`.execute(db);

  await sql`
    create table backup_runs (
      id           uuid        primary key default gen_random_uuid(),
      kind         text        not null check (kind in ('backup', 'test_restore')),
      trigger      text        not null check (trigger in ('schedule', 'manual', 'retry')),
      status       text        not null check (status in ('running', 'succeeded', 'failed')),
      started_at   timestamptz not null default now(),
      heartbeat_at timestamptz not null default now(),
      finished_at  timestamptz,
      folder       text,
      bytes        bigint,
      error        text,
      constraint backup_runs_finished_check check ((status = 'running') = (finished_at is null))
    )
  `.execute(db);
  // One run at a time: a second worker's insert fails, and it waits for the next tick.
  await sql`create unique index backup_runs_one_running on backup_runs ((true)) where status = 'running'`.execute(
    db,
  );
  await sql`create index backup_runs_latest on backup_runs (kind, started_at desc)`.execute(db);

  await sql`
    alter table storage_warnings
      drop constraint storage_warnings_warning_check,
      add constraint storage_warnings_warning_check check (warning in ('merge_headroom',
        'backup_space', 'disk_used', 'replay_budget', 'source_map_budget', 'budgets_exceed_disk',
        'backup_failed', 'backup_overdue'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from storage_warnings where warning in ('backup_failed', 'backup_overdue')`.execute(
    db,
  );
  await sql`
    alter table storage_warnings
      drop constraint storage_warnings_warning_check,
      add constraint storage_warnings_warning_check check (warning in ('merge_headroom',
        'backup_space', 'disk_used', 'replay_budget', 'source_map_budget', 'budgets_exceed_disk'))
  `.execute(db);
  await sql`drop table backup_runs`.execute(db);
  await sql`drop table backup_settings`.execute(db);
}
