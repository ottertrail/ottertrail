import { Buffer } from "node:buffer";

import type { FastifyInstance, FastifyReply } from "fastify";
import type { Kysely } from "kysely";

import type { Database } from "../db/schema.ts";
import { ENGAGEMENT, PAGEVIEW, VITALS } from "../visits/visits.ts";
import { ENVIRONMENT_PATTERN, environmentOf, RELEASE_PATTERN } from "./environment.ts";
import { type NewEvent, storeEvents } from "./event-store.ts";
import { USER_ID_PATTERN } from "./identity.ts";
import { isStorableText, MAX_EVENT_AGE_MS } from "./normalize.ts";
import type { ProjectKeyCache } from "./project-keys.ts";
import type { EventBudget, RateLimit, TokenBucketLimiter } from "./rate-limiter.ts";

/**
 * Requests per IP address to the server endpoint: a site's server sends
 * often, from few addresses, so far more than a browser; the limit only
 * bounds made-up keys, each of which costs a database lookup.
 */
export const DEFAULT_SERVER_IP_LIMIT: RateLimit = { capacity: 600, refillPerSecond: 50 };

/** How far ahead of the server's clock an event may be: a few minutes of clock drift. */
const MAX_FUTURE_MS = 5 * 60 * 1000;

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const BEARER = /^Bearer (sk_[0-9a-f]{32})$/;

type PropertyValue = string | number | boolean | null;

interface ServerEvent {
  id: string;
  name: string;
  /** When it happened, in milliseconds since 1970: the server's clock is trusted. */
  occurredAt: number;
  /** The site's own ID for the user: every server-side event belongs to one. */
  userId: string;
  /** The page it relates to, if any, such as "/checkout". */
  path?: string;
  properties?: Record<string, PropertyValue>;
}

interface ServerBatch {
  v: 1;
  environment?: string;
  release?: string;
  events: ServerEvent[];
}

function problem(code: string, message: string) {
  return { error: code, message };
}

function storageUnavailable(reply: FastifyReply) {
  return reply
    .code(503)
    .header("retry-after", "5")
    .send(problem("storage_unavailable", "Events were not stored. Retry later."));
}

/**
 * POST /server-events: events a site's own server sends, authenticated by
 * the project's secret key (Authorization: Bearer sk_…), such as a payment
 * or a cancelled subscription. A browser cannot block or fake them, so they
 * need no Origin, hostname, or bot check, and a user ID needs no signature.
 * They belong to a user and to no visitor: they show in the user's
 * activity, not in web analytics, which counts what browsers send.
 *
 * The rest is as for browsers: a schema check before any database work,
 * the project's event budget, each event ID stored once, and 202 only
 * after PostgreSQL commits.
 */
