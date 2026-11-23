import { Client } from "pg";

import { type RateLimit, TokenBucketLimiter } from "../collection/rate-limiter.ts";
import { fitLine, type LogRecord } from "./buffer.ts";

/**
 * NOTIFY transports worker logs to listener.ts without storing them.
 * Only current listeners receive each line.
 */
export const SERVER_LOG_CHANNEL = "ottertrail_server_log";

/**
 * PostgreSQL rejects NOTIFY payloads of 8000 bytes or more (default build).
 * fitLine truncates longer lines.
 */
export const NOTIFY_MAX_BYTES = 7900;

/** Rate limiting affects the Server log only; stdout gets every line. */
export const RELAY_LIMIT: RateLimit = { capacity: 100, refillPerSecond: 20 };

/** Lines waiting while the connection opens; past it, lines are dropped and counted. */
export const RELAY_MAX_QUEUE = 200;

const RETRY_MS = { first: 1000, max: 30_000 };

/**
 * Shared with the listener. Timeouts bound connection and query waits;
 * TCP keepalive detects half-open connections.
 */
export const CONNECTION_LIMITS = {
  keepAlive: true,
  connectionTimeoutMillis: 10_000,
  query_timeout: 10_000,
} as const;

/** A queued payload; a count of dropped lines carries how many it stands for. */
interface Queued {
  payload: string;
  /** For the count's own line: the lines it counts, which go back to the count if it is dropped too. */
  counts?: number;
}

export interface RelayOptions {
  connectionString: string;
  channel?: string;
  limit?: RateLimit;
  maxQueue?: number;
  now?: () => number;
}

/**
 * Use a separate connection so log delivery cannot block jobs or the pool.
 * `send` never waits or throws. RELAY_LIMIT bounds PostgreSQL traffic;
 * dropped lines are counted and reported when delivery resumes.
 */
export class WorkerLogRelay {
  readonly #connectionString: string;
  readonly #channel: string;
  readonly #limit: RateLimit;
  readonly #limiter: TokenBucketLimiter;
  readonly #maxQueue: number;
  readonly #now: () => number;
  readonly #queue: Queued[] = [];
  #client: Client | null = null;
  #pumping: Promise<void> | null = null;
  #dropped = 0;
  #retryAt = 0;
  #retryMs = RETRY_MS.first;
  #closed = false;

  constructor({
    connectionString,
    channel = SERVER_LOG_CHANNEL,
    limit = RELAY_LIMIT,
    maxQueue = RELAY_MAX_QUEUE,
    now = Date.now,
  }: RelayOptions) {
    this.#connectionString = connectionString;
    this.#channel = channel;
    this.#limit = limit;
    this.#limiter = new TokenBucketLimiter(limit, { now });
    this.#maxQueue = maxQueue;
    this.#now = now;
  }

  /** Lines dropped since the last count went out. */
  get dropped(): number {
    return this.#dropped;
  }

  /** Queues one line for the API, cut to fit a notification. */
  send(record: LogRecord): void {
    try {
      if (this.#closed) return;
      if (!this.#limiter.take("lines").allowed || this.#queue.length >= this.#maxQueue) {
        this.#dropped += 1;
        return;
      }
      if (this.#dropped > 0) {
        this.#queue.push(this.#droppedLine());
      }
      this.#queue.push({ payload: fitLine(record, NOTIFY_MAX_BYTES).text });
      this.#schedule();
    } catch {
      // Never the worker's problem: its stdout has the line.
      this.#dropped += 1;
    }
  }

  /** Sends what is queued, within about a second, then closes the connection. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.race([
      this.#pumping ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 1000).unref()),
    ]);
    const client = this.#client;
    this.#client = null;
    this.#queue.length = 0;
    await client?.end().catch(() => undefined);
  }

  #schedule(): void {
    if (this.#pumping !== null) return;
    this.#pumping = this.#pump().finally(() => {
      this.#pumping = null;
      if (this.#queue.length > 0 && !this.#closed) this.#schedule();
    });
  }

  #droppedLine(): Queued {
    const count = this.#dropped;
    this.#dropped = 0;
    const payload = JSON.stringify({
      level: "warn",
      time: this.#now(),
      name: "worker",
      msg: `${count} worker ${count === 1 ? "line" : "lines"} didn't reach the Server log: the worker sends at most ${this.#limit.refillPerSecond} a second, and none while PostgreSQL is unreachable. docker compose logs worker has every line.`,
      dropped: count,
    });
    return { payload, counts: count };
  }

  /** If a dropped-count message is lost, add its count back. */
  #drop(item: Queued): void {
    this.#dropped += item.counts ?? 1;
  }

  #backOff(): void {
    this.#retryAt = this.#now() + this.#retryMs;
    this.#retryMs = Math.min(this.#retryMs * 2, RETRY_MS.max);
  }

  async #connect(): Promise<Client | null> {
    if (this.#client !== null) return this.#client;
    if (this.#now() < this.#retryAt) return null;
    const client = new Client({
      connectionString: this.#connectionString,
      application_name: "ottertrail-server-log-relay",
      ...CONNECTION_LIMITS,
    });
    // An unhandled connection error would end the worker.
    client.on("error", () => {
      if (this.#client === client) this.#client = null;
    });
    client.on("end", () => {
      if (this.#client === client) this.#client = null;
    });
    try {
      await client.connect();
    } catch {
      await client.end().catch(() => undefined);
      this.#backOff();
      return null;
    }
    if (this.#closed) {
      await client.end().catch(() => undefined);
      return null;
    }
    this.#client = client;
    return client;
  }

  async #pump(): Promise<void> {
    while (this.#queue.length > 0) {
      const client = await this.#connect();
      if (client === null) {
        // Count queued lines as dropped; report them when delivery resumes.
        for (const item of this.#queue.splice(0)) this.#drop(item);
        return;
      }
      const item = this.#queue.shift();
      if (item === undefined) return;
      try {
        await client.query("select pg_notify($1, $2)", [this.#channel, item.payload]);
        this.#retryMs = RETRY_MS.first;
      } catch {
        // Back off after notification failures to avoid reconnecting for every queued line.
        this.#drop(item);
        if (this.#client === client) this.#client = null;
        await client.end().catch(() => undefined);
        this.#backOff();
      }
    }
  }
}
