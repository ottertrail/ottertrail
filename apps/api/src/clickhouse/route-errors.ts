import { ClickHouseError } from "@clickhouse/client";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

import { DashboardBusyError } from "../telemetry/dashboard-limit.ts";

/**
 * Keep database error details in logs because they can expose server details.
 * Validation errors keep Fastify's response.
 */
export function clickHouseErrorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if ((error.statusCode ?? 500) < 500) {
    throw error;
  }
  if (error instanceof DashboardBusyError) {
    request.log.warn("a dashboard query waited too long for a place");
    return reply.code(503).header("retry-after", "10").send({
      error: "reports_busy",
      message: "Dashboard pages reached the query limit. Try again in a few seconds.",
    });
  }
  if (request.raw.destroyed || (error instanceof Error && error.name === "AbortError")) {
    // The client disconnected, so no one can read the response.
    request.log.info("a report's request was closed before it was answered");
    return reply.code(499).send({ error: "closed", message: "The request was closed." });
  }
  if (error instanceof ClickHouseError && error.type === "MEMORY_LIMIT_EXCEEDED") {
    request.log.warn({ err: error }, "a report ran out of memory");
    return reply.code(503).header("retry-after", "60").send({
      error: "reports_busy",
      message:
        "This report exceeded its memory limit. Shorten the range, narrow the filters, or try again in a minute.",
    });
  }
  if (error instanceof ClickHouseError && error.type === "TIMEOUT_EXCEEDED") {
    request.log.warn({ err: error }, "a report took too long");
    return reply.code(503).header("retry-after", "60").send({
      error: "reports_busy",
      message: "The calculation took too long. Try a shorter range or narrower filters.",
    });
  }
  request.log.error({ err: error }, "a report failed");
  return reply.code(500).send({
    error: "internal_error",
    message: "The reports could not be calculated. Try again.",
  });
}
