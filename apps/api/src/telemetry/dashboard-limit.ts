import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import type { Reader } from "../clickhouse/query.ts";

/**
 * Limits concurrent queries so ingestion has ClickHouse capacity too (docs/telemetry.md, "How the
 * pages read"). Queue timeouts return 503 with Retry-After.
 */

/** Concurrent dashboard queries per process. */
export const QUERIES_AT_ONCE = 4;
/** Limits each request so pages with many queries leave room for others. */
export const QUERIES_PER_REQUEST = 2;
/** Sparklines share this cap across requests, leaving capacity for lists, charts, and Overview. */
export const SPARKLINE_PLACES = 1;
export const QUEUE_WAIT_MS = 10_000;

/** Queue timeout, returned as HTTP 503. */
export class DashboardBusyError extends Error {
  override name = "DashboardBusyError";
}

interface Waiter {
  start: () => void;
}

export class DashboardQueryLimiter {
  readonly #max: number;
  readonly #waitMs: number;
  #running = 0;
  readonly #waiting: Waiter[] = [];

  constructor({ max = QUERIES_AT_ONCE, waitMs = QUEUE_WAIT_MS } = {}) {
    this.#max = max;
    this.#waitMs = waitMs;
  }

  get running(): number {
    return this.#running;
  }

  /** Waits up to `waitMs` for a slot. Waiting aborts when `signal` fires. */
  async run<T>(work: () => Promise<T>, signal?: AbortSignal, waitMs = this.#waitMs): Promise<T> {
    await this.#acquire(signal, waitMs);
    try {
      return await work();
    } finally {
      this.#release();
    }
  }

  /**
   * Limits running and queued queries to `perRequest`; the rest wait within the request. All abort
   * on `signal`.
   */
  gate(signal?: AbortSignal, perRequest = QUERIES_PER_REQUEST, waitMs = this.#waitMs) {
    let held = 0;
    const turns: (() => void)[] = [];
    const turn = () =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(signal.reason);
          return;
        }
        if (held < perRequest) {
          held += 1;
          resolve();
          return;
        }
        const aborted = () => {
          turns.splice(turns.indexOf(start), 1);
          reject(signal?.reason);
        };
        const start = () => {
          signal?.removeEventListener("abort", aborted);
          resolve();
        };
        signal?.addEventListener("abort", aborted, { once: true });
        turns.push(start);
      });
    return async <T>(work: () => Promise<T>): Promise<T> => {
      await turn();
      try {
        return await this.run(work, signal, waitMs);
      } finally {
        const next = turns.shift();
        if (next === undefined) held -= 1;
        else next();
      }
    };
  }

  #acquire(signal: AbortSignal | undefined, waitMs: number): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(signal.reason);
    if (this.#running < this.#max) {
      this.#running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const queue = this.#waiting;
      const leave = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        const at = queue.indexOf(waiter);
        if (at !== -1) queue.splice(at, 1);
      };
      const waiter: Waiter = {
        // #release already counted this slot.
        start: () => {
          leave();
          resolve();
        },
      };
      const timer = setTimeout(() => {
        leave();
        reject(new DashboardBusyError("too many dashboard queries at once"));
      }, waitMs);
      const aborted = () => {
        leave();
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", aborted, { once: true });
      queue.push(waiter);
    });
  }

  #release() {
    const next = this.#waiting[0];
    if (next !== undefined) {
      next.start();
      return;
    }
    this.#running = Math.max(0, this.#running - 1);
  }
}

/**
 * Limits each request to QUERIES_PER_REQUEST queries. Closing the response aborts running and
 * queued work.
 */
export function dashboardReader(
  clickhouse: ClickHouseClient,
  limiter: DashboardQueryLimiter,
  reply: {
    raw: { writableFinished: boolean; once: (event: "close", listener: () => void) => unknown };
  },
  /**
   * Acquires this pool before `limiter`, limiting how many dashboard slots this request type can
   * use.
   */
  share?: DashboardQueryLimiter,
  /** Defaults to the limiter's wait time. */
  waitMs?: number,
): Reader {
  const controller = new AbortController();
  // A closed response, including a 503, aborts sibling queries and frees their slots.
  reply.raw.once("close", () => controller.abort());
  const gate = limiter.gate(
    controller.signal,
    share === undefined ? QUERIES_PER_REQUEST : 1,
    waitMs,
  );
  return {
    client: clickhouse,
    signal: controller.signal,
    gate:
      share === undefined
        ? gate
        : <T>(work: () => Promise<T>) => share.run(() => gate(work), controller.signal),
  };
}

/**
 * Reserves at most 1 of 4 slots for live polls and 1 for sparklines, leaving 2 for lists, charts,
 * and Overview (LIST_PLACES).
 */
export const LIVE_QUERIES_AT_ONCE = 1;
export const LIST_PLACES = QUERIES_AT_ONCE - SPARKLINE_PLACES - LIVE_QUERIES_AT_ONCE;
/** Short wait because the page retries on its next poll. */
export const LIVE_QUEUE_WAIT_MS = 2000;

export const liveQueryLimiter = () =>
  new DashboardQueryLimiter({ max: LIVE_QUERIES_AT_ONCE, waitMs: LIVE_QUEUE_WAIT_MS });

/**
 * Acquires the live pool before the dashboard pool. Each wait is bounded separately; a 503 is
 * retried on the next poll.
 */
export function liveReader(
  clickhouse: ClickHouseClient,
  limiter: DashboardQueryLimiter,
  live: DashboardQueryLimiter,
  reply: Parameters<typeof dashboardReader>[2],
  mainWaitMs = LIVE_QUEUE_WAIT_MS,
): Reader {
  return dashboardReader(clickhouse, limiter, reply, live, mainWaitMs);
}
