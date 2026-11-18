/**
 * At most a few of one organization's telemetry dashboard queries run at
 * once on this process (docs/telemetry.md, "How the pages read"), so one
 * customer's pages cannot fill ClickHouse for the others. A query past the
 * limit waits for a free place; one that waits too long is refused, and the
 * route answers 503 with Retry-After.
 */

/** Queries of one organization in flight on one process. */
export const QUERIES_PER_ORGANIZATION = 4;
/** How long a query waits for a place before it is refused. */
export const QUEUE_WAIT_MS = 10_000;

/** A query that waited QUEUE_WAIT_MS without a place: the route answers 503. */
export class DashboardBusyError extends Error {
  override name = "DashboardBusyError";
}

interface Waiter {
  start: () => void;
}

export class OrganizationLimiter {
  readonly #max: number;
  readonly #waitMs: number;
  readonly #running = new Map<string, number>();
  readonly #waiting = new Map<string, Waiter[]>();

  constructor({ max = QUERIES_PER_ORGANIZATION, waitMs = QUEUE_WAIT_MS } = {}) {
    this.#max = max;
    this.#waitMs = waitMs;
  }

  /** Queries of the organization running now. */
  running(organizationId: string): number {
    return this.#running.get(organizationId) ?? 0;
  }

  /** Runs `work` once the organization has a place; refuses after waiting too long, or when `signal` fires. */
  async run<T>(organizationId: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.#acquire(organizationId, signal);
    try {
      return await work();
    } finally {
      this.#release(organizationId);
    }
  }

  /** A gate for a Reader: every query it runs takes a place of the organization's. */
  gate(organizationId: string, signal?: AbortSignal) {
    return <T>(work: () => Promise<T>) => this.run(organizationId, work, signal);
  }

  #acquire(organizationId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(signal.reason);
    const running = this.running(organizationId);
    if (running < this.#max) {
      this.#running.set(organizationId, running + 1);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const queue = this.#waiting.get(organizationId) ?? [];
      const leave = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        const at = queue.indexOf(waiter);
        if (at !== -1) queue.splice(at, 1);
        if (queue.length === 0) this.#waiting.delete(organizationId);
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
        reject(new DashboardBusyError("too many queries of this organization at once"));
      }, this.#waitMs);
      const aborted = () => {
        leave();
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", aborted, { once: true });
      queue.push(waiter);
      this.#waiting.set(organizationId, queue);
    });
  }

  #release(organizationId: string) {
    const next = this.#waiting.get(organizationId)?.[0];
    if (next !== undefined) {
      // The place passes straight to the first waiting query.
      next.start();
      return;
    }
    const running = this.running(organizationId) - 1;
    if (running <= 0) this.#running.delete(organizationId);
    else this.#running.set(organizationId, running);
  }
}
