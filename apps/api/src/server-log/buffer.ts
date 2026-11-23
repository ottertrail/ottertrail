import { randomBytes } from "node:crypto";

/**
 * Keep recent API and worker lines in memory only (docs/dashboard.md, "Server log").
 * Restarts clear them. Older lines remain in container logs
 * (`docker compose logs`, docs/deployment.md).
 */

/** Database logs are excluded. */
export type ServerProcess = "api" | "worker";

export const SERVER_LOG_MAX_LINES = 2000;
export const SERVER_LOG_MAX_BYTES = 4 * 1024 * 1024;
/** Longer lines are truncated by fitLine. */
export const SERVER_LOG_MAX_LINE_BYTES = 16 * 1024;

export interface ServerLogEntry {
  /** Reconnect cursors use this process-local sequence. */
  seq: number;
  process: ServerProcess;
  /** The line as JSON, one line, without its newline. */
  text: string;
  bytes: number;
}

export interface ServerLogLimits {
  maxLines?: number;
  maxBytes?: number;
  maxLineBytes?: number;
}

export type LogRecord = Record<string, unknown>;

export function isLogRecord(value: unknown): value is LogRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseLogRecord(text: string): LogRecord | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isLogRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Preserve metadata and excerpts when truncating. `truncated` records the full size. */
export function fitLine(record: LogRecord, maxBytes: number): { record: LogRecord; text: string } {
  const text = JSON.stringify(record);
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) return { record, text };
  const base: LogRecord = {};
  for (const key of ["level", "time", "name", "pid", "hostname", "reqId"]) {
    if (record[key] !== undefined && typeof record[key] !== "object") base[key] = record[key];
  }
  const msg = typeof record.msg === "string" ? record.msg : "";
  let budget = Math.max(0, maxBytes - 400);
  for (;;) {
    const cut: LogRecord = {
      ...base,
      msg: msg.length > 500 ? `${msg.slice(0, 500)}…` : msg,
      truncated: { bytes, keptBytes: maxBytes },
      excerpt: `${text.slice(0, budget)}…`,
    };
    const cutText = JSON.stringify(cut);
    if (Buffer.byteLength(cutText) <= maxBytes || budget === 0) {
      return { record: cut, text: cutText };
    }
    budget = Math.floor(budget * 0.8);
  }
}

type Listener = (entry: ServerLogEntry) => void;

/** Bounded by line count and bytes; routes.ts subscribes to new entries. */
export class ServerLogBuffer {
  /** Reconnects after a restart must replay from the start. */
  readonly boot = randomBytes(6).toString("hex");
  readonly maxLines: number;
  readonly maxBytes: number;
  readonly maxLineBytes: number;
  readonly #entries: ServerLogEntry[] = [];
  /** Advance an index to avoid copying the array on each eviction. */
  #start = 0;
  #bytes = 0;
  #seq = 0;
  readonly #listeners = new Set<Listener>();

  constructor({
    maxLines = SERVER_LOG_MAX_LINES,
    maxBytes = SERVER_LOG_MAX_BYTES,
    maxLineBytes = SERVER_LOG_MAX_LINE_BYTES,
  }: ServerLogLimits = {}) {
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
    this.maxLineBytes = Math.min(maxLineBytes, maxBytes);
  }

  /** Never throws; malformed records and listener failures are ignored. */
  add(process: ServerProcess, record: LogRecord): void {
    let text: string;
    try {
      text = fitLine(record, this.maxLineBytes).text;
    } catch {
      // Ignore values JSON cannot serialize, such as BigInt.
      return;
    }
    this.#seq += 1;
    const entry: ServerLogEntry = {
      seq: this.#seq,
      process,
      text,
      bytes: Buffer.byteLength(text),
    };
    this.#entries.push(entry);
    this.#bytes += entry.bytes;
    while (this.size > this.maxLines || this.#bytes > this.maxBytes) {
      const oldest = this.#entries[this.#start];
      if (oldest === undefined) break;
      this.#bytes -= oldest.bytes;
      this.#start += 1;
    }
    // Compact periodically to bound the backing array.
    if (this.#start > 1024 && this.#start * 2 > this.#entries.length) {
      this.#entries.splice(0, this.#start);
      this.#start = 0;
    }
    for (const listener of this.#listeners) {
      try {
        listener(entry);
      } catch {
        // One failed stream must not interrupt the others (routes.ts closes it).
      }
    }
  }

  get size(): number {
    return this.#entries.length - this.#start;
  }

  get bytes(): number {
    return this.#bytes;
  }

  /** The lines kept, oldest first, after `afterSeq` when given. */
  entries(afterSeq = 0): ServerLogEntry[] {
    const kept = this.#entries.slice(this.#start);
    return afterSeq > 0 ? kept.filter((entry) => entry.seq > afterSeq) : kept;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
