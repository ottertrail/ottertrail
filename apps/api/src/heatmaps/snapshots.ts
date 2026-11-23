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
 * Only authenticated overlay sessions save views; visitor pages are never stored
 * (docs/web-analytics.md, "Saved views"; packages/tracker/src/snapshot-take.ts). Keep one per
 * project, path, and device. Objects use random names under
 * heatmap-snapshots/<project_id>/<uuid>.json.gz; heatmap_snapshots holds the current key.
 * Replacing deletes the old object; project deletion removes its prefix
 * (clickhouse/delete-events.ts). Validate shape only: HTML remains untrusted and must use the
 * player's sandbox.
 */

export const SNAPSHOT_PREFIX = "heatmap-snapshots/";
export const projectSnapshotPrefix = (projectId: string) => `${SNAPSHOT_PREFIX}${projectId}/`;
const newSnapshotKey = (projectId: string) =>
  `${projectSnapshotPrefix(projectId)}${randomUUID()}.json.gz`;

/** Compressed-byte cap matches packages/tracker/src/snapshot-names.ts. */
export const MAX_SNAPSHOT_BYTES = 5_000_000;
/** Unpacked JSON byte cap. */
export const MAX_SNAPSHOT_TEXT_BYTES = 32 * 1024 * 1024;
/**
 * Pre-scan before JSON.parse: 32 MiB of {}, can allocate millions of objects. rrweb uses about
 * three containers per element and one per text node; 80,000 of each needs about 320,000
 * containers. These caps leave room above that while bounding memory.
 */
export const MAX_SNAPSHOT_CONTAINERS = 500_000;
export const MAX_SNAPSHOT_VALUES = 4_000_000;
/** rrweb rebuilds recursively at about two levels per element; allows pages over 200 elements deep. */
export const MAX_SNAPSHOT_DEPTH = 500;
/** Allows metadata, one full snapshot, and stylesheet events. */
const MAX_EVENTS = 1000;

// rrweb event numbers (@rrweb/types).
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const META = 4;
const DOCUMENT_NODE = 0;
/** rrweb sources for stylesheet rules, declarations, and adopted sheets. */
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
export const SNAPSHOT_TOO_DEEP = problem(
  "snapshot_too_deep",
  "This page nests its elements too deeply to save: over 500 levels of objects and lists. Its heatmap still shows over the live page with Open on your site.",
);

/**
 * Scans structural bytes outside strings, stopping at container/value caps or depth (`deep`).
 * UTF-8 never embeds these bytes in multibyte characters.
 */
export function structureOf(
  text: Uint8Array,
  limits = {
    containers: MAX_SNAPSHOT_CONTAINERS,
    values: MAX_SNAPSHOT_VALUES,
    depth: MAX_SNAPSHOT_DEPTH,
  },
): { containers: number; values: number; over: boolean; deep: boolean } {
  let containers = 0;
  let values = 0;
  let depth = 0;
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
      depth += 1;
      if (depth > limits.depth) return { containers, values, over: true, deep: true };
      if (containers > limits.containers) return { containers, values, over: true, deep: false };
    } else if (byte === 0x7d || byte === 0x5d) {
      depth -= 1;
    } else if (byte === 0x2c) {
      values += 1;
      if (values > limits.values) return { containers, values, over: true, deep: false };
    }
  }
  return { containers, values, over: false, deep: false };
}

/** Serialize checks because each holds a parsed snapshot in memory. */
let checking: Promise<unknown> = Promise.resolve();
const NOT_A_SNAPSHOT = problem("invalid_snapshot", "The body is not a heatmap snapshot.");

/**
 * preValidation rejects NUL and unpaired surrogates with 400 before database access; paths must
 * fit PostgreSQL (isStorableText).
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
 * Requires v1 JSON with pageHeight and rrweb events: one Meta, one full document snapshot, and
 * optional style events. Rejects other fields.
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
    // Bound object allocations and player recursion before parsing.
    const structure = structureOf(text);
    if (structure.deep) return { ok: false, status: 400, body: SNAPSHOT_TOO_DEEP };
    if (structure.over) return { ok: false, status: 413, body: SNAPSHOT_TOO_LARGE };
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

export interface SnapshotRow {
  device: HeatmapDevice;
  width: number;
  height: number;
  pageHeight: number;
  savedAt: string;
  /** Null after user deletion. */
  savedBy: string | null;
}

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

/** Serialize saves per project, path, and device. */
const lockView = (projectId: string, path: string, device: HeatmapDevice) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${`heatmap-snapshot:${projectId}:${device}:${path}`}, 0))`;

/**
 * Replaces the saved view and deletes its old object. Failures preserve the prior view; concurrent
 * project deletion returns null and removes the new object.
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
      // Hold the project row through the transaction to prevent concurrent deletion.
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
 * Delete the object before its locked row so store failures preserve both. Returns false if
 * absent.
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

/** Cleanup failures are logged without failing the request. */
async function deleteQuietly(store: ObjectStore, keys: readonly string[], log: SnapshotLog) {
  if (keys.length === 0) return;
  try {
    await store.delete(keys);
  } catch (error) {
    log.warn({ err: error, keys }, "could not delete a heatmap snapshot; it stays stored");
  }
}
