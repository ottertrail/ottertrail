import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import type { FastifyReply, FastifyRequest } from "fastify";
import { type Kysely, sql } from "kysely";

import { isStorableText } from "../collection/normalize.ts";
import type { Database } from "../db/schema.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { deviceOf, type HeatmapDevice } from "./store.ts";

/**
 * Saved heatmap views (docs/web-analytics.md, "Saved views"): a snapshot of
 * a page as the owner's own browser showed it, taken by the overlay (o.js
 * and s.js, packages/tracker/src/snapshot-take.ts) when they press "Save
 * this view", and uploaded with the overlay's session. The Heatmaps screen
 * draws the heatmap over it in the replay player's sandboxed frame.
 *
 * One per project, page path, and device class (the viewport's width, as
 * heatmaps class it). Each is an object in the store, gzip-compressed JSON
 * as sent, under a new random name:
 *
 *   heatmap-snapshots/<project_id>/<uuid>.json.gz
 *
 * PostgreSQL holds the current key (heatmap_snapshots). Saving again
 * replaces the row and deletes the old object; a project's deletion
 * deletes its prefix (clickhouse/delete-events.ts). Visitors' pages are
 * never stored: only a signed-in user's overlay session can save one.
 *
 * The API checks the snapshot's shape, not its contents: like a replay, it
 * is untrusted HTML, which only the player's sandboxed frame shows.
 */

export const SNAPSHOT_PREFIX = "heatmap-snapshots/";
export const projectSnapshotPrefix = (projectId: string) => `${SNAPSHOT_PREFIX}${projectId}/`;
const newSnapshotKey = (projectId: string) =>
  `${projectSnapshotPrefix(projectId)}${randomUUID()}.json.gz`;

/** The largest snapshot, compressed, in bytes (packages/tracker/src/snapshot-names.ts). */
export const MAX_SNAPSHOT_BYTES = 5_000_000;
/** The largest snapshot unpacked, in bytes of JSON text. */
export const MAX_SNAPSHOT_TEXT_BYTES = 32 * 1024 * 1024;
/**
 * The most objects and arrays a snapshot's JSON may hold, and the most
 * values in all (every object, array, and comma-separated entry). The text
 * cap alone does not bound memory: 32 MiB of `{},` parses into millions of
 * objects. rrweb writes about three containers per element (the node, its
 * attributes, its children) and one per text node, so a very large page of
 * 80,000 elements and as many text nodes comes to about 320,000; these
 * leave room above that, and the pre-scan (structureOf) refuses a body past
 * them before JSON.parse runs.
 */
export const MAX_SNAPSHOT_CONTAINERS = 500_000;
export const MAX_SNAPSHOT_VALUES = 4_000_000;
/** Events in a snapshot at most: its meta, its full snapshot, and the stylesheets it brought. */
const MAX_EVENTS = 1000;

// rrweb's numbers (@rrweb/types).
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const META = 4;
const DOCUMENT_NODE = 0;
/** Stylesheet rules, declarations, and adopted sheets: what a full snapshot brings with it. */
const STYLE_SOURCES = new Set([8, 13, 15]);

const unzip = promisify(gunzip);

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isSide = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;

const problem = (error: string, message: string) => ({ error, message });
export const SNAPSHOT_TOO_LARGE = problem(
  "snapshot_too_large",
  "This page is too large to save: over 5 MB compressed, 32 MiB unpacked, or about 150,000 elements (500,000 objects and lists). Its heatmap still shows over the live page with Open on your site.",
);

/**
 * Counts the JSON's containers (objects and arrays) and values, outside
 * strings, in one pass over its bytes; stops once either is past its limit.
 * Only bytes of `{`, `[`, `,`, `"`, and `\\` matter, which never occur
 * inside a multi-byte UTF-8 character.
 */
export function structureOf(
  text: Uint8Array,
  limits = { containers: MAX_SNAPSHOT_CONTAINERS, values: MAX_SNAPSHOT_VALUES },
): { containers: number; values: number; over: boolean } {
  let containers = 0;
  let values = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const byte = text[i];
    if (inString) {
      if (byte === 0x5c) i += 1; // a backslash escapes the next byte
      else if (byte === 0x22) inString = false;
    } else if (byte === 0x22) {
      inString = true;
    } else if (byte === 0x7b || byte === 0x5b) {
      containers += 1;
      values += 1;
      if (containers > limits.containers) return { containers, values, over: true };
    } else if (byte === 0x2c) {
      values += 1;
      if (values > limits.values) return { containers, values, over: true };
    }
  }
  return { containers, values, over: false };
}

