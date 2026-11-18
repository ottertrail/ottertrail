import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import type { Database } from "../db/schema.ts";
import { readInstanceSettings } from "../settings/settings.ts";

/**
 * What a signed-in user may reach of one project: set on the request by
 * requireProjectAccess before any project route runs.
 */
export interface ProjectAccess {
  projectId: string;
  /** The instance's timezone, which reports count days in. */
  timeZone: string;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by requireProjectAccess on the routes that use it. */
    projectAccess: ProjectAccess | null;
  }
}

/**
 * The one check every route under /projects/:id runs, after requireSession:
 * the request is signed in, and the project exists. Otherwise the answer
 * is 401 or 404. When dashboard users get roles, what each may reach is
 * decided here, and nowhere else.
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
    const project = await db
      .selectFrom("projects")
      .select("id")
      .where("id", "=", projectId)
      .executeTakeFirst();
    if (project === undefined) {
      return reply.code(404).send({ error: "not_found", message: "No project has this ID." });
    }
    const { timeZone } = await readInstanceSettings(db);
    request.projectAccess = { projectId: project.id, timeZone };
    // Nothing sent: Fastify goes on to the route handler.
    return undefined;
  };
}
