import { createHash } from "node:crypto";

import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import { type Auth, canSignInWith } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { passwordTryLimiter } from "../auth/password-tries.ts";
import {
  newPasswordProperties,
  PASSWORDS_DIFFER,
  requireSession,
  signedInUser,
} from "../auth/routes.ts";
import { deleteUserAvatars } from "../avatars/avatars.ts";
import { clientKey, type RateLimit, TokenBucketLimiter } from "../collection/rate-limiter.ts";
import type { Database } from "../db/schema.ts";
import {
  dropQueuedAccountEmails,
  enqueueAccountEmail,
  inviteLink,
  resetLink,
} from "../notifications/account-emails.ts";
import type { LinkSealer } from "../notifications/link-sealer.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { FORBIDDEN, requirePermission, userAccessOf } from "./access.ts";
import { AREA_LEVELS, AREAS } from "./areas.ts";
import type { AccessChange } from "./grants.ts";
import {
  acceptInvitation,
  createInvitation,
  INVITATION_TTL_MS,
  listInvitations,
  previewInvitation,
  renewInvitation,
  revokeInvitation,
} from "./invitations.ts";
import {
  type Actor,
  changeMember,
  listMembers,
  type MemberAccess,
  removeMember,
  transferOwnership,
} from "./members.ts";
import { makeResetLink, previewPasswordReset, usePasswordReset } from "./password-resets.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/**
 * Accepting invitations and using reset links, per client address (IPv6 by
 * its /64): 10 at once, then one a minute.
 */
export const DEFAULT_LINK_LIMIT: RateLimit = { capacity: 10, refillPerSecond: 1 / 60 };

/** Reset requests from the sign-in page per client address (IPv6 by its /64): 5 per 15 minutes. */
export const DEFAULT_RESET_REQUEST_IP_LIMIT: RateLimit = { capacity: 5, refillPerSecond: 5 / 900 };

/** Limit every email equally to 3 reset requests an hour to avoid revealing accounts. */
export const DEFAULT_RESET_REQUEST_EMAIL_LIMIT: RateLimit = {
  capacity: 3,
  refillPerSecond: 3 / 3600,
};

/**
 * Instance reset requests: burst 30, then 600 an hour. Check first to bound the
 * per-address limiter's memory and keep the queue below worker capacity.
 */
export const DEFAULT_RESET_REQUEST_INSTANCE_LIMIT: RateLimit = {
  capacity: 30,
  refillPerSecond: 600 / 3600,
};

/**
 * The instance limit admits about 630 new addresses an hour. Buckets refill fully
 * after an idle hour, so this cap cannot evict a bucket that still counts.
 */
const RESET_REQUEST_EMAIL_KEYS = 100_000;

/** Emailed invitations and New links per owner or admin: 20 at once, then 20 an hour. */
export const DEFAULT_INVITATION_EMAIL_LIMIT: RateLimit = {
  capacity: 20,
  refillPerSecond: 20 / 3600,
};

const problem = (error: string, message: string) => ({ error, message });
const NO_MEMBER = problem("member_not_found", "This instance has no user with this ID.");
const NO_INVITATION = problem("invitation_not_found", "No pending invitation has this ID.");
const INVITATION_GONE = problem(
  "invalid_link",
  "This invitation link no longer works. Ask for a new one.",
);
const RESET_GONE = problem("invalid_link", "This reset link no longer works. Ask for a new one.");
/** One answer for every address, with or without an account. */
const RESET_REQUESTED = {
  requested: true,
  message:
    "If an account uses that email, we'll send a reset link. Check your inbox and spam folder.",
};
/** One answer for both limits, for every address. */
const RESET_REQUESTS_LIMITED = problem(
  "rate_limited",
  "Too many reset requests. Wait a little, then try again.",
);
const NO_EMAIL = problem(
  "email_not_set_up",
  "Email isn't set up on this instance. Ask the person who runs it for a reset link.",
);
const INVALID_EMAIL = problem(
  "invalid_email",
  "Sign-in does not accept this email address. Use letters, digits, and . _ ' + - before the @. Use a domain such as example.com.",
);

/** An address as a limiter's key: its hash, so the limiter's memory holds no address. */
const emailKey = (email: string) => createHash("sha256").update(email).digest("hex");

