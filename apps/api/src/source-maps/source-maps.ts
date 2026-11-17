import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { type Kysely, sql } from "kysely";

import { isStorableText } from "../collection/normalize.ts";
import type { Database } from "../db/schema.ts";
import type { ObjectStore } from "../storage/object-store.ts";

/**
 * Source maps (docs/errors.md, "Source maps"): what a site's build made to
 * turn its minified code back into its own, uploaded once per release and
 * minified file, and read when the dashboard shows an error's stack.
 */

/** Largest map, as JSON: a big app's largest chunk stays well under it. */
export const MAX_SOURCE_MAP_BYTES = 25 * 1024 ** 2;

/**
 * Most lines and segments a map's mappings may hold. Reading a map builds
 * an array for each line and each segment, tens of bytes apiece, so these,
 * not the map's size, decide the memory it takes: a short map of empty
 * lines would otherwise take gigabytes. A large app's largest chunk stays
 * well under both.
 */
export const MAX_MAP_LINES = 100_000;
export const MAX_MAP_SEGMENTS = 1_000_000;

/** Longest path of a minified file: an asset's address is far shorter. */
export const MAX_SOURCE_PATH = 1024;

/**
 * Whether `path` is a minified file's path as a browser reports it in a
 * stack, so frames can be matched to it (resolve.ts reads a frame's path
 * the same way): starting with "/", without an origin, query, or fragment,
 * percent-encoded, and without "." or ".." segments. Only ASCII, so it
 * stays within what the database indexes.
 */
export function isSourcePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_SOURCE_PATH || !path.startsWith("/")) return false;
  if (path.startsWith("//") || !isStorableText(path)) return false;
  const url = URL.parse(path, "http://placeholder");
  return url !== null && url.pathname === path && url.search === "" && url.hash === "";
}

/** Where a release's map for one file is in the object store: by project, so its files go together. */
export function objectKeyOf(projectId: string, release: string, path: string): string {
  const name = createHash("sha256").update(`${release}\n${path}`).digest("hex");
  return `${projectPrefix(projectId)}${name}.map.gz`;
}

/** Every source map of a project starts with this. */
export const projectPrefix = (projectId: string) => `source-maps/${projectId}/`;

/** A map's "mappings": base64 VLQ segments, "," between segments and ";" between lines. */
const VLQ_MAPPINGS = /^[A-Za-z0-9+/,;]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** How many times `character` is in `text`. */
function occurrences(text: string, character: string): number {
  let count = 0;
  for (let at = text.indexOf(character); at !== -1; at = text.indexOf(character, at + 1)) {
    count += 1;
  }
  return count;
}

export interface MapShape {
  lines: number;
  segments: number;
}

/**
 * The shape of the source map in `text`, without reading its mappings:
 * null when it is not one Ottertrail reads (not JSON, not version 3, not
 * mappings of base64 VLQ, more lines or segments than the limits) or is an
 * index map of "sections", which is not supported: its offsets alone could
 * make reading it take any amount of memory.
 */
export function checkSourceMap(text: string): MapShape | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== 3 || "sections" in parsed) return null;
  const { mappings, sources } = parsed;
  if (typeof mappings !== "string" || !VLQ_MAPPINGS.test(mappings)) return null;
  if (!Array.isArray(sources) || !sources.every((s) => typeof s === "string" || s === null)) {
    return null;
  }
  const lines = occurrences(mappings, ";") + 1;
  // A segment ends at each "," and at the end of each line that has one.
  const segments = occurrences(mappings, ",") + lines;
  return lines <= MAX_MAP_LINES && segments <= MAX_MAP_SEGMENTS ? { lines, segments } : null;
}

export interface StoredSourceMap {
  release: string;
  path: string;
  /** Its stored, compressed size. */
  bytes: number;
  uploadedAt: Date;
}

/** The compressed bytes of every source map of an organization's projects. */
async function organizationBytes(
  db: Kysely<Database>,
  organizationId: string,
  /** A map not to count: the one an upload replaces. */
  except?: { projectId: string; release: string; path: string },
): Promise<number> {
  let query = db
    .selectFrom("source_maps")
    .innerJoin("projects", "projects.id", "source_maps.project_id")
    .select(sql<string>`coalesce(sum(source_maps.bytes), 0)`.as("bytes"))
    .where("projects.organization_id", "=", organizationId);
  if (except !== undefined) {
    query = query.where((eb) =>
      eb.not(
        eb.and([
          eb("source_maps.project_id", "=", except.projectId),
          eb("source_maps.release", "=", except.release),
          eb("source_maps.path", "=", except.path),
        ]),
      ),
    );
  }
  const row = await query.executeTakeFirstOrThrow();
  return Number(row.bytes);
}

/** PostgreSQL's foreign_key_violation: here, a project deleted since its key was read. */
const isForeignKeyViolation = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "23503";

/**
 * Stores a map checked by checkSourceMap, replacing one of the same release
 * and file: its row first, in a transaction, then the compressed map in the
 * object store, then the commit. A failed write leaves neither, and a
 * deletion of the release (deleteRelease) waits for the commit, so the two
 * cannot leave a row without its map or a map without its row. Refused when
 * the organization's maps would pass `limitBytes` (a soft limit: uploads at
 * the same moment can each pass the check), or when the project is gone.
 */
