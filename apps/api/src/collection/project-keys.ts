import type { Kysely } from "kysely";

import type { Database } from "../db/schema.ts";

export const PUBLIC_KEY_PATTERN = "^pk_[0-9a-f]{32}$";

export interface CollectingProject {
  id: string;
  allowedHostnames: string[];
}

interface CacheEntry {
  project: CollectingProject | null;
  expiresAt: number;
}

/**
 * Looks up projects by public key, with a short in-memory cache.
 *
 * Every event request carries a key, so without a cache each request would
 * cost a database query. Unknown keys are cached too ("negative caching"),
 * so repeating a made-up key costs one query per cache lifetime. A stream of
 * different made-up keys still costs a query each; the per-IP rate limit,
 * checked first, bounds it. Changes to
 * a project (new allowed hostname, removed project) take effect within the
 * cache lifetime.
 */
export class ProjectKeyCache {
  readonly #db: Kysely<Database>;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, CacheEntry>();

  constructor(
    db: Kysely<Database>,
    options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
  ) {
    this.#db = db;
    this.#ttlMs = options.ttlMs ?? 60_000;
    this.#maxEntries = options.maxEntries ?? 1_000;
    this.#now = options.now ?? Date.now;
  }

  async find(publicKey: string): Promise<CollectingProject | null> {
    const now = this.#now();
    const cached = this.#entries.get(publicKey);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.project;
    }

    const row = await this.#db
      .selectFrom("projects")
      .select(["id", "allowed_hostnames"])
      .where("public_key", "=", publicKey)
      .executeTakeFirst();
    const project =
      row === undefined ? null : { id: row.id, allowedHostnames: row.allowed_hostnames };

    this.#entries.delete(publicKey);
    this.#entries.set(publicKey, { project, expiresAt: now + this.#ttlMs });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return project;
  }
}
