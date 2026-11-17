import { ClickHouseError } from "@clickhouse/client";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

/**
 * The error handler of routes that read ClickHouse (reports, users). A
 * database's error text stays in the log: it can name servers, settings,
 * and versions. A bad request (validation) keeps Fastify's own answer,
 * which names the problem.
 */
export function clickHouseErrorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if ((error.statusCode ?? 500) < 500) {
    throw error;
  }
  if (error instanceof ClickHouseError && error.type === "MEMORY_LIMIT_EXCEEDED") {
    request.log.warn({ err: error }, "a report ran out of memory");
    return reply.code(503).header("retry-after", "60").send({
      error: "reports_busy",
      message:
        "These reports need more memory than the server has free now. Try a shorter range, or try again in a minute.",
    });
  }
  request.log.error({ err: error }, "a report failed");
  return reply.code(500).send({
    error: "internal_error",
    message: "The reports could not be worked out. Try again.",
  });
}
