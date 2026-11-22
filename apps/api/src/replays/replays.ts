import { gunzipSync, gzipSync } from "node:zlib";

import { type Kysely, sql } from "kysely";

import type { Database } from "../db/schema.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { deriveReplay } from "./derive.ts";

/**
 * Session replays around errors (docs/session-replay.md): what a browser
 * recorded in the minute before an error, masked there, sent as chunks
 * (packages/tracker/src/replay.ts). Chunks land in PostgreSQL, which
 * confirms them; the worker joins each replay's into one object.
 */

/** Largest chunk a browser sends: one gzip member, under a beacon's limit. */
export const MAX_CHUNK_BYTES = 64 * 1024;
/** Most a chunk unpacks to: a small body cannot unpack into a large one. */
export const MAX_CHUNK_UNPACKED_BYTES = 1024 ** 2;
/**
 * Most chunks of one replay, numbered 0 to 99: twice what MAX_REPLAY_BYTES
 * needs, since the tracker fills each chunk at least about half.
 */
export const MAX_CHUNKS = 100;
/** Most bytes of one replay's chunks: the browser stops at 2,000,000. */
export const MAX_REPLAY_BYTES = 2_100_000;
/** Most a replay unpacks to when joined: its JSON, read once by the worker. */
const MAX_REPLAY_JSON_BYTES = 64 * 1024 ** 2;
/** A replay whose last chunk never came is given up after this long without one. */
export const REPLAY_IDLE_MS = 5 * 60_000;
/** Chunks are kept this long after their replay is joined, past the tracker's retries. */
export const CHUNK_KEEP_MS = 60 * 60_000;
/**
 * The times a recording's events may have, in epoch milliseconds: from
 * 1970, as on a device whose clock was reset, to 2100. A visitor's clock may
 * be wrong by years, which the join corrects (derive.ts), but past these a
 * time is not a clock's, and the correction would not fit in PostgreSQL.
 */
export const EARLIEST_EVENT_TIME_MS = 0;
export const LATEST_EVENT_TIME_MS = Date.UTC(2100, 0, 1);
/** How long replays are kept: the shortest retention a project can choose for events. */
export const REPLAY_RETENTION_DAYS = 30;

/** Every replay of a project starts with this. */
export const replayPrefix = (projectId: string) => `replays/${projectId}/`;
export const replayKeyOf = (projectId: string, replayId: string) =>
  `${replayPrefix(projectId)}${replayId}.json.gz`;

/** The compressed bytes of the instance's replays, all projects', and of chunks not yet joined. */
export async function storedReplayBytes(db: Kysely<Database>): Promise<number> {
  const [replays, chunks] = await Promise.all([
    db
      .selectFrom("replays")
      .select(sql<string>`coalesce(sum(bytes), 0)`.as("bytes"))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("replay_chunks")
      .select(sql<string>`coalesce(sum(octet_length(data)), 0)`.as("bytes"))
      .executeTakeFirstOrThrow(),
  ]);
  return Number(replays.bytes) + Number(chunks.bytes);
}

export interface Chunk {
  replayId: string;
  seq: number;
  last: boolean;
  cut: boolean;
  data: Buffer;
  /** When it arrived; now when left out. The development seed (scripts/seed-data.ts) sets past times. */
  receivedAt?: Date;
}

/**
 * Keeps one chunk, once: "stored", or why not. A new replay (its first
 * chunk) is refused when the instance's replays already take
 * `limitBytes`; a replay past MAX_REPLAY_BYTES is refused; a chunk of a
 * replay already joined, or already kept, is a duplicate, as a retry is.
 */
