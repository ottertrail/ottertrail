import { Buffer } from "node:buffer";

import type { FastifyError, FastifyPluginCallback, FastifyReply } from "fastify";
import type { Kysely } from "kysely";

import type { Database } from "../db/schema.ts";
import { type IsDataCenter, noDataCenters } from "../enrichment/data-centers.ts";
import { type Locate, noLocation } from "../enrichment/geo.ts";
import { isBot, parseUserAgent } from "../enrichment/user-agent.ts";
import { fingerprint } from "../errors/fingerprint.ts";
import { VisitorIds } from "../visitors/visitor-ids.ts";
import { ENGAGEMENT, ERROR, VITALS } from "../visits/visits.ts";
import { ENVIRONMENT_PATTERN, environmentOf, RELEASE_PATTERN } from "./environment.ts";
import { type NewEvent, storeEvents } from "./event-store.ts";
import { isSignedUserId, USER_ID_PATTERN, USER_SIGNATURE_PATTERN } from "./identity.ts";
import {
  cleanReferrer,
  correctClock,
  isAllowedHostname,
  isStorableText,
  originHostname,
  parsePageUrl,
} from "./normalize.ts";
import { type CollectingProject, ProjectKeyCache, PUBLIC_KEY_PATTERN } from "./project-keys.ts";
import { EventBudget, type RateLimit, TokenBucketLimiter } from "./rate-limiter.ts";
import { DEFAULT_SERVER_IP_LIMIT, serverEventsRoute } from "./server-events.ts";
import { keepValidVitals } from "./vitals.ts";

export const MAX_EVENTS_PER_BATCH = 50;
export const MAX_BODY_BYTES = 64 * 1024;
/**
 * Size of an event's properties, measured as the JSON the sender sent. The
 * database keeps a looser limit as a safety net: PostgreSQL's own text form
 * of the same JSON is larger (it adds spaces and writes 1e21 out in full).
 */
export const MAX_PROPERTIES_BYTES = 8 * 1024;
/** Longest time on one page an engagement event may report. */
export const MAX_ENGAGED_MS = 24 * 60 * 60 * 1000;

/** Requests per client IP address: bursts of 120, then 2 per second. */
export const DEFAULT_IP_LIMIT: RateLimit = { capacity: 120, refillPerSecond: 2 };
/** Events per project: bursts of 2,000, then 200 per second. */
export const DEFAULT_PROJECT_LIMIT: RateLimit = { capacity: 2_000, refillPerSecond: 200 };
/**
 * Events per organization, all its projects together: three projects at
 * full rate, unless ORGANIZATION_EVENTS_PER_SECOND says otherwise
 * (config.ts). One customer cannot take more of the instance by adding
 * projects (rate-limiter.ts, EventBudget).
 */
export const DEFAULT_ORGANIZATION_LIMIT: RateLimit = { capacity: 6_000, refillPerSecond: 600 };

export interface CollectionOptions {
  db: Kysely<Database>;
  ipLimit?: RateLimit;
  projectLimit?: RateLimit;
  organizationLimit?: RateLimit;
  /** Finds the visitor's location from the request. Default: no location. */
  locate?: Locate;
  /** Whether an address is a data center's. Default: none is. */
  isDataCenter?: IsDataCenter;
  /** How often expired visitor salts are deleted. Default: hourly. */
  saltCleanupIntervalMs?: number;
  /** Clock, replaceable in tests. */
  now?: () => number;
  /** Shared with the project routes, which must make it forget replaced and deleted keys. */
  projectKeys?: ProjectKeyCache;
  /** Requests per IP address to /server-events (server-events.ts). */
  serverIpLimit?: RateLimit;
}

type PropertyValue = string | number | boolean | null;

interface IncomingEvent {
  id: string;
  name: string;
  /** Milliseconds since 1970, by the sender's clock. */
  occurredAt: number;
  /** Full URL of the page the event happened on. */
  url: string;
  referrer?: string;
  properties?: Record<string, PropertyValue>;
  /** The site's own ID for the signed-in user, when one is. */
  userId?: string;
  /** The site server's signature for userId (identity.ts); needed when the project requires it. */
  userSignature?: string;
  /** What went wrong, for an event named "error" only (docs/errors.md). */
  error?: IncomingError;
}

