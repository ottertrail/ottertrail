import { type Kysely, sql } from "kysely";

/**
 * PostgreSQL's tables: the instance's settings, its projects and what they
 * own, and dashboard sign-in. Events, traces, logs, metrics, and uptime
 * results are in ClickHouse (clickhouse/migrations.ts; docs/clickhouse.md).
 *
 * A migration that has run never changes: add the next one.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  /**
   * instance_settings: the settings of this instance, which serves one
   * customer (settings/settings.ts). One row, made here and filled in by
   * the setup link (auth/setup.ts):
   *
   * - name: what the dashboard shows above the projects.
   * - time_zone: an IANA timezone, such as "Asia/Singapore". Reports count
   *   days in it, and visitor salts change at its midnight. Setup sets it
   *   from TIMEZONE; the owner changes it in the dashboard's settings.
   */
  await sql`
    create table instance_settings (
      id          boolean     primary key default true
                              constraint instance_settings_one_row_check check (id),
      name        text        not null
                              constraint instance_settings_name_check
                              check (char_length(name) between 1 and 100),
      time_zone   text        not null,
      updated_at  timestamptz not null default now()
    )
  `.execute(db);
  await sql`insert into instance_settings (name, time_zone) values ('Ottertrail', 'UTC')`.execute(
    db,
  );

  /**
   * projects: the sites and apps whose data the instance keeps. Everything
   * else stored belongs to a project, here by project_id with a foreign key
   * that deletes it with the project, and in ClickHouse by project_id.
   *
   * - public_key: identifies the project in requests from browsers. It sits
   *   in every page's HTML, so it is not a secret and only allows sending
   *   events.
   * - allowed_hostnames: the sites whose pages may send events, such as
   *   "example.com" and "www.example.com". Empty accepts nothing.
   * - secret_key: the project's server key, for the site's own server. It
   *   authenticates server-side events and telemetry, and signs user IDs
   *   (HMAC-SHA256), which Ottertrail checks when require_signed_user_ids
   *   is on. Checking a signature means computing it again, so the key
   *   itself is stored, not a hash of it (docs/web-analytics.md,
   *   "Server-side events").
   * - retention_days: how long the project keeps its events; null keeps
   *   them forever, the default. The worker deletes older events
   *   (retention/retention.ts).
   * - ignore_data_centers: whether collection ignores browser events from
   *   the address ranges of cloud and hosting providers, where nearly all
   *   "visitors" are programs (docs/web-analytics.md, "Data centers"). A
   *   site whose real users browse from a cloud, such as through a remote
   *   desktop, can turn it off.
   * - replay_mode: session replays, "off" or "errors", recording around
   *   errors (docs/session-replay.md). Recordings for a project that has it
   *   off are refused.
   * - last_event_at: when the project's latest event happened, which the
   *   dashboard shows; null before the first. The API records it as it
   *   stores events (collection/last-event.ts).
   */
  await sql`
    create table projects (
      id                       uuid        primary key default gen_random_uuid(),
      name                     text        not null check (char_length(name) between 1 and 200),
      created_at               timestamptz not null default now(),
      public_key               text        not null unique
                                           default ('pk_' || replace(gen_random_uuid()::text, '-', ''))
                                           check (public_key ~ '^pk_[0-9a-f]{32}$'),
      allowed_hostnames        text[]      not null default '{}'
                                           check (cardinality(allowed_hostnames) <= 50),
      secret_key               text        not null
                                           default ('sk_' || replace(gen_random_uuid()::text, '-', ''))
                                           constraint projects_secret_key_check
                                           check (secret_key ~ '^sk_[0-9a-f]{32}$'),
      require_signed_user_ids  boolean     not null default false,
      retention_days           integer     check (retention_days is null
                                             or retention_days between 30 and 3650),
      ignore_data_centers      boolean     not null default true,
      replay_mode              text        not null default 'off'
                                           constraint projects_replay_mode_check
                                           check (replay_mode in ('off', 'errors')),
      last_event_at            timestamptz
    )
  `.execute(db);
  await sql`create unique index projects_secret_key_idx on projects (secret_key)`.execute(db);

  /**
   * project_deletions: projects deleted whose events ClickHouse may still
   * hold. ClickHouse has no foreign keys, so the worker deletes the events
   * there, and the project's objects in the object store, then the row
   * (clickhouse/delete-events.ts). No foreign key here either: the project
   * is gone.
   *
   * A trigger adds the row whenever a project row is deleted, in the same
   * transaction, however the delete came about: the API or a hand-written
   * statement.
   */
  await sql`
    create table project_deletions (
      project_id  uuid        primary key,
      deleted_at  timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create function record_project_deletion() returns trigger language plpgsql as $$
    begin
      insert into project_deletions (project_id) values (old.id) on conflict do nothing;
      return old;
    end
    $$
  `.execute(db);
  await sql`
    create trigger projects_record_deletion after delete on projects
      for each row execute function record_project_deletion()
  `.execute(db);

  /**
   * visitor_salts: counting unique visitors without cookies. One random
   * secret per timezone and day: a visitor ID is a keyed hash of that day's
   * salt, the project, the client's IP address, and its User-Agent, and
   * neither the IP address nor the salt is stored with the event. Keyed by
   * timezone too, so a visit never splits inside a local day, even on the
   * day the instance's timezone changes. A salt is deleted once no event
   * can still need it, after which nobody can tell which IP address a
   * visitor ID came from (visitors/visitor-ids.ts).
   */
  await sql`
    create table visitor_salts (
      time_zone   text        not null,
      day         date        not null,
      salt        bytea       not null check (octet_length(salt) = 32),
      created_at  timestamptz not null default now(),
      primary key (time_zone, day)
    )
  `.execute(db);

  /**
   * Signing in to the dashboard.
   *
   * - dashboard_users, dashboard_sessions, dashboard_accounts, and
   *   dashboard_verifications are the tables Better Auth works with
   *   (auth/auth.ts maps its names to these). An account row holds the
   *   scrypt hash of a user's password; a session row holds the token in
   *   the user's cookie.
   * - dashboard_users.role: "owner" for the account the setup link
   *   created, who owns the instance and may change its settings;
   *   "member" otherwise. An instance has at most one owner.
   * - owner_setup_tokens holds the one-time link that creates the owner
   *   (auth/setup.ts): only a SHA-256 hash of each token, never the token.
   */
  await sql`
    create table dashboard_users (
      id              uuid        primary key default gen_random_uuid(),
      name            text        not null check (char_length(name) between 1 and 200),
      email           text        not null unique check (char_length(email) <= 320),
      email_verified  boolean     not null default false,
      image           text,
      role            text        not null default 'member' check (role in ('owner', 'member')),
      created_at      timestamptz not null default now(),
      updated_at      timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create unique index dashboard_users_one_owner_idx on dashboard_users (role) where role = 'owner'
  `.execute(db);

  await sql`
    create table dashboard_sessions (
      id          uuid        primary key default gen_random_uuid(),
      user_id     uuid        not null references dashboard_users (id) on delete cascade,
      token       text        not null unique,
      expires_at  timestamptz not null,
      user_agent  text,
      -- Better Auth has a column for the client's IP address. Ottertrail
      -- keeps none, so an insert that tries to store one fails.
      ip_address  text        check (ip_address is null),
      created_at  timestamptz not null default now(),
      updated_at  timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index dashboard_sessions_user_id_idx on dashboard_sessions (user_id)`.execute(
    db,
  );

  await sql`
    create table dashboard_accounts (
      id                        uuid        primary key default gen_random_uuid(),
      user_id                   uuid        not null references dashboard_users (id) on delete cascade,
      account_id                text        not null,
      provider_id               text        not null,
      password                  text,
      access_token              text,
      refresh_token             text,
      id_token                  text,
      access_token_expires_at   timestamptz,
      refresh_token_expires_at  timestamptz,
      scope                     text,
      created_at                timestamptz not null default now(),
      updated_at                timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index dashboard_accounts_user_id_idx on dashboard_accounts (user_id)`.execute(
    db,
  );

  await sql`
    create table dashboard_verifications (
      id          uuid        primary key default gen_random_uuid(),
      identifier  text        not null,
      value       text        not null,
      expires_at  timestamptz not null,
      created_at  timestamptz not null default now(),
      updated_at  timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create index dashboard_verifications_identifier_idx on dashboard_verifications (identifier)
  `.execute(db);

  await sql`
    create table owner_setup_tokens (
      token_hash  bytea       primary key check (octet_length(token_hash) = 32),
      expires_at  timestamptz not null,
      created_at  timestamptz not null default now()
    )
  `.execute(db);

  /**
   * error_resolutions: the error groups a project's team marked resolved,
   * by fingerprint (errors/fingerprint.ts), and when. A group with no row
   * is unresolved. One that occurs again after resolved_at counts as
   * unresolved again, a regression: worked out when the list is read, so
   * collection never writes here (docs/errors.md, "Status").
   *
   * A status belongs to the project, in every environment. Deleting the
   * dashboard user keeps the row without its name.
   */
  await sql`
    create table error_resolutions (
      project_id   uuid        not null references projects (id) on delete cascade,
      fingerprint  text        not null
                               constraint error_resolutions_fingerprint_check
                               check (fingerprint ~ '^[0-9]{1,3}-[0-9a-f]{20}$'),
      resolved_at  timestamptz not null default now(),
      resolved_by  uuid        references dashboard_users (id) on delete set null,
      primary key (project_id, fingerprint)
    )
  `.execute(db);

  /**
   * goals: a project's saved conversions (docs/product-analytics.md,
   * "Goals"), each a page viewed or a product event with an optional
   * property filter, as a funnel step is. The analytics page counts them.
   *
   * The columns match the step's kind: a page has a path; an event a name,
   * and a property name and value together or neither. Names are unique in
   * a project, so a list can be read at a glance.
   */
  await sql`
    create table goals (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references projects (id) on delete cascade,
      name text not null constraint goals_name_check check (char_length(name) between 1 and 100),
      kind text not null constraint goals_kind_check check (kind in ('page', 'event')),
      path text constraint goals_path_check check (char_length(path) between 1 and 500),
      event_name text constraint goals_event_name_check check (char_length(event_name) between 1 and 200),
      filter_key text constraint goals_filter_key_check check (char_length(filter_key) between 1 and 100),
      filter_value text constraint goals_filter_value_check check (char_length(filter_value) <= 500),
      created_at timestamptz not null default now(),
      constraint goals_shape_check check (
        (kind = 'page' and path is not null and event_name is null
          and filter_key is null and filter_value is null)
        or (kind = 'event' and event_name is not null and path is null
          and (filter_key is null) = (filter_value is null))
      ),
      constraint goals_project_name_key unique (project_id, name)
    )
  `.execute(db);

  /**
   * saved_funnels: a project's named funnels (docs/product-analytics.md,
   * "Saved funnels"): the steps, who the funnel counts, and its conversion
   * window, so the funnel page can open one again. The period and the
   * environment are the page's, not the funnel's.
   *
   * The steps are the JSON the funnel report takes (product/steps.ts),
   * checked by the API before they are stored: here only their number. A
   * window over a day needs users, whose IDs do not change daily. Names are
   * unique in a project.
   *
   * updated_at is a funnel's version: a change names the one it read, and
   * is refused when another came first. It is kept in whole milliseconds,
   * as JSON carries it, and every change moves it forward.
   */
  await sql`
    create table saved_funnels (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references projects (id) on delete cascade,
      name text not null
        constraint saved_funnels_name_check check (char_length(name) between 1 and 100),
      steps jsonb not null constraint saved_funnels_steps_check check (
        case when jsonb_typeof(steps) = 'array'
          then jsonb_array_length(steps) between 2 and 5
          else false end
      ),
      count_by text not null
        constraint saved_funnels_count_by_check check (count_by in ('visitors', 'users')),
      window_seconds integer not null constraint saved_funnels_window_check check (
        window_seconds > 0 and (count_by = 'users' or window_seconds <= 86400)
      ),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default date_trunc('milliseconds', now()),
      constraint saved_funnels_project_name_key unique (project_id, name)
    )
  `.execute(db);

  /**
   * source_maps: the source maps a project uploaded (docs/errors.md,
   * "Source maps"), one per release and minified file. The map itself is
   * in the object store, compressed, under object_key; bytes is its stored
   * size, which the instance's limit counts. A new upload of the same file
   * and release replaces the old one. The worker deletes a deleted
   * project's objects (project_deletions).
   */
  await sql`
    create table source_maps (
      project_id uuid not null references projects (id) on delete cascade,
      release text not null
        constraint source_maps_release_check check (char_length(release) between 1 and 200),
      -- ASCII, as browsers report a path (source-maps.ts, isSourcePath),
      -- and short enough that the primary key stays within what an index takes.
      path text not null
        constraint source_maps_path_check check (
          char_length(path) between 1 and 1024 and left(path, 1) = '/'
        ),
      object_key text not null,
      bytes integer not null constraint source_maps_bytes_check check (bytes > 0),
      uploaded_at timestamptz not null default now(),
      primary key (project_id, release, path)
    )
  `.execute(db);

  /**
   * Session replays around errors (docs/session-replay.md).
   *
   * - replay_chunks: what browsers sent, one gzip member each, kept until
   *   the worker joins a replay's chunks into one object, and an hour
   *   after, past the tracker's retries. A chunk is stored once per
   *   (project, replay, seq). A replay may have 100 chunks, numbered 0 to
   *   99 (MAX_CHUNKS in replays/replays.ts): the tracker fills each chunk
   *   at least about half, so a 2 MB recording can need more than 50.
   * - replays: the joined replays, one object each in the object store.
   *
   * The worker deletes a deleted project's objects.
   */
  await sql`
    create table replay_chunks (
      project_id uuid not null references projects (id) on delete cascade,
      replay_id uuid not null,
      seq smallint not null constraint replay_chunks_seq_check check (seq between 0 and 99),
      last boolean not null,
      cut boolean not null,
      data bytea not null
        constraint replay_chunks_data_check check (octet_length(data) between 1 and 65536),
      received_at timestamptz not null default now(),
      primary key (project_id, replay_id, seq)
    )
  `.execute(db);
  await sql`create index replay_chunks_received_at on replay_chunks (received_at)`.execute(db);
  await sql`
    create table replays (
      project_id uuid not null references projects (id) on delete cascade,
      replay_id uuid not null,
      object_key text not null,
      bytes integer not null constraint replays_bytes_check check (bytes > 0),
      cut boolean not null,
      created_at timestamptz not null default now(),
      primary key (project_id, replay_id)
    )
  `.execute(db);
  await sql`create index replays_created_at on replays (created_at)`.execute(db);

  /**
   * uptime_checks: a project's HTTP(S) checks (docs/uptime-alerts.md),
   * with what each asks and expects, and its state as the worker last left
   * it: up, down, or pending (no result yet), the failures in a row, when
   * the current run of failures started and why, when it is next due, what
   * its latest request answered, and when its URL last changed. The API
   * checks every value before it is stored; the checks here keep a bad row
   * out all the same.
   *
   * uptime_incidents: each time a check was down, from the first failure
   * of the run that took it down to the success that brought it back (open
   * while it is down), with that first failure's cause. At most one is
   * open per check.
   *
   * Deleting the project or the check deletes both. The worker takes due
   * checks by next_due_at, so the index covers only checks that run.
   */
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
  for (const table of [
    "uptime_incidents",
    "uptime_checks",
    "replays",
    "replay_chunks",
    "source_maps",
    "saved_funnels",
    "goals",
    "error_resolutions",
    "owner_setup_tokens",
    "dashboard_verifications",
    "dashboard_accounts",
    "dashboard_sessions",
    "dashboard_users",
    "visitor_salts",
    "projects",
    "project_deletions",
    "instance_settings",
  ]) {
    await sql`drop table ${sql.table(table)}`.execute(db);
  }
  await sql`drop function record_project_deletion()`.execute(db);
}
