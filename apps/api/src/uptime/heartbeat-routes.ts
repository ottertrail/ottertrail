import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import {
  ClientRateLimiter,
  type RateLimit,
  TokenBucketLimiter,
} from "../collection/rate-limiter.ts";
import type { Database } from "../db/schema.ts";
import type { StateChange } from "./checks.ts";
import { findPinged, recordPing, TOKEN_PATTERN } from "./heartbeats.ts";

/**
 * Pings per client address, an IPv6 address by its /64: a burst of 60,
 * then one a second. A server running many jobs pings from one address.
 */
export const PING_IP_LIMIT: RateLimit = { capacity: 60, refillPerSecond: 1 };
/** Pings per heartbeat: a burst of 10, then one every 6 seconds. */
export const PING_CHECK_LIMIT: RateLimit = { capacity: 10, refillPerSecond: 1 / 6 };

/** A short plain-text answer, never cached. */
const answer = (reply: FastifyReply, status: number, text: string) =>
  reply
    .code(status)
    .header("cache-control", "no-store")
    .type("text/plain; charset=utf-8")
    .send(`${text}\n`);

const tooMany = (reply: FastifyReply, retryAfterSeconds: number) =>
  answer(reply.header("retry-after", String(retryAfterSeconds)), 429, "Too many pings");

/**
 * The heartbeat ping (docs/uptime-alerts.md, "Heartbeat checks"):
 * `/api/heartbeats/:token` and `/api/heartbeats/:token/fail`, by GET, POST,
 * or HEAD (Fastify answers HEAD with each GET). Public: the token is the
 * capability, and it reaches its own check only. A body is never read.
 * An unknown, malformed, or paused token answers 404, the same each way.
 */
export const heartbeatRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  now?: () => Date;
  ipLimit?: RateLimit;
  checkLimit?: RateLimit;
  /** Runs the check's alert rules after it goes down or comes back up. */
  onStateChange?: (change: StateChange) => Promise<void>;
}> = (
  app,
  {
    db,
    now = () => new Date(),
    ipLimit = PING_IP_LIMIT,
    checkLimit = PING_CHECK_LIMIT,
    onStateChange,
  },
  done,
) => {
  const byAddress = new ClientRateLimiter(ipLimit);
  const byCheck = new TokenBucketLimiter(checkLimit);

  // Jobs send whatever their tool sends; the body is dropped unread.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, payload, parsed) => {
    payload.resume();
    parsed(null, undefined);
  });

  async function ping(
    request: FastifyRequest<{ Params: { token: string } }>,
    reply: FastifyReply,
    failed: boolean,
  ) {
    const fromAddress = byAddress.take(request.ip);
    if (!fromAddress.allowed) return tooMany(reply, fromAddress.retryAfterSeconds);
    const { token } = request.params;
    const found = TOKEN_PATTERN.test(token) ? await findPinged(db, token) : null;
    if (found === null) return answer(reply, 404, "Not found");
    const forCheck = byCheck.take(found.checkId);
    if (!forCheck.allowed) return tooMany(reply, forCheck.retryAfterSeconds);
    const { recorded, change } = await recordPing(db, found.checkId, failed, now());
    // Paused or deleted between the lookup and the record.
    if (!recorded) return answer(reply, 404, "Not found");
    if (change !== null && onStateChange !== undefined) {
      try {
        await onStateChange(change);
      } catch (error) {
        request.log.error(
          { err: error, check: change.checkId },
          "a heartbeat's alert rules failed",
        );
      }
    }
    return answer(reply, 200, "OK");
  }

  for (const [path, failed] of [
    ["/heartbeats/:token", false],
    ["/heartbeats/:token/fail", true],
  ] as const) {
    app.route<{ Params: { token: string } }>({
      method: ["GET", "POST"],
      url: path,
      handler: (request, reply) => ping(request, reply, failed),
    });
  }

  done();
};
