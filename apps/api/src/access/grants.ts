import { type Kysely, sql, type Transaction } from "kysely";

import type { Database } from "../db/schema.ts";
import type { Areas } from "./areas.ts";

/** A user's new role, and a member's access with it (docs/access.md). */
export type AccessChange =
  | { role: "admin" }
  | { role: "member"; projects: "all" | readonly string[]; areas: Areas };

/**
 * Sets a user's role and grants: the one place that changes them, so no
 * old grant can come back. An admin keeps no grants rows; a member gets
 * exactly `projects` and `areas`, and "all" clears their project list.
 * Projects deleted meanwhile are dropped. The owner is never changed here
 * (handing ownership over is its own step). Returns false when no such
 * user, or the owner.
 */
export async function setUserAccess(
  db: Kysely<Database>,
  userId: string,
  change: AccessChange,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => setUserAccessIn(trx, userId, change));
}

/** setUserAccess inside a transaction the caller holds, such as accepting an invitation. */
export async function setUserAccessIn(
  trx: Transaction<Database>,
  userId: string,
  change: AccessChange,
): Promise<boolean> {
  const updated = await trx
    .updateTable("dashboard_users")
    .set({ role: change.role })
    .where("id", "=", userId)
    .where("role", "<>", "owner")
    .returning("id")
    .executeTakeFirst();
  if (updated === undefined) {
    return false;
  }
  // The projects go with it (a foreign key).
  await trx.deleteFrom("dashboard_member_access").where("user_id", "=", userId).execute();
  if (change.role === "admin") {
    return true;
  }
  await trx
    .insertInto("dashboard_member_access")
    .values({ user_id: userId, all_projects: change.projects === "all", ...change.areas })
    .execute();
  const { projects } = change;
  if (projects !== "all" && projects.length > 0) {
    await trx
      .insertInto("dashboard_member_projects")
      .columns(["user_id", "project_id"])
      .expression((eb) =>
        eb
          .selectFrom("projects")
          .select([sql<string>`cast(${userId} as uuid)`.as("user_id"), "projects.id as project_id"])
          .where("projects.id", "in", projects),
      )
      .execute();
  }
  return true;
}
