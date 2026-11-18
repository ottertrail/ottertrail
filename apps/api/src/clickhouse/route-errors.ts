import { ClickHouseError } from "@clickhouse/client";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

import { DashboardBusyError } from "../telemetry/dashboard-limit.ts";

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
  if (error instanceof DashboardBusyError) {
    // The organization's pages already run as many queries as they may (telemetry's dashboard).
    request.log.warn("an organization's dashboard queries waited too long for a place");
    return reply.code(503).header("retry-after", "10").send({
      error: "reports_busy",
      message:
        "Your organization's pages are already running as many queries as they may. Try again in a few seconds.",
    });
  }
  if (request.raw.destroyed || (error instanceof Error && error.name === "AbortError")) {
    // The browser gave up on the request, and its query was ended: no one reads the answer.
    request.log.info("a report's request was closed before it was answered");
    return reply.code(499).send({ error: "closed", message: "The request was closed." });
  }
  if (error instanceof ClickHouseError && error.type === "MEMORY_LIMIT_EXCEEDED") {
    // The server's memory, or a query's own limit (telemetry's dashboard sets max_memory_usage).
    request.log.warn({ err: error }, "a report ran out of memory");
    return reply.code(503).header("retry-after", "60").send({
      error: "reports_busy",
      message:
        "This needs more memory than a report may use now. Try a shorter range or narrower filters, or try again in a minute.",
    });
  }
  if (error instanceof ClickHouseError && error.type === "TIMEOUT_EXCEEDED") {
    // A query past its max_execution_time (telemetry's dashboard queries set one).
    request.log.warn({ err: error }, "a report took too long");
    return reply.code(503).header("retry-after", "60").send({
      error: "reports_busy",
      message: "This took too long to work out. Try a shorter range or narrower filters.",
    });
  }
  request.log.error({ err: error }, "a report failed");
  return reply.code(500).send({
    error: "internal_error",
    message: "The reports could not be worked out. Try again.",
  });
}
