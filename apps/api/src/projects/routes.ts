import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import type { Database } from "../db/schema.ts";
import {
  createProject,
  findProject,
  listProjects,
  MAX_ALLOWED_HOSTNAMES,
  MAX_PROJECT_NAME_LENGTH,
  parseHostnames,
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
 * Projects, for the signed-in dashboard. Any signed-in user may manage them
 * for now: only the owner can sign in until invitations and roles exist.
 *
 * Changes to allowed hostnames reach the collection endpoint within a
 * minute, the lifetime of its project cache (collection/project-keys.ts).
 */
export const projectRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  trustedOrigins: readonly string[];
}> = (app, { db, auth, trustedOrigins }, done) => {
  const signedIn = requireSession(auth);
  const fromDashboard = requireTrustedOrigin(trustedOrigins);

  app.get("/projects", { preHandler: signedIn }, async () => ({
    projects: await listProjects(db),
  }));

  app.get<{ Params: { id: string } }>(
    "/projects/:id",
    { preHandler: signedIn, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const project = await findProject(db, request.params.id);
      return project === null
        ? reply.code(404).send(problem("not_found", "No project has this ID."))
        : { project };
    },
  );

  app.post<{ Body: { name: string; allowedHostnames?: string[] } }>(
    "/projects",
    {
      preHandler: [fromDashboard, signedIn],
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

  app.patch<{ Params: { id: string }; Body: { name?: string; allowedHostnames?: string[] } }>(
    "/projects/:id",
    {
      preHandler: [fromDashboard, signedIn],
      schema: {
        params: idParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: { name: nameSchema, allowedHostnames: hostnamesSchema },
        },
      },
    },
    async (request, reply) => {
      const { name, allowedHostnames } = request.body;
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
      });
      return project === null
        ? reply.code(404).send(problem("not_found", "No project has this ID."))
        : { project };
    },
  );
  done();
};
