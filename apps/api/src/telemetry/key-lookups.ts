import type { CollectingProject, ProjectKeyCache } from "../collection/project-keys.ts";

/** Secret-key lookups of keys not yet known to be real that may run at once. */
export const DEFAULT_MAX_KEY_LOOKUPS = 4;
/** Of those, the most that may wait for a place, in order. */
export const DEFAULT_MAX_WAITING_LOOKUPS = 1000;
/** Real keys remembered, so their lookups never wait. */
const MAX_KNOWN_KEYS = 1000;

/** The lookup cannot be taken now: the answer is 503. */
export const BUSY = Symbol("busy");

/**
 * Bounds the secret-key lookups of OTLP and POST /api/ai-calls, which run
 * before any other limit but the address's. Each lookup of a key the
 * cache lacks is a query on the PostgreSQL pool the dashboard shares, so
 * keys not yet seen to belong to a project take one of a few places; the
 * rest wait their turn. One address (an IPv6 address by its /64) has at
 * most one lookup running or waiting, so a flood of made-up keys needs many
 * addresses, and a real exporter waits behind at most one lookup of each.
 * Requests with the same key share its lookup. A key seen to be real
 * skips all this.
 */
export class SecretKeyLookups {
  readonly #max: number;
  readonly #maxWaiting: number;
  #running = 0;
  readonly #waiting: (() => void)[] = [];
  /** Addresses with a lookup running or waiting. */
  readonly #addresses = new Set<string>();
  /** In the order last found, oldest first. */
  readonly #known = new Set<string>();
  /** Lookups running or waiting, by key. */
  readonly #pending = new Map<string, Promise<CollectingProject | null>>();

  constructor(max = DEFAULT_MAX_KEY_LOOKUPS, maxWaiting = DEFAULT_MAX_WAITING_LOOKUPS) {
    this.#max = max;
    this.#maxWaiting = maxWaiting;
  }

  /** Lookups waiting for a place. */
  get waiting(): number {
    return this.#waiting.length;
  }

  /** `address` is the client's, as the rate limiter keys it (clientKey). */
  async find(
    projects: ProjectKeyCache,
    secretKey: string,
    address: string,
  ): Promise<CollectingProject | null | typeof BUSY> {
    if (this.#known.has(secretKey)) return this.#remember(secretKey, projects);
    const pending = this.#pending.get(secretKey);
    if (pending !== undefined) return pending;
    if (this.#addresses.has(address)) return BUSY;
    if (this.#running >= this.#max && this.#waiting.length >= this.#maxWaiting) return BUSY;
    const lookup = this.#queued(projects, secretKey, address);
    this.#pending.set(secretKey, lookup);
    try {
      return await lookup;
    } finally {
      this.#pending.delete(secretKey);
    }
  }

  async #queued(
    projects: ProjectKeyCache,
    secretKey: string,
    address: string,
  ): Promise<CollectingProject | null> {
    this.#addresses.add(address);
    try {
      if (this.#running < this.#max) {
        this.#running += 1;
      } else {
        // The place is handed over by the lookup that ends (below).
        await new Promise<void>((resolve) => {
          this.#waiting.push(resolve);
        });
      }
      try {
        return await this.#remember(secretKey, projects);
      } finally {
        const next = this.#waiting.shift();
        if (next === undefined) this.#running -= 1;
        else next();
      }
    } finally {
      this.#addresses.delete(address);
    }
  }

  async #remember(secretKey: string, projects: ProjectKeyCache) {
    const project = await projects.findBySecret(secretKey);
    this.#known.delete(secretKey);
    if (project === null) return null;
    this.#known.add(secretKey);
    if (this.#known.size > MAX_KNOWN_KEYS) {
      const oldest = this.#known.values().next().value;
      if (oldest !== undefined) this.#known.delete(oldest);
    }
    return project;
  }
}
