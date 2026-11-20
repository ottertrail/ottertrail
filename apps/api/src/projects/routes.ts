import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import {
  can,
  canReachProject,
  checkProjectAccess,
  requirePermission,
  requireProjectAccess,
  type UserAccess,
  userAccessOf,
} from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import type { Database } from "../db/schema.ts";
import { MAX_BLOCKED_ADDRESSES, ownAddress, parseBlockedAddresses } from "./blocked-addresses.ts";
import { MAX_BLOCKED_REFERRERS, parseBlockedReferrers } from "./blocked-referrers.ts";
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
import { listStarredProjects, starProject, unstarProject } from "./stars.ts";

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
const blockedAddressesSchema = {
  type: "array",
  // Generous here; parseBlockedAddresses enforces the real limit after removing duplicates.
  maxItems: MAX_BLOCKED_ADDRESSES * 2,
  items: { type: "string", maxLength: 100 },
} as const;
const blockedReferrersSchema = {
  type: "array",
  // Generous here; parseBlockedReferrers enforces the real limit after removing duplicates.
  maxItems: MAX_BLOCKED_REFERRERS * 2,
  items: { type: "string", maxLength: 300 },
} as const;
const idParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;
const starParamsSchema = {
  type: "object",
  required: ["projectId"],
  properties: { projectId: { type: "string", pattern: UUID_PATTERN } },
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
  const { id, name, createdAt, lastEventAt, avatarUrl } = project;
  return { id, name, createdAt, lastEventAt, avatarUrl };
}

/**
 * Projects, for the signed-in dashboard. Every user sees the projects they
 * may reach; only the owner and admins see keys and settings, and create,
 * change, and delete projects (docs/access.md). Every route on one project
 * runs requireProjectAccess first.
 *
 * Changes to allowed hostnames reach the collection endpoint within a
 * minute, the lifetime of its project cache (collection/project-keys.ts);
 * changes to the collection rules (signed user IDs, data centers, replay
 * mode, heatmaps, blocked addresses and referrers) at once in this process.
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
      heatmaps?: boolean;
      mainGoalId?: string | null;
      blockedAddresses?: string[];
      blockedReferrers?: string[];
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
            // Heatmaps: clicks and scroll depth (docs/web-analytics.md, "Heatmaps"); off by default.
            heatmaps: { type: "boolean" },
            // The overview's main goal: one of the project's goals, or null for none.
            mainGoalId: { type: ["string", "null"], pattern: UUID_PATTERN },
            // Addresses and ranges whose browser events are ignored (blocked-addresses.ts).
            blockedAddresses: blockedAddressesSchema,
            // Referrer domains ignored, with their subdomains (blocked-referrers.ts).
            blockedReferrers: blockedReferrersSchema,
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
        heatmaps,
        mainGoalId,
        blockedAddresses,
        blockedReferrers,
      } = request.body;
      let hostnames: string[] | undefined;
      if (allowedHostnames !== undefined) {
        const parsed = parseHostnames(allowedHostnames);
        if (!parsed.ok) {
          return reply.code(400).send(problem("invalid_hostname", parsed.message));
        }
        hostnames = parsed.hostnames;
      }
      let blocked: string[] | undefined;
      if (blockedAddresses !== undefined) {
        const parsed = parseBlockedAddresses(blockedAddresses);
        if (!parsed.ok) {
          return reply.code(400).send(problem("invalid_address", parsed.message));
        }
        blocked = parsed.addresses;
      }
      let referrers: string[] | undefined;
      if (blockedReferrers !== undefined) {
        // Against the allowed hostnames as they will be after this change.
        const allowed =
          hostnames ?? (await findProject(db, request.params.id))?.allowedHostnames ?? [];
        const parsed = parseBlockedReferrers(blockedReferrers, allowed);
        if (!parsed.ok) {
          return reply.code(400).send(problem("invalid_referrer", parsed.message));
        }
        referrers = parsed.domains;
      }
      const project = await updateProject(db, request.params.id, {
        ...(name === undefined ? {} : { name: name.trim() }),
        ...(hostnames === undefined ? {} : { allowedHostnames: hostnames }),
        ...(retentionDays === undefined ? {} : { retentionDays }),
        ...(requireSignedUserIds === undefined ? {} : { requireSignedUserIds }),
        ...(ignoreDataCenters === undefined ? {} : { ignoreDataCenters }),
        ...(replayMode === undefined ? {} : { replayMode }),
        ...(heatmaps === undefined ? {} : { heatmaps }),
        ...(mainGoalId === undefined ? {} : { mainGoalId }),
        ...(blocked === undefined ? {} : { blockedAddresses: blocked }),
        ...(referrers === undefined ? {} : { blockedReferrers: referrers }),
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
        replayMode !== undefined ||
        heatmaps !== undefined ||
        blocked !== undefined ||
        referrers !== undefined
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

  /**
   * The requester's own address, as the API sees it (TRUST_PROXY applies),
   * for "Add my address" in a project's blocked addresses. Not logged: the
   * request log holds only the method and URL (app.ts), and the answer is
   * not logged.
   */
  app.get("/client-address", { preHandler: [signedIn, manageProjects] }, async (request) =>
    ownAddress(request.ip),
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

  /*
   * Starred projects: the signed-in user's own (stars.ts). They sit outside
   * /projects/:id because they change nothing of the project, only the
   * user's list; starring still needs the project, checked by the one
   * access check (checkProjectAccess), so a project the user may not reach
   * answers 404 as everywhere else.
   */
  app.get("/starred-projects", { preHandler: [signedIn, anyUser] }, async (request) => ({
    projectIds: await listStarredProjects(db, userAccessOf(request)),
  }));

  app.put<{ Params: { projectId: string } }>(
    "/starred-projects/:projectId",
    { preHandler: [fromDashboard, signedIn, anyUser], schema: { params: starParamsSchema } },
    async (request, reply) => {
      const { userId } = userAccessOf(request);
      const checked = await checkProjectAccess(db, userId, request.params.projectId, "project");
      if (!checked.ok) {
        return reply.code(checked.status).send(checked.body);
      }
      await starProject(db, userId, checked.access.projectId);
      return reply.code(204).send();
    },
  );

  // Taking a star off needs no access to the project: it deletes only the user's own row.
  app.delete<{ Params: { projectId: string } }>(
    "/starred-projects/:projectId",
    { preHandler: [fromDashboard, signedIn, anyUser], schema: { params: starParamsSchema } },
    async (request, reply) => {
      await unstarProject(db, userAccessOf(request).userId, request.params.projectId);
      return reply.code(204).send();
    },
  );
  done();
};
