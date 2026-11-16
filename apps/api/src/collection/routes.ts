import { Buffer } from "node:buffer";

import type { FastifyError, FastifyPluginCallback, FastifyReply } from "fastify";
import type { Kysely } from "kysely";

import type { Database } from "../db/schema.ts";
import { type Locate, noLocation } from "../enrichment/geo.ts";
import { isBot, parseUserAgent } from "../enrichment/user-agent.ts";
import { VisitorIds } from "../visitors/visitor-ids.ts";
import { type NewEvent, storeEvents } from "./event-store.ts";
import {
  cleanReferrer,
  correctClock,
  isAllowedHostname,
  originHostname,
  parsePageUrl,
} from "./normalize.ts";
import { type CollectingProject, ProjectKeyCache, PUBLIC_KEY_PATTERN } from "./project-keys.ts";
import { type RateLimit, TokenBucketLimiter } from "./rate-limiter.ts";

export const MAX_EVENTS_PER_BATCH = 50;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_PROPERTIES_BYTES = 8 * 1024;

/** Requests per client IP address: bursts of 120, then 2 per second. */
export const DEFAULT_IP_LIMIT: RateLimit = { capacity: 120, refillPerSecond: 2 };
/** Events per project: bursts of 2,000, then 200 per second. */
export const DEFAULT_PROJECT_LIMIT: RateLimit = { capacity: 2_000, refillPerSecond: 200 };

export interface CollectionOptions {
  db: Kysely<Database>;
  ipLimit?: RateLimit;
  projectLimit?: RateLimit;
  /** Finds the visitor's location from the request. Default: no location. */
  locate?: Locate;
  /** IANA timezone whose midnight starts a new visitor salt. Default: UTC. */
  timeZone?: string;
  /** Clock, replaceable in tests. */
  now?: () => number;
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
}

interface EventBatch {
  /** Version of this request format. */
  v: 1;
  key: string;
  /** When the batch was sent, in milliseconds since 1970, by the sender's clock. */
  sentAt: number;
  events: IncomingEvent[];
}

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const MAX_TIMESTAMP = 8_640_000_000_000_000; // The largest date JavaScript can represent.

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
          // 1 to 200 characters, no control characters.
          name: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            pattern: "^[^\\u0000-\\u001F\\u007F]+$",
          },
          occurredAt: { type: "integer", minimum: 0, maximum: MAX_TIMESTAMP },
          url: { type: "string", minLength: 1, maxLength: 8192 },
          referrer: { type: "string", maxLength: 8192 },
          properties: {
            type: "object",
            maxProperties: 30,
            propertyNames: { minLength: 1, maxLength: 100 },
            additionalProperties: {
              type: ["string", "number", "boolean", "null"],
              maxLength: 500,
            },
          },
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
  const { db, locate = noLocation, now = Date.now } = options;
  const projectLimit = options.projectLimit ?? DEFAULT_PROJECT_LIMIT;
  if (projectLimit.capacity < MAX_EVENTS_PER_BATCH) {
    // Plugins report setup errors through done(); app.ready() then rejects.
    done(new Error(`The project limit must allow a full batch of ${MAX_EVENTS_PER_BATCH} events`));
    return;
  }
  const visitors = new VisitorIds(db, { timeZone: options.timeZone ?? "UTC", now });
  const ipLimiter = new TokenBucketLimiter(options.ipLimit ?? DEFAULT_IP_LIMIT, { now });
  const projectLimiter = new TokenBucketLimiter(projectLimit, { now });
  const projects = new ProjectKeyCache(db, { now });

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
  app.addHook("onSend", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin !== undefined) {
      reply.header("access-control-allow-origin", origin).header("vary", "Origin");
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

      // Bots are accepted and ignored: an error would only invite retries.
      // They are checked before the budget, so they cannot use it up.
      const userAgent = request.headers["user-agent"];
      if (isBot(userAgent)) {
        return reply.code(202).send({ stored: 0, duplicates: 0, tooOld: 0, bots: events.length });
      }

      const budget = projectLimiter.take(project.id, events.length);
      if (!budget.allowed) {
        return tooManyRequests(reply, budget.retryAfterSeconds);
      }

      // Every event in a request comes from the same browser and address. The
      // IP address is used for the location lookup here and then dropped:
      // it is never stored or logged.
      const client = parseUserAgent(userAgent ?? "");
      const location = locate(request);

      const accepted: NewEvent[] = [];
      let tooOld = 0;
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

        const occurredAt = correctClock(event.occurredAt, sentAt, receivedAt);
        if (occurredAt === null) {
          tooOld += 1;
          continue;
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
        });
      }

      let result: Awaited<ReturnType<typeof storeEvents>>;
      try {
        // Each event gets the visitor ID of the day it happened, so a late
        // event from just before midnight joins the rest of that day's visit.
        for (const event of accepted) {
          event.visitorId = await visitors.idFor({
            projectId: project.id,
            ip: request.ip,
            userAgent: userAgent ?? "",
            occurredAt: event.occurredAt,
          });
        }
        result = await storeEvents(db, project.id, accepted);
      } catch (error) {
        request.log.error({ err: error }, "could not store events");
        return storageUnavailable(reply);
      }
      return reply
        .code(202)
        .send({ stored: result.inserted, duplicates: result.duplicates, tooOld, bots: 0 });
    },
  );

  done();
};
