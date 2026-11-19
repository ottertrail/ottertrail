import Fastify, { type FastifyServerOptions } from "fastify";
import type { Kysely } from "kysely";

import { memberRoutes } from "./access/member-routes.ts";
import { meRoutes } from "./access/routes.ts";
import { alertRoutes } from "./alerts/routes.ts";
import type { Auth } from "./auth/auth.ts";
import { betterAuthRoutes, setupRoutes } from "./auth/routes.ts";
import type { ClickHouseClient } from "./clickhouse/clickhouse.ts";
import { ProjectKeyCache } from "./collection/project-keys.ts";
import type { RateLimit } from "./collection/rate-limiter.ts";
import { type CollectionOptions, collectionRoutes } from "./collection/routes.ts";
import {
  DEFAULT_REPLAY_STORAGE_BYTES,
  DEFAULT_SOURCE_MAP_STORAGE_BYTES,
  DEFAULT_TELEMETRY_RETENTION_DAYS,
} from "./config.ts";
import { dashboardAppRoutes, sendsHsts } from "./dashboard-app/routes.ts";
import type { Database } from "./db/schema.ts";
import type { LoadedLocationData } from "./enrichment/reload.ts";
import { errorRoutes } from "./errors/routes.ts";
import { savedFunnelRoutes } from "./funnels/routes.ts";
import { goalRoutes } from "./goals/routes.ts";
import { heatmapRoutes } from "./heatmaps/dashboard-routes.ts";
import { heatmapOverlayRoutes } from "./heatmaps/overlay-routes.ts";
import { heatmapCollectionRoutes } from "./heatmaps/routes.ts";
import { userRoutes } from "./identities/routes.ts";
import { channelRoutes } from "./notifications/routes.ts";
import { addressPolicy, type Lookup } from "./outbound/addresses.ts";
import { overviewRoutes } from "./overview/routes.ts";
import { productRoutes } from "./product/routes.ts";
import { projectRoutes } from "./projects/routes.ts";
import { replayPlayerScriptRoute, replayRoutes } from "./replays/dashboard-routes.ts";
import { replayCollectionRoutes } from "./replays/routes.ts";
import { reportRoutes } from "./reports/routes.ts";
import { healthRoutes } from "./routes/health.ts";
import { settingsRoutes } from "./settings/routes.ts";
import { SourceMapCache } from "./source-maps/resolve.ts";
import { sourceMapRoutes, sourceMapUploadRoutes } from "./source-maps/routes.ts";
import { spamRoutes } from "./spam/routes.ts";
import { speedRoutes } from "./speed/routes.ts";
import type { ObjectStore } from "./storage/object-store.ts";
import { storageRoutes } from "./storage/routes.ts";
import type { StorageSources } from "./storage/usage.ts";
import { DashboardQueryLimiter } from "./telemetry/dashboard-limit.ts";
import { telemetryDashboardRoutes } from "./telemetry/dashboard-routes.ts";
import { type TelemetryOptions, telemetryRoutes } from "./telemetry/routes.ts";
import { trackerScriptRoutes } from "./tracker-script/routes.ts";
import { uptimeRoutes } from "./uptime/routes.ts";

