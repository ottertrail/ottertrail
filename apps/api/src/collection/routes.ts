import { Buffer } from "node:buffer";

import type { FastifyError, FastifyPluginCallback, FastifyReply } from "fastify";
import type { Kysely } from "kysely";

import type { IngestActivity, IngestOutcome, IngestSource } from "../activity/activity.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import type { Database } from "../db/schema.ts";
import { type IsDataCenter, noDataCenters } from "../enrichment/data-centers.ts";
import { type Locate, noLocation } from "../enrichment/geo.ts";
import { isReferrerSpam } from "../enrichment/referrer-spam.ts";
import { isBot, parseUserAgent } from "../enrichment/user-agent.ts";
import { fingerprint } from "../errors/fingerprint.ts";
import { isBlockedAddress } from "../projects/blocked-addresses.ts";
import { readInstanceSettings } from "../settings/settings.ts";
import { VisitorIds } from "../visitors/visitor-ids.ts";
import { ENGAGEMENT, ERROR, VITALS } from "../visits/visits.ts";
import {
  DEFAULT_MAX_EVENTS_IN_FLIGHT,
  DEFAULT_MAX_EVENTS_IN_FLIGHT_PER_PROJECT,
  INSERT_WAIT_SECONDS,
  projectTooBusy,
  tooBusy,
} from "./busy.ts";
import { ENVIRONMENT_PATTERN, environmentOf, RELEASE_PATTERN } from "./environment.ts";
import { type NewEvent, storeEvents } from "./event-store.ts";
import { isSignedUserId, USER_ID_PATTERN, USER_SIGNATURE_PATTERN } from "./identity.ts";
import { InFlight } from "./in-flight.ts";
import { parseTextPlainAsJson } from "./json-body.ts";
import { LastEventRecorder } from "./last-event.ts";
import { locationFromHeaders } from "./location-headers.ts";
import {
  cleanReferrer,
  correctClock,
  isAllowedHostname,
  isStorableText,
  originHostname,
  type PageUrl,
  parsePageUrl,
} from "./normalize.ts";
import { type CollectingProject, ProjectKeyCache, PUBLIC_KEY_PATTERN } from "./project-keys.ts";
import {
  ClientRateLimiter,
  EventBudget,
  type RateLimit,
  TokenBucketLimiter,
} from "./rate-limiter.ts";
import { DEFAULT_SERVER_IP_LIMIT, serverEventsRoute } from "./server-events.ts";
import { VisitorCap } from "./visitor-cap.ts";
import { keepValidVitals } from "./vitals.ts";

export const MAX_EVENTS_PER_BATCH = 50;
export const MAX_BODY_BYTES = 64 * 1024;
/**
 * Measured as the sender's JSON. PostgreSQL's looser safety limit allows for its
 * text format, which adds spaces and expands numbers such as 1e21.
 */
export const MAX_PROPERTIES_BYTES = 8 * 1024;
/** Longest time on one page an engagement event may report. */
export const MAX_ENGAGED_MS = 24 * 60 * 60 * 1000;

/** Requests per client IP address: bursts of 120, then 2 per second. */
export const DEFAULT_IP_LIMIT: RateLimit = { capacity: 120, refillPerSecond: 2 };
/**
 * Counts events per clientKey (IPv4 or IPv6 /64): bursts of 200, then 20 per second.
 * The request limit alone allows 50 events per request.
 */
export const DEFAULT_IP_EVENT_LIMIT: RateLimit = { capacity: 200, refillPerSecond: 20 };
/** Events per project: bursts of 2,000, then 200 per second. */
export const DEFAULT_PROJECT_LIMIT: RateLimit = { capacity: 2_000, refillPerSecond: 200 };
/**
 * Events per instance, all its projects together: three projects at full
 * rate, unless INSTANCE_EVENTS_PER_SECOND says otherwise (config.ts).
 * Adding projects does not raise what the instance takes in
 * (rate-limiter.ts, EventBudget).
 */
export const DEFAULT_INSTANCE_LIMIT: RateLimit = { capacity: 6_000, refillPerSecond: 600 };

