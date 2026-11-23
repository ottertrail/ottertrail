import type { FastifyReply, FastifyRequest } from "fastify";

import type { CollectingProject, ProjectKeyCache } from "../collection/project-keys.ts";
import { clientKey } from "../collection/rate-limiter.ts";

/** Concurrent uncached secret-key lookups. */
export const DEFAULT_MAX_KEY_LOOKUPS = 4;
export const DEFAULT_MAX_WAITING_LOOKUPS = 1000;
/** Allows a NAT or gateway Collector to send several projects' keys. */
export const DEFAULT_MAX_LOOKUPS_PER_ADDRESS = 2;
/** Queue timeouts return 503. */
export const DEFAULT_MAX_LOOKUP_WAIT_MS = 5000;

/** Returned as HTTP 503. */
export const BUSY = Symbol("busy");

type Found = CollectingProject | null | typeof BUSY;

interface Lookup {
  address: string;
  /** Only share lookups within the same cache generation. */
  generation: number;
  /** Connected requests sharing this lookup. */
  sharers: number;
  result: Promise<Found>;
  /** Releases a queued slot and answers BUSY. */
  cancel: (() => void) | null;
}

export interface KeyLookupLimits {
  max?: number;
  maxWaiting?: number;
  maxPerAddress?: number;
  maxWaitMs?: number;
}

/**
 * Shared by OTLP and POST /api/ai-calls (app.ts). Cache misses use the dashboard's PostgreSQL
 * pool, so bound concurrency and queue time. Cached keys, including known misses, return immediately. Each
 * address (IPv6 /64) may hold two running or queued lookups, limiting made-up keys from one
 * sender. Requests sharing a key share its lookup; queued lookups release their turn when all
 * requests disconnect.
 */
export class SecretKeyLookups {
  readonly #max: number;
  readonly #maxWaiting: number;
  readonly #maxPerAddress: number;
  readonly #maxWaitMs: number;
  #running = 0;
  /** true starts the lookup; false cancels it. */
  readonly #waiting: ((start: boolean) => void)[] = [];
  readonly #addresses = new Map<string, number>();
  readonly #pending = new Map<string, Lookup>();

  constructor(limits: KeyLookupLimits = {}) {
    this.#max = limits.max ?? DEFAULT_MAX_KEY_LOOKUPS;
    this.#maxWaiting = limits.maxWaiting ?? DEFAULT_MAX_WAITING_LOOKUPS;
    this.#maxPerAddress = limits.maxPerAddress ?? DEFAULT_MAX_LOOKUPS_PER_ADDRESS;
    this.#maxWaitMs = limits.maxWaitMs ?? DEFAULT_MAX_LOOKUP_WAIT_MS;
  }

  get waiting(): number {
    return this.#waiting.length;
  }

  /**
   * Returns project, null for unknown keys, or BUSY. Use clientKey for `address`; `gone` signals
   * disconnection.
   */
  async find(
    projects: ProjectKeyCache,
    secretKey: string,
    address: string,
    gone?: AbortSignal,
  ): Promise<Found> {
    if (gone?.aborted === true) return BUSY;
    const cached = projects.peekSecret(secretKey);
    if (cached !== undefined) return cached;
    let lookup = this.#pending.get(secretKey);
    // A previous cache generation may return stale keys; start a fresh lookup.
    if (lookup !== undefined && lookup.generation !== projects.generation) lookup = undefined;
    if (lookup === undefined) {
      if ((this.#addresses.get(address) ?? 0) >= this.#maxPerAddress) return BUSY;
      if (this.#running >= this.#max && this.#waiting.length >= this.#maxWaiting) return BUSY;
      lookup = this.#start(projects, secretKey, address);
    }
    const shared = lookup;
    shared.sharers += 1;
    const leave = () => {
      shared.sharers -= 1;
      if (shared.sharers === 0) shared.cancel?.();
    };
    gone?.addEventListener("abort", leave, { once: true });
    try {
      return await shared.result;
    } finally {
      gone?.removeEventListener("abort", leave);
    }
  }

  /** Releases a queued turn if the request disconnects. */
  async findFor(
    projects: ProjectKeyCache,
    secretKey: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Found> {
    const gone = new AbortController();
    const disconnected = () => {
      gone.abort();
    };
    reply.raw.once("close", disconnected);
    // The close event may have fired before the listener was attached.
    if (reply.raw.destroyed) gone.abort();
    try {
      return await this.find(projects, secretKey, clientKey(request.ip), gone.signal);
    } finally {
      reply.raw.off("close", disconnected);
    }
  }

  #start(projects: ProjectKeyCache, secretKey: string, address: string): Lookup {
    const lookup: Lookup = {
      address,
      generation: projects.generation,
      sharers: 0,
      result: Promise.resolve(BUSY),
      cancel: null,
    };
    this.#addresses.set(address, (this.#addresses.get(address) ?? 0) + 1);
    this.#pending.set(secretKey, lookup);
    lookup.result = (async (): Promise<Found> => {
      try {
        if (this.#running < this.#max) this.#running += 1;
        else if (!(await this.#turn(lookup))) return BUSY;
        try {
          return await projects.findBySecret(secretKey);
        } finally {
          const next = this.#waiting.shift();
          if (next === undefined) this.#running -= 1;
          else next(true);
        }
      } finally {
        const left = (this.#addresses.get(address) ?? 1) - 1;
        if (left === 0) this.#addresses.delete(address);
        else this.#addresses.set(address, left);
        if (this.#pending.get(secretKey) === lookup) this.#pending.delete(secretKey);
      }
    })();
    return lookup;
  }

  /** Returns false on timeout or when all sharing requests disconnect. */
  async #turn(lookup: Lookup): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = await new Promise<boolean>((resolve) => {
      const giveUp = () => {
        const at = this.#waiting.indexOf(resolve);
        if (at !== -1) this.#waiting.splice(at, 1);
        resolve(false);
      };
      this.#waiting.push(resolve);
      lookup.cancel = giveUp;
      timer = setTimeout(giveUp, this.#maxWaitMs);
      timer.unref();
    });
    clearTimeout(timer);
    lookup.cancel = null;
    return started;
  }
}
