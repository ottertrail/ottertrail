import { randomBytes } from "node:crypto";

import Fastify, { type FastifyServerOptions } from "fastify";
import type { Kysely } from "kysely";

import { memberRoutes } from "./access/member-routes.ts";
import { meRoutes } from "./access/routes.ts";
import { accountRoutes } from "./account/routes.ts";
import { IngestActivity } from "./activity/activity.ts";
import { ingestActivityRoutes } from "./activity/routes.ts";
import { aiCallListRoutes } from "./ai/call-routes.ts";
import { type AiCallIngestOptions, aiCallIngestRoutes } from "./ai/ingest-routes.ts";
import { aiModelRoutes } from "./ai/model-routes.ts";
import { aiRoutes } from "./ai/routes.ts";
import { evaluateCheckDown } from "./alerts/check-rules.ts";
import { alertRoutes } from "./alerts/routes.ts";
import type { Auth } from "./auth/auth.ts";
import { passwordTryLimiter } from "./auth/password-tries.ts";
import { betterAuthRoutes, setupRoutes } from "./auth/routes.ts";
import { avatarRoutes } from "./avatars/routes.ts";
import { backupRoutes } from "./backups/routes.ts";
import { BackupSecrets } from "./backups/secrets.ts";
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
import { heatmapSnapshotRoutes } from "./heatmaps/snapshot-routes.ts";
import { userRoutes } from "./identities/routes.ts";
import { userDeletionRoutes } from "./identities/server-routes.ts";
import type { Mailer } from "./notifications/email.ts";
import { inboxRoutes } from "./notifications/inbox-routes.ts";
import { LinkSealer } from "./notifications/link-sealer.ts";
import { channelRoutes } from "./notifications/routes.ts";
import { addressPolicy, type Lookup } from "./outbound/addresses.ts";
import { overviewRoutes } from "./overview/routes.ts";
import { productRoutes } from "./product/routes.ts";
import { projectRoutes } from "./projects/routes.ts";
import { replayPlayerScriptRoute, replayRoutes } from "./replays/dashboard-routes.ts";
import { replayCollectionRoutes } from "./replays/routes.ts";
import { reportExportRoutes } from "./reports/export-routes.ts";
import { nowRoutes } from "./reports/now-routes.ts";
import { reportRoutes } from "./reports/routes.ts";
import { healthRoutes } from "./routes/health.ts";
import { segmentRoutes } from "./segments/routes.ts";
import { ServerLogBuffer } from "./server-log/buffer.ts";
import { serverLogDestination } from "./server-log/destination.ts";
import { redactUrl } from "./server-log/redact.ts";
import { serverLogRoutes } from "./server-log/routes.ts";
import { settingsRoutes } from "./settings/routes.ts";
import { shareLinkRoutes, shareRoutes } from "./share/routes.ts";
import { SourceMapCache } from "./source-maps/resolve.ts";
import { sourceMapRoutes, sourceMapUploadRoutes } from "./source-maps/routes.ts";
import { spamRoutes } from "./spam/routes.ts";
import { speedRoutes } from "./speed/routes.ts";
import type { ObjectStore } from "./storage/object-store.ts";
import { storageRoutes } from "./storage/routes.ts";
import type { StorageSources } from "./storage/usage.ts";
import { DashboardQueryLimiter, liveQueryLimiter } from "./telemetry/dashboard-limit.ts";
import { telemetryDashboardRoutes } from "./telemetry/dashboard-routes.ts";
import { SecretKeyLookups } from "./telemetry/key-lookups.ts";
import { type TelemetryOptions, telemetryBudget, telemetryRoutes } from "./telemetry/routes.ts";
import { trackerScriptRoutes } from "./tracker-script/routes.ts";
import { heartbeatRoutes } from "./uptime/heartbeat-routes.ts";
import { uptimeRoutes } from "./uptime/routes.ts";
import { validationMessage } from "./validation-message.ts";

/**
 * How long a client has to send a whole request, its body included, and
 * its headers. Fastify turns off Node's own limits, so without them a
 * client could send a body a byte at a time and hold its connection for
 * ever. Enough for the largest upload, a 25 MiB source map, at about
 * 1.75 Mbit/s, or less gzipped. A response may take as long as it needs: the Server log's
 * stream stays open.
 */
