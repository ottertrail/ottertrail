import { type Kysely, sql, type Transaction } from "kysely";

import type { Database } from "../db/schema.ts";
import { readInstanceSettings } from "../settings/settings.ts";
import { overdueSlot } from "./schedule.ts";
import { readBackupSettings } from "./settings.ts";

/**
 * What PostgreSQL keeps about backup runs (backup_runs, migration 0014):
 * each backup and test restore, one running at a time, with a heartbeat,
 * so a worker that died mid-run does not hold the next one back.
 */

export type RunKind = "backup" | "test_restore";
export type RunTrigger = "schedule" | "manual" | "retry";

export interface Run {
  id: string;
  kind: RunKind;
  trigger: RunTrigger;
  status: "running" | "succeeded" | "failed";
  startedAt: Date;
  finishedAt: Date | null;
  heartbeatAt: Date;
  folder: string | null;
  bytes: number | null;
  error: string | null;
}

/** A running row whose heartbeat is older than this belongs to a worker that stopped. */
export const STALE_AFTER_MS = 10 * 60 * 1000;
/** How often a running backup touches its heartbeat. */
export const HEARTBEAT_MS = 60 * 1000;
/** Runs kept of each kind: the newest. */
const RUNS_KEPT = 100;

export const WORKER_STOPPED =
  "The worker stopped while this ran (it was restarted, or the server went down), so it did not finish. Nothing it uploaded was kept. The next one runs at its time.";

type Executor = Kysely<Database> | Transaction<Database>;

function runOf(row: {
  id: string;
  kind: RunKind;
  trigger: RunTrigger;
  status: Run["status"];
  started_at: Date;
  finished_at: Date | null;
  heartbeat_at: Date;
  folder: string | null;
  bytes: string | number | null;
  error: string | null;
}): Run {
  return {
    id: row.id,
    kind: row.kind,
    trigger: row.trigger,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    heartbeatAt: row.heartbeat_at,
    folder: row.folder,
    bytes: row.bytes === null ? null : Number(row.bytes),
    error: row.error,
  };
}

const RUN_COLUMNS = [
  "id",
  "kind",
  "trigger",
  "status",
  "started_at",
  "finished_at",
  "heartbeat_at",
  "folder",
  "bytes",
  "error",
] as const;

/** The latest runs: the running one, the last finished backup and test restore, and the last success. */
export async function latestRuns(db: Executor): Promise<{
  running: Run | null;
  lastBackup: Run | null;
  lastSuccess: Run | null;
  lastTestRestore: Run | null;
}> {
  const latest = (kind: RunKind, status?: "succeeded") => {
    let query = db
      .selectFrom("backup_runs")
      .select(RUN_COLUMNS)
      .where("kind", "=", kind)
      .where("status", "!=", "running");
    if (status !== undefined) query = query.where("status", "=", status);
    return query.orderBy("started_at", "desc").limit(1).executeTakeFirst();
  };
  const [running, lastBackup, lastSuccess, lastTestRestore] = await Promise.all([
    db
      .selectFrom("backup_runs")
      .select(RUN_COLUMNS)
      .where("status", "=", "running")
      .executeTakeFirst(),
    latest("backup"),
    latest("backup", "succeeded"),
    latest("test_restore"),
  ]);
  const of = (row: typeof running) => (row === undefined ? null : runOf(row));
  return {
    running: of(running),
    lastBackup: of(lastBackup),
    lastSuccess: of(lastSuccess),
    lastTestRestore: of(lastTestRestore),
  };
}

