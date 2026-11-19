import { type Kysely, sql } from "kysely";

import { retryFirstSeenRebuilds, type RoomCheck } from "../clickhouse/delete-events.ts";
import type { Database } from "../db/schema.ts";
import { notifyIn } from "../notifications/deliveries.ts";
import { MAX_MESSAGE } from "../notifications/events.ts";
import type { GarageAdmin } from "./garage-admin.ts";
import { measureStorage, quotaPlanOf, type StorageReading, type StorageSources } from "./usage.ts";
import { readActiveWarnings, readWarningChannels } from "./warning-state.ts";
import { evaluateWarnings, recovery, type WarningId, type WarningLevel } from "./warnings.ts";

/**
 * The worker's storage check (docs/deployment.md, "Storage warnings"),
 * every STORAGE_CHECK_INTERVAL_MS:
 *
 * 1. Measures every store (usage.ts).
 * 2. On the stack's Garage with its admin token, sets the bucket's quota
 *    to the budgets plus 10%, never below what the bucket holds plus the
 *    budgets' room (plannedQuota), when it differs: at the worker's start,
 *    and so after a change of budget, which needs a restart.
 * 3. Works out the warnings (warnings.ts) against the ones already on,
 *    in PostgreSQL, and records the change: a warning that starts, or
 *    rises to critical, sends `storage.low`; one that ends sends
 *    `storage.recovered`, to the channels the setting names. A warning
 *    whose figures could not be measured stays as it was.
 *
 * 4. Rebuilds the first-seen times a rebuild skipped for lack of disk, or
 *    left part way, once ClickHouse has room again
 *    (clickhouse/delete-events.ts, retryFirstSeenRebuilds).
 *
 * Two workers at once take turns on an advisory lock, so a change is
 * notified once.
 */

/** How often the worker checks: disks fill over hours, and a check is a few small queries. */
export const STORAGE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** The advisory lock the check holds while it records a change ("stor" in ASCII). */
const LOCK_KEY = 0x73746f72;

export type StorageLog = (
  level: "info" | "warn" | "error",
  msg: string,
  fields?: Record<string, unknown>,
) => void;

export interface StorageCheckResult {
  started: WarningId[];
  raised: WarningId[];
  ended: WarningId[];
  /** The quota set on the bucket this time, if it changed. */
  quotaSet: number | null;
  /** Projects whose marked first-seen rebuild ran (or waited for room) this time. */
  firstSeen: { projects: number; outcome: "rebuilt" | "deferred" | "none" | "failed" };
}

const cut = (text: string) =>
  text.length <= MAX_MESSAGE ? text : `${text.slice(0, MAX_MESSAGE - 1)}…`;

export class StorageWarningJob {
  readonly #db: Kysely<Database>;
  readonly #sources: StorageSources;
  readonly #publicUrl: string;
  readonly #log: StorageLog;
  readonly #now: () => Date;
  readonly #room: RoomCheck;
  /** Whether the last quota call failed: logged once until it works again. */
  #quotaFailing = false;
  #checkFailing = false;

  constructor(options: {
    db: Kysely<Database>;
    sources: StorageSources;
    publicUrl: string;
    log: StorageLog;
    now?: () => Date;
    /** How a first-seen rebuild learns ClickHouse's free share; tests replace it. */
    room?: RoomCheck;
  }) {
    this.#db = options.db;
    this.#sources = options.sources;
    this.#publicUrl = options.publicUrl;
    this.#log = options.log;
    this.#now = options.now ?? (() => new Date());
    this.#room = options.room ?? {};
  }

