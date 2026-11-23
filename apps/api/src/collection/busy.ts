import type { FastifyReply } from "fastify";

/**
 * Event requests, browsers' and servers' together, one API process works on
 * at once, and of those one project's (in-flight.ts). They bound what piles
 * up in memory while ClickHouse is slow: past them, 503 or 429 at once.
 */
export const DEFAULT_MAX_EVENTS_IN_FLIGHT = 256;
export const DEFAULT_MAX_EVENTS_IN_FLIGHT_PER_PROJECT = 64;

/**
 * How long ClickHouse may take to write a batch of events or heatmap
 * records before it answers an error, and the request 503, which the
 * tracker retries. Its default is 120 seconds.
 */
export const INSERT_WAIT_SECONDS = 10;

/** Past the process's requests in progress (in-flight.ts). */
export function tooBusy(reply: FastifyReply) {
  return reply
    .code(503)
    .header("retry-after", "1")
    .send({ error: "busy", message: "Too many requests are in progress. Retry after 1 second." });
}

/** Past one project's requests in progress. */
export function projectTooBusy(reply: FastifyReply) {
  return reply.code(429).header("retry-after", "1").send({
    error: "rate_limited",
    message: "Too many of this project's requests are in progress. Retry after 1 second.",
  });
}
