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
}
