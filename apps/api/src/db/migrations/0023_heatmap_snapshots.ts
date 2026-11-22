import { type Kysely, sql } from "kysely";

/**
 * Saved heatmap views (docs/web-analytics.md, "Saved views";
 * heatmaps/snapshots.ts): a snapshot of a page as its owner's browser
 * showed it, saved from the overlay, which the Heatmaps screen draws the
 * heatmap over. The snapshot is an object in the store under
 * `heatmap-snapshots/<project_id>/`; the row holds its key and what the
 * screen shows about it.
 *
 * - heatmap_snapshots: one per project, page path, and device class.
 *   Saving again replaces the row and its object. saved_by is the user
 *   who saved it; null once that user is removed.
 * - heatmap_overlay_tokens.path: the page an overlay link was made for,
 *   which its session may save a view of; null for a link made without
 *   one, whose session saves nothing.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table heatmap_snapshots (
      project_id  uuid        not null references projects (id) on delete cascade,
      path        text        not null check (char_length(path) between 1 and 2048 and left(path, 1) = '/'),
      device      text        not null check (device in ('mobile', 'tablet', 'desktop')),
      width       integer     not null check (width between 1 and 16384),
      height      integer     not null check (height between 1 and 16384),
      page_height integer     not null check (page_height between 1 and 1000000),
      object_key  text        not null unique
        check (object_key ~ '^heatmap-snapshots/[0-9a-f-]{36}/[0-9a-f-]{36}\\.json\\.gz$'),
      size_bytes  integer     not null check (size_bytes > 0),
      saved_by    uuid        references dashboard_users (id) on delete set null,
      saved_at    timestamptz not null default now(),
      primary key (project_id, path, device)
    )
  `.execute(db);
  await sql`
    alter table heatmap_overlay_tokens
      add column path text
        check (path is null or (char_length(path) between 1 and 2048 and left(path, 1) = '/'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table heatmap_overlay_tokens drop column path`.execute(db);
  await sql`drop table heatmap_snapshots`.execute(db);
}
