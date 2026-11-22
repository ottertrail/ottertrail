import type { S3Client } from "@aws-sdk/client-s3";
import type { Kysely } from "kysely";

import type { Database } from "../db/schema.ts";
import { readInstanceSettings } from "../settings/settings.ts";
import { applyRetention, BackupError, type BackupSources, runBackup, testRestore } from "./run.ts";
import { backupClient, listBackups, s3ErrorText, testConnection } from "./s3.ts";
import { dueSlot } from "./schedule.ts";
import type { BackupSecrets } from "./secrets.ts";
import {
  type Destination,
  type DestinationReport,
  readBackupSettings,
  reportOf,
  type StoredBackupList,
  type StoredConnectionTest,
} from "./settings.ts";
import {
  failStaleRuns,
  finishRun,
  HEARTBEAT_MS,
  retryStoppedBackup,
  RUN_TAKEN_OVER,
  WORKER_SHUTDOWN,
  type RunKind,
  type RunTrigger,
  startRun,
  touchRun,
} from "./state.ts";

/**
 * The worker's backups (docs/deployment.md, "Backups"), every BACKUP_TICK_MS:
 *
 * 1. Reports its destination (BACKUP_S3_*, without the secret) or what is
 *    wrong with it to PostgreSQL, for the Backups tab, when that changed
 *    or an hour after it last did; and runs a Test connection the owner
 *    asked for, storing each step's result. On its first tick, and after
 *    each run and Test connection, it stores the folder's listing.
 * 2. Marks a run whose worker stopped (no heartbeat for 10 minutes) as failed.
 * 3. Takes one piece of work, in this order: a Test restore the owner asked
 *    for, a "Back up now", the daily time when it is due, or the one retry
 *    of a failed backup an hour after it failed. Only one runs at a time,
 *    in any number of workers (state.ts).
 * 4. Runs it (run.ts), touching its heartbeat each minute, and records how
 *    it ended. A failed backup is tried once more RETRY_AFTER_MS later,
 *    not again and again; after a backup that worked, retention deletes
 *    the folder's backups past the days to keep.
 *
 * Failures show on the Backups tab, and as storage warnings, which notify
 * the channels chosen for them (storage/warning-job.ts).
 */

/** How often the worker looks for due work: a "Back up now" waits at most this long. */
export const BACKUP_TICK_MS = 30_000;
/** A failed backup is tried once more after this. */
export const RETRY_AFTER_MS = 60 * 60 * 1000;
/** An unchanged destination is reported again this long after the last report: a heartbeat. */
export const REPORT_EVERY_MS = 60 * 60 * 1000;
/**
 * A report another worker wrote that differs from this worker's is written
 * over at most this often: two workers with different BACKUP_S3_* don't
 * rewrite the row on every tick.
 */
export const CONTESTED_REPORT_MS = 10 * 60 * 1000;

/** Without BACKUP_S3_*: what a run and Test connection say. */
export const NO_DESTINATION =
  "No backup destination. Set the BACKUP_S3_* variables in the server's .env, then restart the worker.";

export type BackupLog = (
  level: "info" | "warn" | "error",
  msg: string,
  fields?: Record<string, unknown>,
) => void;

interface Work {
  kind: RunKind;
  trigger: RunTrigger;
}

export interface BackupJobOptions {
  db: Kysely<Database>;
  /**
   * Where backups go: the worker's BACKUP_S3_* (config.ts, loadBackupS3);
   * the problem with them, in words; or null when none is set.
   */
  destination: Destination | { problem: string } | null;
  secrets: BackupSecrets;
  sources: BackupSources;
  version: string;
  log: BackupLog;
  now?: () => Date;
  /** How often a run touches its heartbeat; tests shorten it. */
  heartbeatMs?: number;
}

export class BackupJob {
  readonly #options: BackupJobOptions;
  readonly #now: () => Date;
  readonly #heartbeatMs: number;
  #abort = new AbortController();
  #failing = false;
  /** Whether this worker stored the listing yet: once on start, then after changes. */
  #listed = false;
  /** When this worker last wrote its report; null before it has. */
  #reportedAt: Date | null = null;
  /** Whether it logged its configuration problem: once, at its first report. */
  #problemLogged = false;

  constructor(options: BackupJobOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  }

  /** Stops a run in progress: it fails, saying the worker stopped, and cleans up. */
  stop(): void {
    this.#abort.abort();
  }

