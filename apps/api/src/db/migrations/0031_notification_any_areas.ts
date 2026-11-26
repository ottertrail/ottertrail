import { type Kysely, sql } from "kysely";

/**
 * notifications gains `any_areas`: besides `areas`, each of which a reader
 * needs at view, a reader needs one of these (notifications/inbox.ts). A
 * "data stops arriving" rule on events (docs/uptime-alerts.md) shows to
 * anyone with web or product analytics, since both show events
 * (docs/access.md, "Alert rules and the areas they watch"). Empty: none,
 * as for every item already there.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table notifications
      add column any_areas text[] not null default '{}'
        constraint notifications_any_areas_check check (any_areas <@ array['web_analytics',
          'product_analytics', 'errors', 'replays', 'users', 'monitoring', 'ai', 'uptime_alerts'])
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table notifications drop column any_areas`.execute(db);
}
