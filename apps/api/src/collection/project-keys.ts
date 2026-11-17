import type { Kysely } from "kysely";

import type { Database } from "../db/schema.ts";

export const PUBLIC_KEY_PATTERN = "^pk_[0-9a-f]{32}$";

export interface CollectingProject {
  id: string;
  allowedHostnames: string[];
  /** Its organization's timezone, whose midnight starts a new visitor salt. */
  timeZone: string;
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
 * checked first, bounds it. Changes to a project's allowed hostnames take
 * effect within the cache lifetime; a replaced key, a deleted project, or a
 * new timezone at once in this process, because the project and
 * organization routes call forget().
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
      .innerJoin("organizations", "organizations.id", "projects.organization_id")
      .select(["projects.id", "projects.allowed_hostnames", "organizations.time_zone"])
      .where("projects.public_key", "=", publicKey)
      .executeTakeFirst();
    const project =
      row === undefined
        ? null
        : { id: row.id, allowedHostnames: row.allowed_hostnames, timeZone: row.time_zone };

    this.#entries.delete(publicKey);
    this.#entries.set(publicKey, { project, expiresAt: now + this.#ttlMs });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return project;
  }

  /** Drops a key, so its next request reads the database: after a key is replaced, its project deleted, or its timezone changed. */
  forget(publicKey: string) {
    this.#entries.delete(publicKey);
  }
}