/** Checks run one at a time: each holds a parsed snapshot in memory. */
let checking: Promise<unknown> = Promise.resolve();
const NOT_A_SNAPSHOT = problem("invalid_snapshot", "The body is not a heatmap snapshot.");

/**
 * Refuses a `path` in the query that PostgreSQL cannot store (a NUL or an
 * unpaired surrogate, isStorableText), with 400 before any database work:
 * saved views keep the path in a row. A preValidation hook.
 */
export async function storablePath(request: FastifyRequest, reply: FastifyReply) {
  const query: unknown = request.query;
  const path =
    typeof query === "object" && query !== null && "path" in query ? query.path : undefined;
  if (typeof path !== "string" || isStorableText(path)) return undefined;
  return reply
    .code(400)
    .send(problem("invalid_query", "path contains a NUL character or an unpaired surrogate."));
}

/** What the API knows of a snapshot once checked. */
export interface SnapshotInfo {
  device: HeatmapDevice;
  width: number;
  height: number;
  pageHeight: number;
}

export type ReadSnapshot =
  | { ok: true; info: SnapshotInfo }
  | { ok: false; status: 400 | 413; body: { error: string; message: string } };

/**
 * Checks that gzip-compressed bytes are a snapshot as s.js writes it:
 * `{"v":1,"events":[…],"pageHeight":n}` and nothing else, its events
 * rrweb's, with one Meta event (the viewport's width and height), one full
 * snapshot of a document, and otherwise only style events.
 */
export function readSnapshot(body: Uint8Array): Promise<ReadSnapshot> {
  const turn = checking.then(() => checkSnapshot(body));
  checking = turn.catch(() => undefined);
  return turn;
}

async function checkSnapshot(body: Uint8Array): Promise<ReadSnapshot> {
  if (body.byteLength > MAX_SNAPSHOT_BYTES) {
    return { ok: false, status: 413, body: SNAPSHOT_TOO_LARGE };
  }
  let value: unknown;
  try {
    const text = await unzip(body, { maxOutputLength: MAX_SNAPSHOT_TEXT_BYTES });
    // Counted before parsing: memory follows the objects, not the text.
    if (structureOf(text).over) return { ok: false, status: 413, body: SNAPSHOT_TOO_LARGE };
    value = JSON.parse(text.toString("utf8"));
  } catch (error) {
    const tooLarge =
      error instanceof RangeError || (isRecord(error) && error.code === "ERR_BUFFER_TOO_LARGE");
    return tooLarge
      ? { ok: false, status: 413, body: SNAPSHOT_TOO_LARGE }
      : { ok: false, status: 400, body: NOT_A_SNAPSHOT };
  }
  const refused = { ok: false, status: 400, body: NOT_A_SNAPSHOT } as const;
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.events)) return refused;
  if (Object.keys(value).some((key) => !["v", "events", "pageHeight"].includes(key))) {
    return refused;
  }
  if (!isSide(value.pageHeight, 1_000_000)) return refused;
  const events: unknown[] = value.events;
  if (events.length < 2 || events.length > MAX_EVENTS) return refused;
  let meta: Json | undefined;
  let full = 0;
  for (const event of events) {
    if (
      !isRecord(event) ||
      Object.keys(event).some((key) => !["type", "data", "timestamp"].includes(key)) ||
      typeof event.timestamp !== "number" ||
      !Number.isFinite(event.timestamp) ||
      !isRecord(event.data)
    ) {
      return refused;
    }
    const { type, data } = event;
    if (type === META) {
      if (meta !== undefined) return refused;
      meta = data;
    } else if (type === FULL_SNAPSHOT) {
      full += 1;
      if (!isRecord(data.node) || data.node.type !== DOCUMENT_NODE) return refused;
    } else if (type !== INCREMENTAL || !STYLE_SOURCES.has(Number(data.source))) {
      return refused;
    }
  }
  if (meta === undefined || full !== 1) return refused;
  const { width, height } = meta;
  if (!isSide(width, 16_384) || !isSide(height, 16_384)) return refused;
  return {
    ok: true,
    info: { device: deviceOf(width), width, height, pageHeight: value.pageHeight },
  };
}

/** One saved view, as the dashboard lists it. */
export interface SnapshotRow {
  device: HeatmapDevice;
  width: number;
  height: number;
  pageHeight: number;
  savedAt: string;
  /** Who saved it; null once that user was removed. */
  savedBy: string | null;
}

