import type { Kysely } from "kysely";

import { hashToken, newToken } from "../auth/tokens.ts";
import type { Database } from "../db/schema.ts";

/**
 * Heatmap overlay tokens (docs/access.md, "Heatmap overlay tokens";
 * docs/web-analytics.md, "The overlay on your site").
 *
 * A signed-in user with Web analytics at view mints a link token for one
 * project in the dashboard, which opens their site with it in the URL's
 * fragment. The overlay script (o.js) exchanges it, once, for a session
 * token, which it keeps in memory and sends as `Authorization: Bearer` with
 * each read. Both are 32 random bytes, kept only as their SHA-256 hash, and
 * bound to the user, the project, the scope `heatmap:overlay`, and the
 * dashboard session that made it: signing out, a password reset, or that
 * session's end ends them too (a foreign key, and a check of the session's
 * expiry on each use). A token is
 * found by its hash, never compared as text, so the lookup leaks nothing
 * about a guess through its timing.
 *
 * A link may name the page it was made for; its session may then save a
 * view of that page, and of no other, when its user is the owner or an
 * admin (heatmaps/snapshots.ts).
 *
 * Neither grants anything by itself: every read and save checks the
 * user's role and grants again, through the same check as the dashboard's
 * routes (access.ts, requireOverlayAccess).
 */

/** How long a link works, unused. */
export const OVERLAY_LINK_TTL_MS = 5 * 60 * 1000;
/** How long a session lasts from the exchange. */
export const OVERLAY_SESSION_TTL_MS = 30 * 60 * 1000;
/**
 * Retain expired and spent hashes so the overlay can distinguish them from
 * unknown tokens. They cannot authorize reads.
 */
export const OVERLAY_TOKEN_KEEP_MS = 24 * 60 * 60 * 1000;
/**
 * Allows heatmap reads, and saving a view of the link's page only: the
 * save route also needs the owner or an admin.
 */
export const OVERLAY_SCOPE = "heatmap:overlay";
/** A token as newToken() writes it: 32 bytes in base64url, 43 characters. */
export const OVERLAY_TOKEN_PATTERN = "^[A-Za-z0-9_-]{43}$";
const TOKEN = new RegExp(OVERLAY_TOKEN_PATTERN);

/** Validate shape before database work. */
export const isOverlayToken = (text: string): boolean => TOKEN.test(text);

/** Deletes rows that expired more than OVERLAY_TOKEN_KEEP_MS ago. Run on each insert. */
export async function purgeOverlayTokens(db: Kysely<Database>, now: Date): Promise<void> {
  await db
    .deleteFrom("heatmap_overlay_tokens")
    .where("expires_at", "<", new Date(now.getTime() - OVERLAY_TOKEN_KEEP_MS))
    .execute();
}

/**
 * A new link for this user and project, for the page at `path` (null: a
 * link whose session saves nothing). Returns the token once; only its
 * hash is kept.
 */
export async function mintOverlayLink(
  db: Kysely<Database>,
  { userId, sessionId }: { userId: string; sessionId: string },
  projectId: string,
  now: Date,
  path: string | null = null,
): Promise<{ token: string; expiresAt: Date }> {
  await purgeOverlayTokens(db, now);
  const { token, hash } = newToken();
  const expiresAt = new Date(now.getTime() + OVERLAY_LINK_TTL_MS);
  await db
    .insertInto("heatmap_overlay_tokens")
    .values({
      token_hash: hash,
      kind: "link",
      user_id: userId,
      session_id: sessionId,
      project_id: projectId,
      scope: OVERLAY_SCOPE,
      expires_at: expiresAt,
      path,
    })
    .execute();
  return { token, expiresAt };
}

export interface OverlayLink {
  userId: string;
  sessionId: string;
  projectId: string;
  allowedHostnames: string[];
  path: string | null;
  /** Used already, or past its 5 minutes. */
  spent: boolean;
}

