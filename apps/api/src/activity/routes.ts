import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import { requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireSession } from "../auth/routes.ts";
import type { Database } from "../db/schema.ts";
import { activityWindows, readIngestActivity } from "./activity.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/**
 * The Activity tab uses whole-hour windows ending with the current hour
 * (activity.ts). Access matches other project settings: owner and admins.
 */
export const ingestActivityRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  now?: () => Date;
}> = (app, { db, auth, now = () => new Date() }, done) => {
  const signedIn = requireSession(auth);
  const manageProject = requireProjectAccess(db, { permission: "projects" });

  app.get<{ Params: { id: string } }>(
    "/projects/:id/ingest-activity",
    {
      preHandler: [signedIn, manageProject],
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", pattern: UUID_PATTERN } },
        },
      },
    },
    async (request) => {
      const at = now();
      const since = activityWindows(at);
      return {
        now: at.toISOString(),
        // Where "this hour", "24 h", and "7 days" start: whole hours.
        since: {
          hour: since.hour.toISOString(),
          day: since.day.toISOString(),
          week: since.week.toISOString(),
        },
        sources: await readIngestActivity(db, request.params.id, at),
      };
    },
  );

  done();
};
