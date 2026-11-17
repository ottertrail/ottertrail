import { createHmac, randomBytes } from "node:crypto";

import type { Kysely } from "kysely";

import { MAX_EVENT_AGE_MS } from "../collection/normalize.ts";
import type { Database } from "../db/schema.ts";

/**
 * Returns the calendar day of a moment in a timezone, as "YYYY-MM-DD".
 * Salts change at midnight in the organization's timezone, the same days
 * that its reports count in, so one visit is never split across two salts
 * within a reported day.
 */
export function dayIn(timeZone: string): (moment: Date) => string {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (moment) => {
    const parts = Object.fromEntries(
      format.formatToParts(moment).map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
}

/**
 * The official name of a timezone this Node.js runtime knows, or undefined.
 * Old aliases and other spellings become one name: "singapore" becomes
 * "Asia/Singapore", "GMT" becomes "UTC", "US/Pacific" becomes
 * "America/Los_Angeles". Ottertrail then stores and reports one name.
 *
 * Fixed offsets such as "+08:00" are refused. Node reads "+08:00" as eight
 * hours ahead of UTC, but PostgreSQL reads the same text as a POSIX offset,
 * eight hours behind, so visitor days and report days would disagree by 16
 * hours. Named zones come from the same timezone database in both.
 */
export function canonicalTimeZone(name: string): string | undefined {
  let resolved: string;
  try {
    // Throws a RangeError for names it does not know.
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
  return resolved.startsWith("+") || resolved.startsWith("-") ? undefined : resolved;
}

/**
 * A visitor ID: the first 8 bytes of HMAC-SHA256(salt, project, IP, User-Agent),
 * as a signed 64-bit integer in decimal.
 *
 * The same browser on the same network gets the same ID for one day in one
 * project. The project is part of the input, so one person on two projects
 * cannot be linked. Without the salt, the IP address cannot be worked back
 * out of the ID.
 */
export function visitorId(salt: Buffer, projectId: string, ip: string, userAgent: string): string {
  const digest = createHmac("sha256", salt).update(`${projectId}\n${ip}\n${userAgent}`).digest();
  return digest.readBigInt64BE(0).toString();
}

/**
 * How long a salt outlives the window in which events are accepted. The
 * endpoint and the cleanup each read the clock at a slightly different
 * moment; without this margin, an event accepted at the very edge of the
 * 24-hour window could find its salt deleted a moment later and be given a
 * new one, and with it the wrong visitor ID.
 */
export const SALT_GRACE_MS = 60 * 60 * 1000;

/** How often expired salts are deleted, with or without traffic. */
export const SALT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface VisitorIdsOptions {
  now?: () => number;
}

/** A salt's key in this process's cache: its timezone and day. */
interface SaltKey {
  timeZone: string;
  day: string;
}

/**
 * Hands out visitor IDs, creating each salt the first time it is needed and
 * deleting salts no event can still need.
 *
 * There is one salt per timezone and day: each organization's visitor IDs
 * change at its own midnight, and organizations in the same timezone share
 * salts (the project in every ID keeps them apart). Salts live in
 * PostgreSQL so every API process and every restart uses the same salt for
 * the same day. Each process caches them in memory.
 */
export class VisitorIds {
  readonly #db: Kysely<Database>;
  readonly #now: () => number;
  /** Day formatters by timezone: building one is far slower than using it. */
  readonly #dayFormats = new Map<string, (moment: Date) => string>();
  /** Salts by `${timeZone} ${day}`. */
  readonly #salts = new Map<string, { key: SaltKey; salt: Promise<Buffer> }>();

  constructor(db: Kysely<Database>, { now = Date.now }: VisitorIdsOptions = {}) {
    this.#db = db;
    this.#now = now;
  }

  /**
   * The visitor ID for an event, using the salt of the day the event
   * happened in its organization's timezone.
   */
  async idFor(input: {
    projectId: string;
    /** The project's organization's timezone. */
    timeZone: string;
    ip: string;
    userAgent: string;
    occurredAt: Date;
  }): Promise<string> {
    const salt = await this.#salt({
      timeZone: input.timeZone,
      day: this.#day(input.timeZone)(input.occurredAt),
    });
    return visitorId(salt, input.projectId, input.ip, input.userAgent);
  }

  /**
   * The oldest day whose salt is still kept in a timezone. Events arrive up
   * to 24 hours late, so a day's salt is needed until 24 hours after the
   * day ends; it is kept one hour longer (SALT_GRACE_MS) so no accepted
   * event can lose it.
   */
  oldestKeptDay(timeZone: string): string {
    return this.#day(timeZone)(new Date(this.#now() - MAX_EVENT_AGE_MS - SALT_GRACE_MS));
  }

  /**
   * Deletes salts no future event can need, in every timezone, from
   * PostgreSQL and from this process's memory. Returns how many were
   * deleted from PostgreSQL.
   */
  async deleteExpiredSalts(): Promise<number> {
    for (const [cacheKey, { key }] of this.#salts) {
      if (key.day < this.oldestKeptDay(key.timeZone)) this.#salts.delete(cacheKey);
    }
    const zones = await this.#db
      .selectFrom("visitor_salts")
      .select("time_zone")
      .distinct()
      .execute();
    let deleted = 0;
    for (const { time_zone: timeZone } of zones) {
      const result = await this.#db
        .deleteFrom("visitor_salts")
        .where("time_zone", "=", timeZone)
        .where("day", "<", this.oldestKeptDay(timeZone))
        .executeTakeFirst();
      deleted += Number(result.numDeletedRows);
    }
    return deleted;
  }

  /**
   * Deletes expired salts now and then every `intervalMs`, so they are
   * removed on time even when no events arrive. Returns a function that
   * stops the timer. The timer does not keep the process alive.
   *
   * Runs inside each API process for now (deleting twice is harmless); the
   * background worker will take this over.
   */
  startCleanup(
    onError: (error: unknown) => void,
    intervalMs: number = SALT_CLEANUP_INTERVAL_MS,
  ): () => void {
    const run = () => {
      this.deleteExpiredSalts().catch(onError);
    };
    run();
    const timer = setInterval(run, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  #day(timeZone: string): (moment: Date) => string {
    let format = this.#dayFormats.get(timeZone);
    if (format === undefined) {
      format = dayIn(timeZone);
      this.#dayFormats.set(timeZone, format);
    }
    return format;
  }

  #salt(key: SaltKey): Promise<Buffer> {
    const cacheKey = `${key.timeZone} ${key.day}`;
    let cached = this.#salts.get(cacheKey);
    if (cached === undefined) {
      cached = { key, salt: this.#loadOrCreate(key) };
      // A failed load is not remembered, so the next request tries again.
      cached.salt.catch(() => this.#salts.delete(cacheKey));
      this.#salts.set(cacheKey, cached);
    }
    return cached.salt;
  }

  async #loadOrCreate({ timeZone, day }: SaltKey): Promise<Buffer> {
    // Several requests or API processes may reach a new day at once; the
    // first insert wins and everyone reads the same salt back.
    await this.#db
      .insertInto("visitor_salts")
      .values({ time_zone: timeZone, day, salt: randomBytes(32) })
      .onConflict((conflict) => conflict.columns(["time_zone", "day"]).doNothing())
      .execute();
    const row = await this.#db
      .selectFrom("visitor_salts")
      .select("salt")
      .where("time_zone", "=", timeZone)
      .where("day", "=", day)
      .executeTakeFirstOrThrow();
    // A new day is a good moment to drop salts that are no longer needed.
    await this.deleteExpiredSalts();
    return row.salt;
  }
}
