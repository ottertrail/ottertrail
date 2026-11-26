import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import { requirePermission } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import { avatarUrlOf } from "../avatars/avatars.ts";
import type { Database } from "../db/schema.ts";
import type { LoadedLocationData } from "../enrichment/reload.ts";
import { readUpdateStatus, type UpdateStatus } from "../enrichment/updates.ts";
import { anyProjectUsesLocationDatabase } from "../projects/projects.ts";
import { OTTERTRAIL_RELEASE_NOTES_URL, OTTERTRAIL_VERSION } from "../version.ts";
import { canonicalTimeZone } from "../visitors/visitor-ids.ts";
import {
  INVALID_TIME_ZONE,
  type InstanceSettings,
  MAX_INSTANCE_NAME_LENGTH,
  postgresKnowsTimeZone,
  readInstanceSettings,
  updateInstanceSettings,
} from "./settings.ts";

/**
 * Expose the icon as a URL. The version goes only to the owner: on a public
 * route it would tell an attacker which known flaws to try.
 */
function view({ avatarKey, ...settings }: InstanceSettings) {
  return {
    settings: {
      ...settings,
      avatarUrl: avatarUrlOf(avatarKey),
      version: OTTERTRAIL_VERSION,
      releaseNotesUrl: OTTERTRAIL_RELEASE_NOTES_URL,
    },
  };
}

function updateView(status: UpdateStatus | null) {
  if (status === null) return null;
  return {
    lastAttemptAt: status.lastAttemptAt.toISOString(),
    lastSuccessAt: status.lastSuccessAt?.toISOString() ?? null,
    version: status.version,
    builtAt: status.builtAt?.toISOString() ?? null,
    providers: status.providers,
    fileModifiedAt: status.file === null ? null : new Date(status.file.modifiedMs).toISOString(),
    lastError: status.lastError,
  };
}

const iso = (date: Date | null) => date?.toISOString() ?? null;

/**
 * Owner-only settings (docs/access.md). Changing the timezone shifts report
 * day boundaries, including past reports, and restarts visitor IDs for today.
 */
export const settingsRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  trustedOrigins: readonly string[];
  /** What the API has loaded; without it, neither file counts as loaded. */
  locationData?: { readonly loaded: LoadedLocationData };
}> = (app, { db, auth, trustedOrigins, locationData }, done) => {
  const signedIn = requireSession(auth);
  const fromDashboard = requireTrustedOrigin(trustedOrigins);
  const owner = requirePermission(db, "settings");

  app.get("/settings", { preHandler: [signedIn, owner] }, async () =>
    view(await readInstanceSettings(db)),
  );

  app.get("/settings/location-data", { preHandler: [signedIn, owner] }, async () => {
    const loaded = locationData?.loaded;
    const locations = loaded?.locations ?? null;
    const dataCenters = loaded?.dataCenters ?? null;
    const [status, databaseUsed] = await Promise.all([
      readUpdateStatus(db),
      anyProjectUsesLocationDatabase(db),
    ]);
    return {
      // Use server time for relative dates to avoid browser clock skew.
      now: new Date().toISOString(),
      // Whether any project looks up locations in the database; if none, the file is not loaded.
      locationDatabaseUsed: databaseUsed,
      locations: {
        loaded:
          locations === null
            ? null
            : {
                type: locations.type,
                builtAt: locations.builtAt.toISOString(),
                fileModifiedAt: iso(locations.fileModifiedAt),
              },
        loadError: loaded?.locationsError ?? null,
        lastUpdate: updateView(status.locations),
      },
      dataCenters: {
        loaded:
          dataCenters === null
            ? null
            : {
                providers: dataCenters.providers,
                updatedAt: dataCenters.updatedAt.toISOString(),
                fileModifiedAt: iso(dataCenters.fileModifiedAt),
              },
        loadError: loaded?.dataCentersError ?? null,
        lastUpdate: updateView(status.data_centers),
      },
    };
  });

  app.patch<{ Body: { name?: string; timeZone?: string; updateLocationData?: boolean } }>(
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
            // Fastify's boolean coercion would accept null, 0, "", and "false" as false.
            updateLocationData: { enum: [true, false] },
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
      // Invalidate the timezone cache for visitor IDs immediately here; other processes refresh within seconds.
      await updateInstanceSettings(db, {
        ...(name === undefined ? {} : { name }),
        ...(timeZone === undefined ? {} : { timeZone }),
        ...(request.body.updateLocationData === undefined
          ? {}
          : { updateLocationData: request.body.updateLocationData }),
      });
      return view(await readInstanceSettings(db));
    },
  );

  done();
};