  /** One look for work, and the work; never throws. */
  async tick(): Promise<Work | null> {
    try {
      const work = await this.#take();
      if (this.#failing) this.#options.log("info", "running due backups works again");
      this.#failing = false;
      return work;
    } catch (error) {
      if (!this.#failing) {
        this.#options.log("error", "running due backups failed", { err: String(error) });
      }
      this.#failing = true;
      return null;
    }
  }

  async #take(): Promise<Work | null> {
    const { db } = this.#options;
    if (this.#abort.signal.aborted) return null;
    await this.#report();
    const tested = await this.#testConnection();
    if (!this.#listed || tested) await this.#storeListing();
    const now = this.#now();
    const stale = await failStaleRuns(db, now);
    if (stale > 0) this.#options.log("warn", "worker stopped; backup run marked failed");
    // A backup a worker's stop cut off is tried once more, now: the day is not skipped.
    if (await retryStoppedBackup(db, now)) {
      this.#options.log("info", "retrying backup interrupted by worker shutdown");
    }
    const { timeZone } = await readInstanceSettings(db);

    const claimed = await db.transaction().execute(async (trx) => {
      const settings = await readBackupSettings(trx, { lock: true });
      let work: Work | null = null;
      if (settings.testRestoreRequestedAt !== null) {
        work = { kind: "test_restore", trigger: "manual" };
      } else if (settings.backupRequestedAt !== null) {
        work = { kind: "backup", trigger: "manual" };
      } else {
        const slot = dueSlot(now, settings, timeZone);
        if (slot !== null) work = { kind: "backup", trigger: "schedule" };
        else if (
          settings.enabled &&
          settings.retryAt !== null &&
          settings.retryAt.getTime() <= now.getTime()
        ) {
          work = { kind: "backup", trigger: "retry" };
        }
      }
      if (work === null) return null;
      const id = await startRun(trx, work.kind, work.trigger, now);
      // Another run is under way: the request waits for the next tick.
      if (id === null) return null;
      const slot = dueSlot(now, settings, timeZone);
      await trx
        .updateTable("backup_settings")
        .set({
          ...(work.kind === "test_restore" ? { test_restore_requested_at: null } : {}),
          ...(work.trigger === "manual" && work.kind === "backup"
            ? { backup_requested_at: null }
            : {}),
          ...(work.trigger === "schedule" && slot !== null ? { last_slot: slot.day } : {}),
          // A new backup replaces a pending retry: it is the retry.
          ...(work.kind === "backup" ? { retry_at: null } : {}),
        })
        .execute();
      return { id, work };
    });
    if (claimed === null) return null;
    await this.#run(claimed.id, claimed.work);
    // A backup and its retention change the folder.
    if (!this.#abort.signal.aborted) await this.#storeListing();
    return claimed.work;
  }

  /** The destination's non-secret parts, or the problem in words. */
  #reportNow(): { destination: DestinationReport | null; problem: string | null } {
    const { destination } = this.#options;
    if (destination === null) return { destination: null, problem: null };
    if ("problem" in destination) return { destination: null, problem: destination.problem };
    return { destination: reportOf(destination), problem: null };
  }

  /**
   * Writes what this worker has to PostgreSQL: when nothing is there yet;
   * when the same report is REPORT_EVERY_MS old (a heartbeat); and when
   * another worker's report differs, at most every CONTESTED_REPORT_MS. Of
   * several workers, the last write wins. Its configuration problem is
   * logged once: the variables don't change while it runs.
   */
  async #report(): Promise<void> {
    const { db } = this.#options;
    const now = this.#now();
    const report = this.#reportNow();
    if (report.problem !== null && !this.#problemLogged) {
      this.#problemLogged = true;
      this.#options.log("error", "the backup destination is invalid: backups can't run", {
        problem: report.problem,
      });
    }
    const saved = await readBackupSettings(db);
    const same =
      saved.destinationProblem === report.problem &&
      sameDestination(saved.destination, report.destination);
    const since = (at: Date | null) => (at === null ? Infinity : now.getTime() - at.getTime());
    if (same && since(saved.destinationReportedAt) < REPORT_EVERY_MS) return;
    if (
      !same &&
      saved.destinationReportedAt !== null &&
      since(this.#reportedAt) < CONTESTED_REPORT_MS
    ) {
      return;
    }
    this.#reportedAt = now;
    await db
      .updateTable("backup_settings")
      .set({
        destination: report.destination === null ? null : JSON.stringify(report.destination),
        destination_problem: report.problem,
        destination_reported_at: now,
      })
      .execute();
  }

