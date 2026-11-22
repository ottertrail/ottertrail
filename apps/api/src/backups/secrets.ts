import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

import { generateX25519Identity, identityToRecipient } from "age-encryption";

import { Sealer } from "../auth/sealer.ts";

/** What the sealed key is bound to (the GCM additional data). */
const KEY_BINDING = "backups: backup key";

/**
 * The backup key, an age X25519 identity ("AGE-SECRET-KEY-1…"), sealed
 * with a key derived from AUTH_SECRET (auth/sealer.ts), as queued account
 * email links are. The owner can view and download it (backups/routes.ts),
 * and the worker opens it to sign each manifest and to check a backup
 * (Test restore). Backups are encrypted to its public half, the recipient
 * ("age1…"), which is not secret.
 *
 * Whoever has a database dump and AUTH_SECRET can open it; with a dump
 * alone, no one. A changed AUTH_SECRET makes it unreadable: the Backups
 * tab then offers a new key. The destination's keys are not here: they
 * are the worker's BACKUP_S3_* (config.ts).
 */
export class BackupSecrets {
  readonly #sealer: Sealer;

  constructor(authSecret: string) {
    this.#sealer = new Sealer(authSecret, "ottertrail stored secrets v1");
  }

  sealKey(identity: string): string {
    return this.#sealer.seal(identity, KEY_BINDING);
  }

  /** The backup key, or null when AUTH_SECRET changed since it was made. */
  openKey(sealed: string): string | null {
    return this.#sealer.open(sealed, KEY_BINDING);
  }
}

/**
 * JSON with every object's keys sorted: the bytes a manifest's MAC is
 * worked out over, the same however the JSON was written.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * A backup manifest's MAC: HMAC-SHA256 of its canonical JSON (without
 * `mac`), under a key derived from the backup key by HKDF. age needs only
 * the public recipient to encrypt, which the manifest names, so anyone who
 * can write to the bucket could make a backup that decrypts; only the
 * holder of the key can make one whose MAC checks out.
 */
export function manifestMac(identity: string, manifest: Record<string, unknown>): string {
  const { mac: _mac, ...rest } = manifest;
  const key = Buffer.from(
    hkdfSync("sha256", identity, Buffer.alloc(0), "ottertrail backup manifest v1", 32),
  );
  return `hmac-sha256:${createHmac("sha256", key).update(canonicalJson(rest)).digest("hex")}`;
}

/** Whether a manifest carries the MAC the backup key gives it. */
export function manifestMacValid(identity: string, manifest: Record<string, unknown>): boolean {
  const given = manifest.mac;
  if (typeof given !== "string") return false;
  const expected = Buffer.from(manifestMac(identity, manifest));
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
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
