import { generateX25519Identity, identityToRecipient } from "age-encryption";

import { Sealer } from "../auth/sealer.ts";

/** What each sealed value is bound to (the GCM additional data). */
const SECRET_BINDING = "backups: secret access key";
const KEY_BINDING = "backups: backup key";

/**
 * The backups' two stored secrets, sealed with a key derived from
 * AUTH_SECRET (auth/sealer.ts), as queued account email links are:
 *
 * - a separate destination's secret access key, which the API and the
 *   worker open to sign S3 requests and never return;
 * - the backup key, an age X25519 identity ("AGE-SECRET-KEY-1…"), which
 *   the owner can view and download (backups/routes.ts), and which the
 *   worker opens to check a backup (Test restore). Backups are encrypted
 *   to its public half, the recipient ("age1…"), which is not secret.
 *
 * Whoever has a database dump and AUTH_SECRET can open both; with a
 * dump alone, neither. A changed AUTH_SECRET makes both unreadable: the
 * Backups tab then asks for the secret again and offers a new key.
 */
export class BackupSecrets {
  readonly #sealer: Sealer;

  constructor(authSecret: string) {
    this.#sealer = new Sealer(authSecret, "ottertrail stored secrets v1");
  }

  sealSecret(secret: string): string {
    return this.#sealer.seal(secret, SECRET_BINDING);
  }

  /** The secret access key, or null when AUTH_SECRET changed since it was saved. */
  openSecret(sealed: string): string | null {
    return this.#sealer.open(sealed, SECRET_BINDING);
  }

  sealKey(identity: string): string {
    return this.#sealer.seal(identity, KEY_BINDING);
  }

  /** The backup key, or null when AUTH_SECRET changed since it was made. */
  openKey(sealed: string): string | null {
    return this.#sealer.open(sealed, KEY_BINDING);
  }
}

/** A new backup key: an age X25519 identity and its recipient. */
export async function makeBackupKey(): Promise<{ identity: string; recipient: string }> {
  const identity = await generateX25519Identity();
  return { identity, recipient: await identityToRecipient(identity) };
}

/**
 * The key as a file: age's identity file format, with comments, so
 * `age -d -i <file>` reads it as it is, and deploy/restore.sh too.
 */
export function keyFileText({
  identity,
  recipient,
  instanceName,
  createdAt,
}: {
  identity: string;
  recipient: string;
  instanceName: string;
  createdAt: Date;
}): string {
  // A name with a line break would end the comment.
  const name = instanceName.replace(/[\r\n]+/g, " ");
  return [
    `# Ottertrail backup key for ${name}`,
    `# created: ${createdAt.toISOString()}`,
    `# public key: ${recipient}`,
    "# Keep this file off the server: without it, the backups cannot be read.",
    "# Decrypt a backup part with: age -d -i <this file> -o <part> <part>.age",
    identity,
    "",
  ].join("\n");
}

/** The file's name when downloaded. */
export function keyFileName(instanceName: string): string {
  const slug = instanceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `ottertrail-backup-key${slug === "" ? "" : `-${slug}`}.txt`;
}
