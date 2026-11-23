import { type Kysely, sql, type Transaction } from "kysely";

import type { Database } from "../db/schema.ts";
import { readInstanceSettings } from "../settings/settings.ts";
import { overdueSlot } from "./schedule.ts";
import { readBackupSettings } from "./settings.ts";

/**
 * Heartbeats prevent a dead worker from blocking later runs
 * (backup_runs, migration 0014).
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
export const HEARTBEAT_MS = 60 * 1000;
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

/** Returns the number of stale runs marked failed. */
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
 * Returns null if another run is active. backup_runs_one_running
 * serializes workers inside the transaction.
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

/** A zero result means another worker marked the run stale; stop it. */
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
 * Retry an interrupted non-retry backup immediately so a restart does not
 * skip the day. Returns true if a retry was scheduled.
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
  /**
   * The worker reports no destination, or a problem with its BACKUP_S3_*:
   * the next backup can't run. Null while it reports one, or before it
   * has reported at all.
   */
  noDestination: { problem: string | null } | null;
}

export async function readBackupHealth(db: Kysely<Database>, now: Date): Promise<BackupHealth> {
  const [settings, runs, { timeZone }] = await Promise.all([
    readBackupSettings(db),
    latestRuns(db),
    readInstanceSettings(db),
  ]);
  if (!settings.enabled) {
    return { enabled: false, failed: null, overdue: null, noDestination: null };
  }
  const noDestination =
    settings.destinationReportedAt !== null &&
    (settings.destination === null || settings.destinationProblem !== null)
      ? { problem: settings.destinationProblem }
      : null;
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
  return {
    enabled: true,
    failed,
    overdue: slot === null ? null : { since: slot.at },
    noDestination,
  };
}
