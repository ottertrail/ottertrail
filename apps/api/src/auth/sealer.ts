import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * AES-256-GCM uses a purpose-specific HKDF key derived from AUTH_SECRET.
 * Database dumps need AUTH_SECRET to decrypt; rotating it makes sealed values
 * unreadable. GCM additional data binds each value to its row or field.
 * Used by notifications/link-sealer.ts and backups/secrets.ts.
 */
export class Sealer {
  readonly #key: Buffer;

  constructor(secret: string, info: string) {
    if (secret.length === 0) throw new Error("A sealer needs a secret");
    this.#key = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), info, 32));
  }

  seal(text: string, boundTo: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(boundTo, "utf8"));
    const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return `v1.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url")}`;
  }

  /** The text, or null when it was not sealed with this secret for `boundTo`. */
  open(sealed: string, boundTo: string): string | null {
    if (!sealed.startsWith("v1.")) return null;
    const bytes = Buffer.from(sealed.slice(3), "base64url");
    if (bytes.length < 12 + 16 + 1) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(boundTo, "utf8"));
      decipher.setAuthTag(bytes.subarray(bytes.length - 16));
      return Buffer.concat([
        decipher.update(bytes.subarray(12, bytes.length - 16)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      return null;
    }
  }
}