export interface CollectionOptions {
  db: Kysely<Database>;
  /** What each project's requests came to, counted for its Activity tab (activity/activity.ts). */
  activity: IngestActivity;
  clickhouse: ClickHouseClient;
  ipLimit?: RateLimit;
  /** Events per client address (DEFAULT_IP_EVENT_LIMIT). */
  ipEventLimit?: RateLimit;
  projectLimit?: RateLimit;
  instanceLimit?: RateLimit;
  /**
   * Finds the visitor's location from the request. Default: no location.
   * Called only for projects whose location source is "database".
   */
  locate?: Locate;
  /** Whether an address is a data center's. Default: none is. */
  isDataCenter?: IsDataCenter;
  /**
   * Whether the API runs behind a proxy (TRUST_PROXY): without one, no
   * project's location headers are read, whatever the request says.
   */
  behindProxy?: boolean;
  /** How often expired visitor salts are deleted. Default: hourly. */
  saltCleanupIntervalMs?: number;
  now?: () => number;
  /** Shared with the project routes, which must make it forget replaced and deleted keys. */
  projectKeys?: ProjectKeyCache;
  /** Requests per IP address to /server-events (server-events.ts). */
  serverIpLimit?: RateLimit;
  /** Events one visitor ID may store per day (visitor-cap.ts); replaceable in tests. */
  visitorCap?: number;
  /** Event requests in progress per process, and per project (DEFAULT_MAX_EVENTS_IN_FLIGHT). */
  maxInFlight?: number;
  maxInFlightPerProject?: number;
}

type PropertyValue = string | number | boolean | null;

interface IncomingEvent {
  id: string;
  name: string;
  /** Milliseconds since 1970, by the sender's clock. */
  occurredAt: number;
  url: string;
  referrer?: string;
  properties?: Record<string, PropertyValue>;
  /** The site's own ID for the signed-in user, when one is. */
  userId?: string;
  /** The site server's signature for userId (identity.ts); needed when the project requires it. */
  userSignature?: string;
  /** What went wrong, for an event named "error" only (docs/errors.md). */
  error?: IncomingError;
  /** The server's trace of the page load, from Server-Timing (docs/telemetry.md). */
  traceId?: string;
  spanId?: string;
}

interface IncomingError {
  type: string;
  message: string;
  stack?: string;
  /** The site caught it and reported it itself. */
  handled?: boolean;
  /** The session replay the page is sending for it (docs/session-replay.md). */
  replayId?: string;
  /** The page's last requests before it, with data-traces="on" (docs/errors.md). */
  requests?: IncomingRequest[];
}

interface IncomingRequest {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  traceId: string;
}

/** W3C Trace Context's IDs, in lowercase hex as the tracker sends them; all zeros is no ID. */
const TRACE_ID_SCHEMA = { type: "string", pattern: "^(?!0{32}$)[0-9a-f]{32}$" } as const;
const SPAN_ID_SCHEMA = { type: "string", pattern: "^(?!0{16}$)[0-9a-f]{16}$" } as const;

/** Requests an error carries, at most (packages/tracker/src/traces.ts). */
export const MAX_ERROR_REQUESTS = 5;

/**
 * A request as the tracker keeps it: a method; a path without query string
 * or fragment, as URL.pathname writes it (printable ASCII but "?" and "#"); a status (0
 * when no answer came); a duration of at most an hour; its trace.
 */
const REQUEST_SCHEMA = {
  type: "object",
  required: ["method", "path", "status", "durationMs", "traceId"],
  additionalProperties: false,
  properties: {
    method: { type: "string", pattern: "^[A-Z]{1,16}$" },
    path: { type: "string", maxLength: 2048, pattern: '^/[!"$->@-~]*$' },
    status: { type: "integer", minimum: 0, maximum: 999 },
    durationMs: { type: "integer", minimum: 0, maximum: 3_600_000 },
    traceId: TRACE_ID_SCHEMA,
  },
} as const;

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/**
 * An error as the tracker reports it. Message and stack keep tabs and line
 * breaks, as browsers write them; no other control characters. The tracker
 * cuts them to these lengths (packages/tracker/src/errors.ts).
 */
const MULTILINE_TEXT = "^[^\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]*$";
const ERROR_SCHEMA = {
  type: "object",
  required: ["type", "message"],
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      pattern: "^[^\\u0000-\\u001F\\u007F-\\u009F]+$",
    },
    message: { type: "string", maxLength: 2000, pattern: MULTILINE_TEXT },
    stack: { type: "string", maxLength: 16_000, pattern: MULTILINE_TEXT },
    handled: { type: "boolean" },
    replayId: { type: "string", pattern: UUID_PATTERN },
    requests: { type: "array", maxItems: MAX_ERROR_REQUESTS, items: REQUEST_SCHEMA },
  },
} as const;

