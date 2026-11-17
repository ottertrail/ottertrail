import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import type { Database } from "../db/schema.ts";
import { requireProjectAccess } from "../organizations/access.ts";
import { listOrganizations } from "../organizations/organizations.ts";
import { signedInUser } from "../organizations/routes.ts";
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
 * Projects, for the signed-in dashboard. A user sees and manages the
 * projects of the organizations they belong to: every route on one project
 * runs requireProjectAccess first, and the list and the create route check
 * memberships themselves. Every member may manage them until roles exist.
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
  const projectAccess = requireProjectAccess(db);

  app.get("/projects", { preHandler: signedIn }, async (request) => ({
    projects: await listProjects(db, signedInUser(request).id),
  }));

  app.get<{ Params: { id: string } }>(
    "/projects/:id",
    { preHandler: [signedIn, projectAccess], schema: { params: idParamsSchema } },
    async (request, reply) => {
      const project = await findProject(db, request.params.id);
      return project === null
        ? reply.code(404).send(problem("not_found", "No project has this ID."))
        : { project };
    },
  );

  /**
   * Creates a project in one of the user's organizations: the one named, or
   * the user's only one when none is named.
   */
  app.post<{ Body: { name: string; allowedHostnames?: string[]; organizationId?: string } }>(
    "/projects",
    {
      preHandler: [fromDashboard, signedIn],
      schema: {
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: nameSchema,
            allowedHostnames: hostnamesSchema,
            organizationId: { type: "string", pattern: UUID_PATTERN },
          },
        },
      },
    },
    async (request, reply) => {
      const hostnames = parseHostnames(request.body.allowedHostnames ?? []);
      if (!hostnames.ok) {
        return reply.code(400).send(problem("invalid_hostname", hostnames.message));
      }
      const organizations = await listOrganizations(db, signedInUser(request).id);
      const { organizationId } = request.body;
      const organization =
        organizationId === undefined
          ? organizations.length === 1
            ? organizations[0]
            : undefined
          : organizations.find((candidate) => candidate.id === organizationId);
      if (organization === undefined) {
        return organizationId === undefined
          ? reply
              .code(400)
              .send(
                problem(
                  "organization_required",
                  organizations.length === 0
                    ? "You belong to no organization, so you cannot create a project."
                    : "Choose the organization the project belongs to.",
                ),
              )
          : reply.code(404).send(problem("not_found", "No organization has this ID."));
      }
      const project = await createProject(db, {
        organizationId: organization.id,
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
    };
  }>(
    "/projects/:id",
    {
      preHandler: [fromDashboard, signedIn, projectAccess],
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
          },
        },
      },
    },
    async (request, reply) => {
      const { name, allowedHostnames, retentionDays, requireSignedUserIds, ignoreDataCenters } =
        request.body;
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
      });
      // Collection reads these rules from its cache: a change applies at once.
      if (requireSignedUserIds !== undefined || ignoreDataCenters !== undefined) {
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
      preHandler: [fromDashboard, signedIn, projectAccess],
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
    { preHandler: [fromDashboard, signedIn, projectAccess], schema: { params: idParamsSchema } },
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
    { preHandler: [fromDashboard, signedIn, projectAccess], schema: { params: idParamsSchema } },
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
