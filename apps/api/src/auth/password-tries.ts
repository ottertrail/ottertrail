import { type RateLimit, TokenBucketLimiter } from "../collection/rate-limiter.ts";

/**
 * Share 5 tries, refilling one per minute, across all current-password checks.
 * Separate route buckets would give stolen sessions more guesses.
 */
export const PASSWORD_TRY_LIMIT: RateLimit = { capacity: 5, refillPerSecond: 1 / 60 };

/** The one limiter for current-password checks, keyed by the user's ID; the app makes one. */
export function passwordTryLimiter(limit: RateLimit = PASSWORD_TRY_LIMIT): TokenBucketLimiter {
  return new TokenBucketLimiter(limit);
}
