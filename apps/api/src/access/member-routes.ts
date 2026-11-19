import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import { type Auth, canSignInWith } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { newPasswordProperties, PASSWORDS_DIFFER, requireSession } from "../auth/routes.ts";
import { clientKey, type RateLimit, TokenBucketLimiter } from "../collection/rate-limiter.ts";
import type { Database } from "../db/schema.ts";
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

/** Handing over ownership checks the owner's password: 5 tries, then one a minute, per user. */
export const OWNERSHIP_LIMIT: RateLimit = { capacity: 5, refillPerSecond: 1 / 60 };

const problem = (error: string, message: string) => ({ error, message });
const NO_MEMBER = problem("member_not_found", "This instance has no user with this ID.");
const NO_INVITATION = problem("invitation_not_found", "No pending invitation has this ID.");
const INVITATION_GONE = problem(
  "invalid_link",
  "This invitation link no longer works. Ask for a new one.",
);
const RESET_GONE = problem("invalid_link", "This reset link no longer works. Ask for a new one.");

const accessSchema = {
  type: "object",
  required: ["projects", "areas"],
  additionalProperties: false,
  properties: {
    // anyOf, the text first: Fastify's validator coerces types, and would
    // turn "all" into ["all"] if it tried the array first.
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

/** What a body gives, or null for a member without their access. */
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

/** Who acts: the signed-in user, as the permission check read them. */
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
 * Members, invitations, reset links, and handing over ownership
 * (docs/access.md).
 *
 * For the owner and admins (`members`), within the role rules of members.ts:
 *   GET    /api/members                         users and pending invitations
 *   PATCH  /api/members/:userId                 { role, access? }
 *   DELETE /api/members/:userId
 *   POST   /api/members/:userId/reset-link      a one-time link, valid 24 hours
 *   POST   /api/invitations                     { email, role, access? }: a link to copy
 *   POST   /api/invitations/:invitationId/link  a new link; the old one stops working
 *   DELETE /api/invitations/:invitationId
 * For the owner only (`ownership`):
 *   POST   /api/members/:userId/ownership       { password }
 * Public, limited per client address, the token in the body:
 *   POST   /api/invite/preview                  { token }: who invited, to what
 *   POST   /api/invite/accept                   { token, name, password, confirmPassword }
 *   POST   /api/reset-password/preview          { token }: whose password
 *   POST   /api/reset-password                  { token, password, confirmPassword }
 *
 * Links are copied and sent by whoever made them: installs are not expected
 * to have email. Each carries its token in the fragment, which browsers
 * never send to a server.
 */
export const memberRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  trustedOrigins: readonly string[];
  publicUrl: string;
  linkLimit?: RateLimit;
  now?: () => Date;
}> = (
  app,
  { db, auth, trustedOrigins, publicUrl, linkLimit = DEFAULT_LINK_LIMIT, now = () => new Date() },
  done,
) => {
  const signedIn = requireSession(auth);
  const fromDashboard = requireTrustedOrigin(trustedOrigins);
  const manageMembers = requirePermission(db, "members");
  const owner = requirePermission(db, "ownership");
  const limiter = new TokenBucketLimiter(linkLimit);
  const passwordTries = new TokenBucketLimiter(OWNERSHIP_LIMIT);

  const inviteUrl = (token: string) => `${publicUrl}/invite#token=${token}`;
  const resetUrl = (token: string) => `${publicUrl}/reset-password#token=${token}`;

  // Before the body is read or checked, as setup does.
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
    async (request, reply) =>
      answerOf(await removeMember(db, actorOf(request), request.params.userId), reply, NO_MEMBER),
  );

  app.post<{ Params: { userId: string } }>(
    "/members/:userId/reset-link",
    { preHandler: [fromDashboard, signedIn, manageMembers], schema: { params: userParams } },
    async (request, reply) => {
      // Admins reset members; the owner resets anyone else.
      const made = await makeResetLink(db, actorOf(request), request.params.userId, now());
      if (made === "not_found") return reply.code(404).send(NO_MEMBER);
      if (made === "forbidden") return reply.code(403).send(FORBIDDEN);
      return reply.code(201).send({ url: resetUrl(made.token), expiresAt: made.expiresAt });
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
      // The check sign-in makes: an account it refuses could never sign in.
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
      const created = await createInvitation(db, actorOf(request), email, change, now());
      if (created === "forbidden") return reply.code(403).send(FORBIDDEN);
      if (created === "account_exists") {
        return reply
          .code(409)
          .send(problem("account_exists", "Someone with this email already has an account."));
      }
      return reply
        .code(201)
        .send({ invitation: created.invitation, url: inviteUrl(created.token) });
    },
  );

  app.post<{ Params: { invitationId: string } }>(
    "/invitations/:invitationId/link",
    { preHandler: [fromDashboard, signedIn, manageMembers], schema: { params: invitationParams } },
    async (request, reply) => {
      const renewed = await renewInvitation(
        db,
        actorOf(request),
        request.params.invitationId,
        now(),
      );
      if (renewed === "not_found") return reply.code(404).send(NO_INVITATION);
      if (renewed === "forbidden") return reply.code(403).send(FORBIDDEN);
      return { invitation: renewed.invitation, url: inviteUrl(renewed.token) };
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
      return used === null ? reply.code(404).send(RESET_GONE) : used;
    },
  );

  done();
};
