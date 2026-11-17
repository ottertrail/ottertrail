import { type Kysely, sql } from "kysely";

/**
 * error_resolutions: the error groups a project's team marked resolved, by
 * fingerprint (errors/fingerprint.ts), and when. A group with no row is
 * unresolved. One that occurs again after resolved_at counts as
 * unresolved again, a regression: worked out when the list is read, so
 * collection never writes here (docs/errors.md, "Status").
 *
 * A status belongs to the project, in every environment. Deleting the
 * project deletes its rows; deleting the dashboard user keeps the row
 * without its name.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table error_resolutions (
      project_id uuid not null references projects (id) on delete cascade,
      fingerprint text not null
        constraint error_resolutions_fingerprint_check
          check (fingerprint ~ '^[0-9]{1,3}-[0-9a-f]{20}$'),
      resolved_at timestamptz not null default now(),
      resolved_by uuid references dashboard_users (id) on delete set null,
      primary key (project_id, fingerprint)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table error_resolutions`.execute(db);
}
