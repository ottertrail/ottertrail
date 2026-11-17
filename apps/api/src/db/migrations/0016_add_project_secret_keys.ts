import { type Kysely, sql } from "kysely";

/**
 * projects.secret_key: the project's server key ("sk_" and 32 hex
 * characters), for a site's own server. It authenticates server-side events
 * (POST /api/server-events), and signs user IDs (HMAC-SHA256), which
 * Ottertrail checks when require_signed_user_ids is on. Checking a
 * signature means computing it again, so the key itself is stored, not a
 * hash of it (docs/web-analytics.md, "Server-side events").
 *
 * Existing projects get a key each: a volatile default is evaluated per row.
 *
 * events.path may now be null: a server-side event need not happen on a page.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table projects
      add column secret_key text not null
        default ('sk_' || replace(gen_random_uuid()::text, '-', ''))
        constraint projects_secret_key_check check (secret_key ~ '^sk_[0-9a-f]{32}$'),
      add column require_signed_user_ids boolean not null default false
  `.execute(db);
  await sql`create unique index projects_secret_key_idx on projects (secret_key)`.execute(db);
  await sql`alter table events alter column path drop not null`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`update events set path = '/' where path is null`.execute(db);
  await sql`alter table events alter column path set not null`.execute(db);
  await sql`drop index projects_secret_key_idx`.execute(db);
  await sql`alter table projects drop column secret_key, drop column require_signed_user_ids`.execute(
    db,
  );
}
