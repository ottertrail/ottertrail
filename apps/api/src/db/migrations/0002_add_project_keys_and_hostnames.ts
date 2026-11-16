import { type Kysely, sql } from "kysely";

/**
 * Step 2 of web analytics: what the collection endpoint needs to know about
 * a project.
 *
 * - public_key: identifies the project in requests from browsers. It sits in
 *   every page's HTML, so it is not a secret and only allows sending events.
 *   Existing projects get a generated key.
 * - allowed_hostnames: the sites whose pages may send events, such as
 *   "example.com" and "www.example.com". Empty means nothing is accepted yet.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table projects
      add column public_key text not null unique
        default ('pk_' || replace(gen_random_uuid()::text, '-', ''))
        check (public_key ~ '^pk_[0-9a-f]{32}$'),
      add column allowed_hostnames text[] not null default '{}'
        check (cardinality(allowed_hostnames) <= 50)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table projects
      drop column allowed_hostnames,
      drop column public_key
  `.execute(db);
}
