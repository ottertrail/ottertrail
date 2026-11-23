import { type Kysely, sql } from "kysely";

import { type BackupHealth, readBackupHealth } from "../backups/state.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { AI_CALLS_TABLE, HEATMAP_RETENTION_DAYS } from "../clickhouse/migrations.ts";
import { QueryParams, queryRows } from "../clickhouse/query.ts";
import type { Config } from "../config.ts";
import type { Database } from "../db/schema.ts";
import { storedReplayBytes } from "../replays/replays.ts";
import { storedBytes } from "../source-maps/source-maps.ts";
import { RESULT_RETENTION_DAYS } from "../uptime/results.ts";
import {
  budgetRoom,
  type GarageAdmin,
  garageAdmin,
  GarageAdminError,
  plannedQuota,
  type QuotaPlan,
} from "./garage-admin.ts";

/**
 * What fills the server's disk (docs/deployment.md, "Storage"): each store
 * measured on its own, so one that fails does not hide the others. Every
 * figure is one small query to a store the API already talks to; nothing
 * needs the Docker socket.
 *
 * - The replay and source map budgets: what Ottertrail recorded, from
 *   PostgreSQL (storedReplayBytes, storedBytes), against
 *   REPLAY_STORAGE_BYTES and SOURCE_MAP_STORAGE_BYTES.
 * - ClickHouse: bytes_on_disk of active parts per table of its database
 *   (system.parts), and the largest active partition, which a merge may
 *   need twice over.
 * - PostgreSQL: pg_database_size, and the largest tables of the schema
 *   with their indexes (pg_total_relation_size).
 * - The disk: system.disks' total_space and free_space, which ClickHouse
 *   reads with statvfs on its own data path. The stores share one disk in
 *   the default install, so this is the disk for all of them.
 * - The stack's Garage, with its admin token: the bucket's bytes and
 *   objects, and the filesystem its data is on.
 *
 * The `ottertrail` ClickHouse user reads system.parts and system.disks
 * without a GRANT of its own: the image's entrypoint creates it with
 * access management and SELECT on everything (checked on 26.8.38.9 with
 * SHOW GRANTS on 19 November 2026).
 */

/** A store's figures, or why they could not be measured. */
export type Measured<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface Budget {
  /** Compressed bytes Ottertrail recorded. */
  usedBytes: number;
  limitBytes: number;
}

/** How long a ClickHouse table keeps its rows. */
export type Retention =
  /** The same number of days for the whole instance. */
  | { kind: "days"; days: number }
  /** Each project's own retention; `keptForever` projects have none set. */
  | { kind: "projects"; keptForever: number | null }
  /** As long as the project's events: derived from them. */
  | { kind: "with_events" }
  /** Small, and never deleted on a schedule. */
  | { kind: "none" };

export interface ClickHouseTable {
  name: string;
  bytes: number;
  rows: number;
  retention: Retention;
}

export interface Partition {
  table: string;
  partition: string;
  bytes: number;
}

export interface Disk {
  totalBytes: number;
  freeBytes: number;
  /** ClickHouse marked the disk read-only (it then reports 0 free). */
  readOnly: boolean;
  broken: boolean;
}

export type GarageReading =
  | { state: "no_token" }
  | { state: "failed"; error: string }
  | {
      state: "ok";
      /** Null when Garage has no bucket of the configured name. */
      bucket: { id: string; objects: number; bytes: number; maxSize: number | null } | null;
      dataPartition: { availableBytes: number; totalBytes: number } | null;
    };

export interface StorageReading {
  measuredAt: Date;
  /** Where replays and source maps go: none, the stack's Garage, or another S3-compatible store. */
  objectStore: "none" | "garage" | "other";
  /** Null without an object store: replays and source maps are off. */
  budgets: Measured<{ replays: Budget; sourceMaps: Budget }> | null;
  clickhouse: Measured<{
    tables: ClickHouseTable[];
    totalBytes: number;
    largestPartition: Partition | null;
  }>;
  postgres: Measured<{ databaseBytes: number; tables: { name: string; bytes: number }[] }>;
  disk: Measured<Disk>;
  /** Null unless the object store is the stack's Garage. */
  garage: GarageReading | null;
  /**
   * Scheduled backups' health (backups/state.ts), for their two warnings;
   * left out of readings made without it (tests of the other warnings).
   */
  backups?: Measured<BackupHealth> | null;
}

export interface StorageSources {
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  /** Null without an object store; "garage" when it is the stack's own. */
  objectStore: { kind: "garage" | "other"; bucket: string } | null;
  budgets: { replayBytes: number; sourceMapBytes: number };
  telemetryRetentionDays: number;
  /**
   * The stack's Garage: its admin API with a token, "no_token" without
   * one, or null when the store is not the stack's Garage.
   */
  garage: GarageAdmin | "no_token" | null;
  /** Replaces system.disks: tests inject the disk's figures. */
  readDisk?: (() => Promise<Disk>) | undefined;
}

