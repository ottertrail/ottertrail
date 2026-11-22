import { randomBytes } from "node:crypto";

/**
 * The Server log (docs/dashboard.md, "Server log"): the API's and the
 * worker's latest log lines, in this process's memory only. Nothing is
 * stored: a restart starts it empty, and older lines are in the
 * containers' own logs (`docker compose logs`, docs/deployment.md).
 */

/** Ottertrail's processes whose lines the Server log shows. Never the databases'. */
export type ServerProcess = "api" | "worker";

/** The most lines the buffer keeps; older ones go first. */
export const SERVER_LOG_MAX_LINES = 2000;
/** The most bytes of JSON the buffer keeps, all lines together. */
export const SERVER_LOG_MAX_BYTES = 4 * 1024 * 1024;
/** The most bytes of one line the buffer keeps; a longer line is cut (fitLine). */
export const SERVER_LOG_MAX_LINE_BYTES = 16 * 1024;

export interface ServerLogEntry {
  /** Increasing within this process: what a stream that reconnects asks to start after. */
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

/** A log line's object, as pino and the worker write it. */
export type LogRecord = Record<string, unknown>;

export function isLogRecord(value: unknown): value is LogRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A line's JSON as an object, or null when it is not one. */
export function parseLogRecord(text: string): LogRecord | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isLogRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A line cut to `maxBytes` of JSON, saying so: its level, time, and
 * process fields, the start of its message, and the start of the whole
 * line as text (`excerpt`), with `truncated` holding the line's full size.
 * A line that fits comes back as it is.
 */
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

/**
 * A ring of the latest lines, bounded by count and by bytes, and the
 * streams that hear each new one (routes.ts).
 */
export class ServerLogBuffer {
  /** Names this process's run: a stream from before a restart starts again from the start. */
  readonly boot = randomBytes(6).toString("hex");
  readonly maxLines: number;
  readonly maxBytes: number;
  readonly maxLineBytes: number;
  readonly #entries: ServerLogEntry[] = [];
  /** Where the oldest entry is in #entries: removing from the front is a step, not a copy. */
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

  /** Adds one line, cut to fit, and passes it to every stream. Never throws. */
  add(process: ServerProcess, record: LogRecord): void {
    let text: string;
    try {
      text = fitLine(record, this.maxLineBytes).text;
    } catch {
      // A value JSON cannot write (a BigInt): pino and the worker never send one.
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
    // Compact now and then, so the array does not grow with every line ever added.
    if (this.#start > 1024 && this.#start * 2 > this.#entries.length) {
      this.#entries.splice(0, this.#start);
      this.#start = 0;
    }
    for (const listener of this.#listeners) {
      try {
        listener(entry);
      } catch {
        // A stream's failure is its own (routes.ts closes it); the others go on.
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

  /** Hears every line added from now on; returns what stops it. */
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
