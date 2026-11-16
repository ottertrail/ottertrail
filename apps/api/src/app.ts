import Fastify, { type FastifyServerOptions } from "fastify";
import type { Kysely } from "kysely";

import { type CollectionOptions, collectionRoutes } from "./collection/routes.ts";
import type { Database } from "./db/schema.ts";
import { healthRoutes } from "./routes/health.ts";

export interface AppOptions extends FastifyServerOptions {
  db: Kysely<Database>;
  /** Rate limits and clock for the collection endpoint; tests override them. */
  collection?: Omit<CollectionOptions, "db">;
}

export function buildApp({ db, collection = {}, ...fastifyOptions }: AppOptions) {
  const app = Fastify(fastifyOptions);
  app.register(healthRoutes, { prefix: "/api" });
  app.register(collectionRoutes, { prefix: "/api", db, ...collection });
  return app;
}
