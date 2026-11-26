import { createHash, randomBytes } from "node:crypto";

import { type Kysely, sql } from "kysely";

import type { Database } from "../db/schema.ts";
import {
  addCheck,
  type Check,
  checkOf,
  closeIncident,
  MAX_NAME,
  type Problem,
  type StateChange,
} from "./checks.ts";

/**
 * Heartbeat checks (docs/uptime-alerts.md, "Heartbeat checks"): a job calls
 * the check's ping URL each time it runs, and the check goes down when no
 * ping came within its period plus its grace, or at once when the job
 * reports a failure. recordPing and markOverdue are the only places a
 * heartbeat's state changes, as recordOutcome is for an HTTP check.
 */

/** A heartbeat's period, in seconds: 1, 5, 10, 15, 30 minutes, 1, 2, 6, 12 hours, 1 day, 1 week. */
export const HEARTBEAT_PERIODS = [
  60, 300, 600, 900, 1800, 3600, 7200, 21_600, 43_200, 86_400, 604_800,
] as const;
export const DEFAULT_PERIOD = 86_400;
/** The time allowed after the period: 1 minute to 1 day. */
export const HEARTBEAT_GRACES = [
  60, 300, 600, 900, 1800, 3600, 7200, 21_600, 43_200, 86_400,
] as const;
/** Pings kept per check, newest first, for its page. */
export const MAX_PINGS_KEPT = 50;
/** Heartbeats found overdue in one pass; the next pass takes the rest. */
const OVERDUE_BATCH = 500;

/** 24 random bytes: 192 bits, 32 URL-safe characters. */
const TOKEN_BYTES = 24;
export const TOKEN_PATTERN = /^[\w-]{32}$/u;
export const FAILED_DETAIL = "The job reported a failure.";

/** The largest grace in the list that is at most a fifth of the period, and at least 1 minute. */
export function defaultGrace(periodSeconds: number): number {
  return HEARTBEAT_GRACES.findLast((grace) => grace <= periodSeconds / 5) ?? HEARTBEAT_GRACES[0];
}

export function newPingToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** What pings look a check up by: the lookup's time then tells nothing about the token's text. */
export function pingTokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

const unit = (count: number, name: string) => `${count} ${name}${count === 1 ? "" : "s"}`;

/** A span in words, such as "1 day and 1 hour" or "1 day, 1 hour, and 5 minutes". */
export function spanText(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  const parts = [
    ...(days > 0 ? [unit(days, "day")] : []),
    ...(hours > 0 ? [unit(hours, "hour")] : []),
    ...(minutes > 0 ? [unit(minutes, "minute")] : []),
  ];
  if (parts.length === 0) return "less than a minute";
  const last = parts.pop() ?? "";
  if (parts.length === 0) return last;
  return parts.length === 1 ? `${parts[0]} and ${last}` : `${parts.join(", ")}, and ${last}`;
}

export const noPingDetail = (periodSeconds: number, graceSeconds: number) =>
  `No ping for ${spanText(periodSeconds + graceSeconds)}.`;

export interface HeartbeatInput {
  name?: string | undefined;
  intervalSeconds?: number | undefined;
  graceSeconds?: number | undefined;
}

export interface HeartbeatValues {
  name: string;
  intervalSeconds: number;
  graceSeconds: number;
}

// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const CONTROL = /[\u0000-\u001F\u007F]/u;

/** Validate merged input after Fastify checks basic types and bounds. */
export function heartbeatValuesOf(
  input: HeartbeatInput,
  base?: HeartbeatValues,
): HeartbeatValues | Problem {
  const name = (input.name ?? base?.name ?? "").trim();
  if (name === "") {
    return { error: "invalid_name", message: "Enter a name for the heartbeat." };
  }
  if (name.length > MAX_NAME || CONTROL.test(name)) {
    return {
      error: "invalid_name",
      message: `A check's name has at most ${MAX_NAME} characters, and no control characters.`,
    };
  }
  const intervalSeconds = input.intervalSeconds ?? base?.intervalSeconds ?? DEFAULT_PERIOD;
  if (!HEARTBEAT_PERIODS.some((period) => period === intervalSeconds)) {
    return {
      error: "invalid_interval",
      message:
        "A heartbeat expects a ping every 1, 5, 10, 15, or 30 minutes, every 1, 2, 6, or 12 hours, every day, or every week.",
    };
  }
  const graceSeconds = input.graceSeconds ?? base?.graceSeconds ?? defaultGrace(intervalSeconds);
  if (!HEARTBEAT_GRACES.some((grace) => grace === graceSeconds)) {
    return {
      error: "invalid_grace",
      message: "The grace time is 1, 5, 10, 15, or 30 minutes, 1, 2, 6, or 12 hours, or 1 day.",
    };
  }
  return { name, intervalSeconds, graceSeconds };
}

