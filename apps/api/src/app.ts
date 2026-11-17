import Fastify, { type FastifyServerOptions } from "fastify";
import type { Kysely } from "kysely";

import type { Auth } from "./auth/auth.ts";
import { betterAuthRoutes, setupRoutes } from "./auth/routes.ts";
import type { ClickHouseClient } from "./clickhouse/clickhouse.ts";
import { ProjectKeyCache } from "./collection/project-keys.ts";
import type { RateLimit } from "./collection/rate-limiter.ts";
import { type CollectionOptions, collectionRoutes } from "./collection/routes.ts";
import { dashboardAppRoutes, sendsHsts } from "./dashboard-app/routes.ts";
import type { Database } from "./db/schema.ts";
import { errorRoutes } from "./errors/routes.ts";
import { userRoutes } from "./identities/routes.ts";
import { organizationRoutes } from "./organizations/routes.ts";
import { projectRoutes } from "./projects/routes.ts";
import { reportRoutes } from "./reports/routes.ts";
import { healthRoutes } from "./routes/health.ts";
import { speedRoutes } from "./speed/routes.ts";
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
    /** The events reports read (docs/clickhouse.md). */
    clickhouse: ClickHouseClient;
    publicUrl: string;
    /** Origins dashboard requests may come from (Config.trustedOrigins). */
    trustedOrigins: readonly string[];
    /**
     * The timezone of the organization the setup link creates. Each
     * organization keeps its own after that; reports count days in it.
     */
    defaultTimeZone: string;
    /** The clock that decides "today" for report periods; tests fix it. */
    now?: () => Date;
    setupLimit?: RateLimit;
  };
  /** The built tracker, served at /t.js. Not served when omitted. */
  trackerScriptPath?: string;
  /** The built dashboard's directory, served at /. Not served when omitted. */
  dashboardPath?: string;
}

/**
 * What a request log line records about a request: method and URL only.
 * Fastify's default also records the client's IP address and port, and an
 * IP address is personal data that Ottertrail never keeps. A site's user ID
 * is personal data too, so a user's path and a user search are masked:
 * logs are kept apart from the project's retention and deletion.
 */
export function requestLogFields(request: { method: string; url: string }) {
  const url = request.url
    .replace(/(\/users\/)[^/?#]+/, "$1…")
    .replace(/([?&]search=)[^&#]*/, "$1…");
  return { method: request.method, url };
}

export function buildApp({
  db,
  collection = {},
  log,
  dashboard,
  trackerScriptPath,
  dashboardPath,
  ...fastifyOptions
}: AppOptions) {
  const app = Fastify({
    // A user ID in a path may be 200 characters, 400 UTF-16 units; Fastify allows 100.
    maxParamLength: 512,
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
  if (dashboardPath !== undefined) {
    app.register(dashboardAppRoutes, {
      root: dashboardPath,
      hsts: dashboard === undefined ? false : sendsHsts(dashboard.publicUrl),
    });
  }
  if (dashboard !== undefined) {
    app.decorateRequest("dashboardUser", null);
    app.decorateRequest("projectAccess", null);
    app.register(betterAuthRoutes, {
      prefix: "/api",
      auth: dashboard.auth,
      publicUrl: dashboard.publicUrl,
    });
    app.register(setupRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      defaultTimeZone: dashboard.defaultTimeZone,
      ...(dashboard.setupLimit === undefined ? {} : { setupLimit: dashboard.setupLimit }),
    });
    app.register(organizationRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      projectKeys,
    });
    app.register(projectRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      projectKeys,
    });
    app.register(userRoutes, {
      prefix: "/api",
      db,
      clickhouse: dashboard.clickhouse,
      auth: dashboard.auth,
    });
    app.register(speedRoutes, {
      prefix: "/api",
      db,
      clickhouse: dashboard.clickhouse,
      auth: dashboard.auth,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(errorRoutes, {
      prefix: "/api",
      db,
      clickhouse: dashboard.clickhouse,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(reportRoutes, {
      prefix: "/api",
      db,
      clickhouse: dashboard.clickhouse,
      auth: dashboard.auth,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
  }
  return app;
}
