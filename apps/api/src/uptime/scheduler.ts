import type { Kysely } from "kysely";

import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import type { Database } from "../db/schema.ts";
import type { AddressPolicy, Lookup } from "../outbound/addresses.ts";
import { type DueCheck, recordOutcome, type StateChange, takeDueChecks } from "./checks.ts";
import { type CheckOutcome, type RequestOptions, runRequest } from "./request.ts";
import { storeResult } from "./results.ts";
import { parseStatuses } from "./statuses.ts";

export const MAX_RUNNING = 20;

/**
 * Reserve half the slots for other projects so one project's slow checks cannot fill the
 * worker.
 */
export const MAX_RUNNING_PER_PROJECT = 10;

export const CHECK_TICK_MS = 2000;

/** A check taken this long after it was due is late: the worker logs that it is behind. */
export const LATE_MS = 30_000;

export interface SchedulerOptions {
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  policy: AddressPolicy;
  lookup?: Lookup | undefined;
  /** Certificates to trust besides the system's (tests). */
  ca?: RequestOptions["ca"];
  maxRunning?: number;
  maxRunningPerProject?: number;
  /** The clock of a run's start; takeDueChecks reads PostgreSQL's. */
  now?: () => Date;
  /** The moment checks are taken at (tests); PostgreSQL's now() when left out. */
  takeAt?: () => Date;
  /** Called with each check that goes down or comes back up (checks.ts, StateChange). */
  onStateChange?: (change: StateChange) => void | Promise<void>;
  /**
   * Called when a run recorded a certificate expiry other than the one the
   * check had (alert rules on certificates, alerts/evaluator.ts).
   */
  onCertificate?: (check: {
    checkId: string;
    projectId: string;
    expiresAt: Date;
  }) => void | Promise<void>;
  /** Logs a failure to store results once per outage, and when it works again. */
  log?: (level: "info" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * Start claimed checks without waiting, enforcing global and per-project limits. Log backlog
 * once while it lasts. Record outcomes in PostgreSQL before writing ClickHouse results.
 */
export class CheckScheduler {
  readonly #options: SchedulerOptions;
  readonly #running = new Set<Promise<void>>();
  readonly #byProject = new Map<string, number>();
  #resultsFailing = false;
  #late = false;

  constructor(options: SchedulerOptions) {
    this.#options = options;
  }

  get running(): number {
    return this.#running.size;
  }

  async tick(): Promise<number> {
    const {
      db,
      maxRunning = MAX_RUNNING,
      maxRunningPerProject = MAX_RUNNING_PER_PROJECT,
      takeAt,
      log,
    } = this.#options;
    const due = await takeDueChecks(db, {
      limit: maxRunning - this.#running.size,
      perProject: maxRunningPerProject,
      running: this.#byProject,
      now: takeAt?.(),
    });
    const lateness = Math.max(
      0,
      ...due.map((check) => check.taken_at.getTime() - check.due_at.getTime()),
    );
    if (due.length > 0 && lateness >= LATE_MS && !this.#late) {
      log?.("error", "uptime checks are running late: more are due than there are places", {
        lateMs: lateness,
        running: this.#running.size,
      });
      this.#late = true;
    } else if (due.length > 0 && lateness < LATE_MS && this.#late) {
      log?.("info", "uptime checks run on time again");
      this.#late = false;
    }
    for (const check of due) {
      const project = check.project_id;
      this.#byProject.set(project, (this.#byProject.get(project) ?? 0) + 1);
      const run: Promise<void> = this.run(check).then(
        () => undefined,
        () => undefined,
      );
      void run.finally(() => {
        this.#running.delete(run);
        const left = (this.#byProject.get(project) ?? 1) - 1;
        if (left <= 0) this.#byProject.delete(project);
        else this.#byProject.set(project, left);
      });
      this.#running.add(run);
    }
    return due.length;
  }

  async drain(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled(this.#running);
  }

  /** Runs one check and records its outcome; never throws. */
  async run(check: DueCheck): Promise<CheckOutcome> {
    const { db, clickhouse, policy, lookup, ca, now = () => new Date(), log } = this.#options;
    const at = now();
    const outcome = await runRequest(
      {
        url: check.url,
        method: check.method,
        timeoutMs: check.timeout_seconds * 1000,
        expected: parseStatuses(check.expected_statuses) ?? [{ from: 200, to: 399 }],
        word: check.word,
        wordMode: check.word_mode,
      },
      { policy, lookup, ca },
    );
    if (outcome.refused !== undefined) {
      // Log refused addresses privately; dashboard errors hide them.
      log?.("info", "an uptime check's address was refused", {
        check: check.id,
        project: check.project_id,
        ...outcome.refused,
      });
    }
    try {
      const change = await recordOutcome(db, check.id, outcome, at);
      if (change !== null) await this.#options.onStateChange?.(change);
      const expiresAt = outcome.tlsExpiresAt;
      if (expiresAt !== null && expiresAt.getTime() !== check.tls_expires_at?.getTime()) {
        await this.#options.onCertificate?.({
          checkId: check.id,
          projectId: check.project_id,
          expiresAt,
        });
      }
    } catch (error) {
      log?.("error", "recording an uptime check's outcome failed", {
        check: check.id,
        err: String(error),
      });
    }
    try {
      await storeResult(clickhouse, { id: check.id, projectId: check.project_id }, outcome, at);
      if (this.#resultsFailing) log?.("info", "storing uptime check results works again");
      this.#resultsFailing = false;
    } catch (error) {
      if (!this.#resultsFailing) {
        log?.("error", "storing uptime check results failed", { err: String(error) });
      }
      this.#resultsFailing = true;
    }
    return outcome;
  }
}
