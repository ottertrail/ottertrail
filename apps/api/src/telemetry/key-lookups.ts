import type { CollectingProject, ProjectKeyCache } from "../collection/project-keys.ts";

/** Secret-key lookups of keys not yet known to be real that may wait on the database at once. */
export const DEFAULT_MAX_KEY_LOOKUPS = 4;
/** Real keys remembered, so their lookups never wait for a place. */
const MAX_KNOWN_KEYS = 1000;

/** Too many lookups are in progress: the answer is 503. */
export const BUSY = Symbol("busy");

/**
 * Bounds the secret-key lookups of OTLP and POST /api/ai-calls, which run
 * before any other limit but the address's. A flood of made-up keys
 * misses the key cache each time, and each miss is a query on the
 * PostgreSQL pool the dashboard shares, so keys not yet seen to belong to a
 * project share a few places. A key that has is most likely cached, and
 * skips them, so a flood never keeps real exporters out.
 */
export class SecretKeyLookups {
  readonly #max: number;
  #inProgress = 0;
  /** In the order last found, oldest first. */
  readonly #known = new Set<string>();

  constructor(max = DEFAULT_MAX_KEY_LOOKUPS) {
    this.#max = max;
  }

  async find(
    projects: ProjectKeyCache,
    secretKey: string,
  ): Promise<CollectingProject | null | typeof BUSY> {
    if (this.#known.has(secretKey)) return this.#remember(secretKey, projects);
    if (this.#inProgress >= this.#max) return BUSY;
    this.#inProgress += 1;
    try {
      return await this.#remember(secretKey, projects);
    } finally {
      this.#inProgress -= 1;
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

/** The process's, shared by both routes unless their options give another. */
export const secretKeyLookups = new SecretKeyLookups();
