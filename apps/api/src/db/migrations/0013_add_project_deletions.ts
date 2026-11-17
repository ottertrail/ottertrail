import { type Kysely, sql } from "kysely";

/**
 * project_deletions: projects deleted whose events ClickHouse may still
 * hold. ClickHouse has no foreign keys, so the worker deletes the events
 * there, then the row (clickhouse/delete-events.ts). No foreign key here
 * either: the project is gone.
 *
 * A trigger adds the row whenever a project row is deleted, in the same
 * transaction, however the delete came about: the API, an organization's
 * delete cascading to its projects, or a hand-written statement.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table project_deletions (
      project_id uuid primary key,
      deleted_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create function record_project_deletion() returns trigger language plpgsql as $$
    begin
      insert into project_deletions (project_id) values (old.id) on conflict do nothing;
      return old;
    end
    $$
  `.execute(db);
  await sql`
    create trigger projects_record_deletion after delete on projects
      for each row execute function record_project_deletion()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop trigger projects_record_deletion on projects`.execute(db);
  await sql`drop function record_project_deletion()`.execute(db);
  await sql`drop table project_deletions`.execute(db);
}