export const REQUEST_TIMEOUT_MS = 120_000;
export const HEADERS_TIMEOUT_MS = 20_000;

export interface AppOptions extends Omit<FastifyServerOptions, "logger"> {
  /**
   * REQUEST_TIMEOUT_MS and HEADERS_TIMEOUT_MS, and how often Node checks
   * them (30 seconds by default), which tests lower.
   */
  timeouts?: { requestMs?: number; headersMs?: number; checkIntervalMs?: number };
  db: Kysely<Database>;
  /**
   * Uses the dashboard's ClickHouse client unless overridden.
   * Collection routes require a ClickHouse client.
   */
  collection?: Omit<CollectionOptions, "db" | "clickhouse" | "activity"> & {
    clickhouse?: ClickHouseClient;
  };
  /**
   * Logging is off when omitted. Redact every line (server-log/redact.ts)
   * before sending it to the supplied stream or stdout.
   */
  log?: { level: string; stream?: { write(line: string): void } };
  /**
   * Omitting the buffer gives an empty stream. Worker lines arrive through
   * server-log/listener.ts; tests can lower stream limits.
   */
  serverLog?: {
    buffer?: ServerLogBuffer;
    maxStreams?: number;
    heartbeatMs?: number;
    recheckMs?: number;
  };
  /**
   * Without a dashboard, serve health and collection only. Collection still
   * requires collection.clickhouse (src/auth/auth.ts).
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
    /** "Forgot password?" requests per client address and per email address (access/member-routes.ts). */
    resetRequestIpLimit?: RateLimit;
    resetRequestEmailLimit?: RateLimit;
    resetRequestInstanceLimit?: RateLimit;
    /** Emailed invitations and New links per owner or admin. */
    invitationEmailLimit?: RateLimit;
    /**
     * Share one per-user password limiter across email, password,
     * and ownership changes.
     */
    passwordTryLimit?: RateLimit;
  };
  /** Source maps and replays are disabled when no object store is supplied. */
  objectStore?: ObjectStore | null;
  /**
   * Omitting this reports neither location file loaded (enrichment/reload.ts).
   * checkNeeded() loads or drops the location file when projects' location sources change.
   */
  locationData?: { readonly loaded: LoadedLocationData; checkNeeded?(): Promise<void> };
  /** Source maps (docs/errors.md, "Source maps"): the instance's storage limit, and upload limits. */
  sourceMaps?: {
    limitBytes: number;
    ipLimit?: RateLimit;
    /** Uploads one process stores at once (source-maps/routes.ts). */
    maxInFlight?: number;
  };
  /** POST /api/user-deletions' limit per client address (identities/server-routes.ts). */
  userDeletions?: { ipLimit?: RateLimit };
  /** Replay storage and collection limits (docs/session-replay.md). */
  replays?: {
    limitBytes: number;
    ipLimit?: RateLimit;
    projectLimit?: RateLimit;
    instanceLimit?: RateLimit;
  };
  /**
   * Heatmaps use the event collection's ClickHouse client (heatmaps/routes.ts).
   * Overlay limits apply per client address (heatmaps/overlay-routes.ts).
   */
  heatmaps?: {
    ipLimit?: RateLimit;
    ipRecordLimit?: RateLimit;
    projectLimit?: RateLimit;
    instanceLimit?: RateLimit;
    overlayExchangeLimit?: RateLimit;
    overlayReadLimit?: RateLimit;
    overlayMintLimit?: RateLimit;
    overlaySaveLimit?: RateLimit;
    /** Collection requests in progress, per process and per project (heatmaps/routes.ts). */
    maxInFlight?: number;
    maxInFlightPerProject?: number;
  };
  /**
   * Uses the dashboard's ClickHouse client unless overridden. OTLP routes
   * require a client (docs/telemetry.md).
   */
  telemetry?: Partial<Omit<TelemetryOptions, "projects" | "now" | "budget" | "activity">>;
  /** POST /api/ai-calls (ai/ingest-routes.ts): its limit per client address and its requests in progress, which tests lower. */
  aiCalls?: Pick<AiCallIngestOptions, "ipLimit" | "maxInFlight" | "maxInFlightPerProject">;
  /**
   * Uptime checks (docs/uptime-alerts.md): whether they may reach private
   * addresses (UPTIME_ALLOW_PRIVATE_ADDRESSES, off by default), the
   * addresses they may never reach (UPTIME_DENY_ADDRESSES), and the
   * resolver that checks a URL's host when a check is saved (tests fake it).
   */
  uptime?: { allowPrivateAddresses?: boolean; denyAddresses?: string[]; lookup?: Lookup };
  /** Shared links' limits per client address and per link (share/routes.ts), which tests lower. */
  shareLinks?: {
    ipLimit?: RateLimit;
    linkLimit?: RateLimit;
    reportLimiter?: DashboardQueryLimiter;
    liveLimiter?: DashboardQueryLimiter;
  };
  /** Heartbeat pings' limits per client address and per heartbeat (uptime/heartbeat-routes.ts), which tests lower. */
  heartbeats?: { ipLimit?: RateLimit; checkLimit?: RateLimit };
  /**
   * Email (docs/uptime-alerts.md, "Where alerts go"; docs/access.md,
   * "Account email"): whether SMTP_URL is set, which the dashboard shows
   * and which turns account email on (queued for the worker), and the
   * mailer the test email goes out through at once. Webhook URLs follow
   * `uptime`'s address rules and resolver.
   */
  notifications?: {
    emailConfigured?: boolean;
    mailer?: Mailer | null;
    testEmailLimit?: RateLimit;
    /** AUTH_SECRET: the key queued links are sealed with; required with `emailConfigured`. */
    linkSecret?: string;
  };
  /**
   * The Storage section's sources (storage/usage.ts) beyond the app's own:
   * whether the object store is the stack's Garage and its bucket, Garage's
   * admin API, and, in tests, the disk's figures. Omitted, an object store
   * counts as another S3-compatible store, without Garage's figures.
   */
  storage?: Partial<
    Pick<StorageSources, "objectStore" | "garage" | "readDisk" | "telemetryRetentionDays">
  >;
  /**
   * Scheduled backups' routes (backups/routes.ts): the AUTH_SECRET the
   * backup key is sealed with (the link secret when omitted), and the
   * per-user limits, which tests lower. Where backups go is the worker's
   * alone (BACKUP_S3_*).
   */
  backups?: {
    authSecret?: string;
    testConnectionLimit?: RateLimit;
    backupNowLimit?: RateLimit;
    testRestoreLimit?: RateLimit;
  };
  /** Avatar uploads per user (avatars/routes.ts), which tests lower. */
  avatars?: { uploadLimit?: RateLimit };
  /** Changes to the AI model prices per user (ai/model-routes.ts), which tests lower. */
  aiModels?: { changeLimit?: RateLimit };
  /**
   * Flush every 15 seconds and on close (activity/activity.ts).
   * Tests can supply counters to control flushing.
   */
  ingestActivity?: IngestActivity;
  /**
   * Fastify runs onClose hooks in reverse registration order. Close external
   * resources here, after the final ingestion counts are written, to avoid
   * closing the database before the flush.
   */
  closeAfter?: () => Promise<void>;
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
 * IP address is personal data that Ottertrail never keeps. Never headers,
 * so Authorization and Cookie never reach a log. A site's user ID is
 * personal data too, so a user's path, a user search, and event property
 * filters are masked, as are tokens and keys in the URL (redactUrl): logs
 * are kept apart from the project's retention and deletion, and the
 * Server log shows them in the dashboard.
 */