/** Includes spent links; null for unknown tokens. */
export async function findOverlayLink(
  db: Kysely<Database>,
  token: string,
  now: Date,
): Promise<OverlayLink | null> {
  const row = await db
    .selectFrom("heatmap_overlay_tokens as t")
    .innerJoin("projects as p", "p.id", "t.project_id")
    .innerJoin("dashboard_sessions as s", "s.id", "t.session_id")
    .select([
      "t.user_id",
      "t.session_id",
      "t.project_id",
      "t.used_at",
      "t.expires_at",
      "t.path",
      "p.allowed_hostnames",
      "s.expires_at as session_expires_at",
    ])
    .where("t.token_hash", "=", hashToken(token))
    .where("t.kind", "=", "link")
    .where("t.scope", "=", OVERLAY_SCOPE)
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    userId: row.user_id,
    sessionId: row.session_id,
    projectId: row.project_id,
    allowedHostnames: row.allowed_hostnames,
    path: row.path,
    spent: row.used_at !== null || row.expires_at <= now || row.session_expires_at <= now,
  };
}

/** Atomically consumes a valid link; only one concurrent request can succeed. */
export async function useOverlayLink(
  db: Kysely<Database>,
  token: string,
  now: Date,
): Promise<boolean> {
  const row = await db
    .updateTable("heatmap_overlay_tokens")
    .set({ used_at: now })
    .where("token_hash", "=", hashToken(token))
    .where("kind", "=", "link")
    .where("used_at", "is", null)
    .where("expires_at", ">", now)
    .returning("user_id")
    .executeTakeFirst();
  return row !== undefined;
}

/** Returns the token once; store only its hash. Carries the link's user, project, and page. */
export async function startOverlaySession(
  db: Kysely<Database>,
  { userId, sessionId, path }: { userId: string; sessionId: string; path: string | null },
  projectId: string,
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  await purgeOverlayTokens(db, now);
  const { token, hash } = newToken();
  const expiresAt = new Date(now.getTime() + OVERLAY_SESSION_TTL_MS);
  await db
    .insertInto("heatmap_overlay_tokens")
    .values({
      token_hash: hash,
      kind: "session",
      user_id: userId,
      session_id: sessionId,
      project_id: projectId,
      scope: OVERLAY_SCOPE,
      expires_at: expiresAt,
      path,
    })
    .execute();
  return { token, expiresAt };
}

/**
 * The user of a session for this project that has not expired, nor the
 * dashboard session that made it, or null.
 */
export async function overlaySessionUser(
  db: Kysely<Database>,
  token: string,
  projectId: string,
  now: Date,
): Promise<string | null> {
  const row = await db
    .selectFrom("heatmap_overlay_tokens as t")
    .innerJoin("dashboard_sessions as s", "s.id", "t.session_id")
    .select("t.user_id")
    .where("t.token_hash", "=", hashToken(token))
    .where("t.kind", "=", "session")
    .where("t.scope", "=", OVERLAY_SCOPE)
    .where("t.project_id", "=", projectId)
    .where("t.expires_at", ">", now)
    .where("s.expires_at", ">", now)
    .executeTakeFirst();
  return row?.user_id ?? null;
}

/**
 * The page a session may save a view of (its link's), or null: checked as
 * overlaySessionUser checks the session, not only after it, so a session
 * that ended meanwhile saves nothing.
 */
export async function overlaySessionPath(
  db: Kysely<Database>,
  token: string,
  projectId: string,
  now: Date,
): Promise<string | null> {
  const row = await db
    .selectFrom("heatmap_overlay_tokens as t")
    .innerJoin("dashboard_sessions as s", "s.id", "t.session_id")
    .select("t.path")
    .where("t.token_hash", "=", hashToken(token))
    .where("t.kind", "=", "session")
    .where("t.scope", "=", OVERLAY_SCOPE)
    .where("t.project_id", "=", projectId)
    .where("t.expires_at", ">", now)
    .where("s.expires_at", ">", now)
    .executeTakeFirst();
  return row?.path ?? null;
}