interface EventBatch {
  v: 1;
  key: string;
  /** When the batch was sent, in milliseconds since 1970, by the sender's clock. */
  sentAt: number;
  /** The device has a touchscreen; only ever true when sent. */
  touch?: boolean;
  /** Where the site runs, such as "staging"; "production" when left out. */
  environment?: string;
  /** The site's version, such as "1.4.2". */
  release?: string;
  events: IncomingEvent[];
}

const MAX_TIMESTAMP = 8_640_000_000_000_000; // The largest date JavaScript can represent.

export const EVENT_NAME_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  pattern: "^[^\\u0000-\\u001F\\u007F]+$",
} as const;

export const PROPERTIES_SCHEMA = {
  type: "object",
  maxProperties: 30,
  propertyNames: { minLength: 1, maxLength: 100 },
  additionalProperties: {
    type: ["string", "number", "boolean", "null"],
    maxLength: 500,
  },
} as const;

// Remove unknown fields so older servers accept batches from newer trackers.
const eventBatchSchema = {
  type: "object",
  required: ["v", "key", "sentAt", "events"],
  additionalProperties: false,
  properties: {
    v: { const: 1 },
    key: { type: "string", pattern: PUBLIC_KEY_PATTERN },
    sentAt: { type: "integer", minimum: 0, maximum: MAX_TIMESTAMP },
    // The device has a touchscreen: tells an iPad (which says it is a Mac) from a Mac.
    touch: { type: "boolean" },
    // All events in a batch share one environment and release.
    environment: { type: "string", pattern: ENVIRONMENT_PATTERN },
    release: { type: "string", maxLength: 200, pattern: RELEASE_PATTERN },
    events: {
      type: "array",
      minItems: 1,
      maxItems: MAX_EVENTS_PER_BATCH,
      items: {
        type: "object",
        required: ["id", "name", "occurredAt", "url"],
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: UUID_PATTERN },
          name: EVENT_NAME_SCHEMA,
          occurredAt: { type: "integer", minimum: 0, maximum: MAX_TIMESTAMP },
          url: { type: "string", minLength: 1, maxLength: 8192 },
          referrer: { type: "string", maxLength: 8192 },
          userId: { type: "string", maxLength: 200, pattern: USER_ID_PATTERN },
          userSignature: { type: "string", pattern: USER_SIGNATURE_PATTERN },
          properties: PROPERTIES_SCHEMA,
          error: ERROR_SCHEMA,
          traceId: TRACE_ID_SCHEMA,
          spanId: SPAN_ID_SCHEMA,
        },
        // A trace without its span, or a span without its trace, names nothing.
        dependencies: { traceId: ["spanId"], spanId: ["traceId"] },
      },
    },
  },
} as const;

/**
 * The 202 answer is the same whatever became of the batch: stored, too old,
 * a bot, a blocked address, spam, or past a visitor's daily cap. A sender
 * learns nothing about the filters; the project's Activity tab counts them.
 */
const receivedResponseSchema = {
  type: "object",
  required: ["received"],
  additionalProperties: false,
  properties: { received: { type: "integer" } },
} as const;

function problem(code: string, message: string) {
  return { error: code, message };
}

/** Errors and Web Vitals share browser batches but have separate Activity counters. */
function sourceOf(event: { name: string; error?: unknown }): IngestSource {
  // An "error" without its details is a custom event, as the route stores it.
  if (event.name === ERROR && event.error !== undefined) return "errors";
  if (event.name === VITALS) return "web_vitals";
  return "browser_events";
}