export interface AppOptions extends Omit<FastifyServerOptions, "logger"> {
  db: Kysely<Database>;
  /**
   * Rate limits, location lookup, and clock for the collection endpoints,
   * and the ClickHouse they store events in: the dashboard's unless
   * `clickhouse` names another. Not served without a ClickHouse client.
   */
  collection?: Omit<CollectionOptions, "db" | "clickhouse"> & { clickhouse?: ClickHouseClient };
  /** Logging; off when omitted. Tests pass a stream to read the log. */
  log?: { level: string; stream?: { write(line: string): void } };
  /**
   * Dashboard sign-in (src/auth/auth.ts) and the instance's public URL.
   * Without it the API serves only health, and event collection when
   * `collection.clickhouse` is given, which is all some tests need.
   */
  dashboard?: {
    auth: Auth;
    /** Where events are stored and reports read them (docs/clickhouse.md). */
    clickhouse: ClickHouseClient;
    publicUrl: string;
    /** Origins dashboard requests may come from (Config.trustedOrigins). */
    trustedOrigins: readonly string[];
    /** The clock that decides "today" for report periods; tests fix it. */
    now?: () => Date;
    setupLimit?: RateLimit;
    /** Accepting invitations and using reset links, per client address (access/member-routes.ts). */
    linkLimit?: RateLimit;
  };
  /**
   * The S3-compatible object store that holds source maps and session
   * replays; null, or omitted, when the install has none, and both are off.
   */
  objectStore?: ObjectStore | null;
  /**
   * The location database and data-center ranges the API has loaded, for
   * the Settings page's status (enrichment/reload.ts). Omitted, the page
   * reports neither file loaded.
   */
  locationData?: { readonly loaded: LoadedLocationData };
  /** Source maps (docs/errors.md, "Source maps"): the instance's storage limit, and upload limits. */
  sourceMaps?: {
    limitBytes: number;
    ipLimit?: RateLimit;
    /** Uploads one process stores at once (source-maps/routes.ts). */
    maxInFlight?: number;
  };
  /**
   * Session replays (docs/session-replay.md): the instance's limit on what
   * replays keep, and the collection limits, which tests lower.
   */
  replays?: {
    limitBytes: number;
    ipLimit?: RateLimit;
    projectLimit?: RateLimit;
    instanceLimit?: RateLimit;
  };
  /**
   * Heatmaps' collection limits (heatmaps/routes.ts), which tests lower.
   * Collected with the events' ClickHouse client. And the overlay's limits
   * per client address (heatmaps/overlay-routes.ts).
   */
  heatmaps?: {
    ipLimit?: RateLimit;
    ipRecordLimit?: RateLimit;
    projectLimit?: RateLimit;
    instanceLimit?: RateLimit;
    overlayExchangeLimit?: RateLimit;
    overlayReadLimit?: RateLimit;
  };
  /**
   * OTLP traces, logs, and metrics (docs/telemetry.md), stored in
   * ClickHouse: the dashboard's client unless `clickhouse` names another.
   * Not served without a ClickHouse client.
   */
  telemetry?: Partial<Omit<TelemetryOptions, "projects" | "now">>;
  /**
   * Uptime checks (docs/uptime-alerts.md): whether they may reach private
   * addresses (UPTIME_ALLOW_PRIVATE_ADDRESSES, off by default), the
   * addresses they may never reach (UPTIME_DENY_ADDRESSES), and the
   * resolver that checks a URL's host when a check is saved (tests fake it).
   */
  uptime?: { allowPrivateAddresses?: boolean; denyAddresses?: string[]; lookup?: Lookup };
  /**
   * Notification channels (docs/uptime-alerts.md, "Where alerts go"):
   * whether SMTP_URL is set, which the dashboard shows beside email
   * channels. Webhook URLs follow `uptime`'s address rules and resolver.
   */
  notifications?: { emailConfigured?: boolean };
  /**
   * The Storage section's sources (storage/usage.ts) beyond the app's own:
   * whether the object store is the stack's Garage and its bucket, Garage's
   * admin API, and, in tests, the disk's figures. Omitted, an object store
   * counts as another S3-compatible store, without Garage's figures.
   */
  storage?: Partial<
    Pick<StorageSources, "objectStore" | "garage" | "readDisk" | "telemetryRetentionDays">
  >;
  /** The built tracker, served at /t.js. Not served when omitted. */
  trackerScriptPath?: string;
  /** The built dashboard's directory, served at /. Not served when omitted. */
  dashboardPath?: string;
  /** The built session replay player, served at /replay-player.js. Not served when omitted. */
  replayPlayerPath?: string;
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

/** Heatmaps' collection limits, without the overlay's. */
function collectionLimitsOf({
  overlayExchangeLimit: _exchange,
  overlayReadLimit: _read,
  ...limits
}: NonNullable<AppOptions["heatmaps"]>) {
  return limits;
}

export function buildApp({
  db,
  collection = {},
  log,
  dashboard,
  objectStore = null,
  locationData,
  sourceMaps = { limitBytes: DEFAULT_SOURCE_MAP_STORAGE_BYTES },
  replays = { limitBytes: DEFAULT_REPLAY_STORAGE_BYTES },
  heatmaps = {},
  telemetry = {},
  uptime = {},
  notifications = {},
  storage = {},
  trackerScriptPath,
  dashboardPath,
  replayPlayerPath,
  ...fastifyOptions
}: AppOptions) {
  const app = Fastify({
    // A user ID in a path may be 200 characters, 400 UTF-16 units; Fastify allows 100.
    routerOptions: { maxParamLength: 512 },
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
  const collectionClickHouse = collection.clickhouse ?? dashboard?.clickhouse;
  if (collectionClickHouse !== undefined) {
    app.register(collectionRoutes, {
      prefix: "/api",
      db,
      projectKeys,
      ...collection,
      clickhouse: collectionClickHouse,
    });
    app.register(heatmapCollectionRoutes, {
      prefix: "/api",
      clickhouse: collectionClickHouse,
      projects: projectKeys,
      ...collectionLimitsOf(heatmaps),
      ...(collection.isDataCenter === undefined ? {} : { isDataCenter: collection.isDataCenter }),
      ...(collection.now === undefined ? {} : { now: collection.now }),
    });
  }
  app.register(replayCollectionRoutes, {
    prefix: "/api",
    db,
    projects: projectKeys,
    storeConfigured: objectStore !== null,
    ...replays,
    ...(collection.isDataCenter === undefined ? {} : { isDataCenter: collection.isDataCenter }),
    ...(collection.now === undefined ? {} : { now: collection.now }),
  });
  app.register(sourceMapUploadRoutes, {
    prefix: "/api",
    db,
    store: objectStore,
    projects: projectKeys,
    limitBytes: sourceMaps.limitBytes,
    ...(sourceMaps.ipLimit === undefined ? {} : { ipLimit: sourceMaps.ipLimit }),
    ...(sourceMaps.maxInFlight === undefined ? {} : { maxInFlight: sourceMaps.maxInFlight }),
  });
  const telemetryClickHouse = telemetry.clickhouse ?? dashboard?.clickhouse;
  if (telemetryClickHouse !== undefined) {
    // At the root, not under /api: an exporter appends /v1/traces to the
    // address it is given (OTEL_EXPORTER_OTLP_ENDPOINT).
    app.register(telemetryRoutes, {
      ...telemetry,
      clickhouse: telemetryClickHouse,
      projects: projectKeys,
      retentionDays: telemetry.retentionDays ?? DEFAULT_TELEMETRY_RETENTION_DAYS,
      ...(collection.now === undefined ? {} : { now: collection.now }),
    });
  }
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
    app.decorateRequest("userAccess", null);
    app.register(betterAuthRoutes, {
      prefix: "/api",
      auth: dashboard.auth,
      publicUrl: dashboard.publicUrl,
    });
    app.register(setupRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      emailConfigured: notifications.emailConfigured ?? false,
      ...(dashboard.setupLimit === undefined ? {} : { setupLimit: dashboard.setupLimit }),
    });
    app.register(meRoutes, { prefix: "/api", db, auth: dashboard.auth });
    app.register(memberRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      publicUrl: dashboard.publicUrl,
      ...(dashboard.linkLimit === undefined ? {} : { linkLimit: dashboard.linkLimit }),
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(settingsRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      ...(locationData === undefined ? {} : { locationData }),
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
    app.register(goalRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
    });
    app.register(savedFunnelRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
    });
    app.register(productRoutes, {
      prefix: "/api",
      db,
      clickhouse: dashboard.clickhouse,
      auth: dashboard.auth,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
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
      sourceMaps: { store: objectStore, cache: new SourceMapCache() },
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    // One limit on the dashboard's ClickHouse queries, shared by every page that reads them.
    const limiter = new DashboardQueryLimiter();
    app.register(telemetryDashboardRoutes, {
      prefix: "/api",
      db,
      clickhouse: telemetry.clickhouse ?? dashboard.clickhouse,
      auth: dashboard.auth,
      retentionDays: telemetry.retentionDays ?? DEFAULT_TELEMETRY_RETENTION_DAYS,
      limiter,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    // Uptime checks and webhooks follow the same address rules.
    const policy = addressPolicy({
      allowPrivate: uptime.allowPrivateAddresses ?? false,
      deny: uptime.denyAddresses ?? [],
    });
    app.register(uptimeRoutes, {
      prefix: "/api",
      db,
      clickhouse: dashboard.clickhouse,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      policy,
      limiter,
      ...(uptime.lookup === undefined ? {} : { lookup: uptime.lookup }),
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(alertRoutes, {
      prefix: "/api",
      db,
      clickhouse: telemetry.clickhouse ?? dashboard.clickhouse,
      limiter,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(heatmapRoutes, {
      prefix: "/api",
      db,
      clickhouse: dashboard.clickhouse,
      auth: dashboard.auth,
      limiter,
      trustedOrigins: dashboard.trustedOrigins,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(heatmapOverlayRoutes, {
      prefix: "/api",
      db,
      clickhouse: dashboard.clickhouse,
      limiter,
      ...(heatmaps.overlayExchangeLimit === undefined
        ? {}
        : { exchangeLimit: heatmaps.overlayExchangeLimit }),
      ...(heatmaps.overlayReadLimit === undefined ? {} : { readLimit: heatmaps.overlayReadLimit }),
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(overviewRoutes, {
      prefix: "/api",
      db,
      clickhouse: dashboard.clickhouse,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      limiter,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(channelRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      publicUrl: dashboard.publicUrl,
      emailConfigured: notifications.emailConfigured ?? false,
      policy,
      ...(uptime.lookup === undefined ? {} : { lookup: uptime.lookup }),
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(spamRoutes, {
      prefix: "/api",
      db,
      clickhouse: dashboard.clickhouse,
      store: objectStore,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(replayRoutes, {
      prefix: "/api",
      db,
      store: objectStore,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      limitBytes: replays.limitBytes,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    if (replayPlayerPath !== undefined) {
      // At the site's root, beside the dashboard: not under /api.
      app.register(replayPlayerScriptRoute, { scriptPath: replayPlayerPath });
    }
    app.register(sourceMapRoutes, {
      prefix: "/api",
      db,
      store: objectStore,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      limitBytes: sourceMaps.limitBytes,
    });
    app.register(storageRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      sources: {
        db,
        clickhouse: dashboard.clickhouse,
        objectStore:
          storage.objectStore !== undefined
            ? storage.objectStore
            : objectStore === null
              ? null
              : { kind: "other", bucket: "" },
        budgets: { replayBytes: replays.limitBytes, sourceMapBytes: sourceMaps.limitBytes },
        telemetryRetentionDays:
          storage.telemetryRetentionDays ??
          telemetry.retentionDays ??
          DEFAULT_TELEMETRY_RETENTION_DAYS,
        garage: storage.garage ?? null,
        readDisk: storage.readDisk,
      },
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
