import { createHash, randomBytes } from "node:crypto";

/**
 * 32 random bytes resist guessing; store only the SHA-256 hash. Setup, invitation,
 * and reset links keep tokens in fragments (#token=…), which browsers never send
 * to the server.
 */
export const hashToken = (token: string): Buffer => createHash("sha256").update(token).digest();

export function newToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}
