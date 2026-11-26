import { type Kysely, sql } from "kysely";

/**
 * Heartbeat checks (docs/uptime-alerts.md, "Heartbeat checks"): a check a
 * job reports to, by calling its ping URL, instead of one the worker runs.
 *
 * uptime_checks gains `kind` ('http' or 'heartbeat'). A heartbeat has no
 * URL, method, timeout, status codes, or failures before down: those
 * columns become null for it. `interval_seconds` is its period, from its
 * own list, and `grace_seconds` the time allowed after it. Its
 * `next_due_at` is the moment it goes down without a ping: the last ping
 * (or its creation, or resuming it) plus the period and the grace.
 *
 * `ping_token` is the URL's secret, kept as it is so those who manage
 * checks can see the URL again, as a project's keys are. Pings look a
 * check up by `ping_token_hash` (SHA-256 of the token), so the lookup's
 * time does not depend on how much of a guessed token is right.
 *
 * The HTTP checks' due index now covers HTTP checks only. Heartbeats have
 * their own, of those that can go down for lack of a ping: one indexed
 * query finds the overdue ones.
 *
 * heartbeat_pings: when each ping came and whether it reported a
 * failure, the latest 50 per check, never a request's body or headers.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table uptime_checks
      add column kind text not null default 'http'
        constraint uptime_checks_kind_check check (kind in ('http', 'heartbeat')),
      add column grace_seconds integer,
      add column ping_token text,
      add column ping_token_hash bytea,
      alter column url drop not null,
      alter column method drop not null,
      alter column timeout_seconds drop not null,
      alter column expected_statuses drop not null,
      alter column failures_before_down drop not null,
      drop constraint uptime_checks_interval_check,
      add constraint uptime_checks_interval_check check (
        (kind = 'http' and interval_seconds in (60, 120, 300, 600, 900, 1800, 3600))
        or (kind = 'heartbeat' and interval_seconds in
          (60, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400, 604800))
      ),
      add constraint uptime_checks_kind_fields_check check (
        (kind = 'http'
          and url is not null and method is not null and timeout_seconds is not null
          and expected_statuses is not null and failures_before_down is not null
          and grace_seconds is null and ping_token is null and ping_token_hash is null)
        or (kind = 'heartbeat'
          and url is null and method is null and timeout_seconds is null
          and expected_statuses is null and failures_before_down is null and word is null
          and grace_seconds in (60, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400)
          and char_length(ping_token) between 32 and 64
          and octet_length(ping_token_hash) = 32)
      )
  `.execute(db);
  await sql`drop index uptime_checks_due_idx`.execute(db);
  await sql`
    create index uptime_checks_due_idx on uptime_checks (next_due_at)
      where not paused and kind = 'http'
  `.execute(db);
  await sql`
    create index uptime_heartbeats_due_idx on uptime_checks (next_due_at)
      where not paused and kind = 'heartbeat' and state <> 'down'
  `.execute(db);
  await sql`
    create unique index uptime_checks_ping_token_hash_idx on uptime_checks (ping_token_hash)
  `.execute(db);
  await sql`
    create table heartbeat_pings (
      id bigint generated always as identity primary key,
      check_id uuid not null references uptime_checks (id) on delete cascade,
      project_id uuid not null references projects (id) on delete cascade,
      at timestamptz not null,
      failed boolean not null
    )
  `.execute(db);
  await sql`create index heartbeat_pings_check_idx on heartbeat_pings (check_id, at desc, id desc)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table heartbeat_pings`.execute(db);
  await sql`delete from uptime_checks where kind = 'heartbeat'`.execute(db);
  await sql`drop index uptime_checks_ping_token_hash_idx`.execute(db);
  await sql`drop index uptime_heartbeats_due_idx`.execute(db);
  await sql`drop index uptime_checks_due_idx`.execute(db);
  await sql`create index uptime_checks_due_idx on uptime_checks (next_due_at) where not paused`.execute(
    db,
  );
  await sql`
    alter table uptime_checks
      drop constraint uptime_checks_kind_fields_check,
      drop constraint uptime_checks_interval_check,
      add constraint uptime_checks_interval_check
        check (interval_seconds in (60, 120, 300, 600, 900, 1800, 3600)),
      alter column url set not null,
      alter column method set not null,
      alter column timeout_seconds set not null,
      alter column expected_statuses set not null,
      alter column failures_before_down set not null,
      drop column ping_token_hash,
      drop column ping_token,
      drop column grace_seconds,
      drop column kind
  `.execute(db);
}
