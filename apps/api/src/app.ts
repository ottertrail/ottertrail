import Fastify, { type FastifyServerOptions } from "fastify";
import type { Kysely } from "kysely";

import { type CollectionOptions, collectionRoutes } from "./collection/routes.ts";
import type { Database } from "./db/schema.ts";
import { healthRoutes } from "./routes/health.ts";

export interface AppOptions extends Omit<FastifyServerOptions, "logger"> {
  db: Kysely<Database>;
  /** Rate limits, location lookup, and clock for the collection endpoint. */
  collection?: Omit<CollectionOptions, "db">;
  /** Logging; off when omitted. Tests pass a stream to read the log. */
  log?: { level: string; stream?: { write(line: string): void } };
}

/**
 * What a request log line records about a request: method and URL only.
 * Fastify's default also records the client's IP address and port, and an
 * IP address is personal data that Ottertrail never keeps.
 */
export function requestLogFields(request: { method: string; url: string }) {
  return { method: request.method, url: request.url };
}

export function buildApp({ db, collection = {}, log, ...fastifyOptions }: AppOptions) {
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
  app.register(collectionRoutes, { prefix: "/api", db, ...collection });
  return app;
}
