import { randomUUID } from "node:crypto";

import type { Kysely } from "kysely";

import type { Database } from "../db/schema.ts";
import { forgetInstanceSettings } from "../settings/settings.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { CONTENT_TYPES, IMAGE_KINDS, type ImageKind } from "./images.ts";

/**
 * Avatars (docs/dashboard.md, "Avatars"): the instance's icon, each
 * dashboard user's avatar, and each project's icon, uploaded as PNGs, and
 * each project's site's favicon, which the worker fetches (favicons.ts).
 * They are in the object store under `avatars/`, each under a new random
 * name, so its URL changes when it is replaced and browsers may cache it
 * for good. PostgreSQL holds the current key; the API serves only that one.
 *
 *   avatars/instance/<uuid>.png
 *   avatars/users/<userId>/<uuid>.png
 *   avatars/projects/<projectId>/<uuid>.png
 *   avatars/projects/<projectId>/favicon-<uuid>.<png|ico|jpg|webp|gif>
 */

export const AVATAR_PREFIX = "avatars/";

/** Where a user's avatars are: deleted with the user. */
export const userAvatarPrefix = (userId: string) => `avatars/users/${userId}/`;
/** Where a project's icon and favicon are: deleted with the project. */
export const projectAvatarPrefix = (projectId: string) => `avatars/projects/${projectId}/`;

export const newInstanceKey = () => `avatars/instance/${randomUUID()}.png`;
export const newUserKey = (userId: string) => `${userAvatarPrefix(userId)}${randomUUID()}.png`;
export const newProjectKey = (projectId: string) =>
  `${projectAvatarPrefix(projectId)}${randomUUID()}.png`;
export const newFaviconKey = (projectId: string, kind: ImageKind) =>
  `${projectAvatarPrefix(projectId)}favicon-${randomUUID()}.${kind}`;

/** The address the dashboard loads an avatar from; null without one. */
export const avatarUrlOf = (key: string | null): string | null =>
  key === null ? null : `/api/${key}`;

/** An avatar's Content-Type, from the extension its key was made with. */
export function contentTypeOf(key: string): string {
  const extension = key.slice(key.lastIndexOf(".") + 1);
  const kind = IMAGE_KINDS.find((known) => known === extension);
  return kind === undefined ? "image/png" : CONTENT_TYPES[kind];
}

/** What an avatar belongs to: the row its key is kept in. */
export type AvatarOwner =
  | { kind: "instance" }
  | { kind: "user"; userId: string }
  | { kind: "project"; projectId: string };

export function newKeyFor(owner: AvatarOwner): string {
  if (owner.kind === "instance") return newInstanceKey();
  if (owner.kind === "user") return newUserKey(owner.userId);
  return newProjectKey(owner.projectId);
}

/**
 * Sets the owner's uploaded avatar key (null to remove it) in one
 * transaction, the row locked, and answers the key it replaced; undefined
 * when the row is gone (a user removed, a project deleted, meanwhile).
 */
export async function setAvatarKey(
  db: Kysely<Database>,
  owner: AvatarOwner,
  key: string | null,
): Promise<{ old: string | null } | undefined> {
  const result = await db.transaction().execute(async (trx) => {
    if (owner.kind === "instance") {
      const row = await trx
        .selectFrom("instance_settings")
        .select("avatar_key")
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return undefined;
      await trx.updateTable("instance_settings").set({ avatar_key: key }).execute();
      return { old: row.avatar_key };
    }
    const table = owner.kind === "user" ? "dashboard_users" : "projects";
    const id = owner.kind === "user" ? owner.userId : owner.projectId;
    const row = await trx
      .selectFrom(table)
      .select("avatar_key")
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) return undefined;
    await trx.updateTable(table).set({ avatar_key: key }).where("id", "=", id).execute();
    return { old: row.avatar_key };
  });
  // The instance's settings are cached; /api/me shows the new icon at once.
  if (owner.kind === "instance") forgetInstanceSettings(db);
  return result;
}

export interface AvatarLog {
  warn(fields: object, message: string): void;
}

/** Deletes objects nothing points to any more; a failure is logged, not answered. */
export async function deleteQuietly(
  store: ObjectStore,
  keys: readonly (string | null)[],
  log: AvatarLog,
): Promise<void> {
  const present = keys.filter((key): key is string => key !== null);
  if (present.length === 0) return;
  try {
    await store.delete(present);
  } catch (error) {
    log.warn({ err: error, keys: present }, "could not delete replaced avatars; they stay stored");
  }
}

/**
 * Deletes everything a removed user's avatars left under their prefix;
 * a failure is logged. The user's row is gone already.
 */
export async function deleteUserAvatars(
  store: ObjectStore | null,
  userId: string,
  log: AvatarLog,
): Promise<void> {
  if (store === null) return;
  try {
    await store.deletePrefix(userAvatarPrefix(userId));
  } catch (error) {
    log.warn({ err: error, userId }, "could not delete a removed user's avatar; it stays stored");
  }
}
