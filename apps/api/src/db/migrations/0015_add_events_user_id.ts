import { type Kysely, sql } from "kysely";

/**
 * events.user_id: the site's own ID for the signed-in user who caused the
 * event, or null for an anonymous visitor (collection/identity.ts). Added
 * NOT VALID, then validated, so inserts are not held up while existing rows
 * are read (as migration 0014). The check names the control characters it
 * refuses instead of a locale-dependent class.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table events
      add column user_id text,
      add constraint events_user_id_check
        check (char_length(user_id) between 1 and 200 and user_id !~ '[\\x01-\\x1F\\x7F-\\x9F]')
        not valid
  `.execute(db);
  await sql`alter table events validate constraint events_user_id_check`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table events drop column user_id`.execute(db);
}