const accessSchema = {
  type: "object",
  required: ["projects", "areas"],
  additionalProperties: false,
  properties: {
    // Try text first: Fastify coercion would otherwise turn "all" into ["all"].
    projects: {
      anyOf: [
        { type: "string", const: "all" },
        { type: "array", maxItems: 1000, items: { type: "string", pattern: UUID_PATTERN } },
      ],
    },
    areas: {
      type: "object",
      required: [...AREAS],
      additionalProperties: false,
      properties: Object.fromEntries(
        AREAS.map((area) => [area, { type: "string", enum: [...AREA_LEVELS[area]] }]),
      ),
    },
  },
} as const;

const roleProperties = {
  role: { type: "string", enum: ["admin", "member"] },
  access: accessSchema,
} as const;

type RoleBody = { role: "admin" | "member"; access?: MemberAccess };

function changeOf(body: RoleBody): AccessChange | null {
  if (body.role === "admin") return { role: "admin" };
  return body.access === undefined ? null : { role: "member", ...body.access };
}

const ACCESS_REQUIRED = problem("access_required", "Specify the member's projects and areas.");

const userParams = {
  type: "object",
  required: ["userId"],
  properties: { userId: { type: "string", pattern: UUID_PATTERN } },
} as const;
const invitationParams = {
  type: "object",
  required: ["invitationId"],
  properties: { invitationId: { type: "string", pattern: UUID_PATTERN } },
} as const;
const tokenSchema = { type: "string", minLength: 1, maxLength: 200 } as const;

function actorOf(request: FastifyRequest): Actor {
  const { userId, role } = userAccessOf(request);
  return { id: userId, role };
}

function answerOf(
  result: "done" | "not_found" | "forbidden",
  reply: FastifyReply,
  notFound: object,
) {
  if (result === "not_found") return reply.code(404).send(notFound);
  if (result === "forbidden") return reply.code(403).send(FORBIDDEN);
  return reply.code(204).send();
}

/**
 * Members, invitations, reset links, and ownership (docs/access.md).
 * Owner and admins need members permission and must follow members.ts role rules;
 * only the owner may transfer ownership. Public link routes limit client IPs,
 * and emailed reset requests also limit email addresses. SMTP enables queued
 * account email (notifications/account-emails.ts). Links use PUBLIC_URL, never
 * request Host, and keep tokens in fragments that browsers never send to servers.
 */
