import type { FastifyPluginCallback, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { type DashboardUser, requireSession } from "../auth/routes.ts";
import type { Database } from "../db/schema.ts";
import { canonicalTimeZone } from "../visitors/visitor-ids.ts";
import {
  findOrganization,
  listOrganizations,
  MAX_ORGANIZATION_NAME_LENGTH,
  organizationProjectKeys,
  postgresKnowsTimeZone,
  updateOrganization,
} from "./organizations.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

function problem(code: string, message: string) {
  return { error: code, message };
}

/** The user requireSession set. Routes here always run it first. */
export function signedInUser(request: FastifyRequest): DashboardUser {
  if (request.dashboardUser === null) {
    throw new Error("requireSession must run before this route");
  }
  return request.dashboardUser;
}

/**
 * The signed-in user's organizations. GET lists them; PATCH changes one's
 * name or timezone, for its owner only. A changed timezone moves where days
 * start in every report, past ones included, and starts new visitor IDs for
 * the rest of the day, so the dashboard says so before saving.
 */
export const organizationRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  trustedOrigins: readonly string[];
  /** The collection endpoint's key cache, which must pick up a new timezone at once. */
  projectKeys?: { forget(publicKey: string): void };
}> = (app, { db, auth, trustedOrigins, projectKeys }, done) => {
  const signedIn = requireSession(auth);
  const fromDashboard = requireTrustedOrigin(trustedOrigins);

  app.get("/organizations", { preHandler: signedIn }, async (request) => ({
    organizations: await listOrganizations(db, signedInUser(request).id),
  }));

  app.patch<{ Params: { id: string }; Body: { name?: string; timeZone?: string } }>(
    "/organizations/:id",
    {
      preHandler: [fromDashboard, signedIn],
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", pattern: UUID_PATTERN } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: {
              type: "string",
              minLength: 1,
              maxLength: MAX_ORGANIZATION_NAME_LENGTH,
              pattern: "\\S",
            },
            timeZone: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const user = signedInUser(request);
      const organization = await findOrganization(db, user.id, request.params.id);
      if (organization === null) {
        return reply.code(404).send(problem("not_found", "No organization has this ID."));
      }
      if (organization.role !== "owner") {
        return reply
          .code(403)
          .send(problem("forbidden", "Only the organization's owner can change its settings."));
      }
      let timeZone: string | undefined;
      if (request.body.timeZone !== undefined) {
        timeZone = canonicalTimeZone(request.body.timeZone);
        if (timeZone === undefined || !(await postgresKnowsTimeZone(db, timeZone))) {
          return reply
            .code(400)
            .send(
              problem(
                "invalid_time_zone",
                'Use an IANA timezone name such as "Europe/Berlin"; fixed offsets such as "+08:00" are not accepted.',
              ),
            );
        }
      }
      const name = request.body.name?.trim();
      await updateOrganization(db, organization.id, {
        ...(name === undefined ? {} : { name }),
        ...(timeZone === undefined ? {} : { timeZone }),
      });
      if (timeZone !== undefined && timeZone !== organization.timeZone) {
        // Visitor IDs use the timezone of the event's project: start the new one now.
        for (const key of await organizationProjectKeys(db, organization.id)) {
          projectKeys?.forget(key);
        }
      }
      return { organization: await findOrganization(db, user.id, organization.id) };
    },
  );

  done();
};
