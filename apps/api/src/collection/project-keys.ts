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

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** Entries in insertion order, refreshed on a hit: the least recently used goes first. */
class LruMap<T> {
  readonly #entries = new Map<string, CacheEntry<T>>();
  readonly #max: number;

  constructor(max: number) {
    this.#max = max;
  }

  get(key: string, now: number): T | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    this.#entries.delete(key);
    if (entry.expiresAt <= now) return undefined;
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, expiresAt: number): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt });
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  deleteWhere(matches: (value: T) => boolean): void {
    for (const [key, entry] of this.#entries) {
      if (matches(entry.value)) this.#entries.delete(key);
    }
  }
}

/** One kind of key: its projects, the keys no project has, and the lookups under way. */
interface KeyTable {
  known: LruMap<CollectingProject>;
  unknown: LruMap<true>;
  pending: Map<string, Promise<CollectingProject | null>>;
}

/**
 * Caches keys to limit database lookups. Known keys are kept apart from
 * keys no project has, so a stream of made-up keys cannot push real
 * projects out; both are least recently used first. Concurrent misses for
 * one key share one query. Hostname changes take effect within the cache
 * lifetime; forget() and forgetProject() invalidate keys at once in this
 * process. A lookup under way when they are called still answers its
 * request, but its row is not cached or shared with later requests.
 */
export class ProjectKeyCache {
  readonly #db: Kysely<Database>;
  readonly #ttlMs: number;
  readonly #unknownTtlMs: number;
  readonly #now: () => number;
  readonly #byPublic: KeyTable;
  readonly #bySecret: KeyTable;
  /** Counts forget() calls: a lookup that spans one does not cache its result. */
  #forgotten = 0;

  constructor(
    db: Kysely<Database>,
    options: {
      ttlMs?: number;
      maxEntries?: number;
      unknownTtlMs?: number;
      maxUnknown?: number;
      now?: () => number;
    } = {},
  ) {
    this.#db = db;
    this.#ttlMs = options.ttlMs ?? 60_000;
    this.#unknownTtlMs = options.unknownTtlMs ?? 10_000;
    this.#now = options.now ?? Date.now;
    const table = (): KeyTable => ({
      known: new LruMap(options.maxEntries ?? 1_000),
      unknown: new LruMap(options.maxUnknown ?? 256),
      pending: new Map(),
    });
    this.#byPublic = table();
    this.#bySecret = table();
  }

  find(publicKey: string): Promise<CollectingProject | null> {
    return this.#lookup(this.#byPublic, "public_key", publicKey);
  }

  findBySecret(secretKey: string): Promise<CollectingProject | null> {
    return this.#lookup(this.#bySecret, "secret_key", secretKey);
  }

  /**
   * What the cache holds for a secret key, without a query: its project,
   * null when no project has it, or undefined when the cache does not know.
   */
  peekSecret(secretKey: string): CollectingProject | null | undefined {
    const now = this.#now();
    const known = this.#bySecret.known.get(secretKey, now);
    if (known !== undefined) return known;
    return this.#bySecret.unknown.get(secretKey, now) === undefined ? undefined : null;
  }

  async #lookup(
    table: KeyTable,
    column: "public_key" | "secret_key",
    key: string,
  ): Promise<CollectingProject | null> {
    const now = this.#now();
    const known = table.known.get(key, now);
    if (known !== undefined) return known;
    if (table.unknown.get(key, now) !== undefined) return null;
    const pending = table.pending.get(key);
    if (pending !== undefined) return pending;

    const forgotten = this.#forgotten;
    const query = this.#query(column, key);
    table.pending.set(key, query);
    try {
      const project = await query;
      if (forgotten === this.#forgotten) {
        if (project === null) table.unknown.set(key, true, now + this.#unknownTtlMs);
        else table.known.set(key, project, now + this.#ttlMs);
      }
      return project;
    } finally {
      if (table.pending.get(key) === query) table.pending.delete(key);
    }
  }

  async #query(
    column: "public_key" | "secret_key",
    key: string,
  ): Promise<CollectingProject | null> {
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
    return row === undefined
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
  }

  /**
   * Changes whenever keys are forgotten: a lookup started under an older
   * generation may answer with a row since replaced or deleted
   * (telemetry/key-lookups.ts shares lookups only within one).
   */
  get generation(): number {
    return this.#forgotten;
  }

  /** Invalidate replaced or deleted keys before the next request. */
  forget(publicKey: string) {
    this.#forgotten += 1;
    this.#byPublic.known.delete(publicKey);
    this.#byPublic.pending.delete(publicKey);
  }

  /** Invalidate both keys after project deletion, secret-key rotation, or collection changes. */
  forgetProject(projectId: string) {
    this.#forgotten += 1;
    for (const table of [this.#byPublic, this.#bySecret]) {
      table.known.deleteWhere((project) => project.id === projectId);
      // A lookup under way may read the old row: later requests start their own.
      table.pending.clear();
    }
  }
}
