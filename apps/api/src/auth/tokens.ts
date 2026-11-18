import { createHash, randomBytes } from "node:crypto";

/**
 * One-time link tokens: setup, invitations, and password resets. A token
 * is 32 random bytes, so guessing one is not feasible; the database keeps
 * only its SHA-256 hash, so reading the database reveals no working link.
 * Links carry the token in their fragment (#token=…), which browsers never
 * send to a server.
 */
export const hashToken = (token: string): Buffer => createHash("sha256").update(token).digest();

/** A new token, and the hash to store. */
export function newToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}
