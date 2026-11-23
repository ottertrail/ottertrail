import { type Kysely, sql } from "kysely";

/**
 * The overlay tokens' scope is renamed from 'heatmap:read' to
 * 'heatmap:overlay' (access/overlay-tokens.ts): a session reads the
 * heatmap and, for the owner and admins, saves a view of its page, so
 * "read" no longer describes it. Rows already made are renamed with it.
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
