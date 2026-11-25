import { type Kysely, sql } from "kysely";

/**
 * Deleting one known user's data (identities/deletions.ts, docs/data.md):
 * one row per request, which the worker takes (FOR UPDATE SKIP LOCKED),
 * leases, and retries until it is done.
 *
 * - user_id: the end user's ID, as the app sends it, only while the
 *   deletion is pending; cleared when it is done, since keeping it would
 *   keep the personal data the deletion was for. The check holds the two
 *   together.
 * - requested_by: the dashboard user who asked, null once that user is
 *   removed, or when the project's secret key asked (requested_with).
 * - One pending deletion per project and user: asking again while one is
 *   pending answers that one.
 * - Kept after it is done, as the record of when and by whom; deleted with
 *   the project.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table user_deletions (
      id               uuid        primary key default gen_random_uuid(),
      project_id       uuid        not null references projects (id) on delete cascade,
      user_id          text        check (char_length(user_id) between 1 and 200),
      requested_at     timestamptz not null default now(),
      requested_by     uuid        references dashboard_users (id) on delete set null,
      requested_with   text        not null check (requested_with in ('dashboard', 'secret_key')),
      attempts         integer     not null default 0,
      next_attempt_at  timestamptz not null default now(),
      last_error       text,
      completed_at     timestamptz,
      check ((completed_at is null) = (user_id is not null))
    )
  `.execute(db);
  await sql`
    create unique index user_deletions_pending_idx on user_deletions (project_id, user_id)
      where completed_at is null
  `.execute(db);
  await sql`
    create index user_deletions_due_idx on user_deletions (next_attempt_at)
      where completed_at is null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table user_deletions`.execute(db);
}
