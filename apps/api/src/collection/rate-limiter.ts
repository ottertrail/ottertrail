/**
 * Token bucket rate limiter, kept in this process's memory.
 *
 * Each key (an IP address, a project) has a bucket holding up to `capacity`
 * tokens. Every request spends tokens (one, or one per event), and the
 * bucket refills at `refillPerSecond`. A full bucket allows a short burst;
 * the refill rate is the sustained limit. When a bucket is empty, the
 * caller is told how many seconds until enough tokens return.
 *
 * Limits are per API process. Ottertrail runs one API process per instance
 * for now; several processes would each allow the full rate.
 */
import { isIP } from "node:net";

import { ipv6Bytes } from "../outbound/addresses.ts";

/**
 * The key a client address is limited by: an IPv4 address as it is, and an
 * IPv6 address by its /64, the block one household or server usually
 * holds, so a client cannot dodge a limit with each of its addresses. An
 * IPv4-mapped address (::ffff:a.b.c.d) counts as its IPv4 address.
 */
export function clientKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1] !== undefined) return mapped[1];
  const bytes = ipv6Bytes(ip);
  const groups = [0, 2, 4, 6].map((at) =>
    (((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)).toString(16),
  );
  return `${groups.join(":")}::/64`;
}

export interface RateLimit {
  capacity: number;
  refillPerSecond: number;
}

export type TakeResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketLimiter {
  readonly #limit: RateLimit;
  readonly #maxKeys: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(limit: RateLimit, options: { maxKeys?: number; now?: () => number } = {}) {
    if (limit.capacity <= 0 || limit.refillPerSecond <= 0) {
      throw new Error("capacity and refillPerSecond must be positive");
    }
    this.#limit = limit;
    this.#maxKeys = options.maxKeys ?? 10_000;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Spends `cost` tokens from `key`'s bucket if it has enough. A cost above
   * the capacity could never succeed, so it is a configuration error.
   */
  take(key: string, cost = 1): TakeResult {
    const { capacity, refillPerSecond } = this.#limit;
    if (cost > capacity) {
      throw new RangeError(`cost ${cost} exceeds the bucket capacity ${capacity}`);
    }
    const now = this.#now();
    const bucket = this.#buckets.get(key) ?? { tokens: capacity, updatedAt: now };

    const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
    bucket.updatedAt = now;

    let result: TakeResult;
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      result = { allowed: true };
    } else {
      const missing = cost - bucket.tokens;
      result = { allowed: false, retryAfterSeconds: Math.ceil(missing / refillPerSecond) };
    }

    // Re-insert so the Map's order is least recently used first, then drop
    // the oldest buckets, so memory stays bounded however many keys arrive.
    this.#buckets.delete(key);
    this.#buckets.set(key, bucket);
    while (this.#buckets.size > this.#maxKeys) {
      const oldest = this.#buckets.keys().next().value;
      if (oldest === undefined) break;
      this.#buckets.delete(oldest);
    }
    return result;
  }

  /** The most tokens a bucket holds: the largest cost take() accepts. */
  get capacity(): number {
    return this.#limit.capacity;
  }

  /** Seconds until `key` could spend `cost` tokens, without spending them: 0 when it can now. */
  wait(key: string, cost: number): number {
    const { capacity, refillPerSecond } = this.#limit;
    const bucket = this.#buckets.get(key);
    if (bucket === undefined) return 0;
    const elapsedSeconds = Math.max(0, this.#now() - bucket.updatedAt) / 1000;
    const tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
    return tokens >= cost ? 0 : Math.ceil((cost - tokens) / refillPerSecond);
  }

  /** Puts back tokens spent by take(), up to the capacity: for a request refused later on. */
  refund(key: string, cost: number): void {
    const bucket = this.#buckets.get(key);
    if (bucket !== undefined) bucket.tokens = Math.min(this.#limit.capacity, bucket.tokens + cost);
  }
}

/** The instance budget's one key. */
const INSTANCE = "instance";

/**
 * Events a project may store: its own budget, inside the instance's.
 * Without the first, one busy project could take the whole instance's
 * budget from the others; without the second, adding projects would raise
 * what the instance takes in without bound.
 */
export class EventBudget {
  readonly #projects: TokenBucketLimiter;
  readonly #instance: TokenBucketLimiter;

  constructor(projects: TokenBucketLimiter, instance: TokenBucketLimiter) {
    this.#projects = projects;
    this.#instance = instance;
  }

  /**
   * Spends `events` from both budgets, or from neither. A refusal waits for
   * both: retrying when only the instance's has refilled would only be
   * refused again.
   */
  take(projectId: string, events: number): TakeResult {
    const instance = this.#instance.take(INSTANCE, events);
    if (!instance.allowed) {
      const retryAfterSeconds = Math.max(
        instance.retryAfterSeconds,
        this.#projects.wait(projectId, events),
      );
      return { allowed: false, retryAfterSeconds };
    }
    const own = this.#projects.take(projectId, events);
    if (!own.allowed) this.#instance.refund(INSTANCE, events);
    return own;
  }

  /** Puts back what take() spent, for records that were not stored after all. */
  refund(projectId: string, events: number): void {
    this.#projects.refund(projectId, events);
    this.#instance.refund(INSTANCE, events);
  }

  /** The most one take() may ask for: more could never be allowed. */
  get capacity(): number {
    return Math.min(this.#projects.capacity, this.#instance.capacity);
  }
}

/**
 * Traces' spans, log records, and metrics' data points a project may store
 * (docs/telemetry.md, "Limits"): a burst of 50,000, then 5,000 a second.
 * A record costs one, or more when large (telemetry/routes.ts, BYTES_PER_UNIT).
 * A budget apart from events', so telemetry cannot crowd out a site's
 * events. A first guess, to be measured.
 */
export const TELEMETRY_PROJECT_LIMIT: RateLimit = { capacity: 50_000, refillPerSecond: 5_000 };

/** The instance's telemetry budget, all its projects together: three projects' worth. */
export const TELEMETRY_INSTANCE_LIMIT: RateLimit = {
  capacity: 150_000,
  refillPerSecond: 15_000,
};
