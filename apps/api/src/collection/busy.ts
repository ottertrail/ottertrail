import type { FastifyReply } from "fastify";

/**
 * Bounds in-memory event requests while ClickHouse is slow (in-flight.ts). Excess requests get 503
 * per process or 429 per project.
 */
export const DEFAULT_MAX_EVENTS_IN_FLIGHT = 256;
export const DEFAULT_MAX_EVENTS_IN_FLIGHT_PER_PROJECT = 64;

/** Shortens ClickHouse's default 120-second insert wait so trackers get retryable 503s sooner. */
export const INSERT_WAIT_SECONDS = 10;

export function tooBusy(reply: FastifyReply) {
  return reply
    .code(503)
    .header("retry-after", "1")
    .send({ error: "busy", message: "Too many requests are in progress. Retry after 1 second." });
}

export function projectTooBusy(reply: FastifyReply) {
  return reply.code(429).header("retry-after", "1").send({
    error: "rate_limited",
    message: "Too many of this project's requests are in progress. Retry after 1 second.",
  });
}
