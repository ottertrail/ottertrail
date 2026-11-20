import type { Kysely } from "kysely";

import type { ObjectStoreConfig } from "../config.ts";
import type { Database } from "../db/schema.ts";
import { readInstanceSettings } from "../settings/settings.ts";
import { applyRetention, BackupError, type BackupSources, runBackup, testRestore } from "./run.ts";
import { backupClient, type OutboundRules, s3ErrorText } from "./s3.ts";
import { dueSlot } from "./schedule.ts";
import type { BackupSecrets } from "./secrets.ts";
import { destinationModeOf, destinationOf, readBackupSettings } from "./settings.ts";
import {
  failStaleRuns,
  finishRun,
  HEARTBEAT_MS,
  type RunKind,
  type RunTrigger,
  startRun,
  touchRun,
} from "./state.ts";

/**
 * The worker's backups (docs/deployment.md, "Backups"), every BACKUP_TICK_MS:
 *
 * 1. Marks a run whose worker stopped (no heartbeat for 10 minutes) as failed.
 * 2. Takes one piece of work, in this order: a Test restore the owner asked
 *    for, a "Back up now", the daily time when it is due, or the one retry
 *    of a failed backup an hour after it failed. Only one runs at a time,
 *    in any number of workers (state.ts).
 * 3. Runs it (run.ts), touching its heartbeat each minute, and records how
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
  /** The object store (OBJECT_STORE_*), and whether it is the stack's own Garage. */
  objectStore: ObjectStoreConfig | null;
  stackGarage: boolean;
  secrets: BackupSecrets;
  rules: OutboundRules;
  sources: BackupSources;
  version: string;
  log: BackupLog;
  now?: () => Date;
}

export class BackupJob {
  readonly #options: BackupJobOptions;
  readonly #now: () => Date;
  #abort = new AbortController();
  #failing = false;

  constructor(options: BackupJobOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  /** Stops a run in progress: it fails, saying the worker stopped, and cleans up. */
  stop(): void {
    this.#abort.abort();
  }

  /** One look for work, and the work; never throws. */
  async tick(): Promise<Work | null> {
    try {
      const work = await this.#take();
      if (this.#failing) this.#options.log("info", "taking backups works again");
      this.#failing = false;
      return work;
    } catch (error) {
      if (!this.#failing) {
        this.#options.log("error", "taking due backups failed", { err: String(error) });
      }
      this.#failing = true;
      return null;
    }
  }

  async #take(): Promise<Work | null> {
    const { db } = this.#options;
    if (this.#abort.signal.aborted) return null;
    const now = this.#now();
    const stale = await failStaleRuns(db, now);
    if (stale > 0) this.#options.log("warn", "a backup run's worker stopped; it was marked failed");
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
    return claimed.work;
  }

  async #run(id: string, work: Work): Promise<void> {
    const { db, log } = this.#options;
    const run = { id, kind: work.kind };
    const heartbeat = setInterval(() => {
      void touchRun(db, id, this.#now()).catch(() => undefined);
    }, HEARTBEAT_MS);
    log("info", work.kind === "backup" ? "a backup started" : "a test restore started", {
      trigger: work.trigger,
    });
    try {
      const outcome =
        work.kind === "backup" ? await this.#backup(work.trigger) : await this.#testRestore();
      await finishRun(db, run, outcome, this.#now());
      if (outcome.status === "failed") {
        log("error", work.kind === "backup" ? "a backup failed" : "a test restore failed", {
          trigger: work.trigger,
          err: outcome.error,
        });
        if (work.kind === "backup" && work.trigger !== "retry" && !this.#abort.signal.aborted) {
          await db
            .updateTable("backup_settings")
            .set({ retry_at: new Date(this.#now().getTime() + RETRY_AFTER_MS) })
            .execute();
        }
      } else {
        log("info", work.kind === "backup" ? "a backup finished" : "a test restore passed", {
          folder: outcome.folder,
          bytes: outcome.bytes,
        });
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** The destination and its client for the saved settings, or why there is none. */
  async #destination() {
    const { db, objectStore, stackGarage, secrets, rules } = this.#options;
    const settings = await readBackupSettings(db);
    const destination = destinationOf(
      destinationModeOf(objectStore, stackGarage),
      { ...settings, secretAccessKey: null },
      secrets,
    );
    if ("problem" in destination) return { settings, problem: destination.problem };
    try {
      return { settings, destination, client: backupClient(destination, rules) };
    } catch (error) {
      return { settings, problem: `The destination can't be used: ${s3ErrorText(error)}` };
    }
  }

  async #backup(
    trigger: RunTrigger,
  ): Promise<
    { status: "succeeded"; folder: string; bytes: number } | { status: "failed"; error: string }
  > {
    const target = await this.#destination();
    if (target.problem !== undefined) return { status: "failed", error: target.problem };
    const { settings, destination, client } = target;
    if (settings.keyRecipient === null) {
      return {
        status: "failed",
        error: "There is no backup key yet: turn backups on and save, which makes one.",
      };
    }
    try {
      const result = await runBackup({
        sources: this.#options.sources,
        destination,
        client,
        recipient: settings.keyRecipient,
        version: this.#options.version,
        now: this.#now,
        signal: this.#abort.signal,
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
          : `The backup failed: ${error instanceof Error ? error.message : String(error)}`;
      return {
        status: "failed",
        error: this.#abort.signal.aborted
          ? "The worker was stopped during the backup, so it did not finish. Nothing it uploaded was kept."
          : message,
      };
    } finally {
      client.destroy();
    }
  }

  async #testRestore(): Promise<
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
              ? "There is no backup key yet, so there is nothing to check."
              : "The backup key can't be read: AUTH_SECRET changed since it was made. Check a backup with the key file you saved instead (docs/deployment.md, Restoring from S3).",
        };
      }
      const checked = await testRestore({
        client,
        destination,
        identity,
        signal: this.#abort.signal,
      });
      return { status: "succeeded", folder: checked.name, bytes: checked.bytes };
    } catch (error) {
      return {
        status: "failed",
        error:
          error instanceof BackupError
            ? error.message
            : `The test restore failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      client.destroy();
    }
  }
}
