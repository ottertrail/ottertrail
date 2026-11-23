import { Buffer } from "node:buffer";

import type { FastifyInstance, FastifyReply } from "fastify";

import type { IngestActivity } from "../activity/activity.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { ENGAGEMENT, PAGEVIEW, VITALS } from "../visits/visits.ts";
import { ENVIRONMENT_PATTERN, environmentOf, RELEASE_PATTERN } from "./environment.ts";
import { type NewEvent, storeEvents } from "./event-store.ts";
import { USER_ID_PATTERN } from "./identity.ts";
import type { LastEventRecorder } from "./last-event.ts";
import { isStorableText, MAX_EVENT_AGE_MS } from "./normalize.ts";
import type { ProjectKeyCache } from "./project-keys.ts";
import type { ClientRateLimiter, EventBudget, RateLimit } from "./rate-limiter.ts";

/**
 * Site servers send frequently from few addresses. This higher IP limit bounds
 * database lookups for made-up keys.
 */
export const DEFAULT_SERVER_IP_LIMIT: RateLimit = { capacity: 600, refillPerSecond: 50 };

/** How far ahead of the server's clock an event may be: a few minutes of clock drift. */
export const MAX_FUTURE_MS = 5 * 60 * 1000;

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
 * Authenticated by the project secret key (Authorization: Bearer sk_…).
 * No Origin, hostname, bot, or user-signature checks are needed. Events belong
 * to users and have no visitor ID, so web analytics excludes them.
 * Schema validation precedes database work; the shared event budget applies.
 * Retries keep the sender's timestamp (event-store.ts). Acknowledge only after
 * ClickHouse writes; a storage failure returns 503.
 */
export function serverEventsRoute(
  app: FastifyInstance,
  options: {
    clickhouse: ClickHouseClient;
    projects: ProjectKeyCache;
    activity: IngestActivity;
    /** Shared with browser events (last-event.ts). */
    lastEvents: LastEventRecorder;
    /** Shared with browser events: one budget per project, inside the instance's. */
    budget: EventBudget;
    ipLimiter: ClientRateLimiter;
    maxEvents: number;
    maxBodyBytes: number;
    maxPropertiesBytes: number;
    schemas: { name: object; properties: object };
    now: () => number;
  },
) {
  const {
    clickhouse,
    projects,
    lastEvents,
    budget,
    ipLimiter,
    maxEvents,
    maxBodyBytes,
    maxPropertiesBytes,
    now,
    activity,
  } = options;

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
      const projectId = project.id;
      const invalid = (message: string) => {
        activity.add(projectId, "server_events", "refused_invalid");
        return reply.code(400).send(problem("invalid_request", message));
      };

      const receivedAt = now();
      const environment = environmentOf(request.body.environment);
      const { release } = request.body;
      if (release !== undefined && !isStorableText(release)) {
        return invalid("release contains an unpaired surrogate.");
      }
      const accepted: NewEvent[] = [];
      let tooOld = 0;
      for (const [index, event] of request.body.events.entries()) {
        if (event.name === PAGEVIEW || event.name === ENGAGEMENT || event.name === VITALS) {
          return invalid(
            `events[${index}].name: "${event.name}" is sent by the browser tracker only.`,
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
          return invalid(
            `events[${index}] contains a NUL character or an unpaired surrogate, which cannot be stored.`,
          );
        }
        if (
          event.properties !== undefined &&
          Buffer.byteLength(JSON.stringify(event.properties)) > maxPropertiesBytes
        ) {
          return invalid(`events[${index}].properties is larger than ${maxPropertiesBytes} bytes.`);
        }
        if (event.occurredAt > receivedAt + MAX_FUTURE_MS) {
          return invalid(`events[${index}].occurredAt is in the future: check the server's clock.`);
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

      const spent = budget.take(project.id, accepted.length);
      if (!spent.allowed) {
        activity.add(
          projectId,
          "server_events",
          spent.limit === "instance" ? "refused_volume" : "refused_rate_limited",
        );
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
        await storeEvents(clickhouse, project.id, accepted, { receivedAt: new Date(receivedAt) });
      } catch (error) {
        // Refund storage failures so retries retain their budget.
        budget.refund(project.id, accepted.length);
        request.log.error({ err: error }, "could not store server events");
        activity.add(projectId, "server_events", "refused_unavailable");
        return storageUnavailable(reply);
      }
      if (accepted.length > 0) {
        activity.add(projectId, "server_events", "accepted", accepted.length);
      }
      if (tooOld > 0) activity.add(projectId, "server_events", "filtered_too_old", tooOld);
      // PostgreSQL bookkeeping must not delay or fail an already stored batch.
      lastEvents.record(project.id, accepted).catch((error: unknown) => {
        request.log.warn({ err: error }, "could not record the project's latest event");
      });
      return reply.code(202).send({ stored: accepted.length, tooOld });
    },
  );
}
