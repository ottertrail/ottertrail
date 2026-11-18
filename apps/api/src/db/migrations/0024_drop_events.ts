import { type Kysely, sql } from "kysely";

/**
 * Drops PostgreSQL's events table, with its indexes and checks. Events now
 * go straight to ClickHouse, as traces, logs, and metrics do
 * (docs/clickhouse.md); until now they arrived here and the worker copied
 * them there. No install held events here, so nothing is copied first.
 *
 * Going back makes an empty table of migration 0023's shape.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`drop table events`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table events (
      project_id        uuid        not null references projects (id) on delete cascade,
      event_id          uuid        not null,
      name              text        not null check (char_length(name) between 1 and 200),
      occurred_at       timestamptz not null,
      received_at       timestamptz not null default now(),
      path              text        check (char_length(path) between 1 and 2048),
      referrer          text        check (char_length(referrer) <= 2048),
      utm_source        text        check (char_length(utm_source) <= 200),
      utm_medium        text        check (char_length(utm_medium) <= 200),
      utm_campaign      text        check (char_length(utm_campaign) <= 200),
      utm_term          text        check (char_length(utm_term) <= 200),
      utm_content       text        check (char_length(utm_content) <= 200),
      properties        jsonb       not null default '{}'
                                    check (jsonb_typeof(properties) = 'object'),
      browser           text        check (char_length(browser) <= 50),
      browser_version   text        check (browser_version ~ '^[0-9]{1,6}$'),
      os                text        check (char_length(os) <= 50),
      device_type       text        check (device_type in ('desktop', 'mobile', 'tablet', 'tv')),
      country           text        check (country ~ '^[A-Z]{2}$'),
      region            text        check (char_length(region) <= 100),
      city              text        check (char_length(city) <= 100),
      visitor_id        bigint,
      copied_at         timestamptz,
      environment       text        not null default 'production'
                                    constraint events_environment_check
                                    check (environment ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
      release           text        constraint events_release_check
                                    check (char_length(release) between 1 and 200
                                      and release !~ '[\\x01-\\x20\\x7F-\\x9F]'),
      user_id           text        constraint events_user_id_check
                                    check (char_length(user_id) between 1 and 200
                                      and user_id !~ '[\\x01-\\x1F\\x7F-\\x9F]'),
      error_type        text,
      error_message     text,
      error_stack       text,
      error_handled     boolean,
      error_fingerprint text,
      replay_id         uuid,
      primary key (project_id, event_id),
      constraint events_properties_size_check check (octet_length(properties::text) <= 32768),
      constraint events_error_check check (
        (error_type is null and error_message is null and error_stack is null
          and error_handled is null and error_fingerprint is null)
        or (name = 'error'
          and char_length(error_type) between 1 and 200
          and char_length(error_message) <= 2000
          and (error_stack is null or char_length(error_stack) <= 16000)
          and error_handled is not null
          and error_fingerprint ~ '^[0-9]{1,3}-[0-9a-f]{20}$')
      )
    )
  `.execute(db);
  await sql`
    create index events_project_occurred_at_idx on events (project_id, occurred_at)
  `.execute(db);
  await sql`
    create index events_to_copy_idx on events (received_at, project_id, event_id)
      where copied_at is null
  `.execute(db);
}