export function requestLogFields(request: { method: string; url: string }) {
  return { method: request.method, url: redactUrl(request.url) };
}

/**
 * What "request completed" records: the status, and the request's method
 * and URL as requestLogFields records them, so the line reads alone.
 */
export function responseLogFields(reply: {
  statusCode: number;
  request?: { method: string; url: string };
}) {
  return {
    statusCode: reply.statusCode,
    ...(reply.request === undefined ? {} : requestLogFields(reply.request)),
  };
}

/** Heatmaps' collection limits, without the overlay's. */
function collectionLimitsOf({
  overlayExchangeLimit: _exchange,
  overlayReadLimit: _read,
  overlayMintLimit: _mint,
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
  userDeletions = {},
  heatmaps = {},
  telemetry = {},
  aiCalls = {},
  uptime = {},
  heartbeats = {},
  shareLinks = {},
  notifications = {},
  storage = {},
  backups = {},
  avatars = {},
  aiModels = {},
  serverLog = {},
  ingestActivity,
  closeAfter,
  trackerScriptPath,
  dashboardPath,
  replayPlayerPath,
  timeouts = {},
  ...fastifyOptions
}: AppOptions) {
  /** TELEMETRY_RETENTION_DAYS: the most days a project keeps traces, logs, and metrics. */
  const telemetryMaxDays = telemetry.retentionDays ?? DEFAULT_TELEMETRY_RETENTION_DAYS;
  const app = Fastify({
    // A user ID in a path may be 200 characters, 400 UTF-16 units; Fastify allows 100.
    routerOptions: { maxParamLength: 512 },
    // Schema failures read as sentences, which the dashboard shows as they are.
    schemaErrorFormatter: (errors, dataVar) => new Error(validationMessage(errors, dataVar)),
    requestTimeout: timeouts.requestMs ?? REQUEST_TIMEOUT_MS,
    http: {
      headersTimeout: timeouts.headersMs ?? HEADERS_TIMEOUT_MS,
      ...(timeouts.checkIntervalMs === undefined
        ? {}
        : { connectionsCheckingInterval: timeouts.checkIntervalMs }),
    },
    ...fastifyOptions,
    logger:
      log === undefined
        ? false
        : {
            level: log.level,
            // pino's custom destination: masked, then to stdout (or the
            // test's stream) and into the Server log's buffer.
            stream: serverLogDestination(log.stream ?? process.stdout, serverLog.buffer),
            serializers: { req: requestLogFields, res: responseLogFields },
          },
  });
  app.register(healthRoutes, { prefix: "/api" });
  // Counts of what each project's ingestion accepted and refused, written
  // every 15 seconds and once more on close, after the routes' last
  // requests and before `closeAfter` closes the database. Added first, so
  // it runs last of the app's onClose hooks.
  const activity =
    ingestActivity ??
    new IngestActivity(db, {
      ...(collection.now === undefined ? {} : { now: collection.now }),
      warn: (message, fields) => {
        app.log.warn(fields, message);
      },
    });
  const stopActivity = activity.start();
  app.addHook("onClose", async () => {
    stopActivity();
    await activity.flush().catch((error: unknown) => {
      app.log.warn({ err: error }, "ingestion activity: could not write the last counts");
    });
    await closeAfter?.();
  });
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
      // Location headers count only behind a proxy (collection/location-headers.ts).
      behindProxy: fastifyOptions.trustProxy !== undefined && fastifyOptions.trustProxy !== false,
      ...collection,
      activity,
      clickhouse: collectionClickHouse,
    });
    app.register(heatmapCollectionRoutes, {
      prefix: "/api",
      clickhouse: collectionClickHouse,
      projects: projectKeys,
      activity,
      ...collectionLimitsOf(heatmaps),
      ...(collection.isDataCenter === undefined ? {} : { isDataCenter: collection.isDataCenter }),
      ...(collection.now === undefined ? {} : { now: collection.now }),
    });
  }
  app.register(replayCollectionRoutes, {
    prefix: "/api",
    db,
    projects: projectKeys,
    activity,
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
    activity,
    limitBytes: sourceMaps.limitBytes,
    ...(sourceMaps.ipLimit === undefined ? {} : { ipLimit: sourceMaps.ipLimit }),
    ...(sourceMaps.maxInFlight === undefined ? {} : { maxInFlight: sourceMaps.maxInFlight }),
  });
  app.register(userDeletionRoutes, {
    prefix: "/api",
    db,
    projects: projectKeys,
    ...userDeletions,
  });
  const telemetryClickHouse = telemetry.clickhouse ?? dashboard?.clickhouse;
  if (telemetryClickHouse !== undefined) {
    // At the root, not under /api: an exporter appends /v1/traces to the
    // address it is given (OTEL_EXPORTER_OTLP_ENDPOINT).
    // One budget for OTLP and the AI calls sent over HTTP.
    const budget = telemetryBudget(telemetry);
    // And one queue for their key lookups, so together they hold at most 4 of the pool's connections.
    const keyLookups = telemetry.keyLookups ?? new SecretKeyLookups();
    app.register(telemetryRoutes, {
      ...telemetry,
      clickhouse: telemetryClickHouse,
      projects: projectKeys,
      activity,
      budget,
      keyLookups,
      retentionDays: telemetryMaxDays,
      ...(collection.now === undefined ? {} : { now: collection.now }),
    });
    app.register(aiCallIngestRoutes, {
      prefix: "/api",
      clickhouse: telemetryClickHouse,
      projects: projectKeys,
      activity,
      budget,
      keyLookups,
      ...aiCalls,
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
    app.register(meRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      avatarUploads: objectStore !== null,
    });
    if (notifications.emailConfigured === true && notifications.linkSecret === undefined) {
      // Queued account email links are sealed with it (notifications/link-sealer.ts).
      throw new Error("notifications.linkSecret (AUTH_SECRET) is required with emailConfigured");
    }
    const sealer =
      notifications.linkSecret === undefined ? null : new LinkSealer(notifications.linkSecret);
    // One bucket per user for every route that checks the current password.
    const passwordTries = passwordTryLimiter(dashboard.passwordTryLimit);
    app.register(memberRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      publicUrl: dashboard.publicUrl,
      ...(dashboard.linkLimit === undefined ? {} : { linkLimit: dashboard.linkLimit }),
      ...(dashboard.resetRequestIpLimit === undefined
        ? {}
        : { resetRequestIpLimit: dashboard.resetRequestIpLimit }),
      ...(dashboard.resetRequestEmailLimit === undefined
        ? {}
        : { resetRequestEmailLimit: dashboard.resetRequestEmailLimit }),
      ...(dashboard.resetRequestInstanceLimit === undefined
        ? {}
        : { resetRequestInstanceLimit: dashboard.resetRequestInstanceLimit }),
      ...(dashboard.invitationEmailLimit === undefined
        ? {}
        : { invitationEmailLimit: dashboard.invitationEmailLimit }),
      emailConfigured: notifications.emailConfigured ?? false,
      sealer,
      passwordTries,
      objectStore,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(accountRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      passwordTries,
      emailConfigured: notifications.emailConfigured ?? false,
      sealer,
    });
    app.register(avatarRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      store: objectStore,
      ...(avatars.uploadLimit === undefined ? {} : { uploadLimit: avatars.uploadLimit }),
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
      telemetryMaxDays,
      // The reply does not wait: loading the file takes seconds, and checkNeeded never throws.
      onLocationSourcesChange: () => void locationData?.checkNeeded?.(),
    });
    app.register(ingestActivityRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(userRoutes, {
      prefix: "/api",
      db,
      clickhouse: dashboard.clickhouse,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
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
    app.register(segmentRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
    });
    // One limit on the dashboard's ClickHouse queries, shared by every page that reads them.
    const limiter = new DashboardQueryLimiter();
    // Live polls (Logs and Traces' Live, Right now) share one slot of it.
    const liveLimiter = liveQueryLimiter();
    app.register(productRoutes, {
      prefix: "/api",
      db,
      clickhouse: dashboard.clickhouse,
      auth: dashboard.auth,
      limiter,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(speedRoutes, {
      prefix: "/api",
      db,
      clickhouse: dashboard.clickhouse,
      auth: dashboard.auth,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(inboxRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(errorRoutes, {
      prefix: "/api",
      db,
      clickhouse: dashboard.clickhouse,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      publicUrl: dashboard.publicUrl,
      emailConfigured: notifications.emailConfigured ?? false,
      sealer,
      sourceMaps: { store: objectStore, cache: new SourceMapCache() },
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(telemetryDashboardRoutes, {
      prefix: "/api",
      db,
      clickhouse: telemetry.clickhouse ?? dashboard.clickhouse,
      auth: dashboard.auth,
      maxRetentionDays: telemetryMaxDays,
      limiter,
      liveLimiter,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(aiRoutes, {
      prefix: "/api",
      db,
      clickhouse: telemetry.clickhouse ?? dashboard.clickhouse,
      auth: dashboard.auth,
      limiter,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(aiCallListRoutes, {
      prefix: "/api",
      db,
      clickhouse: telemetry.clickhouse ?? dashboard.clickhouse,
      auth: dashboard.auth,
      maxTraceRetentionDays: telemetryMaxDays,
      limiter,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(aiModelRoutes, {
      prefix: "/api",
      db,
      clickhouse: telemetry.clickhouse ?? dashboard.clickhouse,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      limiter,
      ...(aiModels.changeLimit === undefined ? {} : { changeLimit: aiModels.changeLimit }),
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
      publicUrl: dashboard.publicUrl,
      policy,
      limiter,
      ...(uptime.lookup === undefined ? {} : { lookup: uptime.lookup }),
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    // Public: a heartbeat's token is its capability (docs/access.md).
    const alertContext = {
      db,
      publicUrl: dashboard.publicUrl,
      log: (level: "info" | "error", msg: string, fields?: Record<string, unknown>) =>
        app.log[level](fields ?? {}, msg),
    };
    app.register(heartbeatRoutes, {
      prefix: "/api",
      db,
      ...heartbeats,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
      onStateChange: async (change) => {
        await evaluateCheckDown(
          alertContext,
          { projectId: change.projectId, checkId: change.checkId },
          change.at,
        );
      },
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
      ...(heatmaps.overlayMintLimit === undefined ? {} : { mintLimit: heatmaps.overlayMintLimit }),
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
      ...(heatmaps.overlaySaveLimit === undefined ? {} : { saveLimit: heatmaps.overlaySaveLimit }),
      store: objectStore,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(heatmapSnapshotRoutes, {
      prefix: "/api",
      db,
      clickhouse: dashboard.clickhouse,
      store: objectStore,
      auth: dashboard.auth,
      limiter,
      trustedOrigins: dashboard.trustedOrigins,
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
      mailer: notifications.mailer ?? null,
      ...(notifications.testEmailLimit === undefined
        ? {}
        : { testEmailLimit: notifications.testEmailLimit }),
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
        telemetryRetentionDays: storage.telemetryRetentionDays ?? telemetryMaxDays,
        garage: storage.garage ?? null,
        readDisk: storage.readDisk,
      },
    });
    app.register(backupRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      publicUrl: dashboard.publicUrl,
      // The key, and turning backups off, need the current password.
      passwordTries,
      emailConfigured: notifications.emailConfigured ?? false,
      sealer,
      // Without either secret (a test that only lists routes), one for this process alone.
      secrets: new BackupSecrets(
        backups.authSecret ?? notifications.linkSecret ?? randomBytes(32).toString("hex"),
      ),
      ...(backups.testConnectionLimit === undefined
        ? {}
        : { testConnectionLimit: backups.testConnectionLimit }),
      ...(backups.backupNowLimit === undefined ? {} : { backupNowLimit: backups.backupNowLimit }),
      ...(backups.testRestoreLimit === undefined
        ? {}
        : { testRestoreLimit: backups.testRestoreLimit }),
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(reportRoutes, {
      prefix: "/api",
      db,
      clickhouse: dashboard.clickhouse,
      auth: dashboard.auth,
      limiter,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(reportExportRoutes, {
      prefix: "/api",
      db,
      clickhouse: dashboard.clickhouse,
      auth: dashboard.auth,
      limiter,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(nowRoutes, {
      prefix: "/api",
      db,
      clickhouse: dashboard.clickhouse,
      auth: dashboard.auth,
      limiter,
      liveLimiter,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(shareLinkRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      publicUrl: dashboard.publicUrl,
    });
    // Public: a shared link's token is its capability (docs/access.md).
    app.register(shareRoutes, {
      prefix: "/api",
      db,
      clickhouse: dashboard.clickhouse,
      store: objectStore,
      // Its own query limits (share/routes.ts), never the dashboard's.
      ...shareLinks,
      ...(dashboard.now === undefined ? {} : { now: dashboard.now }),
    });
    app.register(serverLogRoutes, {
      prefix: "/api",
      db,
      auth: dashboard.auth,
      trustedOrigins: dashboard.trustedOrigins,
      buffer: serverLog.buffer ?? new ServerLogBuffer(),
      level: log?.level ?? "silent",
      ...(serverLog.maxStreams === undefined ? {} : { maxStreams: serverLog.maxStreams }),
      ...(serverLog.heartbeatMs === undefined ? {} : { heartbeatMs: serverLog.heartbeatMs }),
      ...(serverLog.recheckMs === undefined ? {} : { recheckMs: serverLog.recheckMs }),
    });
  }
  return app;
}
