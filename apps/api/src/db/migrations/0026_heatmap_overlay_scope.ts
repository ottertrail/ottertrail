import { type Kysely, sql } from "kysely";

/**
 * Overlay sessions read heatmaps and let owners/admins save views, so use heatmap:overlay scope
 * (access/overlay-tokens.ts).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table heatmap_overlay_tokens drop constraint heatmap_overlay_tokens_scope_check
  `.execute(db);
  await sql`update heatmap_overlay_tokens set scope = 'heatmap:overlay'`.execute(db);
  await sql`
    alter table heatmap_overlay_tokens
      add constraint heatmap_overlay_tokens_scope_check check (scope = 'heatmap:overlay')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table heatmap_overlay_tokens drop constraint heatmap_overlay_tokens_scope_check
  `.execute(db);
  await sql`update heatmap_overlay_tokens set scope = 'heatmap:read'`.execute(db);
  await sql`
    alter table heatmap_overlay_tokens
      add constraint heatmap_overlay_tokens_scope_check check (scope = 'heatmap:read')
  `.execute(db);
}
