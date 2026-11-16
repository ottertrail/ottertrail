import { type Kysely, sql } from "kysely";

/**
 * Step 5 of web analytics: counting unique visitors without cookies.
 *
 * - visitor_salts: one random secret per day, in the instance's timezone.
 *   A salt is deleted once no event can still need it, after which nobody
 *   can tell which IP address a visitor ID came from.
 * - events.visitor_id: a keyed hash of that day's salt, the project, the
 *   client's IP address, and its User-Agent. Neither the IP address nor
 *   the salt is stored with the event.
 *
 * Events stored before this migration have no visitor ID.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table visitor_salts (
      day         date        primary key,
      salt        bytea       not null check (octet_length(salt) = 32),
      created_at  timestamptz not null default now()
    )
  `.execute(db);

  await sql`alter table events add column visitor_id bigint`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table events drop column visitor_id`.execute(db);
  await sql`drop table visitor_salts`.execute(db);
}
