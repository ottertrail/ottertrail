import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import { type ProjectAccess, requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import type { Database } from "../db/schema.ts";
import { stepOf } from "../product/steps.ts";
import { createGoal, deleteGoal, listGoals, MAX_GOALS } from "./goals.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const GOAL_NAME = /^[^\u0000-\u001F\u007F]{1,100}$/u;

function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

const problem = (error: string, message: string) => ({ error, message });

/** Goal changes require the dashboard origin (goals.ts). */
export const goalRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  trustedOrigins: readonly string[];
}> = (app, { db, auth, trustedOrigins }, done) => {
  const signedIn = requireSession(auth);
  const canView = requireProjectAccess(db, { area: "product_analytics", level: "view" });
  const canManage = requireProjectAccess(db, { area: "product_analytics", level: "manage" });
  const fromDashboard = requireTrustedOrigin(trustedOrigins);
  const params = {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", pattern: UUID_PATTERN } },
  };

  app.get<{ Params: { id: string } }>(
    "/projects/:id/goals",
    { preHandler: [signedIn, canView], schema: { params } },
    async (request) => ({ goals: await listGoals(db, accessOf(request).projectId) }),
  );

  app.post<{ Params: { id: string }; Body: { name: string; step: unknown } }>(
    "/projects/:id/goals",
    {
      preHandler: [fromDashboard, signedIn, canManage],
      schema: {
        params,
        body: {
          type: "object",
          required: ["name", "step"],
          additionalProperties: false,
          properties: { name: { type: "string", maxLength: 200 }, step: { type: "object" } },
        },
      },
    },
    async (request, reply) => {
      const name = request.body.name.trim();
      if (!GOAL_NAME.test(name)) {
        return reply
          .code(400)
          .send(
            problem(
              "invalid_name",
              "A goal's name has 1 to 100 characters, and no control characters.",
            ),
          );
      }
      const step = stepOf(request.body.step);
      if (step === null) {
        return reply
          .code(400)
          .send(
            problem(
              "invalid_step",
              'A goal is {"type":"page","path":"/…"} or {"type":"event","name":"…"}, with an optional "filter":{"key":"…","value":"…"}, which may add "operator":"notEquals" or "contains". A path may hold * for any run of characters.',
            ),
          );
      }
      const created = await createGoal(db, accessOf(request).projectId, name, step);
      if ("refused" in created) {
        return reply
          .code(409)
          .send(
            created.refused === "too_many"
              ? problem("too_many_goals", `A project has at most ${MAX_GOALS} goals.`)
              : problem("goal_name_taken", "The project already has a goal with this name."),
          );
      }
      return reply.code(201).send({ goal: created.goal });
    },
  );

  app.delete<{ Params: { id: string; goalId: string } }>(
    "/projects/:id/goals/:goalId",
    {
      preHandler: [fromDashboard, signedIn, canManage],
      schema: {
        params: {
          type: "object",
          required: ["id", "goalId"],
          properties: {
            id: { type: "string", pattern: UUID_PATTERN },
            goalId: { type: "string", pattern: UUID_PATTERN },
          },
        },
      },
    },
    async (request, reply) => {
      const deleted = await deleteGoal(db, accessOf(request).projectId, request.params.goalId);
      return deleted
        ? reply.code(204).send()
        : reply.code(404).send(problem("goal_not_found", "The project has no goal with this ID."));
    },
  );

  done();
};
