import type { FastifyError, FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import {
  canReachProject,
  requirePermission,
  requireProjectAccess,
  userAccessOf,
} from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession, signedInUser } from "../auth/routes.ts";
import { type RateLimit, TokenBucketLimiter } from "../collection/rate-limiter.ts";
import type { Database } from "../db/schema.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import {
  type AvatarOwner,
  avatarUrlOf,
  contentTypeOf,
  deleteQuietly,
  newKeyFor,
  setAvatarKey,
} from "./avatars.ts";
import { isPngWithin } from "./images.ts";

/** The largest upload: the dashboard sends a 256×256 PNG, far smaller. */
export const MAX_AVATAR_BYTES = 512 * 1024;
/** The widest and tallest upload, in pixels. */
export const MAX_AVATAR_PIXELS = 512;
/** Uploads per user, across the three PUT routes: 10, then one a minute. */
export const DEFAULT_AVATAR_UPLOAD_LIMIT: RateLimit = { capacity: 10, refillPerSecond: 1 / 60 };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const problem = (error: string, message: string) => ({ error, message });

export const OBJECT_STORE_NOT_SET_UP = problem(
  "object_store_not_set_up",
  "Uploads need object storage. Set OBJECT_STORE_URL on the server, then restart it.",
);
const INVALID_IMAGE = problem(
  "invalid_image",
  `Send a PNG of at most ${MAX_AVATAR_PIXELS}×${MAX_AVATAR_PIXELS} pixels, with Content-Type: image/png.`,
);
const TOO_LARGE = problem(
  "image_too_large",
  `An image has at most ${MAX_AVATAR_BYTES / 1024} KiB. Choose a smaller one.`,
);
const STORAGE_UNAVAILABLE = problem(
  "storage_unavailable",
  "The image could not be stored. Try again in a minute.",
);
const NO_AVATAR = problem("not_found", "No avatar has this address.");
const NO_PROJECT = problem("not_found", "No project has this ID.");

const fileParam = (pattern: string) => ({ type: "string", pattern }) as const;
const PNG_FILE = `^${UUID}\\.png$`;
const PROJECT_FILE = `^(${UUID}\\.png|favicon-${UUID}\\.(png|ico|jpg|webp|gif))$`;

