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
import { dropQueuedAccountEmails, enqueueAccountEmail } from "../notifications/account-emails.ts";
import type { LinkSealer } from "../notifications/link-sealer.ts";

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
  "This address has a pending invitation. Use another address, or ask an owner or admin to revoke the invitation on the Members page.",
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
 * Users may change only their own account (docs/access.md, "Your account").
 * Better Auth's alternative update routes are disabled (auth.ts). Current-password
 * checks share the ownership-transfer limiter. Schema validation runs first.
 * SMTP email changes queue a notice to the old address
 * (notifications/account-emails.ts). Request logs contain only method and URL
 * (app.ts), never passwords or email addresses.
 */
export const accountRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  trustedOrigins: readonly string[];
  /** The app's one limiter for current-password checks (auth/password-tries.ts). */
  passwordTries?: TokenBucketLimiter;
  /** Whether SMTP is set up: an email change then notifies the old address. */
  emailConfigured?: boolean;
  /** Seals queued links; required with `emailConfigured`. */
  sealer?: LinkSealer | null;
}> = (
  app,
  {
    db,
    auth,
    trustedOrigins,
    passwordTries = passwordTryLimiter(),
    emailConfigured = false,
    sealer = null,
  },
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
      // Normalize email to match sign-in lookup.
      const email = request.body.email.trim().toLowerCase();
      if (!canSignInWith(email)) return reply.code(400).send(INVALID_EMAIL);
      if (email === user.email.toLowerCase()) return reply.code(400).send(SAME_EMAIL);
      if (limited(passwordTries, user.id, reply)) return reply;
      if (!(await checkPassword(db, auth, user.id, request.body.password))) {
        return reply.code(403).send(WRONG_PASSWORD);
      }
      try {
        // Reject pending invitee addresses in the update statement to avoid a race.
        // Invalidate old-address links in the same transaction; another person may
        // control that mailbox.
        const updated = await db.transaction().execute(async (trx) => {
          const old = await trx
            .selectFrom("dashboard_users")
            .select("email")
            .where("id", "=", user.id)
            .forUpdate()
            .executeTakeFirstOrThrow();
          const changed = await trx
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
          if (changed === undefined) return undefined;
          // Remove all reset links because even admin-made links may have been emailed
          // to the old address; delivery leaves no record of that association.
          await trx
            .deleteFrom("dashboard_password_resets")
            .where("user_id", "=", user.id)
            .execute();
          await dropQueuedAccountEmails(trx, "reset_link", old.email);
          await dropQueuedAccountEmails(trx, "password_reset", old.email);
          if (emailConfigured && sealer !== null) {
            // Notify the old address so its owner can detect an unauthorized change.
            await enqueueAccountEmail(
              trx,
              {
                kind: "email_changed",
                to: old.email,
                params: { oldEmail: old.email, newEmail: changed.email },
              },
              sealer,
            );
          }
          return changed;
        });
        if (updated === undefined) return reply.code(409).send(EMAIL_INVITED);
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
    // Omit session tokens; the page only needs session IDs.
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
      // Restrict deletion to the caller's sessions. Foreign keys remove overlay tokens.
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