export function serverEventsRoute(
  app: FastifyInstance,
  options: {
    db: Kysely<Database>;
    projects: ProjectKeyCache;
    /** Shared with browser events: one budget per project, inside its organization's. */
    budget: EventBudget;
    ipLimiter: TokenBucketLimiter;
    maxEvents: number;
    maxBodyBytes: number;
    maxPropertiesBytes: number;
    schemas: { name: object; properties: object };
    now: () => number;
  },
) {
  const { db, projects, budget, ipLimiter, maxEvents, maxBodyBytes, maxPropertiesBytes, now } =
    options;

  app.post<{ Body: ServerBatch }>(
    "/server-events",
    {
      bodyLimit: maxBodyBytes,
      schema: {
        body: {
          type: "object",
          required: ["v", "events"],
          additionalProperties: false,
          properties: {
            v: { const: 1 },
            environment: { type: "string", pattern: ENVIRONMENT_PATTERN },
            release: { type: "string", maxLength: 200, pattern: RELEASE_PATTERN },
            events: {
              type: "array",
              minItems: 1,
              maxItems: maxEvents,
              items: {
                type: "object",
                required: ["id", "name", "occurredAt", "userId"],
                additionalProperties: false,
                properties: {
                  id: { type: "string", pattern: UUID_PATTERN },
                  name: options.schemas.name,
                  occurredAt: { type: "integer", minimum: 0, maximum: 8_640_000_000_000_000 },
                  userId: { type: "string", maxLength: 200, pattern: USER_ID_PATTERN },
                  // A path, without a query or fragment.
                  path: { type: "string", minLength: 1, maxLength: 2048, pattern: "^/[^?#]*$" },
                  properties: options.schemas.properties,
                },
              },
            },
          },
        },
      },
      // Before the body is read: a request without a well-formed key, or a
      // flood from one address, costs nothing more.
      onRequest: async (request, reply) => {
        if (!BEARER.test(request.headers.authorization ?? "")) {
          return reply
            .code(401)
            .send(
              problem("unauthorized", "Send the project's secret key: Authorization: Bearer sk_…"),
            );
        }
        const result = ipLimiter.take(request.ip);
        if (!result.allowed) {
          return reply
            .code(429)
            .header("retry-after", String(result.retryAfterSeconds))
            .send(problem("rate_limited", "Too many requests from this address."));
        }
        return undefined;
      },
    },
    async (request, reply) => {
      const secretKey = BEARER.exec(request.headers.authorization ?? "")?.[1] ?? "";
      let project;
      try {
        project = await projects.findBySecret(secretKey);
      } catch (error) {
        request.log.error({ err: error }, "could not look up the secret key");
        return storageUnavailable(reply);
      }
      if (project === null) {
        return reply.code(401).send(problem("unknown_key", "No project has this secret key."));
      }

      const receivedAt = now();
      const environment = environmentOf(request.body.environment);
      const { release } = request.body;
      if (release !== undefined && !isStorableText(release)) {
        return reply
          .code(400)
          .send(problem("invalid_request", "release contains an unpaired surrogate."));
      }
      const accepted: NewEvent[] = [];
      let tooOld = 0;
      for (const [index, event] of request.body.events.entries()) {
        if (event.name === PAGEVIEW || event.name === ENGAGEMENT || event.name === VITALS) {
          return reply
            .code(400)
            .send(
              problem(
                "invalid_request",
                `events[${index}].name: "${event.name}" is sent by the browser tracker only.`,
              ),
            );
        }
        const texts = [
          event.name,
          event.userId,
          event.path ?? "",
          ...Object.entries(event.properties ?? {}).flatMap(([name, value]) =>
            typeof value === "string" ? [name, value] : [name],
          ),
        ];
        if (!texts.every(isStorableText)) {
          return reply
            .code(400)
            .send(
              problem(
                "invalid_request",
                `events[${index}] contains a NUL character or an unpaired surrogate, which cannot be stored.`,
              ),
            );
        }
        if (
          event.properties !== undefined &&
          Buffer.byteLength(JSON.stringify(event.properties)) > maxPropertiesBytes
        ) {
          return reply
            .code(400)
            .send(
              problem(
                "invalid_request",
                `events[${index}].properties is larger than ${maxPropertiesBytes} bytes.`,
              ),
            );
        }
        if (event.occurredAt > receivedAt + MAX_FUTURE_MS) {
          return reply
            .code(400)
            .send(
              problem(
                "invalid_request",
                `events[${index}].occurredAt is in the future: check the server's clock.`,
              ),
            );
        }
        if (receivedAt - event.occurredAt > MAX_EVENT_AGE_MS) {
          tooOld += 1;
          continue;
        }
        accepted.push({
          eventId: event.id,
          name: event.name,
          occurredAt: new Date(event.occurredAt),
          ...(event.path === undefined ? {} : { path: event.path }),
          ...(event.properties === undefined ? {} : { properties: event.properties }),
          userId: event.userId,
          environment,
          ...(release === undefined ? {} : { release }),
        });
      }

      const spent = budget.take(project, accepted.length);
      if (!spent.allowed) {
        return reply
          .code(429)
          .header("retry-after", String(spent.retryAfterSeconds))
          .send(
            problem(
              "rate_limited",
              `Too many events. Retry after ${spent.retryAfterSeconds} seconds.`,
            ),
          );
      }
      try {
        const result = await storeEvents(db, project.id, accepted);
        return await reply
          .code(202)
          .send({ stored: result.inserted, duplicates: result.duplicates, tooOld });
      } catch (error) {
        // The project was deleted after its key was looked up.
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "23503"
        ) {
          projects.forgetProject(project.id);
          return reply.code(401).send(problem("unknown_key", "No project has this secret key."));
        }
        request.log.error({ err: error }, "could not store server events");
        return storageUnavailable(reply);
      }
    },
  );
}
