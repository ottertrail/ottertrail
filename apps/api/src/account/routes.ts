import { APIError } from "better-auth";
import type { FastifyPluginCallback, FastifyReply } from "fastify";
import { type Kysely, sql } from "kysely";

import { requirePermission } from "../access/access.ts";
import { checkPassword } from "../access/members.ts";
import { type Auth, canSignInWith, MAX_PASSWORD_LENGTH } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { passwordTryLimiter } from "../auth/password-tries.ts";
import {
  newPasswordProperties,
  PASSWORDS_DIFFER,
  requireSession,
  signedInUser,
  toHeaders,
} from "../auth/routes.ts";
import type { TokenBucketLimiter } from "../collection/rate-limiter.ts";
import type { Database } from "../db/schema.ts";
import { enqueueAccountEmail } from "../notifications/account-emails.ts";

/** As the setup form's name. */
export const MAX_NAME_LENGTH = 200;

const problem = (error: string, message: string) => ({ error, message });

const WRONG_PASSWORD = problem(
  "wrong_password",
  "The current password is incorrect. Enter it again.",
);
const INVALID_EMAIL = problem(
  "invalid_email",
  "Sign-in does not accept this email address. Use letters, digits, and . _ ' + - before the @. Use a domain such as example.com.",
);
const EMAIL_IN_USE = problem(
  "email_in_use",
  "Another account already uses this email address. Enter a different one.",
);
const SAME_EMAIL = problem("same_email", "This is already your email address.");
const EMAIL_INVITED = problem(
  "email_invited",
  "Someone has a pending invitation for this email address, so it can't be yours yet. Enter a different address, or ask an owner or admin to revoke the invitation on the Members page.",
);
const NO_SESSION = problem("session_not_found", "You have no other session with this ID.");
const CURRENT_SESSION = problem(
  "current_session",
  "This is the session you're using now. To end it, sign out.",
);

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** PostgreSQL's unique_violation. */
const isUniqueViolation = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "23505";

const currentPassword = { type: "string", minLength: 1, maxLength: MAX_PASSWORD_LENGTH } as const;

/** Spends one try of `userId`'s; answers 429 when none is left. */
function limited(limiter: TokenBucketLimiter, userId: string, reply: FastifyReply) {
  const tried = limiter.take(userId);
  if (tried.allowed) return false;
  void reply
    .code(429)
    .header("retry-after", String(tried.retryAfterSeconds))
    .send(
      problem("rate_limited", `Too many attempts. Retry after ${tried.retryAfterSeconds} seconds.`),
    );
  return true;
}

/**
 * The signed-in user's own account (docs/access.md, "Your account"):
 *
 *   PATCH  /api/account                 { name }
 *   POST   /api/account/email           { email, password }
 *   POST   /api/account/password        { currentPassword, password, confirmPassword, revokeOtherSessions }
 *   GET    /api/account/sessions        the user's sessions, without their tokens
 *   DELETE /api/account/sessions/:id    signs out one other session
 *   DELETE /api/account/sessions        signs out every other session
 *
 * Every signed-in user may change their own name, email, and password,
 * and nobody else's. Better Auth's own routes for these
 * (/api/auth/update-user, /change-email, /change-password) are turned off
 * (auth.ts), so these are the only way, with these checks.
 * With SMTP set up, an email change queues a notice to the old address
 * (notifications/account-emails.ts).
 *
 * Bodies are checked by schema before anything else; the password tries,
 * shared with handing over ownership, are counted per user once the
 * session is known. Nothing here logs a password or
 * an email: the request log has the method and URL only (app.ts).
 */
