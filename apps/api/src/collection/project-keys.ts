import type { BlockList } from "node:net";

import type { Kysely } from "kysely";

import type { Database } from "../db/schema.ts";
import { blockListOf } from "../projects/blocked-addresses.ts";

export const PUBLIC_KEY_PATTERN = "^pk_[0-9a-f]{32}$";
export const SECRET_KEY_PATTERN = "^sk_[0-9a-f]{32}$";

export interface CollectingProject {
  id: string;
  allowedHostnames: string[];
  /** Signs user IDs (collection/identity.ts). */
  secretKey: string;
  /** Accept a browser's user ID only with a valid signature. */
  requireSignedUserIds: boolean;
  /** Ignore browser events from data centers (enrichment/data-centers.ts). */
  ignoreDataCenters: boolean;
  /** Session replays: "off", or "errors", recorded around errors (docs/session-replay.md). */
  replayMode: "off" | "errors";
  /** Heatmaps: whether heatmap batches are taken (docs/web-analytics.md, "Heatmaps"). */
  heatmaps: boolean;
  /** Built once per project load (projects/blocked-addresses.ts); null for none. */
  blocked: BlockList | null;
  /** The project's blocked referrer domains (projects/blocked-referrers.ts), as a set; null for none. */
  blockedReferrers: ReadonlySet<string> | null;
}

interface CacheEntry {
  project: CollectingProject | null;
  expiresAt: number;
}

/**
 * Caches known and unknown keys to limit database lookups. The per-IP limit bounds
 * lookups for distinct unknown keys. Hostname changes take effect within the cache
 * lifetime; forget() invalidates replaced or deleted keys immediately in this process.
 * In-flight lookups still answer their request but cannot cache a possibly stale row.
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

  find(publicKey: string): Promise<CollectingProject | null> {
    return this.#lookup(this.#entries, "public_key", publicKey);
  }

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
      .select([
        "projects.id",
        "projects.allowed_hostnames",
        "projects.secret_key",
        "projects.require_signed_user_ids",
        "projects.ignore_data_centers",
        "projects.replay_mode",
        "projects.heatmaps",
        "projects.blocked_addresses",
        "projects.blocked_referrers",
      ])
      .where(`projects.${column}`, "=", key)
      .executeTakeFirst();
    const project =
      row === undefined
        ? null
        : {
            id: row.id,
            allowedHostnames: row.allowed_hostnames,
            secretKey: row.secret_key,
            requireSignedUserIds: row.require_signed_user_ids,
            ignoreDataCenters: row.ignore_data_centers,
            replayMode: row.replay_mode,
            heatmaps: row.heatmaps,
            blocked: blockListOf(row.blocked_addresses),
            blockedReferrers:
              row.blocked_referrers.length === 0 ? null : new Set(row.blocked_referrers),
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

  /** Invalidate replaced or deleted keys before the next request. */
  forget(publicKey: string) {
    this.#forgotten += 1;
    this.#entries.delete(publicKey);
  }

  /** Invalidate both keys after project deletion, secret-key rotation, or collection changes. */
  forgetProject(projectId: string) {
    this.#forgotten += 1;
    for (const entries of [this.#entries, this.#bySecret]) {
      for (const [key, entry] of entries) {
        if (entry.project?.id === projectId) entries.delete(key);
      }
    }
  }
}
