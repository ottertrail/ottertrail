import { type Kysely, sql } from "kysely";

import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { deleteInBackground, deleteWhere } from "../clickhouse/delete-events.ts";
import { AI_CALLS_TABLE, USER_FIRST_SEEN } from "../clickhouse/migrations.ts";
import { QueryParams, queryRows } from "../clickhouse/query.ts";
import type { Database } from "../db/schema.ts";
import { deleteReplays } from "../replays/replays.ts";
import type { ObjectStore } from "../storage/object-store.ts";

/**
 * Deleting one known user's data (docs/data.md, "Deleting one user's
 * data"): a request is a row of user_deletions, and the worker deletes the
 * user's events, AI calls, first-seen times, spans and log records that
 * carry the ID, and session replays, then clears the ID from the row. The
 * row keeps when the deletion was asked for, and by whom, not who it was for.
 */

/** Pending deletions a project may have at once; more are refused until the worker catches up. */
export const MAX_PENDING_PER_PROJECT = 1000;

/** Users per run, taken together so one project's users share each ClickHouse DELETE. */
export const DELETIONS_PER_RUN = 100;

/** How long a taken deletion is left to its worker before another may take it. */
export const DELETION_LEASE_MS = 15 * 60_000;

/** The wait after a failed attempt: a minute, doubling, at most an hour. Never given up. */
export function retryDelayMs(attempts: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, Math.min(attempts - 1, 10)));
}

/** The OpenTelemetry attributes a span's or log record's user ID is read from (telemetry/exceptions.ts). */
export const USER_ID_ATTRIBUTES = ["user.id", "enduser.id"] as const;

export type DeletionRequest =
  | { ok: true; requestedAt: Date }
  /** The project has MAX_PENDING_PER_PROJECT deletions waiting. */
  | { ok: false; reason: "too_many_pending" };

/**
 * Records a deletion of `userId`'s data in the project. Asking again while
 * one is pending answers the pending one's time; nothing is added.
 */
export async function requestUserDeletion(
  db: Kysely<Database>,
  {
    projectId,
    userId,
    requestedBy,
  }: {
    projectId: string;
    userId: string;
    /** The dashboard user who asked; null for the project's secret key. */
    requestedBy: string | null;
  },
): Promise<DeletionRequest> {
  return db.transaction().execute(async (trx) => {
    // One request at a time per project, so the count below holds.
    await trx
      .selectFrom("projects")
      .select("id")
      .where("id", "=", projectId)
      .forNoKeyUpdate()
      .execute();
    const pending = await pendingDeletion(trx, projectId, userId);
    if (pending !== null) return { ok: true, requestedAt: pending };
    const [count] = await trx
      .selectFrom("user_deletions")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("project_id", "=", projectId)
      .where("completed_at", "is", null)
      .execute();
    if (Number(count?.n ?? 0) >= MAX_PENDING_PER_PROJECT) {
      return { ok: false, reason: "too_many_pending" };
    }
    const row = await trx
      .insertInto("user_deletions")
      .values({
        project_id: projectId,
        user_id: userId,
        requested_by: requestedBy,
        requested_with: requestedBy === null ? "secret_key" : "dashboard",
      })
      .returning("requested_at")
      .executeTakeFirstOrThrow();
    return { ok: true, requestedAt: row.requested_at };
  });
}

/** When the pending deletion of the user's data was asked for; null when none is pending. */
export async function pendingDeletion(
  db: Kysely<Database>,
  projectId: string,
  userId: string,
): Promise<Date | null> {
  const row = await db
    .selectFrom("user_deletions")
    .select("requested_at")
    .where("project_id", "=", projectId)
    .where("user_id", "=", userId)
    .where("completed_at", "is", null)
    .executeTakeFirst();
  return row?.requested_at ?? null;
}