/** The largest PostgreSQL tables listed. */
export const POSTGRES_TABLES_LISTED = 5;

/** No query of the page may take longer, in seconds. */
const QUERY_SECONDS = 5;

/** Telemetry tables, which keep TELEMETRY_RETENTION_DAYS. */
const TELEMETRY_TABLES = new Set(["spans", "logs", "metric_points", "metric_histograms"]);

/**
 * Expose a fixed reason to the page; keep driver details in logs
 * because they may contain internal addresses.
 */
type Fail = (reason: string, error: unknown) => { ok: false; error: string };

/** Where a failed measurement's details go: the API's request log, or the worker's. */
export type MeasureLog = (msg: string, fields: Record<string, unknown>) => void;

async function measureBudgets(
  sources: StorageSources,
  fail: Fail,
): Promise<StorageReading["budgets"]> {
  if (sources.objectStore === null) return null;
  try {
    const [replays, sourceMaps] = await Promise.all([
      storedReplayBytes(sources.db),
      storedBytes(sources.db),
    ]);
    return {
      ok: true,
      replays: { usedBytes: replays, limitBytes: sources.budgets.replayBytes },
      sourceMaps: { usedBytes: sourceMaps, limitBytes: sources.budgets.sourceMapBytes },
    };
  } catch (error) {
    return fail("PostgreSQL did not answer.", error);
  }
}

async function retentionOfEvents(db: Kysely<Database>): Promise<number | null> {
  try {
    const row = await db
      .selectFrom("projects")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("retention_days", "is", null)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  } catch {
    return null;
  }
}

function retentionOf(name: string, telemetryDays: number, keptForever: number | null): Retention {
  if (name === "events") return { kind: "projects", keptForever };
  if (TELEMETRY_TABLES.has(name)) return { kind: "days", days: telemetryDays };
  if (name === "check_results") return { kind: "days", days: RESULT_RETENTION_DAYS };
  if (name === "user_first_seen") return { kind: "with_events" };
  // Deleted with the project's events, by the same retention (ai/calls.ts).
  if (name === AI_CALLS_TABLE) return { kind: "with_events" };
  if (name === "heatmaps") return { kind: "days", days: HEATMAP_RETENTION_DAYS };
  return { kind: "none" };
}

async function measureClickHouse(
  sources: StorageSources,
  fail: Fail,
): Promise<StorageReading["clickhouse"]> {
  const reader = { client: sources.clickhouse };
  const settings = { max_execution_time: QUERY_SECONDS };
  try {
    const [tables, largest, keptForever] = await Promise.all([
      queryRows<{ table: string; bytes: string; rows: string }>(
        reader,
        `SELECT table, sum(bytes_on_disk) AS bytes, sum(rows) AS rows
         FROM system.parts
         WHERE database = currentDatabase() AND active
         GROUP BY table
         ORDER BY bytes DESC, table`,
        new QueryParams(),
        settings,
      ),
      queryRows<{ table: string; partition: string; bytes: string }>(
        reader,
        `SELECT table, partition, sum(bytes_on_disk) AS bytes
         FROM system.parts
         WHERE database = currentDatabase() AND active
         GROUP BY table, partition
         ORDER BY bytes DESC, table, partition
         LIMIT 1`,
        new QueryParams(),
        settings,
      ),
      retentionOfEvents(sources.db),
    ]);
    const list = tables.map((row) => ({
      name: row.table,
      bytes: Number(row.bytes),
      rows: Number(row.rows),
      retention: retentionOf(row.table, sources.telemetryRetentionDays, keptForever),
    }));
    const top = largest[0];
    return {
      ok: true,
      tables: list,
      totalBytes: list.reduce((sum, table) => sum + table.bytes, 0),
      largestPartition:
        top === undefined
          ? null
          : { table: top.table, partition: top.partition, bytes: Number(top.bytes) },
    };
  } catch (error) {
    return fail("ClickHouse did not answer.", error);
  }
}

async function measureDisk(sources: StorageSources, fail: Fail): Promise<StorageReading["disk"]> {
  try {
    if (sources.readDisk !== undefined) return { ok: true, ...(await sources.readDisk()) };
    const [disk] = await queryRows<{
      total_space: string;
      free_space: string;
      is_read_only: number | string;
      is_broken: number | string;
    }>(
      { client: sources.clickhouse },
      `SELECT total_space, free_space, is_read_only, is_broken
       FROM system.disks WHERE name = 'default'`,
      new QueryParams(),
      { max_execution_time: QUERY_SECONDS },
    );
    if (disk === undefined) return { ok: false, error: "ClickHouse reports no default disk." };
    return {
      ok: true,
      totalBytes: Number(disk.total_space),
      freeBytes: Number(disk.free_space),
      readOnly: Number(disk.is_read_only) === 1,
      broken: Number(disk.is_broken) === 1,
    };
  } catch (error) {
    return fail("ClickHouse did not answer.", error);
  }
}

