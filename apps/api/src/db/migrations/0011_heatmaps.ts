import { type Kysely, sql } from "kysely";

/**
 * Heatmaps (docs/web-analytics.md, "Heatmaps"): whether the project takes
 * them. Off by default; while off, collection refuses heatmap batches (403
 * `heatmaps_off`). The rows themselves are in ClickHouse (`heatmaps`).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table projects add column heatmaps boolean not null default false`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table projects drop column heatmaps`.execute(db);
}
