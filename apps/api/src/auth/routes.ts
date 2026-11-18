import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import { type RateLimit, TokenBucketLimiter } from "../collection/rate-limiter.ts";
import type { Database } from "../db/schema.ts";
import { MAX_INSTANCE_NAME_LENGTH } from "../settings/settings.ts";
import {
  type Auth,
  canSignInWith,
  CLIENT_IP_HEADER,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "./auth.ts";
import { completeSetup, ownerExists } from "./setup.ts";

/** Who is signed in, as the session check finds it. */
export interface DashboardUser {
  id: string;
  name: string;
  email: string;
  role: "owner" | "member";
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by requireSession on routes that use it. */
    dashboardUser: DashboardUser | null;
  }
}

function problem(code: string, message: string) {
  return { error: code, message };
}

/** Node's request headers as a Fetch API Headers object. */
function toHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) {
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  return headers;
}

/**
 * Passes /api/auth/* to Better Auth, which works with Fetch API requests and
 * responses, not Fastify's. Request bodies go through untouched.
 */
export const betterAuthRoutes: FastifyPluginCallback<{ auth: Auth; publicUrl: string }> = (
  app,
  { auth, publicUrl },
  done,
) => {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    "*",
    { parseAs: "string", bodyLimit: 64 * 1024 },
    (_request, body, next) => next(null, body),
  );

  app.route({
    method: ["GET", "POST"],
    url: "/auth/*",
    async handler(request, reply) {
      const headers = toHeaders(request);
      // The client's address as Fastify sees it (following TRUST_PROXY),
      // replacing anything the client sent under this name.
      headers.set(CLIENT_IP_HEADER, request.ip);
      const body =
        typeof request.body === "string" && request.body !== "" ? request.body : undefined;
      const response = await auth.handler(
        new Request(new URL(request.url, publicUrl), {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body }),
        }),
      );

      reply.code(response.status);
      for (const [name, value] of response.headers) {
        if (name !== "set-cookie") {
          reply.header(name, value);
        }
      }
      // Each cookie is its own Set-Cookie header; joining them would break them.
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) {
        reply.header("set-cookie", cookies);
      }
      return reply.send(Buffer.from(await response.arrayBuffer()));
    },
  });
  done();
};

const setupBodySchema = {
  type: "object",
  required: ["token", "name", "email", "password", "instanceName"],
  additionalProperties: false,
  properties: {
    token: { type: "string", minLength: 1, maxLength: 200 },
    name: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
    // Checked against sign-in's own rule in the handler (canSignInWith).
    email: { type: "string", minLength: 3, maxLength: 320 },
    password: { type: "string", minLength: MIN_PASSWORD_LENGTH, maxLength: MAX_PASSWORD_LENGTH },
    instanceName: {
      type: "string",
      minLength: 1,
      maxLength: MAX_INSTANCE_NAME_LENGTH,
      pattern: "\\S",
    },
  },
} as const;

/** Setup attempts per client address: 10 at once, then one a minute. */
export const DEFAULT_SETUP_LIMIT: RateLimit = { capacity: 10, refillPerSecond: 1 / 60 };

/**
 * GET /api/setup says whether the instance still needs an owner, so the
 * dashboard can explain how to create one. POST /api/setup creates the owner
 * from a setup link (see setup.ts). Anyone can call it, so attempts are
 * limited per client address.
 */
export const setupRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  /** The instance's timezone, which the setup link sets (TIMEZONE). */
  defaultTimeZone: string;
  setupLimit?: RateLimit;
}> = (app, { db, auth, defaultTimeZone, setupLimit = DEFAULT_SETUP_LIMIT }, done) => {
  const limiter = new TokenBucketLimiter(setupLimit);

  app.get("/setup", async () => ({ ownerExists: await ownerExists(db) }));

  app.post<{
    Body: {
      token: string;
      name: string;
      email: string;
      password: string;
      instanceName: string;
    };
  }>(
    "/setup",
    {
      schema: { body: setupBodySchema },
      // Before the body is read or checked.
      onRequest: async (request, reply) => {
        const result = limiter.take(request.ip);
        if (!result.allowed) {
          return reply
            .code(429)
            .header("retry-after", String(result.retryAfterSeconds))
            .send(
              problem(
                "rate_limited",
                `Too many setup attempts. Retry after ${result.retryAfterSeconds} seconds.`,
              ),
            );
        }
        return undefined;
      },
    },
    async (request, reply) => {
      const { token, name, email, password, instanceName } = request.body;
      if (!canSignInWith(email)) {
        return reply
          .code(400)
          .send(
            problem(
              "invalid_email",
              "Sign-in does not accept this email address. Use letters, digits, and . _ ' + - before the @, and a domain such as example.com.",
            ),
          );
      }
      const result = await completeSetup(
        db,
        auth,
        { token, name: name.trim(), email, password, instanceName: instanceName.trim() },
        { timeZone: defaultTimeZone },
      );
      if (result === "invalid_link") {
        return reply
          .code(403)
          .send(
            problem(
              "invalid_link",
              "This setup link is invalid, used, or expired. Run `vp run setup` again for a new one.",
            ),
          );
      }
      if (result === "already_set_up") {
        return reply
          .code(409)
          .send(problem("already_set_up", "This instance already has an owner."));
      }
      return reply.code(201).send({ created: true });
    },
  );
  done();
};

/**
 * A preHandler for routes that need a signed-in dashboard user: answers 401
 * without a valid session, and otherwise sets request.dashboardUser.
 */
export function requireSession(auth: Auth) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await auth.api.getSession({ headers: toHeaders(request) });
    if (session === null) {
      return reply.code(401).send(problem("unauthorized", "Sign in to continue."));
    }
    const { id, name, email, role } = session.user;
    request.dashboardUser = { id, name, email, role: role === "owner" ? "owner" : "member" };
    // Nothing sent: Fastify goes on to the route handler.
    return undefined;
  };
}

/** The user requireSession set. Routes that call it always run requireSession first. */
export function signedInUser(request: FastifyRequest): DashboardUser {
  if (request.dashboardUser === null) {
    throw new Error("requireSession must run before this route");
  }
  return request.dashboardUser;
}
