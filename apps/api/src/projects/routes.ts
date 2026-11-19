import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import {
  can,
  canReachProject,
  requirePermission,
  requireProjectAccess,
  type UserAccess,
  userAccessOf,
} from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import type { Database } from "../db/schema.ts";
import {
  createProject,
  deleteProject,
  findProject,
  listProjects,
  MAX_ALLOWED_HOSTNAMES,
  MAX_PROJECT_NAME_LENGTH,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  parseHostnames,
  type Project,
  replacePublicKey,
  replaceSecretKey,
  updateProject,
} from "./projects.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const nameSchema = {
  type: "string",
  minLength: 1,
  maxLength: MAX_PROJECT_NAME_LENGTH,
  pattern: "\\S",
} as const;
const hostnamesSchema = {
  type: "array",
  // Generous here; parseHostnames enforces the real limit after removing duplicates.
  maxItems: MAX_ALLOWED_HOSTNAMES * 2,
  items: { type: "string", maxLength: 300 },
} as const;
const idParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

function problem(code: string, message: string) {
  return { error: code, message };
}

/**
 * A project as this user may see it: in full for those who manage
 * projects, otherwise without its keys and settings (docs/access.md).
 */
function shownTo(access: UserAccess, project: Project) {
  if (can(access, "projects")) {
    return project;
  }
  const { id, name, createdAt, lastEventAt } = project;
  return { id, name, createdAt, lastEventAt };
}

/**
 * Projects, for the signed-in dashboard. Every user sees the projects they
 * may reach; only the owner and admins see keys and settings, and create,
 * change, and delete projects (docs/access.md). Every route on one project
 * runs requireProjectAccess first.
 *
 * Changes to allowed hostnames reach the collection endpoint within a
 * minute, the lifetime of its project cache (collection/project-keys.ts).
 * A replaced key or a deleted project's key stops working at once: the
 * routes tell the cache to forget it.
 */
