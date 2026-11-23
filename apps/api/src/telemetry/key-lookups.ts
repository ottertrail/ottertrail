import type { FastifyReply, FastifyRequest } from "fastify";

import type { CollectingProject, ProjectKeyCache } from "../collection/project-keys.ts";
import { clientKey } from "../collection/rate-limiter.ts";

/** Lookups of secret keys the cache lacks that may run at once. */
export const DEFAULT_MAX_KEY_LOOKUPS = 4;
/** Of those, the most that may wait for a place, in order. */
export const DEFAULT_MAX_WAITING_LOOKUPS = 1000;
/** Lookups one address may have running or waiting: a NAT or a gateway Collector sends several projects' keys. */
export const DEFAULT_MAX_LOOKUPS_PER_ADDRESS = 2;
/** How long a lookup may wait for a place before its requests get 503. */
export const DEFAULT_MAX_LOOKUP_WAIT_MS = 5000;

/** The lookup cannot be taken now: the answer is 503. */
export const BUSY = Symbol("busy");

type Found = CollectingProject | null | typeof BUSY;

interface Lookup {
  address: string;
  /** The cache's generation when it started: shared only within it. */
  generation: number;
  /** Requests waiting on it that have not disconnected. */
  sharers: number;
  result: Promise<Found>;
  /** While it waits for a place: gives the place up, answering BUSY. */
  cancel: (() => void) | null;
}

export interface KeyLookupLimits {
  max?: number;
  maxWaiting?: number;
  maxPerAddress?: number;
  maxWaitMs?: number;
}

/**
 * Bounds the secret-key lookups of OTLP and POST /api/ai-calls together
 * (one instance per app, app.ts), which run before any other limit but the
 * address's. A key the cache holds, a project's or none, is answered at
 * once. Any other is a query on the PostgreSQL pool the dashboard shares,
 * so such lookups take one of a few places and the rest wait their turn,
 * for a few seconds at most. One address (an IPv6 address by its /64) has
 * at most two running or waiting, so a flood of made-up keys needs many
 * addresses, and a real exporter waits behind at most two lookups of each.
 * Requests with the same key share its lookup; a waiting lookup whose
 * requests have all disconnected gives up its turn.
 */
export class SecretKeyLookups {
  readonly #max: number;
  readonly #maxWaiting: number;
  readonly #maxPerAddress: number;
  readonly #maxWaitMs: number;
  #running = 0;
  /** Lookups waiting for a place: each starts when given one (true) or gives up (false). */
  readonly #waiting: ((start: boolean) => void)[] = [];
  /** Lookups running or waiting, by address. */
  readonly #addresses = new Map<string, number>();
  /** Lookups running or waiting, by key. */
  readonly #pending = new Map<string, Lookup>();

  constructor(limits: KeyLookupLimits = {}) {
    this.#max = limits.max ?? DEFAULT_MAX_KEY_LOOKUPS;
    this.#maxWaiting = limits.maxWaiting ?? DEFAULT_MAX_WAITING_LOOKUPS;
    this.#maxPerAddress = limits.maxPerAddress ?? DEFAULT_MAX_LOOKUPS_PER_ADDRESS;
    this.#maxWaitMs = limits.maxWaitMs ?? DEFAULT_MAX_LOOKUP_WAIT_MS;
  }

  /** Lookups waiting for a place. */
  get waiting(): number {
    return this.#waiting.length;
  }

  /**
   * The key's project, null for none, or BUSY. `address` is the client's,
   * as the rate limiter keys it (clientKey); `gone` aborts when the
   * request disconnects.
   */
  async find(
    projects: ProjectKeyCache,
    secretKey: string,
    address: string,
    gone?: AbortSignal,
  ): Promise<Found> {
    // Gone already: no lookup, and no place taken.
    if (gone?.aborted === true) return BUSY;
    const cached = projects.peekSecret(secretKey);
    if (cached !== undefined) return cached;
    let lookup = this.#pending.get(secretKey);
    // One started before keys were forgotten may answer with an old row: start another.
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

  /** find() for a request: by its address, giving up its turn if it disconnects. */
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
    // Closed before the listener was added: its close has already fired.
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
          // The place goes to the next waiting lookup, or is given back.
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

  /** Waits for a place: true when given one, false past the wait or once every request left. */
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
