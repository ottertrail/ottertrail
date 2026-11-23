/**
 * In-memory token buckets allow bursts up to capacity and refill at refillPerSecond.
 * Refusals include the seconds until enough tokens return. Each API process allows
 * the full rate independently.
 */
import { isIP } from "node:net";

import { ipv6Bytes } from "../outbound/addresses.ts";

/**
 * Groups IPv6 clients by /64 to prevent rotating addresses around the limit.
 * IPv4-mapped addresses (::ffff:a.b.c.d) share their IPv4 bucket.
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

    // Refresh LRU order and evict old buckets to bound memory.
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

/** A budget's answer: when it refuses, whose limit was reached, for the Activity tab. */
export type BudgetResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; limit: "project" | "instance" };

const INSTANCE = "instance";

/**
 * Separate project and instance budgets prevent one project from consuming the
 * whole budget and new projects from raising the instance limit.
 */
export class EventBudget {
  readonly #projects: TokenBucketLimiter;
  readonly #instance: TokenBucketLimiter;

  constructor(projects: TokenBucketLimiter, instance: TokenBucketLimiter) {
    this.#projects = projects;
    this.#instance = instance;
  }

  /** Spends from both budgets or neither. Retry waits for both to refill. */
  take(projectId: string, events: number): BudgetResult {
    const instance = this.#instance.take(INSTANCE, events);
    if (!instance.allowed) {
      const retryAfterSeconds = Math.max(
        instance.retryAfterSeconds,
        this.#projects.wait(projectId, events),
      );
      return { allowed: false, retryAfterSeconds, limit: "instance" };
    }
    const own = this.#projects.take(projectId, events);
    if (own.allowed) return own;
    this.#instance.refund(INSTANCE, events);
    return { ...own, limit: "project" };
  }

  refund(projectId: string, events: number): void {
    this.#projects.refund(projectId, events);
    this.#instance.refund(INSTANCE, events);
  }

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
