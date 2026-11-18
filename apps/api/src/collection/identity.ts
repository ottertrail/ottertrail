import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Known users: a site says which of its users is signed in, and every event
 * from then on carries that user's ID (docs/web-analytics.md, section 2).
 * The ID is the site's own, such as its database ID for the user; the docs
 * ask for that rather than an email address.
 */

/**
 * 1 to 200 characters, no control characters (C0, DEL, and C1). Anything
 * else gets a 400.
 */
export const USER_ID_PATTERN = "^[^\\u0000-\\u001F\\u007F-\\u009F]{1,200}$";

/**
 * A user ID's signature: HMAC-SHA256 of the ID (UTF-8) with the project's
 * secret key, in hex. Either case: some libraries write upper case.
 */
export const USER_SIGNATURE_PATTERN = "^[0-9a-fA-F]{64}$";

/** The signature a site's server makes for a user ID, in lower-case hex (docs/web-analytics.md, "Signed user IDs"). */
export function signUserId(secretKey: string, userId: string): string {
  return createHmac("sha256", secretKey).update(userId, "utf8").digest("hex");
}

/** Whether `signature` is the project's signature for `userId`; compared in constant time. */
export function isSignedUserId(
  secretKey: string,
  userId: string,
  signature: string | undefined,
): boolean {
  if (signature === undefined || !/^[0-9a-fA-F]{64}$/.test(signature)) return false;
  return timingSafeEqual(
    Buffer.from(signUserId(secretKey, userId), "hex"),
    Buffer.from(signature, "hex"),
  );
}
