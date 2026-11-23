import { gunzipSync } from "node:zlib";

import { originalPositionFor, sourceContentFor, TraceMap } from "@jridgewell/trace-mapping";
import type { Kysely } from "kysely";

import type { Database } from "../db/schema.ts";
import { parseStack, type StackFrame } from "../errors/fingerprint.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { checkSourceMap, MAX_SOURCE_MAP_BYTES } from "./source-maps.ts";

/** Context lines before and after the frame. */
const CONTEXT_LINES = 3;
/** Bounds output from minified/generated lines. */
const MAX_CONTEXT_LINE = 300;
/** Bounds map lookups per stack; application frames usually use few files. */
const MAX_FILES = 10;
/** Frames repeat map entries, so cap displayed names too. */
const MAX_NAME = 300;
/** Omit context above this source-line cap. */
const MAX_SOURCE_LINES = 200_000;

export interface SourceContext {
  firstLine: number;
  lines: string[];
}

export interface OriginalPosition {
  source: string;
  line: number;
  /** One-based, matching browsers. */
  column: number;
  name: string | null;
  context: SourceContext | null;
}

export interface ResolvedFrame extends StackFrame {
  /** Null when no map covers the position. */
  original: OriginalPosition | null;
}

/**
 * no_release: no release to select maps. no_files: no web-address frames. no_maps: no maps for
 * paths. not_mapped: maps exist but miss frame positions, possibly from a different build.
 * not_configured: no object store. unavailable: store read failed. applied: at least one mapped
 * frame.
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
  /** Upload hints for no_maps and not_mapped. */
  paths: string[];
}

interface CachedMap {
  map: TraceMap;
  /** Estimated decoded memory (sizeOf). */
  bytes: number;
  /** Cached line offsets; null for missing content or excessive lines. */
  lines: Map<string, Uint32Array | null>;
}

/**
 * Estimate from checkSourceMap: text held twice by parsed JSON plus arrays per decoded line and
 * segment.
 */
const sizeOf = (text: string, shape: { lines: number; segments: number }) =>
  text.length * 2 + shape.lines * 40 + shape.segments * 72;

/**
 * Caches expensive decoding within maxBytes, most recent last. Object key and upload time prevent
 * serving replaced maps.
 */
export class SourceMapCache {
  readonly #entries = new Map<string, CachedMap>();
  readonly maxBytes: number;
  #bytes = 0;

  constructor(maxBytes = 128 * 1024 ** 2) {
    this.maxBytes = maxBytes;
  }

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

  /** Charge discovered line offsets even if the entry was evicted. */
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

/** Uses URL paths to match uploaded maps; null for non-URLs. */
function pathOf(file: string): string | null {
  if (!/^https?:\/\//i.test(file)) return null;
  const url = URL.parse(file);
  return url === null ? null : url.pathname;
}

/**
 * Removes webpack:// prefixes and leading ./, e.g. webpack://app/./src/cart.ts becomes
 * src/cart.ts.
 */
function cleanSource(source: string): string {
  return source.replace(/^webpack:\/\/[^/]*\//, "").replace(/^(?:\.\/)+/, "");
}

/**
 * Stores offsets after CRLF, LF, or CR to avoid millions of split strings. Returns null past
 * maxLines (MAX_SOURCE_LINES by default).
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

/** Caps context lines at MAX_CONTEXT_LINE and removes line endings. */
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
  // Treat stored maps as untrusted too.
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
  // Browsers use one-based columns; source maps use zero-based columns.
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

/** Serialize stack reads: each can hold tens of megabytes before entering the cache. */
let reading: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const result = reading.then(work, work);
  reading = result.catch(() => undefined);
  return result;
}

/**
 * Maps only the project's occurrence release; uncovered frames stay unchanged (docs/errors.md,
 * "Source maps").
 */
export async function resolveStack(
  deps: {
    db: Kysely<Database>;
    store: ObjectStore | null;
    cache: SourceMapCache;
    /** Reports read failures; the original stack remains visible. */
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
      // Bound total map memory per stack by cache capacity.
      let budget = cache.maxBytes;
      for (const row of rows) {
        const key = `${row.object_key}@${row.uploaded_at.toISOString()}`;
        let entry = cache.get(key);
        if (entry === undefined) {
          const data = await store.get(row.object_key);
          if (data === null) continue;
          const text = gunzipSync(data, { maxOutputLength: MAX_SOURCE_MAP_BYTES }).toString("utf8");
          // Recheck on read because these limits protect decoding memory.
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
    // Valid-looking mappings may still fail decoding.
    deps.onError?.(error);
    return answer("unavailable");
  }
  return answer(
    resolved.some((frame) => frame.original !== null) ? "applied" : "not_mapped",
    resolved,
  );
}
