import { type Kysely, sql } from "kysely";

/**
 * Shared links (docs/web-analytics.md, "Shared links"): a secret address
 * that shows one project's Web analytics, read-only, to anyone who has it.
 *
 * Only the token's SHA-256 hash is kept, so a copy of the database holds no
 * working link; the link is shown once, when it is made. `token_prefix`,
 * its first characters, tells links apart in the settings. `environment`
 * is the one environment the link shows. Revoking deletes the row, so the
 * link stops at once. A link goes with its project; it stays when the user
 * who made it is removed (`created_by` becomes null).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table share_links (
      id             uuid        primary key default gen_random_uuid(),
      project_id     uuid        not null references projects (id) on delete cascade,
      name           text        not null check (char_length(name) between 1 and 100),
      environment    text        not null
        check (environment ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
      token_hash     bytea       not null check (octet_length(token_hash) = 32),
      token_prefix   text        not null check (char_length(token_prefix) = 6),
      created_by     uuid        references dashboard_users (id) on delete set null,
      created_at     timestamptz not null default now(),
      last_opened_at timestamptz
    )
  `.execute(db);
  await sql`create unique index share_links_token_hash on share_links (token_hash)`.execute(db);
  await sql`create index share_links_project_id on share_links (project_id, created_at)`.execute(
    db,
  );
  // Removing a user sets their links' creator to null through this index.
  await sql`create index share_links_created_by on share_links (created_by)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table share_links`.execute(db);
}
