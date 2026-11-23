import type { Kysely, Transaction } from "kysely";

import type { Auth } from "../auth/auth.ts";
import { hashToken, newToken } from "../auth/tokens.ts";
import type { Database } from "../db/schema.ts";
import { type Actor, lockUser, mayManage } from "./members.ts";

/** How long a reset link from the Members page works. */
export const RESET_LINK_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a reset link from the server's command works. */
export const COMMAND_RESET_TTL_MS = 60 * 60 * 1000;
/** How long a reset link asked for on the sign-in page, and emailed, works. */
export const EMAILED_RESET_TTL_MS = 60 * 60 * 1000;

/** Who made a link: a user on the Members page, the server's command, or a request on the sign-in page. */
export type ResetMaker = { userId: string } | "command" | "email";

/**
 * Keep at most one emailed and one other reset link per user, replacing only
 * the same kind so public requests cannot void owner/admin links. Store only
 * token hashes. Check the maker's authority both when creating and using links
 * (docs/access.md).
 */
export async function createPasswordReset(
  db: Kysely<Database> | Transaction<Database>,
  userId: string,
  { madeBy, ttlMs, now }: { madeBy: ResetMaker; ttlMs: number; now: Date },
): Promise<{ token: string; expiresAt: Date }> {
  const { token, hash } = newToken();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const values = {
    token_hash: hash,
    expires_at: expiresAt,
    created_by: typeof madeBy === "string" ? null : madeBy.userId,
    made_by_command: madeBy === "command",
    created_at: now,
  };
  await db
    .insertInto("dashboard_password_resets")
    .values({ ...values, user_id: userId, emailed: madeBy === "email" })
    .onConflict((conflict) => conflict.columns(["user_id", "emailed"]).doUpdateSet(values))
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

export async function previewPasswordReset(
  db: Kysely<Database>,
  token: string,
  now: Date,
): Promise<{ email: string } | null> {
  const found = await validReset(db, token, now);
  return found === undefined ? null : { email: found.email };
}

/**
 * Atomically consumes the link, changes the password with Better Auth's hash,
 * and revokes all sessions. Returns the sign-in email, or null for invalid links.
 */
export async function usePasswordReset(
  db: Kysely<Database>,
  auth: Auth,
  token: string,
  password: string,
  now: Date,
): Promise<{ email: string } | null> {
  // Validate before paying the password hash cost (about 40 ms).
  if ((await validReset(db, token, now)) === undefined) return null;
  const passwordHash = await (await auth.$context).password.hash(password);
  return db.transaction().execute(async (trx) => {
    // Lock users before links, matching email and access changes, to avoid deadlocks.
    const found = await trx
      .selectFrom("dashboard_password_resets")
      .select(["user_id", "created_by", "made_by_command", "emailed"])
      .where("token_hash", "=", hashToken(token))
      .executeTakeFirst();
    if (found === undefined) return null;
    // Recheck the maker and target roles under lock. Demotion of the maker or
    // promotion of the target can invalidate user-made links. Command and email
    // links have no maker to check.
    const byMaker = !found.made_by_command && !found.emailed;
    const maker =
      byMaker && found.created_by !== null ? await lockUser(trx, found.created_by) : null;
    const target = await lockUser(trx, found.user_id);
    if (target === null) return null;
    if (byMaker && (maker === null || !mayManage(maker, target))) return null;
    const used = await trx
      .deleteFrom("dashboard_password_resets")
      .where("token_hash", "=", hashToken(token))
      .where("user_id", "=", found.user_id)
      .where("expires_at", ">", now)
      .returning("user_id")
      .executeTakeFirst();
    if (used === undefined) return null;
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
    // Invalidate the other kind of reset link too; it could change the password again.
    await trx.deleteFrom("dashboard_password_resets").where("user_id", "=", used.user_id).execute();
    const user = await trx
      .selectFrom("dashboard_users")
      .select("email")
      .where("id", "=", used.user_id)
      .executeTakeFirstOrThrow();
    return { email: user.email };
  });
}

/**
 * Admins may reset members; the owner may reset anyone else. Lock the target
 * first so its role cannot change before the link is made.
 */
export async function makeResetLink(
  db: Kysely<Database>,
  actor: Actor,
  targetId: string,
  now: Date,
): Promise<{ token: string; expiresAt: Date; email: string } | "not_found" | "forbidden"> {
  return db.transaction().execute(async (trx) => {
    const target = await lockUser(trx, targetId);
    if (target === null) return "not_found";
    if (!mayManage(actor, target)) return "forbidden";
    const made = await createPasswordReset(trx, target.id, {
      madeBy: { userId: actor.id },
      ttlMs: RESET_LINK_TTL_MS,
      now,
    });
    const { email } = await trx
      .selectFrom("dashboard_users")
      .select("email")
      .where("id", "=", target.id)
      .executeTakeFirstOrThrow();
    return { ...made, email };
  });
}