export async function storeChunk(
  db: Kysely<Database>,
  project: { id: string },
  chunk: Chunk,
  limitBytes: number,
): Promise<"stored" | "duplicate" | "storage_full" | "too_large"> {
  const joined = await db
    .selectFrom("replays")
    .select("replay_id")
    .where("project_id", "=", project.id)
    .where("replay_id", "=", chunk.replayId)
    .executeTakeFirst();
  if (joined !== undefined) return "duplicate";

  const sofar = await db
    .selectFrom("replay_chunks")
    .select([
      sql<string>`coalesce(sum(octet_length(data)), 0)`.as("bytes"),
      sql<string>`count(*)`.as("chunks"),
    ])
    .where("project_id", "=", project.id)
    .where("replay_id", "=", chunk.replayId)
    .executeTakeFirstOrThrow();
  if (Number(sofar.chunks) === 0 && (await storedReplayBytes(db)) >= limitBytes) {
    return "storage_full";
  }
  if (Number(sofar.bytes) + chunk.data.byteLength > MAX_REPLAY_BYTES) return "too_large";

  const result = await db
    .insertInto("replay_chunks")
    .values({
      project_id: project.id,
      replay_id: chunk.replayId,
      seq: chunk.seq,
      last: chunk.last,
      cut: chunk.cut,
      data: chunk.data,
      ...(chunk.receivedAt === undefined ? {} : { received_at: chunk.receivedAt }),
    })
    .onConflict((oc) => oc.columns(["project_id", "replay_id", "seq"]).doNothing())
    .executeTakeFirst();
  return (result.numInsertedOrUpdatedRows ?? 0n) > 0n ? "stored" : "duplicate";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The recording's JSON joined from its chunks, checked: `{"v":1,"events":
 * [...]}` with events, each an object with a numeric type and timestamp.
 * Null when it is not. What was recorded is not read further: the player
 * treats it as untrusted.
 */
export function joinChunks(chunks: readonly Buffer[]): string | null {
  const text = unpack(chunks);
  return text === null ? null : (checkRecording(text)?.text ?? null);
}

/** The chunks' text, unpacked: each is one gzip member. Null when they are not gzip. */
function unpack(chunks: readonly Buffer[]): string | null {
  try {
    return gunzipSync(Buffer.concat(chunks), { maxOutputLength: MAX_REPLAY_JSON_BYTES }).toString(
      "utf8",
    );
  } catch {
    return null;
  }
}

/**
 * The start of a recording whose end never came, as a whole one: cut after
 * its last complete event, then closed. A visitor who leaves the page just
 * after an error sends only what a beacon takes, so the replay's first
 * chunks come and its last does not. The recording is
 * `{"v":1,"events":[…]}`: an event ends where an object closes inside the
 * array, at depth 2, outside strings. Null when no event is complete.
 */
export function closeRecording(start: string): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastEventEnd = -1;
  for (let index = 0; index < start.length; index += 1) {
    const character = start[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") {
      depth -= 1;
      if (character === "}" && depth === 2) lastEventEnd = index + 1;
    }
  }
  return lastEventEnd === -1 ? null : `${start.slice(0, lastEventEnd)}]}`;
}

interface RecordedEvent {
  type: number;
  timestamp: number;
  data?: unknown;
}

/** The recording's text and events when it is one, as joinChunks describes; null when not. */
function checkRecording(text: string): { text: string; events: RecordedEvent[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.events)) return null;
  const events: unknown[] = parsed.events;
  const isEvent = (event: unknown): event is RecordedEvent =>
    isRecord(event) &&
    typeof event.type === "number" &&
    typeof event.timestamp === "number" &&
    event.timestamp >= EARLIEST_EVENT_TIME_MS &&
    event.timestamp < LATEST_EVENT_TIME_MS;
  return events.length > 0 && events.every(isEvent)
    ? { text, events: events.filter(isEvent) }
    : null;
}

/**
 * Joins each replay whose chunks are all in (the last one came, with every
 * one before it) into one object, and records it. One still missing some
 * after REPLAY_IDLE_MS keeps what came in order from its first chunk, up to
 * its last complete event, marked cut (closeRecording); one with nothing to
 * keep is given up, its chunks deleted. The worker runs it every few
 * seconds; running it twice at once is harmless.
 *
 * Each replay is joined holding its project's row (FOR SHARE), which
 * deleteProjectReplays() takes exclusively: a deletion waits for a join in
 * progress, then deletes what it wrote, and a join after a deletion finds
 * no chunks. Without it, a join that had read the chunks could write the
 * object and its row back after the user deleted them.
 *
 * A replay whose object the store refuses (Garage's bucket quota, a store
 * that is down) keeps its chunks and is tried again on the next run; the
 * others of the batch go on. `failed` counts them, with the first error.
 * Any other error is one replay's alone too: one that will pass (PostgreSQL
 * unreachable, a conflict between transactions) counts as failed, and its
 * chunks wait; one of the replay's own data (PostgreSQL refusing a value, a
 * recording the join cannot read) would fail on every run, so the replay is
 * dropped, its chunks and any object deleted. `onError` hears of each.
 */
export async function joinReplays(
  db: Kysely<Database>,
  store: ObjectStore,
  {
    now = new Date(),
    limit = 100,
    onlyProjectId,
    onError = () => undefined,
  }: {
    now?: Date;
    limit?: number;
    /** One project's replays only (the development seed); every project's when left out. */
    onlyProjectId?: string;
    /** Told of each replay an unexpected error failed (kept) or dropped. */
    onError?: (
      error: unknown,
      replay: { projectId: string; replayId: string; dropped: boolean },
    ) => void;
  } = {},
): Promise<{ joined: number; dropped: number; failed: number; firstError?: unknown }> {
  const idleSince = new Date(now.getTime() - REPLAY_IDLE_MS);
  let query = db.selectFrom("replay_chunks as c");
  if (onlyProjectId !== undefined) query = query.where("c.project_id", "=", onlyProjectId);
  const candidates = await query
    .select(["c.project_id", "c.replay_id"])
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("replays as r")
            .select("r.replay_id")
            .whereRef("r.project_id", "=", "c.project_id")
            .whereRef("r.replay_id", "=", "c.replay_id"),
        ),
      ),
    )
    .groupBy(["c.project_id", "c.replay_id"])
    .having((eb) =>
      eb.or([
        eb(sql<boolean>`bool_or(c.last)`, "=", true),
        eb(eb.fn.max("c.received_at"), "<", idleSince),
      ]),
    )
    .limit(limit)
    .execute();

  let joined = 0;
  let dropped = 0;
  let failed = 0;
  let firstError: unknown;
  for (const { project_id: projectId, replay_id: replayId } of candidates) {
    const objectKey = replayKeyOf(projectId, replayId);
    const outcome = await db
      .transaction()
      .execute(async (trx) => {
        const project = await trx
          .selectFrom("projects")
          .select("id")
          .where("id", "=", projectId)
          .forShare()
          .executeTakeFirst();
        if (project === undefined) return "skipped"; // Deleted: its chunks went with it.
        const chunks = await trx
          .selectFrom("replay_chunks")
          .select(["seq", "last", "cut", "data", "received_at"])
          .where("project_id", "=", projectId)
          .where("replay_id", "=", replayId)
          .orderBy("seq")
          .execute();
        // Deleted since it was found: nothing to join.
        if (chunks.length === 0) return "skipped";
        const lastAt = chunks.findIndex((chunk) => chunk.last);
        // Complete: chunks 0 to the last, none missing.
        const complete =
          lastAt !== -1 && chunks.slice(0, lastAt + 1).every((chunk, index) => chunk.seq === index);
        const latest = chunks.reduce(
          (time, chunk) => Math.max(time, chunk.received_at.getTime()),
          0,
        );
        if (!complete && latest >= idleSince.getTime()) {
          // A chunk may still come, as a retry: wait.
          return "skipped";
        }
        // What came in order from the first chunk.
        let inOrder = 0;
        while (chunks[inOrder]?.seq === inOrder) inOrder += 1;
        const kept = complete ? chunks.slice(0, lastAt + 1) : chunks.slice(0, inOrder);
        const unpacked = kept.length === 0 ? null : unpack(kept.map((chunk) => chunk.data));
        const closed = complete || unpacked === null ? unpacked : closeRecording(unpacked);
        const recording = closed === null ? null : checkRecording(closed);
        if (recording === null) {
          // Not a recording, or nothing of one: once its last chunk came, or
          // it went quiet, nothing more will make it one.
          await trx
            .deleteFrom("replay_chunks")
            .where("project_id", "=", projectId)
            .where("replay_id", "=", replayId)
            .execute();
          return "dropped";
        }
        const compressed = gzipSync(recording.text);
        // What the list and the timeline show, worked out once, here.
        const firstReceivedAt = kept.reduce(
          (time, chunk) => (chunk.received_at < time ? chunk.received_at : time),
          kept[0]?.received_at ?? now,
        );
        const details = deriveReplay(recording.events, firstReceivedAt);
        try {
          await store.put(objectKey, compressed, "application/gzip");
        } catch (error) {
          // Nothing written: the chunks stay for the next run.
          if (failed === 0) firstError = error;
          return "failed";
        }
        await trx
          .insertInto("replays")
          .values({
            project_id: projectId,
            replay_id: replayId,
            object_key: objectKey,
            bytes: compressed.byteLength,
            cut: !complete || kept.some((chunk) => chunk.cut),
            started_at: details.startedAt,
            ended_at: details.endedAt,
            clock_offset_ms: details.clockOffsetMs,
            pages: details.pages,
            clicks: details.clicks,
            page_changes: details.pageChanges,
            timeline: JSON.stringify(details.timeline),
          })
          .onConflict((oc) => oc.columns(["project_id", "replay_id"]).doNothing())
          .execute();
        return "joined";
      })
      .catch(async (error: unknown) => {
        if (isTransient(error)) {
          onError(error, { projectId, replayId, dropped: false });
          if (failed === 0) firstError = error;
          return "failed" as const;
        }
        try {
          await store.delete([objectKey]);
          await db
            .deleteFrom("replay_chunks")
            .where("project_id", "=", projectId)
            .where("replay_id", "=", replayId)
            .execute();
        } catch (deleteError) {
          // Dropped on a later run.
          onError(deleteError, { projectId, replayId, dropped: false });
          if (failed === 0) firstError = deleteError;
          return "failed" as const;
        }
        onError(error, { projectId, replayId, dropped: true });
        return "dropped" as const;
      });
    if (outcome === "joined") joined += 1;
    if (outcome === "dropped") dropped += 1;
    if (outcome === "failed") failed += 1;
  }
  return failed === 0 ? { joined, dropped, failed } : { joined, dropped, failed, firstError };
}

/** PostgreSQL's classes of errors that are the data's: a value out of range, a broken constraint. */
const DATA_ERROR_CLASSES = new Set(["22", "23"]);

/**
 * Whether an error may pass by the next run: anything but PostgreSQL
 * refusing the replay's data (SQLSTATE classes 22 and 23) and errors of the
 * join's own code (a RangeError or TypeError), which come back every time.
 */
function isTransient(error: unknown): boolean {
  const code = isRecord(error) ? error.code : undefined;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
    return !DATA_ERROR_CLASSES.has(code.slice(0, 2));
  }
  if (typeof code === "string") return true; // A system error: ECONNRESET, ETIMEDOUT, …
  if (error instanceof RangeError || error instanceof TypeError || error instanceof SyntaxError) {
    return false;
  }
  return true;
}

/** Deletes the chunks of replays joined more than CHUNK_KEEP_MS ago: past any retry. */
export async function deleteJoinedChunks(
  db: Kysely<Database>,
  { now = new Date() }: { now?: Date } = {},
): Promise<number> {
  const result = await db
    .deleteFrom("replay_chunks as c")
    .where("c.received_at", "<", new Date(now.getTime() - CHUNK_KEEP_MS))
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("replays as r")
          .select("r.replay_id")
          .whereRef("r.project_id", "=", "c.project_id")
          .whereRef("r.replay_id", "=", "c.replay_id"),
      ),
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

/**
 * Deletes replays older than REPLAY_RETENTION_DAYS: the objects, then the
 * rows, a thousand at a time, so a failure leaves rows to try again with.
 */
export async function deleteExpiredReplays(
  db: Kysely<Database>,
  store: ObjectStore,
  { now = new Date() }: { now?: Date } = {},
): Promise<number> {
  const before = new Date(now.getTime() - REPLAY_RETENTION_DAYS * 86_400_000);
  let deleted = 0;
  for (;;) {
    const rows = await db
      .selectFrom("replays")
      .select(["project_id", "replay_id", "object_key"])
      .where("created_at", "<", before)
      .limit(1000)
      .execute();
    if (rows.length === 0) return deleted;
    const keys = rows.map((row) => row.object_key);
    await store.delete(keys);
    // Each object's key is its replay's own: project and replay ID.
    await db.deleteFrom("replays").where("object_key", "in", keys).execute();
    deleted += rows.length;
  }
}

/** How long after an error its replay may still be on its way: recorded 10 s more, then sent. */
export const REPLAY_PENDING_MS = 15 * 60_000;

export type ReplayStatus = "ready" | "pending" | "missing";

/**
 * Each replay ID's state, for the occurrences that name one: ready (joined),
 * pending (its error is recent, so it may still be coming), or missing
 * (never came, or expired).
 */
export async function replayStatuses(
  db: Kysely<Database>,
  projectId: string,
  occurrences: readonly { replayId: string | null; occurredAt: Date }[],
  now = new Date(),
): Promise<Map<string, ReplayStatus>> {
  const ids = [...new Set(occurrences.flatMap((occurrence) => occurrence.replayId ?? []))];
  const statuses = new Map<string, ReplayStatus>();
  if (ids.length === 0) return statuses;
  const ready = await db
    .selectFrom("replays")
    .select("replay_id")
    .where("project_id", "=", projectId)
    .where("replay_id", "in", ids)
    .execute();
  const joined = new Set(ready.map((row) => row.replay_id));
  for (const occurrence of occurrences) {
    const { replayId } = occurrence;
    if (replayId === null || statuses.has(replayId)) continue;
    statuses.set(
      replayId,
      joined.has(replayId)
        ? "ready"
        : now.getTime() - occurrence.occurredAt.getTime() < REPLAY_PENDING_MS
          ? "pending"
          : "missing",
    );
  }
  return statuses;
}

/** A project's replays, how many and how large, for its settings. */
export async function projectReplays(
  db: Kysely<Database>,
  projectId: string,
): Promise<{ count: number; bytes: number }> {
  const row = await db
    .selectFrom("replays")
    .select([sql<string>`count(*)`.as("count"), sql<string>`coalesce(sum(bytes), 0)`.as("bytes")])
    .where("project_id", "=", projectId)
    .executeTakeFirstOrThrow();
  return { count: Number(row.count), bytes: Number(row.bytes) };
}

/**
 * Deletes every replay of a project, as its settings offer when replays
 * are turned off: the objects, then the rows and any chunks still waiting.
 * Holds the project's row exclusively (FOR NO KEY UPDATE, which chunks
 * arriving still may reference), so a join in progress finishes first and
 * none starts until this is done (joinReplays()).
 */
export async function deleteProjectReplays(
  db: Kysely<Database>,
  store: ObjectStore,
  projectId: string,
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    await trx
      .selectFrom("projects")
      .select("id")
      .where("id", "=", projectId)
      .forNoKeyUpdate()
      .execute();
    const deleted = await store.deletePrefix(replayPrefix(projectId));
    await trx.deleteFrom("replays").where("project_id", "=", projectId).execute();
    await trx.deleteFrom("replay_chunks").where("project_id", "=", projectId).execute();
    return deleted;
  });
}

/**
 * Deletes some of a project's replays by ID, with their chunks still
 * waiting: those of deleted spam visits (spam/delete-visits.ts). Holds the
 * project's row as deleteProjectReplays() does, so a join in progress
 * finishes first and cannot write one back. Returns how many were stored.
 */
export async function deleteReplays(
  db: Kysely<Database>,
  store: ObjectStore,
  projectId: string,
  replayIds: readonly string[],
): Promise<number> {
  if (replayIds.length === 0) return 0;
  return db.transaction().execute(async (trx) => {
    await trx
      .selectFrom("projects")
      .select("id")
      .where("id", "=", projectId)
      .forNoKeyUpdate()
      .execute();
    const rows = await trx
      .selectFrom("replays")
      .select("object_key")
      .where("project_id", "=", projectId)
      .where("replay_id", "in", replayIds)
      .execute();
    if (rows.length > 0) await store.delete(rows.map((row) => row.object_key));
    await trx
      .deleteFrom("replays")
      .where("project_id", "=", projectId)
      .where("replay_id", "in", replayIds)
      .execute();
    await trx
      .deleteFrom("replay_chunks")
      .where("project_id", "=", projectId)
      .where("replay_id", "in", replayIds)
      .execute();
    return rows.length;
  });
}
