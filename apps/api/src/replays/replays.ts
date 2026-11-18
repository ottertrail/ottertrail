import { gunzipSync, gzipSync } from "node:zlib";

import { type Kysely, sql } from "kysely";

import type { Database } from "../db/schema.ts";
import type { ObjectStore } from "../storage/object-store.ts";

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
/** How long replays are kept: the shortest retention a project can choose for events. */
export const REPLAY_RETENTION_DAYS = 30;

/** Every replay of a project starts with this. */
export const replayPrefix = (projectId: string) => `replays/${projectId}/`;
export const replayKeyOf = (projectId: string, replayId: string) =>
  `${replayPrefix(projectId)}${replayId}.json.gz`;

/** The compressed bytes of an organization's replays and of chunks not yet joined. */
export async function organizationReplayBytes(
  db: Kysely<Database>,
  organizationId: string,
): Promise<number> {
  const [replays, chunks] = await Promise.all([
    db
      .selectFrom("replays")
      .innerJoin("projects", "projects.id", "replays.project_id")
      .select(sql<string>`coalesce(sum(replays.bytes), 0)`.as("bytes"))
      .where("projects.organization_id", "=", organizationId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("replay_chunks")
      .innerJoin("projects", "projects.id", "replay_chunks.project_id")
      .select(sql<string>`coalesce(sum(octet_length(replay_chunks.data)), 0)`.as("bytes"))
      .where("projects.organization_id", "=", organizationId)
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
}

/**
 * Keeps one chunk, once: "stored", or why not. A new replay (its first
 * chunk) is refused when the organization's replays already take
 * `limitBytes`; a replay past MAX_REPLAY_BYTES is refused; a chunk of a
 * replay already joined, or already kept, is a duplicate, as a retry is.
 */
export async function storeChunk(
  db: Kysely<Database>,
  project: { id: string; organizationId: string },
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
  if (
    Number(sofar.chunks) === 0 &&
    (await organizationReplayBytes(db, project.organizationId)) >= limitBytes
  ) {
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
  return text === null ? null : checkRecording(text);
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

/** The recording's text when it is one, as joinChunks describes; null when not. */
function checkRecording(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.events)) return null;
  const { events } = parsed;
  const valid =
    events.length > 0 &&
    events.every(
      (event) =>
        isRecord(event) && typeof event.type === "number" && typeof event.timestamp === "number",
    );
  return valid ? text : null;
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
 */
export async function joinReplays(
  db: Kysely<Database>,
  store: ObjectStore,
  { now = new Date(), limit = 100 }: { now?: Date; limit?: number } = {},
): Promise<{ joined: number; dropped: number }> {
  const idleSince = new Date(now.getTime() - REPLAY_IDLE_MS);
  const candidates = await db
    .selectFrom("replay_chunks as c")
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
  for (const { project_id: projectId, replay_id: replayId } of candidates) {
    const outcome = await db.transaction().execute(async (trx) => {
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
      const latest = chunks.reduce((time, chunk) => Math.max(time, chunk.received_at.getTime()), 0);
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
      const text = closed === null ? null : checkRecording(closed);
      if (text === null) {
        // Not a recording, or nothing of one: once its last chunk came, or
        // it went quiet, nothing more will make it one.
        await trx
          .deleteFrom("replay_chunks")
          .where("project_id", "=", projectId)
          .where("replay_id", "=", replayId)
          .execute();
        return "dropped";
      }
      const compressed = gzipSync(text);
      const objectKey = replayKeyOf(projectId, replayId);
      await store.put(objectKey, compressed, "application/gzip");
      await trx
        .insertInto("replays")
        .values({
          project_id: projectId,
          replay_id: replayId,
          object_key: objectKey,
          bytes: compressed.byteLength,
          cut: !complete || kept.some((chunk) => chunk.cut),
        })
        .onConflict((oc) => oc.columns(["project_id", "replay_id"]).doNothing())
        .execute();
      return "joined";
    });
    if (outcome === "joined") joined += 1;
    if (outcome === "dropped") dropped += 1;
  }
  return { joined, dropped };
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