async function measurePostgres(
  db: Kysely<Database>,
  fail: Fail,
): Promise<StorageReading["postgres"]> {
  try {
    const [size, tables] = await Promise.all([
      sql<{ bytes: string }>`select pg_database_size(current_database()) as bytes`.execute(db),
      sql<{ name: string; bytes: string }>`
        select c.relname as name, pg_total_relation_size(c.oid) as bytes
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p') and n.nspname = current_schema()
        order by pg_total_relation_size(c.oid) desc, c.relname
        limit ${POSTGRES_TABLES_LISTED}
      `.execute(db),
    ]);
    return {
      ok: true,
      databaseBytes: Number(size.rows[0]?.bytes ?? 0),
      tables: tables.rows.map((row) => ({ name: row.name, bytes: Number(row.bytes) })),
    };
  } catch (error) {
    return fail("PostgreSQL did not answer.", error);
  }
}

async function measureGarage(sources: StorageSources, fail: Fail): Promise<GarageReading | null> {
  const { garage, objectStore } = sources;
  if (garage === null || objectStore === null) return null;
  if (garage === "no_token") return { state: "no_token" };
  try {
    const [bucket, dataPartition] = await Promise.all([
      garage.bucket(objectStore.bucket),
      garage.dataPartition(),
    ]);
    return { state: "ok", bucket, dataPartition };
  } catch (error) {
    // garage-admin.ts words its own errors without addresses or the token.
    const reason = error instanceof GarageAdminError ? error.message : "Garage's admin API failed.";
    return { state: "failed", error: fail(reason, error).error };
  }
}

/** Measures every store at once; each failure is recorded with its store, never thrown. */
export async function measureStorage(
  sources: StorageSources,
  { now = () => new Date(), log }: { now?: () => Date; log?: MeasureLog } = {},
): Promise<StorageReading> {
  const fail: Fail = (reason, error) => {
    log?.("a storage figure could not be measured", {
      reason,
      err: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: reason };
  };
  const measuredAt = now();
  const [budgets, clickhouse, postgres, disk, garage, backups] = await Promise.all([
    measureBudgets(sources, fail),
    measureClickHouse(sources, fail),
    measurePostgres(sources.db, fail),
    measureDisk(sources, fail),
    measureGarage(sources, fail),
    readBackupHealth(sources.db, measuredAt).then(
      (health): Measured<BackupHealth> => ({ ok: true, ...health }),
      (error: unknown) => fail("PostgreSQL did not answer.", error),
    ),
  ]);
  return {
    measuredAt,
    objectStore: sources.objectStore?.kind ?? "none",
    budgets,
    clickhouse,
    postgres,
    disk,
    garage,
    backups,
  };
}

/** Pass the admin token only to the Garage client. */
export function storageSourcesOf(
  config: Pick<
    Config,
    | "objectStore"
    | "garage"
    | "replayStorageBytes"
    | "sourceMapStorageBytes"
    | "telemetryRetentionDays"
  >,
  db: Kysely<Database>,
  clickhouse: ClickHouseClient,
): StorageSources {
  const { objectStore, garage } = config;
  return {
    db,
    clickhouse,
    objectStore:
      objectStore === null
        ? null
        : { kind: garage === null ? "other" : "garage", bucket: objectStore.bucket },
    budgets: {
      replayBytes: config.replayStorageBytes,
      sourceMapBytes: config.sourceMapStorageBytes,
    },
    telemetryRetentionDays: config.telemetryRetentionDays,
    garage:
      garage === null
        ? null
        : garage.adminToken === null
          ? "no_token"
          : garageAdmin({ adminUrl: garage.adminUrl, adminToken: garage.adminToken }),
  };
}

/**
 * Use bucket measurements for plannedQuota. Without them, return budgets
 * plus 10%; the worker must not apply that fallback.
 */
export function quotaPlanOf(
  budgets: StorageSources["budgets"],
  reading: StorageReading,
): QuotaPlan & { measured: boolean } {
  const bucket = reading.garage?.state === "ok" ? reading.garage.bucket : null;
  if (bucket === null || reading.budgets === null || !reading.budgets.ok) {
    return { ...plannedQuota(budgets), measured: false };
  }
  return {
    ...plannedQuota(budgets, { bucketBytes: bucket.bytes, roomBytes: budgetRoom(reading.budgets) }),
    measured: true,
  };
}