/** The page's saved views, one per device class at most. */
export async function listSnapshots(
  db: Kysely<Database>,
  projectId: string,
  path: string,
): Promise<SnapshotRow[]> {
  const rows = await db
    .selectFrom("heatmap_snapshots as s")
    .leftJoin("dashboard_users as u", "u.id", "s.saved_by")
    .select(["s.device", "s.width", "s.height", "s.page_height", "s.saved_at", "u.name"])
    .where("s.project_id", "=", projectId)
    .where("s.path", "=", path)
    .orderBy("s.device")
    .execute();
  return rows.map((row) => ({
    device: row.device,
    width: row.width,
    height: row.height,
    pageHeight: row.page_height,
    savedAt: row.saved_at.toISOString(),
    savedBy: row.name,
  }));
}

/** The object key of one saved view, or null. */
export async function snapshotKey(
  db: Kysely<Database>,
  projectId: string,
  path: string,
  device: HeatmapDevice,
): Promise<string | null> {
  const row = await db
    .selectFrom("heatmap_snapshots")
    .select("object_key")
    .where("project_id", "=", projectId)
    .where("path", "=", path)
    .where("device", "=", device)
    .executeTakeFirst();
  return row?.object_key ?? null;
}

export interface SnapshotLog {
  warn(fields: object, message: string): void;
}

/** One lock per project, path, and device: two saves of one view take turns. */
const lockView = (projectId: string, path: string, device: HeatmapDevice) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${`heatmap-snapshot:${projectId}:${device}:${path}`}, 0))`;

/**
 * Stores the snapshot and makes it the page's view for its device,
 * replacing the one before, whose object is then deleted. Returns null
 * when the project is gone meanwhile (its object is deleted again). A
 * failure of the store or the database throws, and leaves the earlier
 * view as it was.
 */
export async function saveSnapshot(
  db: Kysely<Database>,
  store: ObjectStore,
  {
    projectId,
    path,
    userId,
    body,
    info,
    now = new Date(),
  }: {
    projectId: string;
    path: string;
    userId: string;
    body: Uint8Array;
    info: SnapshotInfo;
    now?: Date;
  },
  log: SnapshotLog,
): Promise<{ savedAt: Date } | null> {
  const key = newSnapshotKey(projectId);
  await store.put(key, body, "application/gzip");
  let saved: { old: string | null } | undefined;
  try {
    saved = await db.transaction().execute(async (trx) => {
      await lockView(projectId, path, info.device).execute(trx);
      // Held until the end, so the project cannot be deleted meanwhile.
      const project = await trx
        .selectFrom("projects")
        .select("id")
        .where("id", "=", projectId)
        .forKeyShare()
        .executeTakeFirst();
      if (project === undefined) return undefined;
      const before = await trx
        .selectFrom("heatmap_snapshots")
        .select("object_key")
        .where("project_id", "=", projectId)
        .where("path", "=", path)
        .where("device", "=", info.device)
        .executeTakeFirst();
      const values = {
        width: info.width,
        height: info.height,
        page_height: info.pageHeight,
        object_key: key,
        size_bytes: body.byteLength,
        saved_by: userId,
        saved_at: now,
      };
      await trx
        .insertInto("heatmap_snapshots")
        .values({ project_id: projectId, path, device: info.device, ...values })
        .onConflict((conflict) =>
          conflict.columns(["project_id", "path", "device"]).doUpdateSet(values),
        )
        .execute();
      return { old: before?.object_key ?? null };
    });
  } catch (error) {
    await deleteQuietly(store, [key], log);
    throw error;
  }
  if (saved === undefined) {
    await deleteQuietly(store, [key], log);
    return null;
  }
  if (saved.old !== null) await deleteQuietly(store, [saved.old], log);
  return { savedAt: now };
}

/**
 * Deletes one saved view: its object, then its row, in one transaction
 * that holds the row, so a failure of the store leaves both. False when
 * there was none.
 */
export async function deleteSnapshot(
  db: Kysely<Database>,
  store: ObjectStore,
  projectId: string,
  path: string,
  device: HeatmapDevice,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    await lockView(projectId, path, device).execute(trx);
    const row = await trx
      .deleteFrom("heatmap_snapshots")
      .where("project_id", "=", projectId)
      .where("path", "=", path)
      .where("device", "=", device)
      .returning("object_key")
      .executeTakeFirst();
    if (row === undefined) return false;
    await store.delete([row.object_key]);
    return true;
  });
}

/** Deletes objects nothing points to any more; a failure is logged, not answered. */
async function deleteQuietly(store: ObjectStore, keys: readonly string[], log: SnapshotLog) {
  if (keys.length === 0) return;
  try {
    await store.delete(keys);
  } catch (error) {
    log.warn({ err: error, keys }, "could not delete a heatmap snapshot; it stays stored");
  }
}
