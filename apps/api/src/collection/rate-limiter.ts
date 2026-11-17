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

/**
 * Events a project may store: its own budget, inside its organization's.
 * Without the second, a customer could add projects to multiply its share
 * of the instance, which every customer shares.
 */
export class EventBudget {
  readonly #projects: TokenBucketLimiter;
  readonly #organizations: TokenBucketLimiter;

  constructor(projects: TokenBucketLimiter, organizations: TokenBucketLimiter) {
    this.#projects = projects;
    this.#organizations = organizations;
  }

  /**
   * Spends `events` from both budgets, or from neither. A refusal waits for
   * both: retrying when only the organization's has refilled would only be
   * refused again.
   */
  take(project: { id: string; organizationId: string }, events: number): TakeResult {
    const organization = this.#organizations.take(project.organizationId, events);
    if (!organization.allowed) {
      const retryAfterSeconds = Math.max(
        organization.retryAfterSeconds,
        this.#projects.wait(project.id, events),
      );
      return { allowed: false, retryAfterSeconds };
    }
    const own = this.#projects.take(project.id, events);
    if (!own.allowed) this.#organizations.refund(project.organizationId, events);
    return own;
  }

  /** Puts back what take() spent, for records that were not stored after all. */
  refund(project: { id: string; organizationId: string }, events: number): void {
    this.#projects.refund(project.id, events);
    this.#organizations.refund(project.organizationId, events);
  }

  /** The most one take() may ask for: more could never be allowed. */
  get capacity(): number {
    return Math.min(this.#projects.capacity, this.#organizations.capacity);
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

/** An organization's telemetry budget, all its projects together: three projects' worth. */
export const TELEMETRY_ORGANIZATION_LIMIT: RateLimit = {
  capacity: 150_000,
  refillPerSecond: 15_000,
};
