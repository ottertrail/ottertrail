import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import type { Reader } from "../clickhouse/query.ts";

/**
 * At most a few of the dashboard's telemetry and uptime queries run at once
 * on this process (docs/telemetry.md, "How the pages read"), so the pages
 * cannot fill ClickHouse, which also stores events and telemetry as they
 * arrive. A query past the limit waits for a free place; one that waits too
 * long is refused, and the route answers 503 with Retry-After.
 */

/** Dashboard queries in flight on one process. */
export const QUERIES_AT_ONCE = 4;
/**
 * Places one request may hold at once: a page that makes many queries,
 * such as a host's, leaves room for the other pages open.
 */
export const QUERIES_PER_REQUEST = 2;
/**
 * Of QUERIES_AT_ONCE, the places the Metrics list's sparklines may hold at
 * once, all requests together: the lists, charts, and the Overview never
 * wait behind a page of sparklines for more than this.
 */
export const SPARKLINE_PLACES = 1;
/** How long a query waits for a place before it is refused. */
export const QUEUE_WAIT_MS = 10_000;

/** A query that waited QUEUE_WAIT_MS without a place: the route answers 503. */
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

  /** Queries running now. */
  get running(): number {
    return this.#running;
  }

  /**
   * Runs `work` once a place is free; refuses after waiting too long
   * (`waitMs`, the limiter's own by default), or when `signal` fires.
   */
  async run<T>(work: () => Promise<T>, signal?: AbortSignal, waitMs = this.#waitMs): Promise<T> {
    await this.#acquire(signal, waitMs);
    try {
      return await work();
    } finally {
      this.#release();
    }
  }

  /**
   * A gate for one request's Reader: every query it runs takes one of the
   * places, and at most `perRequest` run or wait for one at once; the rest
   * wait their turn within the request. All end when `signal` fires.
   */
  gate(signal?: AbortSignal, perRequest = QUERIES_PER_REQUEST, waitMs = this.#waitMs) {
    let held = 0;
    const turns: (() => void)[] = [];
    /** A place among the request's: at once when one is free, else when one is handed on. */
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
        // The place passes straight to the request's next query, if one waits.
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
        // #release has already counted the place as this query's.
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
      // The place passes straight to the first waiting query.
      next.start();
      return;
    }
    this.#running = Math.max(0, this.#running - 1);
  }
}

/**
 * Where a dashboard request's queries run (the telemetry and uptime
 * pages): each waits for one of the process's places
 * (DashboardQueryLimiter), at most QUERIES_PER_REQUEST of them at once, and
 * all end when the request is closed or answered, as when the browser
 * gives up or one query failed.
 */
export function dashboardReader(
  clickhouse: ClickHouseClient,
  limiter: DashboardQueryLimiter,
  reply: {
    raw: { writableFinished: boolean; once: (event: "close", listener: () => void) => unknown };
  },
  /**
   * A smaller pool the request's queries take a place of first, before
   * one of `limiter`'s, one at a time: a kind of request (the sparklines)
   * then holds at most that pool's size of `limiter`'s places.
   */
  share?: DashboardQueryLimiter,
  /** How long a query waits for one of `limiter`'s places: the limiter's own by default. */
  waitMs?: number,
): Reader {
  const controller = new AbortController();
  // Once the answer is sent or the request is gone, nothing more is
  // needed: a failed query's 503 also ends the request's other queries,
  // running or waiting, so they free their places.
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
 * Places the Logs page's live view may hold at once on one process, of
 * QUERIES_AT_ONCE: its polls come every few seconds from every page
 * watching, and must not crowd out the other pages' queries. With the
 * sparklines' SPARKLINE_PLACES, the split of the 4 places is: at most 1
 * for sparklines, at most 1 for live polls, and so at least 2 always free
 * for the lists, charts, and the Overview (LIST_PLACES).
 */
export const LIVE_QUERIES_AT_ONCE = 1;
/** The places neither the sparklines nor the live polls can take. */
export const LIST_PLACES = QUERIES_AT_ONCE - SPARKLINE_PLACES - LIVE_QUERIES_AT_ONCE;
/**
 * How long a live poll waits for its place before it is refused (503): a
 * short wait, since the page asks again at its next poll anyway.
 */
export const LIVE_QUEUE_WAIT_MS = 2000;

/** The live view's own pool, in front of the dashboard's (liveReader). */
export const liveQueryLimiter = () =>
  new DashboardQueryLimiter({ max: LIVE_QUERIES_AT_ONCE, waitMs: LIVE_QUEUE_WAIT_MS });

/**
 * Where a live poll's queries run: each first takes the live view's place
 * (`live`, one a process), then one of the dashboard's places, as the
 * sparklines' do (dashboardReader's `share`); so live polls hold at most
 * LIVE_QUERIES_AT_ONCE of the dashboard's places at a time. Each wait is
 * short, LIVE_QUEUE_WAIT_MS for the live place and as long again for the
 * dashboard's (`mainWaitMs`): a poll refused (503) is asked again at the
 * page's next poll.
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
