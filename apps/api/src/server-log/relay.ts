import { Client } from "pg";

import { type RateLimit, TokenBucketLimiter } from "../collection/rate-limiter.ts";
import { fitLine, type LogRecord } from "./buffer.ts";

/**
 * The PostgreSQL channel the worker's log lines cross to the API on
 * (NOTIFY, then LISTEN in listener.ts): transport only, nothing written to
 * a table. A notification reaches whoever listens at that moment and is
 * gone; with no API listening, PostgreSQL drops it.
 */
export const SERVER_LOG_CHANNEL = "ottertrail_server_log";

/**
 * The most bytes of one line's payload. PostgreSQL refuses a NOTIFY
 * payload of 8000 bytes or more (its default build); a longer line is cut
 * and says so (fitLine).
 */
export const NOTIFY_MAX_BYTES = 7900;

/** The worker's lines per second to the Server log, and the burst. Its stdout gets every line. */
export const RELAY_LIMIT: RateLimit = { capacity: 100, refillPerSecond: 20 };

/** Lines waiting while the connection opens; past it, lines are dropped and counted. */
export const RELAY_MAX_QUEUE = 200;

/** How long the relay waits after a failed connection or notification before trying again. */
const RETRY_MS = { first: 1000, max: 30_000 };

/**
 * The connection's limits, the listener's too: TCP keepalive finds a
 * half-open connection, and a connect or a query gives up after 10 seconds
 * rather than hang.
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
 * The worker's side of the Server log: each log line, already on stdout,
 * also goes to the API as a NOTIFY on its own connection, apart from the
 * worker's pool, so a busy pool never holds a line up and a line never
 * holds a job up. `send` never throws and never waits; a failure only
 * drops lines. At most RELAY_LIMIT lines a second go out, so a worker
 * logging in a loop can't flood PostgreSQL; lines dropped, for the limit
 * or while PostgreSQL can't be reached, are counted and sent as one line
 * when lines go out again.
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

  /** Starts sending, unless a run is under way; a line queued as one ends starts the next. */
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

  /** Counts a queued payload as dropped: a line as one, the count's own line as what it counted. */
  #drop(item: Queued): void {
    this.#dropped += item.counts ?? 1;
  }

  /** Waits before the next connection, doubling up to 30 seconds. */
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
    // Unheard, a lost connection's "error" would end the worker.
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
        // Unreachable: what waits is dropped and counted, and goes out as one line later.
        for (const item of this.#queue.splice(0)) this.#drop(item);
        return;
      }
      const item = this.#queue.shift();
      if (item === undefined) return;
      try {
        await client.query("select pg_notify($1, $2)", [this.#channel, item.payload]);
        this.#retryMs = RETRY_MS.first;
      } catch {
        // A notification that keeps failing waits as a failed connection does,
        // rather than open a connection for each line queued.
        this.#drop(item);
        if (this.#client === client) this.#client = null;
        await client.end().catch(() => undefined);
        this.#backOff();
      }
    }
  }
}
