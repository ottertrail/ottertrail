import type { Kysely, Transaction } from "kysely";
import { z } from "zod";

import type { BackupS3Config } from "../config.ts";
import type { Database } from "../db/schema.ts";

/**
 * Scheduled backups' settings (backup_settings, migrations 0014 and 0020;
 * docs/deployment.md, "Scheduled backups"). The owner's part is on the
 * Backups tab: on or off, the time of day, the days to keep, and the
 * backup key. Where backups go is the worker's: BACKUP_S3_* in its
 * environment (config.ts, parseBackupS3), which the API never reads. The
 * worker reports what it has here, without the secret: the destination or
 * what is wrong with it, Test connection's result, and the folder's
 * listing (backups/job.ts).
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

export interface BackupSettings {
  enabled: boolean;
  timeOfDay: string;
  keepDays: number;
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
  /** What the worker last reported: its destination, or what is wrong with it. */
  destination: DestinationReport | null;
  destinationProblem: string | null;
  destinationReportedAt: Date | null;
  connectionTestRequestedAt: Date | null;
  connectionTest: StoredConnectionTest | null;
  connectionTestedAt: Date | null;
  backupList: StoredBackupList | null;
  backupListedAt: Date | null;
}

/** The destination's non-secret parts, as the worker reports them. */
const destinationReportSchema = z.object({
  endpoint: z.string(),
  region: z.string(),
  bucket: z.string(),
  prefix: z.string(),
  accessKeyId: z.string(),
});

export type DestinationReport = z.infer<typeof destinationReportSchema>;

export function reportOf(destination: Destination): DestinationReport {
  return {
    endpoint: destination.url,
    region: destination.region,
    bucket: destination.bucket,
    prefix: destination.prefix,
    accessKeyId: destination.accessKeyId,
  };
}

/** Test connection's result: each step (backups/s3.ts, testConnection), or why none could run. */
const connectionTestSchema = z.object({
  ok: z.boolean(),
  steps: z.array(
    z.object({
      step: z.enum(["put", "list", "get", "delete"]),
      status: z.enum(["ok", "failed", "skipped"]),
      error: z.string().optional(),
    }),
  ),
  /** Why no step ran: no destination, or a problem with it. */
  error: z.string().optional(),
});

export type StoredConnectionTest = z.infer<typeof connectionTestSchema>;

const placeSchema = { bucket: z.string(), prefix: z.string() };

/** The folder's backups, newest first, or why they could not be listed. */
const backupListSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    ...placeSchema,
    backups: z.array(
      z.object({ name: z.string(), at: z.string(), bytes: z.number(), complete: z.boolean() }),
    ),
  }),
  z.object({ ok: z.literal(false), ...placeSchema, error: z.string() }),
]);

export type StoredBackupList = z.infer<typeof backupListSchema>;

/** A JSON column the worker wrote, or null when it is empty or not of its shape. */
function parsed<T>(schema: z.ZodType<T>, value: unknown): T | null {
  if (value === null) return null;
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
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
    // The three JSON columns are written by the worker alone (backups/job.ts).
    destination: parsed(destinationReportSchema, row.destination),
    destinationProblem: row.destination_problem,
    destinationReportedAt: row.destination_reported_at,
    connectionTestRequestedAt: row.connection_test_requested_at,
    connectionTest: parsed(connectionTestSchema, row.connection_test),
    connectionTestedAt: row.connection_tested_at,
    backupList: parsed(backupListSchema, row.backup_list),
    backupListedAt: row.backup_listed_at,
  };
}

/** Where backups go, with the keys to sign for it: the worker's BACKUP_S3_*. */
export type Destination = BackupS3Config;

/**
 * Where the object store keeps its objects (replays/replays.ts,
 * source-maps/source-maps.ts, avatars/avatars.ts): object backups list
 * only these, and a backup folder in the store's own bucket may not
 * overlap them.
 */
export const OBJECT_PREFIXES = ["replays/", "source-maps/", "avatars/"] as const;

/** Whether a backup folder overlaps the store's objects: "replays", "replays/x", "source-maps", or "avatars". */
export function overlapsObjects(prefix: string): boolean {
  const folder = `${prefix}/`;
  return OBJECT_PREFIXES.some(
    (objects) => folder.startsWith(objects) || objects.startsWith(folder),
  );
}

export const OVERLAP_PROBLEM =
  "This folder overlaps session replays, source maps, or avatars. Choose a separate folder, such as ottertrail-backups.";
