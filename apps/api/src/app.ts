import Fastify, { type FastifyServerOptions } from "fastify";
import type { Kysely } from "kysely";

import type { Auth } from "./auth/auth.ts";
import { betterAuthRoutes, setupRoutes } from "./auth/routes.ts";
import { ProjectKeyCache } from "./collection/project-keys.ts";
import type { RateLimit } from "./collection/rate-limiter.ts";
import { type CollectionOptions, collectionRoutes } from "./collection/routes.ts";
import type { Database } from "./db/schema.ts";
import { projectRoutes } from "./projects/routes.ts";
import { reportRoutes } from "./reports/routes.ts";
import { healthRoutes } from "./routes/health.ts";
import { trackerScriptRoutes } from "./tracker-script/routes.ts";

export interface AppOptions extends Omit<FastifyServerOptions, "logger"> {
  db: Kysely<Database>;
  /** Rate limits, location lookup, and clock for the collection endpoint. */
  collection?: Omit<CollectionOptions, "db">;
  /** Logging; off when omitted. Tests pass a stream to read the log. */
  log?: { level: string; stream?: { write(line: string): void } };
  /**
   * Dashboard sign-in (src/auth/auth.ts) and the instance's public URL.
   * Without it the API serves only health and event collection, which is
   * all some tests need.
   */
  dashboard?: {
    auth: Auth;
    publicUrl: string;
    /** Origins dashboard requests may come from (Config.trustedOrigins). */
    trustedOrigins: readonly string[];
    /** The instance's timezone: reports count days in it. */
    timeZone: string;
    /** The clock that decides "today" for report periods; tests fix it. */
    now?: () => Date;
    setupLimit?: RateLimit;
  };
  /** The built tracker, served at /t.js. Not served when omitted. */
  trackerScriptPath?: string;
}

/**
 * What a request log line records about a request: method and URL only.
 * Fastify's default also records the client's IP address and port, and an
 * IP address is personal data that Ottertrail never keeps.
 */
export function requestLogFields(request: { method: string; url: string }) {
  return { method: request.method, url: request.url };
}

export function buildApp({
  db,
  collection = {},
  log,
  dashboard,
  trackerScriptPath,
  ...fastifyOptions
}: AppOptions) {
  const app = Fastify({
    ...fastifyOptions,
    logger:
      log === undefined
        ? false
        : {
            level: log.level,
            ...(log.stream === undefined ? {} : { stream: log.stream }),
            serializers: { req: requestLogFields },
          },
  });
  app.register(healthRoutes, { prefix: "/api" });
  // One key cache for collection and the project routes, which make it
  // forget a replaced or deleted project's key at once.
  const projectKeys = new ProjectKeyCache(
    db,
    collection.now === undefined ? {} : { now: collection.now },
  );
  app.register(collectionRoutes, { prefix: "/api", db, projectKeys, ...collection });
  if (trackerScriptPath !== undefined) {
    app.register(trackerScriptRoutes, { scriptPath: trackerScriptPath });
  }
  if (dashboard !== undefined) {
    app.decorateRequest("dashboardUser", null);
    app.register(betterAuthRoutes, {
      prefix: "/api",
      auth: dashboard.auth,
      publicUrl: dashboard.publicUrl,
    });
    app.register(setupRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      ...(dashboard.setupLimit === undefined ? {} : { setupLimit: dashboard.setupLimit }),
    });
    app.register(projectRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      projectKeys,
    });
    app.register(reportRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      timeZone: dashboard.timeZone,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
  }
  return app;
}
