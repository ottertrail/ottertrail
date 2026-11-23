import type { FastifyPluginCallback } from "fastify";

const healthResponseSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok"] },
  },
  required: ["status"],
  additionalProperties: false,
} as const;

/** Checks only whether the API accepts requests. */
export const healthRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.get("/health", { schema: { response: { 200: healthResponseSchema } } }, async () => ({
    status: "ok" as const,
  }));
  done();
};
