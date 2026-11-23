import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import { reachOf, requirePermission, userAccessOf } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import type { Database } from "../db/schema.ts";
import {
  DEFAULT_INBOX_PAGE,
  listInbox,
  markAllRead,
  markItem,
  MAX_INBOX_PAGE,
  unreadCount,
} from "./inbox.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const NOT_FOUND = {
  error: "notification_not_found",
  message: "You have no notification with this ID.",
} as const;

/**
 * Inbox routes (inbox.ts). Check current access with reachOf on every read and change
 * (access/access.ts). Changes require the dashboard's origin.
 */
export const inboxRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  trustedOrigins: readonly string[];
  now?: () => Date;
}> = (app, { db, auth, trustedOrigins, now = () => new Date() }, done) => {
  const signedIn = requireSession(auth);
  const anyUser = requirePermission(db, "signed_in");
  const fromDashboard = requireTrustedOrigin(trustedOrigins);

  app.get<{
    Querystring: { filter?: "all" | "unread"; before?: string; limit?: number };
  }>(
    "/notifications",
    {
      preHandler: [signedIn, anyUser],
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            filter: { type: "string", enum: ["all", "unread"] },
            before: { type: "string", pattern: UUID_PATTERN },
            limit: { type: "integer", minimum: 1, maximum: MAX_INBOX_PAGE },
          },
        },
      },
    },
    async (request) => {
      const reach = reachOf(userAccessOf(request));
      const at = now();
      const [page, unread] = await Promise.all([
        listInbox(db, reach, {
          before: request.query.before,
          limit: request.query.limit ?? DEFAULT_INBOX_PAGE,
          unread: request.query.filter === "unread",
          now: at,
        }),
        unreadCount(db, reach, at),
      ]);
      return { notifications: page.items, next: page.next, unread };
    },
  );

  app.get("/notifications/unread-count", { preHandler: [signedIn, anyUser] }, async (request) => ({
    unread: await unreadCount(db, reachOf(userAccessOf(request)), now()),
  }));

  app.patch<{ Params: { notificationId: string }; Body: { read: boolean } }>(
    "/notifications/:notificationId",
    {
      preHandler: [fromDashboard, signedIn, anyUser],
      schema: {
        params: {
          type: "object",
          required: ["notificationId"],
          properties: { notificationId: { type: "string", pattern: UUID_PATTERN } },
        },
        body: {
          type: "object",
          required: ["read"],
          additionalProperties: false,
          properties: { read: { type: "boolean" } },
        },
      },
    },
    async (request, reply) => {
      const reach = reachOf(userAccessOf(request));
      const { notificationId } = request.params;
      if (!(await markItem(db, reach, notificationId, request.body.read, now()))) {
        return reply.code(404).send(NOT_FOUND);
      }
      return { id: notificationId, read: request.body.read };
    },
  );

  app.post(
    "/notifications/read-all",
    { preHandler: [fromDashboard, signedIn, anyUser] },
    async (request) => ({ marked: await markAllRead(db, reachOf(userAccessOf(request)), now()) }),
  );

  done();
};
