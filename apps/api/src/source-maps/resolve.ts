import { gunzipSync } from "node:zlib";

import { originalPositionFor, sourceContentFor, TraceMap } from "@jridgewell/trace-mapping";
import type { Kysely } from "kysely";

import type { Database } from "../db/schema.ts";
import { parseStack, type StackFrame } from "../errors/fingerprint.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { checkSourceMap, MAX_SOURCE_MAP_BYTES } from "./source-maps.ts";

/** Lines of the original source shown around a frame's line, before and after it. */
const CONTEXT_LINES = 3;
/** Longest context line shown: minified or generated lines can be very long. */
const MAX_CONTEXT_LINE = 300;
/** Most files of one stack looked up: a stack's own code is in a few. */
const MAX_FILES = 10;
/** Longest source and name shown: a map's entries are capped, but each frame repeats them. */
const MAX_NAME = 300;
/** Most lines of one source whose context is shown: past it, a frame shows none. */
const MAX_SOURCE_LINES = 200_000;

export interface SourceContext {
  /** The first line's number: the frame's line is among them. */
  firstLine: number;
  lines: string[];
}

export interface OriginalPosition {
  /** The original file, as the map names it, such as "src/cart.ts". */
  source: string;
  line: number;
  /** From 1, as browsers count. */
  column: number;
  /** The original name at that position, if the map has one. */
  name: string | null;
  context: SourceContext | null;
}

export interface ResolvedFrame extends StackFrame {
  /** Where the minified position came from; null when no map covers it. */
  original: OriginalPosition | null;
}

/**
 * - applied: at least one frame was mapped.
 * - no_release: the occurrence named no release, so no map can be chosen.
 * - no_files: no frame is in a file a map could be for (a web address).
 * - no_maps: no map of the release covers the stack's files (`paths`).
 * - not_mapped: the release has maps for the files, but none covers the
 *   frames' positions: they may be another build's.
 * - not_configured: the install has no object store, so no maps.
 * - unavailable: the store could not be read.
 */
export type SourceMapStatus =
  | "applied"
  | "no_release"
  | "no_files"
  | "no_maps"
  | "not_mapped"
  | "not_configured"
  | "unavailable";

export interface ResolvedStack {
  frames: ResolvedFrame[];
  status: SourceMapStatus;
  release: string | null;
  /** The minified files' paths looked up, for "no_maps" and "not_mapped": what to upload. */
  paths: string[];
}

interface CachedMap {
  map: TraceMap;
  /** About what it takes in memory, decoded (sizeOf), and its sources' line starts. */
  bytes: number;
  /** Where each line of a source starts, found once; null for a source without content or too many lines. */
  lines: Map<string, Uint32Array | null>;
}

/**
 * About the memory a map takes once read and decoded: its text, held twice
 * over by the parsed JSON, and the arrays decoding builds, one per line
 * and one per segment. An estimate from what checkSourceMap counted.
 */
const sizeOf = (text: string, shape: { lines: number; segments: number }) =>
  text.length * 2 + shape.lines * 40 + shape.segments * 72;

/**
 * Maps read lately, most recent last, up to about `maxBytes` of memory:
 * reading and decoding a large map costs far more than looking up in it.
 * Keyed by object and upload time, so a replaced map is never served.
 */
export class SourceMapCache {
  readonly #entries = new Map<string, CachedMap>();
  readonly maxBytes: number;
  #bytes = 0;

  constructor(maxBytes = 128 * 1024 ** 2) {
    this.maxBytes = maxBytes;
  }

  /** What the cached maps take, about. */
  get bytes(): number {
    return this.#bytes;
  }

