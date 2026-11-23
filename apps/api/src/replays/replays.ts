import { gunzipSync, gzipSync } from "node:zlib";

import { type Kysely, sql } from "kysely";

import type { Database } from "../db/schema.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { deriveReplay } from "./derive.ts";

/**
 * PostgreSQL acknowledges masked replay chunks; the worker joins them into one object
 * (packages/tracker/src/replay.ts; docs/session-replay.md).
 */

/** One gzip member, within the beacon size limit. */
export const MAX_CHUNK_BYTES = 64 * 1024;
/** Bounds decompression of small uploads. */
export const MAX_CHUNK_UNPACKED_BYTES = 1024 ** 2;
/** Chunks 0 to 99: twice MAX_REPLAY_BYTES needs because the tracker fills chunks at least halfway. */
export const MAX_CHUNKS = 100;
/** The browser stops at 2,000,000 bytes. */
export const MAX_REPLAY_BYTES = 2_100_000;
/**
 * Bounds JSON parsed by both worker and viewer. Masked text compresses well enough that the
 * compressed cap alone permits 100 MiB.
 */
export const MAX_REPLAY_UNPACKED_BYTES = 16 * 1024 ** 2;
/** A typical minute has a few thousand events. */
export const MAX_REPLAY_EVENTS = 100_000;
/** Idle incomplete replays are abandoned. */
export const REPLAY_IDLE_MS = 5 * 60_000;
/** Keep chunks beyond tracker retry time after joining. */
export const CHUNK_KEEP_MS = 60 * 60_000;
/**
 * Accepts device clocks from 1970 through 2100. derive.ts corrects skew; wider corrections may
 * exceed PostgreSQL timestamps.
 */
export const EARLIEST_EVENT_TIME_MS = 0;
export const LATEST_EVENT_TIME_MS = Date.UTC(2100, 0, 1);
/** Matches the shortest project event retention. */
export const REPLAY_RETENTION_DAYS = 30;

export const replayPrefix = (projectId: string) => `replays/${projectId}/`;
export const replayKeyOf = (projectId: string, replayId: string) =>
  `${replayPrefix(projectId)}${replayId}.json.gz`;

/** Includes compressed objects and unjoined chunks across all projects. */
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
  /** Defaults to decompressing data here. */
  unpackedBytes?: number;
  /** Defaults to now; scripts/seed-data.ts supplies historical arrival times. */
  receivedAt?: Date;
}

/**
 * Deduplicates retained/joined chunks. New replays respect limitBytes; existing ones respect
 * MAX_REPLAY_BYTES and MAX_REPLAY_UNPACKED_BYTES.
 */
