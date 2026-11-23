import { createHmac, randomBytes } from "node:crypto";

import type { Kysely } from "kysely";

import { MAX_EVENT_AGE_MS } from "../collection/normalize.ts";
import type { Database } from "../db/schema.ts";

/** Uses local calendar days (YYYY-MM-DD) so salt rotation matches report days. */
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
 * Canonicalizes timezone aliases, such as singapore to Asia/Singapore.
 * Reject fixed offsets: Node reads +08:00 as UTC+8, PostgreSQL as UTC-8,
 * which would shift report and visitor days by 16 hours.
 */
export function canonicalTimeZone(name: string): string | undefined {
  let resolved: string;
  try {
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
 * Keep salts past the acceptance window to cover clock reads at different moments.
 * Otherwise an event at the 24-hour boundary could get a new salt and visitor ID.
 */
export const SALT_GRACE_MS = 60 * 60 * 1000;

/** How often expired salts are deleted, with or without traffic. */
export const SALT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface VisitorIdsOptions {
  now?: () => number;
}

interface SaltKey {
  timeZone: string;
  day: string;
}

/**
 * Hands out visitor IDs, creating each salt the first time it is needed and
 * deleting salts no event can still need.
 *
 * There is one salt per timezone and day: visitor IDs change at midnight
 * in the instance's timezone, and a visit on the day it changes is not
 * split. Projects share salts (the project in every ID keeps them apart). Salts live in
 * PostgreSQL so every API process and every restart uses the same salt for
 * the same day. Each process caches them in memory.
 */
export class VisitorIds {
  readonly #db: Kysely<Database>;
  readonly #now: () => number;
  /** Cache formatters because constructing them is slow. */
  readonly #dayFormats = new Map<string, (moment: Date) => string>();
  /** Salts by `${timeZone} ${day}`. */
  readonly #salts = new Map<string, { key: SaltKey; salt: Promise<Buffer> }>();

  constructor(db: Kysely<Database>, { now = Date.now }: VisitorIdsOptions = {}) {
    this.#db = db;
    this.#now = now;
  }

  /** Uses the salt for the event's local day. */
  async idFor(input: {
    projectId: string;
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

  dayOf(timeZone: string, moment: Date): string {
    return this.#day(timeZone)(moment);
  }

  /**
   * Retain a day's salt for 24 hours after its end, plus SALT_GRACE_MS (one hour),
   * so accepted late events keep their visitor IDs.
   */
  oldestKeptDay(timeZone: string): string {
    return this.#day(timeZone)(new Date(this.#now() - MAX_EVENT_AGE_MS - SALT_GRACE_MS));
  }

  /** Deletes expired salts from PostgreSQL and memory; returns the database count. */
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
   * Delete immediately and on a timer, even without traffic. Returns a stop function;
   * the timer does not keep the process alive. Each API process runs it; duplicate
   * deletes are harmless.
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
    // Concurrent requests and processes share the first inserted salt.
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
    await this.deleteExpiredSalts();
    return row.salt;
  }
}
