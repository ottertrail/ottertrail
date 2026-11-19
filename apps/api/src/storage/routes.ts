import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import { requirePermission } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import type { Database } from "../db/schema.ts";
import { measureStorage, quotaPlanOf, type StorageReading, type StorageSources } from "./usage.ts";
import {
  type ActiveWarning,
  MAX_WARNING_CHANNELS,
  readActiveWarnings,
  readWarningChannels,
  setWarningChannels,
} from "./warning-state.ts";
import { evaluateWarnings, WARNING_TITLES, type WarningId, type WarningLevel } from "./warnings.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** Garage's figures without the admin token: what to do to see them. */
export const NO_TOKEN_MESSAGE =
  "Garage's own figures (the bucket's real size and the disk it writes to) need its admin token. Set GARAGE_ADMIN_TOKEN in .env (generate it with `openssl rand -hex 32`), then run `docker compose up -d`.";

/** The channels setting: which get storage warnings, and the instance's channels to choose from. */
async function channelsView(db: Kysely<Database>) {
  const [chosen, channels] = await Promise.all([
    readWarningChannels(db),
    db
      .selectFrom("notification_channels")
      .select(["id", "name", "kind"])
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  ]);
  return { channelIds: chosen, channels };
}

function garageView(reading: StorageReading, quota: { bytes: number; aboveBudgets: boolean }) {
  const garage = reading.garage;
  if (garage === null) return null;
  if (garage.state === "no_token") return { state: "no_token" as const, message: NO_TOKEN_MESSAGE };
  if (garage.state === "failed") return { state: "failed" as const, error: garage.error };
  return {
    state: "ok" as const,
    bucket:
      garage.bucket === null
        ? null
        : {
            objects: garage.bucket.objects,
            bytes: garage.bucket.bytes,
            quotaBytes: garage.bucket.maxSize,
          },
    dataPartition: garage.dataPartition,
    /** The quota the worker keeps on the bucket. */
    plannedQuotaBytes: quota.bytes,
    /** It sits above the budgets plus 10%: the bucket holds more than they leave room for. */
    quotaAboveBudgets: quota.aboveBudgets,
  };
}

/**
 * GET   /api/settings/storage   what fills the disk, and the warnings (the owner and admins)
 * PATCH /api/settings/storage   which channels get storage warnings (the owner and admins)
 *
 * The Storage section of the instance's Settings (docs/deployment.md,
 * "Storage"). GET measures every store on each request (usage.ts): a few
 * small queries, each bounded. Its warnings count the ones the worker has
 * on as on, so the page and the notifications agree near a threshold.
 * Garage's admin token is never in an answer.
 */
export const storageRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  trustedOrigins: readonly string[];
  sources: StorageSources;
}> = (app, { db, auth, trustedOrigins, sources }, done) => {
  const signedIn = requireSession(auth);
  const fromDashboard = requireTrustedOrigin(trustedOrigins);
  // As the instance's replay and source map totals are (docs/access.md).
  const canView = requirePermission(db, "projects");
  // Choosing where notifications go is managing channels.
  const canChoose = requirePermission(db, "channels");

  app.get("/settings/storage", { preHandler: [signedIn, canView] }, async (request) => {
    const [reading, active, channels] = await Promise.all([
      measureStorage(sources, { log: (msg, fields) => request.log.warn(fields, msg) }),
      readActiveWarnings(db).catch(() => new Map<WarningId, ActiveWarning>()),
      channelsView(db),
    ]);
    const levels = new Map<WarningId, WarningLevel>(
      [...active].map(([id, warning]) => [id, warning.level]),
    );
    const { warnings, undetermined } = evaluateWarnings(reading, levels);
    // On when last measured, and not measured now: still on, as the worker keeps them.
    const held = undetermined.flatMap((id) => {
      const on = active.get(id);
      return on === undefined
        ? []
        : [{ id, level: on.level, title: WARNING_TITLES[id], since: on.startedAt.toISOString() }];
    });
    return {
      measuredAt: reading.measuredAt.toISOString(),
      objectStore: reading.objectStore,
      disk: reading.disk,
      budgets: reading.budgets,
      clickhouse: reading.clickhouse,
      postgres: reading.postgres,
      garage: garageView(reading, quotaPlanOf(sources.budgets, reading)),
      warnings,
      held,
      /** The warnings that could not be worked out now: their figures were not measured. */
      undetermined,
      warningChannels: channels,
    };
  });

  app.patch<{ Body: { warningChannelIds: string[] } }>(
    "/settings/storage",
    {
      preHandler: [fromDashboard, signedIn, canChoose],
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["warningChannelIds"],
          properties: {
            warningChannelIds: {
              type: "array",
              maxItems: MAX_WARNING_CHANNELS,
              uniqueItems: true,
              items: { type: "string", pattern: UUID_PATTERN },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const refused = await setWarningChannels(db, request.body.warningChannelIds);
      if (refused !== null) {
        return reply.code(400).send({
          error: "channel_not_found",
          message:
            "A chosen channel is not one of the instance's channels. It may have been deleted: reload the page and choose again.",
        });
      }
      return { warningChannels: await channelsView(db) };
    },
  );

  done();
};