  /** One check; never throws: a failure is logged, and the next check tries again. */
  async tick(): Promise<StorageCheckResult | null> {
    try {
      const reading = await measureStorage(this.#sources, {
        now: this.#now,
        log: (msg, fields) => this.#log("warn", msg, fields),
      });
      const quotaSet = await this.#applyQuota(reading);
      const result = {
        ...(await this.#record(reading)),
        quotaSet,
        firstSeen: await this.#retryFirstSeen(),
      };
      if (this.#checkFailing) this.#log("info", "the storage check works again");
      this.#checkFailing = false;
      return result;
    } catch (error) {
      if (!this.#checkFailing) {
        this.#log("error", "the storage check failed", { err: String(error) });
      }
      this.#checkFailing = true;
      return null;
    }
  }

  async #retryFirstSeen(): Promise<StorageCheckResult["firstSeen"]> {
    try {
      const result = await retryFirstSeenRebuilds(this.#db, this.#sources.clickhouse, this.#room);
      if (result.outcome === "rebuilt") {
        this.#log("info", "first-seen times worked out again after a skipped rebuild", {
          projects: result.projects,
        });
      }
      return result;
    } catch (error) {
      this.#log("warn", "a marked first-seen rebuild failed; it is tried again later", {
        err: String(error),
      });
      return { projects: 0, outcome: "failed" };
    }
  }

  async #applyQuota(reading: StorageReading): Promise<number | null> {
    const admin: GarageAdmin | "no_token" | null = this.#sources.garage;
    const garage = reading.garage;
    if (
      admin === null ||
      admin === "no_token" ||
      garage?.state !== "ok" ||
      garage.bucket === null
    ) {
      return null;
    }
    const plan = quotaPlanOf(this.#sources.budgets, reading);
    // Without the budgets' figures, the floor under the quota is unknown: wait.
    if (!plan.measured) return null;
    const quota = plan.bytes;
    if (garage.bucket.maxSize === quota) return null;
    try {
      await admin.setQuota(garage.bucket.id, quota);
      this.#log(
        "info",
        plan.aboveBudgets
          ? "Garage's bucket quota set above the budgets: the bucket holds more than they leave room for"
          : "Garage's bucket quota set: the replay and source map budgets plus 10%",
        { maxSize: quota, previous: garage.bucket.maxSize },
      );
      this.#quotaFailing = false;
      return quota;
    } catch (error) {
      if (!this.#quotaFailing) {
        // The message never holds the token (garage-admin.ts).
        this.#log("warn", "Garage's bucket quota could not be set", { err: String(error) });
      }
      this.#quotaFailing = true;
      return null;
    }
  }

  async #record(
    reading: StorageReading,
  ): Promise<{ started: WarningId[]; raised: WarningId[]; ended: WarningId[] }> {
    const url = `${this.#publicUrl}/settings?tab=storage`;
    const now = reading.measuredAt;
    return this.#db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(${LOCK_KEY})`.execute(trx);
      const active = await readActiveWarnings(trx, { lock: true });
      const levels = new Map<WarningId, WarningLevel>(
        [...active].map(([id, warning]) => [id, warning.level]),
      );
      const { warnings, undetermined } = evaluateWarnings(reading, levels);
      const channelIds = await readWarningChannels(trx);
      const started: WarningId[] = [];
      const raised: WarningId[] = [];
      const ended: WarningId[] = [];

      for (const warning of warnings) {
        const was = active.get(warning.id);
        if (was === undefined) {
          await trx
            .insertInto("storage_warnings")
            .values({ warning: warning.id, level: warning.level, started_at: now, updated_at: now })
            .execute();
          started.push(warning.id);
        } else {
          await trx
            .updateTable("storage_warnings")
            .set({ level: warning.level, updated_at: now })
            .where("warning", "=", warning.id)
            .execute();
          // A rise to critical is news; a fall back to a warning is not.
          if (!(was.level === "warning" && warning.level === "critical")) continue;
          raised.push(warning.id);
        }
        await notifyIn(trx, {
          channelIds,
          type: "storage.low",
          project: null,
          subject: {
            type: "storage",
            warning: warning.id,
            level: warning.level,
            ...warning.figures,
          },
          message: cut(`${warning.title}. ${warning.text}`),
          url,
          time: now,
        });
      }

      for (const id of active.keys()) {
        if (warnings.some((warning) => warning.id === id) || undetermined.includes(id)) continue;
        await trx.deleteFrom("storage_warnings").where("warning", "=", id).execute();
        ended.push(id);
        const { message, figures } = recovery(id, reading);
        await notifyIn(trx, {
          channelIds,
          type: "storage.recovered",
          project: null,
          subject: { type: "storage", warning: id, ...figures },
          message: cut(message),
          url,
          time: now,
        });
      }

      for (const id of started) {
        this.#log("warn", "a storage warning started", {
          warning: id,
          level: warnings.find((w) => w.id === id)?.level,
        });
      }
      for (const id of raised)
        this.#log("warn", "a storage warning became critical", { warning: id });
      for (const id of ended) this.#log("info", "a storage warning ended", { warning: id });
      return { started, raised, ended };
    });
  }
}
