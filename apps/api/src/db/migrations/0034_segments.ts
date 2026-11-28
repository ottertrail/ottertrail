import { type Kysely, sql } from "kysely";

/**
 * Saved segments (docs/web-analytics.md, "Segments"): a named set of Web
 * analytics filters, saved for one person or for the project.
 *
 * `filters` holds the filters as the report routes take them, one key per
 * filter and operator with its values (`{"country.not":["DE"]}`). The API
 * checks them on save and again on every read, since the filters allowed
 * can change; here only their form and an upper size.
 *
 * A personal segment has an `owner_id` and goes with its owner. A project
 * segment has none, and stays when the user who made it is removed
 * (`created_by` becomes null). Both go with their project. Names are
 * unique, ignoring case, among a project's segments and among one person's.
 *
 * updated_at is a segment's version, as for saved funnels: a change names
 * the one it read, and is refused when another came first.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table segments (
      id          uuid        primary key default gen_random_uuid(),
      project_id  uuid        not null references projects (id) on delete cascade,
      name        text        not null check (char_length(name) between 1 and 100),
      filters     jsonb       not null
        check (jsonb_typeof(filters) = 'object' and octet_length(filters::text) <= 65536),
      visibility  text        not null check (visibility in ('personal', 'project')),
      owner_id    uuid        references dashboard_users (id) on delete cascade,
      created_by  uuid        references dashboard_users (id) on delete set null,
      created_at  timestamptz not null default now(),
      updated_at  timestamptz not null default date_trunc('milliseconds', now()),
      constraint segments_owner_check check ((visibility = 'personal') = (owner_id is not null))
    )
  `.execute(db);
  await sql`
    create unique index segments_project_name on segments (project_id, lower(name))
      where owner_id is null
  `.execute(db);
  await sql`
    create unique index segments_personal_name on segments (project_id, owner_id, lower(name))
      where owner_id is not null
  `.execute(db);
  // Removing a user deletes their segments and clears created_by through these.
  await sql`create index segments_owner_id on segments (owner_id) where owner_id is not null`.execute(
    db,
  );
  await sql`create index segments_created_by on segments (created_by)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table segments`.execute(db);
}
