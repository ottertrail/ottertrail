import { randomUUID } from "node:crypto";

import type { Kysely } from "kysely";

import type { Database } from "../db/schema.ts";
import { forgetInstanceSettings } from "../settings/settings.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { CONTENT_TYPES, IMAGE_KINDS, type ImageKind } from "./images.ts";

/**
 * Store avatars under random names so replacements get new URLs that browsers can cache
 * indefinitely (docs/dashboard.md, "Avatars"). PostgreSQL holds the current key; the API serves
 * only that key.
 *
 * Paths: avatars/instance/<uuid>.png, avatars/users/<userId>/<uuid>.png,
 * avatars/projects/<projectId>/<uuid>.png, and
 * avatars/projects/<projectId>/favicon-<uuid>.<png|ico|jpg|webp|gif>.
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

export const avatarUrlOf = (key: string | null): string | null =>
  key === null ? null : `/api/${key}`;

export function contentTypeOf(key: string): string {
  const extension = key.slice(key.lastIndexOf(".") + 1);
  const kind = IMAGE_KINDS.find((known) => known === extension);
  return kind === undefined ? "image/png" : CONTENT_TYPES[kind];
}

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
 * Lock the owner row while replacing its key. Return the old key, or undefined if the owner was
 * deleted.
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

/** Log deletion failures without failing the request. */
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

/** Delete a removed user's avatar prefix after their row is gone. Log failures. */
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
