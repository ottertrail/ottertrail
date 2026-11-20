import type { Kysely } from "kysely";

import { canReachProject, type UserAccess } from "../access/access.ts";
import type { Database } from "../db/schema.ts";

/*
 * Starred projects (docs/dashboard.md, "Starred projects"): each dashboard
 * user's own, kept in project_stars. Only a project the user may reach can
 * be starred (the routes check it through access.ts), and a star on one
 * they can no longer reach is never listed. Changing a member's projects
 * deletes their stars on the others (access/grants.ts); deleting the user
 * or the project deletes its stars (foreign keys).
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

/** Stars a project for a user; starring it again changes nothing. The caller checks access. */
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

/** Takes a user's star off a project, if they had one. */
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
