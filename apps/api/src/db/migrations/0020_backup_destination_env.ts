import { type Kysely, sql } from "kysely";

/**
 * Scheduled backups' destination moves from the Backups tab into the
 * worker's environment, BACKUP_S3_* (docs/deployment.md, "Scheduled
 * backups"; config.ts, parseBackupS3): a bucket of its own, with a key
 * only the worker holds, so a key the internet-facing API holds can't
 * delete the backups.
 *
 * - Dropped from backup_settings: the destination the tab saved (bucket,
 *   prefix, endpoint, region, access_key_id) and its sealed secret.
 * - Added, written by the worker alone (backups/job.ts), since the API
 *   can't see its environment: what it reports of BACKUP_S3_*
 *   (`destination`, the non-secret parts as JSON, or
 *   `destination_problem`, what is wrong in words, and when); Test
 *   connection, which the tab asks for (`connection_test_requested_at`)
 *   and the worker runs with its own variables (`connection_test`, each
 *   step's result, and when); and the folder's backups as it last listed
 *   them (`backup_list`, and when).
 *
 * - storage_warnings takes `backup_destination`: backups are on, and the
 *   worker reports no destination or a problem (storage/warnings.ts).
 *
 * Nothing is live, so nothing the tab saved is carried over.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table backup_settings
      drop column bucket,
      drop column prefix,
      drop column endpoint,
      drop column region,
      drop column access_key_id,
      drop column secret_sealed,
      add column destination                  jsonb,
      add column destination_problem          text,
      add column destination_reported_at      timestamptz,
      add column connection_test_requested_at timestamptz,
      add column connection_test              jsonb,
      add column connection_tested_at         timestamptz,
      add column backup_list                  jsonb,
      add column backup_listed_at             timestamptz,
      add constraint backup_settings_destination_check
        check (destination is null or destination_problem is null)
  `.execute(db);
  await sql`
    alter table storage_warnings
      drop constraint storage_warnings_warning_check,
      add constraint storage_warnings_warning_check check (warning in ('merge_headroom',
        'backup_space', 'disk_used', 'replay_budget', 'source_map_budget', 'budgets_exceed_disk',
        'backup_failed', 'backup_overdue', 'backup_destination'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from storage_warnings where warning = 'backup_destination'`.execute(db);
  await sql`
    alter table storage_warnings
      drop constraint storage_warnings_warning_check,
      add constraint storage_warnings_warning_check check (warning in ('merge_headroom',
        'backup_space', 'disk_used', 'replay_budget', 'source_map_budget', 'budgets_exceed_disk',
        'backup_failed', 'backup_overdue'))
  `.execute(db);
  await sql`
    alter table backup_settings
      drop constraint backup_settings_destination_check,
      drop column destination,
      drop column destination_problem,
      drop column destination_reported_at,
      drop column connection_test_requested_at,
      drop column connection_test,
      drop column connection_tested_at,
      drop column backup_list,
      drop column backup_listed_at,
      add column bucket        text,
      add column prefix        text not null default 'ottertrail-backups'
        constraint backup_settings_prefix_check check (char_length(prefix) <= 200),
      add column endpoint      text,
      add column region        text,
      add column access_key_id text,
      add column secret_sealed text
  `.execute(db);
}
