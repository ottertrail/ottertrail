import { describe, expect, test } from "vite-plus/test";

import { EventBudget, TokenBucketLimiter } from "../src/collection/rate-limiter.ts";

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
  const ADA = { id: "ada-site", organizationId: "ada" };
  const ADA_DOCS = { id: "ada-docs", organizationId: "ada" };
  const BOB = { id: "bob-shop", organizationId: "bob" };

  test("keeps an organization's projects together inside its own budget", () => {
    const clock = fakeClock();
    const budget = new EventBudget(
      new TokenBucketLimiter({ capacity: 100, refillPerSecond: 10 }, clock),
      new TokenBucketLimiter({ capacity: 150, refillPerSecond: 15 }, clock),
    );
    expect(budget.take(ADA, 100)).toEqual({ allowed: true });
    // Another project of the same organization: only its organization's 50 left.
    expect(budget.take(ADA_DOCS, 60)).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(budget.take(ADA_DOCS, 50)).toEqual({ allowed: true });
    // Another organization has its own.
    expect(budget.take(BOB, 100)).toEqual({ allowed: true });
  });

  test("a refusal waits for both budgets", () => {
    const clock = fakeClock();
    const budget = new EventBudget(
      new TokenBucketLimiter({ capacity: 100, refillPerSecond: 10 }, clock),
      new TokenBucketLimiter({ capacity: 150, refillPerSecond: 50 }, clock),
    );
    expect(budget.take(ADA, 100)).toEqual({ allowed: true });
    expect(budget.take(ADA_DOCS, 50)).toEqual({ allowed: true });
    // The organization needs 1 second for 50 more; the project, 5.
    expect(budget.take(ADA, 50)).toEqual({ allowed: false, retryAfterSeconds: 5 });
  });

  test("a project's own limit refusing leaves its organization's budget untouched", () => {
    const clock = fakeClock();
    const budget = new EventBudget(
      new TokenBucketLimiter({ capacity: 50, refillPerSecond: 5 }, clock),
      new TokenBucketLimiter({ capacity: 100, refillPerSecond: 10 }, clock),
    );
    expect(budget.take(ADA, 50)).toEqual({ allowed: true });
    expect(budget.take(ADA, 50).allowed).toBe(false);
    // The refused 50 went back: the organization still has 50 for another project.
    expect(budget.take(ADA_DOCS, 50)).toEqual({ allowed: true });
  });
});

describe("EventBudget.refund", () => {
  test("gives back to the project and its organization what was not stored", () => {
    const clock = fakeClock();
    const budget = new EventBudget(
      new TokenBucketLimiter({ capacity: 50, refillPerSecond: 5 }, clock),
      new TokenBucketLimiter({ capacity: 60, refillPerSecond: 6 }, clock),
    );
    const project = { id: "ada-site", organizationId: "ada" };
    expect(budget.capacity).toBe(50);
    expect(budget.take(project, 50)).toEqual({ allowed: true });
    expect(budget.take(project, 1).allowed).toBe(false);
    budget.refund(project, 50);
    expect(budget.take(project, 50)).toEqual({ allowed: true });
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