/** Marks runs whose worker stopped as failed; how many. */
export async function failStaleRuns(db: Executor, now: Date): Promise<number> {
  const result = await db
    .updateTable("backup_runs")
    .set({ status: "failed", finished_at: now, error: WORKER_STOPPED })
    .where("status", "=", "running")
    .where("heartbeat_at", "<", new Date(now.getTime() - STALE_AFTER_MS))
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

/**
 * Starts a run, unless one is running: null then. In a transaction, the
 * unique index (backup_runs_one_running) decides between two workers.
 */
export async function startRun(
  trx: Transaction<Database>,
  kind: RunKind,
  trigger: RunTrigger,
  now: Date,
): Promise<string | null> {
  const row = await trx
    .insertInto("backup_runs")
    .values({ kind, trigger, status: "running", started_at: now, heartbeat_at: now })
    .onConflict((conflict) =>
      conflict
        .expression(sql`(true)`)
        .where("status", "=", "running")
        .doNothing(),
    )
    .returning("id")
    .executeTakeFirst();
  return row?.id ?? null;
}

/**
 * Touches a running run's heartbeat. 0 when it is no longer running: another
 * worker marked it stale (failStaleRuns), and the run must stop.
 */
export async function touchRun(db: Executor, id: string, now: Date): Promise<number> {
  const result = await db
    .updateTable("backup_runs")
    .set({ heartbeat_at: now })
    .where("id", "=", id)
    .where("status", "=", "running")
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

/** A backup cut off by the worker's own shutdown. */
export const WORKER_SHUTDOWN =
  "The worker was stopped during the backup, so it did not finish. Nothing it uploaded was kept. The worker tries it again once when it starts.";

/** A run that another worker marked stale while it still ran: it stopped. */
export const RUN_TAKEN_OVER =
  "This run's heartbeat was late, so another worker marked it stopped, and it ended. The next one runs at its time.";

/**
 * When the latest backup was cut off by a worker stopping (its own
 * shutdown, or a stale heartbeat), and was not itself a retry, schedules
 * its one retry now, so a restart during the daily backup does not skip
 * the day. True when it did.
 */
export async function retryStoppedBackup(db: Kysely<Database>, now: Date): Promise<boolean> {
  const last = await db
    .selectFrom("backup_runs")
    .select(["trigger", "status", "error"])
    .where("kind", "=", "backup")
    .where("status", "!=", "running")
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (last === undefined || last.status !== "failed" || last.trigger === "retry") return false;
  if (last.error !== WORKER_STOPPED && last.error !== WORKER_SHUTDOWN) return false;
  const result = await db
    .updateTable("backup_settings")
    .set({ retry_at: now })
    .where("enabled", "=", true)
    .where("retry_at", "is", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/** Records how a run ended, and keeps the newest RUNS_KEPT of its kind. */
export async function finishRun(
  db: Kysely<Database>,
  run: { id: string; kind: RunKind },
  outcome:
    | { status: "succeeded"; folder: string; bytes: number }
    | { status: "failed"; error: string; folder?: string | null },
  now: Date,
): Promise<void> {
  await db
    .updateTable("backup_runs")
    .set({
      status: outcome.status,
      finished_at: now,
      heartbeat_at: now,
      folder: outcome.folder ?? null,
      bytes: outcome.status === "succeeded" ? outcome.bytes : null,
      error: outcome.status === "failed" ? outcome.error : null,
    })
    .where("id", "=", run.id)
    .execute();
  await db
    .deleteFrom("backup_runs")
    .where("kind", "=", run.kind)
    .where("status", "!=", "running")
    .where(
      "id",
      "not in",
      db
        .selectFrom("backup_runs")
        .select("id")
        .where("kind", "=", run.kind)
        .orderBy("started_at", "desc")
        .limit(RUNS_KEPT),
    )
    .execute();
}

/** Backups' health, for the storage warnings (storage/warnings.ts). */
export interface BackupHealth {
  enabled: boolean;
  /** The latest backup failed: when, and why. */
  failed: { at: Date; error: string } | null;
  /** No backup succeeded since the daily time this long past. */
  overdue: { since: Date } | null;
}

/** Reads backups' health now: off, failed, overdue, or fine. */
export async function readBackupHealth(db: Kysely<Database>, now: Date): Promise<BackupHealth> {
  const [settings, runs, { timeZone }] = await Promise.all([
    readBackupSettings(db),
    latestRuns(db),
    readInstanceSettings(db),
  ]);
  if (!settings.enabled) return { enabled: false, failed: null, overdue: null };
  const last = runs.lastBackup;
  const failed =
    last !== null && last.status === "failed"
      ? { at: last.finishedAt ?? last.startedAt, error: last.error ?? "" }
      : null;
  const slot =
    runs.running?.kind === "backup"
      ? null
      : overdueSlot(
          now,
          {
            enabled: settings.enabled,
            timeOfDay: settings.timeOfDay,
            scheduleFrom: settings.scheduleFrom,
            lastSlot: settings.lastSlot,
          },
          timeZone,
          runs.lastSuccess?.startedAt ?? null,
        );
  return { enabled: true, failed, overdue: slot === null ? null : { since: slot.at } };
}
