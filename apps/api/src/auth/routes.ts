import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import type { Database } from "../db/schema.ts";
import { type Auth, CLIENT_IP_HEADER, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./auth.ts";
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
  required: ["token", "name", "email", "password"],
  additionalProperties: false,
  properties: {
    token: { type: "string", minLength: 1, maxLength: 200 },
    name: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
    email: { type: "string", format: "email", maxLength: 320 },
    password: { type: "string", minLength: MIN_PASSWORD_LENGTH, maxLength: MAX_PASSWORD_LENGTH },
  },
} as const;

/**
 * GET /api/setup says whether the instance still needs an owner, so the
 * dashboard can explain how to create one. POST /api/setup creates the owner
 * from a setup link (see setup.ts).
 */
export const setupRoutes: FastifyPluginCallback<{ db: Kysely<Database>; auth: Auth }> = (
  app,
  { db, auth },
  done,
) => {
  app.get("/setup", async () => ({ ownerExists: await ownerExists(db) }));

  app.post<{ Body: { token: string; name: string; email: string; password: string } }>(
    "/setup",
    { schema: { body: setupBodySchema } },
    async (request, reply) => {
      const { token, name, email, password } = request.body;
      const result = await completeSetup(db, auth, { token, name: name.trim(), email, password });
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