export const projectRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  trustedOrigins: readonly string[];
  /** The collection endpoint's key cache, which must forget replaced and deleted keys. */
  projectKeys?: { forget(publicKey: string): void; forgetProject(projectId: string): void };
}> = (app, { db, auth, trustedOrigins, projectKeys }, done) => {
  const signedIn = requireSession(auth);
  const fromDashboard = requireTrustedOrigin(trustedOrigins);
  const anyUser = requirePermission(db, "signed_in");
  const manageProjects = requirePermission(db, "projects");
  const reachProject = requireProjectAccess(db, "project");
  const manageProject = requireProjectAccess(db, { permission: "projects" });

  app.get("/projects", { preHandler: [signedIn, anyUser] }, async (request) => {
    const access = userAccessOf(request);
    return {
      projects: (await listProjects(db))
        .filter((project) => canReachProject(access, project.id))
        .map((project) => shownTo(access, project)),
    };
  });

  app.get<{ Params: { id: string } }>(
    "/projects/:id",
    { preHandler: [signedIn, reachProject], schema: { params: idParamsSchema } },
    async (request, reply) => {
      const project = await findProject(db, request.params.id);
      return project === null
        ? reply.code(404).send(problem("not_found", "No project has this ID."))
        : { project: shownTo(userAccessOf(request), project) };
    },
  );

  app.post<{ Body: { name: string; allowedHostnames?: string[] } }>(
    "/projects",
    {
      preHandler: [fromDashboard, signedIn, manageProjects],
      schema: {
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: { name: nameSchema, allowedHostnames: hostnamesSchema },
        },
      },
    },
    async (request, reply) => {
      const hostnames = parseHostnames(request.body.allowedHostnames ?? []);
      if (!hostnames.ok) {
        return reply.code(400).send(problem("invalid_hostname", hostnames.message));
      }
      const project = await createProject(db, {
        name: request.body.name.trim(),
        allowedHostnames: hostnames.hostnames,
      });
      return reply.code(201).send({ project });
    },
  );

  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      allowedHostnames?: string[];
      retentionDays?: number | null;
      requireSignedUserIds?: boolean;
      ignoreDataCenters?: boolean;
      replayMode?: "off" | "errors";
      mainGoalId?: string | null;
    };
  }>(
    "/projects/:id",
    {
      preHandler: [fromDashboard, signedIn, manageProject],
      schema: {
        params: idParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: nameSchema,
            allowedHostnames: hostnamesSchema,
            // null keeps events forever.
            retentionDays: {
              type: ["integer", "null"],
              minimum: MIN_RETENTION_DAYS,
              maximum: MAX_RETENTION_DAYS,
            },
            requireSignedUserIds: { type: "boolean" },
            ignoreDataCenters: { type: "boolean" },
            // Session replays around errors (docs/session-replay.md); off by default.
            replayMode: { type: "string", enum: ["off", "errors"] },
            // The overview's main goal: one of the project's goals, or null for none.
            mainGoalId: { type: ["string", "null"], pattern: UUID_PATTERN },
          },
        },
      },
    },
    async (request, reply) => {
      const {
        name,
        allowedHostnames,
        retentionDays,
        requireSignedUserIds,
        ignoreDataCenters,
        replayMode,
        mainGoalId,
      } = request.body;
      let hostnames: string[] | undefined;
      if (allowedHostnames !== undefined) {
        const parsed = parseHostnames(allowedHostnames);
        if (!parsed.ok) {
          return reply.code(400).send(problem("invalid_hostname", parsed.message));
        }
        hostnames = parsed.hostnames;
      }
      const project = await updateProject(db, request.params.id, {
        ...(name === undefined ? {} : { name: name.trim() }),
        ...(hostnames === undefined ? {} : { allowedHostnames: hostnames }),
        ...(retentionDays === undefined ? {} : { retentionDays }),
        ...(requireSignedUserIds === undefined ? {} : { requireSignedUserIds }),
        ...(ignoreDataCenters === undefined ? {} : { ignoreDataCenters }),
        ...(replayMode === undefined ? {} : { replayMode }),
        ...(mainGoalId === undefined ? {} : { mainGoalId }),
      });
      if (project === "no_such_goal") {
        return reply
          .code(400)
          .send(problem("goal_not_found", "The project has no goal with this ID."));
      }
      // Collection reads these rules from its cache: a change applies at once.
      if (
        requireSignedUserIds !== undefined ||
        ignoreDataCenters !== undefined ||
        replayMode !== undefined
      ) {
        projectKeys?.forgetProject(request.params.id);
      }
      return project === null
        ? reply.code(404).send(problem("not_found", "No project has this ID."))
        : { project };
    },
  );

  /**
   * Deletes a project and all its events, for good. The request repeats the
   * project's name, so a mistaken ID or a stray request cannot delete one.
   */
  app.delete<{ Params: { id: string }; Body: { confirmName: string } }>(
    "/projects/:id",
    {
      preHandler: [fromDashboard, signedIn, manageProject],
      schema: {
        params: idParamsSchema,
        body: {
          type: "object",
          required: ["confirmName"],
          additionalProperties: false,
          properties: { confirmName: { type: "string", maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      const project = await findProject(db, request.params.id);
      if (project === null) {
        return reply.code(404).send(problem("not_found", "No project has this ID."));
      }
      if (request.body.confirmName.trim() !== project.name) {
        return reply
          .code(400)
          .send(problem("name_mismatch", "Type the project's name exactly to delete it."));
      }
      const deleted = await deleteProject(db, project.id);
      if (deleted !== null) {
        projectKeys?.forget(deleted.publicKey);
        projectKeys?.forgetProject(project.id);
      }
      return reply.code(204).send();
    },
  );

  /** Replaces a project's public key: pages with the old snippet stop sending events. */
  app.post<{ Params: { id: string } }>(
    "/projects/:id/public-key",
    { preHandler: [fromDashboard, signedIn, manageProject], schema: { params: idParamsSchema } },
    async (request, reply) => {
      const replaced = await replacePublicKey(db, request.params.id);
      if (replaced === null) {
        return reply.code(404).send(problem("not_found", "No project has this ID."));
      }
      projectKeys?.forget(replaced.oldKey);
      return { project: replaced.project };
    },
  );

  /**
   * Replaces a project's secret key: servers with the old one stop sending
   * events, and user IDs signed with it no longer pass.
   */
  app.post<{ Params: { id: string } }>(
    "/projects/:id/secret-key",
    { preHandler: [fromDashboard, signedIn, manageProject], schema: { params: idParamsSchema } },
    async (request, reply) => {
      const project = await replaceSecretKey(db, request.params.id);
      if (project === null) {
        return reply.code(404).send(problem("not_found", "No project has this ID."));
      }
      projectKeys?.forgetProject(project.id);
      return { project };
    },
  );
  done();
};
