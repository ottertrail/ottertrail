import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { QueryParams, queryRows } from "../src/clickhouse/query.ts";
import { clickHouseErrorHandler } from "../src/clickhouse/route-errors.ts";
import { DashboardBusyError, DashboardQueryLimiter } from "../src/telemetry/dashboard-limit.ts";
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

describe("the dashboard's queries in flight", () => {
  test("are at most the limit; the next waits for a place", async () => {
    const limiter = new DashboardQueryLimiter({ max: 2, waitMs: 5000 });
    const held = [later(), later()];
    const running = held.map((hold) => limiter.run(() => hold.promise));
    expect(limiter.running).toBe(2);

    let third = false;
    const waiting = limiter.run(async () => {
      third = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(third).toBe(false);

    held[0]?.settle();
    await waiting;
    expect(third).toBe(true);
    held[1]?.settle();
    await Promise.all(running);
    expect(limiter.running).toBe(0);
  });

  test("past the wait, a query is refused, and the route answers 503 with Retry-After", async () => {
    const limiter = new DashboardQueryLimiter({ max: 1, waitMs: 30 });
    const hold = later();
    const running = limiter.run(() => hold.promise);
    const refused = await limiter.run(async () => "ran").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DashboardBusyError);
    expect(await answerTo(refused)).toEqual({
      status: 503,
      retryAfter: "10",
      error: "reports_busy",
    });
    hold.settle();
    await running;
    // The refused query left no place taken.
    expect(limiter.running).toBe(0);
    expect(await limiter.run(async () => "ran")).toBe("ran");
  });

  test("one request holds at most its share of the places", async () => {
    const limiter = new DashboardQueryLimiter({ max: 4, waitMs: 5000 });
    const gate = limiter.gate(undefined, 2);
    const held = [later(), later(), later()];
    const started: number[] = [];
    const queries = held.map((hold, index) =>
      gate(async () => {
        started.push(index);
        await hold.promise;
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Two run; the third waits, though places are left for other pages.
    expect(started).toEqual([0, 1]);
    expect(limiter.running).toBe(2);
    expect(await limiter.run(async () => "another page")).toBe("another page");
    held[0]?.settle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual([0, 1, 2]);
    held[1]?.settle();
    held[2]?.settle();
    await Promise.all(queries);
    expect(limiter.running).toBe(0);
  });

  test("a request's waiting queries leave when it is closed", async () => {
    const limiter = new DashboardQueryLimiter({ max: 4, waitMs: 5000 });
    const closed = new AbortController();
    const gate = limiter.gate(closed.signal, 1);
    const hold = later();
    const running = gate(() => hold.promise);
    const waiting = gate(async () => "ran");
    // The first has its place; the second waits for the request's.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(limiter.running).toBe(1);
    closed.abort(new Error("closed"));
    await expect(waiting).rejects.toThrow("closed");
    hold.settle();
    await running;
    expect(limiter.running).toBe(0);
  });

  test("a waiting query leaves when its request is closed", async () => {
    const limiter = new DashboardQueryLimiter({ max: 1, waitMs: 5000 });
    const hold = later();
    const running = limiter.run(() => hold.promise);
    const closed = new AbortController();
    const waiting = limiter.run(async () => "ran", closed.signal);
    closed.abort(new Error("closed"));
    await expect(waiting).rejects.toThrow("closed");
    hold.settle();
    await running;
    expect(limiter.running).toBe(0);
  });
});

/** The queries running now that hold `marker`, other than this look itself. */
async function runningWith(marker: string): Promise<number> {
  const result = await clickhouse.client.query({
    query: `SELECT count() AS n FROM system.processes
            WHERE position(query, {marker:String}) > 0 AND position(query, 'system.processes') = 0`,
    query_params: { marker },
    format: "JSONEachRow",
  });
  const [row] = await result.json<{ n: string }>();
  return Number(row?.n ?? 0);
}

describe("a dashboard query whose request is gone", () => {
  test("is stopped by ClickHouse within about a second of the abort", async () => {
    const marker = `abort-${crypto.randomUUID()}`;
    const controller = new AbortController();
    const params = new QueryParams();
    // Runs for minutes unless stopped: a sum over a trillion hashed numbers.
    const query = queryRows(
      { client: clickhouse.client, signal: controller.signal },
      `SELECT ${params.add(marker, "String")} AS marker, sum(cityHash64(number)) AS total
       FROM numbers(1000000000000) -- ${marker}`,
      params,
      DASHBOARD_SETTINGS,
    ).catch((error: unknown) => error);
    await expect.poll(() => runningWith(marker), { timeout: 5000 }).toBe(1);
    controller.abort();
    expect(await query).toBeInstanceOf(Error);
    const aborted = Date.now();
    await expect.poll(() => runningWith(marker), { timeout: 1500, interval: 100 }).toBe(0);
    expect(Date.now() - aborted).toBeLessThan(1500);
  });

  test("a reader's deadline cuts the time a query may run, and refuses one past it", async () => {
    const params = new QueryParams();
    const started = Date.now();
    const error = await queryRows(
      { client: clickhouse.client, deadline: Date.now() + 1500 },
      "SELECT sum(cityHash64(number)) AS total FROM numbers(1000000000000)",
      params,
      DASHBOARD_SETTINGS,
    ).catch((caught: unknown) => caught);
    expect(String(error)).toMatch(/TIMEOUT_EXCEEDED|Timeout exceeded/u);
    expect(Date.now() - started).toBeLessThan(5000);
    await expect(
      queryRows(
        { client: clickhouse.client, deadline: Date.now() - 1 },
        "SELECT 1",
        new QueryParams(),
      ),
    ).rejects.toThrow("The time for this work ran out before the query.");
  });
});
