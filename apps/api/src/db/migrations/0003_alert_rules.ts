import { type Kysely, sql } from "kysely";

/**
 * Alert rules (docs/uptime-alerts.md, "Alerts"; step 3).
 *
 * alert_rules: a project's rules, at most 50 (the API counts them). Each
 * has a name, a kind (alerts/kinds.ts lists them; step 4 adds more, so
 * the column takes any short name and the API checks it), its settings
 * as JSON (which check, how many days, which environment, the window and
 * threshold), the instance's channels it sends to, and whether it is on.
 * A rule the server turned off, because its last channel or its check was
 * deleted, says why in disabled_reason. The cap_* columns count the
 * rule's notifications in the current hour: past 20, they are held back
 * and counted, and one message says how many when the hour ends.
 *
 * alert_states: per rule and subject (a check's ID, an error group's
 * fingerprint, or '' for a spike rule's own count), whether it is firing,
 * since when, the key it fired for (a certificate's expiry, a
 * resolution's time) and when it was last notified. A row is written in
 * the same transaction as the notification, so a restart sends nothing
 * twice.
 *
 * alert_history: each alert, fired and (where the kind resolves)
 * resolved, with its message and the notifications sent; a notification
 * held back by the cap has none. Kept 90 days.
 *
 * active_since: when the rule was created, turned on again, or changed
 * what it watches; error rules read nothing that arrived before it.
 *
 * alert_evaluations: per project, the time up to which its error rules
 * have read arrivals, so the next minute starts where this one ended, and
 * when one minute read more groups than it takes, the last group read
 * (its first arrival, fingerprint, and environment), where the next
 * minute goes on.
 *
 * alert_error_groups: per project, the error groups (fingerprint and
 * environment) new-error rules have already seen, with their first
 * arrival, so only groups not in it are looked up in ClickHouse.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table alert_rules (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references projects (id) on delete cascade,
      name text not null
        constraint alert_rules_name_check check (char_length(name) between 1 and 100),
      kind text not null
        constraint alert_rules_kind_check check (char_length(kind) between 1 and 64),
      settings jsonb not null default '{}'
        constraint alert_rules_settings_check check (jsonb_typeof(settings) = 'object'),
      channel_ids uuid[] not null default '{}'
        constraint alert_rules_channels_check check (cardinality(channel_ids) <= 20),
      enabled boolean not null default true,
      disabled_reason text
        constraint alert_rules_reason_check check (char_length(disabled_reason) <= 300),
      cap_window_start timestamptz,
      cap_sent integer not null default 0,
      cap_held integer not null default 0,
      active_since timestamptz not null default now(),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create index alert_rules_project_idx on alert_rules (project_id, created_at, id)
  `.execute(db);
  await sql`
    create index alert_rules_channels_idx on alert_rules using gin (channel_ids)
  `.execute(db);

  await sql`
    create table alert_history (
      id uuid primary key default gen_random_uuid(),
      rule_id uuid not null references alert_rules (id) on delete cascade,
      project_id uuid not null references projects (id) on delete cascade,
      subject text not null
        constraint alert_history_subject_check check (char_length(subject) <= 200),
      subject_name text not null
        constraint alert_history_subject_name_check check (char_length(subject_name) <= 300),
      fired_at timestamptz not null,
      resolved_at timestamptz,
      message text not null
        constraint alert_history_message_check check (char_length(message) between 1 and 1000),
      notification_id uuid,
      resolve_notification_id uuid
    )
  `.execute(db);
  await sql`
    create index alert_history_rule_idx on alert_history (rule_id, fired_at desc, id desc)
  `.execute(db);
  await sql`
    create index alert_history_project_idx on alert_history (project_id, fired_at desc, id desc)
  `.execute(db);
  await sql`create index alert_history_fired_idx on alert_history (fired_at)`.execute(db);

  await sql`
    create table alert_states (
      rule_id uuid not null references alert_rules (id) on delete cascade,
      subject text not null
        constraint alert_states_subject_check check (char_length(subject) <= 200),
      firing boolean not null,
      key text not null default ''
        constraint alert_states_key_check check (char_length(key) <= 100),
      since timestamptz not null,
      clear_since timestamptz,
      last_notified_at timestamptz,
      history_id uuid references alert_history (id) on delete set null,
      primary key (rule_id, subject)
    )
  `.execute(db);
  await sql`
    create index alert_states_firing_idx on alert_states (rule_id) where firing
  `.execute(db);

  await sql`
    create table alert_evaluations (
      project_id uuid primary key references projects (id) on delete cascade,
      errors_until timestamptz not null,
      after_arrival timestamptz,
      after_fingerprint text,
      after_environment text
    )
  `.execute(db);

  await sql`
    create table alert_error_groups (
      project_id uuid not null references projects (id) on delete cascade,
      fingerprint text not null
        constraint alert_error_groups_fingerprint_check check (char_length(fingerprint) <= 64),
      environment text not null
        constraint alert_error_groups_environment_check check (char_length(environment) <= 64),
      first_arrival timestamptz not null,
      primary key (project_id, fingerprint, environment)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table alert_error_groups`.execute(db);
  await sql`drop table alert_evaluations`.execute(db);
  await sql`drop table alert_states`.execute(db);
  await sql`drop table alert_history`.execute(db);
  await sql`drop table alert_rules`.execute(db);
}
