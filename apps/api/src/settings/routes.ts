import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import { requirePermission } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import type { Database } from "../db/schema.ts";
import type { LoadedLocationData } from "../enrichment/reload.ts";
import { readUpdateStatus, type UpdateStatus } from "../enrichment/updates.ts";
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

/** A file's last recorded update, as the dashboard gets it. */
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
 * The instance's settings (settings.ts), for the owner only (docs/access.md):
 * GET reads them; PATCH changes the name, the timezone, or whether the
 * worker updates the location data on its own; GET /settings/location-data
 * says what the API has loaded and what the last updates did. A changed timezone moves where days
 * start in every report, past ones included, and starts new visitor IDs
 * for the rest of the day, so the dashboard says so before saving.
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
    const status = await readUpdateStatus(db);
    return {
      // The server's clock: the page measures "15 minutes ago" from it, not the browser's.
      now: new Date().toISOString(),
      geoSource: loaded?.geoSource ?? "database",
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
            // Not `type: "boolean"`: Fastify would turn null, 0, "" and "false" into false.
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
      // Visitor IDs read the timezone through the same cache, so a new one
      // starts at once in this process, and within seconds in the others.
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