export const memberRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  trustedOrigins: readonly string[];
  publicUrl: string;
  linkLimit?: RateLimit;
  /** Whether SMTP is set up: account email is queued only then. */
  emailConfigured?: boolean;
  resetRequestIpLimit?: RateLimit;
  resetRequestEmailLimit?: RateLimit;
  resetRequestInstanceLimit?: RateLimit;
  invitationEmailLimit?: RateLimit;
  /** Seals the links queued emails carry; required with `emailConfigured`. */
  sealer?: LinkSealer | null;
  /** Share the app's current-password limiter (auth/password-tries.ts). */
  passwordTries?: TokenBucketLimiter;
  /** Where a removed user's avatar is deleted from; none without a store. */
  objectStore?: ObjectStore | null;
  now?: () => Date;
}> = (
  app,
  {
    db,
    auth,
    trustedOrigins,
    publicUrl,
    linkLimit = DEFAULT_LINK_LIMIT,
    emailConfigured = false,
    resetRequestIpLimit = DEFAULT_RESET_REQUEST_IP_LIMIT,
    resetRequestEmailLimit = DEFAULT_RESET_REQUEST_EMAIL_LIMIT,
    resetRequestInstanceLimit = DEFAULT_RESET_REQUEST_INSTANCE_LIMIT,
    invitationEmailLimit = DEFAULT_INVITATION_EMAIL_LIMIT,
    sealer = null,
    passwordTries = passwordTryLimiter(),
    objectStore = null,
    now = () => new Date(),
  },
  done,
) => {
  const signedIn = requireSession(auth);
  const fromDashboard = requireTrustedOrigin(trustedOrigins);
  const manageMembers = requirePermission(db, "members");
  const owner = requirePermission(db, "ownership");
  const limiter = new TokenBucketLimiter(linkLimit);
  const requestsByAddress = new TokenBucketLimiter(resetRequestIpLimit);
  const requestsByEmail = new TokenBucketLimiter(resetRequestEmailLimit, {
    maxKeys: RESET_REQUEST_EMAIL_KEYS,
  });
  const requestsOfInstance = new TokenBucketLimiter(resetRequestInstanceLimit);
  const invitationEmails = new TokenBucketLimiter(invitationEmailLimit);
  const linkSealer = (): LinkSealer => {
    if (sealer === null) throw new Error("Account email needs a LinkSealer");
    return sealer;
  };

  /** Consumes an emailed invitation allowance; returns false and 429 at the limit. */
  function invitationEmailAllowed(actorId: string, reply: FastifyReply): boolean {
    if (!emailConfigured) return true;
    const result = invitationEmails.take(actorId);
    if (result.allowed) return true;
    void reply
      .code(429)
      .header("retry-after", String(result.retryAfterSeconds))
      .send(
        problem(
          "rate_limited",
          `The limit is ${invitationEmailLimit.capacity} emailed invitations per hour. This invitation wasn't created or sent. Try again in about ${Math.ceil(result.retryAfterSeconds / 60)} minutes.`,
        ),
      );
    return false;
  }

  const inviteUrl = (token: string) => inviteLink(publicUrl, token);
  const resetUrl = (token: string) => resetLink(publicUrl, token);

  /** Queues the invitation's email, replacing one not sent yet, whose link no longer works. */
  async function emailInvitation(
    invitation: { email: string; invitedBy: { name: string } },
    token: string,
  ) {
    await db.transaction().execute(async (trx) => {
      await dropQueuedAccountEmails(trx, "invitation", invitation.email);
      await enqueueAccountEmail(
        trx,
        {
          kind: "invitation",
          to: invitation.email,
          params: {
            link: inviteUrl(token),
            inviter: invitation.invitedBy.name,
            invitedEmail: invitation.email,
          },
        },
        linkSealer(),
      );
    });
  }

  const limited = async (request: FastifyRequest, reply: FastifyReply) => {
    const result = limiter.take(clientKey(request.ip));
    if (result.allowed) return undefined;
    return reply
      .code(429)
      .header("retry-after", String(result.retryAfterSeconds))
      .send(
        problem(
          "rate_limited",
          `Too many attempts. Retry after ${result.retryAfterSeconds} seconds.`,
        ),
      );
  };

  app.get("/members", { preHandler: [signedIn, manageMembers] }, async (request) => ({
    you: actorOf(request),
    invitationDays: INVITATION_TTL_MS / 86_400_000,
    emailConfigured,
    members: await listMembers(db),
    invitations: await listInvitations(db),
  }));

  app.patch<{ Params: { userId: string }; Body: RoleBody }>(
    "/members/:userId",
    {
      preHandler: [fromDashboard, signedIn, manageMembers],
      schema: {
        params: userParams,
        body: {
          type: "object",
          required: ["role"],
          additionalProperties: false,
          properties: roleProperties,
        },
      },
    },
    async (request, reply) => {
      const change = changeOf(request.body);
      if (change === null) return reply.code(400).send(ACCESS_REQUIRED);
      const result = await changeMember(db, actorOf(request), request.params.userId, change);
      return answerOf(result, reply, NO_MEMBER);
    },
  );

  app.delete<{ Params: { userId: string } }>(
    "/members/:userId",
    { preHandler: [fromDashboard, signedIn, manageMembers], schema: { params: userParams } },
    async (request, reply) => {
      const result = await removeMember(db, actorOf(request), request.params.userId);
      // Delete the avatar only after its referencing row is gone.
      if (result === "done") {
        await deleteUserAvatars(objectStore, request.params.userId.toLowerCase(), request.log);
      }
      return answerOf(result, reply, NO_MEMBER);
    },
  );

  app.post<{ Params: { userId: string }; Body: { email?: boolean } | null | undefined }>(
    "/members/:userId/reset-link",
    {
      preHandler: [fromDashboard, signedIn, manageMembers],
      schema: {
        params: userParams,
        body: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: { email: { type: "boolean" } },
        },
      },
    },
    async (request, reply) => {
      const wantsEmail = request.body?.email === true;
      if (wantsEmail && !emailConfigured) {
        return reply
          .code(409)
          .send(
            problem(
              "email_not_set_up",
              "Email isn't set up. Make the link without email, then copy and send it yourself.",
            ),
          );
      }
      // Admins reset members; the owner resets anyone else.
      const made = await makeResetLink(db, actorOf(request), request.params.userId, now());
      if (made === "not_found") return reply.code(404).send(NO_MEMBER);
      if (made === "forbidden") return reply.code(403).send(FORBIDDEN);
      const url = resetUrl(made.token);
      await db.transaction().execute(async (trx) => {
        // Remove queued email for the invalidated link, even if the new link is not emailed.
        await dropQueuedAccountEmails(trx, "reset_link", made.email);
        if (wantsEmail) {
          await enqueueAccountEmail(
            trx,
            {
              kind: "reset_link",
              to: made.email,
              params: { link: url, maker: signedInUser(request).name },
            },
            linkSealer(),
          );
        }
      });
      return reply.code(201).send({ url, expiresAt: made.expiresAt, emailed: wantsEmail });
    },
  );

  app.post<{ Params: { userId: string }; Body: { password: string } }>(
    "/members/:userId/ownership",
    {
      preHandler: [fromDashboard, signedIn, owner],
      schema: {
        params: userParams,
        body: {
          type: "object",
          required: ["password"],
          additionalProperties: false,
          properties: { password: { type: "string", minLength: 1, maxLength: 128 } },
        },
      },
    },
    async (request, reply) => {
      const tried = passwordTries.take(actorOf(request).id);
      if (!tried.allowed) {
        return reply
          .code(429)
          .header("retry-after", String(tried.retryAfterSeconds))
          .send(
            problem(
              "rate_limited",
              `Too many attempts. Retry after ${tried.retryAfterSeconds} seconds.`,
            ),
          );
      }
      const result = await transferOwnership(
        db,
        auth,
        actorOf(request).id,
        request.params.userId,
        request.body.password,
      );
      if (result === "wrong_password") {
        return reply
          .code(403)
          .send(problem("wrong_password", "The password is incorrect. Enter it again."));
      }
      return result === "not_found" ? reply.code(404).send(NO_MEMBER) : reply.code(204).send();
    },
  );

  app.post<{ Body: RoleBody & { email: string } }>(
    "/invitations",
    {
      preHandler: [fromDashboard, signedIn, manageMembers],
      schema: {
        body: {
          type: "object",
          required: ["email", "role"],
          additionalProperties: false,
          properties: {
            email: { type: "string", minLength: 3, maxLength: 320 },
            ...roleProperties,
          },
        },
      },
    },
    async (request, reply) => {
      const email = request.body.email.trim();
      // Match sign-in validation so invited accounts can sign in.
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
      const change = changeOf(request.body);
      if (change === null) return reply.code(400).send(ACCESS_REQUIRED);
      const actor = actorOf(request);
      if (!invitationEmailAllowed(actor.id, reply)) return reply;
      const created = await createInvitation(db, actor, email, change, now());
      // A refusal sends nothing: it spends none of the actor's emails.
      if (typeof created === "string" && emailConfigured) invitationEmails.refund(actor.id, 1);
      if (created === "forbidden") return reply.code(403).send(FORBIDDEN);
      if (created === "account_exists") {
        return reply
          .code(409)
          .send(problem("account_exists", "Someone with this email already has an account."));
      }
      if (emailConfigured) await emailInvitation(created.invitation, created.token);
      return reply.code(201).send({
        invitation: created.invitation,
        url: inviteUrl(created.token),
        emailed: emailConfigured,
      });
    },
  );

  app.post<{ Params: { invitationId: string } }>(
    "/invitations/:invitationId/link",
    { preHandler: [fromDashboard, signedIn, manageMembers], schema: { params: invitationParams } },
    async (request, reply) => {
      const actor = actorOf(request);
      if (!invitationEmailAllowed(actor.id, reply)) return reply;
      const renewed = await renewInvitation(db, actor, request.params.invitationId, now());
      if (typeof renewed === "string" && emailConfigured) invitationEmails.refund(actor.id, 1);
      if (renewed === "not_found") return reply.code(404).send(NO_INVITATION);
      if (renewed === "forbidden") return reply.code(403).send(FORBIDDEN);
      if (emailConfigured) await emailInvitation(renewed.invitation, renewed.token);
      return {
        invitation: renewed.invitation,
        url: inviteUrl(renewed.token),
        emailed: emailConfigured,
      };
    },
  );

  app.delete<{ Params: { invitationId: string } }>(
    "/invitations/:invitationId",
    { preHandler: [fromDashboard, signedIn, manageMembers], schema: { params: invitationParams } },
    async (request, reply) =>
      answerOf(
        await revokeInvitation(db, actorOf(request), request.params.invitationId),
        reply,
        NO_INVITATION,
      ),
  );

  const tokenBody = {
    type: "object",
    required: ["token"],
    additionalProperties: false,
    properties: { token: tokenSchema },
  } as const;

  app.post<{ Body: { token: string } }>(
    "/invite/preview",
    { onRequest: limited, schema: { body: tokenBody } },
    async (request, reply) => {
      const preview = await previewInvitation(db, request.body.token, now());
      return preview === null ? reply.code(404).send(INVITATION_GONE) : { invitation: preview };
    },
  );

  app.post<{ Body: { token: string; name: string; password: string; confirmPassword: string } }>(
    "/invite/accept",
    {
      onRequest: limited,
      schema: {
        body: {
          type: "object",
          required: ["token", "name", "password", "confirmPassword"],
          additionalProperties: false,
          properties: {
            token: tokenSchema,
            name: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
            ...newPasswordProperties,
          },
        },
      },
    },
    async (request, reply) => {
      const { token, name, password, confirmPassword } = request.body;
      if (password !== confirmPassword) return reply.code(400).send(PASSWORDS_DIFFER);
      const accepted = await acceptInvitation(
        db,
        auth,
        { token, name: name.trim(), password },
        now(),
      );
      return accepted === null
        ? reply.code(404).send(INVITATION_GONE)
        : reply.code(201).send(accepted);
    },
  );

  app.post<{ Body: { token: string } }>(
    "/reset-password/preview",
    { onRequest: limited, schema: { body: tokenBody } },
    async (request, reply) => {
      const preview = await previewPasswordReset(db, request.body.token, now());
      return preview === null ? reply.code(404).send(RESET_GONE) : preview;
    },
  );

  app.post<{ Body: { token: string; password: string; confirmPassword: string } }>(
    "/reset-password",
    {
      onRequest: limited,
      schema: {
        body: {
          type: "object",
          required: ["token", "password", "confirmPassword"],
          additionalProperties: false,
          properties: { token: tokenSchema, ...newPasswordProperties },
        },
      },
    },
    async (request, reply) => {
      const { token, password, confirmPassword } = request.body;
      if (password !== confirmPassword) return reply.code(400).send(PASSWORDS_DIFFER);
      const used = await usePasswordReset(db, auth, token, password, now());
      if (used === null) return reply.code(404).send(RESET_GONE);
      if (emailConfigured) {
        await enqueueAccountEmail(
          db,
          { kind: "password_changed", to: used.email, params: {} },
          linkSealer(),
        );
      }
      return used;
    },
  );

  const requestLimited = async (request: FastifyRequest, reply: FastifyReply) => {
    const result = requestsByAddress.take(clientKey(request.ip));
    if (result.allowed) return undefined;
    return reply
      .code(429)
      .header("retry-after", String(result.retryAfterSeconds))
      .send(RESET_REQUESTS_LIMITED);
  };

  app.post<{ Body: { email: string } }>(
    "/reset-password/request",
    {
      onRequest: requestLimited,
      bodyLimit: 4096,
      schema: {
        body: {
          type: "object",
          required: ["email"],
          additionalProperties: false,
          properties: { email: { type: "string", minLength: 3, maxLength: 320 } },
        },
      },
    },
    async (request, reply) => {
      if (!emailConfigured) return reply.code(404).send(NO_EMAIL);
      // As sign-in looks addresses up, and as accounts store them.
      const email = request.body.email.trim().toLowerCase();
      if (!canSignInWith(email)) return reply.code(400).send(INVALID_EMAIL);
      // Check instance first to bound queued rows and per-email limiter memory.
      // Count an email only after the instance limit passes.
      for (const take of [
        () => requestsOfInstance.take("instance"),
        () => requestsByEmail.take(emailKey(email)),
      ]) {
        const result = take();
        if (!result.allowed) {
          return reply
            .code(429)
            .header("retry-after", String(result.retryAfterSeconds))
            .send(RESET_REQUESTS_LIMITED);
        }
      }
      // Queue the same insert for every address to avoid revealing accounts. The worker
      // looks up accounts and sends only when one exists.
      await enqueueAccountEmail(
        db,
        { kind: "password_reset", to: email, params: {} },
        linkSealer(),
      );
      return reply.code(202).send(RESET_REQUESTED);
    },
  );

  done();
};
