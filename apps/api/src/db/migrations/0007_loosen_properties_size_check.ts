import { type Kysely, sql } from "kysely";

/**
 * The API limits an event's properties to 8 KB, measured as the JSON the
 * sender sent. The database checked the same 8 KB against PostgreSQL's own
 * text form of the value, which is larger: it adds a space after each colon
 * and comma, and writes a number such as 1e21 out in full. Properties just
 * under the API's limit then failed the insert, and the whole batch with
 * them, with an error the sender would retry forever.
 *
 * The API stays the limit. The database check becomes a safety net at
 * 32 KB, above anything the API accepts: the largest is 14,651 bytes in that
 * form (20 numbers written as 5e-324 plus long strings, measured).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // The original check was created without a name; find it by its definition.
  await sql`
    do $$
    declare
      check_name text;
    begin
      select conname into strict check_name
      from pg_constraint
      where conrelid = 'events'::regclass
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%octet_length((properties)::text) <= 8192%';
      execute format('alter table events drop constraint %I', check_name);
    end
    $$
  `.execute(db);
  await sql`
    alter table events add constraint events_properties_size_check
      check (octet_length(properties::text) <= 32768)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table events drop constraint events_properties_size_check`.execute(db);
  await sql`
    alter table events add constraint events_properties_check1
      check (octet_length(properties::text) <= 8192)
  `.execute(db);
}
