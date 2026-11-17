import { type Kysely, sql } from "kysely";

/**
 * Errors are events named "error" with five more columns
 * (docs/errors.md): the browser's report (type, message, stack, and
 * whether the site caught it itself) and the group it belongs to, worked
 * out on arrival (errors/fingerprint.ts). Every other event has none of
 * them. An error is part of the same timeline as the visitor's and user's
 * other events, and shares their retention, deletion, and copy to
 * ClickHouse.
 *
 * Migrations run in one transaction, so the table stays locked until all
 * are done; PostgreSQL's events table only holds events not yet copied to
 * ClickHouse and the last two days, so the check is quick.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table events
      add column error_type text,
      add column error_message text,
      add column error_stack text,
      add column error_handled boolean,
      add column error_fingerprint text,
      add constraint events_error_check check (
        (error_type is null and error_message is null and error_stack is null
          and error_handled is null and error_fingerprint is null)
        or (name = 'error'
          and char_length(error_type) between 1 and 200
          and char_length(error_message) <= 2000
          and (error_stack is null or char_length(error_stack) <= 16000)
          and error_handled is not null
          and error_fingerprint ~ '^[0-9]{1,3}-[0-9a-f]{20}$')
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table events
      drop constraint events_error_check,
      drop column error_type,
      drop column error_message,
      drop column error_stack,
      drop column error_handled,
      drop column error_fingerprint
  `.execute(db);
}
