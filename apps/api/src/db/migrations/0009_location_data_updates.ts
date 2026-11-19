import { type Kysely, sql } from "kysely";

/**
 * Automatic updates of the location database and the data-center ranges
 * (docs/web-analytics.md, "Keeping the files current").
 *
 * - instance_settings.update_location_data: whether the worker downloads
 *   new files; on by default. The manual command works either way.
 * - location_data_updates: one row per file ("locations", "data_centers"),
 *   written by whoever updates it (the worker or the manual command): the
 *   last attempt, the last success, what the file holds, and the last
 *   error, and how many attempts in a row failed. No row means no update
 *   has run yet.
 * - location_data_lease: one row while an update runs, so only one runs
 *   at a time; it expires on its own if its process dies.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table instance_settings
      add column update_location_data boolean not null default true
  `.execute(db);
  await sql`
    create table location_data_updates (
      kind             text        primary key
                                   check (kind in ('locations', 'data_centers')),
      last_attempt_at  timestamptz not null,
      last_success_at  timestamptz,
      version          text        check (length(version) <= 100),
      built_at         timestamptz,
      providers        integer,
      file_size        bigint,
      file_modified_at timestamptz,
      last_error       text        check (length(last_error) <= 2000),
      failures         integer     not null default 0 check (failures >= 0)
    )
  `.execute(db);
  await sql`
    create table location_data_lease (
      id         boolean     primary key default true check (id),
      holder     text        not null,
      expires_at timestamptz not null
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table location_data_lease`.execute(db);
  await sql`drop table location_data_updates`.execute(db);
  await sql`alter table instance_settings drop column update_location_data`.execute(db);
}
