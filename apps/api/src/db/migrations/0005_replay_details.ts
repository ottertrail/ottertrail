import { type Kysely, sql } from "kysely";

/**
 * What the dashboard knows about each replay (docs/session-replay.md,
 * "Finding replays"), so the Replays page lists and filters them from
 * PostgreSQL alone, a page at a time.
 *
 * Derived from the recording when the worker joins it (replays/derive.ts):
 *
 * - started_at, ended_at: the recording's first and last event, on the
 *   server's clock: a visitor's clock that is more than a minute off is
 *   corrected by when the replay's first chunk arrived. clock_offset_ms is
 *   that correction (server minus recording), so the recording's own times
 *   can be had back for the player.
 * - pages: the paths the visitor was on, in the order first seen, at most
 *   30, cleaned as page URLs are (no origin, query string, or fragment).
 * - clicks, page_changes: how many of each.
 * - timeline: what the player's timeline lists, `{"items":[…],
 *   "truncated":false|"scrolls"|"earliest"}`, at most 500 items: page changes, clicks (tag and
 *   role only), inputs (never their values), scrolls, and the error.
 *
 * From the error events that carry the replay's ID (ClickHouse), found by
 * the worker soon after the join (replays/link.ts): the first error's
 * time, group, type, and message, the known user, the environment, and the
 * browser, OS, and device. linked: the search is over, found or given up
 * an hour after the join; the columns stay null when it was not found.
 * next_link_at: when the worker looks again, later after each miss, so a
 * project whose errors never come does not take every run.
 *
 * Replays already joined get their join time as start and end: the app is
 * not live, so only development databases have any.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table replays
      add column started_at timestamptz,
      add column ended_at timestamptz,
      add column clock_offset_ms bigint not null default 0,
      add column pages text[] not null default '{}'
        constraint replays_pages_check check (cardinality(pages) <= 30),
      add column clicks integer not null default 0 constraint replays_clicks_check check (clicks >= 0),
      add column page_changes integer not null default 0
        constraint replays_page_changes_check check (page_changes >= 0),
      add column timeline jsonb not null default '{"items":[],"truncated":false}'
        constraint replays_timeline_check check (
          jsonb_typeof(timeline -> 'items') = 'array'
          and jsonb_array_length(timeline -> 'items') <= 500
        ),
      add column linked boolean not null default false,
      add column next_link_at timestamptz not null default now(),
      add column error_at timestamptz,
      add column error_fingerprint text,
      add column error_type text constraint replays_error_type_check check (char_length(error_type) <= 200),
      add column error_message text
        constraint replays_error_message_check check (char_length(error_message) <= 1000),
      add column user_id text constraint replays_user_id_check check (char_length(user_id) <= 200),
      add column environment text,
      add column browser text,
      add column os text,
      add column device_type text
  `.execute(db);
  await sql`update replays set started_at = created_at, ended_at = created_at`.execute(db);
  await sql`
    alter table replays
      alter column started_at set not null,
      alter column ended_at set not null,
      add constraint replays_times_check check (ended_at >= started_at)
  `.execute(db);
  // The list: a project's replays, newest first, a page after a cursor.
  await sql`
    create index replays_project_started_index
      on replays (project_id, started_at desc, replay_id desc)
  `.execute(db);
  // A user's replays, on the user's page.
  await sql`
    create index replays_project_user_index
      on replays (project_id, user_id, started_at desc)
      where user_id is not null
  `.execute(db);
  // The replays whose error the worker still looks for, the most due first.
  await sql`
    create index replays_unlinked_index on replays (next_link_at) where not linked
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index replays_unlinked_index`.execute(db);
  await sql`drop index replays_project_user_index`.execute(db);
  await sql`drop index replays_project_started_index`.execute(db);
  await sql`
    alter table replays
      drop constraint replays_times_check,
      drop column device_type,
      drop column os,
      drop column browser,
      drop column environment,
      drop column user_id,
      drop column error_message,
      drop column error_type,
      drop column error_fingerprint,
      drop column error_at,
      drop column next_link_at,
      drop column linked,
      drop column timeline,
      drop column page_changes,
      drop column clicks,
      drop column pages,
      drop column clock_offset_ms,
      drop column ended_at,
      drop column started_at
  `.execute(db);
}