  get(key: string): CachedMap | undefined {
    const entry = this.#entries.get(key);
    if (entry !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, entry);
    }
    return entry;
  }

  /** Counts `bytes` more for an entry, held or not: the line starts it found. */
  grow(entry: CachedMap, bytes: number): void {
    entry.bytes += bytes;
    if (![...this.#entries.values()].includes(entry)) return;
    this.#bytes += bytes;
    this.#evict();
  }

  set(key: string, entry: CachedMap): void {
    if (entry.bytes > this.maxBytes) return;
    const replaced = this.#entries.get(key);
    if (replaced !== undefined) {
      this.#entries.delete(key);
      this.#bytes -= replaced.bytes;
    }
    this.#entries.set(key, entry);
    this.#bytes += entry.bytes;
    this.#evict();
  }

  #evict(): void {
    for (const [oldest, old] of this.#entries) {
      if (this.#bytes <= this.maxBytes) break;
      this.#entries.delete(oldest);
      this.#bytes -= old.bytes;
    }
  }
}

/** A frame file's path, as maps are uploaded for: its URL's path. Null for anything else. */
function pathOf(file: string): string | null {
  if (!/^https?:\/\//i.test(file)) return null;
  const url = URL.parse(file);
  return url === null ? null : url.pathname;
}

/** "webpack://app/./src/cart.ts" and "./src/cart.ts" as "src/cart.ts". */
function cleanSource(source: string): string {
  return source.replace(/^webpack:\/\/[^/]*\//, "").replace(/^(?:\.\/)+/, "");
}

/**
 * Where each line of `content` starts, after "\r\n", "\n", or "\r"; null
 * past MAX_SOURCE_LINES. Offsets, not split strings: a source of millions
 * of short lines would otherwise take millions of strings.
 */
export function lineStarts(content: string, maxLines = MAX_SOURCE_LINES): Uint32Array | null {
  const starts = [0];
  for (let at = 0; at < content.length; at += 1) {
    const code = content.charCodeAt(at);
    if (code !== 10 && code !== 13) continue;
    if (code === 13 && content.charCodeAt(at + 1) === 10) at += 1;
    if (starts.length >= maxLines) return null;
    starts.push(at + 1);
  }
  return Uint32Array.from(starts);
}

/** The lines around `line` of `content`, each cut to MAX_CONTEXT_LINE, without their line breaks. */
function linesAround(content: string, starts: Uint32Array, line: number): SourceContext | null {
  if (line < 1 || line > starts.length) return null;
  const firstLine = Math.max(1, line - CONTEXT_LINES);
  const lastLine = Math.min(starts.length, line + CONTEXT_LINES);
  const lines: string[] = [];
  for (let index = firstLine - 1; index < lastLine; index += 1) {
    const start = starts[index] ?? 0;
    const end = Math.min(starts[index + 1] ?? content.length, start + MAX_CONTEXT_LINE + 2);
    lines.push(
      content
        .slice(start, end)
        .replace(/\r?\n$|\r$/, "")
        .slice(0, MAX_CONTEXT_LINE),
    );
  }
  return { firstLine, lines };
}

function contextOf(
  cache: SourceMapCache,
  entry: CachedMap,
  source: string,
  line: number,
): SourceContext | null {
  // Checked when stored; a map read back is treated as untrusted all the same.
  const content: unknown = sourceContentFor(entry.map, source);
  if (typeof content !== "string") return null;
  let starts = entry.lines.get(source);
  if (starts === undefined) {
    starts = lineStarts(content);
    entry.lines.set(source, starts);
    cache.grow(entry, (starts?.byteLength ?? 0) + 64);
  }
  return starts === null ? null : linesAround(content, starts, line);
}

function originalOf(
  cache: SourceMapCache,
  entry: CachedMap,
  frame: StackFrame,
): OriginalPosition | null {
  if (frame.line === null || frame.line < 1) return null;
  // Browsers count columns from 1, source maps from 0.
  const column = Math.max(0, (frame.column ?? 1) - 1);
  const position = originalPositionFor(entry.map, { line: frame.line, column });
  if (position.source === null) return null;
  return {
    source: cleanSource(position.source).slice(0, MAX_NAME),
    line: position.line,
    column: position.column + 1,
    name: typeof position.name === "string" ? position.name.slice(0, MAX_NAME) : null,
    context: contextOf(cache, entry, position.source, position.line),
  };
}

const unresolved = (frames: StackFrame[]): ResolvedFrame[] =>
  frames.map((frame) => ({ ...frame, original: null }));

/**
 * One stack's maps are read at a time in this process: each read can take
 * tens of megabytes until the cache holds it, so pages opened at once wait
 * for each other rather than reading many maps together.
 */
let reading: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const result = reading.then(work, work);
  reading = result.catch(() => undefined);
  return result;
}

/**
 * A stack's frames with their original positions, from the maps the
 * project uploaded for the occurrence's release (docs/errors.md, "Source
 * maps"). Frames no map covers are left as the browser wrote them.
 */
export async function resolveStack(
  deps: {
    db: Kysely<Database>;
    store: ObjectStore | null;
    cache: SourceMapCache;
    /** Told why a map could not be read; the stack is then shown as it is. */
    onError?: (error: unknown) => void;
  },
  projectId: string,
  release: string | null,
  stack: string,
): Promise<ResolvedStack> {
  const frames = parseStack(stack);
  const paths = [...new Set(frames.flatMap((frame) => pathOf(frame.file) ?? []))].slice(
    0,
    MAX_FILES,
  );
  const answer = (status: SourceMapStatus, resolved = unresolved(frames)): ResolvedStack => ({
    frames: resolved,
    status,
    release,
    paths: status === "no_maps" || status === "not_mapped" ? paths : [],
  });
  if (deps.store === null) return answer("not_configured");
  if (release === null) return answer("no_release");
  if (paths.length === 0) return answer("no_files");

  const rows = await deps.db
    .selectFrom("source_maps")
    .select(["path", "object_key", "uploaded_at"])
    .where("project_id", "=", projectId)
    .where("release", "=", release)
    .where("path", "in", paths)
    .execute();
  if (rows.length === 0) return answer("no_maps");

  const { store, cache } = deps;
  let maps: Map<string, CachedMap>;
  try {
    maps = await oneAtATime(async () => {
      const found = new Map<string, CachedMap>();
      // One after another, and no more than the cache holds in all.
      let budget = cache.maxBytes;
      for (const row of rows) {
        const key = `${row.object_key}@${row.uploaded_at.toISOString()}`;
        let entry = cache.get(key);
        if (entry === undefined) {
          const data = await store.get(row.object_key);
          if (data === null) continue;
          const text = gunzipSync(data, { maxOutputLength: MAX_SOURCE_MAP_BYTES }).toString("utf8");
          // Checked when uploaded; checked again, as reading is what the limits protect.
          const shape = checkSourceMap(text);
          if (shape === null || sizeOf(text, shape) > budget) continue;
          entry = { map: new TraceMap(text), bytes: sizeOf(text, shape), lines: new Map() };
          cache.set(key, entry);
        }
        if (entry.bytes > budget) continue;
        budget -= entry.bytes;
        found.set(row.path, entry);
      }
      return found;
    });
  } catch (error) {
    deps.onError?.(error);
    return answer("unavailable");
  }

  let resolved: ResolvedFrame[];
  try {
    resolved = frames.map((frame) => {
      const path = pathOf(frame.file);
      const entry = path === null ? undefined : maps.get(path);
      return {
        ...frame,
        original: entry === undefined ? null : originalOf(cache, entry, frame),
      };
    });
  } catch (error) {
    // A map whose mappings do not decode, though they looked right.
    deps.onError?.(error);
    return answer("unavailable");
  }
  return answer(
    resolved.some((frame) => frame.original !== null) ? "applied" : "not_mapped",
    resolved,
  );
}
