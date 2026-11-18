import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { QueryParams, queryRows } from "../src/clickhouse/query.ts";
import { clickHouseErrorHandler } from "../src/clickhouse/route-errors.ts";
import { DashboardBusyError, OrganizationLimiter } from "../src/telemetry/dashboard-limit.ts";
import { DASHBOARD_SETTINGS } from "../src/telemetry/dashboard-query.ts";
import { createTestClickHouse, type TestClickHouse } from "./helpers/test-clickhouse.ts";

let clickhouse: TestClickHouse;

beforeAll(async () => {
  clickhouse = await createTestClickHouse();
});

afterAll(async () => {
  await clickhouse?.destroy();
});

/** A promise and the function that settles it. */
function later() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, settle: () => resolve() };
}

/** The status, Retry-After, and body a route answers when it throws `error`. */
async function answerTo(error: unknown) {
  const app = Fastify();
  app.setErrorHandler(clickHouseErrorHandler);
  app.get("/", () => {
    throw error;
  });
  const response = await app.inject({ url: "/" });
  await app.close();
  return {
    status: response.statusCode,
    retryAfter: response.headers["retry-after"],
    error: response.json().error,
  };
}

describe("a dashboard query's memory", () => {
  test("is limited to 300 MB, and past it the page is told to narrow the range", async () => {
    expect(DASHBOARD_SETTINGS.max_memory_usage).toBe("300000000");
    // An array of 100 million numbers needs about 800 MB.
    const failure = await queryRows(
      { client: clickhouse.client },
      "SELECT length(groupArray(number)) AS n FROM numbers(100000000)",
      new QueryParams(),
      DASHBOARD_SETTINGS,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ type: "MEMORY_LIMIT_EXCEEDED" });
    expect(await answerTo(failure)).toEqual({
      status: 503,
      retryAfter: "60",
      error: "reports_busy",
    });
  });
});

describe("an organization's queries in flight", () => {
  test("are at most the limit; the next waits for a place, other organizations do not", async () => {
    const limiter = new OrganizationLimiter({ max: 2, waitMs: 5000 });
    const held = [later(), later()];
    const running = held.map((hold) => limiter.run("org-a", () => hold.promise));
    expect(limiter.running("org-a")).toBe(2);

    let third = false;
    const waiting = limiter.run("org-a", async () => {
      third = true;
    });
    // Another organization is not held up.
    await limiter.run("org-b", async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(third).toBe(false);

    held[0]?.settle();
    await waiting;
    expect(third).toBe(true);
    held[1]?.settle();
    await Promise.all(running);
    expect(limiter.running("org-a")).toBe(0);
  });

  test("past the wait, a query is refused, and the route answers 503 with Retry-After", async () => {
    const limiter = new OrganizationLimiter({ max: 1, waitMs: 30 });
    const hold = later();
    const running = limiter.run("org-a", () => hold.promise);
    const refused = await limiter.run("org-a", async () => "ran").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DashboardBusyError);
    expect(await answerTo(refused)).toEqual({
      status: 503,
      retryAfter: "10",
      error: "reports_busy",
    });
    hold.settle();
    await running;
    // The refused query left no place taken.
    expect(limiter.running("org-a")).toBe(0);
    expect(await limiter.run("org-a", async () => "ran")).toBe("ran");
  });

  test("a waiting query leaves when its request is closed", async () => {
    const limiter = new OrganizationLimiter({ max: 1, waitMs: 5000 });
    const hold = later();
    const running = limiter.run("org-a", () => hold.promise);
    const closed = new AbortController();
    const waiting = limiter.run("org-a", async () => "ran", closed.signal);
    closed.abort(new Error("closed"));
    await expect(waiting).rejects.toThrow("closed");
    hold.settle();
    await running;
    expect(limiter.running("org-a")).toBe(0);
  });
});
