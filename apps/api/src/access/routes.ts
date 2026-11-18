import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import type { Auth } from "../auth/auth.ts";
import { requireSession, signedInUser } from "../auth/routes.ts";
import type { Database } from "../db/schema.ts";
import { readInstanceSettings } from "../settings/settings.ts";
import { can, requirePermission, userAccessOf } from "./access.ts";
import type { Permission } from "./areas.ts";

/**
 * GET /api/me: who is signed in, the instance's name and timezone, and what they may
 * reach (docs/access.md), read afresh on each request. The dashboard hides
 * what the user cannot use; the routes refuse it regardless.
 */
export const meRoutes: FastifyPluginCallback<{ db: Kysely<Database>; auth: Auth }> = (
  app,
  { db, auth },
  done,
) => {
  const signedIn = requireSession(auth);
  const anyUser = requirePermission(db, "signed_in");

  app.get("/me", { preHandler: [signedIn, anyUser] }, async (request) => {
    const { id, name, email } = signedInUser(request);
    const access = userAccessOf(request);
    const permissions: Record<Permission, boolean> = {
      settings: can(access, "settings"),
      members: can(access, "members"),
      channels: can(access, "channels"),
      projects: can(access, "projects"),
    };
    const { name: instanceName, timeZone } = await readInstanceSettings(db);
    return {
      user: { id, name, email, role: access.role },
      instance: { name: instanceName, timeZone },
      access: { projects: access.projects, areas: access.areas },
      permissions,
    };
  });

  done();
};
