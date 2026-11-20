import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Seals the links queued account emails carry (account-emails.ts), so a
 * dump of the database taken while one waits holds no working invitation
 * or reset link: AES-256-GCM, with a key derived from AUTH_SECRET by HKDF.
 * Whoever has AUTH_SECRET as well can open them; changing AUTH_SECRET
 * makes the queued ones unreadable, and those emails are given up.
 *
 * A sealed link is bound to its email's kind and address (the GCM
 * additional data), so it cannot be moved to another row.
 */
export class LinkSealer {
  readonly #key: Buffer;

  constructor(secret: string) {
    if (secret.length === 0) throw new Error("LinkSealer needs a secret");
    this.#key = Buffer.from(
      hkdfSync("sha256", secret, Buffer.alloc(0), "ottertrail account email links v1", 32),
    );
  }

  seal(link: string, boundTo: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(boundTo, "utf8"));
    const body = Buffer.concat([cipher.update(link, "utf8"), cipher.final()]);
    return `v1.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url")}`;
  }

  /** The link, or null when it was not sealed with this secret for `boundTo`. */
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

/** What a sealed link is bound to: its email's kind and address. */
export const sealBinding = (kind: string, to: string) => `${kind}\n${to}`;
