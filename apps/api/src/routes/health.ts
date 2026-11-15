import type { FastifyPluginCallback } from "fastify";

const healthResponseSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok"] },
  },
  required: ["status"],
  additionalProperties: false,
} as const;

/**
 * Liveness check: reports that the API process is accepting requests.
 * It does not check PostgreSQL or the job queue; those do not exist yet.
 */
export const healthRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.get("/health", { schema: { response: { 200: healthResponseSchema } } }, async () => ({
    status: "ok" as const,
  }));
  done();
};
