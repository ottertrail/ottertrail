import { type Kysely, sql } from "kysely";

/**
 * Step 1 of web analytics: projects, and the event log.
 *
 * Migrations never change once they are committed. Later steps add columns
 * (visitor, session, browser, country) in new migrations.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table projects (
      id          uuid        primary key default gen_random_uuid(),
      name        text        not null check (char_length(name) between 1 and 200),
      created_at  timestamptz not null default now()
    )
  `.execute(db);

  await sql`
    create table events (
      project_id    uuid        not null references projects (id) on delete cascade,
      event_id      uuid        not null,
      name          text        not null check (char_length(name) between 1 and 200),
      occurred_at   timestamptz not null,
      received_at   timestamptz not null default now(),
      path          text        not null check (char_length(path) between 1 and 2048),
      referrer      text        check (char_length(referrer) <= 2048),
      utm_source    text        check (char_length(utm_source) <= 200),
      utm_medium    text        check (char_length(utm_medium) <= 200),
      utm_campaign  text        check (char_length(utm_campaign) <= 200),
      utm_term      text        check (char_length(utm_term) <= 200),
      utm_content   text        check (char_length(utm_content) <= 200),
      properties    jsonb       not null default '{}'
                                check (jsonb_typeof(properties) = 'object')
                                check (octet_length(properties::text) <= 8192),

      -- The same event ID can only be stored once per project, so a retried
      -- send cannot be counted twice.
      primary key (project_id, event_id)
    )
  `.execute(db);

  // Nearly every report asks "this project, between these two times".
  await sql`
    create index events_project_occurred_at_idx on events (project_id, occurred_at)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table events`.execute(db);
  await sql`drop table projects`.execute(db);
}
