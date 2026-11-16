import { createHash, randomBytes } from "node:crypto";

import type { Kysely } from "kysely";

import type { Database } from "../db/schema.ts";
import type { Auth } from "./auth.ts";

/** How long a setup link works. */
export const SETUP_LINK_TTL_MS = 60 * 60 * 1000;

/**
 * Creating the owner, the first dashboard account.
 *
 * Nobody can sign up, and there is no default password. Whoever runs the
 * instance runs `vp run setup`, which prints a link with a random token;
 * opening it lets them choose the owner's name, email, and password. The
 * link works once, for an hour, and stops working for good once an owner
 * exists. A setup page that let the first visitor become the owner would
 * hand a freshly deployed instance to whoever found it first.
 *
 * The database keeps only a SHA-256 hash of the token, so reading the
 * database does not reveal a working link.
 */
const hashToken = (token: string) => createHash("sha256").update(token).digest();

export async function ownerExists(db: Kysely<Database>): Promise<boolean> {
  const owner = await db
    .selectFrom("dashboard_users")
    .select("id")
    .where("role", "=", "owner")
    .executeTakeFirst();
  return owner !== undefined;
}

/**
 * A new setup link's token, replacing any earlier one, or null when the
 * instance already has an owner.
 */
export async function createSetupToken(
  db: Kysely<Database>,
  now = new Date(),
): Promise<{ token: string; expiresAt: Date } | null> {
  if (await ownerExists(db)) {
    return null;
  }
  // 32 random bytes: guessing a working token is not feasible.
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SETUP_LINK_TTL_MS);
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("owner_setup_tokens").execute();
    await trx
      .insertInto("owner_setup_tokens")
      .values({ token_hash: hashToken(token), expires_at: expiresAt })
      .execute();
  });
  return { token, expiresAt };
}

export interface OwnerDetails {
  token: string;
  name: string;
  email: string;
  password: string;
}

export type SetupResult = "created" | "invalid_link" | "already_set_up";

/**
 * Creates the owner from a setup link. Everything happens in one
 * transaction: the token is used up, and the user and their password are
 * stored together or not at all. Two requests with the same link cannot both
 * succeed: the first deletes the token, and the second finds nothing.
 */
export async function completeSetup(
  db: Kysely<Database>,
  auth: Auth,
  { token, name, email, password }: OwnerDetails,
  now = new Date(),
): Promise<SetupResult> {
  // Hashing a password is slow on purpose (scrypt: about 40 ms and 32 MB),
  // so the cheap checks come first: a made-up token, or a request after the
  // owner exists, costs one query, not a hash.
  if (await ownerExists(db)) {
    return "already_set_up";
  }
  const pending = await db
    .selectFrom("owner_setup_tokens")
    .select("token_hash")
    .where("token_hash", "=", hashToken(token))
    .where("expires_at", ">", now)
    .executeTakeFirst();
  if (pending === undefined) {
    return "invalid_link";
  }

  // Better Auth's own hash, so its sign-in can verify it. Outside the
  // transaction, which then checks the link again before using it.
  const passwordHash = await (await auth.$context).password.hash(password);

  return db.transaction().execute(async (trx) => {
    const used = await trx
      .deleteFrom("owner_setup_tokens")
      .where("token_hash", "=", hashToken(token))
      .where("expires_at", ">", now)
      .returning("token_hash")
      .executeTakeFirst();
    if (used === undefined) {
      return "invalid_link";
    }
    if (await ownerExists(trx)) {
      return "already_set_up";
    }
    const user = await trx
      .insertInto("dashboard_users")
      .values({ name, email: email.toLowerCase(), role: "owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    // How Better Auth stores a password: a "credential" account whose ID is the user's.
    await trx
      .insertInto("dashboard_accounts")
      .values({
        user_id: user.id,
        account_id: user.id,
        provider_id: "credential",
        password: passwordHash,
      })
      .execute();
    return "created";
  });
}