interface IncomingError {
  type: string;
  message: string;
  stack?: string;
  /** The site caught it and reported it itself. */
  handled?: boolean;
}

/**
 * An error as the tracker reports it. Message and stack keep tabs and line
 * breaks, as browsers write them; no other control characters. The tracker
 * cuts them to these lengths (packages/tracker/src/errors.ts), and the
 * database checks the same (migration 0018).
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
  },
} as const;

interface EventBatch {
  /** Version of this request format. */
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

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const MAX_TIMESTAMP = 8_640_000_000_000_000; // The largest date JavaScript can represent.

/** An event name: 1 to 200 characters, no control characters. */
export const EVENT_NAME_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  pattern: "^[^\\u0000-\\u001F\\u007F]+$",
} as const;

/** Custom details: a flat object of at most 30 values. */
export const PROPERTIES_SCHEMA = {
  type: "object",
  maxProperties: 30,
  propertyNames: { minLength: 1, maxLength: 100 },
  additionalProperties: {
    type: ["string", "number", "boolean", "null"],
    maxLength: 500,
  },
} as const;

// Fastify validates every request against this before the handler runs.
// Unknown fields are removed rather than rejected, so an older server
// accepts batches from a newer tracker.
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
    // The same for every event of the batch: one page runs in one environment and release.
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
        },
      },
    },
  },
} as const;

const storedResponseSchema = {
  type: "object",
  required: ["stored", "duplicates", "tooOld", "bots"],
  additionalProperties: false,
  properties: {
    stored: { type: "integer" },
    duplicates: { type: "integer" },
    tooOld: { type: "integer" },
    bots: { type: "integer" },
    // Events whose user ID lacked a valid signature, stored without it.
    unverifiedUsers: { type: "integer" },
  },
} as const;

function problem(code: string, message: string) {
  return { error: code, message };
}

function tooManyRequests(reply: FastifyReply, retryAfterSeconds: number) {
  return reply
    .code(429)
    .header("retry-after", String(retryAfterSeconds))
    .send(problem("rate_limited", `Too many requests. Retry after ${retryAfterSeconds} seconds.`));
}

/** PostgreSQL's foreign_key_violation: here, events for a project that no longer exists. */
function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23503";
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
 * 3. Project key (cached).
 * 4. Origin header and page hostnames against the project's allowed hostnames.
 * 5. Event budget per project.
 * 6. URL cleanup and clock correction.
 * 7. One INSERT. 202 is sent only after PostgreSQL commits it.
 */
