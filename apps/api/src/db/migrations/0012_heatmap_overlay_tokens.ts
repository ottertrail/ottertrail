import { type Kysely, sql } from "kysely";

/**
 * Heatmap overlay tokens (docs/web-analytics.md, "The overlay on your
 * site"; access/overlay-tokens.ts): links that open a project's heatmap
 * over the owner's live page, and the sessions they are exchanged for.
 * Only a SHA-256 hash of each token is kept, as for invitations.
 *
 * - kind 'link': minted in the dashboard, used once (used_at), 5 minutes.
 * - kind 'session': what a link is exchanged for, 30 minutes.
 *
 * Each is bound to its user, its project, and its scope; it goes with the
 * user or the project. Rows are purged a day after they expire, so that a
 * link used or expired is still told apart from one never made
 * (overlay-tokens.ts, purgeOverlayTokens).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table heatmap_overlay_tokens (
      token_hash bytea       primary key,
      kind       text        not null check (kind in ('link', 'session')),
      user_id    uuid        not null references dashboard_users (id) on delete cascade,
      project_id uuid        not null references projects (id) on delete cascade,
      scope      text        not null check (scope = 'heatmap:read'),
      expires_at timestamptz not null,
      used_at    timestamptz,
      created_at timestamptz not null default now(),
      check (kind = 'link' or used_at is null)
    )
  `.execute(db);
  await sql`create index heatmap_overlay_tokens_expires_at on heatmap_overlay_tokens (expires_at)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table heatmap_overlay_tokens`.execute(db);
}
