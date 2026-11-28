import { createHash, randomBytes } from "node:crypto";

import type { Kysely } from "kysely";

import type { Database } from "../db/schema.ts";

/**
 * Shared links (docs/web-analytics.md, "Shared links"): a secret address,
 * `/share/<token>`, that shows one project's Web analytics in one
 * environment, read-only, without signing in. The token is the capability:
 * only its SHA-256 hash is stored, and it is shown once, when made.
 */

/** Links a project may have at once. */
export const MAX_LINKS = 10;
/** 32 random bytes: 256 bits, 43 URL-safe characters. */
const TOKEN_BYTES = 32;
export const TOKEN_PATTERN = /^[\w-]{43}$/u;
/** The token's first characters, shown in the settings to tell links apart. */
const PREFIX_LENGTH = 6;
/** How often opening a link records the time: at most once a minute per link. */
const OPENED_EVERY_MS = 60_000;

/** What the settings list shows of a link: never its token or hash. */
export interface ShareLink {
  id: string;
  name: string;
  environment: string;
  /** The token's first characters. */
  prefix: string;
  createdAt: string;
  /** Who made it; null once that user is removed. */
  createdBy: { id: string; name: string } | null;
  lastOpenedAt: string | null;
}

/** Lookups go by the hash, so their time tells nothing about a guessed token's text. */
export function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export async function listShareLinks(
  db: Kysely<Database>,
  projectId: string,
): Promise<ShareLink[]> {
  const rows = await db
    .selectFrom("share_links as l")
    .leftJoin("dashboard_users as u", "u.id", "l.created_by")
    .select([
      "l.id",
      "l.name",
      "l.environment",
      "l.token_prefix",
      "l.created_at",
      "l.last_opened_at",
      "u.id as user_id",
      "u.name as user_name",
    ])
    .where("l.project_id", "=", projectId)
    .orderBy("l.created_at")
    .orderBy("l.id")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    environment: row.environment,
    prefix: row.token_prefix,
    createdAt: row.created_at.toISOString(),
    createdBy:
      row.user_id === null || row.user_name === null
        ? null
        : { id: row.user_id, name: row.user_name },
    lastOpenedAt: row.last_opened_at?.toISOString() ?? null,
  }));
}

/**
 * Makes a link, or refuses at MAX_LINKS. The count and the insert run in
 * one transaction, after locking the project's row, so two at once cannot
 * pass the limit together. The token is returned once and never stored.
 */
export async function createShareLink(
  db: Kysely<Database>,
  options: { projectId: string; name: string; environment: string; createdBy: string },
): Promise<{ link: ShareLink; token: string } | { refused: "too_many" } | null> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return db.transaction().execute(async (trx) => {
    const project = await trx
      .selectFrom("projects")
      .select("id")
      .where("id", "=", options.projectId)
      .forUpdate()
      .executeTakeFirst();
    if (project === undefined) return null;
    const { count } = await trx
      .selectFrom("share_links")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("project_id", "=", options.projectId)
      .executeTakeFirstOrThrow();
    if (Number(count) >= MAX_LINKS) return { refused: "too_many" as const };
    const row = await trx
      .insertInto("share_links")
      .values({
        project_id: options.projectId,
        name: options.name,
        environment: options.environment,
        token_hash: tokenHash(token),
        token_prefix: token.slice(0, PREFIX_LENGTH),
        created_by: options.createdBy,
      })
      .returning(["id", "created_at"])
      .executeTakeFirstOrThrow();
    const user = await trx
      .selectFrom("dashboard_users")
      .select(["id", "name"])
      .where("id", "=", options.createdBy)
      .executeTakeFirst();
    return {
      token,
      link: {
        id: row.id,
        name: options.name,
        environment: options.environment,
        prefix: token.slice(0, PREFIX_LENGTH),
        createdAt: row.created_at.toISOString(),
        createdBy: user ?? null,
        lastOpenedAt: null,
      },
    };
  });
}

/** Revokes a link: its row goes, so its address stops at once. False when the project has none with this ID. */
export async function deleteShareLink(
  db: Kysely<Database>,
  projectId: string,
  linkId: string,
): Promise<boolean> {
  const result = await db
    .deleteFrom("share_links")
    .where("project_id", "=", projectId)
    .where("id", "=", linkId)
    .executeTakeFirst();
  return result.numDeletedRows > 0n;
}

/** What a working token opens: its link, project, and environment. */
export interface OpenedLink {
  linkId: string;
  projectId: string;
  environment: string;
}

/** The link a token opens, or null for a malformed, unknown, or revoked one, alike. */
export async function findShareLink(
  db: Kysely<Database>,
  token: string,
): Promise<OpenedLink | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const row = await db
    .selectFrom("share_links")
    .select(["id", "project_id", "environment"])
    .where("token_hash", "=", tokenHash(token))
    .executeTakeFirst();
  return row === undefined
    ? null
    : { linkId: row.id, projectId: row.project_id, environment: row.environment };
}

/** Records that the link was opened, at most once a minute, so a busy link writes little. */
export async function markOpened(db: Kysely<Database>, linkId: string, now: Date): Promise<void> {
  await db
    .updateTable("share_links")
    .set({ last_opened_at: now })
    .where("id", "=", linkId)
    .where((eb) =>
      eb.or([
        eb("last_opened_at", "is", null),
        eb("last_opened_at", "<", new Date(now.getTime() - OPENED_EVERY_MS)),
      ]),
    )
    .execute();
}
