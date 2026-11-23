import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import { requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireSession } from "../auth/routes.ts";
import type { Database } from "../db/schema.ts";
import { readIngestActivity } from "./activity.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/**
 * GET /api/projects/:id/ingest-activity: what the project's ingestion
 * routes accepted, filtered, and refused in the last hour, 24 hours, and
 * 7 days, per source (activity.ts), for the Activity tab of its settings.
 * As the project's other settings: the owner and admins.
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
      return {
        now: at.toISOString(),
        sources: await readIngestActivity(db, request.params.id, at),
      };
    },
  );

  done();
};
