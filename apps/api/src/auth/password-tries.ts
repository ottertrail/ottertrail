import { type RateLimit, TokenBucketLimiter } from "../collection/rate-limiter.ts";

/**
 * Every route that checks a signed-in user's current password (changing
 * their email or password, handing over ownership) spends from one bucket
 * per user: 5 tries, then one a minute, across all of them. Separate
 * buckets would give a stolen session 5 quick guesses per route.
 */
export const PASSWORD_TRY_LIMIT: RateLimit = { capacity: 5, refillPerSecond: 1 / 60 };

/** The one limiter for current-password checks, keyed by the user's ID; the app makes one. */
export function passwordTryLimiter(limit: RateLimit = PASSWORD_TRY_LIMIT): TokenBucketLimiter {
  return new TokenBucketLimiter(limit);
}
