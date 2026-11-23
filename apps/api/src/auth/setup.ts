import type { Kysely } from "kysely";

import type { Database } from "../db/schema.ts";
import { forgetInstanceSettings, updateInstanceSettings } from "../settings/settings.ts";
import type { Auth } from "./auth.ts";
import { hashToken, newToken } from "./tokens.ts";

/** How long a setup link works. */
export const SETUP_LINK_TTL_MS = 60 * 60 * 1000;

/**
 * vp run setup prints a random link, valid once for an hour and only before
 * an owner exists. Requiring server access prevents the first visitor from
 * claiming a new instance. PostgreSQL stores only the SHA-256 token hash.
 */

export async function ownerExists(db: Kysely<Database>): Promise<boolean> {
  const owner = await db
    .selectFrom("dashboard_users")
    .select("id")
    .where("role", "=", "owner")
    .executeTakeFirst();
  return owner !== undefined;
}

/** Replaces earlier setup links. Returns null if an owner exists. */
export async function createSetupToken(
  db: Kysely<Database>,
  now = new Date(),
): Promise<{ token: string; expiresAt: Date } | null> {
  if (await ownerExists(db)) {
    return null;
  }
  const { token } = newToken();
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
  instanceName: string;
}

export type SetupResult = "created" | "invalid_link" | "already_set_up";

/**
 * Consumes the token and writes the owner, password, name, and timezone in one
 * transaction. Deleting the token prevents concurrent requests from reusing it.
 */
export async function completeSetup(
  db: Kysely<Database>,
  auth: Auth,
  { token, name, email, password, instanceName }: OwnerDetails,
  {
    timeZone,
    now = new Date(),
  }: {
    timeZone: string;
    now?: Date;
  },
): Promise<SetupResult> {
  // Check cheaply before scrypt (about 40 ms and 32 MB) so invalid links cost no hash.
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

  // Use Better Auth's hash outside the transaction; recheck the link inside it.
  const passwordHash = await (await auth.$context).password.hash(password);

  const result = await db.transaction().execute(async (trx): Promise<SetupResult> => {
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
    await updateInstanceSettings(trx, { name: instanceName, timeZone });
    return "created";
  });
  // Discard cached defaults after committing settings.
  forgetInstanceSettings(db);
  return result;
}
