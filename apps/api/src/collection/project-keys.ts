import type { Kysely } from "kysely";

import type { Database } from "../db/schema.ts";

export const PUBLIC_KEY_PATTERN = "^pk_[0-9a-f]{32}$";
export const SECRET_KEY_PATTERN = "^sk_[0-9a-f]{32}$";

export interface CollectingProject {
  id: string;
  /** Its organization, whose event budget its own sits inside. */
  organizationId: string;
  allowedHostnames: string[];
  /** Its organization's timezone, whose midnight starts a new visitor salt. */
  timeZone: string;
  /** Signs user IDs (collection/identity.ts). */
  secretKey: string;
  /** Accept a browser's user ID only with a valid signature. */
  requireSignedUserIds: boolean;
  /** Ignore browser events from data centers (enrichment/data-centers.ts). */
  ignoreDataCenters: boolean;
}

interface CacheEntry {
  project: CollectingProject | null;
  expiresAt: number;
}

/**
 * Looks up projects by public key (browsers) or secret key (servers), with
 * a short in-memory cache.
 *
 * Every event request carries a key, so without a cache each request would
 * cost a database query. Unknown keys are cached too ("negative caching"),
 * so repeating a made-up key costs one query per cache lifetime. A stream of
 * different made-up keys still costs a query each; the per-IP rate limit,
 * checked first, bounds it. Changes to a project's allowed hostnames take
 * effect within the cache lifetime; a replaced key, a deleted project, or a
 * new timezone at once in this process, because the project and
 * organization routes call forget(). A lookup still running when they do
 * answers its own request but is not cached: it may have read the old row.
 */
export class ProjectKeyCache {
  readonly #db: Kysely<Database>;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, CacheEntry>();
  readonly #bySecret = new Map<string, CacheEntry>();
  /** Counts forget() calls: a lookup that spans one does not cache its result. */
  #forgotten = 0;

  constructor(
    db: Kysely<Database>,
    options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
  ) {
    this.#db = db;
    this.#ttlMs = options.ttlMs ?? 60_000;
    this.#maxEntries = options.maxEntries ?? 1_000;
    this.#now = options.now ?? Date.now;
  }

  /** The project with this public key, the one in a page's script tag. */
  find(publicKey: string): Promise<CollectingProject | null> {
    return this.#lookup(this.#entries, "public_key", publicKey);
  }

  /** The project with this secret key, the one a site's server sends events with. */
  findBySecret(secretKey: string): Promise<CollectingProject | null> {
    return this.#lookup(this.#bySecret, "secret_key", secretKey);
  }

  async #lookup(
    entries: Map<string, CacheEntry>,
    column: "public_key" | "secret_key",
    key: string,
  ): Promise<CollectingProject | null> {
    const now = this.#now();
    const cached = entries.get(key);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.project;
    }
    const forgotten = this.#forgotten;

    const row = await this.#db
      .selectFrom("projects")
      .innerJoin("organizations", "organizations.id", "projects.organization_id")
      .select([
        "projects.id",
        "projects.organization_id",
        "projects.allowed_hostnames",
        "projects.secret_key",
        "projects.require_signed_user_ids",
        "projects.ignore_data_centers",
        "organizations.time_zone",
      ])
      .where(`projects.${column}`, "=", key)
      .executeTakeFirst();
    const project =
      row === undefined
        ? null
        : {
            id: row.id,
            organizationId: row.organization_id,
            allowedHostnames: row.allowed_hostnames,
            timeZone: row.time_zone,
            secretKey: row.secret_key,
            requireSignedUserIds: row.require_signed_user_ids,
            ignoreDataCenters: row.ignore_data_centers,
          };

    if (forgotten !== this.#forgotten) return project;
    entries.delete(key);
    entries.set(key, { project, expiresAt: now + this.#ttlMs });
    while (entries.size > this.#maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    return project;
  }

  /** Drops a key, so its next request reads the database: after a key is replaced, its project deleted, or its timezone changed. */
  forget(publicKey: string) {
    this.#forgotten += 1;
    this.#entries.delete(publicKey);
  }

  /**
   * Drops everything cached about one project, under either key: after its
   * secret key is replaced, a collection setting changed, or it is deleted.
   */
  forgetProject(projectId: string) {
    this.#forgotten += 1;
    for (const entries of [this.#entries, this.#bySecret]) {
      for (const [key, entry] of entries) {
        if (entry.project?.id === projectId) entries.delete(key);
      }
    }
  }
}
