import type { Kysely, Transaction } from "kysely";

import type { ObjectStoreConfig } from "../config.ts";
import type { Database } from "../db/schema.ts";
import type { BackupSecrets } from "./secrets.ts";

/**
 * Scheduled backups' settings (backup_settings, migration 0014), and where
 * backups go (docs/deployment.md, "Backups"):
 *
 * - When the object store (OBJECT_STORE_*, which holds replays and source
 *   maps) is an off-site S3-compatible store, backups reuse its connection,
 *   in a bucket and folder the owner picks.
 * - When it is the stack's own Garage (on the server's own disk, so not a
 *   backup), or there is none, backups need a separate destination: an
 *   endpoint, region, bucket, folder, access key, and secret.
 *
 * Which applies follows from the configuration, the same test the Storage
 * page uses for "the stack's Garage" (config.ts, parseGarage: the URL's
 * host is the Compose service `garage`, or in development the local one).
 */

export const DEFAULT_PREFIX = "ottertrail-backups";
export const DEFAULT_KEEP_DAYS = 14;
export const MAX_KEEP_DAYS = 365;

/** "HH:MM", 24-hour. */
export const TIME_PATTERN = "^([01][0-9]|2[0-3]):[0-5][0-9]$";
/** S3's bucket names: 3 to 63 lowercase letters, digits, dots, and hyphens. */
export const BUCKET_PATTERN = "^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$";
/**
 * A folder: one or more names of letters, digits, dots, hyphens, and
 * underscores, joined by slashes, without a slash at either end. Never
 * empty, so backups never list or delete at a bucket's top.
 */
export const PREFIX_PATTERN = "^[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$";
export const MAX_PREFIX = 200;
/** A region such as "us-east-1", "auto" (R2), or "garage". */
export const REGION_PATTERN = "^[A-Za-z0-9_-]{1,64}$";
/** An access key ID: visible characters, no spaces. */
export const ACCESS_KEY_PATTERN = "^[\\x21-\\x7E]{1,128}$";
export const MAX_SECRET = 256;
export const MAX_ENDPOINT = 300;

/** Whether backups reuse the object store's connection, and why not when they don't. */
export type DestinationMode =
  | { mode: "object_store"; store: ObjectStoreConfig }
  | {
      mode: "separate";
      /** The object store is the stack's Garage, on this server's disk; or there is none. */
      reason: "stack_garage" | "none";
    };

export function destinationModeOf(
  objectStore: ObjectStoreConfig | null,
  stackGarage: boolean,
): DestinationMode {
  if (objectStore === null) return { mode: "separate", reason: "none" };
  if (stackGarage) return { mode: "separate", reason: "stack_garage" };
  return { mode: "object_store", store: objectStore };
}

export interface BackupSettings {
  enabled: boolean;
  timeOfDay: string;
  keepDays: number;
  /** Null: the object store's bucket, when backups reuse its connection. */
  bucket: string | null;
  prefix: string;
  endpoint: string | null;
  region: string | null;
  accessKeyId: string | null;
  secretSealed: string | null;
  keySealed: string | null;
  keyRecipient: string | null;
  keyCreatedAt: Date | null;
  keySavedAt: Date | null;
  scheduleFrom: Date | null;
  lastSlot: string | null;
  retryAt: Date | null;
  disabledAt: Date | null;
  disabledBy: string | null;
  backupRequestedAt: Date | null;
  testRestoreRequestedAt: Date | null;
}

export async function readBackupSettings(
  db: Kysely<Database> | Transaction<Database>,
  { lock = false }: { lock?: boolean } = {},
): Promise<BackupSettings> {
  let query = db.selectFrom("backup_settings").selectAll();
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirstOrThrow();
  return {
    enabled: row.enabled,
    timeOfDay: row.time_of_day,
    keepDays: row.keep_days,
    bucket: row.bucket,
    prefix: row.prefix,
    endpoint: row.endpoint,
    region: row.region,
    accessKeyId: row.access_key_id,
    secretSealed: row.secret_sealed,
    keySealed: row.key_sealed,
    keyRecipient: row.key_recipient,
    keyCreatedAt: row.key_created_at,
    keySavedAt: row.key_saved_at,
    scheduleFrom: row.schedule_from,
    lastSlot: row.last_slot,
    retryAt: row.retry_at,
    disabledAt: row.disabled_at,
    disabledBy: row.disabled_by,
    backupRequestedAt: row.backup_requested_at,
    testRestoreRequestedAt: row.test_restore_requested_at,
  };
}

