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
 * bound to the user, the project, the scope `heatmap:read`, and the
 * dashboard session that made it: signing out, a password reset, or that
 * session's end ends them too (a foreign key, and a check of the session's
 * expiry on each use). A token is
 * found by its hash, never compared as text, so the lookup leaks nothing
 * about a guess through its timing.
 *
 * Neither grants anything by itself: every read checks the user's role
 * and grants again, through the same check as the dashboard's routes
 * (access.ts, requireOverlayAccess).
 */

/** How long a link works, unused. */
export const OVERLAY_LINK_TTL_MS = 5 * 60 * 1000;
/** How long a session lasts from the exchange. */
export const OVERLAY_SESSION_TTL_MS = 30 * 60 * 1000;
/**
 * How long rows are kept after they expire: a link used or expired is
 * still known for this long, so the overlay can say so (rather than fail
 * without a reason, as for a token never made). Only hashes, of no use.
 */
export const OVERLAY_TOKEN_KEEP_MS = 24 * 60 * 60 * 1000;
/** The only scope there is: heatmap aggregates of one project. */
export const OVERLAY_SCOPE = "heatmap:read";
/** A token as newToken() writes it: 32 bytes in base64url, 43 characters. */
export const OVERLAY_TOKEN_PATTERN = "^[A-Za-z0-9_-]{43}$";
const TOKEN = new RegExp(OVERLAY_TOKEN_PATTERN);

/** Whether text has a token's shape: checked before any database work. */
export const isOverlayToken = (text: string): boolean => TOKEN.test(text);

/** Deletes rows that expired more than OVERLAY_TOKEN_KEEP_MS ago. Run on each insert. */
export async function purgeOverlayTokens(db: Kysely<Database>, now: Date): Promise<void> {
  await db
    .deleteFrom("heatmap_overlay_tokens")
    .where("expires_at", "<", new Date(now.getTime() - OVERLAY_TOKEN_KEEP_MS))
    .execute();
}

/** A new link for this user and project. Returns the token once; only its hash is kept. */
export async function mintOverlayLink(
  db: Kysely<Database>,
  { userId, sessionId }: { userId: string; sessionId: string },
  projectId: string,
  now: Date,
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
    })
    .execute();
  return { token, expiresAt };
}

/** A link as found by its hash: what it is for, with its project's allowed hostnames. */
export interface OverlayLink {
  userId: string;
  sessionId: string;
  projectId: string;
  allowedHostnames: string[];
  /** Used already, or past its 5 minutes. */
  spent: boolean;
}

/** The link with this token, used or not, or null when none is known. */
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
    spent: row.used_at !== null || row.expires_at <= now || row.session_expires_at <= now,
  };
}

/**
 * Uses the link: true for the one request that does so while it is valid,
 * false for every other (used already, expired, or another request won).
 */
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

/** A session for the link's user and project. Returns the token once; only its hash is kept. */
export async function startOverlaySession(
  db: Kysely<Database>,
  { userId, sessionId }: { userId: string; sessionId: string },
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