export const valuesOfHeartbeat = (check: Check): HeartbeatValues => ({
  name: check.name,
  intervalSeconds: check.intervalSeconds,
  graceSeconds: check.graceSeconds ?? defaultGrace(check.intervalSeconds),
});

const afterSeconds = (at: Date, seconds: number) => new Date(at.getTime() + seconds * 1000);

/** Adds a heartbeat, new until its first period and grace have passed. */
export async function createHeartbeat(
  db: Kysely<Database>,
  projectId: string,
  values: HeartbeatValues,
  now: Date,
): Promise<{ check: Check } | { refused: "too_many" }> {
  const token = newPingToken();
  return addCheck(db, projectId, {
    kind: "heartbeat",
    name: values.name,
    interval_seconds: values.intervalSeconds,
    grace_seconds: values.graceSeconds,
    ping_token: token,
    ping_token_hash: pingTokenHash(token),
    next_due_at: afterSeconds(now, values.intervalSeconds + values.graceSeconds),
    created_at: now,
    updated_at: now,
  });
}

/**
 * Changes a heartbeat. Pausing ends an open incident and forgets the state,
 * as for an HTTP check; resuming waits a whole period and grace from now.
 * A new period or grace moves the deadline by the difference, so it still
 * counts from the last ping (or creation, or resuming).
 */
export async function updateHeartbeat(
  db: Kysely<Database>,
  projectId: string,
  checkId: string,
  values: HeartbeatValues,
  paused: boolean | undefined,
  now: Date,
): Promise<Check | null> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("uptime_checks")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("id", "=", checkId)
      .where("kind", "=", "heartbeat")
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) return null;
    const pausing = paused === true && !row.paused;
    const resuming = paused === false && row.paused;
    if (pausing) await closeIncident(trx, checkId, now);
    const allowed = values.intervalSeconds + values.graceSeconds;
    const before = row.interval_seconds + (row.grace_seconds ?? 0);
    const nextDueAt = resuming
      ? afterSeconds(now, allowed)
      : afterSeconds(row.next_due_at, allowed - before);
    const updated = await trx
      .updateTable("uptime_checks")
      .set({
        name: values.name,
        interval_seconds: values.intervalSeconds,
        grace_seconds: values.graceSeconds,
        next_due_at: nextDueAt,
        ...(paused === undefined ? {} : { paused }),
        ...(pausing
          ? {
              state: "pending" as const,
              consecutive_failures: 0,
              failing_since: null,
              failing_cause: null,
              failing_detail: null,
            }
          : {}),
        updated_at: now,
      })
      .where("id", "=", checkId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return checkOf(updated);
  });
}

/** A heartbeat's ping token; null when the project has no heartbeat with this ID. */
export async function pingTokenOf(
  db: Kysely<Database>,
  projectId: string,
  checkId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom("uptime_checks")
    .select("ping_token")
    .where("project_id", "=", projectId)
    .where("id", "=", checkId)
    .where("kind", "=", "heartbeat")
    .executeTakeFirst();
  return row?.ping_token ?? null;
}

/** Gives a heartbeat a new token: the old URL stops working at once. */
export async function replacePingToken(
  db: Kysely<Database>,
  projectId: string,
  checkId: string,
  now: Date,
): Promise<string | null> {
  const token = newPingToken();
  const row = await db
    .updateTable("uptime_checks")
    .set({ ping_token: token, ping_token_hash: pingTokenHash(token), updated_at: now })
    .where("project_id", "=", projectId)
    .where("id", "=", checkId)
    .where("kind", "=", "heartbeat")
    .returning("id")
    .executeTakeFirst();
  return row === undefined ? null : token;
}

/** The heartbeat a token pings, if it is one and is not paused. */
export async function findPinged(
  db: Kysely<Database>,
  token: string,
): Promise<{ checkId: string; projectId: string } | null> {
  const row = await db
    .selectFrom("uptime_checks")
    .select(["id", "project_id"])
    .where("ping_token_hash", "=", pingTokenHash(token))
    .where("kind", "=", "heartbeat")
    .where("paused", "=", false)
    .executeTakeFirst();
  return row === undefined ? null : { checkId: row.id, projectId: row.project_id };
}

/**
 * Records a ping on its heartbeat, in one transaction: up again on a ping
 * (ending the incident), down at once on a failure, and the deadline moved
 * to a period and grace from now either way. Keeps the latest
 * MAX_PINGS_KEPT pings. Returns the change, if the state went down or came
 * back up; null when the check is gone or paused, or nothing changed.
 */
