import type { DirtyForm } from "@/hooks/use-dirty-form";

import { apiRequest, expectShape } from "./api";

/**
 * Avatars (docs/dashboard.md, "Avatars"): the instance's icon, a user's
 * avatar, and a project's icon. The browser turns the chosen image into a
 * 256×256 PNG before it is sent; the API takes only that.
 */

/** The side of the PNG the browser sends. */
export const AVATAR_SIZE = 256;

/** The images the file picker offers and the browser converts. Never SVG. */
export const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const isAcceptedType = (type: string) => AVATAR_TYPES.some((accepted) => accepted === type);

/**
 * The image as a 256×256 PNG, cropped to its centre square, as a data:
 * URL: the dashboard's Content-Security-Policy shows data: images, not
 * blob: ones, so the preview uses the same. Rejects with a sentence when
 * the browser cannot read the file.
 */
export async function avatarDataUrl(file: Blob): Promise<string> {
  const unreadable = new Error(
    "This file can't be read as an image. Choose a PNG, JPEG, WebP, or GIF.",
  );
  if (!isAcceptedType(file.type)) throw unreadable;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw unreadable;
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (side === 0) throw unreadable;
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const context = canvas.getContext("2d");
    if (context === null) throw unreadable;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_SIZE,
      AVATAR_SIZE,
    );
    return canvas.toDataURL("image/png");
  } finally {
    bitmap.close();
  }
}

/** Whether an avatar field's value is a chosen image not yet saved. */
export const isChosenImage = (value: string | null): value is string =>
  value?.startsWith("data:image/png;base64,") === true;

/** The PNG a chosen image's data: URL holds. */
export function pngOf(dataUrl: string): Blob {
  const text = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: "image/png" });
}

const isUrlOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

/** An upload's answer: the new address (`iconUrl` for a project's icon, else `avatarUrl`). */
const isAvatarAnswer = (
  value: unknown,
): value is { avatarUrl: string | null; iconUrl?: string | null } =>
  typeof value === "object" &&
  value !== null &&
  "avatarUrl" in value &&
  isUrlOrNull(value.avatarUrl) &&
  (!("iconUrl" in value) || isUrlOrNull(value.iconUrl));

/**
 * Saves an avatar field's value and answers the address now saved: a
 * chosen image is uploaded, null removes the avatar, and a saved address
 * is no change and sends nothing. `path` is the route:
 * /api/settings/avatar, /api/account/avatar, or /api/projects/:id/avatar.
 */
export async function saveAvatar(path: string, value: string | null): Promise<string | null> {
  if (value === null) {
    await apiRequest(path, { method: "DELETE" });
    return null;
  }
  if (!isChosenImage(value)) return value;
  const answer = expectShape(
    await apiRequest(path, { method: "PUT", raw: { data: pngOf(value), type: "image/png" } }),
    isAvatarAnswer,
  );
  return answer.iconUrl === undefined ? answer.avatarUrl : answer.iconUrl;
}

/**
 * A form's first step on Save: sends its `avatar` when it changed, and
 * marks it saved at once with the address the server answered, in the
 * saved values and in the field (unless it was edited meanwhile), so a
 * later failure of the rest keeps only the other edits, and saving again
 * sends no image. Answers the values with that address, for the form's
 * final `saved`.
 */
export async function saveAvatarFirst<T extends { avatar: string | null }>(
  form: DirtyForm<T>,
  values: T,
  path: string,
): Promise<T> {
  const before = form.initial;
  if (values.avatar === before.avatar) return values;
  const avatar = await saveAvatar(path, values.avatar);
  form.saved({ ...before, avatar });
  form.setValues((current) =>
    current.avatar === values.avatar ? { ...current, avatar } : current,
  );
  return { ...values, avatar };
}