async function pngBody(request: FastifyRequest, reply: FastifyReply) {
  const type = (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  const body = request.body;
  if (type !== "image/png" || !Buffer.isBuffer(body) || !isPngWithin(body, MAX_AVATAR_PIXELS)) {
    return reply.code(400).send(INVALID_IMAGE);
  }
  return undefined;
}

/**
 * Avatar routes (avatars.ts; docs/access.md, "Avatars"). Validate PNG bytes before touching
 * storage or rows. Store the new image before replacing the row's key, then delete the old
 * object. Without storage, changes return 409. Serve only keys still referenced by a row.
 */
export const avatarRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  trustedOrigins: readonly string[];
  store: ObjectStore | null;
  uploadLimit?: RateLimit;
}> = (app, { db, auth, trustedOrigins, store, uploadLimit }, done) => {
  const signedIn = requireSession(auth);
  const fromDashboard = requireTrustedOrigin(trustedOrigins);
  const owner = requirePermission(db, "settings");
  const anyUser = requirePermission(db, "signed_in");
  const manageProject = requireProjectAccess(db, { permission: "projects" });
  const uploads = new TokenBucketLimiter(uploadLimit ?? DEFAULT_AVATAR_UPLOAD_LIMIT);

  // Parse all bodies as bytes so pngBody returns the same error for invalid uploads.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer", bodyLimit: MAX_AVATAR_BYTES },
    (_request, body, parsed) => {
      parsed(null, body);
    },
  );
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") return reply.code(413).send(TOO_LARGE);
    if (error.code === "FST_ERR_CTP_EMPTY_JSON_BODY" || error.statusCode === 415) {
      return reply.code(400).send(INVALID_IMAGE);
    }
    if (error.validation !== undefined || (error.statusCode ?? 500) < 500) {
      return reply.code(error.statusCode ?? 400).send(error);
    }
    request.log.error({ err: error }, "an avatar request failed");
    return reply.code(500).send(problem("internal", "Something went wrong. Try again."));
  });

  const storeReady = async (_request: FastifyRequest, reply: FastifyReply) => {
    if (store === null) return reply.code(409).send(OBJECT_STORE_NOT_SET_UP);
    return undefined;
  };

  async function upload(request: FastifyRequest, reply: FastifyReply, of: AvatarOwner) {
    const body = request.body;
    if (store === null || !Buffer.isBuffer(body))
      throw new Error("storeReady and pngBody run first");
    const taken = uploads.take(signedInUser(request).id);
    if (!taken.allowed) {
      return reply
        .code(429)
        .header("retry-after", String(taken.retryAfterSeconds))
        .send(
          problem(
            "rate_limited",
            `Too many uploads. Try again in ${Math.ceil(taken.retryAfterSeconds / 60)} minutes.`,
          ),
        );
    }
    const key = newKeyFor(of);
    try {
      await store.put(key, body, "image/png");
    } catch (error) {
      request.log.error({ err: error }, "the object store refused an avatar");
      return reply.code(503).header("retry-after", "30").send(STORAGE_UNAVAILABLE);
    }
    let set;
    try {
      set = await setAvatarKey(db, of, key);
    } catch (error) {
      await deleteQuietly(store, [key], request.log);
      throw error;
    }
    if (set === undefined) {
      await deleteQuietly(store, [key], request.log);
      return reply.code(404).send(of.kind === "project" ? NO_PROJECT : NO_AVATAR);
    }
    await deleteQuietly(store, [set.old], request.log);
    return key;
  }

  async function remove(request: FastifyRequest, reply: FastifyReply, of: AvatarOwner) {
    if (store === null) throw new Error("storeReady runs first");
    const set = await setAvatarKey(db, of, null);
    if (set === undefined) {
      return reply.code(404).send(of.kind === "project" ? NO_PROJECT : NO_AVATAR);
    }
    await deleteQuietly(store, [set.old], request.log);
    return null;
  }

  const uploadOptions = (access: typeof owner) => ({
    preHandler: [fromDashboard, signedIn, access, storeReady, pngBody],
    bodyLimit: MAX_AVATAR_BYTES,
  });
  const removeOptions = (access: typeof owner) => ({
    preHandler: [fromDashboard, signedIn, access, storeReady],
  });

  app.put("/settings/avatar", uploadOptions(owner), async (request, reply) => {
    const key = await upload(request, reply, { kind: "instance" });
    return typeof key === "string" ? { avatarUrl: avatarUrlOf(key) } : key;
  });
  app.delete("/settings/avatar", removeOptions(owner), async (request, reply) => {
    const result = await remove(request, reply, { kind: "instance" });
    return result === null ? { avatarUrl: null } : result;
  });

  app.put("/account/avatar", uploadOptions(anyUser), async (request, reply) => {
    const key = await upload(request, reply, { kind: "user", userId: signedInUser(request).id });
    return typeof key === "string" ? { avatarUrl: avatarUrlOf(key) } : key;
  });
  app.delete("/account/avatar", removeOptions(anyUser), async (request, reply) => {
    const result = await remove(request, reply, { kind: "user", userId: signedInUser(request).id });
    return result === null ? { avatarUrl: null } : result;
  });

  async function projectAvatar(projectId: string) {
    const row = await db
      .selectFrom("projects")
      .select(["avatar_key", "favicon_key"])
      .where("id", "=", projectId)
      .executeTakeFirst();
    return {
      iconUrl: avatarUrlOf(row?.avatar_key ?? null),
      avatarUrl: avatarUrlOf(row?.avatar_key ?? row?.favicon_key ?? null),
    };
  }

  const projectParams = {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", pattern: UUID_PATTERN } },
  } as const;

  app.put<{ Params: { id: string } }>(
    "/projects/:id/avatar",
    { ...uploadOptions(manageProject), schema: { params: projectParams } },
    async (request, reply) => {
      const projectId = request.params.id.toLowerCase();
      const key = await upload(request, reply, { kind: "project", projectId });
      return typeof key === "string" ? projectAvatar(projectId) : key;
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/projects/:id/avatar",
    { ...removeOptions(manageProject), schema: { params: projectParams } },
    async (request, reply) => {
      const projectId = request.params.id.toLowerCase();
      const result = await remove(request, reply, { kind: "project", projectId });
      return result === null ? projectAvatar(projectId) : result;
    },
  );

  async function serve(reply: FastifyReply, key: string | null | undefined, wanted: string) {
    if (store === null || key !== wanted) return reply.code(404).send(NO_AVATAR);
    const bytes = await store.get(key);
    if (bytes === null) return reply.code(404).send(NO_AVATAR);
    return reply
      .header("content-type", contentTypeOf(key))
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "private, max-age=31536000, immutable")
      .send(Buffer.from(bytes));
  }

  app.get<{ Params: { file: string } }>(
    "/avatars/instance/:file",
    {
      preHandler: [signedIn, anyUser],
      schema: {
        params: {
          type: "object",
          required: ["file"],
          properties: { file: fileParam(PNG_FILE) },
        },
      },
    },
    async (request, reply) => {
      const row = await db.selectFrom("instance_settings").select("avatar_key").executeTakeFirst();
      return serve(reply, row?.avatar_key, `avatars/instance/${request.params.file}`);
    },
  );

  app.get<{ Params: { userId: string; file: string } }>(
    "/avatars/users/:userId/:file",
    {
      preHandler: [signedIn, anyUser],
      schema: {
        params: {
          type: "object",
          required: ["userId", "file"],
          properties: { userId: fileParam(`^${UUID}$`), file: fileParam(PNG_FILE) },
        },
      },
    },
    async (request, reply) => {
      const { userId, file } = request.params;
      const row = await db
        .selectFrom("dashboard_users")
        .select("avatar_key")
        .where("id", "=", userId)
        .executeTakeFirst();
      return serve(reply, row?.avatar_key, `avatars/users/${userId}/${file}`);
    },
  );

  app.get<{ Params: { projectId: string; file: string } }>(
    "/avatars/projects/:projectId/:file",
    {
      preHandler: [signedIn, anyUser],
      schema: {
        params: {
          type: "object",
          required: ["projectId", "file"],
          properties: { projectId: fileParam(`^${UUID}$`), file: fileParam(PROJECT_FILE) },
        },
      },
    },
    async (request, reply) => {
      const { projectId, file } = request.params;
      // A project the user may not reach answers as one without an avatar.
      if (!canReachProject(userAccessOf(request), projectId)) {
        return reply.code(404).send(NO_AVATAR);
      }
      const row = await db
        .selectFrom("projects")
        .select(["avatar_key", "favicon_key"])
        .where("id", "=", projectId)
        .executeTakeFirst();
      const wanted = `avatars/projects/${projectId}/${file}`;
      const key = file.startsWith("favicon-") ? row?.favicon_key : row?.avatar_key;
      return serve(reply, key, wanted);
    },
  );

  done();
};