export const accountRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  trustedOrigins: readonly string[];
  /** The app's one limiter for current-password checks (auth/password-tries.ts). */
  passwordTries?: TokenBucketLimiter;
  /** Whether SMTP is set up: an email change then notifies the old address. */
  emailConfigured?: boolean;
}> = (
  app,
  { db, auth, trustedOrigins, passwordTries = passwordTryLimiter(), emailConfigured = false },
  done,
) => {
  const signedIn = requireSession(auth);
  const fromDashboard = requireTrustedOrigin(trustedOrigins);
  const anyUser = requirePermission(db, "signed_in");

  app.patch<{ Body: { name: string } }>(
    "/account",
    {
      preHandler: [fromDashboard, signedIn, anyUser],
      schema: {
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: MAX_NAME_LENGTH, pattern: "\\S" },
          },
        },
      },
    },
    async (request) => {
      const { id } = signedInUser(request);
      const user = await db
        .updateTable("dashboard_users")
        .set({ name: request.body.name.trim(), updated_at: new Date() })
        .where("id", "=", id)
        .returning(["id", "name", "email"])
        .executeTakeFirstOrThrow();
      return { user };
    },
  );

  app.post<{ Body: { email: string; password: string } }>(
    "/account/email",
    {
      preHandler: [fromDashboard, signedIn, anyUser],
      schema: {
        body: {
          type: "object",
          required: ["email", "password"],
          additionalProperties: false,
          properties: {
            // Checked against sign-in's own rule below (canSignInWith).
            email: { type: "string", minLength: 3, maxLength: 320 },
            password: currentPassword,
          },
        },
      },
    },
    async (request, reply) => {
      const user = signedInUser(request);
      // Sign-in looks addresses up in lower case, as setup and invitations store them.
      const email = request.body.email.trim().toLowerCase();
      if (!canSignInWith(email)) return reply.code(400).send(INVALID_EMAIL);
      if (email === user.email.toLowerCase()) return reply.code(400).send(SAME_EMAIL);
      if (limited(passwordTries, user.id, reply)) return reply;
      if (!(await checkPassword(db, auth, user.id, request.body.password))) {
        return reply.code(403).send(WRONG_PASSWORD);
      }
      try {
        // Only the address changes: the role, the grants, and every session
        // stay. An address with a pending invitation is the invitee's: in the
        // same statement, so no invitation can slip in between a check and it.
        const updated = await db
          .updateTable("dashboard_users")
          .set({ email, updated_at: new Date() })
          .where("id", "=", user.id)
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom("dashboard_invitations")
                  .select(sql<number>`1`.as("one"))
                  .where("dashboard_invitations.email", "=", email),
              ),
            ),
          )
          .returning(["id", "name", "email"])
          .executeTakeFirst();
        if (updated === undefined) return reply.code(409).send(EMAIL_INVITED);
        if (emailConfigured) {
          // The old address hears of it, so a change its owner didn't make is noticed.
          await enqueueAccountEmail(db, {
            kind: "email_changed",
            to: user.email.toLowerCase(),
            params: { oldEmail: user.email, newEmail: updated.email },
          });
        }
        return { user: updated };
      } catch (error) {
        // The unique index decides, so two users cannot take one address at once.
        if (isUniqueViolation(error)) return reply.code(409).send(EMAIL_IN_USE);
        throw error;
      }
    },
  );

  app.post<{
    Body: {
      currentPassword: string;
      password: string;
      confirmPassword: string;
      revokeOtherSessions: boolean;
    };
  }>(
    "/account/password",
    {
      preHandler: [fromDashboard, signedIn, anyUser],
      schema: {
        body: {
          type: "object",
          required: ["currentPassword", "password", "confirmPassword", "revokeOtherSessions"],
          additionalProperties: false,
          properties: {
            currentPassword,
            ...newPasswordProperties,
            revokeOtherSessions: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const user = signedInUser(request);
      const body = request.body;
      if (body.password !== body.confirmPassword) return reply.code(400).send(PASSWORDS_DIFFER);
      if (limited(passwordTries, user.id, reply)) return reply;
      try {
        // Better Auth checks the current password, hashes the new one, and,
        // when asked, deletes every session and signs this one in afresh.
        const { headers } = await auth.api.changePassword({
          body: {
            currentPassword: body.currentPassword,
            newPassword: body.password,
            revokeOtherSessions: body.revokeOtherSessions,
          },
          headers: toHeaders(request),
          returnHeaders: true,
        });
        const cookies = headers.getSetCookie();
        if (cookies.length > 0) reply.header("set-cookie", cookies);
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof APIError && error.body?.code === "INVALID_PASSWORD") {
          return reply.code(403).send(WRONG_PASSWORD);
        }
        throw error;
      }
    },
  );

  app.get("/account/sessions", { preHandler: [signedIn, anyUser] }, async (request) => {
    const { id, sessionId } = signedInUser(request);
    const rows = await db
      .selectFrom("dashboard_sessions")
      .select(["id", "created_at", "updated_at", "user_agent"])
      .where("user_id", "=", id)
      .where("expires_at", ">", new Date())
      .orderBy("updated_at", "desc")
      .execute();
    // No token: the page never needs one, and it names the session.
    return {
      sessions: rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at.toISOString(),
        lastActiveAt: row.updated_at.toISOString(),
        userAgent: row.user_agent,
        current: row.id === sessionId,
      })),
    };
  });

  app.delete<{ Params: { id: string } }>(
    "/account/sessions/:id",
    {
      preHandler: [fromDashboard, signedIn, anyUser],
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", pattern: UUID_PATTERN } },
        },
      },
    },
    async (request, reply) => {
      const { id, sessionId } = signedInUser(request);
      if (request.params.id.toLowerCase() === sessionId) {
        return reply.code(400).send(CURRENT_SESSION);
      }
      // Only the user's own: another user's session ID deletes nothing.
      // Its heatmap overlay tokens go with it (a foreign key).
      const deleted = await db
        .deleteFrom("dashboard_sessions")
        .where("id", "=", request.params.id)
        .where("user_id", "=", id)
        .where("id", "<>", sessionId)
        .executeTakeFirst();
      return deleted.numDeletedRows > 0n
        ? reply.code(204).send()
        : reply.code(404).send(NO_SESSION);
    },
  );

  app.delete(
    "/account/sessions",
    { preHandler: [fromDashboard, signedIn, anyUser] },
    async (request) => {
      const { id, sessionId } = signedInUser(request);
      const deleted = await db
        .deleteFrom("dashboard_sessions")
        .where("user_id", "=", id)
        .where("id", "<>", sessionId)
        .executeTakeFirst();
      return { signedOut: Number(deleted.numDeletedRows) };
    },
  );

  done();
};