export async function storeSourceMap(
  deps: { db: Kysely<Database>; store: ObjectStore; limitBytes: number },
  project: { id: string; organizationId: string },
  release: string,
  path: string,
  text: string,
): Promise<
  { stored: StoredSourceMap; replaced: boolean } | { refused: "over_limit" | "no_project" }
> {
  const { db, store, limitBytes } = deps;
  const compressed = gzipSync(text);
  const objectKey = objectKeyOf(project.id, release, path);
  try {
    return await db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("source_maps")
        .select("path")
        .where("project_id", "=", project.id)
        .where("release", "=", release)
        .where("path", "=", path)
        .forUpdate()
        .executeTakeFirst();
      const others = await organizationBytes(trx, project.organizationId, {
        projectId: project.id,
        release,
        path,
      });
      if (others + compressed.byteLength > limitBytes) return { refused: "over_limit" as const };
      const row = await trx
        .insertInto("source_maps")
        .values({
          project_id: project.id,
          release,
          path,
          object_key: objectKey,
          bytes: compressed.byteLength,
        })
        .onConflict((oc) =>
          oc.columns(["project_id", "release", "path"]).doUpdateSet({
            object_key: objectKey,
            bytes: compressed.byteLength,
            uploaded_at: sql<Date>`now()`,
          }),
        )
        .returning(["release", "path", "bytes", "uploaded_at"])
        .executeTakeFirstOrThrow();
      await store.put(objectKey, compressed, "application/gzip");
      return {
        stored: {
          release: row.release,
          path: row.path,
          bytes: row.bytes,
          uploadedAt: row.uploaded_at,
        },
        replaced: existing !== undefined,
      };
    });
  } catch (error) {
    if (isForeignKeyViolation(error)) return { refused: "no_project" };
    throw error;
  }
}

export interface ReleaseMaps {
  release: string;
  files: number;
  bytes: number;
  lastUploadedAt: Date;
}

/**
 * The releases a project has maps for, by their latest upload, newest or
 * oldest first, at most `limit`; and how many there are in all.
 */
export async function listReleases(
  db: Kysely<Database>,
  projectId: string,
  { order = "newest", limit = 100 }: { order?: "newest" | "oldest"; limit?: number } = {},
): Promise<{ releases: ReleaseMaps[]; total: number }> {
  const [rows, total] = await Promise.all([
    db
      .selectFrom("source_maps")
      .select([
        "release",
        sql<string>`count(*)`.as("files"),
        sql<string>`sum(bytes)`.as("bytes"),
        sql<Date>`max(uploaded_at)`.as("last_uploaded_at"),
      ])
      .where("project_id", "=", projectId)
      .groupBy("release")
      .orderBy("last_uploaded_at", order === "newest" ? "desc" : "asc")
      .orderBy("release")
      .limit(limit)
      .execute(),
    db
      .selectFrom("source_maps")
      .select(sql<string>`count(distinct release)`.as("total"))
      .where("project_id", "=", projectId)
      .executeTakeFirstOrThrow(),
  ]);
  return {
    releases: rows.map((row) => ({
      release: row.release,
      files: Number(row.files),
      bytes: Number(row.bytes),
      lastUploadedAt: row.last_uploaded_at,
    })),
    total: Number(total.total),
  };
}

/** One release's maps, by path: at most `limit`. */
export async function listFiles(
  db: Kysely<Database>,
  projectId: string,
  release: string,
  limit = 1000,
): Promise<StoredSourceMap[]> {
  const rows = await db
    .selectFrom("source_maps")
    .select(["release", "path", "bytes", "uploaded_at"])
    .where("project_id", "=", projectId)
    .where("release", "=", release)
    .orderBy("path")
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    release: row.release,
    path: row.path,
    bytes: row.bytes,
    uploadedAt: row.uploaded_at,
  }));
}

/** What an organization's maps take, all its projects together. */
export const storedBytes = async (db: Kysely<Database>, organizationId: string) =>
  organizationBytes(db, organizationId);

/**
 * Deletes a release's maps, in a transaction that holds their rows: the
 * objects, then the rows. An upload of one of them waits for the commit,
 * then stores it anew; a failure leaves the rows, to try again with, never
 * objects nothing points to. How many there were; 0 when none.
 */
export async function deleteRelease(
  deps: { db: Kysely<Database>; store: ObjectStore },
  projectId: string,
  release: string,
): Promise<number> {
  return await deps.db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom("source_maps")
      .select(["path", "object_key"])
      .where("project_id", "=", projectId)
      .where("release", "=", release)
      .forUpdate()
      .execute();
    if (rows.length === 0) return 0;
    await deps.store.delete(rows.map((row) => row.object_key));
    const result = await trx
      .deleteFrom("source_maps")
      .where("project_id", "=", projectId)
      .where("release", "=", release)
      .where(
        "path",
        "in",
        rows.map((row) => row.path),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  });
}