/** The project's pending deletions, oldest first: how many, and the first `limit`. */
export async function pendingDeletions(
  db: Kysely<Database>,
  projectId: string,
  limit = 10,
): Promise<{ count: number; users: { userId: string; requestedAt: Date }[] }> {
  const rows = await db
    .selectFrom("user_deletions")
    .select(["user_id", "requested_at", sql<string>`count(*) over ()`.as("total")])
    .where("project_id", "=", projectId)
    .where("completed_at", "is", null)
    .orderBy("requested_at")
    .orderBy("id")
    .limit(limit)
    .execute();
  return {
    count: Number(rows[0]?.total ?? 0),
    users: rows.flatMap((row) =>
      row.user_id === null ? [] : [{ userId: row.user_id, requestedAt: row.requested_at }],
    ),
  };
}

/** Which of `userIds` have a deletion pending in the project. */
export async function pendingAmong(
  db: Kysely<Database>,
  projectId: string,
  userIds: readonly string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db
    .selectFrom("user_deletions")
    .select("user_id")
    .where("project_id", "=", projectId)
    .where("completed_at", "is", null)
    .where("user_id", "in", userIds)
    .execute();
  return new Set(rows.flatMap((row) => (row.user_id === null ? [] : [row.user_id])));
}

/** What deleteUsersData() removed. */
export interface UserDataDeleted {
  /** ClickHouse rows, all tables together. */
  rows: number;
  /** Session replays: their rows, chunks, and objects. */
  replays: number;
}

/**
 * Deletes every row and object that holds one of `userIds` in the project.
 * Safe to run again: what is gone stays gone, and a run cut short leaves the
 * rest for the next.
 *
 * Replays go first: some are found by the user's error events (a replay's
 * row learns its user only once linked, replays/link.ts), so the events must
 * still be there. Then ClickHouse, each table's DELETE filtered by project
 * first. A lightweight DELETE masks every copy of a row, and every copy of
 * an event holds the same user ID, so FINAL has no copy left to bring back.
 */
export async function deleteUsersData(
  db: Kysely<Database>,
  clickhouse: ClickHouseClient,
  store: ObjectStore | null,
  projectId: string,
  userIds: readonly string[],
): Promise<UserDataDeleted> {
  if (userIds.length === 0) return { rows: 0, replays: 0 };
  const params = new QueryParams();
  const project = params.add(projectId, "UUID");
  const users = params.add(userIds, "Array(String)");

  const fromEvents = await queryRows<{ replay: string }>(
    { client: clickhouse },
    `SELECT DISTINCT toString(assumeNotNull(replay_id)) AS replay FROM events
     WHERE project_id = ${project} AND user_id IN ${users} AND replay_id IS NOT NULL`,
    params,
  );
  const linked = await db
    .selectFrom("replays")
    .select("replay_id")
    .where("project_id", "=", projectId)
    .where("user_id", "in", userIds)
    .execute();
  const replayIds = [
    ...new Set([...fromEvents.map((row) => row.replay), ...linked.map((row) => row.replay_id)]),
  ];
  let replays = 0;
  if (replayIds.length > 0) {
    if (store === null) {
      const stored = await db
        .selectFrom("replays")
        .select("replay_id")
        .where("project_id", "=", projectId)
        .where("replay_id", "in", replayIds)
        .executeTakeFirst();
      // Their objects cannot be reached: wait for a worker with the object store.
      if (stored !== undefined) {
        throw new Error("the user's session replays need the object store to be deleted");
      }
      await db
        .deleteFrom("replay_chunks")
        .where("project_id", "=", projectId)
        .where("replay_id", "in", replayIds)
        .execute();
    } else {
      replays = await deleteReplays(db, store, projectId, replayIds);
    }
  }

  let rows = 0;
  const count = (counts: Map<string, number>) => {
    for (const n of counts.values()) rows += n;
  };
  const byUser = `project_id = ${project} AND user_id IN ${users}`;
  count(await deleteWhere(clickhouse, "events", byUser, params));
  count(await deleteWhere(clickhouse, AI_CALLS_TABLE, byUser, params));
  count(await deleteWhere(clickhouse, USER_FIRST_SEEN, byUser, params));
  const byAttribute = `project_id = ${project} AND (${USER_ID_ATTRIBUTES.map(
    (name) => `attributes['${name}'] IN ${users}`,
  ).join(" OR ")})`;
  // No index finds an attribute's value, so these are queued, not counted.
  await deleteInBackground(clickhouse, "spans", byAttribute, params);
  await deleteInBackground(clickhouse, "logs", byAttribute, params);
  return { rows, replays };
}

