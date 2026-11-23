import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

/** Use the site's user ID rather than an email address (docs/web-analytics.md, section 2). */

export const USER_ID_PATTERN = "^[^\\u0000-\\u001F\\u007F-\\u009F]{1,200}$";

/** HMAC-SHA256 of the UTF-8 user ID with the project secret key. Accepts either hex case. */
export const USER_SIGNATURE_PATTERN = "^[0-9a-fA-F]{64}$";

/** The signature a site's server makes for a user ID, in lower-case hex (docs/web-analytics.md, "Signed user IDs"). */
export function signUserId(secretKey: string, userId: string): string {
  return createHmac("sha256", secretKey).update(userId, "utf8").digest("hex");
}

/** Compares signatures in constant time. */
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
