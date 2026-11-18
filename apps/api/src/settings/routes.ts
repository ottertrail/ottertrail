import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession, signedInUser } from "../auth/routes.ts";
import type { Database } from "../db/schema.ts";
import { canonicalTimeZone } from "../visitors/visitor-ids.ts";
import {
  type InstanceSettings,
  MAX_INSTANCE_NAME_LENGTH,
  postgresKnowsTimeZone,
  readInstanceSettings,
  updateInstanceSettings,
} from "./settings.ts";

function problem(code: string, message: string) {
  return { error: code, message };
}

/** The settings as the dashboard gets them, with whether this user may change them. */
function view(settings: InstanceSettings, role: "owner" | "member") {
  return { settings: { ...settings, canEdit: role === "owner" } };
}

/**
 * The instance's settings (settings.ts). GET reads them; PATCH changes the
 * name or timezone, for the owner only. A changed timezone moves where days
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

  app.get("/settings", { preHandler: signedIn }, async (request) =>
    view(await readInstanceSettings(db), signedInUser(request).role),
  );

  app.patch<{ Body: { name?: string; timeZone?: string } }>(
    "/settings",
    {
      preHandler: [fromDashboard, signedIn],
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
      const user = signedInUser(request);
      if (user.role !== "owner") {
        return reply
          .code(403)
          .send(problem("forbidden", "Only the owner can change these settings."));
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
      // Visitor IDs read the timezone through the same cache, so a new one
      // starts at once in this process, and within seconds in the others.
      await updateInstanceSettings(db, {
        ...(name === undefined ? {} : { name }),
        ...(timeZone === undefined ? {} : { timeZone }),
      });
      return view(await readInstanceSettings(db), user.role);
    },
  );

  done();
};
