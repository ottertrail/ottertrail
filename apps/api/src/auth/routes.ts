import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import { clientKey, type RateLimit, TokenBucketLimiter } from "../collection/rate-limiter.ts";
import type { Database, Role } from "../db/schema.ts";
import {
  INVALID_TIME_ZONE,
  MAX_INSTANCE_NAME_LENGTH,
  postgresKnowsTimeZone,
} from "../settings/settings.ts";
import { canonicalTimeZone } from "../visitors/visitor-ids.ts";
import {
  type Auth,
  canSignInWith,
  CLIENT_IP_HEADER,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "./auth.ts";
import { completeSetup, ownerExists } from "./setup.ts";

export interface DashboardUser {
  id: string;
  name: string;
  email: string;
  /**
   * As the session found it. Access checks read the role again with the
   * user's grants (access/access.ts), so use theirs.
   */
  role: Role;
  /** The dashboard session the request came with (dashboard_sessions.id). */
  sessionId: string;
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

export function toHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) {
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  return headers;
}

/** Adapts /api/auth/* to Better Auth's Fetch API interface. Bodies pass through unchanged. */
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
      // Overwrite client input with Fastify's address (TRUST_PROXY).
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
      // Keep Set-Cookie headers separate; joining them breaks cookies.
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) {
        reply.header("set-cookie", cookies);
      }
      return reply.send(Buffer.from(await response.arrayBuffer()));
    },
  });
  done();
};

export const newPasswordProperties = {
  password: { type: "string", minLength: MIN_PASSWORD_LENGTH, maxLength: MAX_PASSWORD_LENGTH },
  confirmPassword: { type: "string", maxLength: MAX_PASSWORD_LENGTH },
} as const;

export const PASSWORDS_DIFFER = problem(
  "passwords_differ",
  "The passwords do not match. Enter the same password in both fields.",
);

const setupBodySchema = {
  type: "object",
  required: ["token", "name", "email", "password", "confirmPassword", "instanceName", "timeZone"],
  additionalProperties: false,
  properties: {
    token: { type: "string", minLength: 1, maxLength: 200 },
    name: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
    // Checked against sign-in's own rule in the handler (canSignInWith).
    email: { type: "string", minLength: 3, maxLength: 320 },
    ...newPasswordProperties,
    instanceName: {
      type: "string",
      minLength: 1,
      maxLength: MAX_INSTANCE_NAME_LENGTH,
      pattern: "\\S",
    },
    timeZone: { type: "string", minLength: 1, maxLength: 100 },
  },
} as const;

/** Setup attempts per client address: 10 at once, then one a minute. */
export const DEFAULT_SETUP_LIMIT: RateLimit = { capacity: 10, refillPerSecond: 1 / 60 };

/**
 * Setup links create the owner with a chosen timezone (setup.ts). Public attempts
 * are limited per client address. GET also reports SMTP_URL availability.
 */
export const setupRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  /** Whether SMTP_URL is set: a status line on the page, nothing sent. */
  emailConfigured: boolean;
  setupLimit?: RateLimit;
}> = (app, { db, auth, emailConfigured, setupLimit = DEFAULT_SETUP_LIMIT }, done) => {
  const limiter = new TokenBucketLimiter(setupLimit);

  app.get("/setup", async () => ({ ownerExists: await ownerExists(db), emailConfigured }));

  app.post<{
    Body: {
      token: string;
      name: string;
      email: string;
      password: string;
      confirmPassword: string;
      instanceName: string;
      timeZone: string;
    };
  }>(
    "/setup",
    {
      schema: { body: setupBodySchema },
      onRequest: async (request, reply) => {
        const result = limiter.take(clientKey(request.ip));
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
      const { token, name, email, password, confirmPassword, instanceName } = request.body;
      if (!canSignInWith(email)) {
        return reply
          .code(400)
          .send(
            problem(
              "invalid_email",
              "Sign-in does not accept this email address. Use letters, digits, and . _ ' + - before the @. Use a domain such as example.com.",
            ),
          );
      }
      if (password !== confirmPassword) {
        return reply.code(400).send(PASSWORDS_DIFFER);
      }
      // Checked as the settings page checks it: PostgreSQL counts the days.
      const timeZone = canonicalTimeZone(request.body.timeZone);
      if (timeZone === undefined || !(await postgresKnowsTimeZone(db, timeZone))) {
        return reply.code(400).send(INVALID_TIME_ZONE);
      }
      const result = await completeSetup(
        db,
        auth,
        { token, name: name.trim(), email, password, instanceName: instanceName.trim() },
        { timeZone },
      );
      if (result === "invalid_link") {
        return reply
          .code(403)
          .send(
            problem(
              "invalid_link",
              "This setup link is invalid, already used, or expired. To create a new link, run `docker compose exec api node dist/setup.mjs` on the server (`vp run setup` in development).",
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
    request.dashboardUser = {
      id,
      name,
      email,
      role: role === "owner" || role === "admin" ? role : "member",
      sessionId: session.session.id,
    };
    return undefined;
  };
}

/** Requires requireSession to have run first. */
export function signedInUser(request: FastifyRequest): DashboardUser {
  if (request.dashboardUser === null) {
    throw new Error("requireSession must run before this route");
  }
  return request.dashboardUser;
}
