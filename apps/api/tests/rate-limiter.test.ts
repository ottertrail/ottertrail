import { describe, expect, test } from "vite-plus/test";

import { TokenBucketLimiter } from "../src/collection/rate-limiter.ts";

function fakeClock(start = 0) {
  let time = start;
  return {
    now: () => time,
    advanceSeconds: (seconds: number) => {
      time += seconds * 1000;
    },
  };
}

describe("TokenBucketLimiter", () => {
  test("allows a burst up to the capacity, then says how long to wait", () => {
    const clock = fakeClock();
    const limiter = new TokenBucketLimiter({ capacity: 3, refillPerSecond: 1 }, clock);

    expect(limiter.take("ip")).toEqual({ allowed: true });
    expect(limiter.take("ip")).toEqual({ allowed: true });
    expect(limiter.take("ip")).toEqual({ allowed: true });
    expect(limiter.take("ip")).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  test("refills at the sustained rate, never above the capacity", () => {
    const clock = fakeClock();
    const limiter = new TokenBucketLimiter({ capacity: 2, refillPerSecond: 1 }, clock);
    limiter.take("ip");
    limiter.take("ip");

    clock.advanceSeconds(1);
    expect(limiter.take("ip")).toEqual({ allowed: true });
    expect(limiter.take("ip").allowed).toBe(false);

    clock.advanceSeconds(60);
    expect(limiter.take("ip")).toEqual({ allowed: true });
    expect(limiter.take("ip")).toEqual({ allowed: true });
    expect(limiter.take("ip").allowed).toBe(false);
  });

  test("spends one token per event when a batch has a cost", () => {
    const clock = fakeClock();
    const limiter = new TokenBucketLimiter({ capacity: 100, refillPerSecond: 10 }, clock);

    expect(limiter.take("project", 60)).toEqual({ allowed: true });
    // 40 left; 50 more need 10 more tokens, which take one second.
    expect(limiter.take("project", 50)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  test("keeps keys independent", () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1 }, fakeClock());
    expect(limiter.take("a").allowed).toBe(true);
    expect(limiter.take("a").allowed).toBe(false);
    expect(limiter.take("b").allowed).toBe(true);
  });

  test("forgets the least recently used keys beyond maxKeys", () => {
    const limiter = new TokenBucketLimiter(
      { capacity: 1, refillPerSecond: 0.001 },
      { ...fakeClock(), maxKeys: 2 },
    );
    limiter.take("a");
    limiter.take("b");
    limiter.take("c"); // Evicts "a".
    expect(limiter.take("a").allowed).toBe(true); // A fresh, full bucket.
  });

  test("rejects a cost above the capacity as a configuration error", () => {
    const limiter = new TokenBucketLimiter({ capacity: 10, refillPerSecond: 1 }, fakeClock());
    expect(() => limiter.take("project", 11)).toThrow(RangeError);
  });
});
