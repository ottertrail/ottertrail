import { type Kysely, sql } from "kysely";

/**
 * uptime_checks: a project's HTTP(S) checks (docs/uptime-alerts.md), with
 * what each asks and expects, and its state as the worker last left it:
 * up, down, or pending (no result yet), the failures in a row, when the
 * current run of failures started and why, when it is next due, what its
 * latest request answered, and when its URL last changed. The API checks every value before it is
 * stored; the checks here keep a bad row out all the same.
 *
 * uptime_incidents: each time a check was down, from the first failure of
 * the run that took it down to the success that brought it back (open
 * while it is down), with that first failure's cause. At most one is open
 * per check.
 *
 * Deleting the project or the check deletes both. The worker takes due
 * checks by next_due_at, so the index covers only checks that run.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table uptime_checks (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references projects (id) on delete cascade,
      name text not null
        constraint uptime_checks_name_check check (char_length(name) between 1 and 100),
      url text not null
        constraint uptime_checks_url_check check (char_length(url) between 1 and 2048),
      method text not null constraint uptime_checks_method_check check (method in ('GET', 'HEAD')),
      interval_seconds integer not null constraint uptime_checks_interval_check
        check (interval_seconds in (60, 120, 300, 600, 900, 1800, 3600)),
      timeout_seconds integer not null
        constraint uptime_checks_timeout_check check (timeout_seconds between 1 and 30),
      expected_statuses text not null
        constraint uptime_checks_statuses_check check (char_length(expected_statuses) between 3 and 200),
      word text constraint uptime_checks_word_check
        check (word is null or char_length(word) between 1 and 200),
      word_mode text not null default 'present'
        constraint uptime_checks_word_mode_check check (word_mode in ('present', 'absent')),
      failures_before_down integer not null
        constraint uptime_checks_failures_check check (failures_before_down between 1 and 5),
      paused boolean not null default false,
      state text not null default 'pending'
        constraint uptime_checks_state_check check (state in ('pending', 'up', 'down')),
      consecutive_failures integer not null default 0,
      failing_since timestamptz,
      failing_cause text,
      failing_detail text,
      next_due_at timestamptz not null,
      last_checked_at timestamptz,
      last_up boolean,
      last_status_code integer,
      last_response_ms integer,
      last_cause text,
      tls_expires_at timestamptz,
      url_changed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index uptime_checks_project_idx on uptime_checks (project_id, created_at)`.execute(
    db,
  );
  await sql`create index uptime_checks_due_idx on uptime_checks (next_due_at) where not paused`.execute(
    db,
  );
  await sql`
    create table uptime_incidents (
      id uuid primary key default gen_random_uuid(),
      check_id uuid not null references uptime_checks (id) on delete cascade,
      project_id uuid not null references projects (id) on delete cascade,
      started_at timestamptz not null,
      ended_at timestamptz,
      cause text not null,
      detail text not null default '',
      constraint uptime_incidents_order_check check (ended_at is null or ended_at >= started_at)
    )
  `.execute(db);
  await sql`
    create unique index uptime_incidents_open_idx on uptime_incidents (check_id) where ended_at is null
  `.execute(db);
  await sql`
    create index uptime_incidents_check_idx on uptime_incidents (check_id, started_at desc)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table uptime_incidents`.execute(db);
  await sql`drop table uptime_checks`.execute(db);
}
