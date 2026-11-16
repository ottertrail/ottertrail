import { createHmac, randomBytes } from "node:crypto";

import type { Kysely } from "kysely";

import { MAX_EVENT_AGE_MS } from "../collection/normalize.ts";
import type { Database } from "../db/schema.ts";

/**
 * Returns the calendar day of a moment in a timezone, as "YYYY-MM-DD".
 * Salts change at midnight in the instance's timezone, the same days that
 * reports count in, so one visit is never split across two salts within a
 * reported day.
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
 * "America/Los_Angeles". The instance then stores and reports one name.
 */
export function canonicalTimeZone(name: string): string | undefined {
  try {
    // Throws a RangeError for names it does not know.
    return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
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

export interface VisitorIdsOptions {
  /** IANA timezone whose midnight starts a new salt. */
  timeZone: string;
  now?: () => number;
}

/**
 * Hands out visitor IDs, creating each day's salt the first time it is needed
 * and deleting salts no event can still need.
 *
 * Salts live in PostgreSQL so every API process and every restart uses the
 * same salt for the same day. Each process caches them in memory.
 */
export class VisitorIds {
  readonly #db: Kysely<Database>;
  readonly #day: (moment: Date) => string;
  readonly #now: () => number;
  readonly #salts = new Map<string, Promise<Buffer>>();

  constructor(db: Kysely<Database>, { timeZone, now = Date.now }: VisitorIdsOptions) {
    this.#db = db;
    this.#day = dayIn(timeZone);
    this.#now = now;
  }

  /** The visitor ID for an event, using the salt of the day the event happened. */
  async idFor(input: {
    projectId: string;
    ip: string;
    userAgent: string;
    occurredAt: Date;
  }): Promise<string> {
    const salt = await this.#salt(this.#day(input.occurredAt));
    return visitorId(salt, input.projectId, input.ip, input.userAgent);
  }

  /**
   * The oldest day whose salt is still kept. Events arrive up to 24 hours
   * late, so a day's salt is needed until 24 hours after the day ends.
   */
  oldestKeptDay(): string {
    return this.#day(new Date(this.#now() - MAX_EVENT_AGE_MS));
  }

  /** Deletes salts no future event can need. Returns how many were deleted. */
  async deleteExpiredSalts(): Promise<number> {
    const result = await this.#db
      .deleteFrom("visitor_salts")
      .where("day", "<", this.oldestKeptDay())
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  #salt(day: string): Promise<Buffer> {
    let salt = this.#salts.get(day);
    if (salt === undefined) {
      salt = this.#loadOrCreate(day);
      // A failed load is not remembered, so the next request tries again.
      salt.catch(() => this.#salts.delete(day));
      this.#salts.set(day, salt);
      // Forget days no event can belong to any more.
      const oldest = this.oldestKeptDay();
      for (const cached of this.#salts.keys()) {
        if (cached < oldest) this.#salts.delete(cached);
      }
    }
    return salt;
  }

  async #loadOrCreate(day: string): Promise<Buffer> {
    // Several requests or API processes may reach a new day at once; the
    // first insert wins and everyone reads the same salt back.
    await this.#db
      .insertInto("visitor_salts")
      .values({ day, salt: randomBytes(32) })
      .onConflict((conflict) => conflict.column("day").doNothing())
      .execute();
    const row = await this.#db
      .selectFrom("visitor_salts")
      .select("salt")
      .where("day", "=", day)
      .executeTakeFirstOrThrow();
    // A new day is a good moment to drop salts that are no longer needed.
    await this.deleteExpiredSalts();
    return row.salt;
  }
}
