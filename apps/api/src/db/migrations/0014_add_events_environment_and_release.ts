import { type Kysely, sql } from "kysely";

/**
 * events.environment and events.release (collection/environment.ts). Every
 * event stored so far came from a site that named neither, so it is
 * "production" with no release; a constant default adds the column
 * without rewriting the table.
 *
 * The checks are added NOT VALID, then validated: adding a checked column
 * reads every row while holding a lock that stops inserts, and validating
 * afterwards reads them without one. The release check names its
 * characters (spaces, control characters) instead of using a character
 * class such as [:cntrl:], whose meaning depends on the database's locale;
 * the API refuses at least as much (RELEASE_PATTERN), so it answers 400
 * before this check could ever fail.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table events
      add column environment text not null default 'production',
      add column release text,
      add constraint events_environment_check
        check (environment ~ '^[a-z0-9][a-z0-9._-]{0,63}$') not valid,
      add constraint events_release_check
        check (char_length(release) between 1 and 200 and release !~ '[\\x01-\\x20\\x7F-\\x9F]')
        not valid
  `.execute(db);
  await sql`alter table events validate constraint events_environment_check`.execute(db);
  await sql`alter table events validate constraint events_release_check`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table events drop column environment, drop column release`.execute(db);
}
