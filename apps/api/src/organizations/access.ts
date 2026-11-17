import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import type { Database, MembershipRole } from "../db/schema.ts";

/**
 * What a signed-in user may reach of one project: set on the request by
 * requireProjectAccess before any project route runs.
 */
export interface ProjectAccess {
  projectId: string;
  organizationId: string;
  /** The organization's timezone, which its reports count days in. */
  timeZone: string;
  /** The user's role in the project's organization. */
  role: MembershipRole;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by requireProjectAccess on the routes that use it. */
    projectAccess: ProjectAccess | null;
  }
}

/**
 * The project, if the user is a member of its organization; null otherwise,
 * whether or not the project exists, so a project of another organization
 * looks exactly like one that does not exist.
 */
export async function findProjectAccess(
  db: Kysely<Database>,
  userId: string,
  projectId: string,
): Promise<ProjectAccess | null> {
  const row = await db
    .selectFrom("projects")
    .innerJoin("organizations", "organizations.id", "projects.organization_id")
    .innerJoin("memberships", (join) =>
      join
        .onRef("memberships.organization_id", "=", "projects.organization_id")
        .on("memberships.user_id", "=", userId),
    )
    .select([
      "projects.id",
      "projects.organization_id",
      "organizations.time_zone",
      "memberships.role",
    ])
    .where("projects.id", "=", projectId)
    .executeTakeFirst();
  return row === undefined
    ? null
    : {
        projectId: row.id,
        organizationId: row.organization_id,
        timeZone: row.time_zone,
        role: row.role,
      };
}

/**
 * The one check every route under /projects/:id runs, after requireSession:
 * the signed-in user must be a member of the project's organization.
 * Otherwise the answer is 404, the same as for a project that does not
 * exist, so IDs of other organizations' projects reveal nothing.
 *
 * Fastify validates the route's params before this runs, so `id` is a UUID.
 */
export function requireProjectAccess(db: Kysely<Database>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.dashboardUser;
    const { params } = request;
    const projectId =
      typeof params === "object" && params !== null && "id" in params ? params.id : undefined;
    if (user === null || typeof projectId !== "string") {
      // A route registered without requireSession first: refuse rather than guess.
      return reply.code(401).send({ error: "unauthorized", message: "Sign in to continue." });
    }
    const access = await findProjectAccess(db, user.id, projectId);
    if (access === null) {
      return reply.code(404).send({ error: "not_found", message: "No project has this ID." });
    }
    request.projectAccess = access;
    // Nothing sent: Fastify goes on to the route handler.
    return undefined;
  };
}