/** Where backups go, with the keys to sign for it. */
export interface Destination {
  /** Its S3 endpoint, an origin. */
  url: string;
  region: string;
  bucket: string;
  /** The folder backups go under, never empty. */
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Whether the endpoint came from the dashboard rather than the server's
   * environment: its requests then follow the outbound address rules
   * (backups/s3.ts), as webhooks do.
   */
  fromDashboard: boolean;
  /** The object store's bucket when backups share its connection: backups never touch its other keys. */
  objectStoreBucket: string | null;
}

/** What a destination is made from: the saved settings, or a form's unsaved values. */
export interface DestinationFields {
  bucket: string | null;
  prefix: string;
  endpoint: string | null;
  region: string | null;
  accessKeyId: string | null;
  /** The secret itself, when a form sends one. */
  secretAccessKey?: string | null;
  /** The saved secret, used when the form sends none. */
  secretSealed: string | null;
}

/**
 * The destination, or why there is none yet, in words the Backups tab
 * shows: what is missing, and what to do.
 */
export function destinationOf(
  mode: DestinationMode,
  fields: DestinationFields,
  secrets: BackupSecrets,
): Destination | { problem: string } {
  const prefix = fields.prefix;
  if (!new RegExp(PREFIX_PATTERN).test(prefix)) {
    return { problem: "Choose a folder for the backups, such as ottertrail-backups." };
  }
  if (mode.mode === "object_store") {
    const bucket = fields.bucket ?? mode.store.bucket;
    if (bucket === mode.store.bucket && overlapsObjects(prefix)) {
      return { problem: OVERLAP_PROBLEM };
    }
    return {
      url: mode.store.url,
      region: mode.store.region,
      bucket,
      prefix,
      accessKeyId: mode.store.accessKeyId,
      secretAccessKey: mode.store.secretAccessKey,
      fromDashboard: false,
      objectStoreBucket: mode.store.bucket,
    };
  }
  const { endpoint, region, bucket, accessKeyId } = fields;
  if (endpoint === null || region === null || bucket === null || accessKeyId === null) {
    return {
      problem:
        "Backups need a destination: fill in the endpoint, region, bucket, and access key on the Backups tab, then save.",
    };
  }
  let secret = fields.secretAccessKey ?? null;
  if (secret === null || secret === "") {
    if (fields.secretSealed === null) {
      return { problem: "Enter the destination's secret access key on the Backups tab." };
    }
    secret = secrets.openSecret(fields.secretSealed, endpoint, accessKeyId);
    if (secret === null) {
      return {
        problem:
          "The saved secret access key can't be read: AUTH_SECRET changed since it was saved, or it was saved for another endpoint or access key. Enter the secret again on the Backups tab and save.",
      };
    }
  }
  return {
    url: endpoint,
    region,
    bucket,
    prefix,
    accessKeyId,
    secretAccessKey: secret,
    fromDashboard: true,
    objectStoreBucket: null,
  };
}

/**
 * Where the object store keeps its objects (replays/replays.ts,
 * source-maps/source-maps.ts): object backups list only these, and a
 * backup folder in the store's own bucket may not overlap them.
 */
export const OBJECT_PREFIXES = ["replays/", "source-maps/"] as const;

/** Whether a backup folder overlaps the store's objects: "replays", "replays/x", or "source-maps". */
export function overlapsObjects(prefix: string): boolean {
  const folder = `${prefix}/`;
  return OBJECT_PREFIXES.some(
    (objects) => folder.startsWith(objects) || objects.startsWith(folder),
  );
}

export const OVERLAP_PROBLEM =
  "This folder holds the object store's session replays or source maps, which share this bucket. Choose a folder of its own, such as ottertrail-backups.";

/**
 * An endpoint as the form sends it, as an origin; null when it is not an
 * http(s) URL without a user, path, query, or fragment.
 */
export function endpointOrigin(raw: string): string | null {
  const url = URL.parse(raw.trim());
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  if (url.username !== "" || url.password !== "") return null;
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") {
    return null;
  }
  return url.origin;
}
