import { describe, expect, test } from "vite-plus/test";

import { clientKey, EventBudget, TokenBucketLimiter } from "../src/collection/rate-limiter.ts";

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

describe("EventBudget", () => {
  const SITE = "site";
  const DOCS = "docs";
  const SHOP = "shop";

  test("keeps every project inside the instance's budget, and each inside its own", () => {
    const clock = fakeClock();
    const budget = new EventBudget(
      new TokenBucketLimiter({ capacity: 100, refillPerSecond: 10 }, clock),
      new TokenBucketLimiter({ capacity: 150, refillPerSecond: 15 }, clock),
    );
    expect(budget.take(SITE, 100)).toEqual({ allowed: true });
    // The site's own budget is spent, though the instance has 50 left.
    expect(budget.take(SITE, 1)).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
      limit: "project",
    });
    // Another project: only the instance's 50 left.
    expect(budget.take(DOCS, 60)).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
      limit: "instance",
    });
    expect(budget.take(DOCS, 50)).toEqual({ allowed: true });
    // Adding a project does not add to the instance's budget.
    expect(budget.take(SHOP, 1).allowed).toBe(false);
  });

  test("a refusal waits for both budgets", () => {
    const clock = fakeClock();
    const budget = new EventBudget(
      new TokenBucketLimiter({ capacity: 100, refillPerSecond: 10 }, clock),
      new TokenBucketLimiter({ capacity: 150, refillPerSecond: 50 }, clock),
    );
    expect(budget.take(SITE, 100)).toEqual({ allowed: true });
    expect(budget.take(DOCS, 50)).toEqual({ allowed: true });
    // The instance needs 1 second for 50 more; the project, 5.
    expect(budget.take(SITE, 50)).toEqual({
      allowed: false,
      retryAfterSeconds: 5,
      limit: "instance",
    });
  });

  test("a project's own limit refusing leaves the instance's budget untouched", () => {
    const clock = fakeClock();
    const budget = new EventBudget(
      new TokenBucketLimiter({ capacity: 50, refillPerSecond: 5 }, clock),
      new TokenBucketLimiter({ capacity: 100, refillPerSecond: 10 }, clock),
    );
    expect(budget.take(SITE, 50)).toEqual({ allowed: true });
    expect(budget.take(SITE, 50).allowed).toBe(false);
    // The refused 50 went back: the instance still has 50 for another project.
    expect(budget.take(DOCS, 50)).toEqual({ allowed: true });
  });
});

describe("EventBudget.refund", () => {
  test("gives back to the project and the instance what was not stored", () => {
    const clock = fakeClock();
    const budget = new EventBudget(
      new TokenBucketLimiter({ capacity: 50, refillPerSecond: 5 }, clock),
      new TokenBucketLimiter({ capacity: 60, refillPerSecond: 6 }, clock),
    );
    expect(budget.capacity).toBe(50);
    expect(budget.take("site", 50)).toEqual({ allowed: true });
    expect(budget.take("site", 1).allowed).toBe(false);
    budget.refund("site", 50);
    expect(budget.take("site", 50)).toEqual({ allowed: true });
  });
});

describe("refund", () => {
  test("puts tokens back, never above the capacity", () => {
    const limiter = new TokenBucketLimiter({ capacity: 10, refillPerSecond: 1 }, fakeClock());
    expect(limiter.take("a", 10)).toEqual({ allowed: true });
    limiter.refund("a", 4);
    expect(limiter.take("a", 4)).toEqual({ allowed: true });
    limiter.refund("a", 100);
    expect(limiter.take("a", 10)).toEqual({ allowed: true });
    expect(limiter.take("a", 1).allowed).toBe(false);
  });
});

describe("clientKey", () => {
  test("keys IPv4 by the address, IPv6 by its /64, and IPv4-mapped IPv6 as IPv4", () => {
    expect(clientKey("203.0.113.10")).toBe("203.0.113.10");
    expect(clientKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:0db8:0001:0002:abcd:ef01:2345:6789")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(clientKey("::ffff:203.0.113.10")).toBe("203.0.113.10");
  });
});
