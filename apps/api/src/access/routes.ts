import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import type { Auth } from "../auth/auth.ts";
import { requireSession, signedInUser } from "../auth/routes.ts";
import { avatarUrlOf } from "../avatars/avatars.ts";
import type { Database } from "../db/schema.ts";
import { readInstanceSettings } from "../settings/settings.ts";
import { can, requirePermission, userAccessOf } from "./access.ts";
import type { Permission } from "./areas.ts";

/**
 * Reread account and access on each request (docs/access.md). The dashboard
 * hides unavailable features; server routes still enforce access.
 */
export const meRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  avatarUploads?: boolean;
}> = (app, { db, auth, avatarUploads = false }, done) => {
  const signedIn = requireSession(auth);
  const anyUser = requirePermission(db, "signed_in");

  app.get("/me", { preHandler: [signedIn, anyUser] }, async (request) => {
    const { id, name, email } = signedInUser(request);
    const access = userAccessOf(request);
    const permissions: Record<Permission, boolean> = {
      settings: can(access, "settings"),
      ownership: can(access, "ownership"),
      members: can(access, "members"),
      channels: can(access, "channels"),
      projects: can(access, "projects"),
    };
    const [settings, own] = await Promise.all([
      readInstanceSettings(db),
      db.selectFrom("dashboard_users").select("avatar_key").where("id", "=", id).executeTakeFirst(),
    ]);
    return {
      user: { id, name, email, role: access.role, avatarUrl: avatarUrlOf(own?.avatar_key ?? null) },
      instance: {
        name: settings.name,
        timeZone: settings.timeZone,
        avatarUrl: avatarUrlOf(settings.avatarKey),
      },
      access: { projects: access.projects, areas: access.areas },
      permissions,
      avatarUploads,
    };
  });

  done();
};