export async function storeChunk(
  db: Kysely<Database>,
  project: { id: string },
  chunk: Chunk,
  limitBytes: number,
): Promise<"stored" | "duplicate" | "storage_full" | "too_large" | "unpacked_too_large"> {
  const unpackedBytes =
    chunk.unpackedBytes ??
    gunzipSync(chunk.data, { maxOutputLength: MAX_CHUNK_UNPACKED_BYTES }).byteLength;
  // Serialize chunks per replay so concurrent uploads cannot all pass the same size sums.
  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`replay-chunk:${project.id}:${chunk.replayId}`}, 0))`.execute(
      trx,
    );
    const joined = await trx
      .selectFrom("replays")
      .select("replay_id")
      .where("project_id", "=", project.id)
      .where("replay_id", "=", chunk.replayId)
      .executeTakeFirst();
    if (joined !== undefined) return "duplicate";

    const sofar = await trx
      .selectFrom("replay_chunks")
      .select([
        sql<string>`coalesce(sum(octet_length(data)), 0)`.as("bytes"),
        sql<string>`count(*)`.as("chunks"),
        sql<string>`coalesce(sum(unpacked_bytes), 0)`.as("unpacked"),
      ])
      .where("project_id", "=", project.id)
      .where("replay_id", "=", chunk.replayId)
      .executeTakeFirstOrThrow();
    if (Number(sofar.chunks) === 0 && (await storedReplayBytes(trx)) >= limitBytes) {
      return "storage_full";
    }
    if (Number(sofar.bytes) + chunk.data.byteLength > MAX_REPLAY_BYTES) return "too_large";
    if (Number(sofar.unpacked) + unpackedBytes > MAX_REPLAY_UNPACKED_BYTES) {
      return "unpacked_too_large";
    }

    const result = await trx
      .insertInto("replay_chunks")
      .values({
        project_id: project.id,
        replay_id: chunk.replayId,
        seq: chunk.seq,
        last: chunk.last,
        cut: chunk.cut,
        data: chunk.data,
        unpacked_bytes: unpackedBytes,
        ...(chunk.receivedAt === undefined ? {} : { received_at: chunk.receivedAt }),
      })
      .onConflict((oc) => oc.columns(["project_id", "replay_id", "seq"]).doNothing())
      .executeTakeFirst();
    return (result.numInsertedOrUpdatedRows ?? 0n) > 0n ? "stored" : "duplicate";
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Requires v1 JSON and at most MAX_REPLAY_EVENTS objects with numeric type/timestamp. Returns null
 * for invalid recordings; contents remain untrusted.
 */
export function joinChunks(chunks: readonly Buffer[]): string | null {
  const unpacked = unpack(chunks);
  return unpacked === null || !unpacked.whole
    ? null
    : (checkRecording(unpacked.text)?.text ?? null);
}

/**
 * Unpacks chunks in order up to MAX_REPLAY_UNPACKED_BYTES, preserving the start of oversized
 * recordings. Returns null for invalid gzip.
 */
function unpack(chunks: readonly Buffer[]): { text: string; whole: boolean } | null {
  const parts: Buffer[] = [];
  let total = 0;
  for (const chunk of chunks) {
    let part: Buffer;
    try {
      part = gunzipSync(chunk, { maxOutputLength: MAX_REPLAY_UNPACKED_BYTES - total });
    } catch (error) {
      if (error instanceof RangeError) break;
      return null;
    }
    parts.push(part);
    total += part.byteLength;
  }
  return { text: Buffer.concat(parts).toString("utf8"), whole: parts.length === chunks.length };
}

/**
 * Leaving-page beacons may omit final chunks. Close v1 JSON after its last complete event (depth 2
 * outside strings); null if no event is complete.
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

function checkRecording(text: string): { text: string; events: RecordedEvent[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.events)) return null;
  const events: unknown[] = parsed.events;
  if (events.length > MAX_REPLAY_EVENTS) return null;
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
 * Joins complete replays or, after REPLAY_IDLE_MS, preserves contiguous chunks through their last
 * complete event (closeRecording). Drops empty recordings. Overlapping worker runs are safe.
 *
 * Hold the project row FOR SHARE so deleteProjectReplays waits, then removes the result; joins
 * after deletion find no chunks. This prevents recreating deleted replays.
 *
 * Store and transient database failures keep chunks for retry; permanent data/code errors drop the
 * replay and any object. Each failure affects only that replay. `failed` counts retryable
 * failures; `onError` receives each error.
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
    /** Defaults to all projects; seed can restrict one. */
    onlyProjectId?: string;
    /** Reports unexpected failures, including whether the replay was dropped. */
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
    // Only complete or idle replays consume the run limit, so pending uploads cannot starve other
    // joins.
    .having((eb) =>
      eb.or([
        eb.and([
          eb(sql<boolean>`bool_or(c.last)`, "=", true),
          eb(sql<number>`count(*)`, "=", sql<number>`max(c.seq) + 1`),
        ]),
        eb(eb.fn.max("c.received_at"), "<", idleSince),
      ]),
    )
    // Oldest first prevents new uploads from starving older replays.
    .orderBy((eb) => eb.fn.min("c.received_at"))
    .orderBy("c.project_id")
    .orderBy("c.replay_id")
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
          // dropReplay must wait for this join.
          .forShare()
          .execute();
        if (chunks.length === 0) return "skipped";
        const lastAt = chunks.findIndex((chunk) => chunk.last);
        const complete =
          lastAt !== -1 && chunks.slice(0, lastAt + 1).every((chunk, index) => chunk.seq === index);
        const latest = chunks.reduce(
          (time, chunk) => Math.max(time, chunk.received_at.getTime()),
          0,
        );
        if (!complete && latest >= idleSince.getTime()) {
          // Wait while a missing chunk may still be retried.
          return "skipped";
        }
        let inOrder = 0;
        while (chunks[inOrder]?.seq === inOrder) inOrder += 1;
        const kept = complete ? chunks.slice(0, lastAt + 1) : chunks.slice(0, inOrder);
        const unpacked = kept.length === 0 ? null : unpack(kept.map((chunk) => chunk.data));
        // Cut incomplete or size-limited recordings at the last complete event.
        const whole = complete && unpacked?.whole === true;
        const closed =
          unpacked === null ? null : whole ? unpacked.text : closeRecording(unpacked.text);
        const recording = closed === null ? null : checkRecording(closed);
        if (recording === null) {
          // Completed or idle invalid recordings cannot recover; discard them.
          await trx
            .deleteFrom("replay_chunks")
            .where("project_id", "=", projectId)
            .where("replay_id", "=", replayId)
            .execute();
          return "dropped";
        }
        const compressed = gzipSync(recording.text);
        const firstReceivedAt = kept.reduce(
          (time, chunk) => (chunk.received_at < time ? chunk.received_at : time),
          kept[0]?.received_at ?? now,
        );
        const details = deriveReplay(recording.events, firstReceivedAt);
        try {
          await store.put(objectKey, compressed, "application/gzip");
        } catch (error) {
          // Keep chunks for retry when no object was written.
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
            cut: !whole || kept.some((chunk) => chunk.cut),
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
          if (!(await dropReplay(db, store, projectId, replayId))) return "skipped" as const;
        } catch (deleteError) {
          // Cleanup retries on a later run.
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

/**
 * Lock chunks before checking for an overlapping join's result. Later joins find no chunks.
 * Returns false if nothing can be dropped.
 */
async function dropReplay(
  db: Kysely<Database>,
  store: ObjectStore,
  projectId: string,
  replayId: string,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const chunks = await trx
      .selectFrom("replay_chunks")
      .select("seq")
      .where("project_id", "=", projectId)
      .where("replay_id", "=", replayId)
      .forUpdate()
      .execute();
    if (chunks.length === 0) return false;
    const recorded = await trx
      .selectFrom("replays")
      .select("replay_id")
      .where("project_id", "=", projectId)
      .where("replay_id", "=", replayId)
      .executeTakeFirst();
    if (recorded !== undefined) return false;
    await store.delete([replayKeyOf(projectId, replayId)]);
    await trx
      .deleteFrom("replay_chunks")
      .where("project_id", "=", projectId)
      .where("replay_id", "=", replayId)
      .execute();
    return true;
  });
}

/** SQLSTATE data errors and constraint violations. */
const DATA_ERROR_CLASSES = new Set(["22", "23"]);

/**
 * Retry connection/system errors, other PostgreSQL classes, and uncoded errors. Code errors and
 * SQLSTATE 22/23 recur, so drop those replays.
 */
function isTransient(error: unknown): boolean {
  if (error instanceof RangeError || error instanceof TypeError || error instanceof SyntaxError) {
    return false;
  }
  const code = isRecord(error) ? error.code : undefined;
  if (code === undefined) return true;
  if (typeof code !== "string") return false;
  if (/^E[A-Z0-9]+$/.test(code)) return true;
  if (/^[0-9A-Z]{5}$/.test(code)) return !DATA_ERROR_CLASSES.has(code.slice(0, 2));
  return false;
}

/** Keep joined chunks through CHUNK_KEEP_MS to cover retries. */
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

/** Delete objects before rows, 1,000 at a time, so failures leave rows for retry. */
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
    await db.deleteFrom("replays").where("object_key", "in", keys).execute();
    deleted += rows.length;
  }
}

/** Records 10 seconds after an error, then uploads; allow time for arrival. */
export const REPLAY_PENDING_MS = 15 * 60_000;

export type ReplayStatus = "ready" | "pending" | "missing";

/**
 * Recent errors may still be uploading (pending); joined replays are ready, absent/expired ones
 * missing.
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
 * Hold the project FOR NO KEY UPDATE so joins finish before deletion and cannot recreate data.
 * Delete objects, rows, and pending chunks (joinReplays).
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
 * Delete spam-visit replays (spam/delete-visits.ts). Lock the project as deleteProjectReplays does
 * to prevent joins recreating them; returns stored count.
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
