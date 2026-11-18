import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import { requirePermission } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import type { Database } from "../db/schema.ts";
import { canonicalTimeZone } from "../visitors/visitor-ids.ts";
import {
  INVALID_TIME_ZONE,
  type InstanceSettings,
  MAX_INSTANCE_NAME_LENGTH,
  postgresKnowsTimeZone,
  readInstanceSettings,
  updateInstanceSettings,
} from "./settings.ts";

/** The settings as the dashboard gets them. */
function view(settings: InstanceSettings) {
  return { settings };
}

/**
 * The instance's settings (settings.ts), for the owner only (docs/access.md):
 * GET reads them; PATCH changes the name or timezone. A changed timezone moves where days
 * start in every report, past ones included, and starts new visitor IDs
 * for the rest of the day, so the dashboard says so before saving.
 */
export const settingsRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  trustedOrigins: readonly string[];
}> = (app, { db, auth, trustedOrigins }, done) => {
  const signedIn = requireSession(auth);
  const fromDashboard = requireTrustedOrigin(trustedOrigins);
  const owner = requirePermission(db, "settings");

  app.get("/settings", { preHandler: [signedIn, owner] }, async () =>
    view(await readInstanceSettings(db)),
  );

  app.patch<{ Body: { name?: string; timeZone?: string } }>(
    "/settings",
    {
      preHandler: [fromDashboard, signedIn, owner],
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: {
              type: "string",
              minLength: 1,
              maxLength: MAX_INSTANCE_NAME_LENGTH,
              pattern: "\\S",
            },
            timeZone: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      let timeZone: string | undefined;
      if (request.body.timeZone !== undefined) {
        timeZone = canonicalTimeZone(request.body.timeZone);
        if (timeZone === undefined || !(await postgresKnowsTimeZone(db, timeZone))) {
          return reply.code(400).send(INVALID_TIME_ZONE);
        }
      }
      const name = request.body.name?.trim();
      // Visitor IDs read the timezone through the same cache, so a new one
      // starts at once in this process, and within seconds in the others.
      await updateInstanceSettings(db, {
        ...(name === undefined ? {} : { name }),
        ...(timeZone === undefined ? {} : { timeZone }),
      });
      return view(await readInstanceSettings(db));
    },
  );

  done();
};
