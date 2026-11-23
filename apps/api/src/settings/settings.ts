import { type Kysely, sql } from "kysely";

import type { Database } from "../db/schema.ts";

export const MAX_INSTANCE_NAME_LENGTH = 100;

/** Other processes see settings changes within this interval. */
export const SETTINGS_CACHE_MS = 5_000;

export interface InstanceSettings {
  /** What the dashboard shows above the projects. */
  name: string;
  /** IANA timezone: reports count days in it, and visitor salts change at its midnight. */
  timeZone: string;
  /** Automatic updates default to on (enrichment/updates.ts). */
  updateLocationData: boolean;
  /** The instance's icon in the object store, or null (avatars/avatars.ts). */
  avatarKey: string | null;
}

interface CacheEntry {
  settings: Promise<InstanceSettings>;
  expiresAt: number;
}

/** One cache per database handle, so each test's schema has its own. */
const caches = new WeakMap<Kysely<Database>, CacheEntry>();

/**
 * Cache the frequently read timezone for SETTINGS_CACHE_MS.
 * updateInstanceSettings() invalidates this process's cache immediately.
 */
export function readInstanceSettings(
  db: Kysely<Database>,
  now: number = Date.now(),
): Promise<InstanceSettings> {
  const cached = caches.get(db);
  if (cached !== undefined && cached.expiresAt > now) return cached.settings;
  const settings = db
    .selectFrom("instance_settings")
    .select(["name", "time_zone", "update_location_data", "avatar_key"])
    .executeTakeFirstOrThrow()
    .then((row) => ({
      name: row.name,
      timeZone: row.time_zone,
      updateLocationData: row.update_location_data,
      avatarKey: row.avatar_key,
    }));
  caches.set(db, { settings, expiresAt: now + SETTINGS_CACHE_MS });
  // Discard failed reads so the next caller can retry.
  settings.catch(() => {
    if (caches.get(db)?.settings === settings) caches.delete(db);
  });
  return settings;
}

/**
 * The caller must check access. After a transaction commits,
 * call forgetInstanceSettings() on the outer database handle.
 */
export async function updateInstanceSettings(
  db: Kysely<Database>,
  changes: { name?: string; timeZone?: string; updateLocationData?: boolean },
): Promise<void> {
  const result = await db
    .updateTable("instance_settings")
    .set({
      ...(changes.name === undefined ? {} : { name: changes.name }),
      ...(changes.timeZone === undefined ? {} : { time_zone: changes.timeZone }),
      ...(changes.updateLocationData === undefined
        ? {}
        : { update_location_data: changes.updateLocationData }),
      updated_at: new Date(),
    })
    .executeTakeFirst();
  // A missing settings row must fail so setup's transaction rolls back.
  if (result.numUpdatedRows !== 1n) {
    throw new Error("The instance's settings row is missing");
  }
  forgetInstanceSettings(db);
}

export function forgetInstanceSettings(db: Kysely<Database>): void {
  caches.delete(db);
}

/**
 * Node.js and PostgreSQL have separate timezone databases. Reports and
 * retention need a name PostgreSQL recognizes.
 */
export async function postgresKnowsTimeZone(db: Kysely<Database>, name: string): Promise<boolean> {
  const { rows } = await sql<{ known: boolean }>`
    select exists (select 1 from pg_timezone_names where name = ${name}) as known
  `.execute(db);
  return rows[0]?.known === true;
}

export const INVALID_TIME_ZONE = {
  error: "invalid_time_zone",
  message:
    'Use an IANA timezone name such as "Europe/Berlin". Fixed offsets such as "+08:00" are not accepted.',
} as const;
