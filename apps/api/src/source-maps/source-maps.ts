import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { type Kysely, sql } from "kysely";

import { isStorableText } from "../collection/normalize.ts";
import type { Database } from "../db/schema.ts";
import type { ObjectStore } from "../storage/object-store.ts";

/** Maps are scoped to project, release, and minified file (docs/errors.md, "Source maps"). */

/** JSON-byte cap; large app chunks stay well below it. */
export const MAX_SOURCE_MAP_BYTES = 25 * 1024 ** 2;

/**
 * Decoded arrays cost tens of bytes per line and segment. Cap both to prevent compact mappings
 * allocating gigabytes.
 */
export const MAX_MAP_LINES = 100_000;
export const MAX_MAP_SEGMENTS = 1_000_000;

/**
 * Bounds sources/names array allocations and displayed frame text. Typical large chunks have a few
 * thousand sources and short names.
 */
export const MAX_MAP_SOURCES = 20_000;
export const MAX_MAP_NAMES = 300_000;
export const MAX_MAP_ENTRY = 1024;
/** Character cap for sourcesContent, leaving room for other fields. */
export const MAX_MAP_CONTENT = 20 * 1024 ** 2;

/** Bounds minified asset paths. */
export const MAX_SOURCE_PATH = 1024;

/**
 * Matches browser URL paths (resolve.ts): / prefix, percent-encoded, no origin/query/fragment or
 * dot segments. ASCII keeps index sizes bounded.
 */
export function isSourcePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_SOURCE_PATH || !path.startsWith("/")) return false;
  if (path.startsWith("//") || !isStorableText(path)) return false;
  const url = URL.parse(path, "http://placeholder");
  return url !== null && url.pathname === path && url.search === "" && url.hash === "";
}

/** Project prefix keeps objects together for deletion. */
export function objectKeyOf(projectId: string, release: string, path: string): string {
  const name = createHash("sha256").update(`${release}\n${path}`).digest("hex");
  return `${projectPrefix(projectId)}${name}.map.gz`;
}

export const projectPrefix = (projectId: string) => `source-maps/${projectId}/`;

/** Source-map base64 VLQ: commas separate segments, semicolons separate lines. */
const VLQ_MAPPINGS = /^[A-Za-z0-9+/,;]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

function isEntryList(value: unknown, max: number, nulls: boolean): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every((entry) =>
      typeof entry === "string" ? entry.length <= MAX_MAP_ENTRY : nulls && entry === null,
    )
  );
}

function isSourcesContent(value: unknown, sources: number): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > sources) return false;
  let characters = 0;
  for (const content of value) {
    if (content === null) continue;
    if (typeof content !== "string") return false;
    characters += content.length;
    if (characters > MAX_MAP_CONTENT) return false;
  }
  return true;
}

/**
 * Checks v3 shape and limits before decoding mappings. Rejects index-map sections because offsets
 * can cause unbounded allocations. Returns null if unsupported or invalid.
 */
export function checkSourceMap(text: string): MapShape | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== 3 || "sections" in parsed) return null;
  const { mappings, sources, names = [], sourcesContent } = parsed;
  if (typeof mappings !== "string" || !VLQ_MAPPINGS.test(mappings)) return null;
  if (!isEntryList(sources, MAX_MAP_SOURCES, true) || !isEntryList(names, MAX_MAP_NAMES, false)) {
    return null;
  }
  if (!isSourcesContent(sourcesContent, sources.length)) return null;
  const lines = occurrences(mappings, ";") + 1;
  const segments = occurrences(mappings, ",") + lines;
  return lines <= MAX_MAP_LINES && segments <= MAX_MAP_SEGMENTS ? { lines, segments } : null;
}

export interface StoredSourceMap {
  release: string;
  path: string;
  /** Compressed bytes. */
  bytes: number;
  uploadedAt: Date;
}

/** Compressed bytes across all projects. */
export async function storedBytes(
  db: Kysely<Database>,
  /** Exclude the map being replaced. */
  except?: { projectId: string; release: string; path: string },
): Promise<number> {
  let query = db
    .selectFrom("source_maps")
    .select(sql<string>`coalesce(sum(source_maps.bytes), 0)`.as("bytes"));
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

/** A foreign-key violation means the project was deleted after key lookup. */
const isForeignKeyViolation = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "23503";

/**
 * Write the row, then object, then commit so deleteRelease waits and failed writes roll back.
 * limitBytes is soft: concurrent uploads can each pass. Refuses deleted projects.
 */
export async function storeSourceMap(
  deps: { db: Kysely<Database>; store: ObjectStore; limitBytes: number },
  project: { id: string },
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
      const others = await storedBytes(trx, {
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

/** Sorts by latest upload, newest or oldest first, with a capped list and total count. */
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

/**
 * Locks rows and deletes objects first; failures leave rows for retry. Uploads wait for commit
 * before replacing. Returns deleted count, or 0 if absent.
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