  /** A client for the destination, or why there is none. */
  #client(): { destination: Destination; client: S3Client } | { problem: string } {
    const { destination } = this.#options;
    if (destination === null) return { problem: NO_DESTINATION };
    if ("problem" in destination) return { problem: destination.problem };
    return { destination, client: backupClient(destination) };
  }

  /** Runs the Test connection the owner asked for, if any; true when it ran. */
  async #testConnection(): Promise<boolean> {
    const { db } = this.#options;
    const settings = await readBackupSettings(db);
    if (settings.connectionTestRequestedAt === null) return false;
    const target = this.#client();
    let result: StoredConnectionTest;
    if ("problem" in target) {
      result = { ok: false, steps: [], error: target.problem };
    } else {
      try {
        const steps = await testConnection(
          target.client,
          target.destination.bucket,
          target.destination.prefix,
          AbortSignal.any([this.#abort.signal, AbortSignal.timeout(30_000)]),
        );
        result = { ok: steps.every((step) => step.status === "ok"), steps };
      } finally {
        target.client.destroy();
      }
      // Cut off by this worker stopping: the request stays for the next worker.
      if (this.#abort.signal.aborted) return false;
    }
    await db
      .updateTable("backup_settings")
      .set({
        connection_test: JSON.stringify(result),
        connection_tested_at: this.#now(),
        connection_test_requested_at: null,
      })
      .execute();
    this.#options.log(result.ok ? "info" : "warn", "backup test connection ran", {
      ok: result.ok,
    });
    return true;
  }

  /**
   * Stores the folder's backups as listed now, or why they could not be
   * listed; nothing without a destination.
   */
  async #storeListing(): Promise<void> {
    const { db } = this.#options;
    this.#listed = true;
    const target = this.#client();
    let list: StoredBackupList | null = null;
    if (!("problem" in target)) {
      const { bucket, prefix } = target.destination;
      try {
        const backups = await listBackups(
          target.client,
          bucket,
          prefix,
          AbortSignal.any([this.#abort.signal, AbortSignal.timeout(20_000)]),
        );
        list = {
          ok: true,
          bucket,
          prefix,
          backups: backups.map((backup) => ({
            name: backup.name,
            at: backup.at.toISOString(),
            bytes: backup.bytes,
            complete: backup.complete,
          })),
        };
      } catch (error) {
        // Cut off by this worker stopping: the stored listing stays as it was.
        if (this.#abort.signal.aborted) return;
        list = {
          ok: false,
          bucket,
          prefix,
          error: `Couldn't list backups: ${s3ErrorText(error, "list")}`,
        };
      } finally {
        target.client.destroy();
      }
    }
    await db
      .updateTable("backup_settings")
      .set({
        backup_list: list === null ? null : JSON.stringify(list),
        backup_listed_at: list === null ? null : this.#now(),
      })
      .execute();
  }

  async #run(id: string, work: Work): Promise<void> {
    const { db, log } = this.#options;
    const run = { id, kind: work.kind };
    // Stops this run alone: another worker marked it stale, so it must not go on.
    const takenOver = new AbortController();
    const signal = AbortSignal.any([this.#abort.signal, takenOver.signal]);
    const heartbeat = setInterval(() => {
      touchRun(db, id, this.#now()).then(
        (touched) => {
          if (touched === 0 && !takenOver.signal.aborted) {
            log("warn", "backup run stopped after another worker marked it stale");
            takenOver.abort();
          }
        },
        () => undefined,
      );
    }, this.#heartbeatMs);
    log("info", work.kind === "backup" ? "backup started" : "test restore started", {
      trigger: work.trigger,
    });
    try {
      let outcome =
        work.kind === "backup"
          ? await this.#backup(work.trigger, signal)
          : await this.#testRestore(signal);
      if (outcome.status === "failed" && takenOver.signal.aborted) {
        outcome = { status: "failed", error: RUN_TAKEN_OVER };
      } else if (
        outcome.status === "failed" &&
        work.kind === "backup" &&
        this.#abort.signal.aborted
      ) {
        outcome = { status: "failed", error: WORKER_SHUTDOWN };
      }
      // A run marked stale is already finished: its row stays as the other worker left it.
      if (!takenOver.signal.aborted) await finishRun(db, run, outcome, this.#now());
      if (outcome.status === "failed") {
        log("error", work.kind === "backup" ? "backup failed" : "test restore failed", {
          trigger: work.trigger,
          err: outcome.error,
        });
        if (work.kind === "backup" && work.trigger !== "retry" && !signal.aborted) {
          await db
            .updateTable("backup_settings")
            .set({ retry_at: new Date(this.#now().getTime() + RETRY_AFTER_MS) })
            .execute();
        }
      } else {
        log("info", work.kind === "backup" ? "backup finished" : "test restore passed", {
          folder: outcome.folder,
          bytes: outcome.bytes,
        });
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** The saved settings, with the destination and its client, or why there is none. */
  async #destination() {
    const settings = await readBackupSettings(this.#options.db);
    const target = this.#client();
    if ("problem" in target) return { settings, problem: target.problem };
    return { settings, ...target, problem: undefined };
  }

  async #backup(
    trigger: RunTrigger,
    signal: AbortSignal,
  ): Promise<
    { status: "succeeded"; folder: string; bytes: number } | { status: "failed"; error: string }
  > {
    const target = await this.#destination();
    if (target.problem !== undefined) return { status: "failed", error: target.problem };
    const { settings, destination, client } = target;
    if (settings.keyRecipient === null || settings.keySealed === null) {
      client.destroy();
      return {
        status: "failed",
        error: "Turn on backups and save to create a key.",
      };
    }
    // The identity signs the manifest (secrets.ts, manifestMac).
    const identity = this.#options.secrets.openKey(settings.keySealed);
    if (identity === null) {
      client.destroy();
      return {
        status: "failed",
        error: "AUTH_SECRET changed. Create and save a new key in Settings > Backups.",
      };
    }
    try {
      const result = await runBackup({
        sources: this.#options.sources,
        destination,
        client,
        key: { identity, recipient: settings.keyRecipient },
        version: this.#options.version,
        now: this.#now,
        signal,
        onStep: (step) => this.#options.log("info", `backup: ${step}`, { trigger }),
      });
      try {
        const deleted = await applyRetention(client, destination, settings.keepDays, this.#now());
        if (deleted.length > 0) {
          this.#options.log("info", "old backups deleted", {
            deleted,
            keepDays: settings.keepDays,
          });
        }
      } catch (error) {
        // The backup itself worked; old ones are tried again after the next.
        this.#options.log("warn", "deleting old backups failed", {
          err: s3ErrorText(error, "delete"),
        });
      }
      return { status: "succeeded", folder: result.name, bytes: result.bytes };
    } catch (error) {
      const message =
        error instanceof BackupError
          ? error.message
          : `Backup failed: ${error instanceof Error ? error.message : String(error)}`;
      return {
        status: "failed",
        error: signal.aborted ? WORKER_SHUTDOWN : message,
      };
    } finally {
      client.destroy();
    }
  }

  async #testRestore(
    signal: AbortSignal,
  ): Promise<
    { status: "succeeded"; folder: string; bytes: number } | { status: "failed"; error: string }
  > {
    const target = await this.#destination();
    if (target.problem !== undefined) return { status: "failed", error: target.problem };
    const { settings, destination, client } = target;
    try {
      const identity =
        settings.keySealed === null ? null : this.#options.secrets.openKey(settings.keySealed);
      if (identity === null) {
        return {
          status: "failed",
          error:
            settings.keySealed === null
              ? "No backup key to check."
              : "AUTH_SECRET changed. Check the backup with your saved key file (docs/deployment.md, Restoring from S3).",
        };
      }
      const checked = await testRestore({
        client,
        destination,
        identity,
        signal,
      });
      return { status: "succeeded", folder: checked.name, bytes: checked.bytes };
    } catch (error) {
      return {
        status: "failed",
        error:
          error instanceof BackupError
            ? error.message
            : `Test restore failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      client.destroy();
    }
  }
}

/** Whether two reports name the same destination: PostgreSQL's JSON may order keys its own way. */
function sameDestination(a: DestinationReport | null, b: DestinationReport | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.endpoint === b.endpoint &&
    a.region === b.region &&
    a.bucket === b.bucket &&
    a.prefix === b.prefix &&
    a.accessKeyId === b.accessKeyId
  );
}
