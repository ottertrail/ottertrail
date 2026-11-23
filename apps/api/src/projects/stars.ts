import type { Kysely } from "kysely";

import { canReachProject, type UserAccess } from "../access/access.ts";
import type { Database } from "../db/schema.ts";

/**
 * Stars require current project access (docs/dashboard.md, "Starred projects").
 * Grant changes remove inaccessible stars (access/grants.ts). Foreign keys remove
 * stars when a user or project is deleted.
 */

/** The IDs of the projects `access`'s user starred and may still reach, oldest star first. */
export async function listStarredProjects(
  db: Kysely<Database>,
  access: UserAccess,
): Promise<string[]> {
  const rows = await db
    .selectFrom("project_stars")
    .select("project_id")
    .where("user_id", "=", access.userId)
    .orderBy("created_at")
    .orderBy("project_id")
    .execute();
  return rows.map((row) => row.project_id).filter((id) => canReachProject(access, id));
}

/** Idempotent. The caller checks project access. */
export async function starProject(
  db: Kysely<Database>,
  userId: string,
  projectId: string,
): Promise<void> {
  await db
    .insertInto("project_stars")
    .values({ user_id: userId, project_id: projectId })
    .onConflict((conflict) => conflict.columns(["user_id", "project_id"]).doNothing())
    .execute();
}

export async function unstarProject(
  db: Kysely<Database>,
  userId: string,
  projectId: string,
): Promise<void> {
  await db
    .deleteFrom("project_stars")
    .where("user_id", "=", userId)
    .where("project_id", "=", projectId)
    .execute();
}
