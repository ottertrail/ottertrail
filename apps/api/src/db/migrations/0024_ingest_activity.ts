import { type Kysely, sql } from "kysely";

/**
 * What each project's ingestion routes accepted, filtered, and refused
 * (docs/dashboard.md, "Activity"; activity/activity.ts): counts only, one row
 * per project, hour, source, and outcome. Each API process adds its
 * counts every 15 seconds with an upsert, so several processes add up.
 * Never a request's contents, address, user agent, key, or path.
 *
 * - count: requests with this outcome.
 * - items: the items they stood for, when the route knew the number
 *   (events, spans, log records, data points, AI calls, heatmap records,
 *   replay chunks, source maps); 0 when it did not.
 * - last_at: when the latest of them arrived.
 *
 * Kept 7 days: the worker deletes older hours (activity/activity.ts,
 * pruneIngestActivity). Rows go with their project.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table ingest_activity (
      project_id uuid        not null references projects (id) on delete cascade,
      hour       timestamptz not null check (extract(epoch from hour)::bigint % 3600 = 0),
      source     text        not null check (source in (
        'browser_events', 'server_events', 'errors', 'web_vitals', 'replays', 'heatmaps',
        'traces', 'logs', 'metrics', 'ai_calls', 'source_maps'
      )),
      outcome    text        not null check (outcome in (
        'accepted', 'filtered_bot', 'filtered_spam', 'filtered_too_old', 'refused_origin',
        'refused_disabled', 'refused_invalid', 'refused_rate_limited', 'refused_volume',
        'refused_unavailable'
      )),
      count      bigint      not null check (count >= 0),
      items      bigint      not null default 0 check (items >= 0),
      last_at    timestamptz not null,
      primary key (project_id, hour, source, outcome)
    )
  `.execute(db);
  // The worker's daily deletion reads by hour across projects.
  await sql`create index ingest_activity_hour on ingest_activity (hour)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table ingest_activity`.execute(db);
}
