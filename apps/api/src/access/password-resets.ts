import type { Kysely, Transaction } from "kysely";

import type { Auth } from "../auth/auth.ts";
import { hashToken, newToken } from "../auth/tokens.ts";
import type { Database } from "../db/schema.ts";
import { type Actor, lockUser, mayManage } from "./members.ts";

/** How long a reset link from the Members page works. */
export const RESET_LINK_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a reset link from the server's command works. */
export const COMMAND_RESET_TTL_MS = 60 * 60 * 1000;

/**
 * A one-time link that sets a user's password (docs/access.md). A user has
 * one at most: a new one replaces the old. Only a hash of its token is
 * kept. `madeBy` names the user who made it, or is "command" for the server's
 * command. Callers check that the maker may reset the user; using the link
 * checks it again.
 */
export async function createPasswordReset(
  db: Kysely<Database> | Transaction<Database>,
  userId: string,
  { madeBy, ttlMs, now }: { madeBy: { userId: string } | "command"; ttlMs: number; now: Date },
): Promise<{ token: string; expiresAt: Date }> {
  const { token, hash } = newToken();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const values = {
    token_hash: hash,
    expires_at: expiresAt,
    created_by: madeBy === "command" ? null : madeBy.userId,
    made_by_command: madeBy === "command",
    created_at: now,
  };
  await db
    .insertInto("dashboard_password_resets")
    .values({ ...values, user_id: userId })
    .onConflict((conflict) => conflict.column("user_id").doUpdateSet(values))
    .execute();
  return { token, expiresAt };
}

function validReset(db: Kysely<Database>, token: string, now: Date) {
  return db
    .selectFrom("dashboard_password_resets as r")
    .innerJoin("dashboard_users as u", "u.id", "r.user_id")
    .select(["r.user_id", "u.email"])
    .where("r.token_hash", "=", hashToken(token))
    .where("r.expires_at", ">", now)
    .executeTakeFirst();
}

/** The account a reset link is for, or null when it no longer works. */
export async function previewPasswordReset(
  db: Kysely<Database>,
  token: string,
  now: Date,
): Promise<{ email: string } | null> {
  const found = await validReset(db, token, now);
  return found === undefined ? null : { email: found.email };
}

/**
 * Sets the password from a reset link, with Better Auth's hash, and
 * deletes all the user's sessions, in one transaction that uses up the
 * link. The old password works until then. Returns the email to sign in
 * with, or null when the link no longer works.
 */
export async function usePasswordReset(
  db: Kysely<Database>,
  auth: Auth,
  token: string,
  password: string,
  now: Date,
): Promise<{ email: string } | null> {
  // The cheap check first: hashing a password costs about 40 ms on purpose.
  if ((await validReset(db, token, now)) === undefined) return null;
  const passwordHash = await (await auth.$context).password.hash(password);
  return db.transaction().execute(async (trx) => {
    const used = await trx
      .deleteFrom("dashboard_password_resets")
      .where("token_hash", "=", hashToken(token))
      .where("expires_at", ">", now)
      .returning(["user_id", "created_by", "made_by_command"])
      .executeTakeFirst();
    if (used === undefined) return null;
    // A link a user made works only while they may still reset this user
    // as they are now: a maker since demoted, or a target since promoted,
    // makes it void. The rows are locked, so neither changes meanwhile.
    if (!used.made_by_command) {
      const maker = used.created_by === null ? null : await lockUser(trx, used.created_by);
      const target = await lockUser(trx, used.user_id);
      if (maker === null || target === null || !mayManage(maker, target)) return null;
    }
    const updated = await trx
      .updateTable("dashboard_accounts")
      .set({ password: passwordHash, updated_at: now })
      .where("user_id", "=", used.user_id)
      .where("provider_id", "=", "credential")
      .executeTakeFirst();
    if (updated.numUpdatedRows === 0n) {
      await trx
        .insertInto("dashboard_accounts")
        .values({
          user_id: used.user_id,
          account_id: used.user_id,
          provider_id: "credential",
          password: passwordHash,
        })
        .execute();
    }
    await trx.deleteFrom("dashboard_sessions").where("user_id", "=", used.user_id).execute();
    const user = await trx
      .selectFrom("dashboard_users")
      .select("email")
      .where("id", "=", used.user_id)
      .executeTakeFirstOrThrow();
    return { email: user.email };
  });
}

/**
 * A reset link for `targetId` made by `actor`, within the role rules:
 * admins reset members; the owner anyone else. The target's row is locked
 * first, so its role cannot change between the check and the link.
 */
export async function makeResetLink(
  db: Kysely<Database>,
  actor: Actor,
  targetId: string,
  now: Date,
): Promise<{ token: string; expiresAt: Date } | "not_found" | "forbidden"> {
  return db.transaction().execute(async (trx) => {
    const target = await lockUser(trx, targetId);
    if (target === null) return "not_found";
    if (!mayManage(actor, target)) return "forbidden";
    return createPasswordReset(trx, target.id, {
      madeBy: { userId: actor.id },
      ttlMs: RESET_LINK_TTL_MS,
      now,
    });
  });
}