export const collectionRoutes: FastifyPluginCallback<CollectionOptions> = (app, options, done) => {
  const { db, locate = noLocation, isDataCenter = noDataCenters, now = Date.now } = options;
  // Projects whose events were ignored as coming from a data center, logged
  // once each: a site that forwards its events through its own server in a
  // cloud would otherwise lose them all without a trace.
  const dataCenterProjects = new Set<string>();
  const projectLimit = options.projectLimit ?? DEFAULT_PROJECT_LIMIT;
  const organizationLimit = options.organizationLimit ?? DEFAULT_ORGANIZATION_LIMIT;
  if (Math.min(projectLimit.capacity, organizationLimit.capacity) < MAX_EVENTS_PER_BATCH) {
    // Plugins report setup errors through done(); app.ready() then rejects.
    done(
      new Error(
        `The project and organization limits must allow a full batch of ${MAX_EVENTS_PER_BATCH} events`,
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
    stopSaltCleanup();
  });
  const ipLimiter = new TokenBucketLimiter(options.ipLimit ?? DEFAULT_IP_LIMIT, { now });
  const budget = new EventBudget(
    new TokenBucketLimiter(projectLimit, { now }),
    new TokenBucketLimiter(organizationLimit, { now }),
  );
  const projects = options.projectKeys ?? new ProjectKeyCache(db, { now });

  // Browsers send the batch as text/plain: that is a "simple" cross-site
  // request, so the browser sends it directly instead of first asking
  // permission with an OPTIONS (preflight) request. The body is still JSON.
  // This parser only applies to routes in this plugin.
  app.addContentTypeParser(
    "text/plain",
    { parseAs: "string", bodyLimit: MAX_BODY_BYTES },
    (_request, body, parsed) => {
      try {
        parsed(null, JSON.parse(String(body)));
      } catch {
        parsed(Object.assign(new Error("The body is not valid JSON"), { statusCode: 400 }));
      }
    },
  );

  // Every response, including errors and rate limits, lets the sending page
  // read it: the tracker needs the status to know whether retrying can help.
  // Without this header the browser hides a 403 or 429, and the tracker would
  // see a network failure and retry a request that can never succeed. Safe
  // because the endpoint uses no cookies or credentials and its responses
  // hold nothing private. Origin checks still decide what is accepted.
  // Retry-After must be exposed too: it is not one of the headers a browser
  // shows a cross-site page by default, and the tracker waits as it says.
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
      schema: { body: eventBatchSchema, response: { 202: storedResponseSchema } },
      // Runs before the body is read: the cheapest way to turn a flood away.
      onRequest: async (request, reply) => {
        const result = ipLimiter.take(request.ip);
        return result.allowed ? undefined : tooManyRequests(reply, result.retryAfterSeconds);
      },
    },
    async (request, reply) => {
      const receivedAt = now();
      const { key, sentAt, events } = request.body;

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

      // Browsers always send Origin on cross-site POSTs, and pages cannot
      // change it. Servers and scripts may leave it out or set anything, so
      // this filters misuse from other websites; it is not authentication.
      const origin = request.headers.origin;
      if (origin !== undefined) {
        const hostname = originHostname(origin);
        if (hostname === null || !isAllowedHostname(hostname, project.allowedHostnames)) {
          return reply
            .code(403)
            .send(problem("origin_not_allowed", "This site may not send events to this project."));
        }
      }

      // Checked before the budget below: a bad request costs nothing.
      const environment = environmentOf(request.body.environment);
      const { release } = request.body;
      if (release !== undefined && !isStorableText(release)) {
        return reply
          .code(400)
          .send(
            problem(
              "invalid_request",
              "release contains an unpaired surrogate, which cannot be stored.",
            ),
          );
      }

      // Bots are accepted and ignored: an error would only invite retries.
      // They are checked before the budget, so they cannot use it up. A
      // "browser" at a cloud provider's address is nearly always a program
      // too; the address is checked here and, as ever, never stored.
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
        return reply.code(202).send({ stored: 0, duplicates: 0, tooOld: 0, bots: events.length });
      }

      const spent = budget.take(project, events.length);
      if (!spent.allowed) {
        return tooManyRequests(reply, spent.retryAfterSeconds);
      }

      // Every event in a request comes from the same browser and address. The
      // IP address is used for the location lookup here and then dropped:
      // it is never stored or logged.
      const client = parseUserAgent(userAgent ?? "", { touch: request.body.touch === true });
      const location = locate(request);

      const accepted: NewEvent[] = [];
      let tooOld = 0;
      let unverifiedUsers = 0;
      for (const [index, event] of events.entries()) {
        const page = parsePageUrl(event.url);
        if (page === null) {
          return reply
            .code(400)
            .send(problem("invalid_request", `events[${index}].url is not a valid http(s) URL.`));
        }
        if (!isAllowedHostname(page.hostname, project.allowedHostnames)) {
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
          return reply
            .code(400)
            .send(
              problem(
                "invalid_request",
                `events[${index}].userId contains an unpaired surrogate, which cannot be stored.`,
              ),
            );
        }
        if (!isStorableText(event.name)) {
          return reply
            .code(400)
            .send(
              problem(
                "invalid_request",
                `events[${index}].name contains an unpaired surrogate, which cannot be stored.`,
              ),
            );
        }
        if (
          event.properties !== undefined &&
          Object.entries(event.properties).some(
            ([name, value]) =>
              !isStorableText(name) || (typeof value === "string" && !isStorableText(value)),
          )
        ) {
          return reply
            .code(400)
            .send(
              problem(
                "invalid_request",
                `events[${index}].properties contains a NUL character or an unpaired surrogate, which cannot be stored.`,
              ),
            );
        }
        if (
          event.properties !== undefined &&
          Buffer.byteLength(JSON.stringify(event.properties)) > MAX_PROPERTIES_BYTES
        ) {
          return reply
            .code(400)
            .send(
              problem(
                "invalid_request",
                `events[${index}].properties is larger than ${MAX_PROPERTIES_BYTES} bytes.`,
              ),
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
            return reply
              .code(400)
              .send(
                problem(
                  "invalid_request",
                  `events[${index}] is an engagement event: properties.engagedMs must be a whole number of milliseconds, at most 24 hours.`,
                ),
              );
          }
        }
        // A page load's Web Vitals: only the values a page load can have.
        if (event.name === VITALS && event.properties !== undefined) {
          keepValidVitals(event.properties);
        }

        // An error is an event named "error" with its details. One without
        // them is a custom event, as before errors existed: an older tracker
        // in a browser's cache may still send one, and refusing it would
        // lose its whole batch.
        if (event.error !== undefined && event.name !== ERROR) {
          return reply
            .code(400)
            .send(
              problem(
                "invalid_request",
                `events[${index}].error is only for events named "error".`,
              ),
            );
        }
        if (
          event.error !== undefined &&
          ![event.error.type, event.error.message, event.error.stack ?? ""].every(isStorableText)
        ) {
          return reply
            .code(400)
            .send(
              problem(
                "invalid_request",
                `events[${index}].error contains an unpaired surrogate, which cannot be stored.`,
              ),
            );
        }

        const occurredAt = correctClock(event.occurredAt, sentAt, receivedAt);
        if (occurredAt === null) {
          tooOld += 1;
          continue;
        }
        // A project that requires signed user IDs keeps an unsigned or
        // wrongly signed one out, and the event anonymous: only the site's
        // server can name a user.
        let { userId } = event;
        if (
          userId !== undefined &&
          project.requireSignedUserIds &&
          !isSignedUserId(project.secretKey, userId, event.userSignature)
        ) {
          userId = undefined;
          unverifiedUsers += 1;
        }
        accepted.push({
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
                },
              }),
        });
      }

      let result: Awaited<ReturnType<typeof storeEvents>>;
      try {
        // Each event gets the visitor ID of the day it happened, so a late
        // event from just before midnight joins the rest of that day's visit.
        for (const event of accepted) {
          event.visitorId = await visitors.idFor({
            projectId: project.id,
            timeZone: project.timeZone,
            ip: request.ip,
            userAgent: userAgent ?? "",
            occurredAt: event.occurredAt,
          });
        }
        result = await storeEvents(db, project.id, accepted);
      } catch (error) {
        // The project was deleted after its key was looked up (another API
        // process, or a moment's race): the key is gone, not the storage.
        if (isForeignKeyViolation(error)) {
          projects.forget(key);
          return reply.code(403).send(problem("unknown_key", "No project has this key."));
        }
        request.log.error({ err: error }, "could not store events");
        return storageUnavailable(reply);
      }
      return reply.code(202).send({
        stored: result.inserted,
        duplicates: result.duplicates,
        tooOld,
        bots: 0,
        unverifiedUsers,
      });
    },
  );

  serverEventsRoute(app, {
    db,
    projects,
    budget,
    ipLimiter: new TokenBucketLimiter(options.serverIpLimit ?? DEFAULT_SERVER_IP_LIMIT, { now }),
    maxEvents: MAX_EVENTS_PER_BATCH,
    maxBodyBytes: MAX_BODY_BYTES,
    maxPropertiesBytes: MAX_PROPERTIES_BYTES,
    schemas: { name: EVENT_NAME_SCHEMA, properties: PROPERTIES_SCHEMA },
    now,
  });

  done();
};
