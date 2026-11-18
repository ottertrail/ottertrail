import type { FastifyPluginCallback, FastifyReply } from "fastify";
import type { Kysely } from "kysely";

import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import type { Database } from "../db/schema.ts";
import {
  FUNNEL_COUNTS,
  FUNNEL_WINDOWS,
  type FunnelCount,
  funnelRefusal,
  funnelStepsOf,
  type FunnelWindow,
  INVALID_STEPS,
  MAX_STEPS,
} from "../product/funnel.ts";
import { type ProjectAccess, requireProjectAccess } from "../projects/access.ts";
import {
  createSavedFunnel,
  deleteSavedFunnel,
  type FunnelDefinition,
  listSavedFunnels,
  MAX_SAVED_FUNNELS,
  updateSavedFunnel,
} from "./saved-funnels.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** A saved funnel's name: 1 to 100 characters after trimming, no control characters. */
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const FUNNEL_NAME = /^[^\u0000-\u001F\u007F]{1,100}$/u;

/** The access requireProjectAccess set: these routes always run it. */
function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

const problem = (error: string, message: string) => ({ error, message });

const NAME_TAKEN = problem("funnel_name_taken", "The project already has a funnel with this name.");
const NOT_FOUND = problem("funnel_not_found", "The project has no saved funnel with this ID.");

interface FunnelBody {
  name: string;
  steps: unknown[];
  count: FunnelCount;
  window: FunnelWindow;
}

const FUNNEL_BODY = {
  type: "object",
  required: ["name", "steps", "count", "window"] as string[],
  additionalProperties: false,
  properties: {
    name: { type: "string", maxLength: 200 },
    steps: { type: "array", maxItems: MAX_STEPS },
    count: { type: "string", enum: FUNNEL_COUNTS },
    window: { type: "integer", enum: FUNNEL_WINDOWS },
  },
};

/**
 * The funnel a request asks to save, checked as the funnel report checks
 * its own: or the answer that refuses it, already sent.
 */
function definitionOf(body: FunnelBody, reply: FastifyReply): FunnelDefinition | null {
  const name = body.name.trim();
  if (!FUNNEL_NAME.test(name)) {
    void reply
      .code(400)
      .send(
        problem(
          "invalid_name",
          "A funnel's name has 1 to 100 characters, and no control characters.",
        ),
      );
    return null;
  }
  const steps = funnelStepsOf(body.steps);
  if (steps === null) {
    void reply.code(400).send(INVALID_STEPS);
    return null;
  }
  const refusal = funnelRefusal(steps, body.count, body.window);
  if (refusal !== null) {
    void reply.code(400).send(refusal);
    return null;
  }
  return { name, steps, count: body.count, window: body.window };
}

/**
 * GET    /api/projects/:id/funnels
 * POST   /api/projects/:id/funnels              { "name": "Pricing to signup", "steps": […], "count": "visitors", "window": 3600 }
 * PUT    /api/projects/:id/funnels/:funnelId    (the same, and the "updatedAt" it was read with: replaces the name and the funnel)
 * DELETE /api/projects/:id/funnels/:funnelId
 *
 * A project's saved funnels (saved-funnels.ts). Like every project route,
 * each runs requireProjectAccess first; the changes also need the
 * dashboard's origin.
 */
export const savedFunnelRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  trustedOrigins: readonly string[];
}> = (app, { db, auth, trustedOrigins }, done) => {
  const signedIn = requireSession(auth);
  const projectAccess = requireProjectAccess(db);
  const fromDashboard = requireTrustedOrigin(trustedOrigins);
  const params = {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", pattern: UUID_PATTERN } },
  };
  const funnelParams = {
    type: "object",
    required: ["id", "funnelId"],
    properties: {
      id: { type: "string", pattern: UUID_PATTERN },
      funnelId: { type: "string", pattern: UUID_PATTERN },
    },
  };

  app.get<{ Params: { id: string } }>(
    "/projects/:id/funnels",
    { preHandler: [signedIn, projectAccess], schema: { params } },
    async (request) => ({ funnels: await listSavedFunnels(db, accessOf(request).projectId) }),
  );

  app.post<{ Params: { id: string }; Body: FunnelBody }>(
    "/projects/:id/funnels",
    {
      preHandler: [fromDashboard, signedIn, projectAccess],
      schema: { params, body: FUNNEL_BODY },
    },
    async (request, reply) => {
      const definition = definitionOf(request.body, reply);
      if (definition === null) return reply;
      const created = await createSavedFunnel(db, accessOf(request).projectId, definition);
      if ("refused" in created) {
        return reply
          .code(409)
          .send(
            created.refused === "too_many"
              ? problem(
                  "too_many_funnels",
                  `A project has at most ${MAX_SAVED_FUNNELS} saved funnels.`,
                )
              : NAME_TAKEN,
          );
      }
      return reply.code(201).send({ funnel: created.funnel });
    },
  );

  app.put<{
    Params: { id: string; funnelId: string };
    Body: FunnelBody & { updatedAt: string };
  }>(
    "/projects/:id/funnels/:funnelId",
    {
      preHandler: [fromDashboard, signedIn, projectAccess],
      schema: {
        params: funnelParams,
        body: {
          ...FUNNEL_BODY,
          required: [...FUNNEL_BODY.required, "updatedAt"],
          properties: { ...FUNNEL_BODY.properties, updatedAt: { type: "string", maxLength: 40 } },
        },
      },
    },
    async (request, reply) => {
      const read = new Date(request.body.updatedAt);
      if (Number.isNaN(read.getTime())) {
        return reply
          .code(400)
          .send(
            problem(
              "invalid_updated_at",
              "updatedAt is the saved funnel's updatedAt as read, such as 2026-11-17T12:00:00.000Z.",
            ),
          );
      }
      const definition = definitionOf(request.body, reply);
      if (definition === null) return reply;
      const updated = await updateSavedFunnel(
        db,
        accessOf(request).projectId,
        request.params.funnelId,
        read,
        definition,
      );
      if (updated === null) return reply.code(404).send(NOT_FOUND);
      if ("refused" in updated) {
        return reply
          .code(409)
          .send(
            updated.refused === "name_taken"
              ? NAME_TAKEN
              : problem(
                  "funnel_changed",
                  "The saved funnel was changed after it was read, such as in another tab. Read it again before changing it.",
                ),
          );
      }
      return { funnel: updated.funnel };
    },
  );

  app.delete<{ Params: { id: string; funnelId: string } }>(
    "/projects/:id/funnels/:funnelId",
    { preHandler: [fromDashboard, signedIn, projectAccess], schema: { params: funnelParams } },
    async (request, reply) => {
      const deleted = await deleteSavedFunnel(
        db,
        accessOf(request).projectId,
        request.params.funnelId,
      );
      return deleted ? reply.code(204).send() : reply.code(404).send(NOT_FOUND);
    },
  );

  done();
};
