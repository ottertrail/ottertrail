import { type Kysely, sql } from "kysely";

import type { Database } from "../db/schema.ts";

export const MAX_INSTANCE_NAME_LENGTH = 100;

/**
 * How long a process keeps the settings it read: another process (the
 * worker, a second API process) sees a change within this time.
 */
export const SETTINGS_CACHE_MS = 5_000;

/** The instance's settings (the instance_settings table). */
export interface InstanceSettings {
  /** What the dashboard shows above the projects. */
  name: string;
  /** IANA timezone: reports count days in it, and visitor salts change at its midnight. */
  timeZone: string;
}

interface CacheEntry {
  settings: Promise<InstanceSettings>;
  expiresAt: number;
}

/** One cache per database handle, so each test's schema has its own. */
const caches = new WeakMap<Kysely<Database>, CacheEntry>();

/**
 * The instance's settings, from a cache that lasts SETTINGS_CACHE_MS:
 * every report, event, and project route needs the timezone, and it seldom
 * changes. A change made through updateInstanceSettings() shows at once in
 * this process.
 */
export function readInstanceSettings(
  db: Kysely<Database>,
  now: number = Date.now(),
): Promise<InstanceSettings> {
  const cached = caches.get(db);
  if (cached !== undefined && cached.expiresAt > now) return cached.settings;
  const settings = db
    .selectFrom("instance_settings")
    .select(["name", "time_zone"])
    .executeTakeFirstOrThrow()
    .then((row) => ({ name: row.name, timeZone: row.time_zone }));
  caches.set(db, { settings, expiresAt: now + SETTINGS_CACHE_MS });
  // A failed read is not kept: the next caller tries again.
  settings.catch(() => {
    if (caches.get(db)?.settings === settings) caches.delete(db);
  });
  return settings;
}

/**
 * Changes the instance's name or timezone, and drops this process's cached
 * copy. Checking who may do it is the caller's job. In a transaction, call
 * forgetInstanceSettings() on the outer handle once it commits.
 */
export async function updateInstanceSettings(
  db: Kysely<Database>,
  changes: { name?: string; timeZone?: string },
): Promise<void> {
  const result = await db
    .updateTable("instance_settings")
    .set({
      ...(changes.name === undefined ? {} : { name: changes.name }),
      ...(changes.timeZone === undefined ? {} : { time_zone: changes.timeZone }),
      updated_at: new Date(),
    })
    .executeTakeFirst();
  // The schema's migration inserts the one row and nothing deletes it; if
  // it is gone all the same, fail rather than report a change not made
  // (setup's transaction then rolls back).
  if (result.numUpdatedRows !== 1n) {
    throw new Error("The instance's settings row is missing");
  }
  forgetInstanceSettings(db);
}

/** Drops this process's cached settings, so the next read goes to the database. */
export function forgetInstanceSettings(db: Kysely<Database>): void {
  caches.delete(db);
}

/**
 * Whether PostgreSQL knows a timezone name. Node.js and PostgreSQL carry
 * separate timezone databases, and reports and retention hand the name to
 * PostgreSQL, so a name only Node.js knows would make them fail.
 */
export async function postgresKnowsTimeZone(db: Kysely<Database>, name: string): Promise<boolean> {
  const { rows } = await sql<{ known: boolean }>`
    select exists (select 1 from pg_timezone_names where name = ${name}) as known
  `.execute(db);
  return rows[0]?.known === true;
}