export async function recordPing(
  db: Kysely<Database>,
  checkId: string,
  failed: boolean,
  at: Date,
): Promise<{ recorded: boolean; change: StateChange | null }> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("uptime_checks")
      .selectAll()
      .where("id", "=", checkId)
      .where("kind", "=", "heartbeat")
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined || row.paused) return { recorded: false, change: null };
    await trx
      .insertInto("heartbeat_pings")
      .values({ check_id: checkId, project_id: row.project_id, at, failed })
      .execute();
    await sql`
      delete from heartbeat_pings where id in (
        select id from heartbeat_pings where check_id = ${checkId}
        order by at desc, id desc offset ${MAX_PINGS_KEPT}
      )
    `.execute(trx);
    const last = {
      last_checked_at: at,
      last_up: !failed,
      last_cause: failed ? ("job_failed" as const) : null,
      next_due_at: afterSeconds(at, row.interval_seconds + (row.grace_seconds ?? 0)),
    };
    if (!failed) {
      await trx
        .updateTable("uptime_checks")
        .set({
          ...last,
          state: "up",
          consecutive_failures: 0,
          failing_since: null,
          failing_cause: null,
          failing_detail: null,
        })
        .where("id", "=", checkId)
        .execute();
      if (row.state !== "down") return { recorded: true, change: null };
      const ended = await closeIncident(trx, checkId, at);
      return {
        recorded: true,
        change: {
          checkId,
          projectId: row.project_id,
          from: "down",
          to: "up",
          at,
          incidentId: ended?.id ?? "",
          cause: row.failing_cause ?? "no_ping",
          detail: row.failing_detail ?? "",
        },
      };
    }
    const goesDown = row.state !== "down";
    await trx
      .updateTable("uptime_checks")
      .set({
        ...last,
        consecutive_failures: row.consecutive_failures + 1,
        ...(goesDown
          ? {
              state: "down" as const,
              failing_since: at,
              failing_cause: "job_failed" as const,
              failing_detail: FAILED_DETAIL,
            }
          : {}),
      })
      .where("id", "=", checkId)
      .execute();
    if (!goesDown) return { recorded: true, change: null };
    const incident = await trx
      .insertInto("uptime_incidents")
      .values({
        check_id: checkId,
        project_id: row.project_id,
        started_at: at,
        cause: "job_failed",
        detail: FAILED_DETAIL,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return {
      recorded: true,
      change: {
        checkId,
        projectId: row.project_id,
        from: row.state,
        to: "down",
        at,
        incidentId: incident.id,
        cause: "job_failed",
        detail: FAILED_DETAIL,
      },
    };
  });
}

/**
 * Takes the heartbeats past their deadline (one indexed query, with
 * `FOR UPDATE SKIP LOCKED`, so workers share them and a ping that holds
 * one wins) and marks them down, each with an incident from its deadline.
 * Now is PostgreSQL's clock unless `now` is given (tests).
 */
export async function markOverdue(db: Kysely<Database>, now?: Date): Promise<StateChange[]> {
  return db.transaction().execute(async (trx) => {
    const at = sql<Date>`coalesce(${now ?? null}::timestamptz, now())`;
    const rows = await trx
      .selectFrom("uptime_checks")
      .select([
        "id",
        "project_id",
        "state",
        "interval_seconds",
        "grace_seconds",
        "next_due_at",
        "consecutive_failures",
      ])
      .where("kind", "=", "heartbeat")
      .where("paused", "=", false)
      .where("state", "<>", "down")
      .where("next_due_at", "<=", at)
      .orderBy("next_due_at")
      .limit(OVERDUE_BATCH)
      .forUpdate()
      .skipLocked()
      .execute();
    const changes: StateChange[] = [];
    for (const row of rows) {
      const detail = noPingDetail(row.interval_seconds, row.grace_seconds ?? 0);
      await trx
        .updateTable("uptime_checks")
        .set({
          state: "down",
          consecutive_failures: row.consecutive_failures + 1,
          failing_since: row.next_due_at,
          failing_cause: "no_ping",
          failing_detail: detail,
        })
        .where("id", "=", row.id)
        .execute();
      const incident = await trx
        .insertInto("uptime_incidents")
        .values({
          check_id: row.id,
          project_id: row.project_id,
          started_at: row.next_due_at,
          cause: "no_ping",
          detail,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      changes.push({
        checkId: row.id,
        projectId: row.project_id,
        from: row.state,
        to: "down",
        at: row.next_due_at,
        incidentId: incident.id,
        cause: "no_ping",
        detail,
      });
    }
    return changes;
  });
}

export interface Ping {
  at: Date;
  failed: boolean;
}

/** A heartbeat's latest pings, newest first. */
export async function recentPings(
  db: Kysely<Database>,
  projectId: string,
  checkId: string,
): Promise<Ping[]> {
  return db
    .selectFrom("heartbeat_pings")
    .select(["at", "failed"])
    .where("project_id", "=", projectId)
    .where("check_id", "=", checkId)
    .orderBy("at", "desc")
    .orderBy("id", "desc")
    .limit(MAX_PINGS_KEPT)
    .execute();
}