/** What runUserDeletions() did. */
export interface DeletionRun {
  /** Deletions finished. */
  done: number;
  /** Deletions that failed and wait for a retry. */
  failed: number;
  /** Rows deleted from events, AI calls, and first-seen times (spans and logs are not counted). */
  rows: number;
  replays: number;
  /** The first failure's message, for the log, without the user IDs it may quote. */
  firstError?: string;
}

/**
 * An error's message with each of `userIds` replaced, also as ClickHouse
 * quotes it: ClickHouse writes a query's parameters into the query text
 * that some of its errors quote, and the log and last_error must not keep
 * the IDs of users being deleted.
 */
export function withoutUserIds(error: unknown, userIds: readonly string[]): string {
  let message = String(error);
  const longestFirst = userIds.toSorted((a, b) => b.length - a.length);
  for (const id of longestFirst) {
    const quoted = id.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
    message = message.replaceAll(quoted, "[user ID]").replaceAll(id, "[user ID]");
  }
  return message;
}

/**
 * Takes up to `limit` due deletions (FOR UPDATE SKIP LOCKED, so two workers
 * never take the same one), deletes their users' data project by project,
 * and marks them done: the user ID is cleared, when and by whom stay. A
 * taken deletion is leased for DELETION_LEASE_MS, so one whose worker
 * stopped is taken again; a failure waits retryDelayMs() and is tried again,
 * however often it fails. The worker runs it every minute.
 */
export async function runUserDeletions(
  db: Kysely<Database>,
  clickhouse: ClickHouseClient,
  store: ObjectStore | null,
  { limit = DELETIONS_PER_RUN }: { limit?: number } = {},
): Promise<DeletionRun> {
  const taken = await sql<{ id: string; project_id: string; user_id: string; attempts: number }>`
    with due as (
      select id from user_deletions
      where completed_at is null and next_attempt_at <= now()
      order by next_attempt_at, id
      limit ${limit}
      for update skip locked
    )
    update user_deletions as d
    set attempts = d.attempts + 1,
      next_attempt_at = now() + make_interval(secs => ${DELETION_LEASE_MS / 1000})
    from due
    where d.id = due.id
    returning d.id, d.project_id, d.user_id, d.attempts
  `.execute(db);
  const run: DeletionRun = { done: 0, failed: 0, rows: 0, replays: 0 };
  for (const [projectId, deletions] of Map.groupBy(taken.rows, (row) => row.project_id)) {
    const ids = deletions.map((row) => row.id);
    try {
      const deleted = await deleteUsersData(
        db,
        clickhouse,
        store,
        projectId,
        deletions.map((row) => row.user_id),
      );
      await db
        .updateTable("user_deletions")
        .set({ user_id: null, completed_at: sql<Date>`now()`, last_error: null })
        .where("id", "in", ids)
        .execute();
      run.done += deletions.length;
      run.rows += deleted.rows;
      run.replays += deleted.replays;
    } catch (error) {
      const message = withoutUserIds(
        error,
        deletions.map((row) => row.user_id),
      );
      run.failed += deletions.length;
      run.firstError ??= message;
      for (const row of deletions) {
        await db
          .updateTable("user_deletions")
          .set({
            next_attempt_at: sql<Date>`now() + make_interval(secs => ${retryDelayMs(row.attempts) / 1000})`,
            last_error: message.slice(0, 1000),
          })
          .where("id", "=", row.id)
          .where("completed_at", "is", null)
          .execute();
      }
    }
  }
  return run;
}
