import type { FastifyPluginCallback, FastifyReply } from "fastify";
import type { Kysely } from "kysely";

import { USER_ID_PATTERN } from "../collection/identity.ts";
import { isStorableText } from "../collection/normalize.ts";
import type { ProjectKeyCache } from "../collection/project-keys.ts";
import { clientKey, type RateLimit, TokenBucketLimiter } from "../collection/rate-limiter.ts";
import { DEFAULT_SERVER_IP_LIMIT } from "../collection/server-events.ts";
import type { Database } from "../db/schema.ts";
import { MAX_PENDING_PER_PROJECT, requestUserDeletion } from "./deletions.ts";

const BEARER = /^Bearer (sk_[0-9a-f]{32})$/;

const problem = (error: string, message: string) => ({ error, message });

function unavailable(reply: FastifyReply) {
  return reply
    .code(503)
    .header("retry-after", "5")
    .send(problem("storage_unavailable", "The deletion was not recorded. Retry later."));
}

/**
 * POST /api/user-deletions: the app's own server asks for one user's data
 * to be deleted, with the project's secret key (Authorization: Bearer sk_…),
 * as it sends server events (collection/server-events.ts). A public key
 * never matches. The key and the address's rate are checked before the body
 * is read. The user ID goes in the body, not the address, so request logs
 * never hold it. 202 once the deletion is recorded; the worker does it
 * (deletions.ts).
 */
export const userDeletionRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  projects: ProjectKeyCache;
  /** Per client address (IPv6 by /64), as the other secret-key routes. */
  ipLimit?: RateLimit;
}> = (app, { db, projects, ipLimit }, done) => {
  const ipLimiter = new TokenBucketLimiter(ipLimit ?? DEFAULT_SERVER_IP_LIMIT);

  app.post<{ Body: { userId: string } }>(
    "/user-deletions",
    {
      bodyLimit: 4096,
      schema: {
        body: {
          type: "object",
          required: ["userId"],
          additionalProperties: false,
          properties: { userId: { type: "string", maxLength: 200, pattern: USER_ID_PATTERN } },
        },
      },
      onRequest: async (request, reply) => {
        if (!BEARER.test(request.headers.authorization ?? "")) {
          return reply
            .code(401)
            .send(
              problem("unauthorized", "Send the project's secret key: Authorization: Bearer sk_…"),
            );
        }
        const result = ipLimiter.take(clientKey(request.ip));
        if (!result.allowed) {
          return reply
            .code(429)
            .header("retry-after", String(result.retryAfterSeconds))
            .send(problem("rate_limited", "Too many requests from this address."));
        }
        return undefined;
      },
    },
    async (request, reply) => {
      const secretKey = BEARER.exec(request.headers.authorization ?? "")?.[1] ?? "";
      let project;
      try {
        project = await projects.findBySecret(secretKey);
      } catch (error) {
        request.log.error({ err: error }, "could not look up the secret key");
        return unavailable(reply);
      }
      if (project === null) {
        return reply.code(401).send(problem("unknown_key", "No project has this secret key."));
      }
      const { userId } = request.body;
      if (!isStorableText(userId)) {
        return reply
          .code(400)
          .send(problem("invalid_request", "userId contains an unpaired surrogate."));
      }
      let result;
      try {
        result = await requestUserDeletion(db, {
          projectId: project.id,
          userId,
          requestedBy: null,
        });
      } catch (error) {
        request.log.error({ err: error }, "could not record a user's deletion");
        return unavailable(reply);
      }
      if (!result.ok) {
        return reply
          .code(429)
          .header("retry-after", "60")
          .send(
            problem(
              "too_many_pending",
              `${MAX_PENDING_PER_PROJECT.toLocaleString("en-US")} deletions are waiting. Retry once they are done.`,
            ),
          );
      }
      return reply
        .code(202)
        .send({ status: "pending", requestedAt: result.requestedAt.toISOString() });
    },
  );

  done();
};