function countBySource(
  events: readonly { name: string; error?: unknown }[],
): Map<IngestSource, number> {
  const counts = new Map<IngestSource, number>();
  for (const event of events) {
    const source = sourceOf(event);
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  return counts;
}

function tooManyRequests(reply: FastifyReply, retryAfterSeconds: number) {
  return reply
    .code(429)
    .header("retry-after", String(retryAfterSeconds))
    .send(problem("rate_limited", `Too many requests. Retry after ${retryAfterSeconds} seconds.`));
}

function storageUnavailable(reply: FastifyReply) {
  return reply
    .code(503)
    .header("retry-after", "5")
    .send(problem("storage_unavailable", "Events were not stored. Retry later."));
}

/**
 * POST /events: receives a batch of events from a browser or server.
 *
 * Checks run cheapest first, so bad requests are turned away before they
 * cost a database query:
 *
 * 1. Rate limit per client IP (before the body is even read).
 * 2. Body size, content type, and JSON schema.
 * 3. Events per client address, now that their number is known.
 * 4. Project key (cached).
 * 5. Origin header against the project's allowed hostnames.
 * 6. Accepted and not stored (202): the project's blocked addresses, bots
 *    and data centers, referrer spam. Before the budget, so they cannot
 *    use it up.
 * 7. Each event's rules, page hostname, URL cleanup, and clock correction.
 * 8. Event budget per project, once the batch is known to be valid.
 * 9. Visitor IDs, and the daily cap per visitor.
 * 10. One insert into ClickHouse. 202 is sent only after ClickHouse has
 *     written it; 503 while it cannot, which the tracker retries.
 * (docs/web-analytics.md, "Checks, in order".)
 */
export const collectionRoutes: FastifyPluginCallback<CollectionOptions> = (app, options, done) => {
  const {
    db,
    clickhouse,
    locate = noLocation,
    isDataCenter = noDataCenters,
    behindProxy = false,
    now = Date.now,
    activity,
  } = options;
  // Log each affected project once so sites forwarding through cloud servers can
  // diagnose why all their events were ignored.
  const dataCenterProjects = new Set<string>();
  const projectLimit = options.projectLimit ?? DEFAULT_PROJECT_LIMIT;
  const instanceLimit = options.instanceLimit ?? DEFAULT_INSTANCE_LIMIT;
  if (Math.min(projectLimit.capacity, instanceLimit.capacity) < MAX_EVENTS_PER_BATCH) {
    done(
      new Error(
        `The project and instance limits must allow a full batch of ${MAX_EVENTS_PER_BATCH} events`,
      ),
    );
    return;
  }
  const visitors = new VisitorIds(db, { now });
  // Expired salts are deleted on a timer, so they go on time even without traffic.
  const stopSaltCleanup = visitors.startCleanup((error) => {
    app.log.warn({ err: error }, "could not delete expired visitor salts");
  }, options.saltCleanupIntervalMs);
  app.addHook("onClose", async () => {
    await stopSaltCleanup();
  });
  const ipLimiter = new ClientRateLimiter(options.ipLimit ?? DEFAULT_IP_LIMIT, { now });
  const ipEventLimit = options.ipEventLimit ?? DEFAULT_IP_EVENT_LIMIT;
  const ipEventLimiter = new ClientRateLimiter(ipEventLimit, { now });
  const visitorCap = new VisitorCap(
    options.visitorCap === undefined ? {} : { cap: options.visitorCap },
  );
  const budget = new EventBudget(
    new TokenBucketLimiter(projectLimit, { now }),
    new TokenBucketLimiter(instanceLimit, { now }),
  );
  const projects = options.projectKeys ?? new ProjectKeyCache(db, { now });
  // Taken once the body has arrived, so a slow sender holds no slot while it sends.
  const inFlight = new InFlight(
    options.maxInFlight ?? DEFAULT_MAX_EVENTS_IN_FLIGHT,
    options.maxInFlightPerProject ?? DEFAULT_MAX_EVENTS_IN_FLIGHT_PER_PROJECT,
  );
  const lastEvents = new LastEventRecorder(db, { now });

  parseTextPlainAsJson(app, MAX_BODY_BYTES);

  // Expose statuses and Retry-After so the tracker can distinguish failures worth
  // retrying. Responses contain no private data and use no cookies or credentials.
  // Origin checks still control collection.
  app.addHook("onSend", async (request, reply) => {
    const origin = request.headers.origin;
    // Not for server-side events: a page must never send the secret key.
    if (origin !== undefined && request.routeOptions.url?.endsWith("/server-events") !== true) {
      reply
        .header("access-control-allow-origin", origin)
        .header("access-control-expose-headers", "Retry-After")
        .header("vary", "Origin");
    }
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation !== undefined) {
      return reply.code(400).send(problem("invalid_request", error.message));
    }
    switch (error.statusCode) {
      case 400:
        return reply.code(400).send(problem("invalid_request", error.message));
      case 413:
        return reply
          .code(413)
          .send(problem("payload_too_large", `The body is larger than ${MAX_BODY_BYTES} bytes.`));
      case 415:
        return reply
          .code(415)
          .send(
            problem("unsupported_media_type", "Send the batch as text/plain or application/json."),
          );
      default:
        request.log.error({ err: error }, "unexpected error while collecting events");
        return reply.code(500).send(problem("internal_error", "Something went wrong."));
    }
  });

  app.post<{ Body: EventBatch }>(
    "/events",
    {
      bodyLimit: MAX_BODY_BYTES,
      schema: { body: eventBatchSchema, response: { 202: receivedResponseSchema } },
      // Runs before the body is read: the cheapest way to turn a flood away.
      onRequest: async (request, reply) => {
        const result = ipLimiter.take(request.ip);
        return result.allowed ? undefined : tooManyRequests(reply, result.retryAfterSeconds);
      },
      preHandler: async (request, reply) =>
        inFlight.take(request, reply) ? undefined : tooBusy(reply),
      onResponse: inFlight.finished,
      onRequestAbort: inFlight.finished,
    },
    async (request, reply) =>
      inFlight.run(request, async () => {
        const receivedAt = now();
        const { key, sentAt, events } = request.body;

        // Count events before the key lookup. Requests can each hold 50 events; clients
        // behind one address (an office or carrier NAT) share the limit.
        const perClient = ipEventLimiter.take(
          request.ip,
          Math.min(events.length, ipEventLimit.capacity),
        );
        if (!perClient.allowed) {
          return tooManyRequests(reply, perClient.retryAfterSeconds);
        }

        let project: CollectingProject | null;
        try {
          project = await projects.find(key);
        } catch (error) {
          request.log.error({ err: error }, "could not look up the project key");
          return storageUnavailable(reply);
        }
        if (project === null) {
          return reply.code(403).send(problem("unknown_key", "No project has this key."));
        }
        const projectId = project.id;

        // Count outcomes per source once the project is known (activity/activity.ts).
        const inBatch = countBySource(events);
        const count = (outcome: IngestOutcome, items?: ReadonlyMap<IngestSource, number>) => {
          for (const source of (items ?? inBatch).keys()) {
            activity.add(projectId, source, outcome, items?.get(source) ?? 0);
          }
        };
        const invalid = (message: string) => {
          count("refused_invalid");
          return reply.code(400).send(problem("invalid_request", message));
        };
        if (!inFlight.takeForProject(request, projectId)) {
          count("refused_rate_limited");
          return projectTooBusy(reply);
        }

        // Browser Origin filters other websites. Servers can omit or forge it.
        const origin = request.headers.origin;
        if (origin !== undefined) {
          const hostname = originHostname(origin);
          if (hostname === null || !isAllowedHostname(hostname, project.allowedHostnames)) {
            count("refused_origin");
            return reply
              .code(403)
              .send(
                problem("origin_not_allowed", "This site may not send events to this project."),
              );
          }
        }

        // Checked before the budget below: a bad request costs nothing.
        const environment = environmentOf(request.body.environment);
        const { release } = request.body;
        if (release !== undefined && !isStorableText(release)) {
          return invalid("release contains an unpaired surrogate, which cannot be stored.");
        }

        // Acknowledge blocked addresses without storing their events or address.
        const received = { received: events.length };
        if (isBlockedAddress(project.blocked, request.ip)) {
          count("filtered_spam", inBatch);
          return reply.code(202).send(received);
        }

        // Acknowledge bots to avoid retries; check before the budget so they consume none.
        // Data-center addresses are checked here and never stored.
        const userAgent = request.headers["user-agent"];
        const bot = isBot(userAgent);
        const dataCenter = !bot && project.ignoreDataCenters && isDataCenter(request.ip);
        if (dataCenter && !dataCenterProjects.has(project.id) && dataCenterProjects.size < 10_000) {
          dataCenterProjects.add(project.id);
          request.log.info(
            { projectId: project.id },
            "ignoring this project's events from data-center addresses (logged once)",
          );
        }
        if (bot || dataCenter) {
          count("filtered_bot", inBatch);
          return reply.code(202).send(received);
        }

        // One spam referrer drops the whole visit batch, including engagement and vitals.
        // The project's own hostnames are exempt so a listed domain cannot drop later pages.
        if (
          events.some((event) =>
            isReferrerSpam(
              event.referrer,
              project.blockedReferrers,
              undefined,
              project.allowedHostnames,
            ),
          )
        ) {
          count("filtered_spam", inBatch);
          return reply.code(202).send(received);
        }

        // The checks that can refuse the batch, before it spends any budget.
        const valid: { event: IncomingEvent; occurredAt: Date; page: PageUrl }[] = [];
        const tooOldBySource = new Map<IngestSource, number>();
        for (const [index, event] of events.entries()) {
          const page = parsePageUrl(event.url);
          if (page === null) {
            return invalid(`events[${index}].url is not a valid http(s) URL.`);
          }
          if (!isAllowedHostname(page.hostname, project.allowedHostnames)) {
            count("refused_origin");
            return reply
              .code(403)
              .send(
                problem(
                  "hostname_not_allowed",
                  `events[${index}].url is not on an allowed hostname.`,
                ),
              );
          }
          if (event.userId !== undefined && !isStorableText(event.userId)) {
            return invalid(
              `events[${index}].userId contains an unpaired surrogate, which cannot be stored.`,
            );
          }
          if (!isStorableText(event.name)) {
            return invalid(
              `events[${index}].name contains an unpaired surrogate, which cannot be stored.`,
            );
          }
          if (
            event.properties !== undefined &&
            Object.entries(event.properties).some(
              ([name, value]) =>
                !isStorableText(name) || (typeof value === "string" && !isStorableText(value)),
            )
          ) {
            return invalid(
              `events[${index}].properties contains a NUL character or an unpaired surrogate, which cannot be stored.`,
            );
          }
          if (
            event.properties !== undefined &&
            Buffer.byteLength(JSON.stringify(event.properties)) > MAX_PROPERTIES_BYTES
          ) {
            return invalid(
              `events[${index}].properties is larger than ${MAX_PROPERTIES_BYTES} bytes.`,
            );
          }

          // "engagement" is reserved: time a page was visible, reported by the tracker.
          if (event.name === ENGAGEMENT) {
            const engagedMs = event.properties?.engagedMs;
            if (
              typeof engagedMs !== "number" ||
              !Number.isInteger(engagedMs) ||
              engagedMs < 0 ||
              engagedMs > MAX_ENGAGED_MS
            ) {
              return invalid(
                `events[${index}] is an engagement event: properties.engagedMs must be a whole number of milliseconds, at most 24 hours.`,
              );
            }
          }
          if (event.name === VITALS && event.properties !== undefined) {
            keepValidVitals(event.properties);
          }

          // Cached trackers may send "error" as a custom event without details. Keep those
          // events so they do not invalidate the whole batch.
          if (event.error !== undefined && event.name !== ERROR) {
            return invalid(`events[${index}].error is only for events named "error".`);
          }
          if (
            event.error !== undefined &&
            ![event.error.type, event.error.message, event.error.stack ?? ""].every(isStorableText)
          ) {
            return invalid(
              `events[${index}].error contains an unpaired surrogate, which cannot be stored.`,
            );
          }

          const occurredAt = correctClock(event.occurredAt, sentAt, receivedAt);
          if (occurredAt === null) {
            const source = sourceOf(event);
            tooOldBySource.set(source, (tooOldBySource.get(source) ?? 0) + 1);
            continue;
          }
          valid.push({ event, occurredAt, page });
        }

        // After the rules above: a batch refused for one of them spends no budget.
        const spent = budget.take(project.id, events.length);
        if (!spent.allowed) {
          count(spent.limit === "instance" ? "refused_volume" : "refused_rate_limited");
          return tooManyRequests(reply, spent.retryAfterSeconds);
        }

        // The costlier work, only for a batch within its budget: signatures,
        // error fingerprints, the location. The IP is used for the location,
        // then discarded: never stored or logged. Each project picks where
        // locations come from (location-headers.ts), cached with its key.
        const client = parseUserAgent(userAgent ?? "", { touch: request.body.touch === true });
        const location =
          project.location.source === "database"
            ? locate(request.ip)
            : project.location.source === "headers"
              ? behindProxy
                ? locationFromHeaders(request.headers, project.location.headers)
                : {}
              : {};
        const accepted: NewEvent[] = valid.map(({ event, occurredAt, page }) => {
          // When signatures are required, invalid ones leave events anonymous.
          let { userId } = event;
          if (
            userId !== undefined &&
            project.requireSignedUserIds &&
            !isSignedUserId(project.secretKey, userId, event.userSignature)
          ) {
            userId = undefined;
          }
          return {
            eventId: event.id,
            name: event.name,
            occurredAt,
            path: page.path,
            referrer: cleanReferrer(event.referrer),
            utm: page.utm,
            ...(event.properties === undefined ? {} : { properties: event.properties }),
            client,
            location,
            environment,
            ...(release === undefined ? {} : { release }),
            ...(userId === undefined ? {} : { userId }),
            ...(event.error === undefined
              ? {}
              : {
                  error: {
                    type: event.error.type,
                    message: event.error.message,
                    ...(event.error.stack === undefined || event.error.stack === ""
                      ? {}
                      : { stack: event.error.stack }),
                    handled: event.error.handled === true,
                    fingerprint: fingerprint(event.error),
                    ...(event.error.replayId === undefined
                      ? {}
                      : { replayId: event.error.replayId.toLowerCase() }),
                    ...(event.error.requests === undefined || event.error.requests.length === 0
                      ? {}
                      : {
                          requests: event.error.requests.map((sent) => ({
                            method: sent.method,
                            path: sent.path,
                            status: sent.status,
                            duration_ms: sent.durationMs,
                            trace_id: sent.traceId,
                          })),
                        }),
                  },
                }),
            ...(event.traceId === undefined || event.spanId === undefined
              ? {}
              : { trace: { traceId: event.traceId, spanId: event.spanId } }),
          };
        });

        let capped = 0;
        const cappedBySource = new Map<IngestSource, number>();
        const counted: { day: string; visitorId: string }[] = [];
        let toStore = accepted;
        try {
          // Each event gets the visitor ID of the day it happened, so a late
          // event from just before midnight joins the rest of that day's visit.
          const { timeZone } = await readInstanceSettings(db);
          for (const event of accepted) {
            event.visitorId = await visitors.idFor({
              projectId: project.id,
              timeZone,
              ip: request.ip,
              userAgent: userAgent ?? "",
              occurredAt: event.occurredAt,
            });
          }
          toStore = accepted.filter((event) => {
            const day = visitors.dayOf(timeZone, event.occurredAt);
            const visitorId = event.visitorId ?? "";
            if (visitorCap.take(project.id, day, visitorId)) {
              counted.push({ day, visitorId });
              return true;
            }
            capped += 1;
            const source = sourceOf(event);
            cappedBySource.set(source, (cappedBySource.get(source) ?? 0) + 1);
            return false;
          });
          // Capped events spend no budget: they are not stored.
          if (capped > 0) budget.refund(project.id, capped);
          if (toStore.length > 0) {
            await storeEvents(clickhouse, project.id, toStore, {
              receivedAt: new Date(receivedAt),
              waitSeconds: INSERT_WAIT_SECONDS,
            });
          }
        } catch (error) {
          // Refund budget and visitor counts so storage failures do not penalize retries.
          budget.refund(project.id, events.length - capped);
          for (const { day, visitorId } of counted) visitorCap.untake(project.id, day, visitorId);
          request.log.error({ err: error }, "could not store events");
          count("refused_unavailable");
          return storageUnavailable(reply);
        }
        // Mixed batches count in each outcome: stored, too old, or capped (spam).
        count("accepted", countBySource(toStore));
        count("filtered_too_old", tooOldBySource);
        count("filtered_spam", cappedBySource);
        // PostgreSQL bookkeeping must not delay or fail an already stored batch.
        lastEvents.record(project.id, toStore).catch((error: unknown) => {
          request.log.warn({ err: error }, "could not record the project's latest event");
        });
        return reply.code(202).send(received);
      }),
  );

  serverEventsRoute(app, {
    clickhouse,
    projects,
    lastEvents,
    budget,
    activity,
    ipLimiter: new ClientRateLimiter(options.serverIpLimit ?? DEFAULT_SERVER_IP_LIMIT, { now }),
    inFlight,
    maxEvents: MAX_EVENTS_PER_BATCH,
    maxBodyBytes: MAX_BODY_BYTES,
    maxPropertiesBytes: MAX_PROPERTIES_BYTES,
    schemas: { name: EVENT_NAME_SCHEMA, properties: PROPERTIES_SCHEMA },
    now,
  });

  done();
};
